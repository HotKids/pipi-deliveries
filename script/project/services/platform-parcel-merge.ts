import type { AppState, CloudPddParcelTombstone, ParcelPlatformFields, PddCloudOrigin, Shipment } from "../models";
import { projectedCarrierPresentation } from "./carrier-presentation";
import { pendingManualPreviewShipment } from "./manual-preview";
import { shipmentLifecycleKey } from "./shipment-lifecycle";
import { displayWaybill, selectShipmentTimeline, unprojectedAccountOrder } from "./shipment-policy";
import { mergeTimelineAuthorities, normalizeWaybill, shipmentPresentationStatus } from "./status";
import { matchesParcelMetadataLifecycle } from "./waybill-reuse";
import { displayDeliveryEstimate, pddParcelNativeAppURL, pddTimelineFromTraces, type PlatformParcel } from "./platform-parcel-data";
import { pddProductImageURL } from "./product-image-url";
import { internationalShipment } from "./international-records";
import { SCRIPT_BINDING_SOURCE } from "./script-source";

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
    !internationalShipment(shipment) && !unprojectedAccountOrder(shipment) && displayWaybill(shipment) === parcel.waybill) : [];
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

function pddProductAssociation(shipment: Shipment): string {
  const parcel = shipment.pddImport;
  return parcel?.orderId && parcel.shippingId ? JSON.stringify([parcel.ownerKey, parcel.orderId, parcel.shippingId]) : "";
}

export function pddParcelProductImage(shipment: Shipment): string {
  const fields = shipment.platformFields;
  const association = pddProductAssociation(shipment);
  return fields && sameFields(shipment, fields) && association && fields.pddImage?.association === association
    ? pddProductImageURL(fields.pddImage.url) : "";
}

