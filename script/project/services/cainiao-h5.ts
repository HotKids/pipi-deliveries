import type { TimelinePackage, TrackNode } from "../models";
import {
  OperationTimeoutError,
  remainingTimeoutMs,
} from "./deadline";
import {
  packageSemantic,
  parseProviderTime,
  semanticFromText,
  usableTimedTracks,
} from "./status";

const CAINIAO_H5_TIMEOUT_MS = 8_000;
const CAINIAO_H5_EVALUATION_TIMEOUT_MS = 1_000;
const CAINIAO_H5_POLL_INTERVAL_MS = 250;
const CAINIAO_H5_MAX_ATTEMPTS = 32;
const MAX_ROUTE_LENGTH = 16_384;
const MAX_TRACKS = 100;
const MAX_DETAIL_LENGTH = 2_000;

/**
 * First-party extraction baseline verified on 2026-08-30 from
 * page.cainiao.com/guoguo/app-myexpress-taobao/ld.html and its 0.0.8 asset:
 * feed[].time, feed[].standerdDesc, cpInfo.statusDesc, .package-status, and
 * .feed-item_* are all owned template fields. Revalidate this adapter when the
 * loader's publicPath version changes.
 */
export const CAINIAO_H5_ASSET_BASELINE_VERSION = "0.0.8";

export type CainiaoH5TimelineInput = Readonly<{
  routeUrl: string;
  waybill: string;
  courierCode: string;
  companyName: string;
  deadlineAtMs?: number;
  successAtMs?: number;
  signal?: AbortSignal;
}>;

export type CainiaoH5Diagnostics = Readonly<{
  routePresent: boolean;
  routeTrusted: boolean;
  waybillPresent: boolean;
  loadSettled: boolean;
  loadCompleted: boolean;
  evaluationAttempts: number;
  evaluationFailures: number;
  extractionSource: "vue" | "dom" | "none";
  rawTrackCount: number;
  validTrackCount: number;
  trackCount: number;
  exitReason: string;
  durationMs: number;
}>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maxLength = MAX_DETAIL_LENGTH): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function trustedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "cainiao.com" ||
    host.endsWith(".cainiao.com") ||
    host === "taobao.com" ||
    host.endsWith(".taobao.com");
}

export function trustedCainiaoH5Route(value: string): boolean {
  const clean = String(value || "").trim();
  if (!clean || clean.length > MAX_ROUTE_LENGTH) return false;
  try {
    const parsed = new URL(clean);
    return parsed.protocol === "https:" && trustedHost(parsed.hostname);
  } catch {
    return false;
  }
}

function httpsRequest(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function extractionJavaScript(): string {
  return `
    return (() => {
      const clean = (value) => String(value == null ? "" : value).trim().replace(/\\s+/g, " ");
      const trustedHost = (hostname) => {
        const host = clean(hostname).toLowerCase();
        return host === "cainiao.com" || host.endsWith(".cainiao.com") ||
          host === "taobao.com" || host.endsWith(".taobao.com");
      };
      try {
        const page = new URL(window.location.href);
        if (page.protocol !== "https:" || !trustedHost(page.hostname)) {
          return { extractionSource: "none", statusText: "", tracks: [] };
        }
      } catch (_) {
        return { extractionSource: "none", statusText: "", tracks: [] };
      }
      const domStatus = () => clean(
        document.querySelector(".package-status") &&
          document.querySelector(".package-status").textContent
      );
      const compactTracks = (values) => values
        .map((item) => ({
          timeText: clean(item && item.time),
          detail: clean(item && item.standerdDesc),
        }))
        .filter((item) => item.timeText && item.detail)
        .slice(0, ${MAX_TRACKS});
      const roots = [
        document.body,
        document.querySelector(".container"),
        document.querySelector(".mcn"),
        document.querySelector("#app"),
      ].filter(Boolean);
      const queue = [];
      const seen = new Set();
      for (const root of roots) {
        if (root && root.__vue__) queue.push(root.__vue__);
      }
      let vueStatus = "";
      for (let index = 0; index < queue.length && index < 32; index++) {
        const vm = queue[index];
        if (!vm || typeof vm !== "object" || seen.has(vm)) continue;
        seen.add(vm);
        const data = vm._data && typeof vm._data === "object" ? vm._data : vm;
        const cpInfo = data.cpInfo && typeof data.cpInfo === "object" ? data.cpInfo : null;
        if (!vueStatus && cpInfo) vueStatus = clean(cpInfo.statusDesc);
        const feed = Array.isArray(data.feed) ? data.feed : Array.isArray(vm.feed) ? vm.feed : null;
        if (feed) {
          const tracks = compactTracks(feed);
          if (tracks.length) {
            return {
              extractionSource: "vue",
              statusText: vueStatus || domStatus(),
              tracks,
            };
          }
        }
        const children = Array.isArray(vm.$children) ? vm.$children : [];
        for (const child of children) queue.push(child);
      }
      const tracks = Array.from(document.querySelectorAll(".feed-item"))
        .map((item) => {
          const time = clean(item.querySelector(".feed-item_time") &&
            item.querySelector(".feed-item_time").textContent);
          const date = clean(item.querySelector(".feed-item_date") &&
            item.querySelector(".feed-item_date").textContent);
          const detail = clean(item.querySelector(".feed-item_content") &&
            item.querySelector(".feed-item_content").textContent);
          return { timeText: date && time ? date + " " + time : date || time, detail };
        })
        .filter((item) => item.timeText && item.detail)
        .slice(0, ${MAX_TRACKS});
      return {
        extractionSource: tracks.length ? "dom" : "none",
        statusText: vueStatus || domStatus(),
        tracks,
      };
    })();
  `;
}

function assertCainiaoH5Active(signal?: AbortSignal): void {
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
        reject(new OperationTimeoutError("读取菜鸟物流超时，请稍后重试"))
      ),
      Math.max(1, timeoutMs),
    );
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function normalizedTimeText(value: unknown): string {
  const clean = text(value, 64)
    .replace(/[./]/g, "-")
    .replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(clean)) {
    return `${clean}:00`;
  }
  return clean;
}

