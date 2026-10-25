import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, loadState, removeShipment, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import { OperationTimeoutError } from "../services/deadline";
import type { Shipment, StatusSemantic, TimelinePackage } from "../models";
import { applyManualShipment, applyTargetedAccountShipment, hasPickerTimelineStart,
  hasTimelineStartBeforeKdniao, selectShipmentDetailTimeline, selectShipmentTimeline, shipmentDetailIncompleteReason,
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
function mixedHistory(): Shipment {
  const history = { ...packet("k100_h5", old, "UNKNOWN"), structuredStatus: false,
    statusEventAtMs: null, tracks: packet("k100_h5", old, "UNKNOWN").tracks.map(track => ({ ...track, statusCode: "" })) };
  const before = row(history);
  before.manualTimelines = [history, packet("kdniao", recent, "DELIVERY")];
  before.timeline = selectShipmentTimeline(before);
  assert.equal(before.timeline.provider, "k100_h5");
  assert.equal(before.timeline.semantic, "DELIVERY");
  assert.equal(before.timeline.statusEventAtMs, recent);
  return before;
}
for (const response of ["query_failed", "empty_response", "success"] as const)
test(`Online ${response} rebase never writes displayed SF status into the K100 cache`, async () => {
  memory.clear();
  const before = mixedHistory();
  const saved = saveState({ ...emptyState(), shipments: [before], bindings: [
    { source: "interface5", phone: before.identity.phone!, boundAtMs: old - 86_400_000 },
  ] }, NOW).shipments[0]!;
  const originalHistory = saved.manualTimelines!.find(timeline => timeline.provider === "k100_h5")!;
  let stageShipment: Shipment | undefined;
  const output = await runShipmentRefreshForTesting(saved.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
    { trigger: "manual_submit", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async shipment => {
        stageShipment = shipment;
        return null;
      },
      queryManualForSource: async input => ({ shipment: input.pickerOnly && response === "success"
        ? incoming(saved, packet("v6_query", old, "TRANSIT")) : null,
        pending: null, routeUrl: "", result: response }),
    });
  assert.ok(stageShipment);
  assert.deepEqual(stageShipment.manualTimelines!.find(timeline => timeline.provider === "k100_h5"), originalHistory);
  assert.deepEqual(output.shipment.manualTimelines!.find(timeline => timeline.provider === "k100_h5"), originalHistory);
  assert.equal(output.shipment.timeline.semantic, "DELIVERY");
  assert.deepEqual(output.state, loadState());
});
test("an account-only SF wait does not invent a manual feed cache", async () => {
  memory.clear();
  const before = row(packet("interface5", old, "TRANSIT"));
  before.sourceTimeline = before.timeline;
  before.manualTimelines = [];
  const saved = saveState({ ...emptyState(), shipments: [before], bindings: [
    { source: "interface5", phone: before.identity.phone!, boundAtMs: old - 86_400_000 },
  ] }, NOW).shipments[0]!;
  let stageShipment: Shipment | undefined;
  await runShipmentRefreshForTesting(saved.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
    { trigger: "manual_submit", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async shipment => { stageShipment = shipment; return null; },
      queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "", result: "query_failed" }),
    });
  assert.ok(stageShipment);
  assert.deepEqual(stageShipment.manualTimelines, []);
  assert.deepEqual(loadState().shipments[0]!.manualTimelines, []);
});
for (const response of ["query_failed", "empty_response", "timeout", "success"] as const)
test(`SF fallback selection survives cached rebase until an actual ${response} response`, async () => {
  memory.clear();
  const before = row(packet("v5_query", old, "TRANSIT"));
  before.detailSelection = { provider: "v5_query", selectedAtMs: old, reason: "sf_refresh_failed" };
  const saved = saveState({ ...emptyState(), shipments: [before], bindings: [
    { source: "interface5", phone: before.identity.phone!, boundAtMs: old - 86_400_000 },
  ] }, NOW).shipments[0]!;
  const expected = response === "success" ? undefined : "sf_refresh_failed";
  let stageShipment: Shipment | undefined;
  const output = await runShipmentRefreshForTesting(saved.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
    { trigger: "manual_submit", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async shipment => { stageShipment = shipment; return null; },
      queryManualForSource: async input => {
        if (input.pickerOnly && response === "timeout") throw new OperationTimeoutError();
        return { shipment: input.pickerOnly && response === "success"
          ? incoming(saved, packet("v6_query", recent, "TRANSIT")) : null,
          pending: null, routeUrl: "", result: response === "timeout" ? "query_failed" : response };
      },
    });
  assert.ok(stageShipment);
  assert.equal(stageShipment.detailSelection?.reason, expected);
  assert.equal(output.shipment.detailSelection?.reason, expected);
});
for (const during of ["online", "h5"] as const)
test(`mixed-package SF cache provenance survives a concurrent commit during ${during}`, async () => {
  memory.clear();
  const before = mixedHistory();
  const saved = saveState({ ...emptyState(), shipments: [before], bindings: [
    { source: "interface5", phone: before.identity.phone!, boundAtMs: old - 86_400_000 },
  ] }, NOW).shipments[0]!;
  const originalHistory = saved.manualTimelines!.find(timeline => timeline.provider === "k100_h5")!;
  const newer = packet("kdniao", recent + 1, "DELIVERY");
  const advance = () => {
    const state = loadState();
    saveState({ ...state, shipments: [applyManualShipment(state.shipments[0]!, incoming(saved, newer), NOW)] }, NOW);
  };
  const output = await runShipmentRefreshForTesting(saved.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
    { trigger: "manual_submit", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async () => { if (during === "h5") advance(); return null; },
      queryManualForSource: async input => {
        if (input.pickerOnly) {
          if (during === "online") advance();
          return { shipment: incoming(saved, packet("v6_query", old, "TRANSIT")),
            pending: null, routeUrl: "", result: "success" };
        }
        return { shipment: null, pending: null, routeUrl: "", result: "empty_response" };
      },
    });
  assert.deepEqual(output.shipment.manualTimelines!.find(timeline => timeline.provider === "k100_h5"), originalHistory);
  assert.equal(output.shipment.manualTimelines!.find(timeline => timeline.provider === "kdniao")?.statusEventAtMs, recent + 1);
  assert.ok(output.shipment.manualTimelines!.some(timeline => timeline.provider === "v6_query"));
  assert.equal(output.shipment.timeline.semantic, "DELIVERY");
  assert.equal(output.shipment.timeline.statusEventAtMs, recent + 1);
  assert.deepEqual(output.state, loadState());
});
for (const acceptedAt of [NOW, NOW + 1])
test(`the SF accepted status guard validates the current-clock boundary ${acceptedAt}`, () => {
  const before = row(packet("kdniao", acceptedAt, "DELIVERY"));
  before.manualTimelines = [];
  const after = applyManualShipment(before, incoming(before, packet("v6_query", recent, "TRANSIT", true)), NOW);
  assert.equal(after.timeline.semantic, acceptedAt > NOW ? "TRANSIT" : "DELIVERY");
  assert.equal(after.timeline.statusEventAtMs, acceptedAt > NOW ? recent : acceptedAt);
});
for (const acceptedAt of [NOW, NOW + 1])
test(`the SF completeness reference validates the current-clock boundary ${acceptedAt}`, () => {
  const history = packet("v6_query", NOW - 31 * 60_000, "DELIVERY", true);
  const before = row({ ...history, statusEventAtMs: acceptedAt });
  before.manualTimelines = [history];
  before.sourceTimeline = packet("interface5", NOW - 31 * 60_000, "DELIVERY");
  assert.equal(hasPickerTimelineStart(before), acceptedAt > NOW);
  assert.equal(hasTimelineStartBeforeKdniao(before), acceptedAt > NOW);
});
for (const futureNode of [false, true]) test(`SF reference excludes future evidence while raw sticky ordering stays unchanged (future node: ${futureNode})`, () => {
  const cached = { ...packet("k100_h5", old, "TRANSIT"), statusEventAtMs: NOW + 60_000 };
  if (futureNode) {
    cached.tracks.unshift({ ...packet("k100_h5", NOW + 60_000, "TRANSIT").tracks[0]!, statusCode: "" });
    cached.latestTimeText = String(NOW + 60_000);
  }
  const online = packet("v6_query", recent, "TRANSIT", true);
  const before = row(cached);
  before.manualTimelines = [cached, online];
  assert.equal(selectShipmentDetailTimeline(before).provider, futureNode ? "k100_h5" : "v6_query");
  assert.equal(hasPickerTimelineStart(before), true);
  assert.equal(shipmentDetailCandidateEvidence(before, online).detailComplete, true);
  assert.equal(cached.statusEventAtMs, NOW + 60_000);
});
test("SF stop checks retain valid newer nodes beneath a future provider node", () => {
  const cached = packet("k100_h5", NOW + 60_000, "TRANSIT");
  cached.tracks = [
    { ...cached.tracks[0]!, statusCode: "" },
    { ...packet("k100_h5", recent, "TRANSIT").tracks[0]!, statusCode: "" },
  ];
  const online = packet("v6_query", recent - 60 * 60_000, "TRANSIT", true);
  const before = row(cached);
  before.manualTimelines = [cached, online];
  assert.equal(hasPickerTimelineStart(before), false);
  assert.equal(hasTimelineStartBeforeKdniao(before), false);
  assert.equal(shipmentDetailCandidateEvidence(before, online).incompleteReason, "time_mismatch");
  assert.equal(cached.tracks[0]!.timeMs, NOW + 60_000);
});
test("a future accepted signing preserves terminal status without certifying transit history", () => {
  const before = row(packet("kdniao", NOW + 1, "COMPLETED"));
  before.manualTimelines = [];
  const after = applyManualShipment(before, incoming(before, packet("v6_query", recent, "TRANSIT", true)), NOW);
  assert.equal(after.timeline.semantic, "COMPLETED");
  assert.equal(shipmentDetailIncompleteReason(after), "missing_source_time");
  assert.equal(hasPickerTimelineStart(after), false);
  assert.equal(hasTimelineStartBeforeKdniao(after), false);
  assert.equal(signedTripleReached(after, NOW), false);
});
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
test("an old account snapshot cannot reset accepted SF state when manual caches are absent", () => {
  const before = row();
  before.manualTimelines = [];
  const feed = packet("interface5", old, "TRANSIT");
  const after = applyTargetedAccountShipment(before,
    { ...before, timeline: feed, sourceTimeline: feed, manualTimelines: [] }, NOW);
  assert.equal(after.timeline.semantic, "DELIVERY");
  assert.equal(after.timeline.statusEventAtMs, recent);
  assert.deepEqual(after.manualTimelines, [], "accepted status does not fabricate provider caches");
  assert.equal(after.sourceTimeline?.statusEventAtMs, old, "raw account evidence stays independent");
});
for (const acceptedAt of [recent, NOW + 1])
test(`account state can advance without manual caches from accepted clock ${acceptedAt}`, () => {
  const before = row(packet("kdniao", acceptedAt, "DELIVERY"));
  before.manualTimelines = [];
  const feed = packet("interface5", recent + 1, "TRANSIT");
  const after = applyTargetedAccountShipment(before,
    { ...before, timeline: feed, sourceTimeline: feed, manualTimelines: [] }, NOW);
  assert.equal(after.timeline.semantic, "TRANSIT");
  assert.equal(after.timeline.statusEventAtMs, recent + 1);
  assert.deepEqual(after.manualTimelines, []);
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
test("a future incoming SF clock cannot supersede the valid accepted pair", () => {
  const before = row(packet("interface5", recent, "TRANSIT"));
  before.sourceTimeline = before.timeline; before.manualTimelines = [];
  const after = applyManualShipment(before, incoming(before, packet("v6_query", NOW + 3600000, "DELIVERY")), NOW);
  assert.equal(after.timeline.semantic, "TRANSIT");
  assert.equal(after.timeline.statusEventAtMs, recent);
  assert.equal(after.manualTimelines?.find(p => p.provider === "v6_query")?.statusEventAtMs, NOW + 3600000);
});
test("an undated structured signing can replace undated transit", () => {
  const before = row(packet("kdniao", 0, "TRANSIT")); before.manualTimelines = [];
  before.sourceTimeline = packet("interface5", 0, "TRANSIT");
  const after = applyManualShipment(before, incoming(before, packet("v6_query", 0, "COMPLETED")), NOW);
  assert.equal(after.timeline.semantic, "COMPLETED");
  assert.equal(after.timeline.statusEventAtMs || 0, 0);
  assert.equal(signedTripleReached(after, NOW), false);
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
