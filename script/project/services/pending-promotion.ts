import type { AppState } from "../models";

export function committedPendingPromotionShipmentId(
  state: AppState,
  pendingId: string,
  shipmentId: string,
): string {
  const committedShipmentId = String(shipmentId || "").trim();
  if (
    !pendingId ||
    !committedShipmentId ||
    state.pendingQueries.some((pending) => pending.id === pendingId) ||
    !state.shipments.some(
      (shipment) => shipment.identity.id === committedShipmentId,
    )
  ) {
    return "";
  }
  return committedShipmentId;
}
