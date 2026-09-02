import type { AccountSource } from "./account-identity";
import type { TimelinePackage } from "../models";
import {
  isProviderErrorDetail,
  normalizeWaybill,
  parseProviderTime,
} from "./status";
import {
  parseCarrierNormalization,
  type CarrierNormalization,
} from "./carrier-normalization";

export type AccountStatusSemantic =
  | "CANCELLED"
  | "DANGER"
  | "ORDERED"
  | "SHIPPED"
  | "PICKED"
  | "TRANSIT"
  | "DELIVERY"
  | "WAITING_PICKUP"
  | "COMPLETED"
  | "UNKNOWN";

export type AccountTrackDto = Readonly<{
  timeText: string;
  detail: string;
  statusCode: string;
}>;

export type AccountParcelDto = Readonly<{
  source: AccountSource;
  ownerId: string;
  waybill: string;
  orderId: string;
  accountOrder: boolean;
  courierCode: string;
  rawCourierCode?: string;
  rawCompanyName?: string;
  companyName: string;
  carrierNormalization: CarrierNormalization | null;
  sourceProvider: string;
  sourceStateCode: string;
  sourceStateText: string;
  semantic: AccountStatusSemantic;
  normalizedStatusScope?: "ORDER" | "SHIPMENT";
  normalizedStatusSemantic?: AccountStatusSemantic;
  normalizedStatusText?: string;
  receiverPhone: string;
  senderPhone: string;
  latestTimeText: string;
  latestDetail: string;
  tracks: readonly AccountTrackDto[];
  routeUrl: string;
  projectionUrl: string;
  /** Same-source timeline extracted from this order's JD H5 page. */
  projectionTimeline?: TimelinePackage | null;
}>;

export type AccountParcelDefaults = Readonly<{
  waybill?: string;
  waybillAliases?: readonly string[];
  courierCode?: string;
  rawCourierCode?: string;
  rawCompanyName?: string;
  companyName?: string;
  carrierNormalization?: CarrierNormalization | null;
  provider?: string;
  phone?: string;
}>;

export type AccountSyncParseResult = Readonly<{
  parcels: readonly AccountParcelDto[];
  rawRecords: number;
  rejectedRecords: number;
}>;

type JsonObject = Record<string, unknown>;

export class AccountParseError extends Error {
  constructor(message = "快递同步响应异常") {
    super(message);
    this.name = "AccountParseError";
  }
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function first(value: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate && candidate.toLowerCase() !== "null") return candidate;
  }
  return "";
}

function decode(value: unknown, depth = 0): unknown {
  if (depth > 4 || typeof value !== "string") return value;
  const clean = value.trim();
  if (!(clean.startsWith("{") || clean.startsWith("["))) return value;
  try {
    return decode(JSON.parse(clean), depth + 1);
  } catch {
    return value;
  }
}

function responseCode(value: JsonObject): number | null {
  const raw = value.code ?? value.status;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const candidate = text(raw);
  return /^-?\d+$/.test(candidate) ? Number(candidate) : null;
}

function unwrap(source: AccountSource, input: unknown): unknown {
  const decoded = decode(input);
  const root = object(decoded);
  if (!Object.keys(root).length) return decoded;
  const code = responseCode(root);
  if (code != null) {
    const accepted = source === "interface5" ? code === 0 : code === 0 || code === 200;
    if (!accepted) throw new AccountParseError();
  }
  const nested = root.value ?? root.data;
  return nested == null || nested === "" ? decoded : decode(nested);
}

function preferredParcelArray(source: AccountSource, node: unknown): unknown[] {
  if (Array.isArray(node)) return node;
  const root = object(node);
  const keys = source === "interface5"
    ? ["expressList", "serverExpressList", "list"]
    : ["parcelData", "expressList", "serverExpressList", "list"];
  for (const key of keys) {
    const candidate = decode(root[key]);
    if (Array.isArray(candidate)) return candidate;
    const nested = object(candidate);
    for (const nestedKey of keys) {
      const nestedArray = decode(nested[nestedKey]);
      if (Array.isArray(nestedArray)) return nestedArray;
    }
  }
  return [];
}

function recordIdentity(value: JsonObject): string {
  return first(value, "mailNo", "nu", "orderNo", "orderId", "orderCode");
}

