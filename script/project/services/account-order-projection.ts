import type { AccountParcelDto } from "./account-parser";
import type { TimelinePackage, TrackNode } from "../models";
import {
  acquireProjectionViewport,
  releaseProjectionViewport,
} from "./projection-viewport";
import {
  builtInCarrierPresentation,
  projectedCarrierPresentation,
} from "./carrier-presentation";
import {
  headlineTrack,
  isNonEventDetail,
  normalizeWaybill,
  parseProviderTime,
  semanticFromText,
  timedTracks,
} from "./status";
import {
  OperationTimeoutError,
  remainingTimeoutMs,
} from "./deadline";

// Match Android Lite's foreground order-capture window. This bounds one WebView
// capture; it is not a deadline for the rest of the refresh round.
const PROJECTION_TIMEOUT_MS = 20_000;

/** Two timed nodes cannot come from the collapsed first screen, so they prove expansion. */
const EXPANDED_TIMELINE_MIN_TRACKS = 2;

export type AccountOrderProjection = Readonly<{
  waybill: string;
  courierCode: string;
  companyName: string;
  timeline?: TimelinePackage;
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
  resourceReplayBlockReason: string;
  domMatched: boolean;
  /** Whether this capture produced a package that earned §9 `complete`. */
  projectionComplete: boolean;
  /** Timed nodes in the best package this capture produced. */
  projectionTrackCount: number;
  requestCallbackCount: number;
  evaluationAttempts: number;
  evaluationFailures: number;
  loadDurationMs: number;
  resourceCount: number;
  pageClass: string;
  readyState: string;
    visibilityState: string;
  viewportAvailable: boolean;
  /** D-15 裁决 A′: whether the visible detail page lent this load a real viewport. */
  viewportHosted: boolean;
  identitySource: string;
  unionResponseStatuses: string;
  probeCaptureCount: number;
}>;

function feedTextIdentityDiagnostics(): AccountOrderProjectionDiagnostics {
  return {
    loadSettled: true,
    loadCompleted: true,
    captureSeen: false,
    replayAttempted: false,
    replaySucceeded: false,
    probeInstalled: false,
    probeMatched: false,
    probeRequestCount: 0,
    unionSignalSeen: false,
    unionResourceSeen: false,
    resourceReplayBlockReason: "",
    domMatched: false,
    projectionComplete: false,
    projectionTrackCount: 0,
    requestCallbackCount: 0,
    evaluationAttempts: 0,
    evaluationFailures: 0,
    loadDurationMs: 0,
    resourceCount: 0,
    pageClass: "feed",
    readyState: "complete",
    visibilityState: "unknown",
    viewportAvailable: false,
    viewportHosted: false,
    identitySource: "feed_text",
    unionResponseStatuses: "",
    probeCaptureCount: 0,
  };
}

type CapturedRequest = {
  url: string;
  method: string;
  body: string;
  headers: Readonly<Record<string, string>>;
};

const MAX_CAPTURED_URL_LENGTH = 16_384;
const MAX_CAPTURED_BODY_BYTES = 512 * 1_024;
const MAX_CAPTURED_HEADER_LENGTH = 4_096;
const TRUSTED_JD_RESOURCE_HOST_SUFFIXES = [
  "jd.com",
  "jd.hk",
  "360buyimg.com",
  "jdcdn.com",
  "jcloud.com",
  "jdcloud.com",
  "jcloudcs.com",
  "jingxi.com",
] as const;

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

const WAYBILL_FIELD_KEYS = [
  "waybillCode",
  "waybillNo",
  "waybillNum",
  "waybillNumber",
  "expressNo",
  "expressCode",
  "logisticsNo",
  "logisticsCode",
  "mailNo",
] as const;

const COMPANY_FIELD_KEYS = [
  "expressName",
  "carrierName",
  "companyName",
  "expressCompany",
  "expressCompanyName",
  "logisticsCompanyName",
  "logisticsCompany",
  "cpName",
] as const;

const TRACE_FIELD_KEYS = [
  "traceList",
  "traces",
  "trackList",
  "tracks",
  "logisticsTraceList",
  "logisticsTracks",
] as const;

function recordTraces(value: Record<string, unknown>): readonly unknown[] {
  for (const key of TRACE_FIELD_KEYS) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function projectionRecords(value: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 8 || result.length >= 5_000 || candidate == null) return;
    const decoded = decode(candidate);
    if (decoded !== candidate) {
      visit(decoded, depth + 1);
      return;
    }
    if (typeof decoded !== "object" || seen.has(decoded)) return;
    seen.add(decoded);
    if (Array.isArray(decoded)) {
      for (const item of decoded) visit(item, depth + 1);
      return;
    }
    const record = object(decoded);
    result.push(record);
    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };
  visit(value, 0);
  return result;
}

