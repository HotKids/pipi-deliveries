import type { AccountBinding } from "../models";
import type { AccountParcelDto } from "./account-parser";
import { matchBoundPhone } from "./account-parser";
import { postGateway } from "./gateway";
import { remainingTimeoutMs } from "./deadline";
import { diagnosticErrorDetails, writeDiagnostic } from "./logger";
import { readDurableTextResult, writeDurableText } from "./durable-files";
import { withSharedFileTransaction } from "./shared-file-transaction";
import { utf8Data } from "./scripting-data";
import { normalizeWaybill } from "./status";
import { SCRIPT_BINDING_SOURCE } from "./script-source";

export type EnhancementIdentity = Readonly<{ accountId: string; androidId: string }>;
export const ENHANCEMENT_ROUTE = "/api/express/accounts/enhanced";
const IDENTITY_FILE = "account-enhancement-identity-v1.json";
const IDENTITY_KEY = "pipi_deliveries_account_enhancement_identity_v1";
const IDENTITY_SHARED_KEY = "pipi_deliveries_account_enhancement_identity_shared_v1";

export class EnhancementIdentityMissing extends Error {
  constructor() {
    super("增强模式身份已丢失，请重新验证绑定该手机号");
    this.name = "EnhancementIdentityMissing";
  }
}

function validIdentity(value: unknown): value is EnhancementIdentity {
  const identity = value as Partial<EnhancementIdentity> | null;
  return Boolean(identity && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.accountId || "") &&
    /^[0-9a-f]{16}$/.test(identity.androidId || ""));
}

function encodedIdentity(identity: EnhancementIdentity): string {
  return JSON.stringify({ identity,
    checksum: Crypto.sha256(utf8Data(JSON.stringify(identity))).toHexString().toLowerCase() });
}

function decodedIdentity(raw: unknown): EnhancementIdentity | null {
  if (typeof raw !== "string") return null;
  try {
    const record = JSON.parse(raw);
    return validIdentity(record.identity) && record.checksum === Crypto.sha256(
      utf8Data(JSON.stringify(record.identity)),
    ).toHexString().toLowerCase() ? record.identity : null;
  } catch { return null; }
}

function mirrorIdentity(identity: EnhancementIdentity, restoreDurable: boolean): void {
  const encoded = encodedIdentity(identity);
  if (restoreDurable) {
    try { writeDurableText(IDENTITY_FILE, encoded); }
    catch { /* A verified shared or Keychain copy remains authoritative. */ }
  }
  try { Storage.set(IDENTITY_SHARED_KEY, encoded, { shared: true }); }
  catch { /* The durable or Keychain copy remains usable. */ }
  try { Keychain.set(IDENTITY_KEY, encoded); }
  catch { /* The durable or shared copy remains usable. */ }
}

function readExistingIdentity(): EnhancementIdentity | null {
  const durable = readDurableTextResult(IDENTITY_FILE);
  let unreadable = durable.failed || durable.candidates.length > 0;
  for (const raw of durable.candidates) {
    const identity = decodedIdentity(raw);
    if (identity) {
      mirrorIdentity(identity, false);
      return identity;
    }
  }
  for (const read of [() => Storage.get<string>(IDENTITY_SHARED_KEY, { shared: true }),
    () => Keychain.get(IDENTITY_KEY)]) {
    try {
      const raw = read();
      if (raw == null) continue;
      unreadable = true;
      const identity = decodedIdentity(raw);
      if (identity) {
        mirrorIdentity(identity, true);
        return identity;
      }
    } catch { unreadable = true; }
  }
  if (unreadable) throw new Error("增强模式身份读取失败，请稍后重试");
  return null;
}

export function existingEnhancementIdentity(): EnhancementIdentity | null {
  return withSharedFileTransaction(readExistingIdentity);
}

export function enhancementIdentityFingerprint(identity: EnhancementIdentity): string {
  return Crypto.sha256(utf8Data(JSON.stringify(identity))).toHexString().toLowerCase();
}

/** Only the explicit verification flow may create a new subscription identity. */
export function loadEnhancementIdentity(): EnhancementIdentity {
  return withSharedFileTransaction(() => {
    const existing = readExistingIdentity();
    if (existing) return existing;
    const identity = {
      accountId: UUID.string().toLowerCase(),
      androidId: Crypto.generateSymmetricKey(128).toHexString().toLowerCase().slice(0, 16),
    };
    if (!validIdentity(identity)) throw new Error("增强模式身份生成失败");
    writeDurableText(IDENTITY_FILE, encodedIdentity(identity));
    mirrorIdentity(identity, false);
    return identity;
  });
}