function isGenericUpdate(value: string): boolean {
  const clean = value.replace(/\s+/g, "");
  return !clean
    || clean === "快递状态已更新"
    || clean === "快递状态已更新，点击查看>>"
    || clean === "快递状态已更新,点击查看>>";
}

function parseTime(value: string): number | null {
  return parseProviderTime(value);
}

function track(value: unknown): AccountTrackDto | null {
  const item = object(value);
  const detail = first(item, "desc", "context", "description", "detail");
  if (isGenericUpdate(detail) || isProviderErrorDetail(detail)) return null;
  return {
    timeText: first(item, "time", "date", "ftime"),
    detail,
    statusCode: first(item, "statusCode", "status", "state", "stateNum"),
  };
}

function tracks(value: JsonObject): AccountTrackDto[] {
  let source: unknown[] = [];
  for (const key of ["details", "traces", "data"]) {
    if (Array.isArray(value[key])) {
      source = value[key] as unknown[];
      break;
    }
  }
  return source
    .map(track)
    .filter((item): item is AccountTrackDto => item != null)
    .sort((left, right) => {
      const time = (parseTime(right.timeText) || 0) - (parseTime(left.timeText) || 0);
      return time || right.timeText.localeCompare(left.timeText);
    });
}

function semanticFromText(value: string): AccountStatusSemantic {
  const clean = value.replace(/\s+/g, "");
  if (/已签收|已妥投/.test(clean)) return "COMPLETED";
  if (/已取消|订单关闭/.test(clean)) return "CANCELLED";
  if (/待取件|代取件|等待取件|待领取|取件码/.test(clean)) return "WAITING_PICKUP";
  if (/派送中|正在派送|配送中|正在配送/.test(clean)) return "DELIVERY";
  if (/已揽收|已揽件|揽收完成/.test(clean)) return "PICKED";
  if (/运输中|转运|分拨|已发往|已到达/.test(clean)) return "TRANSIT";
  if (/已发货|商家已发货/.test(clean)) return "SHIPPED";
  if (/已下单|订单已提交|订单已完成|配送完成|等待出库|正在打包|拣货/.test(clean)) {
    return "ORDERED";
  }
  if (/异常|问题件/.test(clean)) return "DANGER";
  return "UNKNOWN";
}

function semanticFromStored(code: string, description: string): AccountStatusSemantic {
  switch (code.trim().toUpperCase()) {
    case "CANCEL": case "CANCELLED": return "CANCELLED";
    case "FAILED": case "PROBLEM": case "EXCEPTION": return "DANGER";
    case "CREATE": case "ORDER": case "ORDERED": return "ORDERED";
    case "SHIPPED": case "CONSIGN": return "SHIPPED";
    case "GOT": case "ACCEPT": case "COLLECT": case "PICKED": return "PICKED";
    case "TRANSPORT": case "TRANSIT": case "INTRANSIT": return "TRANSIT";
    case "DELIVERING": case "DELIVERY": case "DISPATCH": return "DELIVERY";
    case "AGENT_SIGN": case "WAITING_PICKUP": return "WAITING_PICKUP";
    case "SIGN": case "SIGNED": case "COMPLETED": return "COMPLETED";
    default: return semanticFromText(description);
  }
}

function semanticFromAccountState(code: string, description: string): AccountStatusSemantic {
  switch (code.trim()) {
    case "101": return "ORDERED";
    case "102": return "SHIPPED";
    case "103": return "PICKED";
    case "104": return "TRANSIT";
    case "105": return "DELIVERY";
    case "106": return "WAITING_PICKUP";
    case "107": return "COMPLETED";
    case "108": case "109": case "110": return "DANGER";
    case "111": return "CANCELLED";
    default: return semanticFromStored("", description);
  }
}

function normalizedStatusScope(value: unknown): "ORDER" | "SHIPMENT" | undefined {
  const normalized = text(value).toUpperCase();
  return normalized === "ORDER" || normalized === "SHIPMENT"
    ? normalized
    : undefined;
}

function normalizedStatusSemantic(
  value: unknown,
): AccountStatusSemantic | undefined {
  const normalized = text(value).toUpperCase() as AccountStatusSemantic;
  return [
    "CANCELLED",
    "DANGER",
    "ORDERED",
    "SHIPPED",
    "PICKED",
    "TRANSIT",
    "DELIVERY",
    "WAITING_PICKUP",
    "COMPLETED",
    "UNKNOWN",
  ].includes(normalized)
    ? normalized
    : undefined;
}

