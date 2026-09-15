import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import type { Shipment } from "../models";
import { emptyState, loadState, saveState, visibleShipments } from "../services/storage";
import { commitManualShipmentPreview, queryManualShipmentPreview, continueManualShipmentPreview } from "../services/sync";

const NOW = Date.UTC(2026, 8, 15, 6);
const HIDDEN = NOW - 8 * 86400000;
const WAYBILL = "SF1234567890123";
Date.now = () => NOW;
function row(manual: boolean, createdAtMs: number): Shipment {
  const timeline = {
    provider: manual ? "v6_query" : "interface5", waybill: WAYBILL,
    courierCode: "SF", companyName: "顺丰速运", semantic: "TRANSIT" as const,
    structuredStatus: true, statusEventAtMs: NOW, latestTimeText: "2026-09-15 14:00:00",
    latestDetail: "Synthetic movement", successAtMs: NOW,
    tracks: [{ timeMs: NOW, timeText: "2026-09-15 14:00:00", detail: "Synthetic movement",
      statusCode: "TRANSPORT", raw: {} }],
  };
  return { identity: { id: `interface5:${manual ? "manual" : "account"}:${WAYBILL}`,
    sourceId: WAYBILL, bindingSource: "interface5", sourceOwner: manual ? "manual" : "interface5",
    courierCode: "SF", companyName: "顺丰速运", manuallyAdded: manual, createdAtMs },
    timeline, sourceTimeline: manual ? null : timeline, manualTimelines: manual ? [timeline] : [],
    updatedAtMs: NOW };
}
function seed() {
  memory.clear();
  return saveState({ ...emptyState(), emptyTimelineRetirements: [{ id: "old-owner",
    source: "interface5", waybill: WAYBILL, hiddenAtMs: HIDDEN }] }, NOW);
}

seed();
const committed = commitManualShipmentPreview({ shipment: row(true, NOW), pending: null,
  routeUrl: "", hasTimedResult: true, roundComplete: true,
  commitBase: { shipment: null, pending: null } }, NOW);
assert.equal(committed.shipments.length, 1, "an explicit new manual owner must survive its real commit");
assert.equal(visibleShipments(loadState(NOW), NOW).length, 1, "the recreated owner survives reload");
assert.equal(committed.emptyTimelineRetirements?.length, 1, "automatic import exclusion remains durable");

for (const incoming of [row(false, NOW), row(true, HIDDEN - 1), row(true, HIDDEN), row(true, NOW + 1)]) {
  const initial = seed();
  const result = saveState({ ...initial, shipments: [incoming] }, NOW);
  assert.equal(result.shipments.length, 0, "automatic import and old manual generations remain retired");
  assert.equal(loadState(NOW).shipments.length, 0);
}

const earlier = seed();
const newerRetirement = saveState({ ...earlier, emptyTimelineRetirements: [
  ...earlier.emptyTimelineRetirements!, { id: "later-owner", source: "interface5",
    waybill: WAYBILL, hiddenAtMs: HIDDEN + 86400000 },
] }, NOW);
assert.equal(saveState({ ...newerRetirement, shipments: [row(true, HIDDEN + 1)] }, NOW).shipments.length, 0,
  "an older tombstone cannot exempt a manual owner that was subsequently retired again");

// Exercise both user-submit routes: a complete first response and pending promotion.
for (const complete of [true, false]) {
  seed();
  const preview = await queryManualShipmentPreview({ waybill: WAYBILL,
    presentation: { courierCode: "SF", companyName: "顺丰速运", requiresPhoneTail: false } }, {
    now: () => NOW,
    post: async () => ({ code: 200, value: JSON.stringify({ nu: WAYBILL, com: "SF",
      name: "顺丰速运", status: complete ? "GOT" : "TRANSPORT", time: "2026-09-15 14:00:00",
      context: complete ? "快件已揽收" : "快件运输中" }) }),
  });
  assert.equal(preview.roundComplete, complete);
  const first = commitManualShipmentPreview(preview, NOW);
  if (!complete) {
    assert.equal(first.pendingQueries.length, 1);
    const result = await continueManualShipmentPreview(preview, { dependencies: {
      now: () => NOW, queryMoto: async () => row(true, NOW),
      queryKuaidi100: async () => null, queryKdniao: async () => null,
    } });
    assert.equal(result.state.shipments.length, 1, "the explicitly submitted pending generation can be promoted");
  }
  assert.equal(visibleShipments(loadState(NOW), NOW).length, 1);
}
console.log("Explicit manual recreation preserves automatic retirement tests passed");
