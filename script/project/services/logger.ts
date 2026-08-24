import type { AppState, BindingSource } from "../models";
import { SCRIPT_BINDING_SOURCE } from "./script-source";

export type DiagnosticLevel = "info" | "warning" | "error";

export type DiagnosticDetails = {
  flowId?: string;
  source?: BindingSource;
  requestedSource?: BindingSource;
  handlerSource?: BindingSource;
  activeSource?: BindingSource;
  baseActiveSource?: BindingSource;
  baseRevision?: number;
  revision?: number;
  resultRevision?: number;
  interface5Bindings?: number;
  attempted?: number;
  succeeded?: number;
  failed?: number;
  rawRecords?: number;
  records?: number;
  rejectedRecords?: number;
  orders?: number;
  routableOrders?: number;
  ownerFingerprint?: string;
  httpStatus?: number;
  failureCode?: string;
  authRuntime?: string;
  durationMs?: number;
  budgetMs?: number;
  blockedMs?: number;
  deadlineLagMs?: number;
  readbackMatched?: boolean;
  loadSettled?: boolean;
  loadCompleted?: boolean;
  captureSeen?: boolean;
  replayAttempted?: boolean;
  replaySucceeded?: boolean;
  probeInstalled?: boolean;
  probeMatched?: boolean;
  probeRequestCount?: number;
  unionSignalSeen?: boolean;
  unionResourceSeen?: boolean;
  domMatched?: boolean;
  requestCallbackCount?: number;
  evaluationAttempts?: number;
  evaluationFailures?: number;
  loadDurationMs?: number;
  resourceCount?: number;
  pageClass?: string;
  readyState?: string;
  visibilityState?: string;
  viewportAvailable?: boolean;
  result?: string;
  stage?: string;
  errorCategory?: string;
};

export type DiagnosticEntry = {
  id: string;
  at: string;
  level: DiagnosticLevel;
  event: string;
  details: DiagnosticDetails;
};

const DIAGNOSTIC_KEY = "pipi_deliveries_diagnostic_log_v1";
const MAX_RECORDS = 100;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_TEXT = /^[A-Za-z0-9._:-]{1,64}$/;
const SOURCES = new Set<BindingSource>([SCRIPT_BINDING_SOURCE]);

const DETAIL_KEYS = new Set<keyof DiagnosticDetails>([
  "flowId",
  "source",
  "requestedSource",
  "handlerSource",
  "activeSource",
  "baseActiveSource",
  "baseRevision",
  "revision",
  "resultRevision",
  "interface5Bindings",
  "attempted",
  "succeeded",
  "failed",
  "rawRecords",
  "records",
  "rejectedRecords",
  "orders",
  "routableOrders",
  "ownerFingerprint",
  "httpStatus",
  "failureCode",
  "authRuntime",
  "durationMs",
  "budgetMs",
  "blockedMs",
  "deadlineLagMs",
  "readbackMatched",
  "loadSettled",
  "loadCompleted",
  "captureSeen",
  "replayAttempted",
  "replaySucceeded",
  "probeInstalled",
  "probeMatched",
  "probeRequestCount",
  "unionSignalSeen",
  "unionResourceSeen",
  "domMatched",
  "requestCallbackCount",
  "evaluationAttempts",
  "evaluationFailures",
  "loadDurationMs",
  "resourceCount",
  "pageClass",
  "readyState",
  "visibilityState",
  "viewportAvailable",
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
  "baseRevision",
  "revision",
  "resultRevision",
  "interface5Bindings",
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
  "probeRequestCount",
  "requestCallbackCount",
  "evaluationAttempts",
  "evaluationFailures",
  "loadDurationMs",
  "resourceCount",
]);

const BOOLEAN_KEYS = new Set<keyof DiagnosticDetails>([
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
]);

const SAFE_FAILURE_CODES = new Set([
  "attestation_rejected",
  "body_too_large",
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
  "invalid_route_credential",
  "invalid_timeline_query",
  "invalid_upstream_response",
  "invalid_waybill",
  "invalid_weather_operation",
  "method_not_allowed",
  "not_found",
  "rate_limited",
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

function sanitizeDetails(value: DiagnosticDetails): DiagnosticDetails {
  const result: DiagnosticDetails = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey as keyof DiagnosticDetails;
    if (!DETAIL_KEYS.has(key) || rawValue == null) continue;
    if (key === "failureCode") {
      const code = String(rawValue).trim().toLowerCase();
      if (SAFE_FAILURE_CODES.has(code)) {
        result.failureCode = code;
      }
      continue;
    }
    if (SOURCE_KEYS.has(key)) {
      if (SOURCES.has(rawValue as BindingSource)) {
        (result as Record<string, unknown>)[key] = rawValue;
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
    const text = String(rawValue || "").trim();
    if (SAFE_TEXT.test(text)) {
      (result as Record<string, unknown>)[key] = text;
    }
  }
  return result;
}

function storedEntries(now = Date.now()): DiagnosticEntry[] {
  try {
    const value = Storage.get<DiagnosticEntry[]>(DIAGNOSTIC_KEY, { shared: true });
    if (!Array.isArray(value)) return [];
    const retained = value
      .filter((item) => validEntry(item, now))
      .map((item) => ({ ...item, details: sanitizeDetails(item.details) }))
      .slice(-MAX_RECORDS);
    if (
      retained.length !== value.length ||
      JSON.stringify(retained) !== JSON.stringify(value)
    ) {
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
    return retained;
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
    interface5Bindings: state.bindings.filter(
      (binding) => binding.source === "interface5",
    ).length,
  };
}

export function classifyDiagnosticError(error: unknown): string {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
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

export function writeDiagnostic(
  event: string,
  details: DiagnosticDetails = {},
  level: DiagnosticLevel = "info",
): void {
  const cleanEvent = String(event || "").trim();
  if (!SAFE_TEXT.test(cleanEvent)) return;
  const now = Date.now();
  const item: DiagnosticEntry = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date(now).toISOString(),
    level,
    event: cleanEvent,
    details: sanitizeDetails(details),
  };
  try {
    Storage.set(
      DIAGNOSTIC_KEY,
      [...storedEntries(now), item].slice(-MAX_RECORDS),
      { shared: true },
    );
  } catch {
    /* diagnostics must never change app behavior */
  }
}

export function readDiagnostics(): DiagnosticEntry[] {
  return storedEntries().reverse();
}

export function clearDiagnostics(): void {
  try {
    Storage.remove(DIAGNOSTIC_KEY, { shared: true });
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
