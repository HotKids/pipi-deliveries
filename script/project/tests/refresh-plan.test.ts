import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import { emptyState, saveState, loadState, commitRefreshState, commitTargetShipmentRefresh, removeBinding } from "../services/storage";
import { runShipmentEnrichmentForTesting, runShipmentRefreshForTesting } from "../services/sync";
import { sortShipments } from "../services/status";
import { applyManualShipment, applySameSourceTimeline, selectShipmentDetailTimeline } from "../services/shipment-policy";
import { manualProviderSchedule } from "../services/manual-query";
import { recordRefreshProviderResult } from "../services/refresh-runtime-state";

const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });
function row(provider: string, id = "123456789012", count = 1, unknown = false): Shipment {
  const waybill = `${provider === "ShunFeng" ? "SF" : "YT"}${id}`;
  const pack: TimelinePackage = {
    provider: "v5_list", waybill, courierCode: "YTO", companyName: "Carrier",
    semantic: unknown ? "UNKNOWN" : "TRANSIT", structuredStatus: !unknown,
    latestDetail: "Parcel in transit", latestTimeText: String(NOW - 60000), successAtMs: NOW,
    tracks: Array.from({ length: count }, (_, i) => ({ timeMs: NOW - 60000 - i * 1000,
      timeText: String(NOW - 60000 - i * 1000), detail: "Parcel in transit", statusCode: "", raw: {} })),
  };
  const manual = provider === "manual";
  return { identity: { id: `interface5:${manual ? "manual" : "account"}:${waybill}`, sourceId: waybill,
    bindingSource: "interface5", sourceProvider: manual ? "" : provider, sourceOwner: "interface5:parcel",
    manuallyAdded: manual, courierCode: "YTO", rawCourierCode: "YTO", companyName: "Carrier",
    phone: "13800001234", phoneTail: "1234", createdAtMs: NOW - 86400000 },
    timeline: pack, sourceTimeline: manual ? null : pack, manualTimelines: [], updatedAtMs: NOW - 60000,
    accountRecord: manual ? null : { waybill, provider, companyCode: "YTO", phone: "13800001234" } };
}
function seed(rows: Shipment[]) {
  memory.clear();
  return saveState({ ...emptyState(), shipments: rows, bindings: [
    { source: "interface5", phone: "13800001234", boundAtMs: NOW - 86400000 },
  ] }, NOW);
}

test("list sends Online only for manual, SF, missing status or missing tracks", async () => {
  const rows = [row("manual", "523456789012"), row("ShunFeng"), row("JingDong"),
    row("CaiNiao", "223456789012"), row("CaiNiao", "323456789012", 0),
    row("JingDong", "423456789012", 1, true)];
  const state = seed(rows);
  const calls: string[] = [];
  let base = state;
  const result = await runShipmentEnrichmentForTesting(state, "interface5", "list-plan", (candidate, _routes, _stage, jobBase) => {
    base = commitRefreshState(jobBase || base, candidate, "interface5", NOW).state;
    return base;
  }, NOW + 30000, new Set(), true, true, undefined, {
    refreshAccountParcel: async () => { assert.fail("list must not query v5 detail"); },
    queryManualForSource: async input => {
      assert.equal(input.pickerOnly, true);
      assert.equal(input.includeKdniaoFallback, false);
      calls.push(input.currentShipment!.identity.id);
      return { shipment: null, pending: null, routeUrl: "" };
    },
  });
  assert.deepEqual(calls.sort(), [rows[0], rows[1], rows[4], rows[5]].map(s => s.identity.id).sort());
  assert.equal(result.failed, 4);
});

test("scheduled Online cooldown skips the query before any shipment lease write", async () => {
  const original = row("ShunFeng");
  const state = seed([original]);
  recordRefreshProviderResult({ ...manualProviderSchedule({ source: "interface5",
    waybill: original.identity.sourceId, rawCourierCode: original.identity.rawCourierCode,
    phoneTail: original.identity.phoneTail, sourceProvider: original.identity.sourceProvider }),
    provider: "picker", result: "upstream_rejected", now: NOW });
  const stages: string[] = [];
  const result = await runShipmentEnrichmentForTesting(state, "interface5", "cooldown-preflight",
    (candidate, _routes, stage) => { stages.push(stage); return candidate; },
    NOW + 30000, new Set(), false, false, undefined, {
      queryManualForSource: async () => { assert.fail("a cooling provider must not be queried"); },
    });
  assert.deepEqual(stages, []);
  assert.equal(result.attempted, 0);
  assert.equal(result.failed, 0);
  assert.equal(loadState(NOW).revision, state.revision);
});

