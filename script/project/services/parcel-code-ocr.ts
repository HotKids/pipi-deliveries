import type { ParcelHandoffRecord, PickupPlatform, StandaloneParcelPickup } from "../models";
import { parcelWaybillEvidence, type ParcelRow } from "./parcel-waybill-ocr";
import { formatListTime } from "./time-presentation";

export type RecognizedPickup = Readonly<{ code: string; locationName?: string }>;
export type ParcelLookup = Readonly<{
  waybill: string;
  capturedAtMs: number;
  pickup?: RecognizedPickup;
}>;
type IndependentCode = Omit<StandaloneParcelPickup, "id"> | Omit<ParcelHandoffRecord, "id">;

// Pipi's ExpressPackageDyn and ExpressOcrExtractor define the recognized code and place fields.
const CODE_PATTERN = /^(?:[A-Z0-9]{3,20}|[A-Z0-9]{1,12}(?:-[A-Z0-9]{1,12})+)$/;
const PLACE_CHARS = "[^，。,.!！?？:：;；【】\\[\\]「」\"“”]";
const STATION_ROW = new RegExp("^" + PLACE_CHARS + "{1,20}?驿站(?:\\s*" + PLACE_CHARS + "{1,30}店)?$");
const STORE_ROW = new RegExp("^" + PLACE_CHARS + "{2,30}(?:店|驿站|站点|快递柜)$");
const PICKUP_BRANDS: Record<PickupPlatform, string> = { cainiao: "菜鸟驿站", pinduoduo: "多多驿站", fengchao: "丰巢" };

export function normalizeRecognizedPickupCode(value: string): string {
  const code = value.replace(/\s+/g, "").toUpperCase();
  return CODE_PATTERN.test(code) ? code : "";
}

function labeledCodes(lines: readonly string[], name: "取件码" | "寄件码"): Set<string> {
  const inline = new RegExp(name + "\\s*[：:]?\\s*(.+)$");
  const values = new Set<string>();
  lines.forEach((line, index) => {
    const cleaned = line.trim().replace(/^[：:| ]+|[：:| ]+$/g, "");
    const value = cleaned === name ? lines[index + 1] ?? "" : cleaned.match(inline)?.[1] ?? "";
    const code = normalizeRecognizedPickupCode(value.replace(/\s*复制\s*$/, ""));
    if (code) values.add(code);
  });
  return values;
}

function closestAbove(rows: readonly ParcelRow[], index: number): number {
  const row = rows[index]?.bounds;
  if (!row) return -1;
  let best = -1;
  let closest = -Infinity;
  for (const [i, candidate] of rows.entries()) {
    const box = candidate.bounds;
    if (!box || i === index || (box.top + box.bottom) / 2 >= row.top ||
        Math.min(box.right, row.right) <= Math.max(box.left, row.left) || box.bottom <= closest) continue;
    best = i;
    closest = box.bottom;
  }
  const box = rows[best]?.bounds;
  return box && row.top - box.bottom <= 2 * Math.max(row.bottom - row.top, box.bottom - box.top) ? best : -1;
}

function adjacentPickupCode(text: string, waybill: string): string {
  if (!/^[A-Za-z0-9]+(?:(?:\s*-\s*|\s+)[A-Za-z0-9]+)*$/.test(text)) return "";
  const compact = text.replace(/[\s-]/g, "");
  if (compact.length < 3 || compact.length > 12 || !/\d/.test(compact) ||
      compact.toUpperCase() === waybill.replace(/[^A-Za-z0-9]/g, "").toUpperCase() ||
      /^1[3-9]\d{9}$/.test(compact) ||
      /^(?:\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2}|\d{1,2}\s*-\s*\d{1,2})$/.test(text)) return "";
  return normalizeRecognizedPickupCode(text);
}

// The two doorstep templates and appointment grammar come from ParcelHandoffExtractor.
const DATE = "(?:今天|明天|(?:\\d{4}年)?\\d{1,2}月\\d{1,2}日|\\d{4}-\\d{1,2}-\\d{1,2})";
const WINDOW = new RegExp("(" + DATE + ")?\\s*(\\d{1,2})[:：](\\d{2})\\s*[–—~～至-]\\s*(" +
  DATE + ")?\\s*(\\d{1,2})[:：](\\d{2})");
const HOUR_MS = 3_600_000;

