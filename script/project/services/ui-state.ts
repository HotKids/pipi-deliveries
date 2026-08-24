import type { AppState, Shipment } from "../models";

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

export function preferNewerShipment(
  current: Shipment,
  incoming: Shipment,
): Shipment {
  if (incoming.identity.id !== current.identity.id) return incoming;
  return incoming.updatedAtMs >= current.updatedAtMs ? incoming : current;
}