function projectionTrack(value: unknown, waybill: string): TrackNode | null {
  const item = object(value);
  const itemWaybill = normalizeWaybill(firstText(item, WAYBILL_FIELD_KEYS));
  if (itemWaybill && itemWaybill !== waybill) return null;
  // The live union page names its trace fields operateMessage / operateTime (Fold7 DevTools,
  // 2026-09-03); the older generic keys stay first for the other page families.
  const detail = firstText(item, [
    "desc", "context", "description", "detail", "operateMessage",
  ]);
  if (!detail || isNonEventDetail(detail)) return null;
  const timeText = firstText(item, ["time", "date", "ftime", "operateTime"]);
  const statusCode = firstText(item, [
    "statusCode",
    "status",
    "state",
    "stateNum",
  ]);
  return {
    timeText,
    timeMs: parseProviderTime(timeText),
    detail,
    statusCode,
    raw: statusCode
      ? { statusCode, _pipiStatusSource: "jingdong_h5" }
      : { _pipiStatusSource: "jingdong_h5" },
  };
}

function projectionTimeline(
  traces: readonly unknown[],
  waybill: string,
  courierCode: string,
  companyName: string,
  provider: string,
  successAtMs: number,
  complete: boolean,
  expansionProofAllowed = true,
): TimelinePackage | null {
  const tracks = traces
    .map((item) => projectionTrack(item, waybill))
    .filter((item): item is TrackNode => item != null)
    .sort((left, right) => {
      const byTime = (right.timeMs || 0) - (left.timeMs || 0);
      return byTime || right.timeText.localeCompare(left.timeText);
    });
  const timed = timedTracks(tracks);
  if (!timed.length) return null;
  // The forecast note stays in `tracks`; it just never becomes the headline.
  const latest = headlineTrack(timed) || timed[0];
  const semantic = semanticFromText(latest.detail);
  return {
    provider,
    // AGENTS §9 (user decision 2026-09-04): the union page renders a single collapsed node until
    // 完整物流进度 is expanded, so two or more timed nodes are themselves proof of an expanded
    // package. Same rule and same threshold as Pipi's JingDongH5Client.isExpandedTimeline.
    // A modal package that covers fewer nodes than a network package of the same session is
    // demoted unconditionally and this rule must not promote it back.
    complete: complete ||
      (expansionProofAllowed && timed.length >= EXPANDED_TIMELINE_MIN_TRACKS),
    structuredStatus: false,
    waybill,
    courierCode,
    companyName,
    semantic,
    statusEventAtMs: semantic === "UNKNOWN" ? null : latest.timeMs,
    latestTimeText: latest.timeText,
    latestDetail: latest.detail,
    tracks,
    successAtMs,
  };
}

function projectedWaybills(
  info: Record<string, unknown>,
  ownerId: string,
): string[] {
  const traces = recordTraces(info);
  return [
    ...WAYBILL_FIELD_KEYS.map((key) => info[key]),
    ...traces.flatMap((item) => {
      const record = object(item);
      return WAYBILL_FIELD_KEYS.map((key) => record[key]);
    }),
  ].map((candidate) => validProjectedWaybill(candidate, ownerId))
    .filter(Boolean);
}

