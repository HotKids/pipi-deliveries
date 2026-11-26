import type { ColorStringHex } from "scripting";
import {
  normalizeCarrierCode,
  resolveCarrierCpCode,
  resolveCarrierName,
  resolveCarrierQuery,
  type CarrierQueryRecord,
} from "./carrier-query";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";

// The same dominant-colour filter as Pipi's ExpressWidgetPalette, applied to the bundled courier artwork.
const ACCENT_BY_ICON: Readonly<Partial<Record<string, ColorStringHex>>> = {
  danniao: "#3B2000",
  dbl: "#00519E",
  ems: "#F39400",
  emsgj: "#FF2600",
  jd: "#D32B2C",
  jdshopping: "#FA0352",
  jtsd: "#E33C24",
  kysy: "#762E97",
  sf: "#E3373F",
  sto: "#F57A00",
  uc: "#72388A",
  yd: "#F7CD23",
  yto: "#581A7E",
  yzpy: "#008E4F",
  zjs: "#009D51",
  zto: "#0480BB",
  // International Watch icons (G-MED-04, 2026-11-20 review): the same filter over the 156px bundled artwork.
  "watch-dhl": "#FECC00",
  "watch-fedex": "#4D138B",
  "watch-gls": "#0519B0",
  "watch-ups": "#EFB828",
  "watch-usps": "#333267",
};

export function carrierArtworkAccent(icon: string): ColorStringHex | undefined {
  return Object.hasOwn(ACCENT_BY_ICON, icon) ? ACCENT_BY_ICON[icon] : undefined;
}

function normalizeName(value: string): string {
  return String(value || "").replace(/\s+/g, "").trim();
}

function displayIcon(record: CarrierQueryRecord | null): string {
  return record?.iconKey || "default";
}

/**
 * 跨端对齐裁决 #35（用户 2026-09-27：「算了统一前面加 快递 两个字吧」）：承运商位置为空时，通知标题、列表行、小组件与详情页头
 * 统一显示「快递」；有承运商名或原始码时照旧显示它们。只在展示层：存盘的 companyName 与查询用的承运商码不动。取代
 * 2026-09-15「不自造承运商名『快递』」在承运商为空这一种情形下的规定。
 */
export const EMPTY_CARRIER_DISPLAY_NAME = "快递";

/**
 * 2026-10-08 用户决定 #9（「显示和写入都先查表」）：名字能在内置表里查到时显示表内的可见名（如上游的「邮政快递包裹」显示为
 * 「邮政快递」）；查不到的名字或原始码照旧原样显示，空的显示「快递」。
 */
export function carrierDisplayName(companyName: string | null | undefined): string {
  const name = String(companyName || "").trim();
  return (name && resolveCarrierName(name)?.displayName) || name || EMPTY_CARRIER_DISPLAY_NAME;
}

/**
 * 4×2 widget identity line: 「承运商 尾号」. An outgoing parcel's 寄 is the gray tag after it, not text (owner
 * 2026-11-20: 「4×2 也改成灰色标签放尾号后面」).
 */
export function widgetIdentityText(row: Readonly<{ companyName: string; waybillSuffix: string }>): string {
  const carrier = carrierDisplayName(row.companyName);
  return row.waybillSuffix ? `${carrier} ${row.waybillSuffix}` : carrier;
}

export type BuiltInCarrierPresentation = Readonly<{
  courierCode: string;
  companyName: string;
}>;

export function builtInCarrierPresentation(
  companyName: string,
): BuiltInCarrierPresentation | null {
  const selected = resolveCarrierName(companyName);
  if (!selected) return null;
  return {
    courierCode: selected.standardCode,
    companyName: selected.displayName,
  };
}

export function courierIconName(
  courierCode: string,
  companyName: string,
  accountOrder = false,
): string {
  if (accountOrder) return EXPRESS_POLICY.carrierIcons.accountOrder;
  if (/^watch-(dhl|fedex|gls|ups|usps)$/.test(courierCode)) return courierCode;
  return displayIcon(
    resolveCarrierQuery(courierCode) ||
      resolveCarrierCpCode(courierCode) ||
      resolveCarrierName(companyName) ||
      null,
  );
}

export function courierHotline(
  courierCode: string,
  companyName: string,
): string {
  return (
    resolveCarrierQuery(courierCode) ||
    resolveCarrierCpCode(courierCode) ||
    resolveCarrierName(companyName) ||
    null
  )?.hotline || "";
}

/**
 * Resolves the real carrier identity after an account order exposes a waybill.
 * The order-stage label is not carrier evidence and must never survive the projection.
 */
export function projectedCarrierPresentation(
  _waybill: string,
  courierCode: string,
  companyName: string,
): { courierCode: string; companyName: string } {
  const rawName = String(companyName || "").trim();
  const normalizedName = normalizeName(rawName);
  const orderStageName = normalizedName === "京东购物";
  const normalizedCode = normalizeCarrierCode(courierCode);
  const codeRecord = resolveCarrierQuery(normalizedCode) ||
    resolveCarrierCpCode(normalizedCode);
  const nameRecord = resolveCarrierName(normalizedName);
  // Discard the shopping label and its JD hint, not an independently known carrier.
  const selected = orderStageName && codeRecord?.standardCode === "JD"
    ? null
    : codeRecord || nameRecord;
  const resolvedCode = selected?.standardCode || (orderStageName ? "" : normalizedCode);
  const canonicalName = selected?.displayName || (orderStageName ? "" : rawName);
  return {
    courierCode: resolvedCode,
    companyName: canonicalName === "快递" ? "" : canonicalName,
  };
}
