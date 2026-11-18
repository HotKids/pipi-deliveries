import type { AppState, ParcelPlatformFields, PddCloudOrigin, Shipment } from "../models";
import { projectedCarrierPresentation } from "./carrier-presentation";
import { pendingManualPreviewShipment } from "./manual-preview";
import { shipmentLifecycleKey } from "./shipment-lifecycle";
import { displayWaybill, unprojectedAccountOrder } from "./shipment-policy";
import { normalizeWaybill, shipmentPresentationStatus } from "./status";
import { matchesParcelMetadataLifecycle } from "./waybill-reuse";
import { displayDeliveryEstimate, pddParcelUniversalURL, type PlatformParcel } from "./platform-parcel-data";

export function eligiblePickup(shipment: Shipment): boolean {
  return !shipment.forcedCompletedAtMs && !shipment.identity.sender &&
    shipmentPresentationStatus(shipment).semantic === "WAITING_PICKUP";
}

export function deliveryEstimateApplies(shipment: Shipment): boolean {
  return ["PICKED", "TRANSIT", "DELIVERY"].includes(shipmentPresentationStatus(shipment).semantic);
}

function orderMatches(shipment: Shipment, parcel: PlatformParcel, owner: string): boolean {
  const ids = parcel.orderIds || [];
  if (parcel.source === "pinduoduo") {
    return shipment.pddImport?.ownerKey === owner && ids.includes(shipment.pddImport.orderId);
  }
  const provider = shipment.identity.sourceProvider?.toLowerCase() || "";
  if (parcel.source === "cainiao" && !["cainiao", "taobao"].includes(provider) ||
      parcel.source === "jingdong" && provider !== "jingdong" ||
      parcel.source === "fengchao") return false;
  return shipment.identity.accountOrder === true &&
    ids.includes(shipment.identity.orderId || shipment.identity.sourceId);
}

export function matchPlatformParcel(
  visible: readonly Shipment[], parcel: PlatformParcel, owner: string,
): Shipment | undefined {
  const waybillMatches = parcel.waybill ? visible.filter((shipment) =>
    !unprojectedAccountOrder(shipment) && displayWaybill(shipment) === parcel.waybill) : [];
  if (waybillMatches.length) return waybillMatches.length === 1 ? waybillMatches[0] : undefined;
  const associated = visible.filter((shipment) => orderMatches(shipment, parcel, owner));
  if (associated.length !== 1) return undefined;
  const match = associated[0];
  if (parcel.waybill && !unprojectedAccountOrder(match) && parcel.waybill !== displayWaybill(match)) return undefined;
  return match;
}

export function samePlatformTarget(before: Shipment | undefined, after: Shipment): boolean {
  return !!before && shipmentLifecycleKey(before) === shipmentLifecycleKey(after) &&
    displayWaybill(before) === displayWaybill(after);
}

function sameFields(shipment: Shipment, fields: ParcelPlatformFields): boolean {
  const bill = unprojectedAccountOrder(shipment) ? "" : displayWaybill(shipment);
  return fields.waybillGeneration === (shipment.waybillReuseAtMs ?? 0) && fields.waybill === bill;
}

export function keepPlatformFields(previous: Shipment | undefined, current: Shipment): Shipment {
  if (!previous || (!previous.platformFields && !previous.pddImport && !previous.pddCloudOrigin) ||
      shipmentLifecycleKey(previous) !== shipmentLifecycleKey(current)) return current;
  const fields = previous.platformFields;
  const retained = fields && (sameFields(current, fields) ||
    !fields.waybill && !!current.identity.projectedWaybill && previous.identity.accountOrder)
    ? { ...fields, waybill: current.identity.projectedWaybill ? displayWaybill(current) : fields.waybill } : undefined;
  let platformFields = current.platformFields ?? retained;
  if (platformFields && retained && sameFields(current, platformFields) &&
      (retained.manualTitleEditedAtMs ?? 0) > (platformFields.manualTitleEditedAtMs ?? 0)) {
    platformFields = {
      ...platformFields,
      manualTitle: retained.manualTitle,
      manualTitleEditedAtMs: retained.manualTitleEditedAtMs,
    };
  }
  return {
    ...current,
    platformFields,
    pddImport: current.pddImport || previous.pddImport,
    pddCloudOrigin: currentPddCloudOrigin(current, current.pddCloudOrigin ?? previous.pddCloudOrigin),
  };
}

