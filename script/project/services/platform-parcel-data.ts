import type { ParcelHandoffRecord, PddParcelImport } from "../models";
import { platformPickupCode } from "./fengchao-account";
import { trustedPlatformPage, type ExpressPlatform } from "./platform-accounts";
import { sha256Hex } from "./scripting-data";
import { normalizeWaybill, parseListEventTime } from "./status";
import { asPlainObject, cleanScalarText, firstCleanScalarText, isPlainObject, type JsonObject } from "./value-guards";

export type PlatformParcel = Readonly<{
  source: ExpressPlatform;
  waybill: string;
  orderIds?: readonly string[];
  shippingId?: string;
  title?: string;
  estimate?: string;
  code?: string;
  name?: string;
  address?: string;
  carrierCode?: string;
  carrierName?: string;
  unnumbered?: boolean;
}>;

export function pddParcelDetailPath(shippingId: string, waybill: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(shippingId) || !/^[A-Z0-9]{6,64}$/.test(waybill)) return "";
  return "/psnl_goods_help.html?_t_module_name=assistant_waybill" +
    "&shipping_id=" + shippingId + "&tracking_number=" + waybill;
}

export function pddParcelAppURL(parcel: PddParcelImport | undefined, waybill: string): string {
  if (!parcel?.ownerKey || !parcel.orderId || !parcel.shippingId) return "";
  const path = pddParcelDetailPath(parcel.shippingId, waybill);
  // Pinduoduo's iOS associated domain serves this same shipment-detail route.
  return path ? "https://m.pinduoduo.net" + path : "";
}

export function objectList(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

function rows(value: JsonObject): JsonObject[] {
  for (const key of ["packages", "sendPackages", "packageList", "list", "result", "items"]) {
    if (Array.isArray(value[key])) return objectList(value[key]);
  }
  return [];
}

const ORDER_KEYS = ["tbOrderId", "tb_order_id", "tradeId", "trade_id", "orderId", "order_id",
  "bizOrderId", "biz_order_id", "orderCode", "order_code"];
const CN_RECIPIENT_TERMINAL = /^(?:SIGN|SIGNED|CANCEL|CANCELLED|CANCELED|REJECT|RETURN|LOST|CLOSED|CLOSE|已签收|已取件|已取出|已取消|已退回|已关闭)$/i;
const CHINA_OFFSET = 8 * 3_600_000;
const DAY = 86_400_000;

function chinaDay(time: number): number {
  return Math.floor((time + CHINA_OFFSET) / DAY) * DAY;
}

export function displayDeliveryEstimate(text: string, capturedAt: number, now = Date.now()): string {
  if (capturedAt <= 0 || capturedAt > now || !/^预计[^\r\n。；;]{1,70}?送达$/.test(text)) return "";
  const matches = Array.from(text.matchAll(/(今天|今日|明天|后天)|(?:(\d{4})年)?(\d{1,2})[月/-](\d{1,2})日?/g));
  const day = matches[matches.length - 1];
  if (!day) return "";
  const observed = chinaDay(capturedAt);
  let arrival: number;
  if (day[1]) arrival = observed + (day[1] === "明天" ? 1 : day[1] === "后天" ? 2 : 0) * DAY;
  else {
    let year = Number(day[2]) || new Date(observed).getUTCFullYear();
    const month = Number(day[3]);
    const date = Number(day[4]);
    arrival = Date.UTC(year, month - 1, date);
    if (!day[2] && arrival < observed - 10 * DAY) arrival = Date.UTC(++year, month - 1, date);
    const resolved = new Date(arrival);
    if (resolved.getUTCMonth() !== month - 1 || resolved.getUTCDate() !== date) return "";
  }
  const today = chinaDay(now);
  if (arrival < today || arrival > observed + 60 * DAY) return "";
  if (today === observed || !day[1]) return text;
  const date = new Date(arrival);
  return text.slice(0, day.index) + (date.getUTCMonth() + 1) + "月" + date.getUTCDate() + "日" +
    text.slice((day.index ?? 0) + day[0].length);
}

export function deliveryForecast(raw: unknown, now: number): string {
  const value = cleanScalarText(raw).match(/预计[^\r\n。；;]{1,70}?送达/)?.[0] || "";
  return displayDeliveryEstimate(value, now, now);
}

export function uniqueDeliveryForecast(values: readonly unknown[], now: number): string {
  const estimates = new Set(values.map((value) => deliveryForecast(value, now)).filter(Boolean));
  return estimates.size === 1 ? [...estimates][0] : "";
}

export function productTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  return title.length <= 512 && !/[\u0000-\u0008\u000E-\u001F]/.test(title) ? title : "";
}

function timestamp(value: unknown): number | undefined {
  const text = cleanScalarText(value, true);
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  return parseListEventTime(text) || undefined;
}

