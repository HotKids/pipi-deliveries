import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, loadState, removeShipment, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import type { Shipment, StatusSemantic, TimelinePackage } from "../models";
import { applyManualShipment, applyTargetedAccountShipment, hasPickerTimelineStart,
  hasTimelineStartBeforeKdniao, selectShipmentDetailTimeline, shipmentDetailIncompleteReason,
  shipmentDetailCandidateEvidence, signedTripleReached } from "../services/shipment-policy";

const waybill = "SFONLINE20261024", recent = NOW - 60_000, old = recent - 10 * 60_000;
const clock = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = clock; });
function packet(provider: string, at: number, semantic: StatusSemantic, start = false): TimelinePackage {
  return { provider, waybill, courierCode: "SF", companyName: "SF", semantic,
    structuredStatus: true, statusEventAtMs: at, latestTimeText: String(at), latestDetail: "Synthetic parcel event",
    successAtMs: NOW, complete: start, tracks: [
      { timeText: String(at), timeMs: at, detail: "Synthetic parcel event", statusCode: semantic, raw: {} },
      ...(start ? [{ timeText: String(at - 60_000), timeMs: at - 60_000, detail: "已揽收", statusCode: "PICKED", raw: {} }] : []),
    ] };
}
function row(selected = packet("kdniao", recent, "DELIVERY")): Shipment {
  return { identity: { id: "interface5:account:synthetic-online", sourceId: waybill,
    bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng", courierCode: "SF",
    rawCourierCode: "SF", companyName: "SF", phone: "13800001234", phoneTail: "1234",
    manuallyAdded: false, createdAtMs: old - 86_400_000 },
    timeline: selected, sourceTimeline: packet("interface5", old, "PICKED"), manualTimelines: [selected],
    detailSelection: { provider: selected.provider, selectedAtMs: NOW - 1_000 }, updatedAtMs: NOW };
}
function incoming(base: Shipment, timeline: TimelinePackage): Shipment {
  return { ...base, timeline, sourceTimeline: null, manualTimelines: [timeline], detailSelection: undefined };
}
for (const semantic of ["TRANSIT", "DELIVERY"] as const) test(`older complete Online cannot replace the selected newer partial manual packet (${semantic})`, () => {
  memory.clear();
  const before = row();
  const online = packet("v6_query", old, semantic, true);
  const after = applyManualShipment(before, incoming(before, online), NOW);
  const selected = selectShipmentDetailTimeline(after);
  assert.equal(selected.provider, "kdniao");
  assert.equal(selected.semantic, "DELIVERY");
  assert.equal(selected.statusEventAtMs, recent);
  assert.deepEqual(selected.tracks, before.timeline.tracks);
  assert.equal(after.manualTimelines?.find(p => p.provider === "v6_query")?.tracks.length, 2,
    "the old Online packet stays in its own history cache");
});
for (const at of [old, recent]) test(`accepted SF state survives a conflicting Online result at ${at}`, () => {
  const before = { ...row(), detailSelection: undefined, manualTimelines: [] };
  const after = applyManualShipment(before, incoming(before, packet("v6_query", at, "TRANSIT", true)), NOW);
  assert.equal(after.timeline.semantic, "DELIVERY");
  assert.equal(after.timeline.statusEventAtMs, recent);
});
test("a newer structured result advances state and a newer complete Online packet can replace partial history", () => {
  const before = row();
  const after = applyManualShipment(before, incoming(before, packet("v6_query", recent + 1, "COMPLETED", true)), NOW);
  assert.equal(after.timeline.semantic, "COMPLETED");
  assert.equal(after.timeline.statusEventAtMs, recent + 1);
  assert.equal(selectShipmentDetailTimeline(after).provider, "v6_query");
});
test("an ordinary old account snapshot cannot reset the accepted manual state baseline", () => {
  const before = row();
  const online = packet("v6_query", old, "TRANSIT", true);
  before.manualTimelines = [online]; before.detailSelection = { provider: "v6_query", selectedAtMs: NOW };
  const feed = packet("interface5", old, "TRANSIT");
  const after = applyTargetedAccountShipment(before, { ...before, timeline: feed, sourceTimeline: feed, manualTimelines: [] }, NOW);
  assert.equal(after.timeline.semantic, "DELIVERY");
  assert.equal(after.timeline.statusEventAtMs, recent);
});
for (const lag of [30 * 60_000, 30 * 60_000 + 1]) test(`SF stop gate includes accepted status clock at lag ${lag}`, () => {
  const online = packet("v6_query", recent - lag, "DELIVERY", true);
  const before = row(); before.manualTimelines = [online];
  assert.equal(hasPickerTimelineStart(before), lag === 30 * 60_000);
  assert.equal(hasTimelineStartBeforeKdniao(before), lag === 30 * 60_000);
});
test("a same-clock conflicting origin cannot stop the permitted remaining query chain", () => {
  const before = row(); before.manualTimelines = [packet("v6_query", recent, "TRANSIT", true)];
  assert.equal(hasPickerTimelineStart(before), false);
  assert.equal(hasTimelineStartBeforeKdniao(before), false);
});
test("known zero-clock status stays paired while an unknown status can initialize", () => {
  for (const semantic of ["DELIVERY", "UNKNOWN"] as const) {
    const before = row(packet("kdniao", 0, semantic)); before.manualTimelines = [];
    const after = applyManualShipment(before, incoming(before, packet("v6_query", 0, "TRANSIT")), NOW);
    assert.equal(after.timeline.semantic, semantic === "UNKNOWN" ? "TRANSIT" : "DELIVERY");
  }
});
test("an account's same-clock structured correction is still accepted", () => {
  const before = row(packet("kdniao", recent, "TRANSIT"));
  const source = packet("interface5", recent, "DELIVERY");
  const after = applyTargetedAccountShipment(before, { ...before, timeline: source, sourceTimeline: source, manualTimelines: [] }, NOW);
  assert.equal(after.timeline.semantic, "DELIVERY");
  assert.equal(after.timeline.statusEventAtMs, recent);
});
for (const at of [old, recent]) test(`another eligible manual node vetoes conflicting Online completeness at ${at}`, () => {
  const online = packet("v6_query", old, "TRANSIT", true);
  const before = row(online);
  const after = applyManualShipment(before, incoming(before, packet("kdniao", at, "DELIVERY")), NOW);
  assert.equal(selectShipmentDetailTimeline(after).provider, "v6_query", "two incomplete packets keep their prior sticky history");
  assert.equal(shipmentDetailCandidateEvidence(after, online).incompleteReason, "status_mismatch");
  assert.equal(hasPickerTimelineStart(after), false);
  assert.equal(hasTimelineStartBeforeKdniao(after), false);
});
test("a newer complete KDNiao packet still advances the accepted status and replaces old Online", () => {
  const before = row(packet("v6_query", old, "TRANSIT", true));
  const after = applyManualShipment(before, incoming(before, packet("kdniao", recent, "DELIVERY", true)), NOW);
  assert.equal(after.timeline.semantic, "DELIVERY");
  assert.equal(after.timeline.statusEventAtMs, recent);
  assert.equal(selectShipmentDetailTimeline(after).provider, "kdniao");
  assert.equal(shipmentDetailCandidateEvidence(after, selectShipmentDetailTimeline(after)).detailComplete, true);
});
for (const sourcePresent of [true, false]) test(`signed completeness includes accepted clock with source ${sourcePresent}`, async () => {
  memory.clear();
  const history = packet("v6_query", recent - 30 * 60_000 - 1, "COMPLETED", true);
  const before = row({ ...history, statusEventAtMs: recent });
  before.manualTimelines = [history];
  before.sourceTimeline = sourcePresent ? packet("interface5", old, "COMPLETED") : null;
  const saved = saveState({ ...emptyState(), shipments: [before], bindings: [
    { source: "interface5", phone: before.identity.phone!, boundAtMs: old - 86_400_000 },
  ] }, NOW).shipments[0]!;
  assert.equal(shipmentDetailIncompleteReason(saved), "time_mismatch");
  assert.equal(signedTripleReached(saved, NOW), false);
  const calls: string[] = [];
  await runShipmentRefreshForTesting(saved.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
    { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async () => { calls.push("h5"); return null; },
      queryManualForSource: async input => {
        assert.equal(input.fallbackOnly, true); calls.push("kdniao");
        return { shipment: null, pending: null, routeUrl: "" };
      },
    });
  assert.deepEqual(calls, ["h5", "kdniao"]);
});
for (const newerProvider of ["coarse", "manual"] as const) test(`signed completeness uses eligible manual clocks instead of ${newerProvider} drift`, () => {
  const at = recent - 30 * 60_000 - 1;
  const signed = packet("v6_query", at, "COMPLETED", true);
  const before = row(signed);
  before.sourceTimeline = { ...packet("interface5", newerProvider === "coarse" ? recent : at, "UNKNOWN"),
    structuredStatus: false, statusEventAtMs: null };
  if (newerProvider === "manual") before.manualTimelines!.push({ ...packet("k100_h5", recent, "UNKNOWN"),
    structuredStatus: false, statusEventAtMs: null });
  assert.equal(shipmentDetailIncompleteReason(before), newerProvider === "coarse" ? null : "time_mismatch");
});
for (const [previous, next] of [["TRANSIT", "DELIVERY"], ["DELIVERY", "DELIVERY"], ["DELIVERY", "TRANSIT"]] as const)
test(`the actual refresh accepts a newer complete Online result (${previous} to ${next})`, async () => {
  memory.clear();
  const original = row(packet("k100_h5", old, previous));
  saveState({ ...emptyState(), shipments: [original], bindings: [
    { source: "interface5", phone: original.identity.phone!, boundAtMs: old - 86_400_000 },
  ] }, NOW);
  const output = await runShipmentRefreshForTesting(original.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
    { trigger: "manual_submit", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async () => { assert.fail("a current aligned Online packet retains the existing stop rule"); },
      queryManualForSource: async input => {
        assert.equal(input.pickerOnly, true);
        return { shipment: incoming(original, packet("v6_query", recent, next, true)),
          pending: null, routeUrl: "", result: "success" };
      },
    });
  assert.equal(output.shipment.timeline.semantic, next);
  assert.equal(output.shipment.timeline.statusEventAtMs, recent);
  assert.equal(selectShipmentDetailTimeline(output.shipment).provider, "v6_query");
  assert.deepEqual(output.state, loadState());
});
for (const duringWait of ["newer", "same-clock", "delete", "reimport", "rebind", "empty", "failed"] as const) {
  test(`the actual refresh reloads ${duringWait} accepted during Online`, async () => {
    memory.clear();
    const before = row(packet("k100_h5", old, "TRANSIT"));
    const binding = { source: "interface5" as const, phone: before.identity.phone!, boundAtMs: old - 86_400_000 };
    const original = saveState({ ...emptyState(), shipments: [before], bindings: [binding] }, NOW).shipments[0]!;
    const calls: string[] = [];
    const result = runShipmentRefreshForTesting(original.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
      { trigger: "manual_submit", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshWebTimeline: async () => { calls.push("h5"); return null; },
        queryManualForSource: async input => {
          if (input.fallbackOnly) {
            calls.push("kdniao"); return { shipment: null, pending: null, routeUrl: "" };
          }
          assert.equal(input.pickerOnly, true); calls.push("online");
          if (duringWait === "delete") removeShipment(original.identity.id, NOW);
          else {
            const changed = row(packet("kdniao", duringWait === "same-clock" ? old : recent, "DELIVERY"));
            if (duringWait === "reimport") changed.identity.createdAtMs++;
            saveState({ ...loadState(), shipments: [changed], bindings: [duringWait === "rebind"
              ? { ...binding, boundAtMs: binding.boundAtMs + 1 } : binding] }, NOW);
          }
          return { shipment: ["empty", "failed"].includes(duringWait) ? null
              : incoming(original, packet("v6_query", old, "TRANSIT", true)),
            pending: null, routeUrl: "", result: duringWait === "failed" ? "query_failed"
              : duringWait === "empty" ? "empty_response" : "success" };
        },
      });
    if (duringWait === "delete") await assert.rejects(result);
    else {
      const output = await result;
      assert.equal(output.shipment.timeline.semantic, "DELIVERY");
      assert.equal(output.shipment.timeline.statusEventAtMs, duringWait === "same-clock" ? old : recent);
      assert.deepEqual(output.state, loadState());
    }
    assert.deepEqual(calls, ["delete", "reimport", "rebind"].includes(duringWait)
      ? ["online"] : ["online", "h5", "kdniao"]);
  });
}
for (const duringWait of ["newer", "same-clock", "delete", "reimport", "rebind"] as const) {
  test(`the actual refresh stop boundary sees ${duringWait} accepted during H5`, async () => {
    memory.clear();
    const before = row(packet("k100_h5", old, "TRANSIT"));
    const binding = { source: "interface5" as const, phone: before.identity.phone!, boundAtMs: old - 86_400_000 };
    const original = saveState({ ...emptyState(), shipments: [before], bindings: [binding] }, NOW).shipments[0]!;
    const calls: string[] = [];
    const result = runShipmentRefreshForTesting(original.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshWebTimeline: async () => {
          calls.push("h5");
          if (duringWait === "delete") removeShipment(original.identity.id, NOW);
          else {
            const changed = row(packet("kdniao", duringWait === "same-clock" ? old : recent, "DELIVERY"));
            if (duringWait === "reimport") changed.identity.createdAtMs++;
            saveState({ ...loadState(), shipments: [changed], bindings: [duringWait === "rebind"
              ? { ...binding, boundAtMs: binding.boundAtMs + 1 } : binding] }, NOW);
          }
          return incoming(original, packet("k100_h5", old, "TRANSIT", true));
        },
        queryManualForSource: async input => {
          assert.equal(input.fallbackOnly, true); calls.push("kdniao");
          return { shipment: null, pending: null, routeUrl: "" };
        },
      });
    if (duringWait === "delete") await assert.rejects(result);
    else {
      const output = await result;
      assert.equal(output.shipment.timeline.semantic, "DELIVERY");
      assert.deepEqual(output.state, loadState());
    }
    assert.deepEqual(calls, duringWait === "newer" || duringWait === "same-clock" ? ["h5", "kdniao"] : ["h5"]);
  });
}
