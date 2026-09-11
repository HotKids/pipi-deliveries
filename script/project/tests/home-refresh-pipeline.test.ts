import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import type { AccountParcelDto } from "../services/account-parser";
import { emptyState, saveState, loadState, commitRefreshState, removeBinding } from "../services/storage";
import { runShipmentEnrichmentForTesting } from "../services/sync";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}
const labels = new Map<string, string>();
const label = (s: Shipment) => labels.get(s.identity.id) || s.identity.id;
function row(id: string, manual = false, sf = false, signed = false): Shipment {
  const waybill = `${sf || manual ? "SF" : "JD"}123456${id.replace(/[^a-z0-9]/gi, "").toUpperCase()}`;
  const identityId = `${manual ? "interface5:manual" : "interface5:account"}:${waybill}`;
  labels.set(identityId, id);
  const pack: TimelinePackage = {
    provider: manual ? "kdniao" : "interface5", waybill, courierCode: sf || manual ? "SF" : "JD",
    companyName: "Carrier", semantic: signed ? "COMPLETED" : "TRANSIT", structuredStatus: true,
    statusEventAtMs: NOW-60000, complete: true, latestDetail: "Existing carrier event",
    latestTimeText: "2026-09-08 13:59:00", successAtMs: NOW-60000,
    tracks: [0,1].map(n => ({timeMs: NOW-60000-n*60000, timeText: "2026-09-08 13:59:00",
      detail: `Existing carrier event ${n}`, statusCode: "", raw: {}})),
  };
  return {
    identity: {id: identityId, sourceId: waybill, bindingSource: "interface5", manuallyAdded: manual,
      accountOrder: false, sourceOwner: manual ? "manual" : "interface5:parcel",
      sourceProvider: sf ? "ShunFeng" : "JingDong", courierCode: pack.courierCode,
      rawCourierCode: pack.courierCode, companyName: "Carrier", phone: "13800001234",
      phoneTail: "1234", createdAtMs: NOW-86400000},
    timeline: pack, sourceTimeline: manual ? undefined : pack,
    manualTimelines: manual ? [pack] : [], updatedAtMs: NOW-60000,
    accountRecord: manual ? null : {waybill, companyCode: pack.courierCode, name: "Carrier",
      provider: sf ? "ShunFeng" : "JingDong", stateNumber: signed ? 107 : 104,
      phone: "13800001234", channel: "account"},
  };
}
function parcel(s: Shipment, completed = false): AccountParcelDto {
  const detail = `Fresh ${label(s)}`;
  return {source: "interface5", ownerId: s.identity.sourceId, accountOrder: false,
    waybill: s.identity.sourceId, courierCode: s.identity.courierCode,
    rawCourierCode: s.identity.rawCourierCode, companyName: "Carrier", rawCompanyName: "Carrier",
    carrierNormalization: null, sourceProvider: s.identity.sourceProvider!,
    sourceStateCode: completed ? "107" : "104", sourceStateText: completed ? "已签收" : "运输中",
    semantic: completed ? "COMPLETED" : "TRANSIT", normalizedStatusScope: "SHIPMENT",
    normalizedStatusSemantic: completed ? "COMPLETED" : "TRANSIT",
    normalizedStatusText: completed ? "已签收" : "运输中", receiverPhone: "13800001234",
    senderPhone: "", routeUrl: "", projectionUrl: "", latestDetail: detail,
    latestTimeText: "2026-09-08 14:00:00",
    tracks: [{timeMs: NOW, timeText: "2026-09-08 14:00:00", detail, statusCode: "", raw: {}}]};
}
function harness(rows: Shipment[]) {
  clockNow = NOW;
  memory.clear();
  const initial = saveState({...emptyState(), shipments: rows,
    bindings: [{source: "interface5", phone: "13800001234", boundAtMs: NOW-86400000}]}, NOW);
  let base = initial;
  const commits: string[] = [];
  const checkpoint: Parameters<typeof runShipmentEnrichmentForTesting>[3] = (candidate, _routes, stage, jobBase) => {
    const result = commitRefreshState(jobBase || base, candidate, "interface5", Date.now());
    assert.equal(result.applied, true);
    base = result.state;
    commits.push(stage);
    return base;
  };
  return {initial, checkpoint, commits};
}

const realNow = Date.now;
let clockNow = NOW;
Date.now = () => clockNow;
process.on("exit", () => {Date.now = realNow;});

test("list commits finished Online rows before slower peers, with at most two active calls", async () => {
  const rows = [1,2,3,4].map(n => row(`online-${n}`, true));
  const h = harness(rows), gates = new Map<string, ReturnType<typeof deferred>>();
  let drain = false, active = 0, peak = 0;
  const run = runShipmentEnrichmentForTesting(h.initial, "interface5", "progressive", h.checkpoint,
    NOW+60000, new Set(), true, false, undefined, {
      refreshAccountParcel: async () => { assert.fail("list must not fetch account detail"); },
      queryManualForSource: async input => {
        assert.equal(input.pickerOnly, true); assert.equal(input.includeKdniaoFallback, false);
        const current = input.currentShipment!;
        const gate = deferred(); gates.set(current.identity.id, gate);
        active++; peak = Math.max(peak, active);
        if (!drain) await gate.promise;
        active--;
        const timeline = { ...current.timeline, provider: "v6_query", latestDetail: `Fresh ${label(current)}`,
          tracks: [{ ...current.timeline.tracks[0], detail: `Fresh ${label(current)}`, timeMs: NOW }] };
        return { shipment: { ...current, timeline, manualTimelines: [timeline] }, pending: null, routeUrl: "" };
      },
    });
  try {
    await tick(); assert.equal(gates.size, 2);
    const id = gates.keys().next().value!;
    gates.get(id)!.resolve(); await tick();
    assert.equal(gates.size, 3, "a freed slot is refilled before the slow peer returns");
    assert.ok(loadState(NOW).shipments.find(s => s.identity.id === id)?.manualTimelines?.some(
      p => p.provider === "v6_query" && p.tracks.some(t => t.detail.startsWith("Fresh"))));
  } finally { drain = true; gates.forEach(g => g.resolve()); await run; }
  assert.equal(peak, 2);
});

