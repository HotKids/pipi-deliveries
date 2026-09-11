import type { AppState, BindingSource } from "../models";
import { SCRIPT_BINDING_SOURCE } from "./script-source";
import { SCRIPT_BUILD_TRACK, SCRIPT_CLIENT_BUILD } from "./build-track";
import { OperationTimeoutError, type RequestTimeoutDetails } from "./deadline";

export type DiagnosticLevel = "info" | "warning" | "error";

export type DiagnosticDetails = Partial<RequestTimeoutDetails> & {
  flowId?: string;
  blockingFlowId?: string;
  blockingTrigger?: string;
  blockingLeaseAgeMs?: number;
  blockingLeaseRemainingMs?: number;
  source?: BindingSource;
  requestedSource?: BindingSource;
  handlerSource?: BindingSource;
  activeSource?: BindingSource;
  baseActiveSource?: BindingSource;
  baseRevision?: number;
  revision?: number;
  resultRevision?: number;
  v5Bindings?: number;
  attempted?: number;
  candidateCount?: number;
  availableCandidateCount?: number;
  captureComplete?: boolean;
  hasPickup?: boolean;
  foreignPackage?: boolean;
  foreignAnchorAtMs?: number;
  earliestTrackAtMs?: number;
  waybillMatches?: boolean;
  waybillMatchesOrder?: boolean;
  incompleteReason?: string;
  attempt?: number;
  mode?: "manual" | "refresh" | "last_detail";
  upstreamCode?: number;
  valueKind?: string;
  redirectPresent?: boolean;
  succeeded?: number;
  failed?: number;
  rawRecords?: number;
  records?: number;
  rejectedRecords?: number;
  orders?: number;
  routableOrders?: number;
  ownerFingerprint?: string;
  waybillTail?: string;
  sourceProvider?: string;
  carrierCode?: string;
  /** The raw platform code the source sent (JD/JDKD…), before recognition. */
  rawCarrierCode?: string;
  /** The code actually shown to the user, after the R-20 display rules. */
  displayCarrierCode?: string;
  /** Whitelisted StatusSemantic value. */
  statusSemantic?: string;
  structuredStatus?: boolean;
  detailStatusSemantic?: string;
  latestTrackSemantic?: string;
  missingStatusRefresh?: boolean;
  unprojectedOrder?: boolean;
  detailComplete?: boolean;
  /** What started this refresh: detail_pull / detail_open / identity_projection. */
  trigger?: string;
  /** Why a chain ran or was skipped: owner_pickup / jd_h5_complete / cooldown / no_evidence. */
  gateReason?: string;
  routeKind?: string;
  skipReason?: string;
  extractionSource?: string;
  exitReason?: string;
  historyProvider?: string;
  headlineProvider?: string;
  statusProvider?: string;
  selectionReason?: string;
  timelineProvider?: string;
  requestProvider?: string;
  displayTimelineProvider?: string;
  finalTimelineProvider?: string;
  detailTimelineProvider?: string;
  executionBoundary?: "per_stage" | "host_budget";
  scriptVersion?: string;
  clientBuild?: number;
  httpStatus?: number;
  failureCode?: string;
  authRuntime?: string;
  durationMs?: number;
  budgetMs?: number;
  blockedMs?: number;
  deadlineLagMs?: number;
  /** Widget timeline cadence: wall time since this widget last started a run. */
  sincePreviousMs?: number;
  /** The reload delay this widget run asked WidgetKit for. */
  reloadAfterMs?: number;
  readbackMatched?: boolean;
  loadSettled?: boolean;
  loadCompleted?: boolean;
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
  startupRecovery?: string;
  phoneVerificationAttempted?: boolean;
  timedTrackCount?: number;
  captureSeen?: boolean;
  replayAttempted?: boolean;
  replaySucceeded?: boolean;
  probeInstalled?: boolean;
  probeMatched?: boolean;
  probeRequestCount?: number;
  unionSignalSeen?: boolean;
  unionResourceSeen?: boolean;
  resourceReplayBlockReason?: string;
  domMatched?: boolean;
  requestCallbackCount?: number;
  evaluationAttempts?: number;
  evaluationFailures?: number;
  loadDurationMs?: number;
  resourceCount?: number;
  rawTrackCount?: number;
  validTrackCount?: number;
  effectiveTrackCount?: number;
  detailEffectiveTrackCount?: number;
  latestEventAtMs?: number;
  latestTrackAtMs?: number;
  feedEventAtMs?: number;
  statusEventAtMs?: number;
  primarySuccessCount?: number;
  primaryReachedTimelineStart?: boolean;
  pageClass?: string;
  readyState?: string;
  visibilityState?: string;
  viewportAvailable?: boolean;
  automatic?: boolean;
  selected?: boolean;
  webViewAllowed?: boolean;
  routePointerPresent?: boolean;
  routePresent?: boolean;
  routeTrusted?: boolean;
  routeCaptured?: boolean;
  waybillPresent?: boolean;
  persisted?: boolean;
  v4QuerySupported?: boolean;
  v4QuerySucceeded?: boolean;
  k100H5Succeeded?: boolean;
  kdniaoAttempted?: boolean;
  kdniaoSucceeded?: boolean;
  result?: string;
  stage?: string;
  errorCategory?: string;
  /** 统一用词（2026-09-05）：这一行归属的接口，v1…v6；手动件省略。 */
  interface?: string;
  /** 统一用词（2026-09-05）：链上的哪一级，见 unifiedLevel()。 */
  level?: string;
};

