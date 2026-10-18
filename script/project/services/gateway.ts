import { fetch } from "scripting";
import { GATEWAY_ORIGIN, SCRIPTING_GATEWAY_PROTOCOL_VERSION } from "./build-track";
import {
  gatewayCredentialStatus,
  loadGatewayCredentials,
  beginGatewayCredentialObservation,
  recordGatewayCredentialOutcome,
} from "./credentials";
import {
  SCRIPTING_PROTOCOL_VERSION,
  SCRIPTING_REQUEST_METHOD,
  scriptingCanonicalRequest,
  scriptingKeyMaterial,
  scriptingActivationHash,
  normalizeScriptingToken,
  scriptingLegacyCanonicalRequest,
  SCRIPTING_LEGACY_EXPIRES_AT_SECONDS,
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
import {
  loadScriptingActivation,
  recordScriptingActivationOutcome,
} from "./scripting-activation";

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
  // Access Key activation (CONTRACT §3.3): the two codes this client must tell apart from the
  // generic 403 forbidden and 5xx answers.
  "key_activated_elsewhere",
  "key_store_unavailable",
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
  keyId: string,
  activationHash: string,
): string {
  return scriptingCanonicalRequest(timestamp, nonce, GATEWAY_ORIGIN,
    route, bodySha256, keyId, activationHash);
}

export function hmacSha256Hex(key: string, value: string): string {
  return scriptingHmacSha256Hex(key, value);
}

function sha256Hex(value: string): string {
  return Crypto.sha256(utf8Data(value)).toHexString().toLowerCase();
}

type SharedScriptingAuthHeaders = {
  "X-Scripting-Version": string;
  "X-Scripting-Activation": string;
  "X-Scripting-Timestamp": string;
  "X-Scripting-Nonce": string;
  "X-Scripting-Signature": string;
};
export type ScriptingAuthHeaders = SharedScriptingAuthHeaders & (
  { "X-Scripting-Key-Id": string } | { "X-Scripting-Token": string }
);

/**
 * The package selects one protocol before delivery; a failed request never changes it. The
 * Worker, not the client, enforces timestamp freshness and one-time nonce use.
 */
export function scriptingAuthHeaders(
  token: string,
  timestamp: number,
  nonce: string,
  route: string,
  bodySha256: string,
  activationIdentity: string,
  protocol: "1" | "2" = SCRIPTING_GATEWAY_PROTOCOL_VERSION,
): ScriptingAuthHeaders {
  if (protocol === "1") {
    if (timestamp >= SCRIPTING_LEGACY_EXPIRES_AT_SECONDS) {
      throw new GatewayError(SCRIPTING_UPDATE_REQUIRED_MESSAGE);
    }
    const secret = normalizeScriptingToken(token);
    if (!secret) throw new GatewayError(ACCESS_KEY_INVALID_MESSAGE);
    scriptingActivationHash(activationIdentity, sha256Hex);
    return {
      "X-Scripting-Version": "1",
      "X-Scripting-Token": secret,
      "X-Scripting-Activation": activationIdentity,
      "X-Scripting-Timestamp": String(timestamp),
      "X-Scripting-Nonce": nonce,
      "X-Scripting-Signature": hmacSha256Hex(secret,
        scriptingLegacyCanonicalRequest(timestamp, nonce, route, bodySha256)),
    };
  }
  if (protocol !== "2") throw new GatewayError(SCRIPTING_UPDATE_REQUIRED_MESSAGE);
  const material = scriptingKeyMaterial(token, sha256Hex, hmacSha256Hex);
  if (!material) throw new GatewayError(ACCESS_KEY_INVALID_MESSAGE);
  const activationHash = scriptingActivationHash(activationIdentity, sha256Hex);
  return {
    "X-Scripting-Version": SCRIPTING_PROTOCOL_VERSION,
    "X-Scripting-Key-Id": material.keyId,
    "X-Scripting-Activation": activationHash,
    "X-Scripting-Timestamp": String(timestamp),
    "X-Scripting-Nonce": nonce,
    "X-Scripting-Signature": hmacSha256Hex(
      material.macKey,
      canonicalRequest(timestamp, nonce, route, bodySha256, material.keyId, activationHash),
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

/**
 * Access Key copy (user decision 2026-09-27): every invalid-key case — wrong format, mistyped, never
 * issued, replaced by a newer key, revoked, expired shared Token — is the Worker's single
 * 401 unauthorized and reads the same. 403 key_activated_elsewhere is its own case; 403 forbidden
 * and 401 expired_request keep their existing copy.
 */
export const ACCESS_KEY_INVALID_MESSAGE = "Access Key 无效或已失效";
export const ACCESS_KEY_ACTIVATED_ELSEWHERE_MESSAGE = "Access Key 已使用";
export const ACTIVATION_SAVE_FAILED_MESSAGE = "激活信息保存失败，请重试";
export const SCRIPTING_UPDATE_REQUIRED_MESSAGE = "请更新脚本后重试";

function failureMessage(status: number, gatewayCode = ""): string {
  if (status === 401 && gatewayCode === "unauthorized") return ACCESS_KEY_INVALID_MESSAGE;
  if (status === 403 && gatewayCode === "key_activated_elsewhere") {
    return ACCESS_KEY_ACTIVATED_ELSEWHERE_MESSAGE;
  }
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
    beforeQuery?: () => void;
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
  const credentialObservation = beginGatewayCredentialObservation();
  const route = validateRoute(routeInput);
  // The activation identity is saved before any request carries it; if it cannot be saved nothing
  // is sent, so a key can never bind to an identity that is lost right after.
  let activation: string;
  try {
    activation = loadScriptingActivation();
  } catch {
    throw new GatewayError(ACTIVATION_SAVE_FAILED_MESSAGE);
  }
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
      activation,
    );
  } catch (error) {
    if (error instanceof GatewayError) throw error;
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
      options.beforeQuery?.();
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
    if (error instanceof GatewayError && requestPhase === "response_complete" &&
        !lifecycle.signal.aborted && Date.now() < lifecycleDeadlineAtMs) {
      recordGatewayCredentialOutcome(credentialObservation, response.status, "", false);
    }
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

  const responseCode = gatewayErrorCode(responseText);
  recordScriptingActivationOutcome(credentials.token, response.status, responseCode);
  let value: unknown;
  try { value = JSON.parse(responseText) as unknown; } catch { /* HTTP errors can have non-JSON bodies. */ }
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  recordGatewayCredentialOutcome(credentialObservation, response.status, responseCode, Boolean(root));
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
      failureMessage(response.status, responseCode),
      response.status,
      responseCode,
      response.status === 401 ? scriptingCryptoRuntimeLabel() : "",
      response.status === 502 ? recognitionRetryAt(responseText) : 0,
    );
  }
  if (!root) throw new GatewayError("服务响应异常", response.status);
  return root as T;
}
