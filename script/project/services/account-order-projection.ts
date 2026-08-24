import type { AccountParcelDto } from "./account-parser";
import { projectedCarrierPresentation } from "./carrier-presentation";
import {
  normalizeWaybill,
} from "./status";
import {
  OperationTimeoutError,
  remainingTimeoutMs,
} from "./deadline";

const PROJECTION_TIMEOUT_MS = 9_000;

export type AccountOrderProjection = Readonly<{
  waybill: string;
  courierCode: string;
  companyName: string;
}>;

export type AccountOrderProjectionDiagnostics = Readonly<{
  loadSettled: boolean;
  loadCompleted: boolean;
  captureSeen: boolean;
  replayAttempted: boolean;
  replaySucceeded: boolean;
  probeInstalled: boolean;
  probeMatched: boolean;
  probeRequestCount: number;
  unionSignalSeen: boolean;
  unionResourceSeen: boolean;
  domMatched: boolean;
  requestCallbackCount: number;
  evaluationAttempts: number;
  evaluationFailures: number;
  loadDurationMs: number;
  resourceCount: number;
  pageClass: string;
  readyState: string;
  visibilityState: string;
  viewportAvailable: boolean;
}>;

type CapturedRequest = {
  url: string;
  method: string;
  body: string;
  headers: Readonly<Record<string, string>>;
};

