import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { AppState, Shipment, StatusSemantic, TimelinePackage, TrackNode } from "../models";
import { emptyState, loadState, saveState } from "../services/storage";
import { selectShipmentTimeline, signedTripleReached, statusAlignmentOutOfStep,
  statusAlignmentTimes, MANUAL_REFRESH_MIN_INTERVAL_MS } from "../services/shipment-policy";
import { createStatusAlignment, runStatusAlignmentPass } from "../services/status-alignment";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey } from "../services/row-ledger";
import { shipmentNotificationPresentation } from "../services/notification-events";

const WAYBILL = "SF900000001008";
const time = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
function track(at: number, detail: string, semantic: StatusSemantic = "UNKNOWN"): TrackNode {
  return { timeMs: at, timeText: time(at), detail, statusCode: "", raw: semantic === "UNKNOWN" ? {} : {
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic, code: semantic, text: semantic,
      priority: 0, eventAtMs: at, structured: true },
  } };
}
function pack(provider: string, semantic: StatusSemantic, at: number, tracks: TrackNode[]): TimelinePackage {
  return { provider, semantic, statusEventAtMs: at, structuredStatus: true, complete: true,
    waybill: WAYBILL, courierCode: "SF", companyName: "SF", tracks, successAtMs: NOW,
    latestTimeText: tracks[0]?.timeText || "", latestDetail: tracks[0]?.detail || "" };
}
function row(source: TimelinePackage, manual?: TimelinePackage, sf = false): Shipment {
  return { identity: { id: "interface5:account:ALIGN1008", bindingSource: "interface5",
    sourceOwner: "interface5:parcel", sourceId: WAYBILL, phoneTail: "1008", courierCode: sf ? "SF" : "ZTO",
    companyName: "SF", manuallyAdded: false, sourceProvider: sf ? "ShunFeng" : "CaiNiao",
    createdAtMs: NOW - 86400000 }, timeline: manual || source, sourceTimeline: source,
    manualTimelines: manual ? [manual] : [], updatedAtMs: NOW,
    accountRecord: { waybill: WAYBILL, companyCode: "SF", name: "SF", provider: sf ? "ShunFeng" : "CaiNiao",
      stateNumber: 2, updateTime: "", phone: "13800001008", channel: "" } };
}

test("a known delivery headline near a signed status is out of step and cannot freeze", () => {
  memory.clear();
  const source = pack("interface5", "COMPLETED", NOW - 60000,
    [track(NOW - 3 * 60000, "Known delivery", "DELIVERY")]);
  const shipment = row(source);
  assert.equal(statusAlignmentOutOfStep(statusAlignmentTimes(shipment)!), true);
  assert.equal(selectShipmentTimeline(shipment).latestDetail, "Known delivery",
    "a conflicting known enum is not a same-state donor even within five minutes");
  assert.equal(signedTripleReached(shipment, NOW), false);
});

test("an unknown node within five minutes may align an undated structured status without freezing", () => {
  memory.clear();
  const source = pack("interface5", "COMPLETED", 0, [track(NOW - 60000, "Untyped carrier event")]);
  const times = statusAlignmentTimes(row(source));
  assert.ok(times);
  assert.equal(times.statusAtMs, NOW - 60000, "comparison uses its donor's valid node time");
  assert.equal(signedTripleReached(row(source), NOW), false, "comparison time is never signing evidence");
  assert.equal(selectShipmentTimeline(row(source)).statusEventAtMs, 0);
});

test("undated status comparison and same-state selection exclude provider placeholders", () => {
  memory.clear();
  const realAt = NOW - 3600000;
  const source = pack("interface5", "COMPLETED", 0,
    [track(NOW - 60000, "快递状态已更新", "COMPLETED"),
      track(NOW - 120000, "您有包裹运输时效变化，请留意取件安排", "COMPLETED"),
      track(NOW - 180000, "查无结果", "COMPLETED"),
      track(realAt, "Actual signing", "COMPLETED")]);
  assert.equal(statusAlignmentTimes(row(source))!.statusAtMs, realAt);
  assert.equal(selectShipmentTimeline(row(source)).latestDetail, "Actual signing");
  assert.equal(selectShipmentTimeline(row(source)).statusEventAtMs, 0);
});

