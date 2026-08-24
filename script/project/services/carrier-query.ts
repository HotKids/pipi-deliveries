import { EXPRESS_POLICY } from "../contracts/express-policy.generated";

export type CarrierQueryRecord = {
  standardCode: string;
  kuaidi100Code: string;
  requiresPhoneTail: boolean;
};

export function normalizeCarrierCode(value: string): string {
  let code = String(value || "").trim().toUpperCase();
  if (code.startsWith("VIVO_")) code = code.slice(5);
  return code.replace(/[^A-Z0-9]/g, "");
}

const BY_ALIAS = new Map<string, CarrierQueryRecord>();
for (const value of EXPRESS_POLICY.carrierQuery.records) {
  const record: CarrierQueryRecord = {
    standardCode: value.standardCode,
    kuaidi100Code: value.kuaidi100Code,
    requiresPhoneTail: value.requiresPhoneTail,
  };
  for (const alias of [
    value.standardCode,
    value.kuaidi100Code,
    ...value.aliases,
  ]) {
    BY_ALIAS.set(normalizeCarrierCode(alias), record);
  }
}

export function resolveCarrierQuery(
  code: string,
): CarrierQueryRecord | null {
  return BY_ALIAS.get(normalizeCarrierCode(code)) || null;
}

export function guessCarrierQueryByWaybill(
  waybill: string,
): CarrierQueryRecord | null {
  const normalized = normalizeCarrierCode(waybill);
  for (const [prefix, carrierCode] of Object.entries(
    EXPRESS_POLICY.carrierQuery.waybillPrefixes,
  )) {
    if (normalized.startsWith(prefix)) {
      return resolveCarrierQuery(carrierCode);
    }
  }
  return null;
}

export function queryPhoneTails(
  record: CarrierQueryRecord | null,
  explicitTail: string,
  boundTails: readonly string[],
): string[] {
  const supplied = [explicitTail, ...boundTails]
    .map((value) => String(value || "").trim())
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
  return record?.requiresPhoneTail ? supplied : ["", ...supplied];
}
