import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { AppState, Shipment, TimelinePackage } from "../models";
import { emptyState, loadState, saveState } from "../services/storage";
import { MANUAL_REFRESH_MIN_INTERVAL_MS } from "../services/shipment-policy";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey, saveAlignmentRecords } from "../services/row-ledger";
import { createStatusAlignment, runStatusAlignmentPass } from "../services/status-alignment";
import { acquireDurableRefreshLease } from "../services/refresh-runtime-state";

const LEDGER_KEY = "pipi_deliveries_row_ledger_v1";
const WAYBILL = "ZTO900000001008";
function timeline(provider = "interface5", at = NOW - 3600000): TimelinePackage {
  const timeText = new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
  return { provider, waybill: WAYBILL, courierCode: "ZTO", companyName: "Synthetic carrier",
    semantic: provider === "interface5" ? "TRANSIT" : "UNKNOWN", structuredStatus: provider === "interface5",
    statusEventAtMs: provider === "interface5" ? NOW - 60000 : 0, complete: true, successAtMs: NOW,
    latestTimeText: timeText, latestDetail: "Synthetic carrier event",
    tracks: [{ timeMs: at, timeText, detail: "Synthetic carrier event", statusCode: "", raw: {} }] };
}
function state(): AppState {
  const source = timeline();
  const shipment: Shipment = { identity: { id: "interface5:account:DURABLE1008", bindingSource: "interface5",
    sourceOwner: "interface5:parcel", sourceId: WAYBILL, courierCode: "ZTO", companyName: "Synthetic carrier",
    sourceProvider: "CaiNiao", manuallyAdded: false, createdAtMs: NOW - 86400000 },
    sourceTimeline: source, timeline: source, updatedAtMs: NOW,
    accountRecord: { waybill: WAYBILL, companyCode: "ZTO", provider: "CaiNiao", name: "Synthetic carrier",
      phone: "13800001008", stateNumber: 2, updateTime: "", channel: "" } };
  return { ...emptyState(), shipments: [shipment] };
}
function seedMixedLedger() {
  memory.clear();
  const shipment = state().shipments[0];
  const key = rowLedgerKey(shipment.identity.id);
  const own = { signed: { completedAtMs: NOW - 86400000, jingDongUnionGapAtMs: NOW - 3600000 },
    classifyAnchorAtMs: NOW - 2 * 86400000, updatedAtMs: NOW - 3600000 };
  const other = { alignment: "older|hidden|record", signed: { completedAtMs: NOW - 3600000 },
    classifyAnchorAtMs: NOW - 3 * 86400000, updatedAtMs: NOW - 3600000 };
  const raw = JSON.stringify({ version: 1, rows: { [key]: own, "row:synthetic-hidden": other } });
  memory.set(LEDGER_KEY, raw);
  return { key, own, other, raw };
}

test("a foreign detail lease that cannot be joined consumes no alignment attempt", async () => {
  memory.clear();
  const realNow = Date.now;
  Date.now = () => NOW;
  const shipment = saveState(state(), NOW).shipments[0];
  const foreign = acquireDurableRefreshLease(`detail:${shipment.identity.id}`, 35000, NOW)!;
  assert.ok(foreign);
  try {
    await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
      load: () => loadState(NOW), now: () => NOW });
    assert.equal(loadAlignmentRecords()[rowLedgerKey(shipment.identity.id)], undefined,
      "the real durable lease path returned without issuing or joining a query");
  } finally { foreign.release(); Date.now = realNow; }
});

test("a statically eligible refresh that issues no query consumes no attempt", async () => {
  seedMixedLedger();
  let refreshes = 0;
  const result = await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
    load: state, now: () => NOW, refresh: async () => { refreshes++; return { state: state() }; } });
  assert.equal(refreshes, 1);
  assert.equal(loadAlignmentRecords()[rowLedgerKey(state().shipments[0].identity.id)], undefined);
  assert.equal(result.result, "nothing_due");
});

for (const failedSave of ["reservation", "completion"] as const) {
  test(`the existing controller watch resumes after a ${failedSave} storage failure without a new revision`, async () => {
    seedMixedLedger();
    let clock = NOW, requests = 0, writes = 0, timerId = 0;
    const timers = new Map<number, { due: number; callback: () => void }>();
    const set = Storage.set;
    let storageFailed = true;
    Storage.set = ((key: string, value: unknown, options?: { shared: boolean }) => {
      if (key === LEDGER_KEY && ++writes >= (failedSave === "reservation" ? 1 : 2) && storageFailed) return false;
      return set(key, value, options);
    }) as typeof Storage.set;
    const controller = createStatusAlignment({
      runPass: options => runStatusAlignmentPass(options, { appHost: () => true, busy: () => false,
        load: state, now: () => clock, refresh: async (_id, beforeQuery) => {
          beforeQuery?.(); requests++; return { state: state() };
        } }),
      subscribeRefreshOutcome: () => () => {}, peekRevision: () => 1, applyState: () => {},
      setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { due: clock + delay, callback }); return id; },
      clearTimer: id => { timers.delete(id as number); },
    });
    const tick = async (elapsed: number) => {
      clock += elapsed;
      for (let round = 0; round < 20; round++) {
        for (const [id, timer] of [...timers].filter(([, timer]) => timer.due <= clock)) {
          timers.delete(id); timer.callback();
        }
        await Promise.resolve();
      }
    };
    try {
      controller.scenePhaseChanged("active");
      await tick(0);
      assert.equal(requests, failedSave === "reservation" ? 0 : 1);
      storageFailed = false;
      await tick(3000);
      assert.equal(requests, 1, "the restored store is checked by the existing watch");
      for (let elapsed = 3000; elapsed < MANUAL_REFRESH_MIN_INTERVAL_MS; elapsed += 3000) await tick(3000);
      if (failedSave === "reservation") await tick(3000);
      assert.equal(requests, 2, "the durable reservation still enforces the ordinary row interval");
    } finally { controller.stop(); Storage.set = set; }
  });
}