function currentPddCloudOrigin(shipment: Shipment, origin: PddCloudOrigin | undefined): PddCloudOrigin | undefined {
  return origin && origin.waybill === normalizeWaybill(displayWaybill(shipment)) &&
    origin.waybillGeneration === (shipment.waybillReuseAtMs ?? 0) ? origin : undefined;
}

export function hasPddParcelSource(shipment: Shipment): boolean {
  return Boolean(shipment.pddImport || currentPddCloudOrigin(shipment, shipment.pddCloudOrigin));
}

export type CloudPddParcel = Readonly<{
  waybill: string;
  anchorAt: number;
  terminalAt: number;
  carrierCode: string;
  phone4: string;
}>;

export function applyCloudPddParcels(state: AppState, parcels: readonly CloudPddParcel[], now: number): AppState {
  const incoming = new Map<string, CloudPddParcel | null>();
  for (const parcel of parcels) incoming.set(parcel.waybill, incoming.has(parcel.waybill) ? null : parcel);
  const local = new Map<string, Shipment[]>();
  for (const shipment of state.shipments) {
    if (unprojectedAccountOrder(shipment)) continue;
    const waybill = normalizeWaybill(displayWaybill(shipment));
    if (!incoming.get(waybill)) continue;
    const sameNumber = local.get(waybill) || [];
    sameNumber.push(shipment);
    local.set(waybill, sameNumber);
  }
  const pending = new Set(state.pendingQueries.map(query => normalizeWaybill(query.waybill)));
  const changes = new Map<string, Shipment>();
  for (const [waybill, parcel] of incoming) {
    if (!parcel) continue;
    const existing = local.get(waybill) || [];
    if (existing.length > 1) continue;
    const current = existing[0];
    if (current) {
      const { identity } = current;
      const genericSource = identity.manuallyAdded || identity.sourceProvider?.toLowerCase() === "kuaidi100";
      if (!genericSource || identity.sender || identity.accountOrder || hasPddParcelSource(current) ||
        !matchesParcelMetadataLifecycle(current, parcel.anchorAt, parcel.terminalAt, now)) continue;
      changes.set(identity.id, { ...current, pddCloudOrigin: { waybill, waybillGeneration: current.waybillReuseAtMs ?? 0 } });
      continue;
    }
    if (pending.has(waybill)) continue;
    const carrier = projectedCarrierPresentation(waybill, parcel.carrierCode, "");
    const shipment = pendingManualPreviewShipment({ id: `${state.activeSource}:${waybill}`, source: state.activeSource,
      waybill, phoneTail: parcel.phone4, ...carrier, rawCourierCode: parcel.carrierCode,
      createdAtMs: now, lastAttemptAtMs: now, attempts: 0 });
    changes.set(shipment.identity.id, { ...shipment, pddCloudOrigin: { waybill, waybillGeneration: 0 } });
  }
  if (!changes.size) return state;
  const shipments = new Map(state.shipments.map(shipment => [shipment.identity.id, shipment]));
  for (const [id, shipment] of changes) shipments.set(id, shipment);
  return { ...state, shipments: [...shipments.values()] };
}

export type CloudParcelMetadata = Readonly<{
  waybill: string;
  anchorAt: number;
  terminalAt?: number;
  productName?: string;
  deliveryEstimate?: string;
  deliveryEstimateObservedAt?: number;
}>;

export type CloudParcelPddLink = Pick<CloudParcelMetadata, "waybill" | "anchorAt" | "terminalAt"> & Readonly<{
  shippingId: string;
}>;

export function cloudPddParcelAppURL(shipment: Shipment, link: CloudParcelPddLink | undefined, now = Date.now()): string {
  if (!link || unprojectedAccountOrder(shipment)) return "";
  const waybill = normalizeWaybill(displayWaybill(shipment));
  if (link.waybill !== waybill || !matchesParcelMetadataLifecycle(shipment, link.anchorAt, link.terminalAt ?? 0, now)) return "";
  return pddParcelUniversalURL(link.shippingId, waybill);
}