export function keepPlatformFields(previous: Shipment | undefined, current: Shipment): Shipment {
  if (!previous || (!previous.platformFields && !previous.pddImport && !previous.pddCloudOrigin && !previous.cloudExpressOrigin) ||
      shipmentLifecycleKey(previous) !== shipmentLifecycleKey(current)) return current;
  const fields = previous.platformFields;
  const retained = fields && (sameFields(current, fields) ||
    !fields.waybill && !!current.identity.projectedWaybill && previous.identity.accountOrder)
    ? { ...fields, waybill: current.identity.projectedWaybill ? displayWaybill(current) : fields.waybill } : undefined;
  // R5-NEW-09 ②: a Watch row's fields come from its own snapshot. A snapshot without its estimate withdrew it, so only
  // the user's title edit is carried and the cloud parcel metadata's estimate can show again.
  const carried = retained && internationalShipment(current)
    ? retained.manualTitle != null || retained.manualTitleEditedAtMs != null || retained.cloudProductName != null
      ? { waybill: retained.waybill, waybillGeneration: retained.waybillGeneration,
          ...(retained.manualTitle != null ? { manualTitle: retained.manualTitle } : {}),
          ...(retained.manualTitleEditedAtMs != null ? { manualTitleEditedAtMs: retained.manualTitleEditedAtMs } : {}),
          ...(retained.cloudProductName != null ? { cloudProductName: retained.cloudProductName } : {}),
          ...(retained.cloudProductNameObservedAtMs != null ? { cloudProductNameObservedAtMs: retained.cloudProductNameObservedAtMs } : {}) }
      : undefined
    : retained;
  let platformFields = current.platformFields ?? carried;
  if (platformFields && retained && sameFields(current, platformFields) &&
      (retained.manualTitleEditedAtMs ?? 0) > (platformFields.manualTitleEditedAtMs ?? 0)) {
    platformFields = {
      ...platformFields,
      manualTitle: retained.manualTitle,
      manualTitleEditedAtMs: retained.manualTitleEditedAtMs,
    };
  }
  if (platformFields && retained && sameFields(current, platformFields) &&
      retained.cloudProductName &&
      (!platformFields.cloudProductName || (retained.cloudProductNameObservedAtMs ?? 0) > (platformFields.cloudProductNameObservedAtMs ?? 0))) {
    platformFields = {
      ...platformFields,
      cloudProductName: retained.cloudProductName,
      ...(retained.cloudProductNameObservedAtMs !== undefined
        ? { cloudProductNameObservedAtMs: retained.cloudProductNameObservedAtMs }
        : {}),
    };
  }
  const cloudExpressOrigin = currentPddCloudOrigin(current, current.cloudExpressOrigin ?? previous.cloudExpressOrigin);
  return {
    ...current,
    platformFields,
    pddImport: current.pddImport || previous.pddImport,
    pddCloudOrigin: currentPddCloudOrigin(current, current.pddCloudOrigin ?? previous.pddCloudOrigin),
    ...(cloudExpressOrigin ? { cloudExpressOrigin } : {}),
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
  /** A Pipi automatic row's PDD link: marks an existing same-lifecycle row and never imports one (C-03). */
  markOnly?: boolean;
}>;

type CloudPddParcelIdentity = Pick<CloudParcelMetadata, "waybill" | "anchorAt" | "terminalAt">;

function matchesCloudPddParcel(shipment: Shipment, parcel: CloudPddParcelIdentity, now: number): boolean {
  return !unprojectedAccountOrder(shipment) && parcel.waybill === normalizeWaybill(displayWaybill(shipment)) &&
    matchesParcelMetadataLifecycle(shipment, parcel.anchorAt, parcel.terminalAt ?? 0, now);
}

/**
 * The rows that can show a confirmed PDD source. On 2026-11-20 the owner asked for PDD to have the highest priority
 * (「pdd 图标这条把优先级提到最高」), so the order for one parcel is 「已确认 PDD > 自动来源 > 普通手动来源」. A manual or
 * generic Kuaidi100 row qualifies, as before, and so does an automatic account row of this script. Sender rows never
 * qualify, and neither do JingDong business sources (account orders and JingDong-sourced rows), because a PDD order never
 * produces JingDong evidence.
 */
export function acceptsPddParcelSource(shipment: Shipment): boolean {
  const { identity } = shipment;
  const provider = identity.sourceProvider?.toLowerCase() || "";
  const generic = identity.manuallyAdded || provider === "kuaidi100";
  const automatic = !identity.manuallyAdded && identity.bindingSource === SCRIPT_BINDING_SOURCE && provider !== "jingdong";
  return (generic || automatic) && !identity.sender && !identity.accountOrder;
}

export function adoptCloudPddParcelSource(shipment: Shipment, parcel: CloudPddParcelIdentity, now: number): Shipment {
  if (!acceptsPddParcelSource(shipment) || hasPddParcelSource(shipment) ||
      !matchesCloudPddParcel(shipment, parcel, now)) return shipment;
  return { ...shipment, pddCloudOrigin: { waybill: parcel.waybill, waybillGeneration: shipment.waybillReuseAtMs ?? 0 } };
}

/**
 * Keeps the PDD source when an account row takes over a manual row of the same parcel, under the same 2026-11-20
 * priority. The survivor takes the manual row's confirmed PDD source (its local import and cloud origin)
 * with the PDD product name and image. The detail page then keeps the PDD source, its exact parcel page and the linked
 * product. The automatic source keeps its status, timeline and pickup data.
 *
 * The caller has already decided that the two rows are one parcel and not a reused waybill. The survivor's own values
 * are never replaced. A sender row or a JingDong business source never takes the source. `stored` is the survivor's
 * saved row; its platform fields count as the survivor's own, as storage keeps them (`keepPlatformFields`).
 */
export function withAbsorbedPddParcelSource(survivor: Shipment, absorbed: Shipment, stored?: Shipment): Shipment {
  if (absorbed.identity.sender || !hasPddParcelSource(absorbed) || !acceptsPddParcelSource(survivor)) return survivor;
  const waybill = normalizeWaybill(displayWaybill(survivor));
  if (!waybill || waybill !== normalizeWaybill(displayWaybill(absorbed))) return survivor;
  const target = keepPlatformFields(stored, survivor);
  const generation = target.waybillReuseAtMs ?? 0;
  const pddImport = target.pddImport || absorbed.pddImport;
  const pddCloudOrigin = currentPddCloudOrigin(target, target.pddCloudOrigin) ||
    (currentPddCloudOrigin(absorbed, absorbed.pddCloudOrigin) ? { waybill, waybillGeneration: generation } : undefined);
  const own = target.platformFields && sameFields(target, target.platformFields) ? target.platformFields : undefined;
  const carried = absorbed.platformFields && sameFields(absorbed, absorbed.platformFields)
    ? absorbed.platformFields : undefined;
  const association = pddImport ? pddProductAssociation({ ...target, pddImport }) : "";
  const title = !own?.title && carried?.title?.source === "pinduoduo" ? carried.title : undefined;
  const named = !own?.manualTitle && carried?.manualTitle ? carried : undefined;
  const pddImage = !own?.pddImage && association && carried?.pddImage?.association === association
    ? carried.pddImage : undefined;
  const platformFields = title || named || pddImage ? {
    ...own,
    waybill: displayWaybill(target),
    waybillGeneration: generation,
    ...(title ? { title } : {}),
    ...(named ? { manualTitle: named.manualTitle } : {}),
    ...(named?.manualTitleEditedAtMs !== undefined ? { manualTitleEditedAtMs: named.manualTitleEditedAtMs } : {}),
    ...(pddImage ? { pddImage } : {}),
  } : undefined;
  return {
    ...target,
    ...(pddImport ? { pddImport } : {}),
    ...(pddCloudOrigin ? { pddCloudOrigin } : {}),
    ...(platformFields ? { platformFields } : {}),
  };
}

/**
 * Preserves pickup codes, manual `forcedCompletedAtMs`, user remarks, and non-PDD `platformFields` (`manualTitle`,
 * non-PDD `title`, `estimate`, `cainiaoImage`) when an automatic source takes over a manual row or an order row
 * attaches/projects on the same waybill generation (§8.6 #5). Never overwrites the survivor's own populated fields.
 */
export function withAbsorbedParcelFields(
  survivor: Shipment,
  absorbed: Shipment,
  stored?: Shipment,
  options: { skipPddSource?: boolean; skipNote?: boolean } = {},
): Shipment {
  if (absorbed.identity.sender) return survivor;
  const waybill = normalizeWaybill(displayWaybill(survivor));
  if (!waybill || waybill !== normalizeWaybill(displayWaybill(absorbed))) return survivor;
  let base = survivor;
  if (
    stored &&
    shipmentLifecycleKey(stored) === shipmentLifecycleKey(survivor) &&
    stored.platformFields &&
    sameFields(survivor, stored.platformFields) &&
    survivor.platformFields &&
    sameFields(survivor, survivor.platformFields)
  ) {
    base = {
      ...survivor,
      platformFields: {
        ...stored.platformFields,
        ...survivor.platformFields,
      },
    };
  }
  let target = keepPlatformFields(stored, base);
  if (!options.skipPddSource) {
    target = withAbsorbedPddParcelSource(target, absorbed, stored);
  }
  const generation = target.waybillReuseAtMs ?? 0;
  const absorbedGen = absorbed.waybillReuseAtMs ?? 0;

  let pickup = target.pickup;
  if (
    !pickup &&
    !target.identity.sender &&
    absorbed.pickup &&
    normalizeWaybill(absorbed.pickup.waybill) === waybill &&
    absorbed.pickup.waybillGeneration === absorbedGen
  ) {
    pickup = {
      ...absorbed.pickup,
      waybill: displayWaybill(target),
      waybillGeneration: generation,
    };
  }

  const forcedCompletedAtMs = target.forcedCompletedAtMs ?? absorbed.forcedCompletedAtMs;
  const settledAtMs = target.settledAtMs ??
    (forcedCompletedAtMs ? absorbed.settledAtMs ?? forcedCompletedAtMs : undefined);

  const own = target.platformFields && sameFields(target, target.platformFields) ? target.platformFields : undefined;
  const carried = absorbed.platformFields && sameFields(absorbed, absorbed.platformFields)
    ? absorbed.platformFields
    : undefined;
  let platformFields = own;
  if (carried) {
    const manualTitleNewer = carried.manualTitle !== undefined &&
      (!own?.manualTitle || (carried.manualTitleEditedAtMs ?? 0) > (own.manualTitleEditedAtMs ?? 0));
    const cloudTitleNewer = carried.cloudProductName !== undefined &&
      (!own?.cloudProductName || (carried.cloudProductNameObservedAtMs ?? 0) > (own.cloudProductNameObservedAtMs ?? 0));
    const nonPddTitle = !own?.title && carried.title && carried.title.source !== "pinduoduo"
      ? carried.title
      : undefined;
    const allowEstimate = carried.estimate &&
      (carried.estimate.source !== "pinduoduo" || (!options.skipPddSource && acceptsPddParcelSource(target)));
    const estimate = !own?.estimate && allowEstimate ? carried.estimate : undefined;
    const cainiaoImage = !own?.cainiaoImage && carried.cainiaoImage ? carried.cainiaoImage : undefined;
    if (manualTitleNewer || cloudTitleNewer || nonPddTitle || estimate || cainiaoImage) {
      platformFields = {
        ...own,
        waybill: displayWaybill(target),
        waybillGeneration: generation,
        ...(manualTitleNewer
          ? {
              manualTitle: carried.manualTitle,
              ...(carried.manualTitleEditedAtMs !== undefined
                ? { manualTitleEditedAtMs: carried.manualTitleEditedAtMs }
                : {}),
            }
          : {}),
        ...(cloudTitleNewer
          ? {
              cloudProductName: carried.cloudProductName,
              ...(carried.cloudProductNameObservedAtMs !== undefined
                ? { cloudProductNameObservedAtMs: carried.cloudProductNameObservedAtMs }
                : {}),
            }
          : {}),
        ...(nonPddTitle ? { title: nonPddTitle } : {}),
        ...(estimate ? { estimate } : {}),
        ...(cainiaoImage ? { cainiaoImage } : {}),
      };
    }
  }

  const absorbedNote = options.skipNote ? "" : String(absorbed.note || "").trim();
  const note = String(target.note || "").trim() || absorbedNote;

  let merged: Shipment = {
    ...target,
    ...(pickup ? { pickup } : {}),
    ...(forcedCompletedAtMs !== undefined ? { forcedCompletedAtMs } : {}),
    ...(settledAtMs !== undefined ? { settledAtMs } : {}),
    ...(platformFields ? { platformFields } : {}),
    ...(note ? { note } : {}),
  };
  if (forcedCompletedAtMs !== undefined && !target.forcedCompletedAtMs) {
    merged = { ...merged, timeline: selectShipmentTimeline(merged) };
  }
  return merged;
}

const CLOUD_PDD_TOMBSTONE_REUSE_GAP_MS = 24 * 3_600_000;

export function matchingCloudPddTombstone(
  tombstones: readonly CloudPddParcelTombstone[] | undefined,
  waybill: string,
  anchorAt: number,
  terminalAt = 0,
): CloudPddParcelTombstone | undefined {
  if (!tombstones?.length) return undefined;
  const canonical = normalizeWaybill(waybill);
  if (!canonical) return undefined;
  const matches = tombstones.filter((entry) => {
    if (normalizeWaybill(entry.waybill) !== canonical) return false;
    // A strictly later lifecycle on the reused waybill supersedes an earlier parcel's tombstone.
    if (anchorAt > 0 && entry.anchorAt > 0 && anchorAt >= Math.max(entry.anchorAt, entry.actedAtMs) + CLOUD_PDD_TOMBSTONE_REUSE_GAP_MS) {
      return false;
    }
    if (terminalAt > 0 && entry.anchorAt > 0 && terminalAt + CLOUD_PDD_TOMBSTONE_REUSE_GAP_MS <= entry.anchorAt) {
      return false;
    }
    return true;
  });
  if (!matches.length) return undefined;
  return matches.sort((left, right) => right.actedAtMs - left.actedAtMs)[0];
}

export function applyCloudPddParcels(state: AppState, parcels: readonly CloudPddParcel[], now: number): AppState {
  const incoming = new Map<string, CloudPddParcel | null>();
  for (const parcel of parcels) {
    if (!parcel.markOnly) incoming.set(parcel.waybill, incoming.has(parcel.waybill) ? null : parcel);
  }
  // Third external review C-03 (owner 2026-11-23): Pipi exports an automatic row's confirmed PDD source only as its
  // PDD link, so a link marks the waybill's sole same-lifecycle row here, as Pipi and the Bot adopt it. A waybill
  // that also has a PDD express record keeps the record's path; a link never adds a row.
  const marks = new Map<string, CloudPddParcel | null>();
  for (const parcel of parcels) {
    if (parcel.markOnly && !incoming.has(parcel.waybill)) {
      marks.set(parcel.waybill, marks.has(parcel.waybill) ? null : parcel);
    }
  }
  const local = new Map<string, Shipment[]>();
  for (const shipment of state.shipments) {
    if (unprojectedAccountOrder(shipment)) continue;
    const waybill = normalizeWaybill(displayWaybill(shipment));
    if (!incoming.get(waybill) && !marks.get(waybill)) continue;
    const sameNumber = local.get(waybill) || [];
    sameNumber.push(shipment);
    local.set(waybill, sameNumber);
  }
  const pending = new Set(state.pendingQueries.map(query => normalizeWaybill(query.waybill)));
  const changes = new Map<string, Shipment>();
  const tombstones = state.cloudPddTombstones;
  for (const [waybill, parcel] of incoming) {
    if (!parcel) continue;
    const tombstone = matchingCloudPddTombstone(tombstones, waybill, parcel.anchorAt, parcel.terminalAt);
    if (tombstone?.action === "deleted") continue;
    const existing = local.get(waybill) || [];
    if (existing.length > 1) continue;
    const current = existing[0];
    if (current) {
      let adopted = adoptCloudPddParcelSource(current, parcel, now);
      if (tombstone?.action === "completed" && adopted.identity.manuallyAdded && !adopted.forcedCompletedAtMs && matchesCloudPddParcel(adopted, parcel, now)) {
        adopted = {
          ...adopted,
          forcedCompletedAtMs: tombstone.actedAtMs,
          settledAtMs: tombstone.actedAtMs,
          timeline: { ...adopted.timeline, semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: tombstone.actedAtMs },
        };
      }
      if (adopted !== current) changes.set(current.identity.id, adopted);
      continue;
    }
    if (pending.has(waybill)) continue;
    const createdAtMs = parcel.anchorAt || now;
    // Skip resurrecting an already expired/completed parcel beyond the 21-day signed retention cutoff.
    if (parcel.terminalAt > 0 && now - parcel.terminalAt >= 21 * 86_400_000) continue;
    if (tombstone?.action === "completed" && now - tombstone.actedAtMs >= 21 * 86_400_000) continue;
    const carrier = projectedCarrierPresentation(waybill, parcel.carrierCode, "");
    const baseShipment = pendingManualPreviewShipment({ id: `${state.activeSource}:${waybill}`, source: state.activeSource,
      waybill, phoneTail: parcel.phone4, ...carrier, rawCourierCode: parcel.carrierCode,
      createdAtMs, lastAttemptAtMs: now, attempts: 0 });
    const shipment = tombstone?.action === "completed"
      ? {
          ...baseShipment,
          forcedCompletedAtMs: tombstone.actedAtMs,
          settledAtMs: tombstone.actedAtMs,
          timeline: { ...baseShipment.timeline, semantic: "COMPLETED" as const, structuredStatus: true, statusEventAtMs: tombstone.actedAtMs },
        }
      : baseShipment;
    changes.set(shipment.identity.id, { ...shipment, pddCloudOrigin: { waybill, waybillGeneration: 0 } });
  }
  for (const [waybill, mark] of marks) {
    if (!mark) continue;
    const tombstone = matchingCloudPddTombstone(tombstones, waybill, mark.anchorAt, mark.terminalAt);
    if (tombstone?.action === "deleted") continue;
    const existing = local.get(waybill) || [];
    if (existing.length !== 1) continue;
    const adopted = adoptCloudPddParcelSource(existing[0], mark, now);
    if (adopted !== existing[0]) changes.set(existing[0].identity.id, adopted);
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
  productNameObservedAt?: number;
  productImageURL?: string;
  deliveryEstimate?: string;
  deliveryEstimateObservedAt?: number;
}>;

export type CloudParcelPddLink = CloudPddParcelIdentity & Readonly<{
  shippingId: string;
}>;

export function cloudPddParcelAppURL(shipment: Shipment, link: CloudParcelPddLink | undefined, now = Date.now()): string {
  if (!link || !matchesCloudPddParcel(shipment, link, now)) return "";
  return pddParcelNativeAppURL(link.shippingId, link.waybill);
}

export function displayedPlatformFields(shipment: Shipment, now = Date.now(), cloud?: CloudParcelMetadata): {
  title?: string; estimate?: string; productImageURL?: string;
} {
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
  const effectiveCloudName = matchingCloud?.productName || saved?.cloudProductName;
  const effectiveCloudAt = matchingCloud?.productName
    ? (matchingCloud.productNameObservedAt ?? 0)
    : (saved?.cloudProductNameObservedAtMs ?? 0);
  const cloudTitleNewerThanLocalEdit = Boolean(
    effectiveCloudName &&
    effectiveCloudAt &&
    saved?.manualTitle &&
    saved?.manualTitleEditedAtMs &&
    effectiveCloudAt > saved.manualTitleEditedAtMs,
  );
  const title = cloudTitleNewerThanLocalEdit
    ? effectiveCloudName
    : saved?.manualTitle || saved?.title?.text || effectiveCloudName;
  return {
    title: title || undefined,
    estimate: localEstimate || cloudEstimate,
    ...(matchingCloud?.productImageURL ? { productImageURL: matchingCloud.productImageURL } : {}),
  };
}

export function enrichPlatformParcel(shipment: Shipment, parcel: PlatformParcel, now: number, cainiaoGeneration?: string): Shipment {
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
  const cainiaoImage = parcel.source === "cainiao" && parcel.productImageURL && cainiaoGeneration
    ? { url: parcel.productImageURL, generation: cainiaoGeneration } : undefined;
  const pddURL = parcel.source === "pinduoduo" ? pddProductImageURL(parcel.productImageURL) : "";
  const association = pddURL ? pddProductAssociation(next) : "";
  const pddImage = association && parcel.waybill === waybill && parcel.shippingId === next.pddImport?.shippingId &&
    !pddParcelProductImage(next) ? { url: pddURL, association } : undefined;
  if (parcel.source !== "fengchao" && (parcel.title || parcel.estimate || cainiaoImage || pddImage)) {
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
    const image = cainiaoImage || fields?.cainiaoImage;
    const platformFields = { ...fields, waybill, waybillGeneration, title, estimate,
      ...(image ? { cainiaoImage: image } : {}), ...(pddImage ? { pddImage } : {}) };
    if (JSON.stringify(platformFields) !== JSON.stringify(fields) || waybill !== fields?.waybill) {
      next = { ...next, platformFields };
    }
  }
  if (parcel.source === "pinduoduo" && parcel.traces?.length && waybill && !next.forcedCompletedAtMs) {
    const pddTimeline = pddTimelineFromTraces(
      waybill, next.identity.courierCode, next.identity.companyName, parcel.traces, now, next.identity.rawCourierCode,
    );
    if (pddTimeline) {
      const manualTimelines = mergeTimelineAuthorities(next.manualTimelines || [], pddTimeline);
      if (JSON.stringify(manualTimelines) !== JSON.stringify(next.manualTimelines || [])) {
        const withPdd: Shipment = { ...next, manualTimelines, updatedAtMs: Math.max(next.updatedAtMs, now) };
        next = { ...withPdd, timeline: selectShipmentTimeline(withPdd) };
      }
    }
  }
  if (!waybill || !eligiblePickup(next)) return next;
  const previous = next.pickup?.waybill === waybill && next.pickup.waybillGeneration === waybillGeneration
    ? next.pickup : undefined;
  if (previous?.completedAtMs) return next;
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