test("a failed alignment read prevents requests and preserves the mixed ledger bytes", async () => {
  const { raw } = seedMixedLedger();
  const get = Storage.get;
  let requests = 0;
  Storage.get = ((key: string, options?: { shared: boolean }) => {
    if (key === LEDGER_KEY) throw new Error("Synthetic ledger read failure");
    return get(key, options);
  }) as typeof Storage.get;
  try {
    await assert.rejects(runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
      load: state, now: () => NOW, refresh: async (_id, beforeQuery) => { beforeQuery(); requests++; return { state: state() }; } }),
    /Synthetic ledger read failure/);
    assert.equal(requests, 0);
    assert.equal(memory.get(LEDGER_KEY), raw);
  } finally { Storage.get = get; }
});

test("a failed alignment merge read cannot replace other ledger fields with an empty ledger", () => {
  const { key, raw } = seedMixedLedger();
  const get = Storage.get;
  Storage.get = ((storageKey: string, options?: { shared: boolean }) => {
    if (storageKey === LEDGER_KEY) throw new Error("Synthetic merge read failure");
    return get(storageKey, options);
  }) as typeof Storage.get;
  try {
    assert.throws(() => saveAlignmentRecords({ [key]: "new|alignment|record" }), /Synthetic merge read failure/);
    assert.equal(memory.get(LEDGER_KEY), raw);
  } finally { Storage.get = get; }
});

for (const failure of ["throw", "false"] as const) {
  test(`a reservation save returning ${failure} prevents the request and preserves the old ledger`, async () => {
    const { raw } = seedMixedLedger();
    const set = Storage.set;
    let requests = 0;
    Storage.set = ((key: string, value: unknown, options?: { shared: boolean }) => {
      if (key !== LEDGER_KEY) return set(key, value, options);
      if (failure === "throw") throw new Error("Synthetic reservation save failure");
      return false;
    }) as typeof Storage.set;
    try {
      await assert.rejects(runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
        load: state, now: () => NOW, refresh: async (_id, beforeQuery) => { beforeQuery(); requests++; return { state: state() }; } }));
      assert.equal(requests, 0);
      assert.equal(memory.get(LEDGER_KEY), raw);
    } finally { Storage.set = set; }
  });
}

test("successful alignment saves preserve hidden rows and signed/classification fields", async () => {
  const { key, own, other } = seedMixedLedger();
  const result = await runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
    load: state, now: () => NOW, refresh: async (_id, beforeQuery) => { beforeQuery(); return { state: state() }; } });
  assert.equal(result.result, "attempted");
  const rows = JSON.parse(memory.get(LEDGER_KEY) as string).rows;
  assert.deepEqual(rows["row:synthetic-hidden"], other);
  assert.deepEqual(rows[key].signed, own.signed);
  assert.equal(rows[key].classifyAnchorAtMs, own.classifyAnchorAtMs);
  assert.equal(parseAlignmentAttempt(loadAlignmentRecords()[key])!.attempts, 1);
});

for (const failure of ["throw", "false"] as const) {
  test(`a completion save returning ${failure} cannot claim success or bypass the durable attempt count`, async () => {
    const { key } = seedMixedLedger();
    let current = state(), clock = NOW, requests = 0, ledgerWrites = 0;
    const set = Storage.set;
    Storage.set = ((storageKey: string, value: unknown, options?: { shared: boolean }) => {
      if (storageKey === LEDGER_KEY && ++ledgerWrites >= 2) {
        if (failure === "throw") throw new Error("Synthetic completion save failure");
        return false;
      }
      return set(storageKey, value, options);
    }) as typeof Storage.set;
    const pass = () => runStatusAlignmentPass({}, { appHost: () => true, busy: () => false,
      load: () => current, now: () => clock, refresh: async (_id, beforeQuery) => {
        beforeQuery();
        if (++requests === 1) current = { ...current, shipments: [{ ...current.shipments[0],
          manualTimelines: [timeline("v5_query", NOW - 7200000)] }] };
        return { state: current };
      } });
    try {
      await assert.rejects(pass());
      const reserved = parseAlignmentAttempt(loadAlignmentRecords()[key])!;
      assert.equal(reserved.attempts, 1);
      assert.equal(reserved.complete, false);
      assert.equal(reserved.finished, false);
      Storage.set = set;
      assert.equal((await pass()).result, "nothing_due", "the saved reservation still enforces the interval");
      clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
      assert.equal((await pass()).result, "attempted");
      assert.equal(parseAlignmentAttempt(loadAlignmentRecords()[key])!.attempts, 2);
      assert.equal(parseAlignmentAttempt(loadAlignmentRecords()[key])!.complete, false,
        "the failed completion's evidence is not remembered as success in memory");
      clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
      await pass();
      clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
      assert.equal((await pass()).result, "nothing_due");
      assert.equal(requests, 3);
    } finally { Storage.set = set; }
  });
}
