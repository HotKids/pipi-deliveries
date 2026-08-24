import assert from "node:assert/strict";
import type { AppState, Shipment } from "../models";
import {
  preferNewerShipment,
  preferNewerState,
  selectedShipment,
} from "../services/ui-state";

const base = {
  version: 2,
  revision: 4,
  updatedAtMs: 100,
  activeSource: "interface5",
  bindings: [],
  suppressions: [],
  tombstones: [],
  pendingQueries: [],
  shipments: [],
} satisfies AppState;

assert.equal(preferNewerState(base, { ...base, revision: 3 }), base);
assert.equal(
  preferNewerState(base, { ...base, revision: 4, updatedAtMs: 99 }),
  base,
);
const newer = { ...base, revision: 5, updatedAtMs: 90 };
assert.equal(preferNewerState(base, newer), newer);

const shipment = {
  identity: { id: "shipment-a" },
  updatedAtMs: 1,
} as Shipment;
const replacement = {
  identity: { id: "shipment-a" },
  updatedAtMs: 2,
} as Shipment;
const other = {
  identity: { id: "shipment-b" },
  updatedAtMs: 3,
} as Shipment;
const state = { ...base, shipments: [replacement, other] };
assert.equal(selectedShipment(state, "shipment-a"), replacement);
assert.equal(selectedShipment(state, "shipment-a", shipment), shipment);
assert.equal(selectedShipment(state, "shipment-a", other), replacement);
assert.equal(selectedShipment(state, "missing"), null);
assert.equal(preferNewerShipment(replacement, shipment), replacement);
assert.equal(preferNewerShipment(shipment, replacement), replacement);
assert.equal(preferNewerShipment(shipment, other), other);

console.log("UI state monotonicity and stable selection tests passed");
