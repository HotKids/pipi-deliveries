import type { ParcelHandoffRecord, PickupCodeRecord, PickupPlatform, Shipment } from "../models";
import { displayWaybill, unprojectedAccountOrder } from "./shipment-policy";
import { normalizeWaybill, shipmentPresentationStatus } from "./status";
import { cleanString } from "./value-guards";
import { formatListTime } from "./time-presentation";
import { parcelHandoffDeadline } from "./parcel-handoff-expiry";
import type { ParcelLookup } from "./parcel-code-ocr";

export const PLATFORM_ACCOUNT_NAMES = {
  cainiao: "菜鸟",
  pinduoduo: "拼多多",
  fengchao: "丰巢",
} as const satisfies Record<PickupPlatform, string>;

export type ParcelActivityTarget = Readonly<{
  shipmentId: string;
  waybill: string;
  waybillGeneration: number;
}> | Readonly<{ recordId: string }>;

export type ParcelActivityContent = Readonly<{
  target?: ParcelActivityTarget;
  platform?: PickupPlatform;
  kind?: "handoff";
  capturedAtMs?: number;
  expiresAtMs?: number;
  title: string;
  location: string;
  address?: string;
  code: string;
}>;

export function shipmentForPickupTarget(
  shipments: readonly Shipment[], target: ParcelActivityTarget | undefined,
): Shipment | undefined {
  if (!target || !("shipmentId" in target)) return undefined;
  return shipments.find((shipment) => shipment.identity.id === target.shipmentId &&
    displayWaybill(shipment) === target.waybill && (shipment.waybillReuseAtMs ?? 0) === target.waybillGeneration);
}

export const PARCEL_ACTIVITY_PREVIEW: ParcelActivityContent = {
  platform: "cainiao",
  title: "取件码示例",
  location: "菜鸟驿站",
  code: "1-2-3456",
};

function appointmentPart(value: number | undefined): string {
  if (!value || value <= 0) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatListTime(date.toISOString()) : "";
}

export function handoffActivityContent(handoff: ParcelHandoffRecord): ParcelActivityContent | null {
  const code = cleanString(handoff.code);
  if (!code || /[\u0000-\u001f\u007f]/.test(code) ||
    (handoff.platform !== "cainiao" && handoff.platform !== "pinduoduo") ||
    !Number.isSafeInteger(handoff.capturedAtMs) || handoff.capturedAtMs <= 0 ||
    handoff.completedAtMs || handoff.expiredAtMs) {
    return null;
  }
  const startAt = handoff.windowStartAtMs ?? 0;
  const endAt = handoff.windowEndAtMs ?? 0;
  const start = appointmentPart(startAt);
  const end = appointmentPart(endAt);
  const validEnd = end && startAt <= endAt;
  const appointment = start && validEnd
    ? start.slice(5) + "–" + (start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end.slice(5))
    : cleanString(handoff.windowText);
  return {
    kind: "handoff",
    target: handoff.id ? { recordId: handoff.id } : undefined,
    platform: handoff.platform,
    capturedAtMs: handoff.capturedAtMs,
    expiresAtMs: parcelHandoffDeadline(handoff),
    title: "寄件码",
    location: appointment ? appointment + " 上门" : "",
    code,
  };
}

export function independentPickupContent(record: PickupCodeRecord): ParcelActivityContent | null {
  if (!record || !cleanString(record.id) || record.completedAtMs ||
    !Object.prototype.hasOwnProperty.call(PLATFORM_ACCOUNT_NAMES, record.platform)) return null;
  if (record.kind === "handoff") return handoffActivityContent(record);
  const code = cleanString(record.code);
  if (record.kind !== "pickup" || !code || /[\u0000-\u001f\u007f]/.test(code) ||
    !Number.isSafeInteger(record.capturedAtMs) || record.capturedAtMs <= 0) return null;
  return {
    target: { recordId: record.id },
    platform: record.platform,
    capturedAtMs: record.capturedAtMs,
    title: record.platform === "cainiao" ? "菜鸟驿站" :
      record.platform === "pinduoduo" ? "多多驿站" : "丰巢快递柜",
    location: cleanString(record.locationName) || cleanString(record.address),
    ...(record.address ? { address: cleanString(record.address) } : {}),
    code,
  };
}

export function activePickupCards(
  shipments: readonly Shipment[],
  independent: readonly PickupCodeRecord[] = [],
): ParcelActivityContent[] {
  return [
    ...shipments.map(parcelActivityContent),
    ...independent.map(independentPickupContent),
  ].filter((card): card is ParcelActivityContent => card != null);
}

export function parcelActivityContent(shipment: Shipment): ParcelActivityContent | null {
  const pickup = shipment.pickup;
  const code = cleanString(pickup?.code);
  if (!pickup || (pickup.platform && !Object.prototype.hasOwnProperty.call(PLATFORM_ACCOUNT_NAMES, pickup.platform)) ||
    !code || /[\u0000-\u001f\u007f]/.test(code) ||
    !Number.isSafeInteger(pickup.capturedAtMs) || pickup.capturedAtMs <= 0 ||
    unprojectedAccountOrder(shipment) || shipment.forcedCompletedAtMs ||
    shipmentPresentationStatus(shipment).semantic !== "WAITING_PICKUP") {
    return null;
  }
  const waybill = normalizeWaybill(cleanString(pickup.waybill));
  const waybillGeneration = shipment.waybillReuseAtMs ?? 0;
  if (!waybill || waybill !== displayWaybill(shipment) || pickup.waybillGeneration !== waybillGeneration) {
    return null;
  }
  return {
    target: { shipmentId: shipment.identity.id, waybill, waybillGeneration },
    platform: pickup.platform,
    capturedAtMs: pickup.capturedAtMs,
    title: shipment.identity.companyName || (pickup.platform ? PLATFORM_ACCOUNT_NAMES[pickup.platform] : "取件码"),
    location: cleanString(pickup.locationName) || cleanString(pickup.address),
    ...(pickup.address ? { address: cleanString(pickup.address) } : {}),
    code,
  };
}

export function applyRecognizedPickup(shipment: Shipment, lookup: ParcelLookup): Shipment {
  const generation = shipment.waybillReuseAtMs ?? 0;
  const waybill = normalizeWaybill(lookup.waybill);
  const status = shipmentPresentationStatus(shipment).semantic;
  if (!lookup.pickup || !waybill || waybill !== displayWaybill(shipment) || unprojectedAccountOrder(shipment) ||
      lookup.capturedAtMs < generation || shipment.forcedCompletedAtMs ||
      status === "COMPLETED" || status === "CANCELLED") return shipment;
  const previous = shipment.pickup?.waybillGeneration === generation && shipment.pickup.waybill === waybill
    ? shipment.pickup : undefined;
  if (previous && previous.capturedAtMs >= lookup.capturedAtMs) return shipment;
  const sameCode = previous?.code === lookup.pickup.code;
  return {
    ...shipment,
    pickup: {
      waybill, waybillGeneration: generation, capturedAtMs: lookup.capturedAtMs, code: lookup.pickup.code,
      platform: sameCode ? previous?.platform : undefined,
      locationName: lookup.pickup.locationName || (sameCode ? previous?.locationName : undefined),
      address: sameCode ? previous?.address : undefined,
    },
  };
}
