import type {
  AccountIdentity,
  Interface5Identity,
} from "./account-identity";
import {
  isInterface5Identity,
} from "./account-identity";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";

export const ACCOUNT_REQUEST_TIMEOUT_MS = 30_000;

export type JsonObject = Record<string, unknown>;
export type AccountPost = (
  route: string,
  payload: JsonObject,
  timeoutMs: number,
) => Promise<JsonObject>;

export type AccountGatewayRequest = Readonly<{
  route: "/api/express/accounts/code"
    | "/api/express/accounts/bind"
    | "/api/express/accounts/sync"
    | "/api/express/timeline/source";
  payload: JsonObject;
}>;

export type Interface5DetailRecord = Readonly<{
  waybill: string;
  companyCode?: string;
  name?: string;
  provider?: string;
  stateNumber?: number;
  updateTime?: string;
  phone?: string;
  channel?: string | number;
}>;

export type AccountTimelineRequest =
  | Readonly<{
      source: "interface5";
      mode: "detail";
      identity: Interface5Identity;
      record: Interface5DetailRecord;
    }>
  | Readonly<{
      source: "interface5";
      mode: "manual";
      identity: Interface5Identity;
      waybill: string;
      phones?: readonly string[];
    }>;

export class AccountApiError extends Error {
  readonly code: "INVALID_INPUT" | "UPSTREAM_REJECTED";

