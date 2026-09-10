import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, saveState, loadState } from "../services/storage";
import { applyManualShipment } from "../services/shipment-policy";

const actualNow = Date.now;
Date.now = () => NOW;
const failures: string[] = [];
function pack(provider: string, semantic: TimelinePackage["semantic"], count: number, at: number): TimelinePackage {
  return { provider, waybill: "SF1234567890", courierCode: "SF", companyName: "SF",
    semantic, structuredStatus: semantic !== "UNKNOWN", statusEventAtMs: at,
    latestDetail: "Carrier event", latestTimeText: new Date(at).toISOString(), successAtMs: NOW,
    tracks: Array.from({ length: count }, (_, index) => ({ timeMs: at - index * 1000,
      timeText: new Date(at - index * 1000).toISOString(), detail: "Carrier event", statusCode: "", raw: {} })),
  };
}
function owner(provider: string, feed: TimelinePackage): Shipment {
  return { identity: { id: "interface5:account:synthetic", sourceId: feed.waybill,
    bindingSource: "interface5", sourceProvider: provider, sourceOwner: "account", manuallyAdded: false,
    phone: "13800001234", phoneTail: "1234", courierCode: "SF", companyName: "SF", createdAtMs: NOW - 10000 },
    timeline: feed, sourceTimeline: feed, manualTimelines: [], updatedAtMs: NOW };
}
try {
  for (const provider of ["DouYin", "ShunFeng"]) {
    try {
      memory.clear();
      let row = owner(provider, pack("interface5", "UNKNOWN", 3, NOW - 3000));
      const signed = pack("kdniao", "COMPLETED", 1, NOW - 2000);
      row = applyManualShipment(row, { ...row, timeline: signed, sourceTimeline: null,
        manualTimelines: [signed] }, NOW);
      const signedState = saveState({ ...emptyState(), shipments: [row] }, NOW);
      const savedSigned = signedState.shipments[0]!;
      assert.equal(savedSigned.timeline.semantic, "COMPLETED");
      assert.equal(savedSigned.timeline.statusEventAtMs, signed.statusEventAtMs);
      const transit = pack("v6_query", "TRANSIT", 4, NOW - 1000);
      row = applyManualShipment(savedSigned, { ...savedSigned, timeline: transit, sourceTimeline: null,
        manualTimelines: [transit] }, NOW + 1);
      const refreshed = saveState({ ...signedState, shipments: [row] }, NOW + 1);
      assert.equal(refreshed.shipments[0]!.timeline.semantic, "COMPLETED",
        `${provider}: a later nonterminal donor cannot undo an already displayed sign-off at commit`);
      assert.equal(refreshed.shipments[0]!.timeline.statusEventAtMs, signed.statusEventAtMs);
      const restarted = loadState(NOW + 2).shipments[0]!;
      assert.equal(restarted.timeline.semantic, "COMPLETED", `${provider}: sign-off survives reselection on restart`);
      assert.equal(restarted.timeline.statusEventAtMs, signed.statusEventAtMs);
      assert.equal(restarted.sourceTimeline?.semantic, "UNKNOWN", "the empty feed never acquires the donor's status");
    } catch (error) {
      failures.push(`${provider}: ${String(error)}`);
    }
  }
  try {
    memory.clear();
    const orderId = "361000000000001";
    const evaluation = `您的订单${orderId}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。`;
    const feed = pack("interface5", "COMPLETED", 0, NOW - 1000);
    feed.latestDetail = evaluation;
    feed.tracks = [
      { timeMs: NOW - 1000, timeText: "2026-09-08 13:59:59", detail: evaluation,
        statusCode: "107", raw: { statusCode: "107", _pipiStatusSource: "interface5" } },
      { timeMs: NOW - 2000, timeText: "2026-09-08 13:59:58", detail: "Carrier event",
        statusCode: "104", raw: { statusCode: "104", _pipiStatusSource: "interface5" } },
    ];
    const row = owner("JingDong", feed);
    row.identity = { ...row.identity, sourceId: orderId, orderId, accountOrder: true,
      projectedWaybill: feed.waybill };
    const restored = saveState({ ...emptyState(), shipments: [row] }, NOW).shipments[0]!;
    assert.notEqual(restored.timeline.semantic, "COMPLETED", "rejected shopping completion must not become a terminal latch");
    const restarted = loadState(NOW + 1).shipments[0]!;
    assert.notEqual(restarted.timeline.semantic, "COMPLETED");
    assert.equal(restarted.timeline.tracks.some((track) => track.detail === evaluation), false);
  } catch (error) {
    failures.push(`JingDong evaluation: ${String(error)}`);
  }
} finally {
  Date.now = actualNow;
}
assert.equal(failures.length, 0, failures.join("\n"));
console.log("borrowed sign-off retention and JingDong evaluation cleanup tests passed");
