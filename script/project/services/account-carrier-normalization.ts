import { JING_DONG_ACCOUNT_NAME, type AccountParcelDto } from "./account-parser";
import {
  cachedCarrierRecognition,
  carrierRecognitionExhausted,
  recognizeNonSyncCarrier,
  type CarrierRecognitionBudget,
  type CarrierRecognitionResult,
} from "./carrier-recognition";
import { carrierUnmatched } from "./carrier-gate";
import {
  activeCarrierTableVersion,
  normalizeCarrierCode,
  resolveCarrierCpCode,
  resolveCarrierName,
  resolveCarrierQuery,
} from "./carrier-query";
import {
  builtInCarrierPresentation,
  projectedCarrierPresentation,
} from "./carrier-presentation";
import { normalizeWaybill } from "./status";
import { accountParcelReuseAnchorAtMs } from "./waybill-reuse";
import { firstClassifyAnchor } from "./row-ledger";
import type { Shipment, ShipmentIdentity } from "../models";
import type { CarrierNormalization } from "./carrier-normalization";

type Recognizer = typeof recognizeNonSyncCarrier;

export type AccountCarrierNormalizationOptions = Readonly<{
  deadlineAtMs?: number;
  signal?: AbortSignal;
  /** The round's shared recognition wait (用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒). */
  budget?: CarrierRecognitionBudget;
  recognize?: Recognizer;
}>;

export function hasBuiltInAccountCarrierName(value: string): boolean {
  return builtInCarrierPresentation(value) != null;
}

function realWaybill(parcel: AccountParcelDto): string {
  const waybill = normalizeWaybill(parcel.waybill || parcel.ownerId);
  const ownerId = normalizeWaybill(parcel.ownerId);
  if (!waybill || (parcel.accountOrder && waybill === ownerId)) return "";
  return waybill;
}

/**
 * A JD-platform row (Xiaomi `provider=JingDong`) names the shopping platform in its raw code
 * (`JDKD`…), not the courier. On a real waybill that is not a JD number, that label — and any
 * sidecar or name that only re-states JD — is no carrier evidence (R-20); the waybill is
 * recognised instead.
 */
function platformLabelOnly(parcel: AccountParcelDto): boolean {
  const provider = String(parcel.sourceProvider || "").trim().toLowerCase();
  if (provider !== "jingdong") return false;
  const waybill = realWaybill(parcel);
  return Boolean(waybill) && !/^JD/i.test(waybill);
}

/**
 * The carrier this parcel shows without asking anyone: the built-in table, else what the recognizer already cached
 * for its waybill. A JD-platform row (R-20) with neither shows no carrier rather than its platform label (T23, user
 * 2026-09-26).
 */
export function directAccountCarrierPresentation(parcel: AccountParcelDto): AccountParcelDto {
  const direct = directPresentation(parcel);
  if (direct) return direct;
  const waybill = realWaybill(parcel);
  const cached = waybill ? cachedCarrierRecognition(waybill) : null;
  if (cached) {
    return applyRecognition(parcel, {
      normalization: cached.normalization,
      terminal: false,
      pendingSecondLevel: false,
      coolingDown: false,
      ...(cached.normalization ? {} : { displayName: cached.displayName }),
    });
  }
  return waybill && carrierRecognitionExhausted(waybill)
    ? applyRecognition(parcel, {
        normalization: null,
        terminal: true,
        pendingSecondLevel: false,
        coolingDown: false,
        exhausted: true,
      })
    : withoutPlatformLabel(parcel);
}

/** Whether a JD-platform row's shown carrier fields only re-state JD (the R-20 label), or are empty. */
function showsPlatformLabel(parcel: AccountParcelDto): boolean {
  if (!platformLabelOnly(parcel)) return false;
  const name = String(parcel.companyName || "").trim();
  const nameRecord = name ? resolveCarrierName(name) : null;
  if (nameRecord) return nameRecord.standardCode === "JD";
  if (name && name !== JING_DONG_ACCOUNT_NAME && name !== "京东购物") return false;
  const code = normalizeCarrierCode(parcel.courierCode || "");
  const codeRecord = code ? resolveCarrierQuery(code) || resolveCarrierCpCode(code) : null;
  return !codeRecord || codeRecord.standardCode === "JD";
}

/**
 * After the built-in table found nothing: whether the parcel's own name still names a carrier. A JD-platform row's
 * label (R-20), an empty name and a raw code standing in as the name do not.
 */
