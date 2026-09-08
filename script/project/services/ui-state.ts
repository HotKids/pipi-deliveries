import type { AppState, RefreshSummary, Shipment } from "../models";
import { displayWaybill } from "./shipment-policy";
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