test("notification bodies use the same aligned headline as the list", () => {
  memory.clear();
  const source = pack("interface5", "COMPLETED", NOW - 3600000,
    [track(NOW - 60000, "Later unknown reminder"),
      track(NOW - 3600000, "Actual signing", "COMPLETED")]);
  const shipment = row(source);
  assert.equal(selectShipmentTimeline(shipment).latestDetail, "Actual signing");
  assert.equal(shipmentNotificationPresentation(shipment).body, "Actual signing");
});

test("SF keeps non-coarse history before its first forced attempt", () => {
  memory.clear();
  const source = pack("interface5", "COMPLETED", NOW - 60000,
    [track(NOW - 60000, "Coarse feed signing", "COMPLETED")]);
  const manual = pack("k100_h5", "UNKNOWN", 0,
    [track(NOW - 3600000, "Detailed carrier history"), track(NOW - 86400000, "已揽收")]);
  assert.equal(selectShipmentTimeline(row(source, manual, true)).latestDetail, "Detailed carrier history");
});

test("SF never freezes on coarse feed history alone", () => {
  memory.clear();
  const source = pack("interface5", "COMPLETED", NOW - 60000,
    [track(NOW - 60000, "Coarse feed signing", "COMPLETED")]);
  assert.equal(signedTripleReached(row(source, undefined, true), NOW), false);
});

test("a newer known headline advances displayed status but never reverses an already signed state", () => {
  memory.clear();
  const source = pack("interface5", "TRANSIT", NOW - 3600000,
    [track(NOW - 60000, "Structured delivery", "DELIVERY")]);
  assert.equal(selectShipmentTimeline(row(source)).semantic, "DELIVERY");
  const signed = pack("interface5", "COMPLETED", NOW - 3600000,
    [track(NOW - 60000, "Late delivery", "DELIVERY"),
      track(NOW - 3600000, "Earlier signing", "COMPLETED")]);
  const listed = selectShipmentTimeline(row(signed));
  assert.equal(listed.semantic, "COMPLETED");
  assert.equal(listed.latestDetail, "Earlier signing");
});

test("unchanged alignment replies retry at the ordinary row interval, at most three times", async () => {
  memory.clear();
  const source = pack("interface5", "TRANSIT", NOW - 60000,
    [track(NOW - 3600000, "Old history", "TRANSIT")]);
  const state: AppState = { ...emptyState(), shipments: [row(source)] };
  let clock = NOW, calls = 0;
  let records: Record<string, string> = {};
  const pass = () => runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
    load: () => state, now: () => clock, records: { load: () => ({ ...records }), save: next => { records = next; } },
    refresh: async (_id, beforeQuery) => { beforeQuery(); calls++; return { state }; } });
  assert.equal((await pass()).result, "attempted");
  assert.equal((await pass()).result, "nothing_due");
  clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
  assert.equal((await pass()).result, "attempted", "unchanged reply does not complete the group");
  clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
  assert.equal((await pass()).result, "attempted");
  clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
  assert.equal((await pass()).result, "nothing_due");
  assert.equal(calls, 3);
});