function timelineFromExtraction(
  value: unknown,
  input: CainiaoH5TimelineInput,
  successAtMs: number,
): Readonly<{
  timeline: TimelinePackage | null;
  extractionSource: "vue" | "dom" | "none";
  rawTrackCount: number;
  validTrackCount: number;
}> {
  const root = object(value);
  const extractionSource = root.extractionSource === "vue" || root.extractionSource === "dom"
    ? root.extractionSource
    : "none";
  const sourceTracks = Array.isArray(root.tracks)
    ? root.tracks.slice(0, MAX_TRACKS)
    : [];
  const rawTrackCount = sourceTracks.length;
  if (extractionSource === "none" || !sourceTracks.length) {
    return {
      timeline: null,
      extractionSource,
      rawTrackCount,
      validTrackCount: 0,
    };
  }
  const tracks: TrackNode[] = [];
  const seen = new Set<string>();
  for (const raw of sourceTracks) {
    const item = object(raw);
    const timeText = normalizedTimeText(item.timeText);
    const timeMs = parseProviderTime(timeText);
    const detail = text(item.detail);
    if (timeMs == null || !detail) continue;
    const key = `${timeText}\u0000${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({
      timeText,
      timeMs,
      detail,
      statusCode: "",
      raw: { _pipiStatusSource: "web" },
    });
  }
  tracks.sort((left, right) => (right.timeMs || 0) - (left.timeMs || 0));
  const timed = usableTimedTracks(tracks);
  if (!timed.length) {
    return {
      timeline: null,
      extractionSource,
      rawTrackCount,
      validTrackCount: 0,
    };
  }
  const inferred = packageSemantic("", tracks);
  const statusSemantic = semanticFromText(text(root.statusText, 128));
  const semantic = statusSemantic === "UNKNOWN" ? inferred.semantic : statusSemantic;
  const latest = timed[0];
  const statusEventAtMs = semantic === "UNKNOWN"
    ? inferred.eventAtMs
    : latest.timeMs;
  return {
    extractionSource,
    rawTrackCount,
    validTrackCount: timed.length,
    timeline: {
      provider: "web",
      complete: timed.length >= 2,
      waybill: String(input.waybill || "").trim(),
      courierCode: String(input.courierCode || "").trim(),
      companyName: String(input.companyName || "").trim(),
      semantic,
      statusEventAtMs,
      latestTimeText: latest.timeText,
      latestDetail: latest.detail,
      tracks,
      successAtMs,
    },
  };
}

function pause(durationMs: number, signal?: AbortSignal): Promise<void> {
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

export async function scrapeCainiaoH5Timeline(
  input: CainiaoH5TimelineInput,
  observe?: (diagnostics: CainiaoH5Diagnostics) => void,
): Promise<TimelinePackage | null> {
  assertCainiaoH5Active(input.signal);
  const startedAtMs = Date.now();
  const routePresent = Boolean(String(input.routeUrl || "").trim());
  const routeTrusted = trustedCainiaoH5Route(input.routeUrl);
  const waybillPresent = Boolean(String(input.waybill || "").trim());
  const initialExitReason = !routePresent
    ? "route_missing"
    : !routeTrusted
      ? "route_untrusted"
      : !waybillPresent
        ? "waybill_missing"
        : "pending";
  if (!routeTrusted || !waybillPresent) {
    try {
      observe?.({
        routePresent,
        routeTrusted,
        waybillPresent,
        loadSettled: false,
        loadCompleted: false,
        evaluationAttempts: 0,
        evaluationFailures: 0,
        extractionSource: "none",
        rawTrackCount: 0,
        validTrackCount: 0,
        trackCount: 0,
        exitReason: initialExitReason,
        durationMs: Date.now() - startedAtMs,
      });
    } catch {
      /* diagnostics are best-effort and contain only aggregate state */
    }
    return null;
  }
  const budgetMs = remainingTimeoutMs(
    input.deadlineAtMs,
    CAINIAO_H5_TIMEOUT_MS,
    startedAtMs,
  );
  const deadlineAtMs = startedAtMs + budgetMs;
  const successAtMs = typeof input.successAtMs === "number" &&
      Number.isFinite(input.successAtMs) && input.successAtMs > 0
    ? input.successAtMs
    : startedAtMs;
  const controller = new WebViewController({ ephemeral: true });
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
  input.signal?.addEventListener("abort", abort, { once: true });
  let loadSettled = false;
  let loadCompleted = false;
  let evaluationAttempts = 0;
  let evaluationFailures = 0;
  let extractionSource: CainiaoH5Diagnostics["extractionSource"] = "none";
  let rawTrackCount = 0;
  let validTrackCount = 0;
  let trackCount = 0;
  let exitReason = "no_timed_tracks";
  controller.shouldAllowRequest = async (request) => {
    if (input.signal?.aborted) return false;
    if (!httpsRequest(request.url)) return false;
    if (request.navigationType === "other" || !request.navigationType) return true;
    return trustedCainiaoH5Route(request.url);
  };
  try {
    assertCainiaoH5Active(input.signal);
    try {
      void controller.loadURL(input.routeUrl).then(
        (loaded) => {
          if (input.signal?.aborted) return;
          loadSettled = true;
          loadCompleted = loaded;
        },
        () => {
          if (input.signal?.aborted) return;
          loadSettled = true;
        },
      );
    } catch {
      loadSettled = true;
    }
    while (
      evaluationAttempts < CAINIAO_H5_MAX_ATTEMPTS &&
      Date.now() < deadlineAtMs
    ) {
      assertCainiaoH5Active(input.signal);
      if (loadSettled && !loadCompleted) {
        exitReason = "load_failed";
        return null;
      }
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= 0) break;
      try {
        evaluationAttempts++;
        const raw = await timeout(
          controller.evaluateJavaScript<unknown>(extractionJavaScript()),
          Math.min(CAINIAO_H5_EVALUATION_TIMEOUT_MS, remaining),
          input.signal,
        );
        assertCainiaoH5Active(input.signal);
        if (Date.now() >= deadlineAtMs) {
          exitReason = "deadline_exhausted";
          throw new OperationTimeoutError("读取菜鸟物流超时，请稍后重试");
        }
        const extracted = timelineFromExtraction(raw, input, successAtMs);
        extractionSource = extracted.extractionSource;
        rawTrackCount = Math.max(rawTrackCount, extracted.rawTrackCount);
        validTrackCount = Math.max(validTrackCount, extracted.validTrackCount);
        if (extracted.timeline) {
          trackCount = extracted.timeline.tracks.length;
          exitReason = "timed_tracks";
          return extracted.timeline;
        }
      } catch (error) {
        if (input.signal?.aborted) throw new OperationTimeoutError();
        if (
          error instanceof OperationTimeoutError &&
          exitReason === "deadline_exhausted"
        ) throw error;
        evaluationFailures++;
      }
      const delay = Math.min(
        CAINIAO_H5_POLL_INTERVAL_MS,
        deadlineAtMs - Date.now(),
      );
      if (delay > 0) await pause(delay, input.signal);
    }
    assertCainiaoH5Active(input.signal);
    exitReason = Date.now() >= deadlineAtMs
      ? "deadline_exhausted"
      : "evaluation_exhausted";
    return null;
  } finally {
    if (
      !input.signal?.aborted &&
      !(input.signal && Date.now() >= deadlineAtMs)
    ) {
      try {
        observe?.({
          routePresent,
          routeTrusted,
          waybillPresent,
          loadSettled,
          loadCompleted,
          evaluationAttempts,
          evaluationFailures,
          extractionSource,
          rawTrackCount,
          validTrackCount,
          trackCount,
          exitReason,
          durationMs: Date.now() - startedAtMs,
        });
      } catch {
        /* diagnostics are best-effort and contain only aggregate state */
      }
    }
    input.signal?.removeEventListener("abort", abort);
    disposeController();
  }
}
