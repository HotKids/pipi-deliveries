import type { ParcelHandoffRecord, PickupArtworkChoice, PickupArtworkChoices, PickupCodeRecord, PickupPlatform, Shipment } from "../models";
import { carrierDisplayName, courierIconName } from "./carrier-presentation";
import { parcelArtworkCarrierUnmatched } from "./carrier-gate";
import { displayWaybill, unprojectedAccountOrder } from "./shipment-policy";
import { normalizeWaybill, shipmentPresentationStatus, waybillSuffix } from "./status";
import { cleanString } from "./value-guards";
import { formatListTime } from "./time-presentation";
import { parcelHandoffDeadline } from "./parcel-handoff-expiry";
import type { PickupVisualStyle } from "./meal/pickup-artwork";
import type { ParcelLookup } from "./parcel-code-ocr";

export const PICKUP_TAB_TITLE = "待取";

export const PLATFORM_ACCOUNT_NAMES = {
  cainiao: "菜鸟",
  pinduoduo: "拼多多",
  fengchao: "丰巢",
} as const satisfies Record<PickupPlatform, string>;

export type ParcelActivityTarget = Readonly<{
  shipmentId: string;
  waybill: string;
  waybillGeneration: number;
}> | Readonly<{ recordId: string }> | Readonly<{ mealId: string; mealScope: string }>;

export type ParcelActivityContent = Readonly<{
  target?: ParcelActivityTarget;
  platform?: PickupPlatform;
  carrierIcon?: string;
  artworkChoice?: PickupArtworkChoice;
  artworkSwitchable?: true;
  kind?: "handoff" | "meal";
  mealStyle?: PickupVisualStyle;
  mealBrandId?: string;
  /** The compact Dynamic Island text from Pipi's meal capsule rule. */
  mealCompactCode?: string;
  hasMealQR?: boolean;
  businessDateKey?: string;
  capturedAtMs?: number;
  expiresAtMs?: number;
  title: string;
  location: string;
  address?: string;
  code: string;
}>;

export function parcelCardKey({ target }: Pick<ParcelActivityContent, "target">): string {
  return target ? "mealId" in target ? `meal:${target.mealScope}:${target.mealId}` :
    "recordId" in target ? "record:" + target.recordId :
      JSON.stringify([target.shipmentId, target.waybill, target.waybillGeneration]) : "";
}

const STATION_ARTWORK: readonly PickupArtworkChoice[] = ["cainiao", "pinduoduo", "fengchao"];
const HANDOFF_ARTWORK: readonly PickupArtworkChoice[] = ["cainiao", "jingdong", "douyin", "pinduoduo"];

function artworkOrder(card: ParcelActivityContent) {
  return card.kind === "handoff" ? HANDOFF_ARTWORK : STATION_ARTWORK;
}

export function withPickupArtwork(card: ParcelActivityContent, choices?: PickupArtworkChoices): ParcelActivityContent {
  const choice = card.artworkSwitchable ? choices?.[parcelCardKey(card)] : undefined;
  return choice && artworkOrder(card).includes(choice) ? { ...card, artworkChoice: choice } : card;
}

export function nextPickupArtwork(card: ParcelActivityContent): PickupArtworkChoice | undefined {
  if (!card.artworkSwitchable || card.kind === "meal") return undefined;
  const order = artworkOrder(card);
  const displayed = card.artworkChoice ?? card.platform;
  return order[((displayed ? order.indexOf(displayed) : -1) + 1) % order.length];
}

export function shipmentForPickupTarget(
  shipments: readonly Shipment[], target: ParcelActivityTarget | undefined,
): Shipment | undefined {
  if (!target || !("shipmentId" in target)) return undefined;
  return shipments.find((shipment) => shipment.identity.id === target.shipmentId &&
    displayWaybill(shipment) === target.waybill && (shipment.waybillReuseAtMs ?? 0) === target.waybillGeneration);
}