function confirmedPickupEvent(value: string): boolean {
  const clean = value.replace(/\s+/g, "");
  if (!clean || clean.includes("已签收")) return false;
  if (clean.includes("待取件") || clean.includes("等待取件")) return true;
  const pickupPlace = [
    "代收点", "丰巢", "快递柜", "智能柜", "驿站", "自提点", "服务站",
  ].some((candidate) => clean.includes(candidate));
  const deposited = [
    "已暂存", "已入柜", "已存放", "已放入", "已投递至", "已送至",
  ].some((candidate) => clean.includes(candidate));
  const collect = [
    "请及时领取", "请领取", "请取件", "凭取件码", "取件码",
  ].some((candidate) => clean.includes(candidate));
  return pickupPlace && deposited && collect;
}

function safeHttps(value: unknown): string {
  const candidate = text(value);
  if (!candidate || candidate.length > 16_384) return "";
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const trusted = ["cainiao.com", "taobao.com", "jd.com"].some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
    return url.protocol === "https:" && trusted ? candidate : "";
  } catch {
    return "";
  }
}

function routeUrl(value: JsonObject): string {
  for (const key of ["detailUrl", "moreInfoUrl", "cainiaoH5", "url"]) {
    const route = safeHttps(value[key]);
    if (route) return route;
  }
  if (!Array.isArray(value.jumpList)) return "";
  for (const entry of value.jumpList) {
    const item = object(entry);
    if (first(item, "type").toLowerCase() !== "h5") continue;
    const route = safeHttps(first(item, "link", "url"));
    if (route) return route;
  }
  return "";
}

function orderProjectionUrl(value: JsonObject): string {
  if (!Array.isArray(value.jumpList)) return "";
  for (const entry of value.jumpList) {
    const item = object(entry);
    if (first(item, "type").toLowerCase() !== "h5") continue;
    const candidate = first(item, "link", "url");
    const route = safeHttps(candidate);
    if (!route) continue;
    try {
      const host = new URL(route).hostname.toLowerCase();
      if (host === "jd.com" || host.endsWith(".jd.com")) return route;
    } catch {
      /* safeHttps already rejected malformed URLs */
    }
  }
  return "";
}

export function isJingDongAccountOrder(
  identifier: string,
  provider: string,
  statusScope = "",
  evidence: readonly string[] = [],
): boolean {
  if (provider !== "JingDong") return false;
  if (/^[0-9]{16}$/.test(identifier)) return true;
  if (!/^[0-9]{12}$/.test(identifier)) return false;
  return statusScope.trim().toUpperCase() === "ORDER" ||
    evidence.some((value) => /订单/.test(String(value || "")));
}

function accountOrder(value: JsonObject): boolean {
  const parsedTracks = tracks(value);
  return isJingDongAccountOrder(
    first(value, "mailNo"),
    first(value, "provider", "providerName"),
    first(value, "normalizedStatusScope"),
    [
      first(
        value,
        "state",
        "logisticsStatusDesc",
        "stateName",
        "statusText",
        "normalizedStatusText",
        "lastLogisticDetail",
        "context",
        "message",
      ),
      ...parsedTracks.map((item) => item.detail),
    ],
  );
}

