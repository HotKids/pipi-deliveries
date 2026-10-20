import type { AccountBinding } from "../models";
import type { AccountParcelDto } from "./account-parser";
import { matchBoundPhone } from "./account-parser";
import { postGateway } from "./gateway";
import { remainingTimeoutMs } from "./deadline";
import { diagnosticErrorDetails, writeDiagnostic } from "./logger";
import { readDurableTextResult, writeDurableText } from "./durable-files";
import { withSharedFileTransaction } from "./shared-file-transaction";
import { utf8Data } from "./scripting-data";

export type EnhancementIdentity = Readonly<{ accountId: string; androidId: string }>;
export const ENHANCEMENT_ROUTE = "/api/express/accounts/enhanced";
const IDENTITY_FILE = "account-enhancement-identity-v1.json";

function validIdentity(value: unknown): value is EnhancementIdentity {
  const identity = value as Partial<EnhancementIdentity> | null;
  return Boolean(identity && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.accountId || "") &&
    /^[0-9a-f]{16}$/.test(identity.androidId || ""));
}

export function loadEnhancementIdentity(): EnhancementIdentity {
  return withSharedFileTransaction(() => {
    const { candidates, failed } = readDurableTextResult(IDENTITY_FILE);
    for (const raw of candidates) {
      try {
        const record = JSON.parse(raw);
        if (validIdentity(record.identity) && record.checksum === Crypto.sha256(
          utf8Data(JSON.stringify(record.identity)),
        ).toHexString().toLowerCase()) return record.identity;
      } catch { /* Try the existing durable backup before reporting corruption. */ }
    }
    if (failed || candidates.length) throw new Error("增强模式身份读取失败，请稍后重试");
    const identity = {
      accountId: UUID.string().toLowerCase(),
      androidId: Crypto.generateSymmetricKey(128).toHexString().toLowerCase().slice(0, 16),
    };
    if (!validIdentity(identity)) throw new Error("增强模式身份生成失败");
    writeDurableText(IDENTITY_FILE, JSON.stringify({ identity,
      checksum: Crypto.sha256(utf8Data(JSON.stringify(identity))).toHexString().toLowerCase() }));
    return identity;
  });
}

export function requireEnhancementBinding(bindings: readonly AccountBinding[], phone: string): AccountBinding {
  const binding = bindings.find(value => value.source === "interface5" && value.phone === phone);
  if (!binding) throw new Error("请先完成该手机号的基础绑定，再开启增强模式");
  return binding;
}

export async function enhancementOperation(operation: "code" | "bind" | "unbind", phone: string,
  options: { code?: string; deadlineAtMs?: number } = {}): Promise<void> {
  if (!/^1[3-9]\d{9}$/.test(phone) || (operation === "bind" && !/^\d{4,8}$/.test(options.code || ""))) {
    throw new Error("请输入正确的手机号和验证码");
  }
  const result = await postGateway(ENHANCEMENT_ROUTE, { operation, phone,
    identity: loadEnhancementIdentity(), ...(options.code ? { code: options.code } : {}) }, {
    timeoutMs: remainingTimeoutMs(options.deadlineAtMs, 25_000), deadlineAtMs: options.deadlineAtMs,
  });
  if (result.ok !== true) throw new Error("增强模式操作失败，请重试");
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

export async function enhanceAccountParcels(parcels: readonly AccountParcelDto[], bindings: readonly AccountBinding[],
  options: { deadlineAtMs?: number; signal?: AbortSignal;
    identity?: EnhancementIdentity;
    request?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> } = {}): Promise<AccountParcelDto[]> {
  const candidateOrders = parcels.filter(parcel => parcel.source === "interface5" && parcel.accountOrder &&
    parcel.sourceProvider.toLowerCase() === "jingdong");
  const orders = parcels.flatMap(parcel => {
    const phone = enhancementPhone(parcel, bindings);
    return phone ? [{ phone, orderId: parcel.orderId || parcel.ownerId }] : [];
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
      writeDiagnostic("account.enhanced.skipped", { stage: "metadata", result: "no_eligible_orders",
        orders: candidateOrders.length, requestedOrderCount: 0 });
    }
    return [...parcels];
  }
  const marked = parcels.map(parcel => enhancementPhone(parcel, bindings) ? { ...parcel, enhancedMode: true as const } : parcel);
  try {
    const request = options.request || (payload => postGateway(ENHANCEMENT_ROUTE, payload, {
      deadlineAtMs: options.deadlineAtMs, signal: options.signal,
      timeoutMs: remainingTimeoutMs(options.deadlineAtMs, 25_000),
    }));
    const response = await request({ operation: "sync", identity: options.identity || loadEnhancementIdentity(), orders: distinctOrders });
    if (options.signal?.aborted) throw new Error("增强模式同步已取消");
    if (!Array.isArray(response.records) || !Array.isArray(response.ambiguousOrderIds)) throw new Error("增强模式响应异常");
    const ambiguous = new Set(response.ambiguousOrderIds);
    const matched = new Set<string>(), images = new Set<string>();
    const enriched = marked.map(parcel => {
      const phone = enhancementPhone(parcel, bindings), orderId = parcel.orderId || parcel.ownerId;
      if (!phone || ambiguous.has(orderId)) return parcel;
      const records = response.records.filter(record => record && typeof record === "object" &&
        (record as Record<string, unknown>).phone === phone && (record as Record<string, unknown>).orderId === orderId) as Record<string, unknown>[];
      if (records.length !== 1) return parcel;
      const record = records[0];
      const waybill = typeof record.realWaybill === "string" ? record.realWaybill.trim() : "";
      const image = allowedImage(record.imageUrl);
      const pair = `${phone}\0${orderId}`;
      matched.add(pair);
      if (image) images.add(pair);
      return { ...parcel, ...(image ? { productImageURL: image } : {}),
        ...(waybill && waybill !== orderId && waybill.length >= 6 && waybill.length <= 64 &&
          !/[\u0000-\u0020\u007f]/.test(waybill)
          ? { enhancedWaybill: waybill }
          : {}) };
    });
    writeDiagnostic("account.enhanced.completed", { stage: "metadata", result: "completed",
      orders: candidateOrders.length, requestedOrderCount: distinctOrders.length, records: response.records.length,
      matchedOrderCount: matched.size, productImageCount: images.size,
      ambiguousOrderCount: distinctOrders.filter(order => ambiguous.has(order.orderId)).length });
    return enriched;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    writeDiagnostic("account.enhanced.failed", { ...diagnosticErrorDetails(error), records: orders.length }, "warning");
    // The base account remains usable; an enhancement failure never re-enables legacy number extraction.
    return marked;
  }
}
