import assert from "node:assert/strict";
import type { PendingManualQuery, Shipment, TimelinePackage } from "../models.ts";
import { memory, NOW } from "./state-storage-mock.ts";
import {
  emptyState, loadState, saveState, commitRefreshState, removeShipment, upsertPendingQuery,
} from "../services/storage.ts";
import { queryManualShipmentPreview, commitManualShipmentPreview } from "../services/sync.ts";

Date.now = () => NOW;
const id = "interface5:manual:AUDIT1234567890";
const waybill = "AUDIT1234567890";
const timeline: TimelinePackage = {
  provider: "v6_query", waybill, courierCode: "SF", companyName: "顺丰速运",
  semantic: "TRANSIT", statusEventAtMs: NOW - 60_000,
  latestTimeText: "2026-09-08 10:00:00", latestDetail: "快件运输中",
  tracks: [{ timeText: "2026-09-08 10:00:00", timeMs: NOW - 60_000,
    detail: "快件运输中", statusCode: "", raw: {} }],
  successAtMs: NOW, complete: false,
};
const row: Shipment = {
  identity: { id, bindingSource: "interface5", sourceOwner: "manual", sourceId: waybill,
    phoneTail: "", courierCode: "SF", rawCourierCode: "SF", companyName: "顺丰速运",
    manuallyAdded: true, createdAtMs: NOW - 60_000 },
  timeline, manualTimelines: [timeline], updatedAtMs: NOW,
};
const pending: PendingManualQuery = {
  id: `interface5:${waybill}`, source: "interface5", waybill, phoneTail: "",
  courierCode: "SF", rawCourierCode: "SF", companyName: "顺丰速运",
  createdAtMs: NOW - 60_000, lastAttemptAtMs: NOW - 30_000, attempts: 1,
  awaitingRoundCompletion: true,
};

async function previewDuring(intervene: () => void, completeRound = true) {
  let release!: (value: unknown) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const work = queryManualShipmentPreview({
    waybill, presentation: { courierCode: "SF", companyName: "顺丰速运", requiresPhoneTail: false },
  }, {
    now: () => NOW,
    post: async path => {
      assert.equal(path, "/api/express/timeline/source");
      began();
      return response;
    },
  });
  await started;
  intervene();
  release({ code: 200, value: JSON.stringify({
    nu: waybill, com: "SF", name: "顺丰速运", state: completeRound ? "1" : "2",
    time: "2026-09-08 10:01:00", context: completeRound ? "快件已揽收" : "快件运输中",
  }) });
  return work;
}

for (const completeRound of [true, false]) {
  memory.clear();
  saveState({ ...emptyState(), pendingQueries: [pending] }, NOW);
  const preview = await previewDuring(() => {
    // A concurrent Home refresh promotes the pending query while Picker waits;
    // the now-visible row can be deleted through the ordinary row action.
    const base = loadState();
    const promoted = commitRefreshState(base,
      { ...base, pendingQueries: [], shipments: [row] }, "interface5");
    assert.equal(promoted.state.shipments.length, 1);
    removeShipment(id);
  }, completeRound);
  assert.equal(preview.roundComplete, completeRound);
  assert.throws(() => commitManualShipmentPreview(preview), /已被移除或更新/);
  assert.equal(loadState().shipments.length, 0);
  assert.equal(loadState().pendingQueries.length, 0,
    "a partial late result must not recreate the deleted retry either");
}

memory.clear();
saveState({ ...emptyState(), pendingQueries: [pending] }, NOW);
const replaced = await previewDuring(() => upsertPendingQuery({ ...pending, attempts: 2 }, NOW));
assert.throws(() => commitManualShipmentPreview(replaced), /已被移除或更新/);
assert.equal(loadState().pendingQueries[0].attempts, 2);

// Changes to unrelated rows do not invalidate the pending query's generation.
memory.clear();
saveState({ ...emptyState(), pendingQueries: [pending] }, NOW);
const fresh = await previewDuring(() => {
  const other = { ...row, identity: { ...row.identity, id: "interface5:manual:OTHER123456",
    sourceId: "OTHER123456" }, timeline: { ...timeline, waybill: "OTHER123456" }, manualTimelines: [] };
  saveState({ ...loadState(), shipments: [other] }, NOW);
});
assert.equal(commitManualShipmentPreview(fresh).shipments.length, 2);
assert.equal(loadState().pendingQueries.length, 0);

memory.clear();
const first = await previewDuring(() => {}, false);
assert.equal(commitManualShipmentPreview(first).pendingQueries.length, 1,
  "a new partial preview can still create its first durable retry");

memory.clear();
saveState({ ...emptyState(), shipments: [row] }, NOW);
const existing = await previewDuring(() => {});
assert.equal(commitManualShipmentPreview(existing).shipments.length, 1,
  "an unchanged existing owner can accept the requested Picker refresh");
console.log("initial Picker commits preserve deletion and replacement while unrelated changes proceed");
