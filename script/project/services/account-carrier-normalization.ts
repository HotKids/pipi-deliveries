import type { AccountParcelDto } from "./account-parser";
import {
  recognizeNonSyncCarrier,
  type CarrierRecognitionResult,
} from "./carrier-recognition";
import {
  activeCarrierTableVersion,
  normalizeCarrierCode,
  resolveCarrierCpCode,
  resolveCarrierQuery,
} from "./carrier-query";
import {
  builtInCarrierPresentation,
  projectedCarrierPresentation,
} from "./carrier-presentation";
import { normalizeWaybill } from "./status";
import type { Shipment, ShipmentIdentity } from "../models";
import type { CarrierNormalization } from "./carrier-normalization";

type Recognizer = typeof recognizeNonSyncCarrier;

export type AccountCarrierNormalizationOptions = Readonly<{
  deadlineAtMs?: number;
  signal?: AbortSignal;
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

function directPresentation(parcel: AccountParcelDto): AccountParcelDto | null {
  const platformOnly = platformLabelOnly(parcel);
  const rawCode = parcel.rawCourierCode
    ? resolveCarrierCpCode(parcel.rawCourierCode)
    : null;
  if (
    !rawCode && parcel.carrierNormalization?.isBuiltIn &&
    !(platformOnly && parcel.carrierNormalization.standardCode === "JD")
  ) return parcel;
  const code = rawCode || resolveCarrierQuery(parcel.courierCode);
  const name = builtInCarrierPresentation(parcel.companyName);
  const carrier = code || (name ? resolveCarrierQuery(name.courierCode) : null);
  if (!carrier) return null;
  if (platformOnly && carrier.standardCode === "JD") return null;
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
  return carrier?.isBuiltIn
    ? {
        ...parcel,
        courierCode: carrier.standardCode,
        companyName: carrier.displayName,
        carrierNormalization: carrier,
      }
    : parcel;
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
    { deadlineAtMs: options.deadlineAtMs, signal: options.signal },
  );
  return applyRecognition(parcel, recognition);
}

export const normalizeNonSyncAccountParcel = normalizeAccountParcelCarrier;

/**
 * An already projected account order whose carrier is still the JD order label (or empty) while
 * its carrier waybill is not a JD number carries a leaked order-stage carrier: recognise the real
 * carrier from the waybill once and repair the identity.
 */
export function needsProjectedCarrierRepair(
  identity: Pick<ShipmentIdentity, "accountOrder" | "manuallyAdded" | "projectedWaybill" | "courierCode">,
): boolean {
  if (!identity.accountOrder || identity.manuallyAdded) return false;
  const projected = normalizeWaybill(identity.projectedWaybill || "");
  if (!projected || /^JD/i.test(projected)) return false;
  const code = normalizeCarrierCode(identity.courierCode || "");
  if (!code) return true;
  const record = resolveCarrierQuery(code) || resolveCarrierCpCode(code);
  return record?.standardCode === "JD";
}

export function repairProjectedShipmentCarrier(
  shipment: Shipment,
  normalization: CarrierNormalization | null | undefined,
): Shipment {
  if (!normalization?.isBuiltIn || !needsProjectedCarrierRepair(shipment.identity)) return shipment;
  const code = normalizeCarrierCode(normalization.standardCode);
  if (!code || code === "JD" || code === normalizeCarrierCode(shipment.identity.courierCode || "")) {
    return shipment;
  }
  const projected = normalizeWaybill(shipment.identity.projectedWaybill || "");
  const presentation = projectedCarrierPresentation(projected, code, normalization.displayName);
  const carrier = {
    courierCode: presentation.courierCode || code,
    companyName: presentation.companyName || normalization.displayName,
    rawCourierCode: "",
    carrierIsBuiltIn: true,
    carrierKuaidi100Code: normalization.kuaidi100Code,
    carrierTableVersion: normalization.tableVersion,
  };
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