export type DiagnosticEntry = {
  id: string;
  at: string;
  level: DiagnosticLevel;
  event: string;
  details: DiagnosticDetails;
};

const DIAGNOSTIC_KEY = "pipi_deliveries_diagnostic_log_v1";
/**
 * Recording is a user switch. Beta defaults to enabled; formal builds require an explicit opt-in.
 */
const DIAGNOSTIC_ENABLED_KEY = "pipi_deliveries_diagnostic_enabled_v1";
// A single foreground refresh can emit dozens of causally related stage records.
// Keep enough history to preserve several complete refresh flows for diagnosis.
const MAX_RECORDS = 200;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOSED_FLOWS = 256;
const SAFE_TEXT = /^[A-Za-z0-9._:-]{1,64}$/;
const SOURCES = new Set<BindingSource>([SCRIPT_BINDING_SOURCE]);
const closedFlowIds = new Set<string>();
const flowTriggers = new Map<string, string>();

const DETAIL_KEYS = new Set<keyof DiagnosticDetails>([
  "blockingFlowId", "blockingTrigger", "blockingLeaseAgeMs", "blockingLeaseRemainingMs",
  "timeoutOrigin", "requestPhase", "requestBudgetMs", "requestElapsedMs", "responseHeadersAfterMs", "responseBodyAfterMs",
  "foreignAnchorAtMs", "earliestTrackAtMs",
  "hasPickup", "foreignPackage", "waybillMatches", "waybillMatchesOrder",
  "candidateCount", "availableCandidateCount", "captureComplete", "incompleteReason",
  "requestProvider", "displayTimelineProvider",
  "historyProvider", "headlineProvider", "statusProvider", "selectionReason",
  "interface",
  "level",
  "flowId",
  "source",
  "requestedSource",
  "handlerSource",
  "activeSource",
  "baseActiveSource",
  "baseRevision",
  "revision",
  "resultRevision",
  "v5Bindings",
  "attempted",
  "attempt",
  "mode",
  "upstreamCode",
  "valueKind",
  "redirectPresent",
  "succeeded",
  "failed",
  "rawRecords",
  "records",
  "rejectedRecords",
  "orders",
  "routableOrders",
  "ownerFingerprint",
  "waybillTail",
  "sourceProvider",
  "carrierCode",
  "rawCarrierCode",
  "displayCarrierCode",
  "statusSemantic",
  "structuredStatus",
  "detailStatusSemantic",
  "latestTrackSemantic",
  "missingStatusRefresh",
  "unprojectedOrder",
  "detailComplete",
  "trigger",
  "gateReason",
  "routeKind",
  "skipReason",
  "extractionSource",
  "exitReason",
  "timelineProvider",
  "finalTimelineProvider",
  "detailTimelineProvider",
  "executionBoundary",
  "scriptVersion",
  "clientBuild",
  "httpStatus",
  "failureCode",
  "authRuntime",
  "durationMs",
  "budgetMs",
  "blockedMs",
  "deadlineLagMs",
  "sincePreviousMs",
  "reloadAfterMs",
  "projectionTrackCount",
  "cooldownRemainingMs",
  "readbackMatched",
  "loadSettled",
  "loadCompleted",
  "mainPresent",
  "parsedScriptCount",
  "lastParsedScript",
  "vuePresent",
  "jqueryPresent",
  "phoneChallengeVisible",
  "locationNuMatches",
  "vmNumMatches",
  "lastQueriedNumMatches",
  "vmLoading",
  "carrierSelected",
  "carrierCandidateCount",
  "allListsCount",
  "listsCount",
  "queryErrorType",
  "rawExtractedCount",
  "firstTimePresent",
  "firstFtimePresent",
  "firstContextPresent",
  "firstRowOutcome",
  "startupRecovery",
  "phoneVerificationAttempted",
  "timedTrackCount",
  "captureSeen",
  "replayAttempted",
  "replaySucceeded",
  "probeInstalled",
  "probeMatched",
  "probeRequestCount",
  "unionSignalSeen",
  "unionResourceSeen",
  "resourceReplayBlockReason",
  "domMatched",
  "requestCallbackCount",
  "evaluationAttempts",
  "evaluationFailures",
  "loadDurationMs",
  "resourceCount",
  "rawTrackCount",
  "validTrackCount",
  "effectiveTrackCount",
  "detailEffectiveTrackCount",
  "latestEventAtMs",
  "latestTrackAtMs",
  "feedEventAtMs",
  "statusEventAtMs",
  "primarySuccessCount",
  "primaryReachedTimelineStart",
  "pageClass",
  "readyState",
  "visibilityState",
  "viewportAvailable",
  "viewportHosted",
  "projectionComplete",
  "accumulatedStart",
  "automatic",
  "selected",
  "webViewAllowed",
  "routePointerPresent",
  "routePresent",
  "routeTrusted",
  "routeCaptured",
  "waybillPresent",
  "persisted",
  "v4QuerySupported",
  "v4QuerySucceeded",
  "k100H5Succeeded",
  "kdniaoAttempted",
  "kdniaoSucceeded",
  "result",
  "stage",
  "errorCategory",
]);