function parseParcel(
  source: AccountSource,
  raw: unknown,
  defaults: AccountParcelDefaults = {},
  normalizationResponse?: unknown,
): AccountParcelDto | null {
  const value = object(decode(raw));
  if (!Object.keys(value).length) return null;
  const identity = recordIdentity(value) || text(defaults.waybill);
  if (!identity) return null;
  const isOrder = source === "interface5" && accountOrder(value);
  const parsedTracks = tracks(value);
  const stateCode = source === "interface5"
    ? first(value, "stateNum", "state")
    : first(value, "logsiticsStatus", "logisticsStatus", "status");
  const stateText = first(
    value,
    "state",
    "logisticsStatusDesc",
    "stateName",
    "statusText",
  );
  let semantic = source === "interface5"
    ? semanticFromAccountState(stateCode, stateText)
    : semanticFromStored(stateCode, stateText);
  const latestTrack = parsedTracks[0];
  if (semantic === "UNKNOWN" && latestTrack) semantic = semanticFromText(latestTrack.detail);
  const headline = first(value, "lastLogisticDetail", "context", "message");
  const latestDetail = latestTrack?.detail
    || (isGenericUpdate(headline) || isProviderErrorDetail(headline) ? "" : headline);
  if (!isOrder &&
    source === "interface5" &&
    !["COMPLETED", "CANCELLED", "DANGER", "WAITING_PICKUP"].includes(semantic) &&
    confirmedPickupEvent(latestDetail)
  ) {
    semantic = "WAITING_PICKUP";
  }
  const latestTimeText = latestTrack?.timeText || first(
    value,
    "logisticsGmtModified",
    "logisticsUpdateTime",
    "time",
  );
  const rawCourierCode = first(value, "cpCode", "com") ||
    text(defaults.rawCourierCode);
  const rawCompanyName = first(value, "name", "cpName", "companyName") ||
    text(defaults.rawCompanyName);
  const carrierNormalization = isOrder
    ? null
    : parseCarrierNormalization(value, normalizationResponse) ||
      defaults.carrierNormalization || null;
  const courierCode = carrierNormalization?.isBuiltIn
    ? carrierNormalization.standardCode
    : rawCourierCode || text(defaults.courierCode);
  const companyName = isOrder
    ? "京东购物"
    : carrierNormalization?.isBuiltIn
    ? carrierNormalization.displayName
    : rawCompanyName || text(defaults.companyName);
  return {
    source,
    ownerId: identity,
    waybill: identity,
    orderId: isOrder ? identity : "",
    accountOrder: isOrder,
    courierCode,
    rawCourierCode,
    rawCompanyName,
    companyName,
    carrierNormalization,
    sourceProvider: first(value, "provider", "providerName") || text(defaults.provider),
    sourceStateCode: stateCode,
    sourceStateText: stateText,
    semantic,
    normalizedStatusScope: source === "interface5"
      ? normalizedStatusScope(value.normalizedStatusScope)
      : undefined,
    normalizedStatusSemantic: source === "interface5"
      ? normalizedStatusSemantic(value.normalizedStatusSemantic)
      : undefined,
    normalizedStatusText: source === "interface5"
      ? first(value, "normalizedStatusText") || undefined
      : undefined,
    receiverPhone: first(value, "phone", "subPhone", "receiverPhone") || text(defaults.phone),
    senderPhone: first(value, "sendPhone", "senderPhone"),
    latestTimeText,
    latestDetail,
    tracks: parsedTracks,
    routeUrl: isOrder ? "" : routeUrl(value),
    projectionUrl: isOrder ? orderProjectionUrl(value) : "",
  };
}

export function mergeAccountParcel(
  summary: AccountParcelDto,
  detail: AccountParcelDto | null,
): AccountParcelDto {
  if (!detail) return summary;
  const projected =
    summary.accountOrder &&
    normalizeWaybill(detail.ownerId) !== normalizeWaybill(summary.ownerId);
  return {
    ...summary,
    ...detail,
    ownerId: summary.ownerId,
    orderId: summary.orderId || detail.orderId,
    waybill: projected ? detail.waybill : summary.waybill,
    accountOrder: summary.accountOrder || detail.accountOrder,
    sourceProvider: summary.sourceProvider || detail.sourceProvider,
    carrierNormalization:
      detail.carrierNormalization || summary.carrierNormalization,
    receiverPhone: summary.receiverPhone || detail.receiverPhone,
    senderPhone: summary.senderPhone || detail.senderPhone,
    semantic: detail.semantic === "UNKNOWN" ? summary.semantic : detail.semantic,
    normalizedStatusScope:
      detail.normalizedStatusScope || summary.normalizedStatusScope,
    normalizedStatusSemantic:
      detail.normalizedStatusSemantic || summary.normalizedStatusSemantic,
    normalizedStatusText:
      detail.normalizedStatusText || summary.normalizedStatusText,
    latestTimeText: detail.latestTimeText || summary.latestTimeText,
    latestDetail: detail.latestDetail || summary.latestDetail,
    tracks: detail.tracks.length ? detail.tracks : summary.tracks,
    routeUrl: summary.accountOrder ? "" : detail.routeUrl || summary.routeUrl,
    projectionUrl: summary.accountOrder
      ? summary.projectionUrl
      : detail.projectionUrl || summary.projectionUrl,
  };
}