export const PARCEL_ACTIVITY_PREVIEW = {
  platform: "pinduoduo",
  title: "派派的猫罐头",
  location: "旺旺多多驿站",
  code: "1-2-3456",
} as const satisfies ParcelActivityContent;

export function pickupDateSections(
  cards: readonly ParcelActivityContent[], previewing: boolean, focusedRecordId: string, now = new Date(),
) {
  const today = [String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const sections = new Map<string, ParcelActivityContent[]>();
  let focusedDay = "";
  if (previewing) sections.set(today, []);
  for (const card of cards) {
    // Pipi Home dates receiving cards today and handoffs by the appointment's business day.
    const day = card.businessDateKey || today;
    const group = sections.get(day) ?? [];
    const target = card.target;
    const recordId = target && ("recordId" in target ? target.recordId : "mealId" in target ? target.mealId : "");
    if (recordId && recordId === focusedRecordId) {
      focusedDay = day;
      group.unshift(card);
    } else {
      group.push(card);
    }
    sections.set(day, group);
  }
  return [...sections].sort(([a], [b]) => a === focusedDay ? -1 : b === focusedDay ? 1 : a.localeCompare(b))
    .map(([key, items]) => {
      const day = new Date(key + "T00:00:00Z");
      const weekday = "日一二三四五六"[day.getUTCDay()];
      return {
        key, items, preview: previewing && key === today,
        label: `${day.getUTCFullYear()}年${day.getUTCMonth() + 1}月${day.getUTCDate()}日 周${weekday}`,
      };
    });
}

export function parcelPickupShortCode(code: string): string {
  const value = code.trim();
  return Array.from(value).length <= 8 ? value : value.replace(/[^\p{L}\p{N}]/gu, "") || value;
}

/**
 * A meal's text beside the brand mark in the compact Dynamic Island. It mirrors
 * Pipi's status-bar capsule (`PickupNotificationRenderer.capsule` in the Android
 * app): the trimmed text code, only its leading number for Starbucks, and for a
 * Chayan Yuese card without a text code the product name when it has fewer than
 * five characters, otherwise the brand. A card without a text code, such as a
 * QR-only Luckin card, shows 待取餐 (owner, 2026-11-21: "pipi 也显示待取餐").
 * Like Pipi it does not pre-truncate the phrase; the system owns the width. The
 * card, expanded island and copy keep the full code.
 */
export function mealCompactCode(
  { brandId, code, productName }: Readonly<{ brandId?: string; code?: string; productName?: string }>,
): string {
  const value = (code ?? "").trim();
  if (brandId === "chayanyuese" && !value) {
    const product = (productName ?? "").trim();
    return product && Array.from(product).length < 5 ? product : "茶颜悦色";
  }
  if (!value) return "待取餐";
  if (brandId !== "xingbake") return value;
  return value.match(/^\p{Nd}+/u)?.[0] ?? value;
}

/**
 * Text beside the brand mark in the compact Dynamic Island, the counterpart of
 * Pipi's status-bar capsule. A meal uses its saved capsule text; an activity
 * published before that field existed, or with it empty, applies the same rule
 * to its code.
 * Parcels and handoffs keep the eight-character short code.
 */
export function parcelActivityCompactText(
  data: Pick<ParcelActivityContent, "kind" | "code" | "title" | "mealBrandId" | "mealCompactCode">,
): string {
  if (data.kind === "meal") {
    const trimmedCode = data.code.trim();
    const code = trimmedCode === "待核销" ? "" : trimmedCode;
    const savedCompact = data.mealCompactCode?.trim();
    return savedCompact || mealCompactCode({ brandId: data.mealBrandId, code, productName: data.title });
  }
  const code = parcelPickupShortCode(data.code);
  return code && Array.from(code).length <= 8 ? code : data.kind === "handoff" ? "待寄件" : "待取件";
}

export function parcelPickupSubtitle(card: ParcelActivityContent, location = card.location, showingAddress = false) {
  if (card.kind === "handoff") return { text: location, symbol: "calendar.circle.fill" };
  if (!location) {
    return {
      text: card.kind === "meal" ? "请及时取餐" : "请及时取件",
      symbol: card.kind === "meal" ? "fork.knife" : "doc.text.fill",
    };
  }
  return { text: location, symbol: showingAddress || location === card.address ? "mappin.circle.fill" : "house.fill" };
}

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
    : cleanString(handoff.windowText) || start.slice(5);
  const expiresAtMs = parcelHandoffDeadline(handoff);
  return {
    kind: "handoff",
    ...(start ? { businessDateKey: start.slice(0, 10) } : {}),
    target: handoff.id ? { recordId: handoff.id } : undefined,
    platform: handoff.platform,
    capturedAtMs: handoff.capturedAtMs,
    expiresAtMs,
    ...(handoff.platform !== "cainiao" && (expiresAtMs === undefined || expiresAtMs > Date.now())
      ? { artworkSwitchable: true as const } : {}),
    title: cleanString(handoff.note) || cleanString(handoff.providerTitle) || "寄件码",
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
    title: cleanString(record.note) || (record.platform === "cainiao" ? "菜鸟驿站" :
      record.platform === "pinduoduo" ? "多多驿站" : "丰巢快递柜"),
    location: cleanString(record.locationName) || cleanString(record.address),
    ...(record.address ? { address: cleanString(record.address) } : {}),
    code,
  };
}