const SOURCE_KEYS = new Set<keyof DiagnosticDetails>([
  "source",
  "requestedSource",
  "handlerSource",
  "activeSource",
  "baseActiveSource",
]);

const NUMBER_KEYS = new Set<keyof DiagnosticDetails>([
  "blockingLeaseAgeMs", "blockingLeaseRemainingMs",
  "requestBudgetMs", "requestElapsedMs", "responseHeadersAfterMs", "responseBodyAfterMs",
  "foreignAnchorAtMs", "earliestTrackAtMs",
  "candidateCount", "availableCandidateCount",
  "baseRevision",
  "revision",
  "resultRevision",
  "v5Bindings",
  "attempted",
  "succeeded",
  "failed",
  "rawRecords",
  "records",
  "rejectedRecords",
  "orders",
  "routableOrders",
  "httpStatus",
  "durationMs",
  "budgetMs",
  "blockedMs",
  "deadlineLagMs",
  "sincePreviousMs",
  "reloadAfterMs",
  "projectionTrackCount",
  "cooldownRemainingMs",
  "probeRequestCount",
  "requestCallbackCount",
  "evaluationAttempts",
  "evaluationFailures",
  "loadDurationMs",
  "resourceCount",
  "rawTrackCount",
  "validTrackCount",
  "effectiveTrackCount",
  "detailEffectiveTrackCount",
  "latestEventAtMs",
  "latestTrackAtMs",
  "feedEventAtMs",
  "statusEventAtMs",
  "primarySuccessCount",
  "clientBuild",
]);