function collectTimelineRecords(
  node: unknown,
  output: JsonObject[],
  depth = 0,
): void {
  if (depth > 6) return;
  const decoded = decode(node);
  if (Array.isArray(decoded)) {
    for (const child of decoded) {
      collectTimelineRecords(child, output, depth + 1);
    }
    return;
  }
  const value = object(decoded);
  if (!Object.keys(value).length) return;
  if (
    recordIdentity(value) ||
    Array.isArray(value.details) ||
    Array.isArray(value.traces)
  ) {
    output.push(value);
    return;
  }
  for (const child of Object.values(value)) {
    collectTimelineRecords(child, output, depth + 1);
  }
}

function mostDetailedRecord(values: readonly JsonObject[]): JsonObject | null {
  return values.reduce<JsonObject | null>((best, candidate) => {
    if (!best) return candidate;
    return tracks(candidate).length > tracks(best).length ? candidate : best;
  }, null);
}

function findTimelineRecord(
  node: unknown,
  expectedWaybills: readonly string[],
): JsonObject | null {
  const records: JsonObject[] = [];
  collectTimelineRecords(node, records);
  if (!records.length) return null;
  const expected = new Set(
    expectedWaybills.map(normalizeWaybill).filter(Boolean),
  );
  if (!expected.size) {
    return records.length === 1 ? records[0] : mostDetailedRecord(records);
  }
  const exact = records.filter(
    (record) => expected.has(normalizeWaybill(recordIdentity(record))),
  );
  if (exact.length) return mostDetailedRecord(exact);
  if (
    records.length === 1 &&
    !normalizeWaybill(recordIdentity(records[0]))
  ) {
    return records[0];
  }
  return null;
}

export function parseAccountSyncResponse(
  source: AccountSource,
  input: unknown,
): AccountParcelDto[] {
  return [...parseAccountSyncResult(source, input).parcels];
}

function strictInterface5Rows(input: unknown): unknown[] {
  const root = object(decode(input));
  if (responseCode(root) !== 0) throw new AccountParseError();
  const data = object(decode(root.data));
  if (!Object.keys(data).length || !Array.isArray(data.expressList)) {
    throw new AccountParseError();
  }
  return data.expressList;
}

export function parseAccountSyncResult(
  source: AccountSource,
  input: unknown,
): AccountSyncParseResult {
  const rows = source === "interface5"
    ? strictInterface5Rows(input)
    : preferredParcelArray(source, unwrap(source, input));
  const output: AccountParcelDto[] = [];
  const identities = new Set<string>();
  let rejectedRecords = 0;
  for (const row of rows) {
    const parcel = parseParcel(source, row, {}, input);
    if (!parcel) {
      rejectedRecords++;
      continue;
    }
    if (identities.has(parcel.ownerId)) continue;
    identities.add(parcel.ownerId);
    output.push(parcel);
  }
  if (rejectedRecords > 0) throw new AccountParseError();
  return {
    parcels: output,
    rawRecords: rows.length,
    rejectedRecords,
  };
}

export function parseAccountTimelineResponse(
  source: AccountSource,
  input: unknown,
  defaults: AccountParcelDefaults = {},
): AccountParcelDto | null {
  const payload = unwrap(source, input);
  const record = findTimelineRecord(
    payload,
    [defaults.waybill || "", ...(defaults.waybillAliases || [])],
  );
  return record ? parseParcel(source, record, defaults) : null;
}

export function normalizePhoneEvidence(value: unknown): string {
  const digits = text(value).replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
}

export function matchBoundPhone(
  parcel: Pick<AccountParcelDto, "receiverPhone" | "senderPhone">,
  phones: readonly string[],
): string {
  const candidates = [parcel.receiverPhone, parcel.senderPhone]
    .map(normalizePhoneEvidence)
    .filter((value) => value.length >= 4);
  const matches = new Set<string>();
  for (const candidate of candidates) {
    for (const phone of phones) {
      const bound = normalizePhoneEvidence(phone);
      if (bound.length !== 11) continue;
      const same = candidate.length === 11
        ? candidate === bound
        : bound.endsWith(candidate.slice(-4));
      if (same) matches.add(bound);
    }
  }
  return matches.size === 1 ? [...matches][0] : "";
}