for (const action of ["delete", "sign", "unbind"] as const) {
  test(`list rechecks queued Online after ${action}`, async () => {
    const rows = [1,2,3].map(n => row(`queued-${action}-${n}`, false, true));
    const h = harness(rows), gate = deferred(), started: string[] = [];
    const run = runShipmentEnrichmentForTesting(h.initial, "interface5", action, h.checkpoint,
      NOW+60000, new Set(), true, false, undefined, {
        queryManualForSource: async input => {
          started.push(input.currentShipment!.identity.id); await gate.promise;
          return { shipment: null, pending: null, routeUrl: "" };
        },
      });
    let queuedId = "";
    try {
      await tick(); assert.equal(started.length, 2);
      queuedId = rows.find(s => !started.includes(s.identity.id))!.identity.id;
      const state = loadState(NOW);
      if (action === "unbind") removeBinding("interface5", "13800001234", NOW);
      else saveState({ ...state, shipments: state.shipments.flatMap(s => s.identity.id !== queuedId ? [s]
        : action === "delete" ? [] : [{ ...s, forcedCompletedAtMs: NOW }]) }, NOW);
    } finally { gate.resolve(); await run; }
    assert.equal(started.includes(queuedId), false);
  });
}

test("list cancellation retains earlier commits and rejects outstanding and queued results", async () => {
  const h = harness([1,2,3,4].map(n => row(`cancel-${n}`, true)));
  const gates = new Map<string, ReturnType<typeof deferred>>(), signals: AbortSignal[] = [];
  const controller = new AbortController();
  const run = runShipmentEnrichmentForTesting(h.initial, "interface5", "cancel", h.checkpoint,
    NOW+60000, new Set(), true, false, controller.signal, {
      queryManualForSource: async input => {
        const current = input.currentShipment!, gate = deferred();
        signals.push(input.signal!); gates.set(current.identity.id, gate); await gate.promise;
        const timeline = { ...current.timeline, provider: "v6_query" };
        return { shipment: { ...current, timeline, manualTimelines: [timeline] }, pending: null, routeUrl: "" };
      },
    });
  const rejected = assert.rejects(run, error => (error as Error).name === "OperationTimeoutError");
  await tick(); const first = gates.keys().next().value!;
  gates.get(first)!.resolve(); await tick();
  assert.equal(gates.size, 3);
  const commits = h.commits.length;
  controller.abort(); gates.forEach(g => g.resolve()); await rejected;
  assert.ok(signals.every(s => s.aborted));
  assert.equal(gates.size, 3); assert.equal(h.commits.length, commits);
  assert.ok(loadState(NOW).shipments.find(s => s.identity.id === first)?.manualTimelines?.some(p => p.provider === "v6_query"));
});

test("list stops queued Online at the existing host deadline", async () => {
  const h = harness([1,2,3].map(n => row(`deadline-${n}`, true))), gate = deferred();
  let calls = 0;
  const run = runShipmentEnrichmentForTesting(h.initial, "interface5", "deadline", h.checkpoint,
    NOW+60000, new Set(), true, false, undefined, {
      queryManualForSource: async () => { calls++; await gate.promise; return { shipment: null, pending: null, routeUrl: "" }; },
    });
  await tick(); clockNow = NOW+60001; gate.resolve(); await run;
  assert.equal(calls, 2);
});

test("a failed durable result commit cancels its sibling and preserves the error", async () => {
  const h = harness([1,2,3].map(n => row(`failed-${n}`, true))), gate = deferred();
  const expected = new Error("synthetic commit failure"), signals: AbortSignal[] = [];
  const run = runShipmentEnrichmentForTesting(h.initial, "interface5", "commit-failure", (candidate, routes, stage, base) => {
    if (stage === "manual_refresh") throw expected;
    return h.checkpoint(candidate, routes, stage, base);
  }, NOW+60000, new Set(), true, false, undefined, {
    queryManualForSource: async input => {
      signals.push(input.signal!); await gate.promise;
      const current = input.currentShipment!, timeline = { ...current.timeline, provider: "v6_query" };
      return { shipment: { ...current, timeline, manualTimelines: [timeline] }, pending: null, routeUrl: "" };
    },
  });
  const rejected = assert.rejects(run, error => error === expected);
  await tick(); gate.resolve(); await rejected;
  assert.equal(signals.length, 2); assert.ok(signals.every(s => s.aborted));
  assert.ok(loadState(NOW).shipments.every(s => !s.manualTimelines?.some(p => p.provider === "v6_query")));
});

test("route-only SF Online result releases ownership in its result commit", async () => {
  const h = harness([row("route-only", false, true)]);
  await runShipmentEnrichmentForTesting(h.initial, "interface5", "route", h.checkpoint, NOW+60000,
    new Set(), true, false, undefined, { queryManualForSource: async input => ({
      shipment: { ...input.currentShipment!, route: { kind: "web", source: "v6_query" },
        timeline: { ...input.currentShipment!.timeline, provider: "v6_query", tracks: [] } },
      pending: null, routeUrl: "https://www.kuaidi100.com/chaxun?com=shunfeng&nu=SF1234560000",
    }) });
  assert.deepEqual(h.commits, ["manual_refresh_attempt", "manual_refresh_route"]);
  assert.equal(loadState(NOW).shipments[0]?.manualRefreshLease, undefined);
});