function appointmentDate(value: string | undefined, capturedAtMs: number): string {
  if (!value) return "";
  const captureDay = formatListTime(new Date(capturedAtMs).toISOString()).slice(0, 10);
  if (value === "今天") return captureDay;
  if (value === "明天") return new Date(Date.parse(captureDay) + 24 * HOUR_MS).toISOString().slice(0, 10);
  const date = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) ??
    value.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/);
  if (!date) return "";
  const day = [date[1] ?? captureDay.slice(0, 4), date[2].padStart(2, "0"), date[3].padStart(2, "0")].join("-");
  const ms = Date.parse(day);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? day : "";
}

function recognizeHandoff(lines: readonly string[], capturedAtMs: number): IndependentCode | undefined {
  const text = lines.join("\n");
  const pinduoduo = /换货详情|退货详情/.test(text) && text.includes("待快递员取件") && text.includes("请在快递员上门后出示");
  const cainiao = text.includes("菜鸟") && text.includes("待上门取件") && text.includes("寄件码");
  if (pinduoduo === cainiao) return undefined;
  const codes = labeledCodes(lines, cainiao ? "寄件码" : "取件码");
  if (codes.size !== 1) return undefined;
  const windows = new Set(lines.filter((line) => line.includes("上门取件"))
    .map((line) => line.match(WINDOW)?.[0]).filter(Boolean));
  if (windows.size > 1) return undefined;
  const record: Omit<ParcelHandoffRecord, "id"> = {
    kind: "handoff", platform: cainiao ? "cainiao" : "pinduoduo", capturedAtMs, code: [...codes][0],
  };
  const range = [...windows][0]?.match(WINDOW);
  if (!range || Number(range[2]) > 23 || Number(range[3]) > 59 ||
      Number(range[5]) > 23 || Number(range[6]) > 59) return record;
  const from = range[2].padStart(2, "0") + ":" + range[3];
  const to = range[5].padStart(2, "0") + ":" + range[6];
  const first = appointmentDate(range[1], capturedAtMs);
  const last = range[4] ? appointmentDate(range[4], capturedAtMs) : first;
  const windowText = from + "–" + to;
  if (range[1] && !first || range[4] && !last) return record;
  if (!first || !last) return { ...record, windowText };
  const windowStartAtMs = Date.parse(first + "T" + from + ":00+08:00");
  const windowEndAtMs = Date.parse(last + "T" + to + ":00+08:00");
  return windowEndAtMs < windowStartAtMs ? { ...record, windowText } :
    { ...record, windowText, windowStartAtMs, windowEndAtMs };
}

export function recognizeParcelCodes(rows: readonly ParcelRow[], capturedAtMs: number): {
  lookup?: ParcelLookup;
  independent?: IndependentCode;
} {
  const { waybill, candidateCount, carrierRow } = parcelWaybillEvidence(rows);
  const lines = rows.map((row) => row.text);
  const handoff = recognizeHandoff(lines, capturedAtMs);
  if (handoff) return { independent: handoff, ...(waybill ? { lookup: { waybill, capturedAtMs } } : {}) };

  const codes = labeledCodes(lines, "取件码");
  const stations = new Set(lines.map((line) => line.trim().replace(/\s+/g, " ")).filter((line) => STATION_ROW.test(line)));
  let locationName = stations.size === 1 ? [...stations][0] : undefined;
  let code = codes.size === 1 ? [...codes][0] : "";
  if (waybill) {
    if (!codes.size && carrierRow >= 0) {
      const codeRow = closestAbove(rows, carrierRow);
      code = adjacentPickupCode(rows[codeRow]?.text ?? "", waybill);
      if (code && !locationName) {
        const store = rows[closestAbove(rows, codeRow)]?.text ?? "";
        if (STORE_ROW.test(store)) locationName = store;
      }
    }
    return { lookup: { waybill, capturedAtMs, ...(code ? { pickup: { code, locationName } } : {}) } };
  }

  const brands = (Object.keys(PICKUP_BRANDS) as PickupPlatform[])
    .filter((platform) => lines.some((line) => line.includes(PICKUP_BRANDS[platform])));
  if (candidateCount || !code || brands.length !== 1) return {};
  return { independent: { kind: "pickup", platform: brands[0], code, locationName, capturedAtMs } };
}
