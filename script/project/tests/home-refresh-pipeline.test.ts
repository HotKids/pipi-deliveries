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

test("Home pipelines each parcel, refills free slots, and keeps both concurrency limits", async () => {
  const rows = [row("pipe-sf", false, true), ...[1,2,3,4,5].map(n => row(`pipe-a${n}`)),
    row("pipe-manual", true), row("pipe-signed", false, false, true)];
  const h = harness(rows);
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const started: string[] = [];
  let active = 0, manualActive = 0, peak = 0, manualPeak = 0;
  async function wait(key: string, manual: boolean) {
    started.push(key); const gate = deferred(); gates.set(key, gate);
    active++; manualActive += Number(manual);
    peak = Math.max(peak, active); manualPeak = Math.max(manualPeak, manualActive);
    await gate.promise;
    active--; manualActive -= Number(manual);
  }
  let drain = false;
  const run = runShipmentEnrichmentForTesting(h.initial, "interface5", "pipeline-test", h.checkpoint,
    NOW+60000, new Set(), true, false, undefined, {
      refreshAccountParcel: async s => {if (!drain) await wait(`a:${label(s)}`, false); return parcel(s);},
      queryManualForSource: async options => {
        const s = options.currentShipment!;
        if (label(s) === "pipe-sf") {
          assert.ok(s.manualTimelines?.some(p => p.tracks.some(t => t.detail === "Fresh pipe-sf")),
            "automatic supplementation uses its own durably committed account result");
        }
        if (!drain) await wait(`m:${label(s)}`, true);
        const timeline = {...s.timeline, provider: "kdniao", latestDetail: `Manual ${label(s)}`};
        return {shipment: {...s, timeline, manualTimelines: [timeline]}, pending: null, routeUrl: ""};
      },
    });
  try {
    await tick();
    assert.ok(started.includes("m:pipe-manual"), `independent manual work must start before unrelated account queries finish: ${JSON.stringify(started)}`);
    assert.ok(!started.includes("m:pipe-sf"), "automatic supplementation waits for its own account result");
    assert.ok(!started.some(key => key.includes("pipe-signed")), "signed rows remain skipped");
    const earlyAccount = started.find(key => key.startsWith("a:") && key !== "a:pipe-sf")!;
    const beforeCount = started.filter(key => key.startsWith("a:")).length;
    gates.get(earlyAccount)!.resolve(); await tick();
    assert.ok(started.filter(key => key.startsWith("a:")).length > beforeCount,
      "a free slot must accept another account row while the slow first rows remain pending");
    gates.get("a:pipe-sf")!.resolve(); await tick();
    assert.ok(started.includes("m:pipe-sf"), "same-parcel manual work must not wait for every account row");
  } finally {
    drain = true; for (const gate of gates.values()) gate.resolve(); await run;
  }
  assert.ok(peak <= 4, `total concurrent tasks: ${peak}`);
  assert.ok(manualPeak <= 2, `manual concurrent tasks: ${manualPeak}`);
  const stored = loadState(NOW);
  for (const s of rows.filter(s => !s.identity.manuallyAdded && label(s) !== "pipe-signed")) {
    assert.ok(stored.shipments.find(r => r.identity.id === s.identity.id)?.manualTimelines?.some(
      p => p.tracks.some(t => t.detail === `Fresh ${label(s)}`)), "parallel commits preserve each other");
  }
});

test("Home reevaluates terminal status after the parcel's own account query", async () => {
  const unsigned = row("freeze-after-query", false, true);
  unsigned.timeline.semantic = "UNKNOWN";
  unsigned.timeline.structuredStatus = false;
  const h = harness([unsigned]);
  let manualCalls = 0;
  await runShipmentEnrichmentForTesting(h.initial, "interface5", "terminal-test", h.checkpoint,
    NOW+60000, new Set(), true, false, undefined, {
      refreshAccountParcel: async s => parcel(s, true),
      queryManualForSource: async () => {manualCalls++; return {shipment: null, pending: null, routeUrl: ""};},
    });
  assert.equal(manualCalls, 0, "a newly signed parcel must not enter supplementation");
  assert.equal(loadState(NOW).shipments[0]?.timeline.semantic, "COMPLETED");
});

test("route-only manual result releases its lease in the result checkpoint", async () => {
  const s = row("route-only", false, true); s.accountRecord = null;
  const h = harness([s]);
  await runShipmentEnrichmentForTesting(h.initial, "interface5", "route-test", h.checkpoint,
    NOW+60000, new Set(), true, false, undefined, {
      refreshAccountParcel: async () => {throw new Error("no account record");},
      queryManualForSource: async options => ({shipment: {...options.currentShipment!,
        route: {kind: "web", source: "v6_query"},
        timeline: {...options.currentShipment!.timeline, provider: "v6_query", tracks: []}},
        pending: null, routeUrl: "https://www.kuaidi100.com/chaxun?com=shunfeng&nu=SF1234560000"}),
    });
  assert.deepEqual(h.commits, ["manual_refresh_attempt", "manual_refresh_route"],
    "route result and lease release must use one state commit");
  assert.equal(loadState(NOW).shipments[0]?.manualRefreshLease, undefined);
});

test("Home discovers supplementation that becomes eligible during its account query", async () => {
  const s = row("expired-lease", false, true);
  s.manualRefreshLease = {attemptId: "previous-runtime", startedAtMs: NOW-1000, expiresAtMs: NOW+100};
  const h = harness([s]);
  let manualCalls = 0;
  await runShipmentEnrichmentForTesting(h.initial, "interface5", "expired-lease-test", h.checkpoint,
    NOW+60000, new Set(), true, false, undefined, {
      refreshAccountParcel: async current => {clockNow = NOW+200; return parcel(current);},
      queryManualForSource: async () => {manualCalls++; return {shipment: null, pending: null, routeUrl: ""};},
    });
  assert.equal(manualCalls, 1);
});

