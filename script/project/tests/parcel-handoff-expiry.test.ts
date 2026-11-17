import assert from "node:assert/strict";
import type { ParcelHandoffRecord, PickupCodeRecord, Shipment } from "../models";
import { memory, NOW, sha256 } from "./state-storage-mock";

const { completeIndependentParcelCode, emptyState, expireDueParcelHandoffs, loadState, saveRecognizedParcelCode, saveRecognizedShipmentPickup, saveState } =
  await import("../services/storage");
const END_AT = NOW + 60_000;
const DEADLINE = END_AT + 3_600_000;
const handoff: ParcelHandoffRecord = {
  id: "known-window",
  kind: "handoff",
  platform: "cainiao",
  code: "0152",
  capturedAtMs: NOW,
  windowStartAtMs: NOW,
  windowEndAtMs: END_AT,
};
const records: PickupCodeRecord[] = [
  handoff,
  { ...handoff, id: "unknown-window", windowEndAtMs: 0, windowText: "14:00–16:00" },
  { ...handoff, id: "completed", completedAtMs: NOW + 1000 },
  { ...handoff, id: "later", windowEndAtMs: END_AT + 120_000 },
  { id: "collection", kind: "pickup", platform: "cainiao", code: "1-2-3456", capturedAtMs: NOW },
];
const original = { ...emptyState(), pickupCodeRecords: records, updatedAtMs: NOW };
memory.set("pipi_deliveries_state_v1", {
  schema: 2,
  checksum: sha256(JSON.stringify(original)),
  state: original,
});

const before = loadState(NOW);
assert.equal(expireDueParcelHandoffs(DEADLINE - 1).revision, before.revision);
const after = expireDueParcelHandoffs(DEADLINE + 3000);
assert.equal(after.revision, before.revision + 1);
assert.deepEqual(after.pickupCodeRecords, [
  { ...handoff, expiredAtMs: DEADLINE },
  ...records.slice(1),
]);
assert.deepEqual(loadState(DEADLINE + 3001).pickupCodeRecords, after.pickupCodeRecords);
assert.equal(expireDueParcelHandoffs(DEADLINE + 3002).revision, after.revision);
// An ordinary shipment write does not own the independent code records.
const ordinarySave = saveState(before, DEADLINE + 3003);
assert.deepEqual(ordinarySave.pickupCodeRecords, after.pickupCodeRecords);
assert.deepEqual(ordinarySave.shipments, before.shipments);

const recognized = { ...records[4], id: "new-local-capture", capturedAtMs: DEADLINE + 3004 };
const withLocalCode = saveRecognizedParcelCode(recognized, DEADLINE + 3004);
assert.deepEqual(withLocalCode.pickupCodeRecords?.at(-1), recognized);
const completed = completeIndependentParcelCode(recognized.id, DEADLINE + 3005);
assert.deepEqual(completed.pickupCodeRecords?.at(-1), { ...recognized, completedAtMs: DEADLINE + 3005 });
assert.equal(saveRecognizedParcelCode(recognized, DEADLINE + 3006).revision, completed.revision);
assert.deepEqual(completed.shipments, before.shipments);
const due = { ...handoff, id: "already-due" };
const withExpired = saveRecognizedParcelCode(due, DEADLINE + 3007);
assert.deepEqual(withExpired.pickupCodeRecords?.at(-1), { ...due, expiredAtMs: DEADLINE });

const now = DEADLINE + 4000;
const waybill = "TEST81234567";
const tracked: Shipment = {
  identity: {
    id: "synthetic-tracked",
    bindingSource: null,
    sourceOwner: "synthetic",
    sourceId: waybill,
    phoneTail: "",
    courierCode: "sf",
    companyName: "顺丰",
    manuallyAdded: true,
    createdAtMs: NOW,
  },
  timeline: {
    provider: "moto", waybill, courierCode: "sf", companyName: "顺丰", semantic: "WAITING_PICKUP",
    statusEventAtMs: NOW, latestTimeText: "2026-09-08 14:00", latestDetail: "待取件",
    tracks: [{ timeText: "2026-09-08 14:00", timeMs: NOW, detail: "待取件", statusCode: "501", raw: {} }],
    successAtMs: NOW,
  },
  updatedAtMs: now,
};
const withShipment = saveState({ ...withExpired, shipments: [tracked] }, now);
const visible = withShipment.shipments[0];
const lookup = { waybill, pickup: { code: "A1-2345" }, capturedAtMs: now };
const attached = saveRecognizedShipmentPickup(visible, lookup, now + 1);
assert.equal(loadState(now + 2).shipments[0].pickup?.code, lookup.pickup.code);
const refreshed = saveState({ ...attached, shipments: [{ ...visible, updatedAtMs: now + 3 }] }, now + 3);
assert.equal(refreshed.shipments[0].pickup?.capturedAtMs, now);
assert.deepEqual(refreshed.pickupCodeRecords, withExpired.pickupCodeRecords);

console.log("Independent handoff expiry survives reload and ordinary shipment writes");