function namesCarrier(parcel: AccountParcelDto): boolean {
  if (showsPlatformLabel(parcel)) return false;
  const shown = normalizeCarrierCode(String(parcel.companyName || "").trim());
  return Boolean(shown) &&
    shown !== normalizeCarrierCode(parcel.courierCode || "") &&
    shown !== normalizeCarrierCode(parcel.rawCourierCode || "");
}

/**
 * R-20 when nothing identified the carrier (T23, user 2026-09-26): a JD-platform row shows no carrier instead of its
 * platform label. The raw tuple is kept.
 */
function withoutPlatformLabel(parcel: AccountParcelDto): AccountParcelDto {
  if (!showsPlatformLabel(parcel) ||
      (!parcel.courierCode && !parcel.companyName && !parcel.carrierNormalization)) return parcel;
  return { ...parcel, courierCode: "", companyName: "", carrierNormalization: null };
}

function directPresentation(parcel: AccountParcelDto): AccountParcelDto | null {
  const platformOnly = platformLabelOnly(parcel);
  const rawCode = parcel.rawCourierCode
    ? resolveCarrierCpCode(parcel.rawCourierCode)
    : null;
  const carrier = [
    rawCode,
    resolveCarrierName(parcel.rawCompanyName || ""),
    resolveCarrierQuery(parcel.courierCode),
    resolveCarrierName(parcel.companyName),
    parcel.carrierNormalization?.isBuiltIn
      ? resolveCarrierQuery(parcel.carrierNormalization.standardCode)
      : null,
  ].find(record => record && !(platformOnly && record.standardCode === "JD"));
  if (!carrier) return null;
  const presentation = projectedCarrierPresentation(
    parcel.waybill,
    carrier.standardCode,
    parcel.companyName || carrier.displayName,
  );
  const displayName = presentation.companyName || carrier.displayName;
  return {
    ...parcel,
    courierCode: carrier.standardCode,
    companyName: displayName,
    carrierNormalization: {
      standardCode: carrier.standardCode,
      displayName,
      kuaidi100Code: carrier.kuaidi100Code,
      isBuiltIn: true,
      tableVersion: activeCarrierTableVersion(),
    },
  };
}

function applyRecognition(
  parcel: AccountParcelDto,
  recognition: CarrierRecognitionResult,
): AccountParcelDto {
  const carrier = recognition.normalization;
  if (carrier?.isBuiltIn) {
    return {
      ...parcel,
      courierCode: carrier.standardCode,
      companyName: carrier.displayName,
      carrierNormalization: carrier,
    };
  }
  // 表外承运商（用户 2026-09-26，其余裁决 29）：快递100 认得出、内置表里没有，只在这一行还没有承运商时显示它给的名字；
  // 不进表、没有专属图标，原始元组不动。
  const displayName = String(recognition.displayName || "").trim();
  if (displayName && !namesCarrier(parcel)) {
    return {
      ...parcel,
      courierCode: "",
      companyName: displayName,
      carrierNormalization: {
        standardCode: "",
        displayName,
        kuaidi100Code: "",
        isBuiltIn: false,
        tableVersion: activeCarrierTableVersion(),
      },
    };
  }
  const unlabelled = withoutPlatformLabel(parcel);
  // 其余裁决 32、33（用户 2026-09-26）：识别进入终态、快递100 也没给名字时，承运商位置填来源传回的承运商码原样（JDKD、ZTKY
  // 这类，不是平台名「京东快递」），没传回就空着（这一行照样放行，见 carrier-gate）。原始码只作显示，不当承运商码用。订单的
  // 投影由同步层用订单自己的原始码处理。
  const rawCode = String(parcel.rawCourierCode || "").trim();
  if (recognition.exhausted && !parcel.accountOrder && rawCode && !namesCarrier(unlabelled)) {
    return { ...unlabelled, companyName: rawCode };
  }
  return unlabelled;
}

/** The row an account record lands on (account-sync parcelToShipment builds the same id). */
export function accountParcelRowId(parcel: AccountParcelDto): string {
  const ownerId = normalizeWaybill(parcel.ownerId);
  return ownerId ? `${parcel.source}:account:${ownerId}` : "";
}

/**
 * 优化 5 续（用户 2026-10-03「第一次识别时记下锚点，之后不变」）：the anchor an account record sends with the paid stage —
 * its row's recorded first anchor, or, the first time, this record's own reuse anchor as it is now (then recorded).
 */
export function accountParcelClassifyAnchor(parcel: AccountParcelDto): () => number | undefined {
  return () => firstClassifyAnchor(accountParcelRowId(parcel), () => accountParcelReuseAnchorAtMs(parcel));
}

