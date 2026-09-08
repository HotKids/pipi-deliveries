import assert from "node:assert/strict";
import type { AppState } from "../models";
import {
  performShipmentCompletion,
  performShipmentDeletion,
} from "../services/shipment-actions";

const state = {
  version: 2,
  revision: 8,
  updatedAtMs: 100,
  activeSource: "interface5",
  bindings: [],
  pendingQueries: [{ id: "pending-route" }],
  shipments: [{ identity: { id: "retained-shipment" } }],
} as AppState;

let pruneCalls = 0;
let reloadCalls = 0;
const succeeded = performShipmentDeletion("deleted-shipment", {
  mutate(id) {
    assert.equal(id, "deleted-shipment");
    return state;
  },
  pruneRoutes(next) {
    pruneCalls += 1;
    assert.equal(next, state);
    throw new Error("route cleanup failed");
  },
  reloadWidgets() {
    reloadCalls += 1;
    throw new Error("widget reload failed");
  },
});
assert.equal(succeeded.ok, true);
assert.equal(succeeded.ok && succeeded.state, state);
assert.equal(pruneCalls, 1);
assert.equal(reloadCalls, 1);
assert.equal(succeeded instanceof Promise, false);

pruneCalls = 0;
reloadCalls = 0;
const failed = performShipmentDeletion("deleted-shipment", {
  mutate() {
    throw new Error("durable write failed");
  },
  pruneRoutes() {
    pruneCalls += 1;
  },
  reloadWidgets() {
    reloadCalls += 1;
  },
});
assert.deepEqual(failed, {
  ok: false,
  message: "操作失败，请稍后重试",
});
assert.equal(pruneCalls, 0);
assert.equal(reloadCalls, 0);

let completedId = "";
const completed = performShipmentCompletion("shipment-to-complete", {
  mutate(id) {
    completedId = id;
    return state;
  },
  pruneRoutes() {},
  reloadWidgets() {
    reloadCalls += 1;
  },
});
assert.equal(completed.ok, true);
assert.equal(completedId, "shipment-to-complete");

console.log("shipment action recovery boundary tests passed");
