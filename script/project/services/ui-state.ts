import type { AppState, RefreshSummary, Shipment } from "../models";
import { displayWaybill } from "./shipment-policy";
import { listHeadline, shipmentPresentationStatus, statusTextTint } from "./status";
import type { ManualShipmentPreview } from "./sync";

export type ShipmentNavigationTarget =
  | Readonly<{ kind: "persisted"; shipmentId: string }>
  | Readonly<{ kind: "manualPreview"; preview: ManualShipmentPreview }>;

export type ConsumedShipmentNavigationTarget = Readonly<{
  nextTarget: null;
  preview: ManualShipmentPreview | null;
}>;

export function preferNewerState(
  current: AppState,
  incoming: AppState,
): AppState {
  if (incoming.revision !== current.revision) {
    return incoming.revision > current.revision ? incoming : current;
  }
  return incoming.updatedAtMs > current.updatedAtMs ? incoming : current;
}

export function selectedShipment(
  state: AppState,
  shipmentId: string,
  preview: Shipment | null = null,
): Shipment | null {
  if (!shipmentId) return null;
  if (preview?.identity.id === shipmentId) return preview;
  return state.shipments.find(
    (shipment) => shipment.identity.id === shipmentId,
  ) || null;
}

export function persistedShipmentNavigationTarget(
  shipmentId: string,
): ShipmentNavigationTarget | null {
  const value = String(shipmentId || "").trim();
  return value ? { kind: "persisted", shipmentId: value } : null;
}

export function promotedPendingShipmentNavigationTarget(
  summary: RefreshSummary,
  currentTarget: ShipmentNavigationTarget | null = null,
): ShipmentNavigationTarget | null {
  if (currentTarget) return null;
  const shipmentId = summary.promotedPendingShipmentIds.find((candidate) =>
    summary.state.shipments.some(
      (shipment) => shipment.identity.id === candidate,
    )
  );
  return persistedShipmentNavigationTarget(shipmentId || "");
}

export function manualPreviewNavigationTarget(
  preview: ManualShipmentPreview,
  committedState?: AppState,
): ShipmentNavigationTarget {
  if (!preview.shipment) {
    throw new Error("A manual detail preview requires a shipment");
  }
  const previewShipment = preview.shipment;
  const committedShipment = committedState?.shipments.find(
    (shipment) => shipment.identity.id === previewShipment.identity.id,
  ) || committedState?.shipments
    .filter(
      (shipment) =>
        (shipment.identity.bindingSource || null) ===
          (previewShipment.identity.bindingSource || null) &&
        displayWaybill(shipment) === displayWaybill(previewShipment),
    )
    .sort((left, right) =>
      Number(left.identity.manuallyAdded) -
        Number(right.identity.manuallyAdded)
    )[0];
  return {
    kind: "manualPreview",
    preview: committedShipment
      ? { ...preview, shipment: committedShipment }
      : preview,
  };
}

export function selectedNavigationShipment(
  state: AppState,
  target: ShipmentNavigationTarget | null,
): Shipment | null {
  if (!target) return null;
  if (target.kind === "manualPreview") return target.preview.shipment;
  return selectedShipment(state, target.shipmentId);
}

export function shipmentNavigationTargetId(
  target: ShipmentNavigationTarget | null,
): string {
  if (!target) return "";
  return target.kind === "manualPreview"
    ? target.preview.shipment?.identity.id || ""
    : target.shipmentId;
}

export function consumeShipmentNavigationTarget(
  target: ShipmentNavigationTarget | null,
): ConsumedShipmentNavigationTarget {
  return {
    nextTarget: null,
    preview: target?.kind === "manualPreview" ? target.preview : null,
  };
}

export function preferNewerShipment(
  current: Shipment,
  incoming: Shipment,
): Shipment {
  if (incoming.identity.id !== current.identity.id) return incoming;
  return incoming.updatedAtMs >= current.updatedAtMs ? incoming : current;
}

export type ShipmentListItem = { id: string; shipment: Shipment; deleting: boolean; completing: boolean };