const BOOLEAN_KEYS = new Set<keyof DiagnosticDetails>([
  "hasPickup", "foreignPackage", "waybillMatches", "waybillMatchesOrder",
  "captureComplete",
  "vuePresent",
  "jqueryPresent",
  "mainPresent",
  "phoneChallengeVisible",
  "locationNuMatches",
  "vmNumMatches",
  "lastQueriedNumMatches",
  "vmLoading",
  "firstTimePresent",
  "firstFtimePresent",
  "firstContextPresent",
  "carrierSelected",
  "phoneVerificationAttempted",
  "redirectPresent",
  "structuredStatus",
  "missingStatusRefresh",
  "unprojectedOrder",
  "detailComplete",
  "readbackMatched",
  "loadSettled",
  "loadCompleted",
  "captureSeen",
  "replayAttempted",
  "replaySucceeded",
  "probeInstalled",
  "probeMatched",
  "unionSignalSeen",
  "unionResourceSeen",
  "domMatched",
  "viewportAvailable",
  "viewportHosted",
  "projectionComplete",
  "accumulatedStart",
  "automatic",
  "selected",
  "webViewAllowed",
  "routePointerPresent",
  "routePresent",
  "routeTrusted",
  "routeCaptured",
  "waybillPresent",
  "persisted",
  "v4QuerySupported",
  "v4QuerySucceeded",
  "k100H5Succeeded",
  "primaryReachedTimelineStart",
  "kdniaoAttempted",
  "kdniaoSucceeded",
]);

const SAFE_FAILURE_CODES = new Set([
  "attestation_rejected",
  "body_too_large",
  "carrier_mismatch",
  "carrier_unknown",
  "delegation_unavailable",
  "detail_route_not_reconstructable",
  "expired_request",
  "forbidden",
  "gateway_not_configured",
  "invalid_company_code",
  "invalid_content_length",
  "invalid_express_identity",
  "invalid_express_interface",
  "invalid_express_operation",
  "invalid_flight_operation",
  "invalid_input",
  "invalid_jd_app_route",
  "invalid_json",
  "invalid_movie_operation",
  "invalid_order_id",
  "invalid_primary_routes",
  "invalid_push_receipt",
  "invalid_query",
  "invalid_railway_operation",
  "invalid_response",
  "invalid_route_credential",
  "invalid_timeline_query",
  "invalid_upstream_response",
  "invalid_waybill",
  "invalid_weather_operation",
  "method_not_allowed",
  "network",
  "not_found",
  "phone_tail",
  "rate_limited",
  "rejected",
  "replay_store_unavailable",
  "replayed_request",
  "unauthorized",
  "upstream_rejected",
  "upstream_unavailable",
]);

function validEntry(value: unknown, now: number): value is DiagnosticEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DiagnosticEntry>;
  const at = typeof item.at === "string" ? new Date(item.at).getTime() : NaN;
  return Boolean(
    typeof item.id === "string" &&
      SAFE_TEXT.test(item.id) &&
      typeof item.event === "string" &&
      SAFE_TEXT.test(item.event) &&
      (item.level === "info" || item.level === "warning" || item.level === "error") &&
      Number.isFinite(at) &&
      at <= now &&
      now - at < MAX_AGE_MS &&
      item.details &&
      typeof item.details === "object" &&
      !Array.isArray(item.details),
  );
}

/**
 * 统一用词（用户定 2026-09-05，三端同一套）：日志里的参数值一律写规范化后的词——接口 v1…v6，
 * 链上的一级写 level 词（v5_list / v5_query / v6_query / v4_query / v2_query / jd_h5 / cn_h5 /
 * k100_h5 / kdniao / k100_autoCom）。调用点还是按各自的类型传旧名，落日志前在这里统一换掉。
 */
const SOURCE_WIRE: Record<string, string> = {
  interface5: "v5",
  interface6: "v6",
};
const STAGE_WIRE: Record<string, string> = {
  account_list: "v5_list",
  account_detail: "v5_query",
  jingdong_h5: "jd_h5",
  cainiao_h5: "cn_h5",
  kuaidi100_query: "k100_h5",
  web_timeline: "k100_h5",
  picker_query: "v6_query",
  pending_picker: "v6_query",
  route: "v6_query",
  moto_query: "v4_query",
  pending_moto: "v4_query",
  local: "v4_query",
  kdniao_fallback: "kdniao",
  pending_kdniao: "kdniao",
  fallback: "kdniao",
  classify: "k100_autoCom",
  carrier_detect: "k100_autoCom",
};
const PROVIDER_WIRE: Record<string, string> = {
  interface5: "v5_list",
  account: "v5_list",
  v5_list: "v5_list",
  meizu: "v6_query",
  route: "v6_query",
  moto: "v4_query",
  local: "v4_query",
  fallback: "kdniao",
  kuaidi100_h5: "k100_h5",
  kuaidi100: "k100_h5",
  jingdong_h5: "jd_h5",
  cainiao_h5: "cn_h5",
  web: "cn_h5",
};
const PROVIDER_KEYS = new Set<keyof DiagnosticDetails>([
  "requestProvider", "displayTimelineProvider",
  "timelineProvider",
  "finalTimelineProvider",
  "detailTimelineProvider",
]);
const NORMALIZED_SOURCES = new Set(Object.values(SOURCE_WIRE));

