import { fetch } from "scripting";
import { resolveCarrierQuery } from "./carrier-query";
import { TIMELINE_SLOT } from "./timeline-slot";
import type { TimelinePackage, TrackNode } from "../models";
import {
  OperationTimeoutError,
  linkedTimeoutSignal,
  remainingTimeoutMs,
} from "./deadline";
import {
  packageSemantic,
  normalizeWaybill,
  parseProviderTime,
  usableTimedTracks,
  isProviderErrorDetail,
} from "./status";

const LOAD_TIMEOUT_MS = 10_000;
const EVALUATION_TIMEOUT_MS = 1_000;
const POLL_INTERVAL_MS = 250;
const MAX_ATTEMPTS = 40;
const MAX_TRACKS = 100;
const MAX_HTML_LENGTH = 65_536;
const BLOCKING_AD_TAG = '<script type="text/javascript" src="//a.baidinet.com/common/hc/static/b/common/i/ubd/resource/di.js"></script>';
const SCRIPT_MARKERS = ["baidinet", "jquery", "app_base", "promotion", "appGuide", "vue", "result", "inline", "other"];

export type WebTimelineDiagnostics = Readonly<{
  routePresent: boolean;
  routeTrusted: boolean;
  loadSettled: boolean;
  loadCompleted: boolean;
  htmlFetchCompleted: boolean;
  adScriptRemoved: boolean;
  evaluationAttempts: number;
  evaluationFailures: number;
  trackCount: number;
  mainPresent?: boolean;
  parsedScriptCount?: number;
  lastParsedScript?: string;
  vuePresent?: boolean;
  jqueryPresent?: boolean;
  phoneChallengeVisible?: boolean;
  locationNuMatches?: boolean;
  vmNumMatches?: boolean;
  lastQueriedNumMatches?: boolean;
  vmLoading?: boolean;
  carrierSelected?: boolean;
  carrierCandidateCount?: number;
  allListsCount?: number;
  listsCount?: number;
  queryErrorType?: string;
  rawExtractedCount?: number;
  firstTimePresent?: boolean;
  firstFtimePresent?: boolean;
  firstContextPresent?: boolean;
  firstRowOutcome?: string;
  phoneVerificationAttempted: boolean;
  readyState?: string;
  timedTrackCount: number;
  exitReason: string;
  durationMs: number;
}>;

