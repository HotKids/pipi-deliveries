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
  const selected = orderStageName ? null : codeRecord || nameRecord;
  // Do not let the shopping-order JD hint leak into the projected parcel.
  const resolvedCode = orderStageName
    ? selected?.standardCode || ""
    : selected?.standardCode || normalizeCarrierCode(courierCode);
  const canonicalName = selected?.displayName || rawName;
  return {
    courierCode: resolvedCode,
    companyName: orderStageName
      ? selected?.displayName || "快递"
      : canonicalName || "快递",
  };
}
