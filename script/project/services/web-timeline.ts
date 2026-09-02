import type { TimelinePackage, TrackNode } from "../models";
import {
  OperationTimeoutError,
  remainingTimeoutMs,
} from "./deadline";
import {
  packageSemantic,
  parseProviderTime,
  usableTimedTracks,
} from "./status";

const LOAD_TIMEOUT_MS = 10_000;
const EVALUATION_TIMEOUT_MS = 1_000;
const POLL_INTERVAL_MS = 250;
const MAX_ATTEMPTS = 40;
const MAX_TRACKS = 100;

export type WebTimelineDiagnostics = Readonly<{
  routePresent: boolean;
  routeTrusted: boolean;
  loadSettled: boolean;
  loadCompleted: boolean;
  evaluationAttempts: number;
  evaluationFailures: number;
  trackCount: number;
  exitReason: string;
  durationMs: number;
}>;

export type WebTimelineInput = Readonly<{
  routeUrl: string;
  waybill: string;
  courierCode: string;
  companyName: string;
  deadlineAtMs?: number;
  signal?: AbortSignal;
}>;

function trustedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "kuaidi100.com" || host.endsWith(".kuaidi100.com");
}

export function trustedWebTimelineRoute(value: string): boolean {
  const clean = String(value || "").trim();
  if (!clean || clean.length > 16_384) return false;
  try {
    const url = new URL(clean);
    return url.protocol === "https:" && trustedHost(url.hostname);
  } catch {
    return false;
  }
}