/** Resolves display-only carrier identity without changing source or raw fields. */
export async function normalizeAccountParcelCarrier(
  parcel: AccountParcelDto,
  options: AccountCarrierNormalizationOptions = {},
): Promise<AccountParcelDto> {
  const waybill = realWaybill(parcel);
  if (!waybill) return parcel;
  const direct = directPresentation(parcel);
  if (direct) return direct;
  const recognition = await (options.recognize || recognizeNonSyncCarrier)(
    waybill,
    { deadlineAtMs: options.deadlineAtMs, signal: options.signal, budget: options.budget,
      // 优化 5 (user 2026-10-03): this record's own reuse anchor goes with the paid stage, the one its row first sent.
      parcelAnchorAtMs: accountParcelClassifyAnchor(parcel) },
  );
  return applyRecognition(parcel, recognition);
}

/**
 * A real projected waybill needs recognition whenever its code and name do not identify a
 * built-in carrier. The JD platform hint remains invalid evidence on non-JD waybills.
 */
export function needsProjectedCarrierRepair(
  identity: Pick<ShipmentIdentity, "accountOrder" | "manuallyAdded" | "projectedWaybill" | "courierCode" | "companyName">,
): boolean {
  if (!identity.accountOrder || identity.manuallyAdded) return false;
  const projected = normalizeWaybill(identity.projectedWaybill || "");
  if (!projected) return false;
  const code = normalizeCarrierCode(identity.courierCode || "");
  const record = [
    resolveCarrierQuery(code),
    resolveCarrierCpCode(code),
    resolveCarrierName(identity.companyName || ""),
  ].find(value => value && (value.standardCode !== "JD" || /^JD/i.test(projected)));
  return !record;
}

export function repairProjectedShipmentCarrier(
  shipment: Shipment,
  normalization: CarrierNormalization | null | undefined,
  /** 表外承运商的快递100 名（其余裁决 29）：只补承运商名为空的投影行。 */
  offTableName = "",
): Shipment {
  if (!needsProjectedCarrierRepair(shipment.identity)) return shipment;
  const projected = normalizeWaybill(shipment.identity.projectedWaybill || "");
  let carrier: Readonly<{
    courierCode: string;
    companyName: string;
    rawCourierCode: string;
    carrierIsBuiltIn: boolean;
    carrierKuaidi100Code: string;
    carrierTableVersion: string;
  }>;
  if (normalization?.isBuiltIn) {
    const code = normalizeCarrierCode(normalization.standardCode);
    if (!code || (code === "JD" && !/^JD/i.test(projected)) ||
        code === normalizeCarrierCode(shipment.identity.courierCode || "")) {
      return shipment;
    }
    const presentation = projectedCarrierPresentation(projected, code, normalization.displayName);
    carrier = {
      courierCode: presentation.courierCode || code,
      companyName: presentation.companyName || normalization.displayName,
      rawCourierCode: "",
      carrierIsBuiltIn: true,
      carrierKuaidi100Code: normalization.kuaidi100Code,
      carrierTableVersion: normalization.tableVersion,
    };
  } else {
    // Only a row still without a carrier takes the Kuaidi100 name: blank, the R-20 label, or the raw code shown after an
    // exhausted recognition (其余裁决 29、32).
    const displayName = String(offTableName || "").trim();
    if (!displayName || !carrierUnmatched(shipment)) return shipment;
    carrier = {
      courierCode: "",
      companyName: displayName,
      rawCourierCode: "",
      carrierIsBuiltIn: false,
      carrierKuaidi100Code: "",
      carrierTableVersion: activeCarrierTableVersion(),
    };
  }
  const retag = <T extends { courierCode: string; companyName: string } | null | undefined>(timeline: T): T =>
    timeline ? { ...timeline, courierCode: carrier.courierCode, companyName: carrier.companyName } : timeline;
  const identity = { ...shipment.identity, ...carrier };
  const ownership = shipment.automaticOwnership;
  return {
    ...shipment,
    identity,
    timeline: retag(shipment.timeline),
    sourceTimeline: retag(shipment.sourceTimeline),
    // 手动/H5 包裹里也存着抓取当时的承运商（kuaidi100_h5 直接写 detectedCarrier）。identity 修好了
    // 却把它们留在原地，泄漏的订单阶段承运商就会从详情页那条链上重新冒出来。
    manualTimelines: (shipment.manualTimelines || []).map((timeline) =>
      retag(timeline)
    ),
    automaticOwnership: ownership
      ? {
          ...ownership,
          observations: ownership.observations.map((observation) =>
            observation.identity.id === identity.id
              ? {
                  ...observation,
                  identity: { ...observation.identity, ...carrier },
                  sourceTimeline: retag(observation.sourceTimeline),
                }
              : observation
          ),
        }
      : ownership,
  };
}