function unifiedWire(key: keyof DiagnosticDetails, value: string): string {
  const lower = value.trim().toLowerCase();
  if ((key === "level" || key === "stage" || PROVIDER_KEYS.has(key)) &&
      (lower === "v6_picker" || lower === "meizu_picker")) return "v6_query";
  if (key === "sourceProvider") return ({ cainiao: "cainiao", jingdong: "jingdong",
    shunfeng: "sfexpress", sfexpress: "sfexpress", douyin: "douyin" } as Record<string, string>)[lower] || value;
  if (key === "stage") return STAGE_WIRE[lower] || value;
  if (PROVIDER_KEYS.has(key)) return PROVIDER_WIRE[lower] || value;
  return value;
}

function sanitizeDetails(value: DiagnosticDetails): DiagnosticDetails {
  const result: DiagnosticDetails = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey as keyof DiagnosticDetails;
    if (!DETAIL_KEYS.has(key) || rawValue == null) continue;
    if (key === "readyState") {
      if (["loading", "interactive", "complete", "unknown"].includes(rawValue as string)) result.readyState = rawValue as string;
      continue;
    }
    if (key === "timedTrackCount" || key === "parsedScriptCount" ||
        key === "carrierCandidateCount" || key === "allListsCount" || key === "listsCount" || key === "rawExtractedCount") {
      if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue >= 0 && rawValue <= 100) result[key] = rawValue;
      continue;
    }
    if (key === "startupRecovery") {
      if (["pending", "applied", "skipped", "failed"].includes(rawValue as string)) result.startupRecovery = rawValue as string;
      continue;
    }
    if (key === "firstRowOutcome") {
      if (["not_object", "missing_time", "missing_detail", "same_text", "not_extracted", "invalid_time", "provider_error", "valid"].includes(rawValue as string)) result.firstRowOutcome = rawValue as string;
      continue;
    }
    if (key === "queryErrorType") {
      if (["", "empty", "network", "none"].includes(rawValue as string)) result.queryErrorType = rawValue as string;
      continue;
    }
    if (key === "lastParsedScript") {
      if (["baidinet", "jquery", "app_base", "promotion", "appGuide", "vue", "result", "inline", "other"].includes(rawValue as string)) result.lastParsedScript = rawValue as string;
      continue;
    }
    if (key === "attempt") {
      if (rawValue === 1 || rawValue === 2) result.attempt = rawValue;
      continue;
    }
    if (key === "upstreamCode") {
      if (typeof rawValue === "number" && Number.isSafeInteger(rawValue)) result.upstreamCode = rawValue;
      continue;
    }
    if (key === "mode") {
      if (rawValue === "manual" || rawValue === "refresh" || rawValue === "last_detail") result.mode = rawValue;
      continue;
    }
    if (key === "valueKind") {
      if (["missing", "null", "object", "array", "string", "number", "boolean"].includes(rawValue as string)) {
        result.valueKind = rawValue as string;
      }
      continue;
    }
    if (key === "waybillTail") {
      const tail = String(rawValue).trim().toUpperCase();
      if (/^[A-Z0-9]{4}$/.test(tail)) result.waybillTail = tail;
      continue;
    }
    if (key === "failureCode") {
      const code = String(rawValue).trim().toLowerCase();
      if (SAFE_FAILURE_CODES.has(code)) {
        result.failureCode = code;
      }
      continue;
    }
    if (SOURCE_KEYS.has(key)) {
      const raw = String(rawValue);
      const wire = SOURCE_WIRE[raw] || raw;
      if (SOURCES.has(raw as BindingSource) || NORMALIZED_SOURCES.has(wire)) {
        (result as Record<string, unknown>)[key] = wire;
      }
      continue;
    }
    if (NUMBER_KEYS.has(key)) {
      const number = Number(rawValue);
      if (Number.isFinite(number) && number >= 0) {
        (result as Record<string, unknown>)[key] = Math.round(number);
      }
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof rawValue === "boolean") {
        (result as Record<string, unknown>)[key] = rawValue;
      }
      continue;
    }
    const text = unifiedWire(key, String(rawValue || "").trim());
    if (SAFE_TEXT.test(text)) {
      (result as Record<string, unknown>)[key] = text;
    }
  }
  return result;
}

