import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import { selectShipmentDetailTimeline, shipmentDetailComplete, shouldScheduleManualRefresh } from "../services/shipment-policy";

import { shouldRefreshShipment } from "../services/status";

const waybill = "SF123456789012";
const oldAt = NOW - 24 * 60 * 60_000;
function pack(provider: string, count: number, newestAt: number, pickup: boolean): TimelinePackage {
  return { provider, waybill, courierCode: "SF", companyName: "顺丰速运", semantic: "TRANSIT",
    structuredStatus: true, statusEventAtMs: newestAt, complete: provider === "cn_h5",
    latestTimeText: String(newestAt), latestDetail: "Parcel in transit", successAtMs: NOW,
    tracks: Array.from({ length: count }, (_, index) => ({ timeMs: newestAt - index * 60_000,
      timeText: String(newestAt - index * 60_000),
      detail: pickup && index === count - 1 ? "顺丰速运 已收取快件" : `Parcel passed facility ${index}`,
      statusCode: "", raw: {} })),
  };
}
function seed(sourceProvider = "ShunFeng", completed = false) {
  const source = pack("interface5", 1, oldAt, false);
  const query = pack("v5_query", 5, oldAt, true);
  const h5 = pack("cn_h5", 2, oldAt, true);
  if (completed) for (const value of [source, query, h5]) value.semantic = "COMPLETED";
  const row: Shipment = { identity: { id: `interface5:account:${waybill}`, sourceId: waybill,
    bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceProvider,
    courierCode: "SF", rawCourierCode: "SF", companyName: "顺丰速运", phone: "13800001234",
    phoneTail: "1234", manuallyAdded: false, createdAtMs: oldAt - 24 * 60 * 60_000 },
    timeline: source, sourceTimeline: source, manualTimelines: [query, h5], updatedAtMs: NOW,
    detailSelection: { provider: "v5_query", selectedAtMs: oldAt },
    accountRecord: { waybill, companyCode: "SF", provider: sourceProvider, phone: "13800001234", stateNumber: 2 },
  };
  return saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: "13800001234", boundAtMs: oldAt },
  ] }, NOW).shipments[0]!;
}
const actualNow = Date.now;
Date.now = () => NOW;
try {
  for (const response of ["new-picker", "no-result"] as const) {
    memory.clear();
    const original = seed();
    assert.equal(selectShipmentDetailTimeline(original).provider, "v5_query");
    assert.equal(selectShipmentDetailTimeline(original).tracks.length, 5);
    const calls: string[] = [];
    const fresh = pack("v6_query", 18, NOW - 60_000, true);
    const result = await runShipmentRefreshForTesting(original.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { calls.push("account"); return null; },
        queryManualForSource: async (input) => {
          assert.ok(input.pickerOnly || input.fallbackOnly, "SF keeps its supported Picker/KDNiao adapters");
          calls.push(input.pickerOnly ? "picker" : "kdniao");
          return { shipment: response === "new-picker" ? { ...original, timeline: fresh,
            sourceTimeline: null, manualTimelines: [fresh] } : null, pending: null, routeUrl: "" };
        },
      });
    assert.deepEqual(calls, response === "new-picker" ? ["picker"] : ["picker", "kdniao"],
      "only accumulated manual pickup can stop SF supplementation; coarse source history cannot");
    assert.equal(shipmentDetailComplete(original), false);
    if (response === "new-picker") {
      assert.equal(result.refreshed, true);
      assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "v6_query",
        "a newer complete Picker package must replace history aligned only with the stale SF feed");
      assert.deepEqual(selectShipmentDetailTimeline(loadState(NOW).shipments[0]!).tracks, fresh.tracks,
        "the selected result survives reloading as one provider package, without feed or query nodes");
      assert.equal(loadState(NOW).shipments[0]!.manualTimelines?.find(pack => pack.provider === "v6_query")?.tracks.length, 18,
        "a refreshed Picker result must enter its own durable cache");
    } else {
      assert.equal(result.refreshed, false);
      assert.deepEqual(selectShipmentDetailTimeline(result.shipment).tracks, selectShipmentDetailTimeline(original).tracks);
    }
  }
  memory.clear();
  const original = seed();
  const withCandidate = (candidate: TimelinePackage, row: Shipment = original): Shipment => ({
    ...row, manualTimelines: [...(row.manualTimelines || []), candidate],
  });
  for (const delta of [30 * 60_000, 30 * 60_000 + 1]) {
    const candidate = pack("v6_query", 6, oldAt + delta, true);
    const preferredManual = { ...withCandidate(pack("k100_h5", 5, oldAt, true)),
      detailSelection: { provider: "k100_h5", selectedAtMs: oldAt } };
    assert.equal(selectShipmentDetailTimeline(withCandidate(candidate, preferredManual)).provider,
      delta === 30 * 60_000 ? "k100_h5" : "v6_query",
      "the existing 30-minute window and sticky preference remain exact among manual candidates");
  }
  const fresh = pack("v6_query", 18, NOW - 60_000, true);
  const lackingPickup = pack("v6_query", 18, NOW - 60_000, false);
  assert.equal(selectShipmentDetailTimeline(withCandidate(lackingPickup)).provider, "v6_query",
    "a usable partial manual package replaces coarse SF fallback without claiming completeness");
  for (const ineligible of [pack("v2_query", 30, NOW + 24 * 60 * 60_000, true),
    { ...pack("v4_query", 0, NOW + 24 * 60 * 60_000, true), complete: true }]) {
    assert.equal(selectShipmentDetailTimeline(withCandidate(ineligible, withCandidate(fresh))).provider, "v6_query",
      "ineligible providers and packages without timed nodes cannot move the SF reference");
  }
  const terminal = seed("ShunFeng", true);
  const terminalWithNewerHistory = withCandidate(fresh, terminal);
  assert.equal(selectShipmentDetailTimeline(terminalWithNewerHistory).semantic, "COMPLETED");
  assert.equal(shouldRefreshShipment(terminalWithNewerHistory, NOW), false);
  assert.equal(shouldScheduleManualRefresh(terminalWithNewerHistory, NOW), false,
    "a newer candidate cannot reopen a trusted completed shipment for scheduled refresh");
  for (const [provider, expected] of [["JingDong", "v5_query"], ["CaiNiao", "cn_h5"]]) {
    const other = seed(provider);
    assert.equal(selectShipmentDetailTimeline(withCandidate(fresh, other)).provider, expected,
      "other sources retain their feed reference even with an SF carrier code");
  }
  for (const [provider, completed] of [["ShunFeng", true], ["JingDong", false], ["CaiNiao", false]] as const) {
    memory.clear();
    const original = seed(provider, completed);
    assert.equal(shipmentDetailComplete(original), true);
    const result = await runShipmentRefreshForTesting(original.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { assert.fail("unchanged complete-source gate"); },
        queryManualForSource: async () => { assert.fail("unchanged complete-source gate"); },
      });
    assert.equal(result.refreshed, false);
  }
} finally { Date.now = actualNow; }

console.log("ShunFeng native detail refresh tests passed");
