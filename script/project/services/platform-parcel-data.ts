import type { ParcelHandoffRecord, PddParcelImport, TimelinePackage, TrackNode } from "../models";
import { platformPickupCode } from "./fengchao-account";
import { trustedPlatformPage, type ExpressPlatform } from "./platform-accounts";
import { sha256Hex } from "./scripting-data";
import { isNonEventDetail, normalizeWaybill, packageSemantic, parseListEventTime, parseProviderTime, usableTimedTracks } from "./status";
import { TIMELINE_SLOT } from "./timeline-slot";
import { cainiaoProductImageURL } from "./product-image-url";
import { asPlainObject, cleanScalarText, firstCleanScalarText, isPlainObject, type JsonObject } from "./value-guards";

export type PddTrace = Readonly<{ time: string; info: string }>;

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
  taken?: boolean;
  takenAtMs?: number;
  productImageURL?: string;
  traces?: readonly PddTrace[];
}>;

export function pddTimelineFromTraces(
  waybill: string,
  courierCode: string,
  companyName: string,
  traces: readonly PddTrace[] | undefined,
  now: number,
  rawCourierCode?: string,
): TimelinePackage | null {
  if (!traces?.length || !waybill) return null;
  const seen = new Set<string>();
  const tracks: TrackNode[] = [];
  for (const item of traces.slice(0, 100)) {
    const rawTime = cleanScalarText(item?.time).replace(/[./]/g, "-").replace("T", " ");
    const timeText = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(rawTime) ? `${rawTime}:00` : rawTime;
    const timeMs = parseProviderTime(timeText);
    const detail = cleanScalarText(item?.info).replace(/\s+/g, " ").slice(0, 2_000);
    const key = `${timeText}\u0000${detail}`;
    if (timeMs == null || !detail || isNonEventDetail(detail) || seen.has(key)) continue;
    seen.add(key);
    tracks.push({
      timeText,
      timeMs,
      detail,
      statusCode: "",
      raw: { _pipiStatusSource: "pdd_h5" },
    });
  }
  tracks.sort((left, right) => (right.timeMs || 0) - (left.timeMs || 0));
  const timed = usableTimedTracks(tracks);
  if (!timed.length) return null;
  const status = packageSemantic("", tracks);
  return {
    provider: TIMELINE_SLOT.PDD_H5,
    structuredStatus: false,
    complete: timed.length >= 2,
    waybill,
    ...(rawCourierCode ? { rawCourierCode } : {}),
    courierCode,
    companyName,
    semantic: status.semantic,
    statusEventAtMs: status.eventAtMs,
    latestTimeText: timed[0].timeText,
    latestDetail: timed[0].detail,
    tracks,
    successAtMs: now,
  };
}

export function pddParcelDetailPath(shippingId: string, waybill: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(shippingId) || !/^[A-Z0-9]{6,64}$/.test(waybill)) return "";
  return "/psnl_goods_help.html?_t_module_name=assistant_waybill" +
    "&shipping_id=" + shippingId + "&tracking_number=" + waybill;
}

export function pddParcelAppURL(parcel: PddParcelImport | undefined, waybill: string): string {
  if (!parcel?.ownerKey || !parcel.orderId || !parcel.shippingId) return "";
  return pddParcelNativeAppURL(parcel.shippingId, waybill);
}

export function pddParcelNativeAppURL(shippingId: string, waybill: string): string {
  const path = pddParcelDetailPath(shippingId, waybill);
  return path ? "pinduoduo://com.xunmeng.pinduoduo" + path : "";
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
const CN_RECIPIENT_TAKEN = /^(?:SIGN|SIGNED|已签收|已取件|已取出)$/i;
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
  const goods = matches[0].goodsList;
  const items = Array.isArray(goods) ? objectList(goods) : [asPlainObject(goods)];
  const productImageURL = items.map((item) =>
    cainiaoProductImageURL(item.itemPic) || cainiaoProductImageURL(item.allPicUrl)).find(Boolean);
  return { source: "cainiao", waybill, ...cainiaoParcelFields(matches[0], now),
    ...(productImageURL ? { productImageURL } : {}) };
}