function firstTime(row: JsonObject, fields: readonly string[]): number | undefined {
  for (const name of fields) {
    const value = timestamp(row[name]);
    if (value) return value;
  }
  return undefined;
}

function cainiaoParcelFields(parcel: JsonObject, now: number) {
  let dynamic = asPlainObject(parcel.packageDyn);
  if (typeof parcel.packageDyn === "string") {
    try { dynamic = asPlainObject(JSON.parse(parcel.packageDyn)); } catch { /* Unknown provider field. */ }
  }
  return {
    title: [...new Set(objectList(parcel.packageItem).map((item) => productTitle(item.itemTitle)).filter(Boolean))].join("\n"),
    estimate: CN_RECIPIENT_TERMINAL.test(firstCleanScalarText(parcel, "status", "statusDesc", "packageStatus")) ? "" :
      uniqueDeliveryForecast([...Object.values(parcel), ...Object.values(dynamic)], now),
  };
}

export function cainiaoParcelDetails(data: JsonObject, waybill: string, now: number): PlatformParcel | undefined {
  const result = data.result;
  const matches = (Array.isArray(result) ? objectList(result) : [isPlainObject(result) ? result : data])
    .filter((row) => waybill === normalizeWaybill(firstCleanScalarText(row, "mailNo", "mail_no")));
  if (matches.length !== 1) return undefined;
  return { source: "cainiao", waybill, ...cainiaoParcelFields(matches[0], now) };
}

export function cainiaoRecipientParcels(data: JsonObject, now: number): PlatformParcel[] {
  const output: PlatformParcel[] = [];
  for (const pkg of rows(data)) {
    if (CN_RECIPIENT_TERMINAL.test(firstCleanScalarText(pkg, "status", "statusDesc", "packageStatus"))) continue;
    const updateTime = firstTime(pkg, ["updateTime", "modifyTime", "lastTime", "statusTime", "gmtModified", "createTime"]);
    if (updateTime && updateTime < now - 14 * DAY) continue;
    const rawWaybill = firstCleanScalarText(pkg, "mailNo", "mail_no");
    const waybill = normalizeWaybill(rawWaybill);
    const feature = asPlainObject(pkg.feature);
    const items = objectList(pkg.packageItem);
    const orderIds = [...new Set([pkg, feature, items[0] || {}].flatMap((row) =>
      ORDER_KEYS.map((key) => cleanScalarText(row[key])).filter((value) => value && !/^(?:null|0)$/i.test(value) && value !== rawWaybill),
    ))];
    const station = asPlainObject(pkg.packageStation);
    const candidates = [firstCleanScalarText(station, "authCode", "auth_code"),
      firstCleanScalarText(station, "showPickupCode", "show_pickup_code", "pickUpCode", "pickupCode"),
      firstCleanScalarText(feature, "stationOrderPickUpCode", "station_order_pick_up_code")];
    const code = candidates.map((value) => platformPickupCode(value, rawWaybill, ...orderIds)).find(Boolean);
    const name = firstCleanScalarText(station, "pointName", "point_name", "stationName", "station_name", "name");
    const address = firstCleanScalarText(station, "address", "stationAddress", "station_address", "pointAddress", "addr");
    if (!waybill && (rawWaybill || !code || !(name || address))) continue;
    output.push({
      source: "cainiao", waybill, orderIds,
      ...cainiaoParcelFields(pkg, now),
      code, name, address, unnumbered: !rawWaybill,
      carrierCode: firstCleanScalarText(pkg, "cpCode", "cp_code"),
      carrierName: firstCleanScalarText(pkg, "cpName", "cp_name", "companyName"),
    });
  }
  return output;
}

const SENDER_ACTIVE = /^(?:WAIT_[A-Z_]+|WAITING_[A-Z_]+|APPOINTED|APPOINTMENT|BOOKED|CREATE|CREATED|INIT|ASSIGNED|DISPATCHED|ACCEPT|ACCEPTED|预约成功|已接单|等待揽收|待快递员上门)$/i;
const SENDER_TERMINAL = /(?:^|_)(?:SIGN|SIGNED|COLLECTED|GOT|TAKEN|PICKED|PICKED_UP|SEND|SENDING|TRANSIT|IN_TRANSIT|DELIVER|DELIVERING|CANCEL|CANCELLED|CANCELED|CLOSE|CLOSED|REJECT|FINISH|FINISHED|COMPLETED|COMPLETE|EXPIRED)$|已揽收|已取件|已寄出|运输中|派送中|已签收|已取消|已关闭|已作废/i;
const START_KEYS = ["appointStartTime", "appoint_start_time", "expectStartTime", "bookStartTime", "pickupStartTime", "doorStartTime"];
const END_KEYS = ["appointEndTime", "appoint_end_time", "expectEndTime", "bookEndTime", "pickupEndTime", "doorEndTime"];
const WINDOW_KEYS = ["appointTimeDesc", "appointTimeStr", "appointTime", "bookTimeDesc", "doorTimeText", "windowText"];