for (const action of ["delete", "sign", "unbind"] as const) {
  test(`Home rechecks durable eligibility before starting a queued account after ${action}`, async () => {
    const rows = [1,2,3,4,5].map(n => row(`queued-${action}-${n}`));
    const h = harness(rows);
    const gate = deferred();
    const started: string[] = [];
    let queuedId = "";
    const run = runShipmentEnrichmentForTesting(h.initial, "interface5", `queued-${action}`, h.checkpoint,
      NOW+60000, new Set(), true, false, undefined, {
        refreshAccountParcel: async s => {started.push(s.identity.id); await gate.promise; return null;},
      });
    try {
      await tick();
      assert.equal(started.length, 4);
      queuedId = rows.find(s => !started.includes(s.identity.id))!.identity.id;
      const current = loadState(NOW);
      if (action === "unbind") removeBinding("interface5", "13800001234", NOW);
      else saveState({...current, shipments: current.shipments.flatMap(s =>
        s.identity.id !== queuedId ? [s] : action === "delete" ? [] :
          [{...s, forcedCompletedAtMs: NOW}])}, NOW);
    } finally {
      gate.resolve(); await run;
    }
    assert.equal(started.includes(queuedId), false);
  });
}

test("Home admits at most two manual tasks and refills their freed slot", async () => {
  const h = harness([1,2,3,4].map(n => row(`manual-limit-${n}`, true)));
  const gates: ReturnType<typeof deferred>[] = [];
  let active = 0, peak = 0, drain = false;
  const run = runShipmentEnrichmentForTesting(h.initial, "interface5", "manual-limit", h.checkpoint,
    NOW+60000, new Set(), true, false, undefined, {
      queryManualForSource: async () => {
        const gate = deferred(); gates.push(gate);
        active++; peak = Math.max(peak, active);
        if (!drain) await gate.promise;
        active--;
        return {shipment: null, pending: null, routeUrl: ""};
      },
    });
  try {
    await tick(); assert.equal(gates.length, 2);
    gates[0].resolve(); await tick(); assert.equal(gates.length, 3);
  } finally {
    drain = true; gates.forEach(g => g.resolve()); await run;
  }
  assert.equal(peak, 2);
});

test("Home cancellation preserves completed rows and rejects late results and queued work", async () => {
  const rows = [1,2,3,4,5,6].map(n => row(`cancel-${n}`));
  const h = harness(rows);
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const signals: AbortSignal[] = [];
  let completedId = "";
  const controller = new AbortController();
  const run = runShipmentEnrichmentForTesting(h.initial, "interface5", "cancel-test", h.checkpoint,
    NOW+60000, new Set(), true, false, controller.signal, {
      refreshAccountParcel: async (s, _deadline, signal) => {
        signals.push(signal!); const gate = deferred(); gates.set(s.identity.id, gate);
        await gate.promise; return parcel(s);
      },
    });
  const rejection = assert.rejects(run, error => (error as Error).name === "OperationTimeoutError");
  try {
    await tick();
    completedId = gates.keys().next().value!;
    gates.get(completedId)!.resolve(); await tick();
    assert.equal(h.commits.length, 1);
    assert.equal(gates.size, 5);
    controller.abort(); await tick();
    assert.ok(signals.every(s => s.aborted));
  } finally {
    controller.abort(); gates.forEach(g => g.resolve()); await rejection;
  }
  assert.equal(gates.size, 5, "the last queued row must not start");
  assert.equal(h.commits.length, 1, "late successful network results cannot commit");
  const saved = loadState(NOW).shipments.find(s => s.identity.id === completedId)!;
  assert.ok(saved.manualTimelines?.some(p => p.tracks.some(t => t.detail === `Fresh ${label(saved)}`)));
});

test("Home stops queued work at the existing host deadline", async () => {
  const h = harness([1,2,3,4,5].map(n => row(`deadline-${n}`)));
  const gate = deferred();
  let calls = 0;
  const run = runShipmentEnrichmentForTesting(h.initial, "interface5", "deadline-test", h.checkpoint,
    NOW+60000, new Set(), true, false, undefined, {
      refreshAccountParcel: async () => {calls++; await gate.promise; return null;},
    });
  await tick();
  clockNow = NOW+60001; gate.resolve(); await run;
  assert.equal(calls, 4);
});

test("Home preserves the original commit failure while cancelling sibling tasks", async () => {
  const h = harness([1,2,3,4,5].map(n => row(`failure-${n}`)));
  const gate = deferred();
  const signals: AbortSignal[] = [];
  const expected = new Error("synthetic commit failure");
  let commits = 0;
  const run = runShipmentEnrichmentForTesting(h.initial, "interface5", "failure-test", () => {
    commits++; throw expected;
  }, NOW+60000, new Set(), true, false, undefined, {
    refreshAccountParcel: async (s, _deadline, signal) => {
      signals.push(signal!); await gate.promise; return parcel(s);
    },
  });
  const rejection = assert.rejects(run, error => error === expected);
  await tick(); gate.resolve(); await rejection;
  assert.equal(commits, 1);
  assert.equal(signals.length, 4);
  assert.ok(signals.every(s => s.aborted));
  assert.equal(loadState(NOW).revision, h.initial.revision);
});
