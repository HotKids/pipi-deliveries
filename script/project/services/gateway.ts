import { fetch } from "scripting";
import { GATEWAY_ORIGIN } from "./build-track";
import {
  gatewayCredentialStatus,
  loadGatewayCredentials,
} from "./credentials";
import {
  SCRIPTING_PROTOCOL_VERSION,
  SCRIPTING_REQUEST_METHOD,
  scriptingCanonicalRequest,
  scriptingTokenSecret,
} from "./scripting-auth";
import {
  linkedTimeoutSignal,
  OperationTimeoutError,
  remainingTimeoutMs,
  type RequestTimeoutDetails,
} from "./deadline";
import {
  scriptingCryptoRuntimeLabel,
  scriptingHmacSha256Hex,
} from "./scripting-crypto";
import { utf8Data } from "./scripting-data";
import { createDiagnosticFlowId, writeDiagnostic } from "./logger";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SAFE_GATEWAY_ERROR_CODES = new Set([
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
  "recognition_pending",
  "replay_store_unavailable",
  "replayed_request",
  "unauthorized",
  "upstream_unavailable",
  "upstream_business_error",
  "phone_verification_required",
]);

export class GatewayError extends Error {
  readonly status: number;
  readonly gatewayCode: string;
  readonly authRuntime: string;
  readonly retryAtMs: number;

  constructor(
    message: string,
    status = 0,
    gatewayCode = "",
    authRuntime = "",
    retryAtMs = 0,
  ) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.gatewayCode = gatewayCode;
    this.authRuntime = authRuntime;
    this.retryAtMs = retryAtMs;
  }
}

export function canonicalRequest(
  timestamp: number,
  nonce: string,
  route: string,
  bodySha256: string,
): string {
  return scriptingCanonicalRequest(timestamp, nonce, route, bodySha256);
}

export function hmacSha256Hex(key: string, value: string): string {
  return scriptingHmacSha256Hex(key, value);
}

function sha256Hex(value: string): string {
  return Crypto.sha256(utf8Data(value)).toHexString().toLowerCase();
}

function tokenSecret(token: string): string {
  const secret = scriptingTokenSecret(token);
  if (!secret) {
    throw new GatewayError("Access Key 格式不正确");
  }
  return secret;
}

export type ScriptingAuthHeaders = {
  "X-Scripting-Version": string;
  "X-Scripting-Token": string;
  "X-Scripting-Timestamp": string;
  "X-Scripting-Nonce": string;
  "X-Scripting-Signature": string;
};

/**
 * Builds the protocol-v1 authentication headers as one atomic contract. The
 * Worker, not the client, enforces timestamp freshness and one-time nonce use.
 */
export function scriptingAuthHeaders(
  token: string,
  timestamp: number,
  nonce: string,
  route: string,
  bodySha256: string,
): ScriptingAuthHeaders {
  const secret = tokenSecret(token);
  return {
    "X-Scripting-Version": SCRIPTING_PROTOCOL_VERSION,
    "X-Scripting-Token": secret,
    "X-Scripting-Timestamp": String(timestamp),
    "X-Scripting-Nonce": nonce,
    "X-Scripting-Signature": hmacSha256Hex(
      secret,
      canonicalRequest(timestamp, nonce, route, bodySha256),
    ),
  };
}

function requestNonce(): string {
  return Crypto.generateSymmetricKey(128).toHexString().toLowerCase();
}

function validateRoute(route: string): string {
  const clean = route.trim();
  if (!clean.startsWith("/api/") || clean.includes("?") || clean.includes("#")) {
    throw new GatewayError("无效的查询路径");
  }
  return clean;
}

function failureMessage(status: number): string {
  if (status === 401) return "访问授权无效，请检查 Access Key 与系统时间";
  if (status === 403) return "当前授权不可使用此功能";
  if (status === 408) return "请求超时，请稍后重试";
  if (status === 429) return "请求过于频繁，请稍后重试";
  if (status >= 500) return "服务暂时不可用，请稍后重试";
  return "查询失败，请稍后重试";
}