function senderWaiting(status: string): boolean {
  return SENDER_ACTIVE.test(status) || /待取件|待揽收|待上门/.test(status);
}

function providerWindow(text: string, now: number): [number, number] | undefined {
  const range = /(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})\s*[-–~至]\s*(?:(\d{1,2})[-/](\d{1,2})\s+)?(\d{1,2}):(\d{2})/.exec(text);
  if (!range) return undefined;
  const year = range[1] || String(new Date(chinaDay(now)).getUTCFullYear());
  const build = (month: string, date: string, hour: string, minute: string) =>
    parseListEventTime([year, month.padStart(2, "0"), date.padStart(2, "0")].join("-") + " " + hour.padStart(2, "0") + ":" + minute);
  const start = build(range[2], range[3], range[4], range[5]);
  const end = build(range[6] || range[2], range[7] || range[3], range[8], range[9]);
  return start && end && end >= start ? [start, end] : undefined;
}

export function cainiaoHandoffs(data: JsonObject, owner: string, now: number): ParcelHandoffRecord[] {
  const output: ParcelHandoffRecord[] = [];
  for (const pkg of rows(data)) {
    const appointment = ["appointment", "appointInfo", "packageAppointment", "sendInfo"]
      .map((key) => pkg[key]).find(isPlainObject) || {};
    const feature = asPlainObject(pkg.feature);
    const statuses = [firstCleanScalarText(appointment, "appointStatus", "status", "statusCode", "statusDesc"),
      firstCleanScalarText(pkg, "status", "packageStatus", "orderStatus", "statusCode", "statusDesc")];
    if (statuses.some((status) => !senderWaiting(status) && SENDER_TERMINAL.test(status)) ||
      !statuses.some(senderWaiting)) continue;
    const ids = ["appointmentId", "appointId", "sendOrderCode", "logisticsOrderCode", "orderCode"];
    const id = firstCleanScalarText(appointment, ...ids) || firstCleanScalarText(pkg, ...ids, "lpOrderId", "packageId", "id");
    const names = ["gotCode", "got_code", "sendCode", "send_code", "pickupCode", "pickUpCode"];
    const code = platformPickupCode(firstCleanScalarText(appointment, ...names, "doorCode", "takeCode", "verifyCode") ||
      firstCleanScalarText(feature, ...names) || firstCleanScalarText(pkg, ...names, "doorCode", "takeCode"),
      id, firstCleanScalarText(pkg, "mailNo", "mail_no"));
    if (!id || !code) continue;
    const text = (firstCleanScalarText(appointment, ...WINDOW_KEYS) || firstCleanScalarText(feature, ...WINDOW_KEYS.slice(0, 2)) ||
      firstCleanScalarText(pkg, ...WINDOW_KEYS)).replace(/(?:预约上门|上门取件|预计上门|上门)[:：\s]*$/, "")
      .replace(/^(?:预约时间|上门时间|取件时间)[:：\s]*/, "").trim();
    let start = firstTime(appointment, [...START_KEYS, "startTime"]) || firstTime(pkg, START_KEYS);
    let end = firstTime(appointment, [...END_KEYS, "endTime"]) || firstTime(pkg, END_KEYS);
    const window = providerWindow(text, now);
    start ||= window?.[0];
    end ||= window?.[1];
    if (start && end && end < start) end = undefined;
    if (start || end || text) output.push({
      id: "cn-handoff:" + sha256Hex(owner + ":" + id),
      platform: "cainiao", kind: "handoff", code, capturedAtMs: now,
      windowStartAtMs: start, windowEndAtMs: end, windowText: start && end ? "" : text,
    });
  }
  return output;
}

function pddOrderFor(pkg: JsonObject): string {
  try {
    const jump = new URL(cleanScalarText(pkg.jump_url), "https://m.pinduoduo.net");
    if (!trustedPlatformPage("pinduoduo", jump.toString())) return "";
    return jump.searchParams.get("order_sn") || cleanScalarText(pkg.order_sn);
  } catch { return ""; }
}

export function pddPickupParcels(data: JsonObject): PlatformParcel[] {
  const result = isPlainObject(data.result) ? data.result : data;
  return objectList(result.combine_list).flatMap((group) => {
    const primary = objectList(group.combine_track_list);
    return (primary.length ? primary : objectList(group.list)).map((pkg): PlatformParcel => {
      const rawWaybill = cleanScalarText(pkg.tracking_number);
      const order = pddOrderFor(pkg);
      return {
        source: "pinduoduo", waybill: normalizeWaybill(rawWaybill), orderIds: order ? [order] : [],
        code: platformPickupCode(pkg.pick_code, rawWaybill, order),
        name: cleanScalarText(group.company_name), address: cleanScalarText(group.address),
      };
    });
  });
}