export function sameForegroundShipmentProjection(left: Shipment, right: Shipment): boolean {
  if (left === right) return true;
  const leftPresentation = shipmentPresentationStatus(left);
  const rightPresentation = shipmentPresentationStatus(right);
  if (
    leftPresentation.semantic !== rightPresentation.semantic ||
    leftPresentation.text !== rightPresentation.text
  ) {
    return false;
  }
  const leftTone = statusTextTint(leftPresentation.semantic, { label: leftPresentation.text });
  const rightTone = statusTextTint(rightPresentation.semantic, { label: rightPresentation.text });
  if (leftTone.light !== rightTone.light || leftTone.dark !== rightTone.dark) {
    return false;
  }
  const leftHeadline = Array.isArray(left.timeline.tracks) ? listHeadline(left.timeline) : null;
  const rightHeadline = Array.isArray(right.timeline.tracks) ? listHeadline(right.timeline) : null;
  return (
    left.identity.id === right.identity.id &&
    left.identity.createdAtMs === right.identity.createdAtMs &&
    left.waybillReuseAtMs === right.waybillReuseAtMs &&
    (left.note || "").trim() === (right.note || "").trim() &&
    Boolean(left.forcedCompletedAtMs) === Boolean(right.forcedCompletedAtMs) &&
    left.statusPresentation?.scope === right.statusPresentation?.scope &&
    left.statusPresentation?.semantic === right.statusPresentation?.semantic &&
    left.statusPresentation?.text === right.statusPresentation?.text &&
    left.timeline.normalizedStatus?.scope === right.timeline.normalizedStatus?.scope &&
    left.timeline.normalizedStatus?.semantic === right.timeline.normalizedStatus?.semantic &&
    left.timeline.normalizedStatus?.code === right.timeline.normalizedStatus?.code &&
    left.timeline.normalizedStatus?.text === right.timeline.normalizedStatus?.text &&
    left.timeline.normalizedStatus?.structured === right.timeline.normalizedStatus?.structured &&
    left.identity.companyName === right.identity.companyName &&
    left.identity.courierCode === right.identity.courierCode &&
    left.identity.sender === right.identity.sender &&
    left.identity.accountOrder === right.identity.accountOrder &&
    left.identity.projectedWaybill === right.identity.projectedWaybill &&
    displayWaybill(left) === displayWaybill(right) &&
    left.timeline.semantic === right.timeline.semantic &&
    left.timeline.latestTimeText === right.timeline.latestTimeText &&
    left.timeline.latestDetail === right.timeline.latestDetail &&
    leftHeadline?.timeText === rightHeadline?.timeText &&
    leftHeadline?.detail === rightHeadline?.detail &&
    left.timeline.headlineDisplay?.timeText === right.timeline.headlineDisplay?.timeText &&
    left.timeline.headlineDisplay?.detail === right.timeline.headlineDisplay?.detail &&
    left.platformFields?.manualTitle === right.platformFields?.manualTitle &&
    left.platformFields?.cloudProductName === right.platformFields?.cloudProductName &&
    left.platformFields?.title?.text === right.platformFields?.title?.text &&
    left.platformFields?.estimate?.text === right.platformFields?.estimate?.text &&
    left.platformFields?.cainiaoImage?.url === right.platformFields?.cainiaoImage?.url &&
    left.platformFields?.pddImage?.url === right.platformFields?.pddImage?.url &&
    (left.pickup === right.pickup || JSON.stringify(left.pickup) === JSON.stringify(right.pickup))
  );
}

export function selectForegroundShipmentsProjection(
  previous: readonly Shipment[],
  next: readonly Shipment[],
): readonly Shipment[] {
  if (previous === next) return previous;
  if (previous.length !== next.length) return next;
  for (let i = 0; i < next.length; i += 1) {
    if (!sameForegroundShipmentProjection(previous[i]!, next[i]!)) return next;
  }
  return previous;
}

export function selectForegroundPickupCardsProjection<T>(
  previous: readonly T[],
  next: readonly T[],
): readonly T[] {
  if (previous === next) return previous;
  if (previous.length !== next.length) return next;
  if (next.length === 0) return previous;
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

export function sameShipmentRowPresentation(left: Shipment, right: Shipment): boolean {
  if (left === right) return true;
  const leftPresentation = shipmentPresentationStatus(left);
  const rightPresentation = shipmentPresentationStatus(right);
  if (
    leftPresentation.semantic !== rightPresentation.semantic ||
    leftPresentation.text !== rightPresentation.text
  ) {
    return false;
  }
  const leftTone = statusTextTint(leftPresentation.semantic, { label: leftPresentation.text });
  const rightTone = statusTextTint(rightPresentation.semantic, { label: rightPresentation.text });
  if (leftTone.light !== rightTone.light || leftTone.dark !== rightTone.dark) {
    return false;
  }
  const leftHeadline = Array.isArray(left.timeline.tracks) ? listHeadline(left.timeline) : null;
  const rightHeadline = Array.isArray(right.timeline.tracks) ? listHeadline(right.timeline) : null;
  return (left.note || "").trim() === (right.note || "").trim() &&
    Boolean(left.forcedCompletedAtMs) === Boolean(right.forcedCompletedAtMs) &&
    left.statusPresentation?.scope === right.statusPresentation?.scope &&
    left.statusPresentation?.semantic === right.statusPresentation?.semantic &&
    left.statusPresentation?.text === right.statusPresentation?.text &&
    left.timeline.normalizedStatus?.scope === right.timeline.normalizedStatus?.scope &&
    left.timeline.normalizedStatus?.semantic === right.timeline.normalizedStatus?.semantic &&
    left.timeline.normalizedStatus?.code === right.timeline.normalizedStatus?.code &&
    left.timeline.normalizedStatus?.text === right.timeline.normalizedStatus?.text &&
    left.timeline.normalizedStatus?.structured === right.timeline.normalizedStatus?.structured &&
    left.identity.companyName === right.identity.companyName &&
    left.identity.courierCode === right.identity.courierCode &&
    left.identity.sender === right.identity.sender &&
    left.identity.accountOrder === right.identity.accountOrder &&
    left.identity.projectedWaybill === right.identity.projectedWaybill &&
    displayWaybill(left) === displayWaybill(right) &&
    left.timeline.semantic === right.timeline.semantic &&
    left.timeline.latestTimeText === right.timeline.latestTimeText &&
    left.timeline.latestDetail === right.timeline.latestDetail &&
    leftHeadline?.timeText === rightHeadline?.timeText &&
    leftHeadline?.detail === rightHeadline?.detail &&
    left.timeline.headlineDisplay?.timeText === right.timeline.headlineDisplay?.timeText &&
    left.timeline.headlineDisplay?.detail === right.timeline.headlineDisplay?.detail;
}

export function sameShipmentItemList(
  left: readonly ShipmentListItem[] | undefined,
  right: readonly ShipmentListItem[],
): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