export function gatewayErrorCode(responseText: string): string {
  if (!responseText || responseText.length > 4_096) return "";
  try {
    const value = JSON.parse(responseText) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const raw = (value as { error?: unknown }).error;
    if (typeof raw !== "string") return "";
    const code = raw.trim().toLowerCase();
    return SAFE_GATEWAY_ERROR_CODES.has(code) ? code : "";
  } catch {
    return "";
  }
}

function recognitionRetryAt(responseText: string): number {
  if (gatewayErrorCode(responseText) !== "recognition_pending") return 0;
  const value = (JSON.parse(responseText) as { retryAt?: unknown }).retryAt;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export async function postGateway<T extends Record<string, unknown>>(
  routeInput: string,
  payload: Record<string, unknown>,
  options: {
    timeoutMs?: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
    onQueryAttempted?: (authorized: boolean) => void;
  } = {},
): Promise<T> {
  const credentialStatus = gatewayCredentialStatus();
  if (credentialStatus === "conflict") {
    throw new GatewayError(
      "本地访问授权记录不一致，请在设置中重新保存 Access Key",
    );
  }
  const credentials = loadGatewayCredentials();
  if (!credentials) {
    throw new GatewayError("请先配置 Access Key");
  }
  const route = validateRoute(routeInput);
  const body = JSON.stringify(payload || {});
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = requestNonce();
  let authHeaders: ScriptingAuthHeaders;
  try {
    authHeaders = scriptingAuthHeaders(
      credentials.token,
      timestamp,
      nonce,
      route,
      sha256Hex(body),
    );
  } catch {
    throw new GatewayError(
      "当前 Scripting 版本的加密组件不可用，请更新后重试",
      0,
      "",
      scriptingCryptoRuntimeLabel(),
    );
  }

  let response;
  let requestStarted = false;
  let requestSettled = false;
  let responseText = "";
  const timeoutMs = remainingTimeoutMs(
    options.deadlineAtMs,
    Math.min(Number(options.timeoutMs) || REQUEST_TIMEOUT_MS, 60_000),
  );
  const requestStartedAtMs = Date.now();
  const requestId = createDiagnosticFlowId("request");
  const lifecycleDeadlineAtMs = requestStartedAtMs + timeoutMs;
  let requestPhase: RequestTimeoutDetails["requestPhase"] = "request";
  let responseHeadersAfterMs: number | undefined;
  let responseBodyAfterMs: number | undefined;
  let signalAbortAfterMs: number | undefined;
  let callerSettledAfterMs: number | undefined;
  const timeoutError = (timeoutOrigin: RequestTimeoutDetails["timeoutOrigin"]) => {
    const observedAtMs = Date.now();
    return new OperationTimeoutError(undefined, {
      requestId, signalAbortAfterMs,
      timeoutOrigin, requestPhase, requestBudgetMs: timeoutMs,
      requestElapsedMs: observedAtMs - requestStartedAtMs,
      responseHeadersAfterMs, responseBodyAfterMs,
      deadlineLagMs: Math.max(0, observedAtMs - lifecycleDeadlineAtMs),
    });
  };
  const lifecycle = linkedTimeoutSignal(timeoutMs, options.signal);
  let rejectLifecycle: ((reason: Error) => void) | undefined;
  const abortLifecycle = () => {
    signalAbortAfterMs = Date.now() - requestStartedAtMs;
    rejectLifecycle?.(timeoutError(options.signal?.aborted ? "parent_signal" : "timeout_signal"));
  };
  try {
    if (lifecycle.signal.aborted) throw timeoutError(options.signal?.aborted ? "parent_signal" : "timeout_signal");
    const expired = new Promise<void>((_, reject) => {
      rejectLifecycle = reject;
    });
    lifecycle.signal.addEventListener("abort", abortLifecycle, { once: true });
    const request = (async () => {
      requestStarted = true;
      response = await fetch(`${GATEWAY_ORIGIN}${route}`, {
        method: SCRIPTING_REQUEST_METHOD,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...authHeaders,
        },
        body,
        timeout: timeoutMs / 1000,
        signal: lifecycle.signal,
        debugLabel: `Pipi Deliveries ${route}`,
      });
      responseHeadersAfterMs = Date.now() - requestStartedAtMs;
      if (lifecycle.signal.aborted) {
        throw timeoutError(options.signal?.aborted ? "parent_signal" : "timeout_signal");
      }
      if (Date.now() >= lifecycleDeadlineAtMs) {
        throw timeoutError("deadline_after_headers");
      }
      requestPhase = "response_body";
      if (
        typeof response.expectedContentLength === "number" &&
        response.expectedContentLength > MAX_RESPONSE_BYTES
      ) {
        throw new GatewayError("服务响应异常", response.status);
      }
      const text = await response.text();
      responseBodyAfterMs = Date.now() - requestStartedAtMs;
      requestPhase = "response_complete";
      if (Date.now() >= lifecycleDeadlineAtMs) {
        throw timeoutError("deadline_after_body");
      }
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new GatewayError("服务响应异常", response.status);
      }
      responseText = text;
    })();
    // A timed-out caller can finish before the native fetch/body callback. Observe
    // that callback without waiting for it or exposing its request/response data.
    const observeSettlement = () => {
      requestSettled = true;
      if (callerSettledAfterMs == null) return;
      writeDiagnostic("gateway.request.late_settled", {
        requestId, signalAbortAfterMs, callerSettledAfterMs,
        requestPhase, requestBudgetMs: timeoutMs,
        requestElapsedMs: Date.now() - requestStartedAtMs,
        responseHeadersAfterMs, responseBodyAfterMs,
        result: "settled",
      });
    };
    void request.then(observeSettlement, observeSettlement);
    await Promise.race([request, expired]);
  } catch (error) {
    if (error instanceof GatewayError || error instanceof OperationTimeoutError) {
      throw error;
    }
    if (lifecycle.signal.aborted) throw timeoutError(options.signal?.aborted ? "parent_signal" : "timeout_signal");
    if (error instanceof Error && error.name === "TimeoutError") throw timeoutError("native_timeout");
    if (error instanceof Error && error.name === "AbortError") throw timeoutError("native_abort");
    if (Date.now() >= lifecycleDeadlineAtMs) {
      throw timeoutError("deadline_after_error");
    }
    throw new GatewayError("网络连接异常，请稍后重试");
  } finally {
    callerSettledAfterMs = Date.now() - requestStartedAtMs;
    rejectLifecycle = undefined;
    lifecycle.signal.removeEventListener("abort", abortLifecycle);
    lifecycle.cancel();
    lifecycle.dispose();
    if (requestStarted && !requestSettled) {
      writeDiagnostic("gateway.request.wait_ended", {
        requestId, signalAbortAfterMs, callerSettledAfterMs,
        requestPhase, requestBudgetMs: timeoutMs,
        requestElapsedMs: callerSettledAfterMs,
        responseHeadersAfterMs, responseBodyAfterMs,
        result: "native_pending",
      });
    }
    // Access rejection is not evidence that a parcel lookup was permitted.
    if (requestStarted) {
      options.onQueryAttempted?.(response?.status !== 401 && response?.status !== 403);
    }
  }

  let value: unknown;
  try { value = JSON.parse(responseText) as unknown; } catch { /* HTTP errors can have non-JSON bodies. */ }
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const normalized = root?.normalizedError as { version?: unknown; code?: unknown } | undefined;
  if (normalized?.version === 1 && typeof normalized.code === "string") {
    const code = SAFE_GATEWAY_ERROR_CODES.has(normalized.code)
      ? normalized.code : "upstream_business_error";
    throw new GatewayError(
      code === "phone_verification_required" ? "请输入正确的手机尾号"
        : failureMessage(code === "rate_limited" ? 429 : code === "unauthorized" ? 401 : response.status),
      response.status, code,
    );
  }
  if (!response.ok) {
    throw new GatewayError(
      failureMessage(response.status),
      response.status,
      gatewayErrorCode(responseText),
      response.status === 401 ? scriptingCryptoRuntimeLabel() : "",
      response.status === 502 ? recognitionRetryAt(responseText) : 0,
    );
  }
  if (!root) throw new GatewayError("服务响应异常", response.status);
  return root as T;
}