export function requireEnhancementBinding(bindings: readonly AccountBinding[], phone: string): AccountBinding {
  const binding = bindings.find(value => value.source === "interface5" && value.phone === phone);
  if (!binding) throw new Error("请先完成该手机号的基础绑定，再开启增强模式");
  return binding;
}

type EnhancementOperationOptions = { code?: string; deadlineAtMs?: number; expectedIdentityFingerprint?: string };

export function enhancementOperation(operation: "bind", phone: string, options?: EnhancementOperationOptions): Promise<string>;
export function enhancementOperation(operation: "code" | "unbind", phone: string, options?: EnhancementOperationOptions): Promise<void>;
export async function enhancementOperation(operation: "code" | "bind" | "unbind", phone: string,
  options: EnhancementOperationOptions = {}): Promise<string | void> {
  if (!/^1[3-9]\d{9}$/.test(phone) || (operation === "bind" && !/^\d{4,8}$/.test(options.code || ""))) {
    throw new Error("请输入正确的手机号和验证码");
  }
  const identity = operation === "unbind" ? existingEnhancementIdentity() : loadEnhancementIdentity();
  if (!identity) throw new EnhancementIdentityMissing();
  const identityFingerprint = enhancementIdentityFingerprint(identity);
  if (operation === "unbind" && options.expectedIdentityFingerprint !== identityFingerprint) {
    throw new Error("无法确认增强模式原订阅身份，请重新验证绑定该手机号");
  }
  const result = await postGateway(ENHANCEMENT_ROUTE, { operation, phone,
    identity, ...(options.code ? { code: options.code } : {}) }, {
    timeoutMs: remainingTimeoutMs(options.deadlineAtMs, 25_000), deadlineAtMs: options.deadlineAtMs,
  });
  if (result.ok !== true) throw new Error("增强模式操作失败，请重试");
  if (operation === "bind") return identityFingerprint;
}

function allowedImage(value: unknown): string {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f\\]/.test(value)) return "";
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password &&
      !value.match(/^https:\/\/[^/]*@/i) && (!url.port || url.port === "443") &&
      (host === "jd.com" || host.endsWith(".jd.com") || host === "360buyimg.com" || host.endsWith(".360buyimg.com"))
      ? url.href : "";
  } catch { return ""; }
}

export function enhancementPhone(parcel: AccountParcelDto, bindings: readonly AccountBinding[]): string {
  if (parcel.source !== "interface5" || !parcel.accountOrder || parcel.sourceProvider.toLowerCase() !== "jingdong") return "";
  const phones = bindings.filter(binding => binding.source === "interface5").map(binding => binding.phone);
  const phone = matchBoundPhone(parcel, phones) ||
    (!parcel.receiverPhone && !parcel.senderPhone && phones.length === 1 ? phones[0] : "");
  return bindings.some(binding => binding.source === "interface5" && binding.phone === phone && binding.enhancedMode)
    ? phone : "";
}

/** A cached row flag cannot outlive its current same-phone enhancement binding. */
export function withCurrentAccountEnhancement(parcel: AccountParcelDto, bindings: readonly AccountBinding[]): AccountParcelDto {
  const active = Boolean(enhancementPhone(parcel, bindings));
  if (active === Boolean(parcel.enhancedMode)) return parcel;
  return { ...parcel, enhancedMode: active ? true : undefined, enhancedWaybill: undefined };
}

function enhancementRequested(parcel: AccountParcelDto, purpose: "waybill" | "image"): boolean {
  if (!parcel.enhancedMode) return false;
  if (purpose === "image") return !parcel.productImageURL;
  // Use the upstream list enum: an unprojected 103 is presented locally as ORDERED.
  return /^(10[2-9]|110)$/.test(parcel.sourceStateCode) && !parcel.enhancedWaybill &&
    normalizeWaybill(parcel.waybill) === normalizeWaybill(parcel.ownerId);
}