export function activePickupCards(
  shipments: readonly Shipment[],
  independent: readonly PickupCodeRecord[] = [],
  choices?: PickupArtworkChoices,
): ParcelActivityContent[] {
  const cards = [
    ...shipments.map(parcelActivityContent),
    ...independent.map(independentPickupContent),
  ].filter((card): card is ParcelActivityContent => card != null);
  return choices ? cards.map(card => withPickupArtwork(card, choices)) : cards;
}

export function parcelActivityContent(shipment: Shipment): ParcelActivityContent | null {
  const pickup = shipment.pickup;
  const code = cleanString(pickup?.code);
  const semantic = shipmentPresentationStatus(shipment).semantic;
  if (!pickup || (pickup.platform && !Object.prototype.hasOwnProperty.call(PLATFORM_ACCOUNT_NAMES, pickup.platform)) ||
    !code || /[\u0000-\u001f\u007f]/.test(code) ||
    !Number.isSafeInteger(pickup.capturedAtMs) || pickup.capturedAtMs <= 0 ||
    unprojectedAccountOrder(shipment) || shipment.identity.sender || shipment.forcedCompletedAtMs || pickup.completedAtMs ||
    (semantic !== "WAITING_PICKUP" && semantic !== "DELIVERY")) {
    return null;
  }
  const waybill = normalizeWaybill(cleanString(pickup.waybill));
  const waybillGeneration = shipment.waybillReuseAtMs ?? 0;
  if (!waybill || waybill !== displayWaybill(shipment) || pickup.waybillGeneration !== waybillGeneration) {
    return null;
  }
  const carrier = carrierDisplayName(shipment.identity.companyName);
  const unknownCarrier = parcelArtworkCarrierUnmatched(shipment);
  const carrierIcon = unknownCarrier ? "default" : courierIconName(shipment.identity.courierCode, shipment.identity.companyName);
  return {
    target: { shipmentId: shipment.identity.id, waybill, waybillGeneration },
    platform: pickup.platform,
    ...(unknownCarrier && !pickup.platform ? { artworkSwitchable: true as const } : {}),
    ...(carrierIcon !== "default" ? { carrierIcon } : {}),
    capturedAtMs: pickup.capturedAtMs,
    title: cleanString(shipment.note) || `${carrier} ${waybillSuffix(waybill)}`,
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
  if (previous && (previous.completedAtMs || previous.capturedAtMs >= lookup.capturedAtMs)) return shipment;
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