const MAX_CAPTURED_URL_LENGTH = 16_384;
const MAX_CAPTURED_BODY_BYTES = 512 * 1_024;
const MAX_CAPTURED_HEADER_LENGTH = 4_096;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function decode(value: unknown, depth = 0): unknown {
  if (depth > 3 || typeof value !== "string") return value;
  const clean = value.trim();
  if (!clean) return value;
  try {
    return decode(JSON.parse(clean), depth + 1);
  } catch {
    const start = clean.indexOf("(");
    const end = clean.lastIndexOf(")");
    if (start > 0 && end > start) {
      try {
        return decode(JSON.parse(clean.slice(start + 1, end)), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(value: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return "";
}

function validProjectedWaybill(value: unknown, ownerId: string): string {
  const normalized = normalizeWaybill(text(value));
  const owner = normalizeWaybill(ownerId);
  return normalized.length >= 6 && normalized.length <= 48 && normalized !== owner
    ? normalized
    : "";
}

function courierCodeForName(value: string): string {
  const name = value.replace(/\s+/g, "");
  if (name.includes("顺丰")) return "SF";
  if (name.includes("中通")) return "ZTO";
  if (name.includes("圆通")) return "YTO";
  if (name.includes("申通")) return "STO";
  if (name.includes("韵达")) return "YD";
  if (name.includes("邮政") || /^EMS/i.test(name)) return "EMS";
  if (name.includes("京东")) return "JD";
  if (name.includes("极兔")) return "JTSD";
  if (name.includes("德邦")) return "DBL";
  if (name.includes("丹鸟") || name.includes("菜鸟直送")) return "DANNIAO";
  return "";
}

export function projectionFromUnionPayload(
  value: unknown,
  ownerId: string,
): AccountOrderProjection | null {
  const root = object(decode(value));
  const data = object(decode(root.data));
  const floors = Array.isArray(data.floors) ? data.floors : [];
  const info = object(object(object(floors[0]).element).info);
  const traces = Array.isArray(info.traceList) ? info.traceList : [];
  const waybill = [
    info.waybillCode,
    ...traces.map((item) => object(item).waybillCode),
  ].map((candidate) => validProjectedWaybill(candidate, ownerId)).find(Boolean) || "";
  if (!waybill) return null;
  const companyName = firstText(info, [
    "expressName",
    "carrierName",
    "companyName",
    "expressCompany",
    "expressCompanyName",
    "logisticsCompanyName",
    "logisticsCompany",
  ]) || traces.map((item) => firstText(object(item), [
    "expressName",
    "carrierName",
    "companyName",
    "expressCompany",
    "expressCompanyName",
    "cpName",
  ])).find(Boolean) || "";
  return {
    waybill,
    ...projectedCarrierPresentation(
      waybill,
      courierCodeForName(companyName),
      companyName,
    ),
  };
}

function trustedInitialRoute(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (
      host === "jd.com" || host.endsWith(".jd.com")
    );
  } catch {
    return false;
  }
}

function trustedWebResource(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return [
      "jd.com",
      "jd.hk",
      "360buyimg.com",
      "jdcdn.com",
      "jcloud.com",
      "jdcloud.com",
      "jcloudcs.com",
      "jingxi.com",
    ].some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function httpsResource(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function passiveResourceRequest(navigationType: string | undefined): boolean {
  return navigationType === "other";
}

function unionRequest(value: string, body = ""): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const raw = `${value}&${body}`;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      /* the undecoded request can still contain the target signal */
    }
    return /getUnionActivity/i.test(decoded);
  } catch {
    return false;
  }
}

function replayHeaders(
  values: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(values || {})) {
    const name = rawName.trim().toLowerCase();
    const value = String(rawValue || "").trim();
    if (
      !value ||
      value.length > MAX_CAPTURED_HEADER_LENGTH ||
      !(
        name === "accept" ||
        name === "content-type" ||
        /^x-[a-z0-9-]{1,64}$/.test(name)
      )
    ) continue;
    result[name] = value;
  }
  return result;
}

function requestKey(value: CapturedRequest): string {
  return JSON.stringify([value.url, value.method, value.body]);
}

function timeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new OperationTimeoutError("提取运单号超时，请稍后重试")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function extractionJavaScript(
  ownerId: string,
  request: CapturedRequest | null,
): string {
  const input = JSON.stringify({ ownerId, request });
  return `
    return (async () => {
      const input = ${input};
      const probeKey = "__pipiDeliveriesOrderProjectionProbeV1";
      const clean = (value) => String(value == null ? "" : value).trim();
      const requestSignal = (url, body) => {
        const raw = clean(url) + "&" + clean(body);
        try { return decodeURIComponent(raw); } catch (_) { return raw; }
      };
      const relevant = (url, body) => /getUnionActivity/i.test(requestSignal(url, body));
      const parse = (source) => {
        if (source && typeof source === "object") return source;
        const value = clean(source);
        if (!value) return null;
        try { return JSON.parse(value); } catch (_) {}
        const start = value.indexOf("(");
        const end = value.lastIndexOf(")");
        if (start >= 0 && end > start) {
          try { return JSON.parse(value.slice(start + 1, end)); } catch (_) {}
        }
        return null;
      };
      const normalize = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
      const valid = (value) => {
        const candidate = normalize(value);
        const owner = normalize(input.ownerId);
        return candidate.length >= 6 && candidate.length <= 48 && candidate !== owner
          ? candidate
          : "";
      };
      const projection = (source, extractionSource) => {
        let root = parse(source) || source;
        if (root && typeof root.data === "string") {
          root.data = parse(root.data) || root.data;
        }
        const floors = root && root.data && Array.isArray(root.data.floors)
          ? root.data.floors
          : [];
        const info = floors[0] && floors[0].element && floors[0].element.info
          ? floors[0].element.info
          : {};
        const traces = Array.isArray(info.traceList) ? info.traceList : [];
        const waybillCode = [info.waybillCode, ...traces.map((item) => item && item.waybillCode)]
          .map(valid)
          .find(Boolean) || "";
        if (!waybillCode) return null;
        const companyKeys = [
          "expressName", "carrierName", "companyName", "expressCompany",
          "expressCompanyName", "logisticsCompanyName", "logisticsCompany", "cpName",
        ];
        let companyName = "";
        for (const key of companyKeys) {
          companyName = clean(info[key]);
          if (companyName) break;
        }
        if (!companyName) {
          for (const trace of traces) {
            for (const key of companyKeys) {
              companyName = clean(trace && trace[key]);
              if (companyName) break;
            }
            if (companyName) break;
          }
        }
        return { waybillCode, companyName, extractionSource };
      };
      let pageClass = "invalid";
      try {
        const page = new URL(window.location.href);
        const host = page.hostname.toLowerCase();
        pageClass = page.protocol === "https:" && (host === "jd.com" || host.endsWith(".jd.com"))
          ? "jd"
          : "other";
      } catch (_) {}
      const performanceResources = () => {
        let entries = [];
        try {
          entries = window.performance && typeof window.performance.getEntriesByType === "function"
            ? window.performance.getEntriesByType("resource") || []
            : [];
        } catch (_) {}
        let unionResourceSeen = false;
        let replayUrl = "";
        for (const entry of entries.slice(0, 5000)) {
          const name = clean(entry && entry.name);
          if (!name || !relevant(name, "")) continue;
          unionResourceSeen = true;
          try {
            const candidate = new URL(name);
            const host = candidate.hostname.toLowerCase();
            if (
              !replayUrl &&
              name.length <= ${MAX_CAPTURED_URL_LENGTH} &&
              candidate.protocol === "https:" &&
              (host === "jd.com" || host.endsWith(".jd.com"))
            ) replayUrl = name;
          } catch (_) {}
        }
        return {
          count: Math.min(entries.length, 100000),
          unionResourceSeen,
          replayUrl,
        };
      };
      const snapshot = (probe, resourceState) => ({
        extractionSource: "diagnostic",
        probeInstalled: Boolean(probe && probe.version === 1),
        probeRequestCount: probe && Number.isFinite(probe.requestCount)
          ? Math.min(Math.max(0, probe.requestCount), 100000)
          : 0,
        unionSignalSeen: Boolean(probe && probe.unionSignalSeen),
        unionResourceSeen: Boolean(
          (probe && probe.unionResourceSeen) || resourceState.unionResourceSeen
        ),
        resourceReplayAttempted: Boolean(probe && probe.resourceReplayAttempted),
        resourceReplaySucceeded: Boolean(probe && probe.resourceReplaySucceeded),
        resourceCount: resourceState.count,
        pageClass,
        readyState: clean(document && document.readyState) || "unknown",
        visibilityState: clean(document && document.visibilityState) || "unknown",
        viewportAvailable: Number(window.innerWidth || 0) > 0 && Number(window.innerHeight || 0) > 0,
      });
      const resourceStateBeforeProbe = performanceResources();
      if (pageClass !== "jd") return snapshot(null, resourceStateBeforeProbe);
      const installProbe = () => {
        const existing = window[probeKey];
        if (existing && existing.version === 1) return existing;
        const probe = {
          version: 1,
          queue: [],
          requestCount: 0,
          unionSignalSeen: false,
          unionResourceSeen: resourceStateBeforeProbe.unionResourceSeen,
          resourceReplayAttempted: false,
          resourceReplaySucceeded: false,
        };
        window[probeKey] = probe;
        const enqueue = (source) => {
          try {
            const result = projection(source, "probe");
            if (!result) return;
            probe.queue.push(result);
            if (probe.queue.length > 4) probe.queue.splice(0, probe.queue.length - 4);
          } catch (_) {}
        };
        const captureResponse = (response) => {
          try {
            if (!response || typeof response.clone !== "function") return;
            response.clone().text().then(enqueue).catch(() => {});
          } catch (_) {}
        };
        try {
          const originalFetch = window.fetch;
          if (typeof originalFetch === "function") {
            window.fetch = function(inputValue, initValue) {
              let url = "";
              try {
                url = typeof inputValue === "string"
                  ? inputValue
                  : clean(inputValue && inputValue.url);
              } catch (_) {}
              let body = "";
              try {
                body = typeof (initValue && initValue.body) === "string"
                  ? initValue.body
                  : clean(initValue && initValue.body);
              } catch (_) {}
              probe.requestCount = Math.min(probe.requestCount + 1, 100000);
              const target = relevant(url, body);
              if (target) probe.unionSignalSeen = true;
              const response = originalFetch.apply(this, arguments);
              if (target) Promise.resolve(response).then(captureResponse).catch(() => {});
              return response;
            };
          }
        } catch (_) {}
        try {
          const prototype = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
          if (prototype && !prototype.__pipiDeliveriesProjectionProbeV1) {
            const originalOpen = prototype.open;
            const originalSend = prototype.send;
            prototype.open = function(method, url) {
              this.__pipiDeliveriesProjectionUrl = clean(url);
              return originalOpen.apply(this, arguments);
            };
            prototype.send = function(body) {
              probe.requestCount = Math.min(probe.requestCount + 1, 100000);
              const target = relevant(this.__pipiDeliveriesProjectionUrl, body);
              if (target) {
                probe.unionSignalSeen = true;
                try {
                  this.addEventListener("loadend", () => {
                    try { enqueue(this.responseText); } catch (_) {}
                  }, { once: true });
                } catch (_) {}
              }
              return originalSend.apply(this, arguments);
            };
            try {
              Object.defineProperty(prototype, "__pipiDeliveriesProjectionProbeV1", {
                value: true,
                configurable: false,
              });
            } catch (_) {
              prototype.__pipiDeliveriesProjectionProbeV1 = true;
            }
          }
        } catch (_) {}
        return probe;
      };
      const probe = installProbe();
      const queued = Array.isArray(probe.queue) ? probe.queue.shift() : null;
      if (queued) return {
        ...snapshot(probe, performanceResources()),
        ...queued,
      };
      const scripts = Array.from(document.querySelectorAll("script"))
        .map((item) => item.textContent || "")
        .join("\\n")
        .slice(0, 1500000);
      const structured = [...scripts.matchAll(/["']waybillCode["']\\s*:\\s*["']([A-Za-z0-9_-]{6,64})["']/gi)];
      for (const match of structured) {
        const waybillCode = valid(match && match[1]);
        if (waybillCode) return { waybillCode, companyName: "", extractionSource: "script" };
      }
      const body = clean(document.body && document.body.innerText).slice(0, 300000);
      const visible = [...body.matchAll(/(?:运单号|快递单号)\\s*[：:]?\\s*([A-Za-z0-9_-]{6,64})/gi)];
      for (const match of visible) {
        const waybillCode = valid(match && match[1]);
        if (waybillCode) return { waybillCode, companyName: "", extractionSource: "dom" };
      }
      if (input.request && input.request.url) {
        try {
          const aborter = new AbortController();
          const timer = setTimeout(() => aborter.abort(), 3000);
          const options = {
            method: input.request.method || "GET",
            credentials: "include",
            headers: input.request.headers || {},
            signal: aborter.signal,
          };
          if (options.method !== "GET" && options.method !== "HEAD" && input.request.body) {
            options.body = input.request.body;
          }
          const response = await window.fetch(input.request.url, options).finally(() => clearTimeout(timer));
          if (response.ok) {
            const result = projection(await response.text(), "replay");
            if (result) return result;
          }
        } catch (_) {}
      }
      const resourceState = performanceResources();
      probe.unionResourceSeen ||= resourceState.unionResourceSeen;
      if (!probe.resourceReplayAttempted && resourceState.replayUrl) {
        probe.resourceReplayAttempted = true;
        try {
          const aborter = new AbortController();
          const timer = setTimeout(() => aborter.abort(), 3000);
          const response = await window.fetch(resourceState.replayUrl, {
            credentials: "include",
            signal: aborter.signal,
          }).finally(() => clearTimeout(timer));
          if (response.ok) {
            const result = projection(await response.text(), "resource_replay");
            if (result) {
              probe.resourceReplaySucceeded = true;
              return {
                ...snapshot(probe, resourceState),
                ...result,
              };
            }
          }
        } catch (_) {}
      }
      return snapshot(probe, resourceState);
    })();
  `;
}

export async function projectAccountOrder(
  parcel: AccountParcelDto,
  deadlineAtMs?: number,
  observe?: (diagnostics: AccountOrderProjectionDiagnostics) => void,
): Promise<AccountParcelDto> {
  if (
    parcel.source !== "interface5" ||
    !parcel.accountOrder ||
    normalizeWaybill(parcel.waybill) !== normalizeWaybill(parcel.ownerId) ||
    !trustedInitialRoute(parcel.projectionUrl)
  ) return parcel;

  const projectionStartedAtMs = Date.now();
  const budget = remainingTimeoutMs(
    deadlineAtMs,
    PROJECTION_TIMEOUT_MS,
    projectionStartedAtMs,
  );
  const projectionDeadlineAtMs = projectionStartedAtMs + budget;
  const controller = new WebViewController({ ephemeral: true });
  let captured: CapturedRequest | null = null;
  let loadCompleted = false;
  let replayAttempted = false;
  let replaySucceeded = false;
  let probeInstalled = false;
  let probeMatched = false;
  let probeRequestCount = 0;
  let unionSignalSeen = false;
  let unionResourceSeen = false;
  let domMatched = false;
  let requestCallbackCount = 0;
  let resourceCount = 0;
  let pageClass = "unknown";
  let readyState = "unknown";
  let visibilityState = "unknown";
  let viewportAvailable = false;
  const loadStartedAt = projectionStartedAtMs;
  let loadDurationMs = 0;
  let loadSettled = false;
  let loadFailure: unknown = null;
  let evaluationAttempts = 0;
  let evaluationFailures = 0;
  controller.shouldAllowRequest = async (request) => {
    requestCallbackCount++;
    if (!httpsResource(request.url)) return false;
    if (
      !trustedWebResource(request.url) &&
      !passiveResourceRequest(request.navigationType)
    ) return false;
    if (request.url.length > MAX_CAPTURED_URL_LENGTH) return true;
    let body = "";
    try {
      const bytes = request.body?.toUint8Array();
      if (bytes && bytes.length > MAX_CAPTURED_BODY_BYTES) return true;
      body = request.body?.toRawString("utf-8") || "";
    } catch {
      // Request inspection is optional; never reject a page resource because its Data bridge
      // cannot be decoded by this Scripting runtime.
      return true;
    }
    if (trustedWebResource(request.url) && unionRequest(request.url, body)) {
      const candidate: CapturedRequest = {
        url: request.url,
        method: String(request.method || "GET").toUpperCase(),
        body,
        headers: replayHeaders(request.headers),
      };
      captured = candidate;
    }
    return true;
  };
  try {
    // A dynamic page can keep WebKit's load promise pending after its useful requests and DOM are
    // already available. Start navigation without waiting for that promise so capture and DOM
    // polling can run inside the same bounded projection window.
    try {
      void controller.loadURL(parcel.projectionUrl).then(
        (loaded) => {
          loadSettled = true;
          loadCompleted = loaded;
          loadDurationMs = Date.now() - loadStartedAt;
        },
        (error) => {
          loadSettled = true;
          loadFailure = error;
          loadDurationMs = Date.now() - loadStartedAt;
        },
      );
    } catch (error) {
      loadSettled = true;
      loadFailure = error;
      loadDurationMs = Date.now() - loadStartedAt;
    }
    let replayedRequestKey = "";
    while (Date.now() < projectionDeadlineAtMs) {
      if (loadSettled && !loadCompleted && !captured) {
        if (loadFailure) throw loadFailure;
        return parcel;
      }
      const currentRequest = captured;
      const currentKey = currentRequest ? requestKey(currentRequest) : "";
      // Let the original page render first. Replay one observed request only after the DOM and
      // inline data have had a chance to expose the carrier waybill.
      const request = replayedRequestKey || !currentRequest ? null : currentRequest;
      const remaining = projectionDeadlineAtMs - Date.now();
      if (remaining <= 0) break;
      if (request) {
        replayedRequestKey = currentKey;
        replayAttempted = true;
      }
      let raw: unknown;
      try {
        evaluationAttempts++;
        raw = await timeout(
          controller.evaluateJavaScript<unknown>(
            extractionJavaScript(parcel.ownerId, request),
          ),
          remaining,
        );
      } catch (error) {
        if (error instanceof OperationTimeoutError) throw error;
        evaluationFailures++;
        const elapsed = Date.now() - loadStartedAt;
        const pause = Math.min(
          elapsed < 500 ? 20 : 250,
          projectionDeadlineAtMs - Date.now(),
        );
        if (pause > 0) await new Promise<void>((resolve) => setTimeout(resolve, pause));
        continue;
      }
      const candidate = object(raw);
      const extractionSource = text(candidate.extractionSource);
      probeInstalled ||= candidate.probeInstalled === true;
      probeMatched ||= extractionSource === "probe";
      unionSignalSeen ||= candidate.unionSignalSeen === true;
      unionResourceSeen ||= candidate.unionResourceSeen === true;
      replayAttempted ||= candidate.resourceReplayAttempted === true;
      replaySucceeded ||= candidate.resourceReplaySucceeded === true ||
        extractionSource === "replay" || extractionSource === "resource_replay";
      domMatched ||= extractionSource === "dom" || extractionSource === "script";
      const candidateProbeRequests = Number(candidate.probeRequestCount);
      if (Number.isFinite(candidateProbeRequests) && candidateProbeRequests >= 0) {
        probeRequestCount = Math.max(probeRequestCount, Math.round(candidateProbeRequests));
      }
      const candidateResourceCount = Number(candidate.resourceCount);
      if (Number.isFinite(candidateResourceCount) && candidateResourceCount >= 0) {
        resourceCount = Math.max(resourceCount, Math.round(candidateResourceCount));
      }
      const candidatePageClass = text(candidate.pageClass);
      if (["invalid", "other", "jd"].includes(candidatePageClass)) {
        pageClass = candidatePageClass;
      }
      const candidateReadyState = text(candidate.readyState);
      if (["loading", "interactive", "complete", "unknown"].includes(candidateReadyState)) {
        readyState = candidateReadyState;
      }
      const candidateVisibilityState = text(candidate.visibilityState);
      if (["visible", "hidden", "prerender", "unknown"].includes(candidateVisibilityState)) {
        visibilityState = candidateVisibilityState;
      }
      viewportAvailable ||= candidate.viewportAvailable === true;
      const projection = projectionFromUnionPayload({
        data: {
          floors: [{
            element: {
              info: {
                waybillCode: candidate.waybillCode,
                expressCompanyName: candidate.companyName,
              },
            },
          }],
        },
      }, parcel.ownerId);
      if (projection) {
        return {
          ...parcel,
          waybill: projection.waybill,
          courierCode: projection.courierCode,
          companyName: projection.companyName,
        };
      }
      // Scripting has no document-start injection API. Retry aggressively while the new document
      // is being created so the idempotent response probe has several chances to beat page scripts.
      const elapsed = Date.now() - loadStartedAt;
      const pause = Math.min(
        elapsed < 500 ? 20 : 250,
        projectionDeadlineAtMs - Date.now(),
      );
      if (pause > 0) await new Promise<void>((resolve) => setTimeout(resolve, pause));
    }
    if (Date.now() >= projectionDeadlineAtMs) {
      throw new OperationTimeoutError("提取运单号超时，请稍后重试");
    }
    return parcel;
  } finally {
    if (!loadDurationMs) loadDurationMs = Date.now() - loadStartedAt;
    try {
      observe?.({
        loadSettled,
        loadCompleted,
        captureSeen: captured != null,
        replayAttempted,
        replaySucceeded,
        probeInstalled,
        probeMatched,
        probeRequestCount,
        unionSignalSeen,
        unionResourceSeen,
        domMatched,
        requestCallbackCount,
        evaluationAttempts,
        evaluationFailures,
        loadDurationMs,
        resourceCount,
        pageClass,
        readyState,
        visibilityState,
        viewportAvailable,
      });
    } catch {
      /* diagnostics are best-effort and must not change the projection result */
    }
    controller.dispose();
  }
}