for (const provider of ["manual", "ShunFeng", "JingDong", "CaiNiao"]) {
  test(`${provider} detail open has only its allowed entry request`, async () => {
    const current = seed([row(provider)]).shipments[0];
    let accountCalls = 0;
    await runShipmentRefreshForTesting(current.identity.id, { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
      { trigger: "detail_open", includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { accountCalls++; return null; },
        queryManualForSource: async () => { assert.fail("detail entry must not start manual providers"); },
      });
    assert.equal(accountCalls, provider === "JingDong" || provider === "CaiNiao" ? 1 : 0);
  });
  test(`${provider} detail pull never requests v5 or v6`, async () => {
    const current = seed([row(provider)]).shipments[0];
    await runShipmentRefreshForTesting(current.identity.id, { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { assert.fail("pull must not start v5"); },
        queryManualForSource: async input => {
          assert.notEqual(input.pickerOnly, true, "pull must not start v6 even after another provider fails");
          return { shipment: null, pending: null, routeUrl: "" };
        },
      });
  });
}
test("equal event times keep row order across different completion times", () => {
  const a = row("manual", "123456789012");
  const b = row("manual", "223456789012");
  const ids = (rows: Shipment[]) => sortShipments(rows).map(s => s.identity.id);
  assert.deepEqual(ids([{ ...a, updatedAtMs: NOW + 10 }, b]), ids([a, { ...b, updatedAtMs: NOW + 20 }]));
});

function captured(current: Shipment, provider: string, pickup = false): Shipment {
  const timeline = { ...current.timeline, provider, complete: true, tracks: [
    { ...current.timeline.tracks[0], detail: "New carrier event", timeMs: NOW, timeText: String(NOW) },
    { ...current.timeline.tracks[0], detail: pickup ? "已揽收" : "Another carrier event" },
  ] };
  return applySameSourceTimeline(current, timeline, NOW);
}

for (const source of ["CaiNiao", "JingDong"]) {
  for (const response of ["none", "expanded", "pickup"] as const) {
    test(`${source} ${response} H5 uses pickup evidence to gate the free primary round`, async () => {
      let original = row(source);
      if (source === "JingDong") {
        original = { ...original, identity: { ...original.identity, accountOrder: true,
          sourceId: "361000000000001", orderId: "361000000000001", projectedWaybill: original.identity.sourceId },
          accountRecord: { ...original.accountRecord!, waybill: "361000000000001" } };
        // A cached JD capture exercises the same continuation gate without a live page URL.
        if (response !== "none") original = captured(original, "jd_h5", response === "pickup");
      }
      const current = seed([original]).shipments[0];
      const calls: string[] = [];
      const result = await runShipmentRefreshForTesting(current.identity.id,
        { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
        { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
          refreshAccountParcel: async () => { calls.push("v5_query"); return null; },
          refreshCainiaoH5: async s => {
            calls.push("cn_h5");
            return response === "none" ? null : captured(s, "cn_h5", response === "pickup");
          },
          refreshWebTimeline: async () => { calls.push("primary_h5"); return null; },
          queryManualForSource: async input => {
            calls.push(input.motoOnly ? "v4_query" : input.fallbackOnly ? "kdniao" : "v6_query");
            return { shipment: null, pending: null, routeUrl: "" };
          },
        });
      const primary = response === "pickup" ? [] : source === "CaiNiao"
        ? ["v4_query", "primary_h5", "kdniao"] : ["primary_h5", "kdniao"];
      assert.deepEqual(calls, source === "CaiNiao" ? ["cn_h5", ...primary] : primary);
      if (response === "expanded") assert.ok(result.shipment.manualTimelines?.some(p =>
        p.provider === (source === "CaiNiao" ? "cn_h5" : "jd_h5") && p.tracks.length >= 2),
        "useful partial history survives even when the next providers fail");
    });
  }
}

for (const cachedQuery of [false, true]) {
  test(`SF failed detail preserves eligible manual history with v5_query present (${cachedQuery})`, async () => {
    let original = row("ShunFeng");
    if (cachedQuery) original = captured(original, "v5_query");
    original = captured(original, "kdniao");
    const current = seed([original]).shipments[0];
    const before = selectShipmentDetailTimeline(current);
    const calls: string[] = [];
    const result = await runShipmentRefreshForTesting(current.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { calls.push("v5_query"); return null; },
        refreshWebTimeline: async () => { calls.push("primary_h5"); return null; },
        queryManualForSource: async input => {
          calls.push(input.fallbackOnly ? "kdniao" : "unexpected");
          return { shipment: null, pending: null, routeUrl: "" };
        },
      });
    assert.deepEqual(calls, ["primary_h5", "kdniao"]);
    assert.equal(result.querySucceeded, false);
    assert.equal(selectShipmentDetailTimeline(result.shipment).provider, before.provider);
    assert.equal(selectShipmentDetailTimeline(loadState(NOW).shipments[0]).provider,
      before.provider);
    if (cachedQuery) {
      const fallback = { ...result.shipment, detailSelection: { provider: "v5_query", selectedAtMs: NOW, reason: "sf_refresh_failed" as const } };
      const valid = { ...fallback.timeline, provider: "v6_query" };
      const empty = { ...valid, tracks: [], latestDetail: "", latestTimeText: "" };
      assert.equal(applySameSourceTimeline(fallback, empty, NOW).detailSelection?.reason, "sf_refresh_failed");
      assert.equal(applyManualShipment(fallback, { ...fallback, timeline: empty }, NOW).detailSelection?.reason, "sf_refresh_failed");
      assert.notEqual(applySameSourceTimeline(fallback, valid, NOW).detailSelection?.reason, "sf_refresh_failed");
      assert.notEqual(applyManualShipment(fallback, { ...fallback, timeline: valid }, NOW).detailSelection?.reason, "sf_refresh_failed");
    }
  });
}

test("a failed detail returns the latest independently committed list cache", async () => {
  const state = seed([row("manual")]);
  const original = state.shipments[0];
  let committed = false;
  const result = await runShipmentRefreshForTesting(original.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
    { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async () => null,
      queryManualForSource: async () => {
        if (!committed) {
          committed = true;
          assert.equal(commitTargetShipmentRefresh(state, captured(original, "v6_query"), NOW).applied, true);
        }
        return { shipment: null, pending: null, routeUrl: "" };
      },
    });
  assert.equal(committed, true);
  assert.equal(result.querySucceeded, false);
  assert.deepEqual(result.shipment, loadState(NOW).shipments[0]);
  assert.equal(result.state.revision, loadState(NOW).revision);
});

test("an old Online pickup does not suppress a free refresh of incomplete current detail", async () => {
  let original = row("ShunFeng");
  original = captured(original, "v6_query", true);
  const current = seed([original]).shipments[0];
  const calls: string[] = [];
  await runShipmentRefreshForTesting(current.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
    { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshWebTimeline: async () => { calls.push("primary_h5"); return null; },
      queryManualForSource: async input => {
        calls.push(input.fallbackOnly ? "kdniao" : "unexpected");
        return { shipment: null, pending: null, routeUrl: "" };
      },
    });
  assert.deepEqual(calls, ["primary_h5"], "the old origin still closes the paid fallback gate");
});

test("independent list and detail slots survive either completion order", () => {
  for (const order of [["v6_query", "v5_query"], ["v5_query", "v6_query"]]) {
    const state = seed([row("ShunFeng")]);
    const original = state.shipments[0];
    const first = captured(original, order[0]);
    const second = captured(original, order[1]);
    assert.equal(commitTargetShipmentRefresh(state, first, NOW).applied, true);
    const commit = commitTargetShipmentRefresh(state, second, NOW);
    assert.equal(commit.applied, true);
    for (const provider of order) assert.ok(commit.state.shipments[0].manualTimelines?.some(p => p.provider === provider));
  }
});

test("late same-slot detail, delete, sign-off and unbind cannot replace current data", () => {
  for (const action of ["same_slot", "delete", "sign", "unbind"] as const) {
    const state = seed([row("CaiNiao")]);
    const original = state.shipments[0];
    const incoming = captured(original, "v5_query");
    if (action === "same_slot") commitTargetShipmentRefresh(state, incoming, NOW);
    if (action === "delete") saveState({ ...state, shipments: [] }, NOW);
    if (action === "sign") saveState({ ...state, shipments: [{ ...original, forcedCompletedAtMs: NOW }] }, NOW);
    if (action === "unbind") removeBinding("interface5", "13800001234", NOW);
    const before = loadState(NOW);
    assert.equal(commitTargetShipmentRefresh(state, incoming, NOW).applied, false, action);
    assert.deepEqual(loadState(NOW).shipments, before.shipments);
  }
});
