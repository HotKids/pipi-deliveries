import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import {
  guessCarrierQueryByWaybill,
  normalizeCarrierCode,
  resolveCarrierQuery,
} from "./carrier-query";

const ICON_BY_ALIAS = EXPRESS_POLICY.carrierIcons.aliases as Readonly<
  Record<string, string>
>;
const ICON_BY_NAME = EXPRESS_POLICY.carrierIcons.names as Readonly<
  Record<string, string>
>;

const DISPLAY_NAME_BY_CODE: Readonly<Record<string, string>> = {
  SF: "顺丰速运",
  ZTO: "中通快递",
  YTO: "圆通速递",
  STO: "申通快递",
  YD: "韵达快递",
  JD: "京东快递",
  JTSD: "极兔速递",
  EMS: "EMS",
  KYSY: "跨越速运",
  ZJS: "宅急送",
};

const DISPLAY_NAME_BY_ICON: Readonly<Record<string, string>> = {
  sf: "顺丰速运",
  zto: "中通快递",
  yto: "圆通速递",
  sto: "申通快递",
  yd: "韵达快递",
  jd: "京东快递",
  jtsd: "极兔速递",
  ems: "EMS",
  yzpy: "邮政包裹",
  dbl: "德邦快递",
  kysy: "跨越速运",
  zjs: "宅急送",
  danniao: "丹鸟",
};

const HOTLINE_BY_STANDARD_CODE: Readonly<Record<string, string>> = {
  SF: "95338",
  ZTO: "95311",
  ZTOKY: "",
  YTO: "95554",
  STO: "95543",
  YD: "95546",
  JD: "950616",
  JDKY: "950616",
  EMS: "11183",
  EMSGJ: "11183",
  YZPY: "11183",
  JTSD: "956025",
  HTKY: "",
  DBL: "95353",
  KYSY: "95324",
  ZJS: "4006789000",
  UC: "",
  DANNIAO: "",
};

const HOTLINE_BY_ICON: Readonly<Record<string, string>> = {
  sf: "95338",
  zto: "95311",
  yto: "95554",
  sto: "95543",
  yd: "95546",
  jd: "950616",
  jdshopping: "950616",
  ems: "11183",
  emsgj: "11183",
  yzpy: "11183",
  jtsd: "956025",
  dbl: "95353",
  kysy: "95324",
  zjs: "4006789000",
};

const NAMES_WITHOUT_HOTLINE = new Set([
  "中通快运",
  "百世",
  "百世快递",
  "汇通",
  "优速",
  "优速快递",
  "丹鸟",
  "丹鸟快递",
  "丹鸟速递",
  "菜鸟速递",
  "菜鸟直送",
]);

function normalizeName(value: string): string {
  return String(value || "").replace(/\s+/g, "").trim();
}

export function courierIconName(
  courierCode: string,
  companyName: string,
  accountOrder = false,
): string {
  if (accountOrder) return EXPRESS_POLICY.carrierIcons.accountOrder;
  return ICON_BY_ALIAS[normalizeCarrierCode(courierCode)]
    || ICON_BY_NAME[normalizeName(companyName)]
    || "";
}

export function courierHotline(
  courierCode: string,
  companyName: string,
): string {
  const standardCode = resolveCarrierQuery(courierCode)?.standardCode || "";
  if (Object.prototype.hasOwnProperty.call(HOTLINE_BY_STANDARD_CODE, standardCode)) {
    return HOTLINE_BY_STANDARD_CODE[standardCode];
  }
  const normalizedName = normalizeName(companyName);
  if (NAMES_WITHOUT_HOTLINE.has(normalizedName)) return "";
  const icon = courierIconName(courierCode, companyName);
  return HOTLINE_BY_ICON[icon] || "";
}

/**
 * Resolves the real carrier identity after an account order exposes a waybill.
 * The order-stage label is not carrier evidence and must never survive the projection.
 */
export function projectedCarrierPresentation(
  waybill: string,
  courierCode: string,
  companyName: string,
): { courierCode: string; companyName: string } {
  const rawName = String(companyName || "").trim();
  const normalizedName = normalizeName(rawName);
  const nameIcon = ICON_BY_NAME[normalizedName] || "";
  const orderStageName = nameIcon === EXPRESS_POLICY.carrierIcons.accountOrder;
  const inferred = guessCarrierQueryByWaybill(waybill);
  const normalizedCode = normalizeCarrierCode(courierCode);
  const resolvedCode = orderStageName
    ? inferred?.standardCode || ""
    : normalizedCode || inferred?.standardCode || "";
  const canonicalName = DISPLAY_NAME_BY_ICON[nameIcon]
    || DISPLAY_NAME_BY_CODE[resolvedCode]
    || rawName;
  return {
    courierCode: resolvedCode,
    companyName: orderStageName
      ? DISPLAY_NAME_BY_CODE[resolvedCode] || "快递"
      : canonicalName || "快递",
  };
}