export type WebTimelineInput = Readonly<{
  waybill: string;
  courierCode: string;
  companyName: string;
  phoneTail?: string;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  onQueryAttempted?: (authorized: boolean) => void;
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

function extractionJavaScript(waybill: string): string {
  return `
    return (() => {
      const clean = (value) => String(value == null ? "" : value).trim().replace(/\\s+/g, " ");
      // Vue 组件对象里 time/context 同名的常是过滤器函数，序列化就成假节点（Android 同页实测）；只收字符串/数字。
      const text = (value) => (typeof value === "string" || typeof value === "number") ? clean(value) : "";
      const main = document.querySelector("#main");
      const page = {
        mainPresent: Boolean(main),
        readyState: ["loading", "interactive", "complete"].includes(document.readyState)
          ? document.readyState : "unknown"
      };
      const host = clean(location.hostname).toLowerCase();
      if (!(host === "kuaidi100.com" || host.endsWith(".kuaidi100.com"))) {
        return { tracks: [], page };
      }
      // Parsed script elements identify the startup boundary without exposing page or script contents.
      const scripts = document.querySelectorAll("script");
      page.parsedScriptCount = Math.min(100, scripts.length);
      page.vuePresent = typeof window.Vue === "function";
      page.jqueryPresent = typeof window.jQuery === "function";
      if (scripts.length) {
        const src = scripts[scripts.length - 1].src;
        page.lastParsedScript = src ? "other" : "inline";
        if (src) {
          try {
            const script = new URL(src, location.href);
            if (script.hostname === "a.baidinet.com" && script.pathname === "/common/hc/static/b/common/i/ubd/resource/di.js") {
              page.lastParsedScript = "baidinet";
            } else if (script.hostname === "cdn.kuaidi100.com") {
              page.lastParsedScript = ({
                "/js/util/jquery-1.12.4.min.js": "jquery",
                "/js/page/smart/app_base.js": "app_base",
                "/js/share/promotion.js": "promotion",
                "/js/page/smart/libs/appGuide.js": "appGuide",
                "/js/share/vue.js": "vue",
                "/js/page/smart/query/result.js": "result"
              })[script.pathname] || "other";
            }
          } catch { /* malformed script attributes remain unclassified */ }
        }
      }
      const vm = main && main.__vue__;
      const expectedWaybill = ${JSON.stringify(waybill)};
      try {
        page.locationNuMatches = new URL(location.href).searchParams.get("nu") === expectedWaybill;
      } catch { /* a malformed location supplies no diagnostic evidence */ }
      if (vm) {
        // The official query sets lastnum before auto recognition; compare identities without returning them.
        page.vmNumMatches = vm.num === expectedWaybill;
        page.lastQueriedNumMatches = vm.lastnum === expectedWaybill;
        if (typeof vm.loading === "boolean") page.vmLoading = vm.loading;
        if (typeof vm.com === "string") page.carrierSelected = vm.com.length > 0;
        if (Array.isArray(vm.autos)) page.carrierCandidateCount = Math.min(100, vm.autos.length);
        if (Array.isArray(vm.alllists)) page.allListsCount = Math.min(100, vm.alllists.length);
        if (Array.isArray(vm.lists)) page.listsCount = Math.min(100, vm.lists.length);
        if (vm.errors && ["", "empty", "network", "none"].includes(vm.errors.type)) {
          page.queryErrorType = vm.errors.type;
        }
      }
      const checkCode = vm && vm.checkCode;
      if (checkCode && typeof checkCode.show === "boolean") page.phoneChallengeVisible = checkCode.show;
      const timeKeys = ["time", "ftime", "timeText", "datetime", "date"];
      const detailKeys = ["context", "desc", "detail", "remark", "status", "text"];
      const tracks = [];
      const seenTrack = new Set();
      const append = (item) => {
        if (!item || typeof item !== "object") return;
        let timeText = "";
        let detail = "";
        for (const key of timeKeys) if (!timeText) timeText = text(item[key]);
        for (const key of detailKeys) if (!detail) detail = text(item[key]);
        if (!timeText || !detail || timeText === detail) return;
        const key = timeText + "\\u0000" + detail;
        if (seenTrack.has(key)) return;
        seenTrack.add(key);
        tracks.push({ timeText, detail });
      };
      const queue = [window.__INITIAL_STATE__, window.__NUXT__, window.__NEXT_DATA__];
      for (const node of document.querySelectorAll("body,#main,#app,.container")) {
        if (node && node.__vue__) queue.push(node.__vue__);
      }
      const seen = new Set();
      for (let index = 0; index < queue.length && index < 800 && tracks.length < ${MAX_TRACKS}; index++) {
        const value = queue[index];
        // The verification form has no timeline; never inspect its entered value.
        if (value === checkCode) continue;
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
      try {
        if (vm && Array.isArray(vm.alllists) && vm.alllists.length && vm.alllists[0] !== checkCode) {
          const first = vm.alllists[0];
          const row = first && typeof first === "object" ? first : null;
          page.firstTimePresent = Boolean(row && text(row.time));
          page.firstFtimePresent = Boolean(row && text(row.ftime));
          page.firstContextPresent = Boolean(row && text(row.context));
          const selectedTime = row && timeKeys.map(key => text(row[key])).find(Boolean);
          const selectedDetail = row && detailKeys.map(key => text(row[key])).find(Boolean);
          page.firstRowOutcome = !row ? "not_object" : !selectedTime ? "missing_time"
            : !selectedDetail ? "missing_detail" : selectedTime === selectedDetail ? "same_text" : "not_extracted";
          if (page.firstRowOutcome === "not_extracted") {
            // Reference the existing extraction only; do not export an extra copy of the source row.
            page.firstRowTrackIndex = tracks.findIndex(track => track.timeText === selectedTime && track.detail === selectedDetail);
          }
        }
      } catch { /* row diagnostics must not change extraction success */ }
      return { tracks: tracks.slice(0, ${MAX_TRACKS}), page };
    })();
  `;
}

function phoneVerificationJavaScript(waybill: string, phoneTail: string): string {
  return `
    return (() => {
      const page = new URL(location.href);
      const waybill = ${JSON.stringify(waybill)};
      if (page.protocol !== "https:" || page.hostname !== "m.kuaidi100.com" ||
          page.pathname !== "/app/query/" || page.searchParams.getAll("nu").length !== 1 ||
          page.searchParams.get("nu") !== waybill) return;
      const main = document.querySelector("#main");
      const vm = main && main.__vue__;
      if (!vm || vm.num !== waybill || !vm.checkCode || vm.checkCode.show !== true ||
          typeof vm.doCheckCode !== "function") return;
      vm.checkCode.value = ${JSON.stringify(phoneTail)};
      vm.doCheckCode();
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
  input: Omit<WebTimelineInput, "deadlineAtMs" | "signal">,
  successAtMs: number,
): TimelinePackage | null {
  const root = object(value);
  const rows = Array.isArray(root.tracks) ? root.tracks.slice(0, MAX_TRACKS) : [];
  // The fixed page is queried for this waybill; retain the owner's carrier marker on its isolated K100 package.
  const kuaidi100Com = resolveCarrierQuery(input.courierCode)?.kuaidi100Code || "";
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
      raw: kuaidi100Com
        ? { _pipiStatusSource: "web", _pipiKuaidi100Com: kuaidi100Com }
        : { _pipiStatusSource: "web" },
    });
  }
  tracks.sort((left, right) => (right.timeMs || 0) - (left.timeMs || 0));
  const timed = usableTimedTracks(tracks);
  if (!timed.length) return null;
  const status = packageSemantic("", tracks);
  return {
    provider: TIMELINE_SLOT.K100_H5,
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
  const waybill = normalizeWaybill(input.waybill);
  if (!waybill) return null;
  const phoneTail = typeof input.phoneTail === "string" && /^\d{4}$/.test(input.phoneTail) ? input.phoneTail : "";
  // This stage queries the actual waybill directly; Picker links do not own its target page.
  const routeUrl = "https://m.kuaidi100.com/app/query/?nu=" + encodeURIComponent(waybill);
  const routePresent = true;
  const routeTrusted = trustedWebTimelineRoute(routeUrl);
  if (!routeTrusted) return null;
  const deadlineAtMs = startedAtMs + remainingTimeoutMs(
    input.deadlineAtMs,
    LOAD_TIMEOUT_MS,
    startedAtMs,
  );
  const controller = new WebViewController({ ephemeral: true });
  let requestStarted = false;
  let loadSettled = false;
  let loadCompleted = false;
  let htmlFetchCompleted = false;
  let adScriptRemoved = false;
  let attempts = 0;
  let failures = 0;
  let trackCount = 0;
  let mainPresent: boolean | undefined;
  let parsedScriptCount: number | undefined;
  let lastParsedScript: string | undefined;
  let vuePresent: boolean | undefined;
  let jqueryPresent: boolean | undefined;
  let phoneChallengeVisible: boolean | undefined;
  let locationNuMatches: boolean | undefined;
  let vmNumMatches: boolean | undefined;
  let lastQueriedNumMatches: boolean | undefined;
  let vmLoading: boolean | undefined;
  let carrierSelected: boolean | undefined;
  let carrierCandidateCount: number | undefined;
  let allListsCount: number | undefined;
  let listsCount: number | undefined;
  let queryErrorType: string | undefined;
  let rawExtractedCount: number | undefined;
  let firstTimePresent: boolean | undefined;
  let firstFtimePresent: boolean | undefined;
  let firstContextPresent: boolean | undefined;
  let firstRowOutcome: string | undefined;
  let readyState: string | undefined;
  let phoneVerificationAttempted = false;
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
    if (input.signal?.aborted) throw new OperationTimeoutError();
    requestStarted = true;
    const fetchTimeoutMs = remainingTimeoutMs(deadlineAtMs, LOAD_TIMEOUT_MS);
    const lifecycle = linkedTimeoutSignal(fetchTimeoutMs, input.signal);
    const fetchAbort = new AbortController();
    let rejectFetch: ((error: Error) => void) | undefined;
    const abortFetch = () => { fetchAbort.abort(); rejectFetch?.(new OperationTimeoutError()); };
    let html = "";
    try {
      const aborted = new Promise<never>((_, reject) => { rejectFetch = reject; });
      lifecycle.signal.addEventListener("abort", abortFetch, { once: true });
      if (lifecycle.signal.aborted) throw new OperationTimeoutError();
      html = await withTimeout(Promise.race([(async () => {
        const response = await fetch(routeUrl, {
          method: "GET",
          timeout: fetchTimeoutMs / 1000,
          signal: fetchAbort.signal,
          handleRedirect: async () => null,
          debugLabel: "Pipi Deliveries K100 page",
        });
        if (response.status !== 200 || response.url !== routeUrl ||
            (response.mimeType && response.mimeType !== "text/html") ||
            (response.expectedContentLength != null && response.expectedContentLength > MAX_HTML_LENGTH)) {
          throw new Error("K100 page unavailable");
        }
        const body = await response.text();
        if (!body || body.length > MAX_HTML_LENGTH) throw new Error("K100 page unavailable");
        if (lifecycle.signal.aborted || Date.now() >= deadlineAtMs) throw new OperationTimeoutError();
        return body;
      })(), aborted]), fetchTimeoutMs);
      htmlFetchCompleted = true;
    } catch {
      if (input.signal?.aborted) throw new OperationTimeoutError();
      exitReason = Date.now() >= deadlineAtMs || lifecycle.signal.aborted ? "deadline_exhausted" : "load_failed";
      return null;
    } finally {
      rejectFetch = undefined;
      fetchAbort.abort();
      lifecycle.signal.removeEventListener("abort", abortFetch);
      lifecycle.dispose();
    }
    // iOS did not intercept this parser-blocking ad subresource. Preserve the official page and its base URL,
    // removing only the observed empty tag before WebKit starts the query and normal phone-verification scripts.
    const pageHtml = html.replace(BLOCKING_AD_TAG, "");
    adScriptRemoved = pageHtml !== html;
    if (input.signal?.aborted) throw new OperationTimeoutError();
    if (Date.now() >= deadlineAtMs) {
      exitReason = "deadline_exhausted";
      return null;
    }
    void controller.loadHTML(pageHtml, routeUrl).then(
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
          controller.evaluateJavaScript<unknown>(extractionJavaScript(waybill)),
          Math.min(EVALUATION_TIMEOUT_MS, deadlineAtMs - Date.now()),
        );
        const page = object(object(raw).page);
        mainPresent = typeof page.mainPresent === "boolean" ? page.mainPresent : undefined;
        parsedScriptCount = typeof page.parsedScriptCount === "number" && Number.isInteger(page.parsedScriptCount) &&
          page.parsedScriptCount >= 0 && page.parsedScriptCount <= 100 ? page.parsedScriptCount : undefined;
        lastParsedScript = SCRIPT_MARKERS.includes(String(page.lastParsedScript)) ? String(page.lastParsedScript) : undefined;
        vuePresent = typeof page.vuePresent === "boolean" ? page.vuePresent : undefined;
        jqueryPresent = typeof page.jqueryPresent === "boolean" ? page.jqueryPresent : undefined;
        phoneChallengeVisible = typeof page.phoneChallengeVisible === "boolean" ? page.phoneChallengeVisible : undefined;
        locationNuMatches = typeof page.locationNuMatches === "boolean" ? page.locationNuMatches : undefined;
        vmNumMatches = typeof page.vmNumMatches === "boolean" ? page.vmNumMatches : undefined;
        lastQueriedNumMatches = typeof page.lastQueriedNumMatches === "boolean" ? page.lastQueriedNumMatches : undefined;
        vmLoading = typeof page.vmLoading === "boolean" ? page.vmLoading : undefined;
        carrierSelected = typeof page.carrierSelected === "boolean" ? page.carrierSelected : undefined;
        carrierCandidateCount = typeof page.carrierCandidateCount === "number" && Number.isInteger(page.carrierCandidateCount) &&
          page.carrierCandidateCount >= 0 && page.carrierCandidateCount <= 100 ? page.carrierCandidateCount : undefined;
        allListsCount = typeof page.allListsCount === "number" && Number.isInteger(page.allListsCount) &&
          page.allListsCount >= 0 && page.allListsCount <= 100 ? page.allListsCount : undefined;
        listsCount = typeof page.listsCount === "number" && Number.isInteger(page.listsCount) &&
          page.listsCount >= 0 && page.listsCount <= 100 ? page.listsCount : undefined;
        queryErrorType = ["", "empty", "network", "none"].includes(page.queryErrorType as string)
          ? page.queryErrorType as string : undefined;
        readyState = ["loading", "interactive", "complete", "unknown"].includes(String(page.readyState))
          ? String(page.readyState) : undefined;
        const extractedRows = Array.isArray(object(raw).tracks) ? object(raw).tracks as unknown[] : [];
        rawExtractedCount = Math.min(MAX_TRACKS, extractedRows.length);
        firstTimePresent = typeof page.firstTimePresent === "boolean" ? page.firstTimePresent : undefined;
        firstFtimePresent = typeof page.firstFtimePresent === "boolean" ? page.firstFtimePresent : undefined;
        firstContextPresent = typeof page.firstContextPresent === "boolean" ? page.firstContextPresent : undefined;
        firstRowOutcome = ["not_object", "missing_time", "missing_detail", "same_text", "not_extracted", "invalid_time", "provider_error", "valid"].includes(page.firstRowOutcome as string) ? page.firstRowOutcome as string : undefined;
        const firstIndex = page.firstRowTrackIndex;
        if (firstRowOutcome === "not_extracted" && typeof firstIndex === "number" &&
            Number.isInteger(firstIndex) && firstIndex >= 0 && firstIndex < rawExtractedCount) {
          const first = object(extractedRows[firstIndex]);
          const detail = String(first.detail || "").trim().replace(/\s+/g, " ").slice(0, 2_000);
          firstRowOutcome = parseProviderTime(normalizeTime(String(first.timeText || ""))) == null ? "invalid_time"
            : isProviderErrorDetail(detail) ? "provider_error" : "valid";
        }
        const timeline = webTimelineFromExtraction(raw, { ...input, waybill }, startedAtMs);
        if (phoneTail && phoneChallengeVisible === true && !phoneVerificationAttempted && Date.now() < deadlineAtMs) {
          // Claim before evaluation: a timeout or rejected form must not resubmit this input.
          phoneVerificationAttempted = true;
          await withTimeout(
            controller.evaluateJavaScript<unknown>(phoneVerificationJavaScript(waybill, phoneTail)),
            Math.min(EVALUATION_TIMEOUT_MS, deadlineAtMs - Date.now()),
          );
        } else if (timeline) {
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
    if (requestStarted) input.onQueryAttempted?.(true);
    input.signal?.removeEventListener("abort", abort);
    dispose();
    try {
      observe?.({
        routePresent,
        routeTrusted,
        loadSettled,
        loadCompleted,
        htmlFetchCompleted,
        adScriptRemoved,
        evaluationAttempts: attempts,
        evaluationFailures: failures,
        trackCount,
        mainPresent,
        parsedScriptCount,
        lastParsedScript,
        vuePresent,
        jqueryPresent,
        phoneChallengeVisible,
        locationNuMatches,
        vmNumMatches,
        lastQueriedNumMatches,
        vmLoading,
        carrierSelected,
        carrierCandidateCount,
        allListsCount,
        listsCount,
        queryErrorType,
        rawExtractedCount,
        firstTimePresent,
        firstFtimePresent,
        firstContextPresent,
        firstRowOutcome,
        phoneVerificationAttempted,
        readyState,
        timedTrackCount: trackCount,
        exitReason,
        durationMs: Date.now() - startedAtMs,
      });
    } catch {
      /* aggregate diagnostics are best effort */
    }
  }
}