export function displayedPlatformFields(shipment: Shipment, now = Date.now(), cloud?: CloudParcelMetadata) {
  const saved = shipment.platformFields && sameFields(shipment, shipment.platformFields) ? shipment.platformFields : undefined;
  const matchingCloud = cloud && !unprojectedAccountOrder(shipment) &&
    cloud.waybill === normalizeWaybill(displayWaybill(shipment)) &&
    matchesParcelMetadataLifecycle(shipment, cloud.anchorAt, cloud.terminalAt ?? 0, now) ? cloud : undefined;
  if (!saved && !matchingCloud) return {};
  const estimate = saved?.estimate;
  const inTransit = deliveryEstimateApplies(shipment);
  const localEstimate = estimate && inTransit ? displayDeliveryEstimate(estimate.text, estimate.capturedAtMs, now) : "";
  const cloudEstimate = inTransit && matchingCloud?.deliveryEstimate && !matchingCloud.terminalAt
    ? displayDeliveryEstimate(matchingCloud.deliveryEstimate, matchingCloud.deliveryEstimateObservedAt ?? 0, now) : "";
  return {
    title: saved?.manualTitle || saved?.title?.text || matchingCloud?.productName,
    estimate: localEstimate || cloudEstimate,
  };
}

export function enrichPlatformParcel(shipment: Shipment, parcel: PlatformParcel, now: number): Shipment {
  let next = shipment;
  if (unprojectedAccountOrder(next) && parcel.source === "cainiao" &&
    eligiblePickup(next) && parcel.waybill) {
    const carrier = projectedCarrierPresentation(parcel.waybill, parcel.carrierCode || "", parcel.carrierName || "");
    if (carrier.companyName) {
      const timeline = { ...next.timeline, waybill: parcel.waybill, ...carrier };
      next = {
        ...next,
        identity: { ...next.identity, ...carrier, projectedWaybill: parcel.waybill, hadRealWaybill: true },
        timeline,
        sourceTimeline: next.sourceTimeline ? { ...next.sourceTimeline, waybill: parcel.waybill, ...carrier } : next.sourceTimeline,
        occupiedAtMs: now,
      };
    }
  }
  const waybill = unprojectedAccountOrder(next) ? "" : displayWaybill(next);
  const waybillGeneration = next.waybillReuseAtMs ?? 0;
  if (parcel.source !== "fengchao" && (parcel.title || parcel.estimate)) {
    const fields = next.platformFields && (sameFields(next, next.platformFields) || next !== shipment)
      ? next.platformFields : undefined;
    const prefer = (source: string) => source === parcel.source || parcel.source === "cainiao";
    const title = parcel.title && (!fields?.title || prefer(fields.title.source))
      ? { text: parcel.title, source: parcel.source } : fields?.title;
    const estimate = parcel.estimate && (!fields?.estimate || prefer(fields.estimate.source))
      ? {
        text: parcel.estimate, source: parcel.source,
        capturedAtMs: fields?.estimate?.text === parcel.estimate ? fields.estimate.capturedAtMs : now,
      } : fields?.estimate;
    const platformFields = { ...fields, waybill, waybillGeneration, title, estimate };
    if (JSON.stringify(platformFields) !== JSON.stringify(fields) || waybill !== fields?.waybill) {
      next = { ...next, platformFields };
    }
  }
  if (!waybill || !eligiblePickup(next)) return next;
  const previous = next.pickup?.waybill === waybill && next.pickup.waybillGeneration === waybillGeneration
    ? next.pickup : undefined;
  const platform = parcel.source === "jingdong" ? undefined : parcel.source;
  const conflictingCode = previous?.code && parcel.code && previous.code !== parcel.code &&
    (!previous.platform || previous.platform !== platform);
  if (conflictingCode || (!previous?.code && !parcel.code)) return next;
  const sourceMatches = !previous?.platform || previous.platform === platform;
  const code = parcel.code || previous!.code;
  const pickup = {
    code, waybill, waybillGeneration,
    platform: previous?.platform || (parcel.code ? platform : undefined),
    capturedAtMs: previous?.code === code ? previous.capturedAtMs : now,
    locationName: sourceMatches ? (parcel.name || previous?.locationName) : previous?.locationName,
    address: sourceMatches ? (parcel.address || previous?.address) : previous?.address,
  };
  return JSON.stringify(pickup) === JSON.stringify(previous) ? next : { ...next, pickup };
}
