import type { Shipment } from "../models";

export class ShipmentLifecycleChangedError extends Error {
  constructor() {
    super("Shipment lifecycle changed; reopen the detail before editing.");
    this.name = "ShipmentLifecycleChangedError";
  }
}

export function shipmentLifecycleKey(shipment: Shipment): string {
  // Ordinary account/manual merges and order projection preserve creation; waybill reuse starts a new lifecycle.
  return JSON.stringify([shipment.identity.id, shipment.identity.createdAtMs, shipment.waybillReuseAtMs || 0]);
}