/**
 * The stored entries, pruned of anything expired or malformed.
 *
 * `sanitize` re-runs the whitelist over entries that are already on disk. That is defence in depth
 * against a record written by an older build, and it belongs on the READ path only: on the write
 * path it re-sanitized all 200 stored entries for every single line, which — together with the two
 * whole-array JSON.stringify calls the change check used to do — made each log line cost a full
 * validate + sanitize + double-serialize pass over the entire log.
 *
 * The array itself is still re-read on every write rather than cached in a module variable: the
 * key is shared, and the widget process appends to the same log, so a cached copy in the app
 * process would silently drop whatever the widget wrote.
 */
function storedEntries(now = Date.now(), sanitize = false): DiagnosticEntry[] {
  try {
    const value = Storage.get<DiagnosticEntry[]>(DIAGNOSTIC_KEY, { shared: true });
    if (!Array.isArray(value)) return [];
    const kept = value.filter((item) => validEntry(item, now));
    const retained = kept.length > MAX_RECORDS ? kept.slice(-MAX_RECORDS) : kept;
    if (retained.length !== value.length) {
      try {
        if (retained.length) {
          Storage.set(DIAGNOSTIC_KEY, retained, { shared: true });
        } else {
          Storage.remove(DIAGNOSTIC_KEY, { shared: true });
        }
      } catch {
        /* expiry cleanup retries the next time diagnostics are read */
      }
    }
    return sanitize
      ? retained.map((item) => ({ ...item, details: sanitizeDetails(item.details) }))
      : retained;
  } catch {
    return [];
  }
}

