import assert from "node:assert/strict";
import type { Shipment, StatusSemantic, TimelinePackage } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import { hasPickerTimelineStart, hasTimelineStartBeforeKdniao } from "../services/shipment-policy";

const waybill = "SFSTOPALIGN1013";
const HOUR = 60 * 60_000;
function pack(provider: string, at: number, start: boolean, semantic: StatusSemantic = "TRANSIT"): TimelinePackage {
  return { provider, waybill, courierCode: "SF", companyName: "Test carrier",
    semantic, structuredStatus: true, statusEventAtMs: at, complete: false,
    latestTimeText: "", latestDetail: "Parcel event", successAtMs: NOW,
    tracks: [{ timeMs: at, timeText: "", detail: start ? "已揽收" : "Parcel event",
      statusCode: "", raw: {} }] };
}
function seed(manuals: TimelinePackage[]): Shipment {
  const source = pack("interface5", NOW - 20 * HOUR, true);
  const selected = manuals.reduce((latest, value) =>
    value.statusEventAtMs! > latest.statusEventAtMs! ? value : latest, source);
  return { identity: { id: `interface5:account:${waybill}`, sourceId: waybill,
    bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng",
    courierCode: "SF", rawCourierCode: "SF", companyName: "Test carrier", phone: "13800001234",
    phoneTail: "1234", manuallyAdded: false, createdAtMs: NOW - 30 * HOUR },
    timeline: selected, sourceTimeline: source, manualTimelines: manuals, updatedAtMs: NOW };
}

const actualNow = Date.now;
Date.now = () => NOW;
try {
  for (const provider of ["v6_query", "k100_h5"]) {
    const oldStart = pack(provider, NOW - 10 * HOUR, true);
    const current = pack("kdniao", NOW, false, "COMPLETED");
    const row = seed([oldStart, current]);
    assert.equal(hasTimelineStartBeforeKdniao(row), false,
      `${provider}: ten-hour-old pickup does not close newer completed history`);
    if (provider === "v6_query") assert.equal(hasPickerTimelineStart(row), false);
  }
  for (const lag of [30 * 60_000, 30 * 60_000 + 1]) {
    const row = seed([pack("k100_h5", NOW - lag, true), pack("v6_query", NOW, false)]);
    assert.equal(hasTimelineStartBeforeKdniao(row), lag === 30 * 60_000,
      "the existing thirty-minute time-alignment boundary is unchanged");
  }
  const conflict = pack("k100_h5", NOW, true, "COMPLETED");
  conflict.tracks[0].statusCode = "PICKED";
  assert.equal(hasTimelineStartBeforeKdniao(seed([conflict])), false,
    "a latest structured pickup node contradicts displayed completion");
  const undated = pack("k100_h5", NOW - HOUR, true, "COMPLETED");
  undated.statusEventAtMs = null;
  assert.equal(hasTimelineStartBeforeKdniao({ ...seed([undated]), timeline: undated }), false,
    "undated completion cannot close the query chain");
  const future = pack("k100_h5", NOW + HOUR, true, "COMPLETED");
  assert.equal(hasTimelineStartBeforeKdniao(seed([future])), false,
    "future completion cannot close the query chain");
  const noTime = pack("k100_h5", 0, true);
  assert.equal(hasTimelineStartBeforeKdniao({ ...seed([noTime]), timeline: noTime }), false,
    "SF's coarse feed cannot provide the missing manual reference clock");
  const sameWaybill = pack("k100_h5", NOW - 10 * HOUR, true);
  const unrelated = { ...pack("v6_query", NOW, false), waybill: "UNRELATED123456" };
  assert.equal(hasTimelineStartBeforeKdniao({ ...seed([sameWaybill, unrelated]), timeline: sameWaybill }), true,
    "a different waybill cannot advance this parcel's reference clock");
  assert.equal(hasPickerTimelineStart({ ...seed([unrelated]), timeline: sameWaybill }), false,
    "a different waybill cannot stop this parcel's primary round");

  for (const aligned of [false, true]) {
    memory.clear();
    const oldStart = pack("k100_h5", NOW - 10 * HOUR, true);
    const current = pack("v6_query", NOW, false, "COMPLETED");
    const original = saveState({ ...emptyState(), shipments: [seed([oldStart, current])], bindings: [
      { source: "interface5", phone: "13800001234", boundAtMs: NOW - 30 * HOUR },
    ] }, NOW).shipments[0]!;
    const calls: string[] = [];
    const h5 = pack("k100_h5", aligned ? NOW : NOW - 10 * HOUR, !aligned, "UNKNOWN");
    h5.structuredStatus = false;
    h5.statusEventAtMs = null;
    await runShipmentRefreshForTesting(original.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { assert.fail("SF must retain its existing manual chain"); },
        refreshWebTimeline: async () => { calls.push("h5"); return { ...original,
          timeline: h5, sourceTimeline: null, manualTimelines: [h5] }; },
        queryManualForSource: async input => {
          assert.equal(input.fallbackOnly, true);
          calls.push("kdniao");
          return { shipment: null, pending: null, routeUrl: "" };
        },
      });
    assert.deepEqual(calls, aligned ? ["h5"] : ["h5", "kdniao"],
      "this round's accumulated H5 history must align before it can stop paid fallback");
    assert.equal(loadState(NOW).shipments[0]!.manualTimelines?.find(t => t.provider === "v6_query")?.tracks.length, 1,
      "each provider retains its own packet");
  }
  memory.clear();
  const cachedOrigin = pack("v6_query", NOW - 10 * HOUR, true);
  const original = saveState({ ...emptyState(), shipments: [seed([cachedOrigin])], bindings: [
    { source: "interface5", phone: "13800001234", boundAtMs: NOW - 30 * HOUR },
  ] }, NOW).shipments[0]!;
  assert.equal(hasTimelineStartBeforeKdniao(original), true,
    "cached origin is aligned before this round discovers a newer event");
  const calls: string[] = [];
  const freshPartial = pack("k100_h5", NOW, false);
  await runShipmentRefreshForTesting(original.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
    { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async () => { calls.push("h5"); return { ...original,
        timeline: freshPartial, sourceTimeline: null, manualTimelines: [freshPartial] }; },
      queryManualForSource: async input => {
        assert.equal(input.fallbackOnly, true);
        calls.push("kdniao");
        return { shipment: null, pending: null, routeUrl: "" };
      },
    });
  assert.deepEqual(calls, ["h5", "kdniao"],
    "a new primary response must invalidate an older cached origin before the fallback decision");
} finally { Date.now = actualNow; }
console.log("manual stop alignment tests passed");