  constructor(
    message: string,
    code: "INVALID_INPUT" | "UPSTREAM_REJECTED" = "INVALID_INPUT",
  ) {
    super(message);
    this.name = "AccountApiError";
    this.code = code;
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireBindingSource(source: unknown): "interface5" {
  if (source !== "interface5") {
    throw new AccountApiError("当前快递服务不可用");
  }
  return "interface5";
}

export function normalizePhone(value: unknown): string {
  const phone = clean(value).replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    throw new AccountApiError("请输入有效的手机号");
  }
  return phone;
}

export function normalizePhones(values: readonly string[] | undefined): string[] {
  const phones: string[] = [];
  for (const value of values || []) {
    const phone = normalizePhone(value);
    if (!phones.includes(phone)) phones.push(phone);
  }
  if (phones.length > EXPRESS_POLICY.sources.maxBindingsPerSource) {
    throw new AccountApiError(
      `最多可绑定 ${EXPRESS_POLICY.sources.maxBindingsPerSource} 个手机号`,
    );
  }
  return phones;
}

export function normalizeWaybill(value: unknown): string {
  const waybill = clean(value);
  if (waybill.length < 6 || waybill.length > 64 || /[\u0000-\u001f\u007f]/.test(waybill)) {
    throw new AccountApiError("请输入有效的快递单号");
  }
  return waybill;
}

function requireIdentity(
  source: "interface5",
  identity: AccountIdentity,
): Interface5Identity {
  requireBindingSource(source);
  if (isInterface5Identity(identity)) return identity;
  throw new AccountApiError("设备验证失效，请重新绑定手机号");
}

function verificationCode(value: unknown): string {
  const code = clean(value);
  if (!/^\d{4,6}$/.test(code)) {
    throw new AccountApiError("请输入正确的验证码");
  }
  return code;
}

function commonAccountPayload(
  source: "interface5",
  identity: AccountIdentity,
): JsonObject {
  return {
    interface: "v5",
    identity: requireIdentity(source, identity),
  };
}

export function buildAccountCodeRequest(input: {
  source: "interface5";
  identity: AccountIdentity;
  phone: string;
}): AccountGatewayRequest {
  return {
    route: "/api/express/accounts/code",
    payload: {
      ...commonAccountPayload(input.source, input.identity),
      phone: normalizePhone(input.phone),
    },
  };
}

export function buildAccountBindRequest(input: {
  source: "interface5";
  identity: AccountIdentity;
  phone: string;
  code: string;
}): AccountGatewayRequest {
  return {
    route: "/api/express/accounts/bind",
    payload: {
      ...commonAccountPayload(input.source, input.identity),
      phone: normalizePhone(input.phone),
      code: verificationCode(input.code),
    },
  };
}

export function buildAccountSyncRequest(input: {
  source: "interface5";
  identity: AccountIdentity;
  phones?: readonly string[];
}): AccountGatewayRequest {
  const payload = commonAccountPayload(input.source, input.identity);
  const phones = normalizePhones(input.phones);
  if (!phones.length) throw new AccountApiError("请先绑定手机号");
  payload.phones = phones;
  return { route: "/api/express/accounts/sync", payload };
}

function normalizedDetailRecord(record: Interface5DetailRecord): JsonObject {
  const companyCode = clean(record.companyCode);
  const name = clean(record.name);
  const provider = clean(record.provider);
  const updateTime = clean(record.updateTime);
  const phone = clean(record.phone) ? normalizePhone(record.phone) : "";
  const stateNumber = record.stateNumber ?? 0;
  const channel = record.channel ?? 1;
  if (!/^[A-Za-z0-9_-]{0,32}$/.test(companyCode)
      || name.length > 128
      || provider.length > 64
      || updateTime.length > 64
      || !Number.isInteger(stateNumber)
      || stateNumber < 0
      || stateNumber > 100_000
      || String(channel).length > 32) {
    throw new AccountApiError("无法打开该快递详情");
  }
  return {
    waybill: normalizeWaybill(record.waybill),
    companyCode,
    name,
    provider,
    stateNumber,
    updateTime,
    phone,
    channel,
  };
}

export function buildAccountTimelineRequest(
  input: AccountTimelineRequest,
): AccountGatewayRequest {
  if (input.mode === "detail") {
    return {
      route: "/api/express/timeline/source",
      payload: {
        interface: "v5",
        mode: "detail",
        identity: requireIdentity("interface5", input.identity),
        record: normalizedDetailRecord(input.record),
      },
    };
  }

  return {
    route: "/api/express/timeline/source",
    payload: {
      ...commonAccountPayload(input.source, input.identity),
      mode: "manual",
      waybill: normalizeWaybill(input.waybill),
      phones: normalizePhones(input.phones),
    },
  };
}

function responseCode(value: JsonObject): number | null {
  const raw = value.code ?? value.status;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

function assertOperationAccepted(value: JsonObject): void {
  const code = responseCode(value);
  if (code !== 0) {
    throw new AccountApiError("验证失败，请稍后重试", "UPSTREAM_REJECTED");
  }
}

function assertSyncAccepted(value: JsonObject): void {
  const code = responseCode(value);
  if (code !== 0) {
    throw new AccountApiError("快递同步失败，请稍后重试", "UPSTREAM_REJECTED");
  }
}

export class AccountApi {
  constructor(private readonly post: AccountPost) {}

  async sendCode(input: {
    source: "interface5";
    identity: AccountIdentity;
    phone: string;
  }): Promise<void> {
    const request = buildAccountCodeRequest(input);
    const response = await this.post(
      request.route,
      request.payload,
      ACCOUNT_REQUEST_TIMEOUT_MS,
    );
    assertOperationAccepted(response);
  }

  async bind(input: {
    source: "interface5";
    identity: AccountIdentity;
    phone: string;
    code: string;
  }): Promise<void> {
    const request = buildAccountBindRequest(input);
    const response = await this.post(
      request.route,
      request.payload,
      ACCOUNT_REQUEST_TIMEOUT_MS,
    );
    assertOperationAccepted(response);
  }

  async sync(input: {
    source: "interface5";
    identity: AccountIdentity;
    phones?: readonly string[];
  }): Promise<JsonObject> {
    const request = buildAccountSyncRequest(input);
    const response = await this.post(
      request.route,
      request.payload,
      ACCOUNT_REQUEST_TIMEOUT_MS,
    );
    assertSyncAccepted(response);
    return response;
  }

  async timeline(input: AccountTimelineRequest): Promise<JsonObject> {
    const request = buildAccountTimelineRequest(input);
    return this.post(request.route, request.payload, ACCOUNT_REQUEST_TIMEOUT_MS);
  }
}
