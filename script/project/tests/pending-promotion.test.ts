import assert from "node:assert/strict";
import type { AppState } from "../models";
import { committedPendingPromotionShipmentId } from "../services/pending-promotion";

const pendingId = "pending-a";
const shipmentId = "shipment-a";
const committedState = {
  pendingQueries: [],
  shipments: [{ identity: { id: shipmentId } }],
} as AppState;

assert.equal(
  committedPendingPromotionShipmentId(committedState, pendingId, shipmentId),
  shipmentId,
);
assert.equal(
  committedPendingPromotionShipmentId({
    ...committedState,
    pendingQueries: [{ id: pendingId }],
  } as AppState, pendingId, shipmentId),
  "",
  "a pending row that survived the checkpoint was not promoted",
);
assert.equal(
  committedPendingPromotionShipmentId({
    ...committedState,
    shipments: [],
  }, pendingId, shipmentId),
  "",
  "a checkpoint without the committed shipment must not emit navigation",
);

console.log("pending promotion commit tests passed");
