import assert from "node:assert/strict";
import type { AppState, Shipment } from "../models";
import type { ManualShipmentPreview } from "../services/sync";
import {
  consumeShipmentNavigationTarget,
  manualPreviewNavigationTarget,
  persistedShipmentNavigationTarget,
  promotedPendingShipmentNavigationTarget,
  preferNewerShipment,
  preferNewerState,
  selectedNavigationShipment,
  selectedShipment,
  shipmentNavigationTargetId,
} from "../services/ui-state";

const base = {
  version: 2,
  revision: 4,
  updatedAtMs: 100,
  activeSource: "interface5",
  bindings: [],
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

const preview = {
  shipment,
  pending: null,
  routeUrl: "",
  hasTimedResult: true,
} satisfies ManualShipmentPreview;
const manualTarget = manualPreviewNavigationTarget(preview);
assert.equal(
  selectedNavigationShipment(state, manualTarget),
  shipment,
  "the transient manual package must atomically own its first detail presentation",
);
assert.equal(
  selectedNavigationShipment({ ...state, revision: 6 }, manualTarget),
  shipment,
  "an unrelated persisted-state refresh must not consume or replace the preview",
);
const committedManualTarget = manualPreviewNavigationTarget(preview, state);
assert.equal(
  selectedNavigationShipment(state, committedManualTarget),
  replacement,
  "Home must open the canonical shipment produced by the preview commit",
);
const racedPreviewShipment = {
  identity: {
    id: "temporary-manual-id",
    bindingSource: "interface5",
    manuallyAdded: true,
  },
  timeline: { waybill: "SF5116474383875" },
  updatedAtMs: 3,
} as Shipment;
const racedCommittedShipment = {
  identity: {
    id: "canonical-account-id",
    bindingSource: "interface5",
    manuallyAdded: false,
  },
  timeline: { waybill: "SF5116474383875" },
  updatedAtMs: 4,
} as Shipment;
const racedPreview = {
  shipment: racedPreviewShipment,
  pending: null,
  routeUrl: "",
  hasTimedResult: true,
} satisfies ManualShipmentPreview;
const racedState = {
  ...state,
  revision: 6,
  shipments: [racedCommittedShipment],
};
assert.equal(
  selectedNavigationShipment(
    racedState,
    manualPreviewNavigationTarget(racedPreview, racedState),
  ),
  racedCommittedShipment,
  "a concurrent refresh may canonicalize the shipment ID before the manual preview is committed",
);
const firstDismissal = consumeShipmentNavigationTarget(manualTarget);
assert.equal(firstDismissal.preview, preview);
assert.equal(firstDismissal.nextTarget, null);
assert.equal(
  consumeShipmentNavigationTarget(firstDismissal.nextTarget).preview,
  null,
  "a consumed preview must not be committed or reopened twice",
);

const persistedTarget = persistedShipmentNavigationTarget("shipment-a");
assert.equal(selectedNavigationShipment(state, persistedTarget), replacement);
assert.equal(consumeShipmentNavigationTarget(persistedTarget).preview, null);

const promotedTarget = promotedPendingShipmentNavigationTarget({
  attempted: 1,
  succeeded: 1,
  failed: 0,
  state,
  promotedPendingShipmentIds: ["shipment-a"],
});
assert.deepEqual(
  promotedTarget,
  persistedTarget,
  "a foreground refresh must navigate to the committed pending promotion",
);
assert.equal(
  promotedPendingShipmentNavigationTarget({
    attempted: 1,
    succeeded: 1,
    failed: 0,
    state,
    promotedPendingShipmentIds: ["missing"],
  }),
  null,
  "a stale promotion event must not open a missing shipment",
);
assert.equal(
  shipmentNavigationTargetId(promotedPendingShipmentNavigationTarget({
    attempted: 2,
    succeeded: 2,
    failed: 0,
    state,
    promotedPendingShipmentIds: ["shipment-b", "shipment-a"],
  })),
  "shipment-b",
  "multiple promotions must open only the first committed shipment",
);
assert.equal(
  promotedPendingShipmentNavigationTarget({
    attempted: 1,
    succeeded: 1,
    failed: 0,
    state,
    promotedPendingShipmentIds: ["shipment-b"],
  }, persistedTarget),
  null,
  "a pending promotion must not replace an existing navigation target",
);

console.log("UI state monotonicity and stable selection tests passed");