export async function enhanceAccountParcels(parcels: readonly AccountParcelDto[], bindings: readonly AccountBinding[],
  options: { purpose?: "waybill" | "image"; deadlineAtMs?: number; signal?: AbortSignal;
    flowId?: string; trigger?: string;
    identity?: EnhancementIdentity;
    request?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> } = {}): Promise<AccountParcelDto[]> {
  const candidateOrders = parcels.filter(parcel => parcel.source === "interface5" && parcel.accountOrder &&
    parcel.sourceProvider.toLowerCase() === "jingdong");
  const purpose = options.purpose || "waybill";
  const diagnostic = { interface: "v3", requestProvider: "v3_list", purpose,
    stage: "v3_list", source: SCRIPT_BINDING_SOURCE, sourceProvider: "jingdong",
    flowId: options.flowId, trigger: options.trigger, orders: candidateOrders.length } as const;
  const marked = parcels.map(parcel => withCurrentAccountEnhancement(parcel, bindings));
  const orders = marked.flatMap(parcel => {
    const phone = enhancementPhone(parcel, bindings);
    return phone && enhancementRequested(parcel, purpose) ? [{ phone, orderId: parcel.orderId || parcel.ownerId }] : [];
  });
  const seen = new Set<string>();
  const distinctOrders = orders.filter(order => {
    const key = `${order.phone}\0${order.orderId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!orders.length) {
    if (candidateOrders.length && bindings.some(binding => binding.source === "interface5" && binding.enhancedMode)) {
      writeDiagnostic("account.enhanced.skipped", { ...diagnostic, result: "no_eligible_orders",
        requestedOrderCount: 0, matchedOrderCount: 0, realWaybillCount: 0, imageURLCount: 0, productImageCount: 0 });
    }
    return marked;
  }
  const startedAt = Date.now();
  try {
    const request = options.request || (payload => postGateway(ENHANCEMENT_ROUTE, payload, {
      deadlineAtMs: options.deadlineAtMs, signal: options.signal,
      timeoutMs: remainingTimeoutMs(options.deadlineAtMs, 25_000),
    }));
    const identity = options.identity || existingEnhancementIdentity();
    if (!identity) throw new EnhancementIdentityMissing();
    const response = await request({ operation: "sync", identity, orders: distinctOrders });
    if (options.signal?.aborted) throw new Error("增强模式同步已取消");
    if (!Array.isArray(response.records) || !Array.isArray(response.ambiguousOrderIds)) throw new Error("增强模式响应异常");
    const ambiguous = new Set(response.ambiguousOrderIds);
    const matched = new Set<string>(), waybills = new Set<string>(), images = new Set<string>();
    const enriched = marked.map(parcel => {
      const phone = enhancementPhone(parcel, bindings), orderId = parcel.orderId || parcel.ownerId;
      if (!phone || !enhancementRequested(parcel, purpose) || ambiguous.has(orderId)) return parcel;
      const uniqueOrder = distinctOrders.filter(order => order.orderId === orderId).length === 1;
      const records = response.records.filter(record => record && typeof record === "object" &&
        (record as Record<string, unknown>).orderId === orderId &&
        ((record as Record<string, unknown>).phone === phone ||
          (uniqueOrder && (record as Record<string, unknown>).phone === ""))) as Record<string, unknown>[];
      if (records.length !== 1) return parcel;
      const record = records[0];
      const waybill = typeof record.realWaybill === "string" ? record.realWaybill.trim() : "";
      const image = purpose === "image" ? allowedImage(record.imageUrl) : "";
      const pair = `${phone}\0${orderId}`;
      matched.add(pair);
      if (image) images.add(pair);
      const enhancedWaybill = purpose === "waybill" && waybill && waybill !== orderId &&
        waybill.length >= 6 && waybill.length <= 64 && !/[\u0000-\u0020\u007f]/.test(waybill) ? waybill : "";
      if (enhancedWaybill) waybills.add(pair);
      return { ...parcel, ...(image ? { productImageURL: image } : {}),
        ...(enhancedWaybill ? { enhancedWaybill } : {}) };
    });
    writeDiagnostic("account.enhanced.completed", { ...diagnostic, result: "completed", durationMs: Date.now() - startedAt,
      requestedOrderCount: distinctOrders.length, records: response.records.length,
      matchedOrderCount: matched.size, productImageCount: images.size,
      realWaybillCount: waybills.size, imageURLCount: images.size,
      ambiguousOrderCount: distinctOrders.filter(order => ambiguous.has(order.orderId)).length });
    return enriched;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // A failed request accepted no results; these counts do not describe the upstream response.
    writeDiagnostic("account.enhanced.failed", { ...diagnostic, result: "failed", durationMs: Date.now() - startedAt,
      requestedOrderCount: distinctOrders.length, matchedOrderCount: 0, realWaybillCount: 0,
      imageURLCount: 0, productImageCount: 0, ...diagnosticErrorDetails(error) }, "warning");
    // The base account remains usable; an enhancement failure never re-enables legacy number extraction.
    return marked;
  }
}