for (const anotherRow of [false, true]) {
  test(`the controller retains a waiting retry${anotherRow ? " after another row completes" : " across watch ticks"}`, async () => {
    memory.clear();
    const source = pack("interface5", "TRANSIT", NOW - 60000,
      [track(NOW - 3600000, "Old history", "TRANSIT")]);
    const first = row(source);
    const second = { ...first, identity: { ...first.identity, id: "interface5:account:SECOND1008" } };
    let state: AppState = { ...emptyState(), shipments: anotherRow ? [first, second] : [first] };
    let clock = NOW, records: Record<string, string> = {}, nextTimer = 0, firstCalls = 0;
    const timers = new Map<number, { due: number; callback: () => void }>();
    const controller = createStatusAlignment({
      runPass: options => runStatusAlignmentPass(options, { appHost: () => true, busy: () => false,
        load: () => state, now: () => clock, records: { load: () => ({ ...records }), save: next => { records = next; } },
        refresh: async (id, beforeQuery) => { beforeQuery();
          if (id === first.identity.id) firstCalls++;
          else state = { ...state, shipments: state.shipments.map(shipment => shipment.identity.id === id
            ? { ...shipment, sourceTimeline: { ...source, tracks: [track(NOW, "Updated history", "TRANSIT")] } }
            : shipment) };
          return { state };
        } }),
      subscribeRefreshOutcome: () => () => {}, peekRevision: () => 1, applyState: () => {},
      setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { due: clock + delay, callback }); return id; },
      clearTimer: id => { timers.delete(id as number); },
    });
    const tick = async (elapsed: number) => {
      clock += elapsed;
      for (let round = 0; round < 20; round++) {
        const due = [...timers].filter(([, timer]) => timer.due <= clock);
        for (const [id, timer] of due) { timers.delete(id); timer.callback(); }
        await Promise.resolve();
      }
    };
    try {
      controller.scenePhaseChanged("active");
      await tick(0);
      assert.equal(firstCalls, 1);
      for (let elapsed = 3000; elapsed <= MANUAL_REFRESH_MIN_INTERVAL_MS; elapsed += 3000) await tick(3000);
      assert.equal(firstCalls, 2, "cooldown checks do not forget the unfinished same-group attempt");
      for (let elapsed = 3000; elapsed <= MANUAL_REFRESH_MIN_INTERVAL_MS; elapsed += 3000) await tick(3000);
      assert.equal(firstCalls, 3);
      for (let elapsed = 3000; elapsed <= MANUAL_REFRESH_MIN_INTERVAL_MS; elapsed += 3000) await tick(3000);
      assert.equal(firstCalls, 3, "the watch stops requesting after the third unchanged attempt");
    } finally { controller.stop(); }
  });
}

test("a failed or cancelled alignment can retry the same times", async () => {
  memory.clear();
  const state: AppState = { ...emptyState(), shipments: [row(pack("interface5", "TRANSIT", NOW - 60000,
    [track(NOW - 3600000, "Old history", "TRANSIT")]))] };
  let clock = NOW, calls = 0, records: Record<string, string> = {};
  const pass = () => runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
    load: () => state, now: () => clock, records: { load: () => ({ ...records }), save: next => { records = next; } },
    refresh: async (_id, beforeQuery) => { beforeQuery(); if (++calls === 1) throw new Error("Synthetic cancellation"); return { state }; } });
  assert.equal((await pass()).result, "failed");
  clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
  assert.equal((await pass()).result, "attempted");
  assert.equal(calls, 2);
});

test("SF coarse fallback is available only after the first attempt finishes and never certifies freezing", async () => {
  memory.clear();
  const source = pack("interface5", "COMPLETED", NOW - 60000,
    [track(NOW - 60000, "Coarse feed signing", "COMPLETED")]);
  const manual = pack("k100_h5", "UNKNOWN", 0,
    [track(NOW - 3600000, "Detailed carrier history"), track(NOW - 86400000, "已揽收")]);
  const original = saveState({ ...emptyState(), shipments: [row(source, manual, true)] }, NOW).shipments[0];
  assert.equal(original.timeline.latestDetail, "Detailed carrier history");
  const result = await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
    load: () => loadState(NOW), now: () => NOW,
    refresh: async (_id, beforeQuery) => { beforeQuery();
      assert.equal(selectShipmentTimeline(loadState(NOW).shipments[0]).latestDetail, "Detailed carrier history",
        "a reservation alone does not allow the coarse fallback");
      return { state: loadState(NOW) };
    } });
  assert.equal(result.state!.shipments[0].timeline.latestDetail, "Coarse feed signing");
  assert.equal(loadState(NOW).shipments[0].timeline.latestDetail, "Coarse feed signing",
    "later hosts use the same durable attempt record");
  assert.equal(signedTripleReached(loadState(NOW).shipments[0], NOW), false);
  assert.equal(parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(original.identity.id)])!.complete, false);
});

test("newer evidence in a related slot completes the original group, capture time alone does not", async () => {
  for (const newNode of [false, true]) {
    memory.clear();
    const source = pack("interface5", "TRANSIT", NOW - 60000,
      [track(NOW - 3600000, "Old history", "TRANSIT")]);
    let state: AppState = { ...emptyState(), shipments: [row(source)] };
    let records: Record<string, string> = {};
    await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false, load: () => state, now: () => NOW,
      records: { load: () => ({ ...records }), save: next => { records = next; } },
      refresh: async (_id, beforeQuery) => { beforeQuery();
        const updated = { ...source, successAtMs: NOW + 60000,
          tracks: newNode ? [track(NOW - 30000, "New carrier node", "TRANSIT")] : source.tracks };
        state = { ...state, shipments: [{ ...state.shipments[0], sourceTimeline: updated }] };
        return { state };
      } });
    assert.equal(parseAlignmentAttempt(Object.values(records)[0])!.complete, newNode);
  }
});