export function projectionFromUnionPayload(
  value: unknown,
  ownerId: string,
  provider = "interface5",
  successAtMs = Date.now(),
  fullProgressRequestedAtStart = false,
  expansionProofAllowed = true,
): AccountOrderProjection | null {
  const root = object(decode(value));
  const data = object(decode(root.data));
  const floors = Array.isArray(data.floors) ? data.floors : [];
  const unionInfo = object(object(object(floors[0]).element).info);
  const records = projectionRecords(root);
  if (Object.keys(unionInfo).length) {
    if (new Set(projectedWaybills(unionInfo, ownerId)).size > 1) return null;
    records.unshift(unionInfo);
  }
  for (const info of records) {
    const traces = recordTraces(info);
    const declaredWaybills = projectedWaybills(info, ownerId);
    if (new Set(declaredWaybills).size > 1) continue;
    const waybill = declaredWaybills[0] || "";
    if (!waybill) continue;
    const companyName = firstText(info, COMPANY_FIELD_KEYS) ||
      traces.map((item) => firstText(object(item), COMPANY_FIELD_KEYS))
        .find(Boolean) || "";
    const builtIn = builtInCarrierPresentation(companyName);
    const presentation = projectedCarrierPresentation(
      waybill,
      builtIn?.courierCode || "",
      builtIn?.companyName || companyName,
    );
    const timeline = projectionTimeline(
      traces,
      waybill,
      presentation.courierCode,
      presentation.companyName,
      provider,
      successAtMs,
      fullProgressRequestedAtStart,
      expansionProofAllowed,
    );
    return {
      waybill,
      ...presentation,
      ...(timeline ? { timeline } : {}),
    };
  }
  return null;
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
    return TRUSTED_JD_RESOURCE_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
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

function projectionRequest(value: string, body = ""): boolean {
  if (unionRequest(value, body)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const raw = `${value}&${body}`;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      /* the undecoded request can still contain a projection signal */
    }
    return /(waybill|logistics|express|orderTrack|track(?:List|Detail|Info|Trace)|delivery(?:Track|Trace|Detail|Info))/i
      .test(decoded);
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

function assertProjectionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationTimeoutError();
}

function timeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperationTimeoutError());
      return;
    }
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      settle();
    };
    const abort = () => finish(() => reject(new OperationTimeoutError()));
    const timer = setTimeout(
      () => finish(() =>
        reject(new OperationTimeoutError("提取运单号超时，请稍后重试"))
      ),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function pauseWhileActive(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperationTimeoutError());
      return;
    }
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      settle();
    };
    const abort = () => finish(() => reject(new OperationTimeoutError()));
    const timer = setTimeout(() => finish(resolve), durationMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function extractionJavaScript(
  ownerId: string,
  request: CapturedRequest | null,
): string {
  const input = JSON.stringify({ ownerId, request });
  const trustedResourceHostSuffixes = JSON.stringify(
    TRUSTED_JD_RESOURCE_HOST_SUFFIXES,
  );
  return `
    return (async () => {
      const input = ${input};
      const probeKey = "__pipiDeliveriesOrderProjectionProbeV2";
      const clean = (value) => String(value == null ? "" : value).trim();
      const requestSignal = (url, body) => {
        const raw = clean(url) + "&" + clean(body);
        try { return decodeURIComponent(raw); } catch (_) { return raw; }
      };
      const relevant = (url, body) => /getUnionActivity/i.test(requestSignal(url, body));
      const trustedResourceHostSuffixes = ${trustedResourceHostSuffixes};
      const trustedJdUrl = (value) => {
        try {
          const candidate = new URL(clean(value), window.location.href);
          const host = candidate.hostname.toLowerCase();
          return candidate.protocol === "https:" &&
            trustedResourceHostSuffixes.some((suffix) =>
              host === suffix || host.endsWith("." + suffix)
            );
        } catch (_) {
          return false;
        }
      };
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
      const projection = (source, extractionSource, fullProgressRequestedAtStart = false) => {
        let root = parse(source) || source;
        if (root && typeof root.data === "string") {
          root.data = parse(root.data) || root.data;
        }
        const waybillKeys = [
          "waybillCode", "waybillNo", "waybillNum", "waybillNumber",
          "expressNo", "expressCode", "logisticsNo", "logisticsCode", "mailNo",
        ];
        const companyKeys = [
          "expressName", "carrierName", "companyName", "expressCompany",
          "expressCompanyName", "logisticsCompanyName", "logisticsCompany", "cpName",
        ];
        const traceKeys = [
          "traceList", "traces", "trackList", "tracks",
          "logisticsTraceList", "logisticsTracks",
        ];
        const floors = root && root.data && Array.isArray(root.data.floors)
          ? root.data.floors
          : [];
        const unionInfo = floors[0] && floors[0].element && floors[0].element.info
          ? floors[0].element.info
          : {};
        const records = [];
        const seen = new WeakSet();
        const visit = (candidate, depth) => {
          if (depth > 8 || records.length >= 5000 || candidate == null) return;
          const decoded = typeof candidate === "string" ? parse(candidate) : candidate;
          if (decoded !== candidate && decoded != null) {
            visit(decoded, depth + 1);
            return;
          }
          if (decoded == null || typeof decoded !== "object" || seen.has(decoded)) return;
          seen.add(decoded);
          if (Array.isArray(decoded)) {
            for (const item of decoded) visit(item, depth + 1);
            return;
          }
          records.push(decoded);
          for (const nested of Object.values(decoded)) visit(nested, depth + 1);
        };
        visit(root, 0);
        if (unionInfo && Object.keys(unionInfo).length) records.unshift(unionInfo);
        for (const info of records) {
          let traces = [];
          for (const key of traceKeys) {
            if (Array.isArray(info[key])) {
              traces = info[key];
              break;
            }
          }
          const waybillCode = [
            ...waybillKeys.map((key) => info[key]),
            ...traces.flatMap((item) => waybillKeys.map((key) => item && item[key])),
          ].map(valid).find(Boolean) || "";
          if (!waybillCode) continue;
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
          const projectedTraces = traces.slice(0, 500).map((trace) => {
            const item = trace && typeof trace === "object" ? trace : {};
            const first = (keys) => {
              for (const key of keys) {
                const value = clean(item[key]);
                if (value) return value;
              }
              return "";
            };
            return {
              waybillCode: first(waybillKeys).slice(0, 64),
              time: first(["time", "date", "ftime", "operateTime"]).slice(0, 64),
              desc: first(["desc", "context", "description", "detail", "operateMessage"])
                .slice(0, 4000),
              statusCode: first(["statusCode", "status", "state", "stateNum"]).slice(0, 128),
            };
          }).filter((trace) => trace.desc);
          return {
            waybillCode,
            companyName,
            traceList: projectedTraces,
            extractionSource,
            fullProgressRequestedAtStart: fullProgressRequestedAtStart === true,
          };
        }
        return null;
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
        let resourceReplayBlockReason = "";
        for (const entry of entries.slice(0, 5000)) {
          const name = clean(entry && entry.name);
          if (!name) continue;
          if (!relevant(name, "")) continue;
          unionResourceSeen = true;
          if (replayUrl) continue;
          if (name.length > ${MAX_CAPTURED_URL_LENGTH}) {
            resourceReplayBlockReason ||= "url_too_long";
            continue;
          }
          try {
            const candidate = new URL(name);
            if (trustedJdUrl(candidate.href)) replayUrl = name;
            else resourceReplayBlockReason ||= "untrusted_host";
          } catch (_) {
            resourceReplayBlockReason ||= "invalid_url";
          }
        }
        return {
          count: Math.min(entries.length, 100000),
          unionResourceSeen,
          replayUrl,
          resourceReplayBlockReason: replayUrl ? "" : resourceReplayBlockReason,
        };
      };
      const snapshot = (probe, resourceState) => ({
        extractionSource: "diagnostic",
        probeInstalled: Boolean(probe && probe.version === 2),
        probeRequestCount: probe && Number.isFinite(probe.requestCount)
          ? Math.min(Math.max(0, probe.requestCount), 100000)
          : 0,
        unionSignalSeen: Boolean(probe && probe.unionSignalSeen),
        unionResourceSeen: Boolean(
          (probe && probe.unionResourceSeen) || resourceState.unionResourceSeen
        ),
        resourceReplayAttempted: Boolean(probe && probe.resourceReplayAttempted),
        resourceReplaySucceeded: Boolean(probe && probe.resourceReplaySucceeded),
        resourceReplayBlockReason: clean(resourceState.resourceReplayBlockReason),
        resourceCount: resourceState.count,
        pageClass,
        readyState: clean(document && document.readyState) || "unknown",
                visibilityState: clean(document && document.visibilityState) || "unknown",
        viewportAvailable: Number(window.innerWidth || 0) > 0 && Number(window.innerHeight || 0) > 0,
        unionResponseStatuses: probe && Array.isArray(probe.unionStatuses)
          ? probe.unionStatuses.join(",")
          : "",
        probeCaptureCount: probe && Array.isArray(probe.queue) ? probe.queue.length : 0,
      });
      const resourceStateBeforeProbe = performanceResources();
      if (pageClass !== "jd") return snapshot(null, resourceStateBeforeProbe);
      const installProbe = () => {
        const existing = window[probeKey];
        if (existing && existing.version === 2) return existing;
        const probe = {
          version: 2,
          queue: [],
          requestCount: 0,
          unionSignalSeen: false,
          unionResourceSeen: resourceStateBeforeProbe.unionResourceSeen,
          resourceReplayAttempted: false,
          resourceReplaySucceeded: false,
          fullProgressClickAttempted: false,
          fullProgressAttempt: null,
          originalFetch: null,
          unionStatuses: [],
        };
        window[probeKey] = probe;
        // A synchronous XHR may finish before click() returns or throws.
        const enqueue = (source, clickAttemptAtStart = null) => Promise.resolve().then(() => {
          try {
            if (typeof source === "string" && source.length > 1500000) return;
            const result = projection(source, "probe", Boolean(clickAttemptAtStart && clickAttemptAtStart.succeeded));
            if (!result) return;
            // The page's own waybill/carrier are the reference for the modal DOM package.
            if (result.waybillCode && !probe.unionWaybill) {
              probe.unionWaybill = result.waybillCode;
              probe.unionCompanyName = result.companyName || "";
            }
            probe.queue.push(result);
            if (probe.queue.length > 4) probe.queue.splice(0, probe.queue.length - 4);
          } catch (_) {}
        });
                const recordUnionStatus = (status) => {
          try {
            if (!Array.isArray(probe.unionStatuses)) probe.unionStatuses = [];
            probe.unionStatuses.push(Number(status) || 0);
            while (probe.unionStatuses.length > 8) probe.unionStatuses.shift();
          } catch (_) {}
        };
        const captureResponse = (response, clickAttemptAtStart) => {
          try {
            if (!response || typeof response.clone !== "function") return;
            const contentType = clean(response.headers && response.headers.get &&
              response.headers.get("content-type"));
            if (contentType && !/(json|javascript|text)/i.test(contentType)) return;
            const contentLength = Number(response.headers && response.headers.get &&
              response.headers.get("content-length"));
            if (Number.isFinite(contentLength) && contentLength > 1500000) return;
            response.clone().text()
              .then((source) => enqueue(source, clickAttemptAtStart))
              .catch(() => {});
          } catch (_) {}
        };
        try {
          const originalFetch = window.fetch;
          if (typeof originalFetch === "function") {
            probe.originalFetch = originalFetch;
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
              const unionTarget = relevant(url, body);
              const target = trustedJdUrl(url);
              const clickAttemptAtStart = unionTarget ? probe.fullProgressAttempt : null;
              if (unionTarget) probe.unionSignalSeen = true;
                            const response = originalFetch.apply(this, arguments);
              if (target) {
                Promise.resolve(response)
                  .then((value) => {
                    if (unionTarget) recordUnionStatus(value && value.status);
                    captureResponse(value, clickAttemptAtStart);
                  })
                  .catch(() => {});
              }
              return response;
            };
          }
        } catch (_) {}
        try {
          const prototype = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
          if (prototype && !prototype.__pipiDeliveriesProjectionProbeV2) {
            const originalOpen = prototype.open;
            const originalSend = prototype.send;
            prototype.open = function(method, url) {
              this.__pipiDeliveriesProjectionUrl = clean(url);
              return originalOpen.apply(this, arguments);
            };
            prototype.send = function(body) {
              probe.requestCount = Math.min(probe.requestCount + 1, 100000);
              const unionTarget = relevant(this.__pipiDeliveriesProjectionUrl, body);
              const target = trustedJdUrl(this.__pipiDeliveriesProjectionUrl);
              const clickAttemptAtStart = unionTarget ? probe.fullProgressAttempt : null;
              if (target) {
                if (unionTarget) probe.unionSignalSeen = true;
                try {
                                    this.addEventListener("loadend", () => {
                    if (unionTarget) recordUnionStatus(this.status);
                    try {
                      const contentType = clean(this.getResponseHeader &&
                        this.getResponseHeader("content-type"));
                      if (!contentType || /(json|javascript|text)/i.test(contentType)) {
                        enqueue(this.responseText, clickAttemptAtStart);
                      }
                    } catch (_) {}
                  }, { once: true });
                } catch (_) {}
              }
              return originalSend.apply(this, arguments);
            };
            try {
              Object.defineProperty(prototype, "__pipiDeliveriesProjectionProbeV2", {
                value: true,
                configurable: false,
              });
            } catch (_) {
              prototype.__pipiDeliveriesProjectionProbeV2 = true;
            }
          }
        } catch (_) {}
        return probe;
      };
      const probe = installProbe();
      if (!probe.fullProgressClickAttempted) {
        let control = null;
        try {
          const candidate = document.querySelector(".logistics-button");
          const label = candidate && candidate.querySelector(".logistics-button-text");
          // The control's text node reads "完整物流进度 >"; the trailing chevron is decoration.
          const labelText = clean(label && (label.innerText || label.textContent))
            .replace(/[>›〉»]+$/, "")
            .trim();
          if (labelText === "完整物流进度") control = candidate;
        } catch (_) {}
        if (control && typeof control.click === "function") {
          probe.fullProgressClickAttempted = true;
          // Each request retains its own attempt; a later retry cannot validate a failed click.
          const attempt = { succeeded: false };
          probe.fullProgressAttempt = attempt;
          try {
            control.click();
            attempt.succeeded = true;
          } catch (_) {
            probe.fullProgressClickAttempted = false;
          }
        }
      }
      // Commit already received synchronous XHRs before a shorter modal can end capture.
      await Promise.resolve();
      // §9 (2026-09-03): the click opens a modal rendered from data the page already holds and
      // issues no new request, so the complete package is the modal's own node list: read only
      // after the exact click, from the modal header (carrier + waybill) and its .child-status
      // rows; re-read while the list keeps growing. Same rule as Pipi's document-start script.
      // (This comment lives inside a template literal: never put a backtick in it.)
      if (probe.fullProgressClickAttempted) {
        try {
          let items = document.querySelectorAll(".logistics-status-info.child-status");
          if (!items.length) items = document.querySelectorAll(".logistics-status-info");
          const head = document.querySelector(".logistics-top-narrow") ||
            document.querySelector(".express-info") ||
            document.querySelector("[class*=logistics-top]");
          // The header names the carrier and waybill in one or more lines ("极兔速递 JT… 复制");
          // the waybill is the alphanumeric token carrying digits and must agree with the page's
          // own response when one was captured (the response also fills a missing token).
          const networkWaybill = clean(probe.unionWaybill).toUpperCase();
          const headText = clean(head && head.innerText);
          const tokens = headText.replace(/复制/g, " ").match(/[A-Za-z0-9-]{8,48}/g) || [];
          let waybillCode = "";
          for (const token of tokens) {
            const candidate = valid(token);
            if (!candidate || !/\\d/.test(candidate)) continue;
            if (networkWaybill && candidate === networkWaybill) {
              waybillCode = candidate;
              break;
            }
            if (!waybillCode) waybillCode = candidate;
          }
          if (networkWaybill && waybillCode && waybillCode !== networkWaybill) waybillCode = "";
          // AGENTS §9: the modal header must name the waybill itself. Substituting the network
          // response's waybill for an unreadable header makes the header check compare a value
          // against itself, so an unmatched selector could still pass as a complete package.
          // No header waybill means no DOM package at all. Same rule as Pipi's JingDongH5Client.
          const nameMatch = headText.match(/[\\u4e00-\\u9fa5]{2,12}/);
          const companyName = nameMatch ? nameMatch[0] : clean(probe.unionCompanyName);
          probe.domModal = { i: items.length, h: Boolean(head), w: Boolean(waybillCode) };
          if (waybillCode && items.length > (probe.domModalCount || 0)) {
            {
              const traceList = [];
              for (let index = 0; index < items.length && index < 500; index++) {
                const item = items[index];
                const read = (selector) => {
                  const node = item.querySelector(selector);
                  return clean(node && node.innerText);
                };
                const time = read(".status-time");
                const desc = read(".status-msg");
                if (time && desc) {
                  traceList.push({
                    waybillCode,
                    time: time.slice(0, 64),
                    desc: desc.slice(0, 4000),
                    statusCode: "",
                  });
                }
              }
              if (traceList.length) {
                probe.domModalCount = items.length;
                probe.queue.push({
                  waybillCode,
                  companyName,
                  traceList,
                  extractionSource: "dom_modal",
                  fullProgressRequestedAtStart: true,
                });
                if (probe.queue.length > 4) probe.queue.splice(0, probe.queue.length - 4);
              }
            }
          }
        } catch (_) {}
      }
      const queued = Array.isArray(probe.queue) ? probe.queue.shift() : null;
      if (queued) return {
        ...snapshot(probe, performanceResources()),
        ...queued,
      };
      const scripts = Array.from(document.querySelectorAll("script"))
        .map((item) => item.textContent || "")
        .join("\\n")
        .slice(0, 1500000);
      const structured = [...scripts.matchAll(/["'](?:waybillCode|waybillNo|waybillNum|waybillNumber|expressNo|expressCode|logisticsNo|logisticsCode|mailNo)["']\\s*:\\s*["']([A-Za-z0-9_-]{6,64})["']/gi)];
      for (const match of structured) {
        const waybillCode = valid(match && match[1]);
        if (waybillCode) return { waybillCode, companyName: "", extractionSource: "script" };
      }
      const body = clean(document.body && document.body.innerText).slice(0, 300000);
      const visible = [...body.matchAll(/(?:运单号|快递单号|物流单号|配送单号)\\s*[：:]?\\s*([A-Za-z0-9_-]{6,64})/gi)];
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
          const replayFetch = typeof probe.originalFetch === "function"
            ? probe.originalFetch
            : window.fetch;
          const response = await replayFetch.call(window, input.request.url, options)
            .finally(() => clearTimeout(timer));
          if (response.ok) {
            const result = projection(await response.text(), "replay", false);
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
          const replayFetch = typeof probe.originalFetch === "function"
            ? probe.originalFetch
            : window.fetch;
          const response = await replayFetch.call(window, resourceState.replayUrl, {
            credentials: "include",
            signal: aborter.signal,
          }).finally(() => clearTimeout(timer));
          if (response.ok) {
            const result = projection(await response.text(), "resource_replay", false);
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
  signal?: AbortSignal,
): Promise<AccountParcelDto> {
    assertProjectionActive(signal);
  const textIdentity = parcel.textIdentity;
  if (
    parcel.source === "interface5" &&
    parcel.accountOrder &&
    textIdentity &&
    textIdentity.waybill
  ) {
    // Xiaomi's own track text already names the carrier waybill: read it directly and skip
    // the H5 page. Orders whose text never names one still go through the projection below.
    try {
      observe?.(feedTextIdentityDiagnostics());
    } catch {
      /* diagnostics are best-effort */
    }
        // The order-stage raw carrier tuple (e.g. JDKD) is not evidence for the carrier waybill and
    // must never survive the projection.
    return {
      ...parcel,
      waybill: textIdentity.waybill,
      courierCode: textIdentity.courierCode,
      rawCourierCode: "",
      rawCompanyName: textIdentity.companyName,
      companyName: textIdentity.companyName,
      carrierNormalization: null,
      projectionTimeline: null,
    };
  }
  if (
    parcel.source !== "interface5" ||
    !parcel.accountOrder ||
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
  // D-15 裁决 A′ (2026-09-04): borrow the visible page's viewport before loading, so the union
  // page's floors mount and the 「完整物流进度」 control can be clicked. Headless when no page hosts.
  let viewportHosted = false;
  let disposed = false;
  const disposeController = () => {
    if (disposed) return;
    disposed = true;
    try {
      controller.dispose();
    } catch {
      /* cancellation still owns the result even when native cleanup reports an error */
    }
  };
  const abort = () => disposeController();
  signal?.addEventListener("abort", abort, { once: true });
  let captured: CapturedRequest | null = null;
  let loadCompleted = false;
  let replayAttempted = false;
  let replaySucceeded = false;
  let probeInstalled = false;
  let probeMatched = false;
  let probeRequestCount = 0;
  let unionSignalSeen = false;
  let unionResourceSeen = false;
  let resourceReplayBlockReason = "";
  let domMatched = false;
  let projectionComplete = false;
  let projectionTrackCount = 0;
  let requestCallbackCount = 0;
  let resourceCount = 0;
  let pageClass = "unknown";
  let readyState = "unknown";
    let visibilityState = "unknown";
  let viewportAvailable = false;
  let unionResponseStatuses = "";
  let networkTraceCount = 0;
  let probeCaptureCount = 0;
  let bestProjection: AccountOrderProjection | null = null;
  const loadStartedAt = projectionStartedAtMs;
  let loadDurationMs = 0;
  let loadSettled = false;
  let loadFailure: unknown = null;
  let evaluationAttempts = 0;
  let evaluationFailures = 0;
  controller.shouldAllowRequest = async (request) => {
    if (signal?.aborted) return false;
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
    if (trustedWebResource(request.url) && projectionRequest(request.url, body)) {
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
    assertProjectionActive(signal);
    // The viewport must exist before the first paint: the union page mounts its floors by
    // intersection, so a page attached after loadURL would not re-run that mount.
    viewportHosted = await acquireProjectionViewport(controller);
    assertProjectionActive(signal);
    // A dynamic page can keep WebKit's load promise pending after its useful requests and DOM are
    // already available. Start navigation without waiting for that promise so capture and DOM
    // polling can run inside the same bounded projection window.
    try {
      void controller.loadURL(parcel.projectionUrl).then(
        (loaded) => {
          if (signal?.aborted) return;
          loadSettled = true;
          loadCompleted = loaded;
          loadDurationMs = Date.now() - loadStartedAt;
        },
        (error) => {
          if (signal?.aborted) return;
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
      assertProjectionActive(signal);
      if (loadSettled && !loadCompleted && !captured) {
        if (bestProjection) {
                return {
        ...parcel,
        waybill: bestProjection.waybill,
        courierCode: bestProjection.courierCode,
        rawCourierCode: "",
        rawCompanyName: bestProjection.companyName,
        companyName: bestProjection.companyName,
        carrierNormalization: null,
        projectionTimeline: bestProjection.timeline || null,
          };
        }
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
          signal,
        );
        if (Date.now() >= projectionDeadlineAtMs) {
          throw new OperationTimeoutError("提取运单号超时，请稍后重试");
        }
      } catch (error) {
        assertProjectionActive(signal);
        if (error instanceof OperationTimeoutError) throw error;
        evaluationFailures++;
        const elapsed = Date.now() - loadStartedAt;
        const pause = Math.min(
          elapsed < 500 ? 20 : 250,
          projectionDeadlineAtMs - Date.now(),
        );
        if (pause > 0) await pauseWhileActive(pause, signal);
        continue;
      }
      assertProjectionActive(signal);
      const candidate = object(raw);
      const extractionSource = text(candidate.extractionSource);
      const candidateTraceCount = Array.isArray(candidate.traceList)
        ? candidate.traceList.length
        : 0;
      // §9: a modal DOM package is complete only when it covers every network package the probe
      // captured in this session; the first-screen response always precedes the click.
      if (extractionSource === "probe") {
        networkTraceCount = Math.max(networkTraceCount, candidateTraceCount);
      }
      const domModal = extractionSource === "dom_modal";
      const domModalCoversNetwork = !domModal || candidateTraceCount >= networkTraceCount;
      probeInstalled ||= candidate.probeInstalled === true;
      probeMatched ||= extractionSource === "probe" || domModal;
      unionSignalSeen ||= candidate.unionSignalSeen === true;
      unionResourceSeen ||= candidate.unionResourceSeen === true;
      resourceReplayBlockReason ||= text(candidate.resourceReplayBlockReason);
      replayAttempted ||= candidate.resourceReplayAttempted === true;
      replaySucceeded ||= candidate.resourceReplaySucceeded === true ||
        extractionSource === "replay" || extractionSource === "resource_replay";
      domMatched ||= extractionSource === "dom" || extractionSource === "script" ||
        extractionSource === "dom_modal";
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
      const candidateStatuses = text(candidate.unionResponseStatuses);
      if (candidateStatuses) unionResponseStatuses = candidateStatuses;
      const candidateCaptures = Number(candidate.probeCaptureCount);
      if (Number.isFinite(candidateCaptures) && candidateCaptures >= 0) {
        probeCaptureCount = Math.max(probeCaptureCount, Math.round(candidateCaptures));
      }
      const projection = projectionFromUnionPayload(
        {
          data: {
            floors: [{
              element: {
                info: {
                  waybillCode: candidate.waybillCode,
                  expressCompanyName: candidate.companyName,
                  traceList: Array.isArray(candidate.traceList)
                    ? candidate.traceList
                    : [],
                },
              },
            }],
          },
        },
        parcel.ownerId,
        parcel.source,
        Date.now(),
        candidate.fullProgressRequestedAtStart === true && domModalCoversNetwork,
        domModalCoversNetwork,
      );
      const hasCompleteTimeline = Boolean(
        projection?.timeline?.complete === true &&
          timedTracks(projection.timeline.tracks).length,
      );
      // Without this the log cannot say whether a capture earned `complete`; the only other
      // signal was how early the loop exited, which had to be inferred from timestamps.
      projectionComplete ||= hasCompleteTimeline;
      projectionTrackCount = Math.max(
        projectionTrackCount,
        projection?.timeline ? timedTracks(projection.timeline.tracks).length : 0,
      );
      if (projection) {
        if (Date.now() >= projectionDeadlineAtMs) {
          throw new OperationTimeoutError("提取运单号超时，请稍后重试");
        }
        if (projection.timeline || !bestProjection?.timeline) {
          bestProjection = projection;
        }
        if (hasCompleteTimeline) {
          return {
            ...parcel,
            waybill: projection.waybill,
            courierCode: projection.courierCode,
            companyName: projection.companyName,
            projectionTimeline: projection.timeline || null,
          };
        }
      }
      // Scripting has no document-start injection API. Retry aggressively while the new document
      // is being created so the idempotent response probe has several chances to beat page scripts.
      const elapsed = Date.now() - loadStartedAt;
      const pause = Math.min(
        elapsed < 500 ? 20 : 250,
        projectionDeadlineAtMs - Date.now(),
      );
      if (pause > 0) await pauseWhileActive(pause, signal);
    }
    assertProjectionActive(signal);
    if (bestProjection) {
            return {
        ...parcel,
        waybill: bestProjection.waybill,
        courierCode: bestProjection.courierCode,
        rawCourierCode: "",
        rawCompanyName: bestProjection.companyName,
        companyName: bestProjection.companyName,
        carrierNormalization: null,
        projectionTimeline: bestProjection.timeline || null,
      };
    }
    if (Date.now() >= projectionDeadlineAtMs) {
      throw new OperationTimeoutError("提取运单号超时，请稍后重试");
    }
    return parcel;
  } finally {
    if (!loadDurationMs) loadDurationMs = Date.now() - loadStartedAt;
    if (!signal?.aborted) {
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
          resourceReplayBlockReason,
          domMatched,
          projectionComplete,
          projectionTrackCount,
          requestCallbackCount,
          evaluationAttempts,
          evaluationFailures,
          loadDurationMs,
          resourceCount,
          pageClass,
          readyState,
                    visibilityState,
          viewportAvailable,
          viewportHosted,
          identitySource: "webview",
          unionResponseStatuses,
          probeCaptureCount,
        });
      } catch {
        /* diagnostics are best-effort and must not change the projection result */
      }
    }
    signal?.removeEventListener("abort", abort);
    if (viewportHosted) releaseProjectionViewport();
    disposeController();
  }
}