function extractionJavaScript(): string {
  return `
    return (() => {
      const clean = (value) => String(value == null ? "" : value).trim().replace(/\\s+/g, " ");
      const host = clean(location.hostname).toLowerCase();
      if (!(host === "kuaidi100.com" || host.endsWith(".kuaidi100.com"))) {
        return { tracks: [] };
      }
      const timeKeys = ["time", "ftime", "timeText", "datetime", "date"];
      const detailKeys = ["context", "desc", "detail", "remark", "status", "text"];
      const tracks = [];
      const seenTrack = new Set();
      const append = (item) => {
        if (!item || typeof item !== "object") return;
        let timeText = "";
        let detail = "";
        for (const key of timeKeys) if (!timeText) timeText = clean(item[key]);
        for (const key of detailKeys) if (!detail) detail = clean(item[key]);
        if (!timeText || !detail || timeText === detail) return;
        const key = timeText + "\\u0000" + detail;
        if (seenTrack.has(key)) return;
        seenTrack.add(key);
        tracks.push({ timeText, detail });
      };
      const queue = [window.__INITIAL_STATE__, window.__NUXT__, window.__NEXT_DATA__];
      for (const node of document.querySelectorAll("body,#app,.container")) {
        if (node && node.__vue__) queue.push(node.__vue__);
      }
      const seen = new Set();
      for (let index = 0; index < queue.length && index < 800 && tracks.length < ${MAX_TRACKS}; index++) {
        const value = queue[index];
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        if (Array.isArray(value)) {
          for (const child of value) {
            append(child);
            if (child && typeof child === "object") queue.push(child);
          }
          continue;
        }
        append(value);
        for (const child of Object.values(value)) {
          if (child && typeof child === "object") queue.push(child);
        }
      }
      if (!tracks.length) {
        const selectors = [
          ".result-list li", ".result-list .item", ".result-list .row",
          ".trace-list li", ".timeline li", ".logistics li", "[class*=trace] li"
        ];
        for (const selector of selectors) {
          for (const row of document.querySelectorAll(selector)) {
            const timeNode = row.querySelector("time,.time,.date,[class*=time],[class*=date]");
            const detailNode = row.querySelector(".context,.desc,.text,.status,[class*=context],[class*=desc]");
            const timeText = clean(timeNode && timeNode.textContent);
            const detail = clean(detailNode && detailNode.textContent);
            if (timeText && detail) append({ time: timeText, context: detail });
          }
          if (tracks.length) break;
        }
      }
      return { tracks: tracks.slice(0, ${MAX_TRACKS}) };
    })();
  `;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeTime(value: unknown): string {
  const clean = String(value || "").trim().replace(/[./]/g, "-").replace("T", " ");
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(clean) ? `${clean}:00` : clean;
}

export function webTimelineFromExtraction(
  value: unknown,
  input: Omit<WebTimelineInput, "routeUrl" | "deadlineAtMs" | "signal">,
  successAtMs: number,
): TimelinePackage | null {
  const root = object(value);
  const rows = Array.isArray(root.tracks) ? root.tracks.slice(0, MAX_TRACKS) : [];
  const seen = new Set<string>();
  const tracks: TrackNode[] = [];
  for (const raw of rows) {
    const row = object(raw);
    const timeText = normalizeTime(row.timeText);
    const timeMs = parseProviderTime(timeText);
    const detail = String(row.detail || "").trim().replace(/\s+/g, " ").slice(0, 2_000);
    const key = `${timeText}\u0000${detail}`;
    if (timeMs == null || !detail || seen.has(key)) continue;
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
  if (!timed.length) return null;
  const status = packageSemantic("", tracks);
  return {
    provider: "web",
    complete: timed.length >= 2,
    waybill: input.waybill,
    courierCode: input.courierCode,
    companyName: input.companyName,
    semantic: status.semantic,
    statusEventAtMs: status.eventAtMs,
    latestTimeText: timed[0].timeText,
    latestDetail: timed[0].detail,
    tracks,
    successAtMs,
  };
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new OperationTimeoutError());
    const timer = setTimeout(done, ms);
    const abort = () => done(new OperationTimeoutError());
    function done(error?: Error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new OperationTimeoutError()), Math.max(1, ms));
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function scrapeWebTimeline(
  input: WebTimelineInput,
  observe?: (diagnostics: WebTimelineDiagnostics) => void,
): Promise<TimelinePackage | null> {
  const startedAtMs = Date.now();
  const routePresent = Boolean(String(input.routeUrl || "").trim());
  const routeTrusted = trustedWebTimelineRoute(input.routeUrl);
  if (!routeTrusted || !String(input.waybill || "").trim()) return null;
  const deadlineAtMs = startedAtMs + remainingTimeoutMs(
    input.deadlineAtMs,
    LOAD_TIMEOUT_MS,
    startedAtMs,
  );
  const controller = new WebViewController({ ephemeral: true });
  let loadSettled = false;
  let loadCompleted = false;
  let attempts = 0;
  let failures = 0;
  let trackCount = 0;
  let exitReason = "no_timed_tracks";
  const dispose = () => { try { controller.dispose(); } catch { /* best effort */ } };
  const abort = () => dispose();
  input.signal?.addEventListener("abort", abort, { once: true });
  controller.shouldAllowRequest = async (request) => {
    if (input.signal?.aborted) return false;
    try {
      const url = new URL(request.url);
      if (url.protocol !== "https:") return false;
      return request.navigationType === "other" || !request.navigationType
        ? true
        : trustedWebTimelineRoute(request.url);
    } catch {
      return false;
    }
  };
  try {
    void controller.loadURL(input.routeUrl).then(
      (loaded) => { loadSettled = true; loadCompleted = loaded; },
      () => { loadSettled = true; },
    );
    while (attempts < MAX_ATTEMPTS && Date.now() < deadlineAtMs) {
      if (input.signal?.aborted) throw new OperationTimeoutError();
      if (loadSettled && !loadCompleted) {
        exitReason = "load_failed";
        break;
      }
      try {
        attempts++;
        const raw = await withTimeout(
          controller.evaluateJavaScript<unknown>(extractionJavaScript()),
          Math.min(EVALUATION_TIMEOUT_MS, deadlineAtMs - Date.now()),
        );
        const timeline = webTimelineFromExtraction(raw, input, startedAtMs);
        if (timeline) {
          trackCount = timeline.tracks.length;
          exitReason = "timed_tracks";
          return timeline;
        }
      } catch {
        failures++;
      }
      const wait = Math.min(POLL_INTERVAL_MS, deadlineAtMs - Date.now());
      if (wait > 0) await pause(wait, input.signal);
    }
    exitReason = Date.now() >= deadlineAtMs ? "deadline_exhausted" : exitReason;
    return null;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    dispose();
    try {
      observe?.({
        routePresent,
        routeTrusted,
        loadSettled,
        loadCompleted,
        evaluationAttempts: attempts,
        evaluationFailures: failures,
        trackCount,
        exitReason,
        durationMs: Date.now() - startedAtMs,
      });
    } catch {
      /* aggregate diagnostics are best effort */
    }
  }
}
