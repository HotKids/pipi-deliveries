import type { Shipment } from "../models";

export function shipmentLifecycleKey(shipment: Shipment): string {
  // Ordinary account/manual merges and order projection preserve creation; waybill reuse starts a new lifecycle.
  return JSON.stringify([shipment.identity.id, shipment.identity.createdAtMs, shipment.waybillReuseAtMs || 0]);
}