export function cainiaoRecipientParcels(data: JsonObject, now: number): PlatformParcel[] {
  const output: PlatformParcel[] = [];
  for (const pkg of rows(data)) {
    const statuses = ["status", "statusDesc", "packageStatus"].map((field) => cleanScalarText(pkg[field]));
    if (statuses.some(status => CN_RECIPIENT_TERMINAL.test(status) && !CN_RECIPIENT_TAKEN.test(status))) continue;
    const taken = statuses.some((status) => CN_RECIPIENT_TAKEN.test(status));
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
    if (!waybill && (rawWaybill || !code)) continue;
    if (taken) {
      const takenAtMs = firstTime(pkg, ["statusTime", "statusUpdateTime", "status_update_time"]);
      if (takenAtMs && (takenAtMs > now || takenAtMs < now - 14 * DAY)) continue;
      output.push({ source: "cainiao", waybill, code, name, address, unnumbered: !rawWaybill, taken, takenAtMs });
      continue;
    }
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

export function nearestCalendarYear(month: number, date: number, referenceMs: number): number {
  const observed = chinaDay(referenceMs);
  let year = new Date(observed).getUTCFullYear();
  let candidate = Date.UTC(year, month - 1, date);
  if (candidate < observed - 180 * DAY) candidate = Date.UTC(++year, month - 1, date);
  else if (candidate > observed + 180 * DAY) candidate = Date.UTC(--year, month - 1, date);
  return year;
}

export function parseHandoffWindow(text: string, now: number, exact = false): [number, number] | undefined {
  const range = /(?:(\d{4})[-/])?(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})\s*[-–~至]\s*(?:(\d{1,2})[-/](\d{1,2})\s+)?(\d{1,2}):(\d{2})/.exec(text);
  if (!range || exact && range[0] !== text) return undefined;
  const startMonth = Number(range[2]);
  const startDate = Number(range[3]);
  const startYear = range[1] ? Number(range[1]) : nearestCalendarYear(startMonth, startDate, now);
  const build = (year: number, month: string, date: string, hour: string, minute: string) =>
    parseListEventTime([String(year), month.padStart(2, "0"), date.padStart(2, "0")].join("-") + " " + hour.padStart(2, "0") + ":" + minute);
  const start = build(startYear, range[2], range[3], range[4], range[5]);
  const endMonthStr = range[6] || range[2];
  const endDateStr = range[7] || range[3];
  let end = build(startYear, endMonthStr, endDateStr, range[8], range[9]);
  if (start && end && end < start && range[6]) {
    end = build(startYear + 1, endMonthStr, endDateStr, range[8], range[9]);
  }
  return start && end && end >= start ? [start, end] : undefined;
}

export function cainiaoHandoffId(owner: string, orderId: string): string {
  return "cn-handoff:" + sha256Hex(owner + ":" + orderId);
}

export function cainiaoHandoffs(data: JsonObject, owner: string, now: number,
  existing: readonly ParcelHandoffRecord[] = []): ParcelHandoffRecord[] {
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
    const raw = firstCleanScalarText(appointment, ...names, "doorCode", "takeCode", "verifyCode") ||
      firstCleanScalarText(feature, ...names) || firstCleanScalarText(pkg, ...names, "doorCode", "takeCode");
    const key = cainiaoHandoffId(owner, id);
    const code = platformPickupCode(raw, id, firstCleanScalarText(pkg, "mailNo", "mail_no")) ||
      (!raw ? existing.find((record) => record.id === key && !record.completedAtMs && !record.expiredAtMs)?.code : "");
    if (!id || !code) continue;
    const text = (firstCleanScalarText(appointment, ...WINDOW_KEYS) || firstCleanScalarText(feature, ...WINDOW_KEYS.slice(0, 2)) ||
      firstCleanScalarText(pkg, ...WINDOW_KEYS)).replace(/(?:预约上门|上门取件|预计上门|上门)[:：\s]*$/, "")
      .replace(/^(?:预约时间|上门时间|取件时间)[:：\s]*/, "").trim();
    let start = firstTime(appointment, [...START_KEYS, "startTime"]) || firstTime(pkg, START_KEYS);
    let end = firstTime(appointment, [...END_KEYS, "endTime"]) || firstTime(pkg, END_KEYS);
    const window = parseHandoffWindow(text, now);
    start ||= window?.[0];
    end ||= window?.[1];
    if (start && end && end < start) end = undefined;
    output.push({
      id: key,
      platform: "cainiao", kind: "handoff", code, capturedAtMs: now,
      providerTitle: firstCleanScalarText(pkg, "providerTitle") || undefined,
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