export function createDiagnosticFlowId(prefix: string): string {
  const safePrefix = SAFE_TEXT.test(prefix) ? prefix : "flow";
  return `${safePrefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

export function diagnosticState(state: AppState): DiagnosticDetails {
  return {
    activeSource: SCRIPT_BINDING_SOURCE,
    revision: state.revision,
    v5Bindings: state.bindings.filter(
      (binding) => binding.source === "interface5",
    ).length,
  };
}

export function classifyDiagnosticError(error: unknown): string {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const rawCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : "";
  const code = typeof rawCode === "string" ? rawCode.trim().toLowerCase() : "";
  const status = Number(
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : 0,
  );
  if (name.includes("abort") || message.includes("取消")) return "cancelled";
  if (name.includes("timeout") || message.includes("超时")) return "timeout";
  if (status === 401 || status === 403) return "authorization";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "service";
  if (code === "invalid_upstream_response") return "protocol";
  if (code === "invalid_company_code" || code === "invalid_input") {
    return "validation";
  }
  if (code === "rate_limited") return "rate_limited";
  if (
    code === "upstream_rejected" ||
    code === "upstream_unavailable"
  ) return "upstream";
  if (
    name.includes("accountparse") ||
    message.includes("响应与当前运单不匹配") ||
    message.includes("物流信息与当前运单不符")
  ) return "protocol";
  if (name.includes("accountapi")) {
    return message.includes("参数") || message.includes("手机号") ||
        message.includes("验证码") || message.includes("身份") ||
        message.includes("设备验证") || message.includes("无法打开")
      ? "validation"
      : "upstream";
  }
  if (
    name.includes("kuaidi100") ||
    message.includes("暂无轨迹") ||
    message.includes("无法识别")
  ) return "no_result";
  if (
    message.includes("已不在列表") ||
    message.includes("已从列表中移除")
  ) return "removed";
  if (message.includes("状态已更新")) return "state_changed";
  if (message.includes("服务暂时不可用")) return "service";
  if (
    message.includes("网络") ||
    message.includes("连接")
  ) return "network";
  if (
    message.includes("token") ||
    message.includes("access key") ||
    message.includes("授权")
  ) return "authorization";
  if (message.includes("保存") || message.includes("storage")) return "storage";
  if (message.includes("手机号") || message.includes("验证码")) return "validation";
  return "unknown";
}

export function diagnosticErrorDetails(error: unknown): DiagnosticDetails {
  const status = Number(
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : 0,
  );
  const rawGatewayCode = error && typeof error === "object" && "gatewayCode" in error
    ? (error as { gatewayCode?: unknown }).gatewayCode
    : "";
  const gatewayCode = typeof rawGatewayCode === "string"
    ? rawGatewayCode.trim().toLowerCase()
    : "";
  const rawAccountCode = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : "";
  const accountCode = typeof rawAccountCode === "string"
    ? rawAccountCode.trim().toLowerCase()
    : "";
  const rawAuthRuntime = error && typeof error === "object" && "authRuntime" in error
    ? (error as { authRuntime?: unknown }).authRuntime
    : "";
  const authRuntime = typeof rawAuthRuntime === "string"
    ? rawAuthRuntime.trim().toLowerCase()
    : "";
  const failureCode = SAFE_FAILURE_CODES.has(gatewayCode)
    ? gatewayCode
    : SAFE_FAILURE_CODES.has(accountCode)
      ? accountCode
      : "";
  return {
    errorCategory: classifyDiagnosticError(error),
    ...(error instanceof OperationTimeoutError ? error.requestDetails : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599
      ? { httpStatus: status }
      : {}),
    ...(failureCode
      ? { failureCode }
      : {}),
    ...(authRuntime === "data-key" || authRuntime === "key-data" ||
        authRuntime === "sha256-invalid" || authRuntime === "hmac-invalid"
      ? { authRuntime }
      : {}),
  };
}

/** Beta records by default; the formal build stays quiet until the user turns it on. */
const DIAGNOSTICS_DEFAULT_ENABLED = SCRIPT_BUILD_TRACK === "beta";

export function diagnosticsEnabled(): boolean {
  try {
    const stored = Storage.get<boolean>(DIAGNOSTIC_ENABLED_KEY, { shared: true });
    return typeof stored === "boolean" ? stored : DIAGNOSTICS_DEFAULT_ENABLED;
  } catch {
    return DIAGNOSTICS_DEFAULT_ENABLED;
  }
}

/** Turning recording off stops every write; the entries already stored are left alone. */
export function setDiagnosticsEnabled(enabled: boolean): boolean {
  try {
    Storage.set(DIAGNOSTIC_ENABLED_KEY, enabled === true, { shared: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 统一用词（用户定 2026-09-05，三端同一套）：每行带 `level`（链上的哪一级）与 `interface`
 * （归属接口）。旧字段 `stage` / `timelineProvider` 先并存一版方便对照，值来自它们推导：
 * v5_list / v5_query / v6_query / v4_query / v2_query / jd_h5 / cn_h5 / k100_h5 / kdniao /
 * k100_autoCom。iOS 只接接口 5，所以接口相关的行一律 interface=v5。
 */
const LEVEL_BY_STAGE: Record<string, string> = {
  jt_h5: "jt_h5",
  v6_query: "v6_query",
  v6_refresh: "v6_refresh",
  account_list: "v5_list",
  account_detail: "v5_query",
  jingdong_h5: "jd_h5",
  detail_webview: "jd_h5",
  detail_webview_commit: "jd_h5",
  cainiao_h5: "cn_h5",
  kuaidi100_query: "k100_h5",
  web_timeline: "k100_h5",
  picker_query: "v6_query",
  pending_picker: "v6_query",
  route: "v6_query",
  moto_query: "v4_query",
  pending_moto: "v4_query",
  local: "v4_query",
  kdniao_fallback: "kdniao",
  pending_kdniao: "kdniao",
  fallback: "kdniao",
  classify: "k100_autoCom",
  carrier_detect: "k100_autoCom",
};
const LEVEL_BY_PROVIDER: Record<string, string> = {
  jt_h5: "jt_h5",
  interface5: "v5_list",
  account: "v5_list",
  v5_list: "v5_list",
  meizu: "v6_query",
  route: "v6_query",
  moto: "v4_query",
  local: "v4_query",
  kdniao: "kdniao",
  fallback: "kdniao",
  kuaidi100_h5: "k100_h5",
  kuaidi100: "k100_h5",
  jingdong_h5: "jd_h5",
  cainiao_h5: "cn_h5",
  web: "cn_h5",
  v5_query: "v5_query",
  v4_query: "v4_query",
  v6_query: "v6_query",
  v6_refresh: "v6_refresh",
  v2_query: "v2_query",
  jd_h5: "jd_h5",
  cn_h5: "cn_h5",
  k100_h5: "k100_h5",
};
const INTERFACE_LEVELS = new Set(["v5_list", "v5_query"]);

export function unifiedLevel(details: DiagnosticDetails): string {
  if (details.level) return String(details.level);
  if (details.requestProvider) return String(details.requestProvider);
  const stage = String(details.stage || "").trim().toLowerCase();
  const byStage = LEVEL_BY_STAGE[stage];
  const provider = String(details.timelineProvider || "").trim().toLowerCase();
  const byProvider = LEVEL_BY_PROVIDER[provider];
  // manual_refresh / manual_query / detail_refresh 这类阶段名不指向某一级，看包/来源名。
  if (byStage) return byStage;
  if (byProvider) return byProvider;
  return "";
}

export function writeDiagnostic(
  event: string,
  details: DiagnosticDetails = {},
  level: DiagnosticLevel = "info",
): void {
  if (!diagnosticsEnabled()) return;
  const cleanEvent = String(event || "").trim();
  if (!SAFE_TEXT.test(cleanEvent)) return;
  const now = Date.now();
  const unified = unifiedLevel(details);
  const cleanDetails = sanitizeDetails({
    ...details,
    clientBuild: SCRIPT_CLIENT_BUILD,
    ...(unified ? { level: unified } : {}),
    ...(unified && INTERFACE_LEVELS.has(unified) && !details.interface
      ? { interface: "v5" }
      : {}),
  });
  const flowId = cleanDetails.flowId || "";
  if (flowId && closedFlowIds.has(flowId)) return;
  if (flowId) {
    if (cleanDetails.trigger) {
      flowTriggers.set(flowId, cleanDetails.trigger);
      while (flowTriggers.size > MAX_CLOSED_FLOWS) {
        flowTriggers.delete(flowTriggers.keys().next().value!);
      }
    } else if (flowTriggers.has(flowId)) {
      cleanDetails.trigger = flowTriggers.get(flowId);
    }
  }
  const item: DiagnosticEntry = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date(now).toISOString(),
    level,
    event: cleanEvent,
    details: cleanDetails,
  };
  try {
    Storage.set(
      DIAGNOSTIC_KEY,
      [...storedEntries(now), item].slice(-MAX_RECORDS),
      { shared: true },
    );
    if (
      flowId &&
      (cleanEvent === "refresh.succeeded" || cleanEvent === "refresh.failed")
    ) {
      closedFlowIds.add(flowId);
      flowTriggers.delete(flowId);
      while (closedFlowIds.size > MAX_CLOSED_FLOWS) {
        const oldest = closedFlowIds.values().next().value;
        if (typeof oldest !== "string") break;
        closedFlowIds.delete(oldest);
      }
    }
  } catch {
    /* diagnostics must never change app behavior */
  }
}

export function readDiagnostics(): DiagnosticEntry[] {
  return storedEntries(Date.now(), true).reverse();
}

export function clearDiagnostics(): void {
  try {
    Storage.remove(DIAGNOSTIC_KEY, { shared: true });
    closedFlowIds.clear();
    flowTriggers.clear();
  } catch {
    throw new Error("诊断日志清空失败");
  }
}

export function diagnosticText(entries = readDiagnostics()): string {
  return entries
    .map((entry) => {
      const details = Object.entries(entry.details)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      return `${entry.at} ${entry.level.toUpperCase()} ${entry.event}${
        details ? ` ${details}` : ""
      }`;
    })
    .join("\n");
}
