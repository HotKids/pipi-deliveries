import {
  normalizeCarrierCode,
  resolveCarrierCpCode,
  resolveCarrierName,
  resolveCarrierQuery,
  type CarrierQueryRecord,
} from "./carrier-query";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";

function normalizeName(value: string): string {
  return String(value || "").replace(/\s+/g, "").trim();
}

function displayIcon(record: CarrierQueryRecord | null): string {
  return record?.iconKey || "default";
}

/**
 * 其余裁决 35（用户 2026-09-27：「算了统一前面加 快递 两个字吧」）：承运商位置为空时，通知标题、列表行、小组件与详情页头
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