for (const correction of ["headline", "status", "unknown_headline"] as const) {
  test(`same-clock ${correction} enum correction invalidates only the old completion, never the attempt budget`, async () => {
    memory.clear();
    const source = pack("interface5", "TRANSIT", NOW - 60000,
      [track(NOW - 3600000, "History event", correction === "unknown_headline" ? "UNKNOWN" : "TRANSIT"),
        track(NOW - 86400000, "已揽收")]);
    let state: AppState = { ...emptyState(), shipments: [row(source)] };
    let clock = NOW, calls = 0, records: Record<string, string> = {};
    const pass = () => runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
      load: () => state, now: () => clock,
      records: { load: () => ({ ...records }), save: next => { records = next; } },
      refresh: async (_id, beforeQuery) => { beforeQuery();
        if (++calls === 1) state = { ...state, shipments: [{ ...state.shipments[0],
          manualTimelines: [pack("v5_query", "UNKNOWN", 0, [track(NOW - 7200000, "Newly returned older account node")])] }] };
        return { state };
      } });
    await pass();
    const record = () => parseAlignmentAttempt(Object.values(records)[0])!;
    assert.equal(record().complete, true, "a newly returned related slot completed the first run");
    const originalTimes = record().times;
    const corrected = correction === "status" ? { ...source, semantic: "DELIVERY" as const }
      : { ...source, tracks: [track(NOW - 3600000, "History event", "DELIVERY"), source.tracks[1]] };
    state = { ...state, shipments: [{ ...state.shipments[0], sourceTimeline: corrected }] };
    assert.equal((await pass()).result, "nothing_due", "enum correction does not bypass the row interval");
    clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
    assert.equal((await pass()).result, "attempted", "known status correction cannot be swallowed by stale done");
    assert.equal(record().times, originalTimes, "semantic correction does not create a new time group");
    assert.equal(record().attempts, 2);
    assert.equal(record().complete, false, "semantic correction alone is not newer logistics evidence");
    clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
    assert.equal((await pass()).result, "attempted");
    clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
    assert.equal((await pass()).result, "nothing_due");
    assert.equal(calls, 3, "the original attempt budget still caps the group");
  });
}

test("a row without a permitted source, and a non-app host, reserve no attempt", async () => {
  memory.clear();
  const shipment = row(pack("interface5", "TRANSIT", NOW - 60000,
    [track(NOW - 3600000, "Old history", "TRANSIT")]));
  shipment.accountRecord = null;
  let records: Record<string, string> = {};
  const dependencies = { appHost: () => true, busy: () => false,
    load: () => ({ ...emptyState(), shipments: [shipment] }), now: () => NOW,
    records: { load: () => ({ ...records }), save: (next: Record<string, string>) => { records = next; } },
    refresh: async (_id, beforeQuery) => { beforeQuery(); assert.fail("no source can be queried"); } };
  assert.equal((await runStatusAlignmentPass({}, dependencies)).result, "nothing_due");
  assert.deepEqual(records, {});
  assert.equal((await runStatusAlignmentPass({}, { ...dependencies, appHost: () => false })).result, "not_app_host");
  assert.deepEqual(records, {});
});

test("SF non-coarse signing may freeze, while a known delivery detail at the same time may not", () => {
  memory.clear();
  const source = pack("interface5", "COMPLETED", NOW - 60000,
    [track(NOW - 60000, "Coarse feed signing", "COMPLETED")]);
  const detailed = pack("v6_query", "COMPLETED", NOW - 60000,
    [track(NOW - 60000, "Carrier signature", "COMPLETED"), track(NOW - 86400000, "已揽收")]);
  assert.equal(signedTripleReached(row(source, detailed, true), NOW), true);
  const delivery = { ...detailed, tracks: [track(NOW - 60000, "Carrier still delivering", "DELIVERY"),
    track(NOW - 86400000, "已揽收")], latestDetail: "Carrier still delivering" };
  assert.equal(signedTripleReached(row(source, delivery, true), NOW), false);
});
