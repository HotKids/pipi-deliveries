import { fetch } from "scripting";
import {
  gatewayCredentialStatus,
  loadGatewayCredentials,
  markGatewayTokenUnavailable,
} from "./credentials";
import {
  SCRIPTING_PROTOCOL_VERSION,
  SCRIPTING_REQUEST_METHOD,
  scriptingCanonicalRequest,
  scriptingTokenSecret,
} from "./scripting-auth";
import {
  OperationTimeoutError,
  remainingTimeoutMs,
} from "./deadline";
import {
  scriptingCryptoRuntimeLabel,
  scriptingHmacSha256Hex,
} from "./scripting-crypto";
import { utf8Data } from "./scripting-data";

const GATEWAY_ORIGIN = "https://pipi-gateway.hotki.de";
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
  "replay_store_unavailable",
  "replayed_request",
  "unauthorized",
  "upstream_unavailable",
]);

export class GatewayError extends Error {
  readonly status: number;
  readonly gatewayCode: string;
  readonly authRuntime: string;

  constructor(
    message: string,
    status = 0,
    gatewayCode = "",
    authRuntime = "",
  ) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.gatewayCode = gatewayCode;
    this.authRuntime = authRuntime;
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
  if (status === 429) return "操作过于频繁，请稍后重试";
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

export async function postGateway<T extends Record<string, unknown>>(
  routeInput: string,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number; deadlineAtMs?: number } = {},
): Promise<T> {
  const credentialStatus = gatewayCredentialStatus();
  if (credentialStatus === "conflict") {
    throw new GatewayError(
      "本地访问授权记录不一致，请在设置中重新保存 Access Key",
    );
  }
  if (credentialStatus === "unavailable") {
    throw new GatewayError(
      "Access Key 已失效，请在设置中保存新的 Access Key",
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
  let responseText = "";
  let credentialStateWriteFailed = false;
  const timeoutMs = remainingTimeoutMs(
    options.deadlineAtMs,
    Math.min(Number(options.timeoutMs) || REQUEST_TIMEOUT_MS, 60_000),
  );
  try {
    response = await fetch(`${GATEWAY_ORIGIN}${route}`, {
      method: SCRIPTING_REQUEST_METHOD,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...authHeaders,
      },
      body,
      timeout: timeoutMs / 1000,
      debugLabel: `Pipi Deliveries ${route}`,
    });
    if (response.status === 401 || response.status === 403) {
      try {
        markGatewayTokenUnavailable(credentials.token);
      } catch {
        credentialStateWriteFailed = true;
      }
    }
    if (
      typeof response.expectedContentLength === "number" &&
      response.expectedContentLength > MAX_RESPONSE_BYTES
    ) {
      throw new GatewayError("服务响应异常", response.status);
    }
    responseText = await response.text();
    if (options.deadlineAtMs != null && Date.now() >= options.deadlineAtMs) {
      throw new OperationTimeoutError();
    }
    if (responseText.length > MAX_RESPONSE_BYTES) {
      throw new GatewayError("服务响应异常", response.status);
    }
  } catch (error) {
    if (error instanceof GatewayError || error instanceof OperationTimeoutError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new OperationTimeoutError();
    }
    if (options.deadlineAtMs != null && Date.now() >= options.deadlineAtMs) {
      throw new OperationTimeoutError();
    }
    throw new GatewayError("网络连接失败，请稍后重试");
  }

  if (!response.ok) {
    throw new GatewayError(
      credentialStateWriteFailed
        ? "访问授权已被服务拒绝，但本地状态保存失败，请在设置中重新保存 Access Key"
        : failureMessage(response.status),
      response.status,
      gatewayErrorCode(responseText),
      response.status === 401 ? scriptingCryptoRuntimeLabel() : "",
    );
  }
  try {
    const value = JSON.parse(responseText) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid object");
    }
    return value as T;
  } catch {
    throw new GatewayError("服务响应异常", response.status);
  }
}
