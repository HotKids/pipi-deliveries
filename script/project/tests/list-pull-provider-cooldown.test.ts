import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { manualProviderSchedule, queryManualForSource } from "../services/manual-query";
import { recordRefreshProviderResult, refreshProviderDue } from "../services/refresh-runtime-state";
import { manualPullHistoryIncomplete } from "../services/shipment-policy";
import { commitRefreshState, emptyState, loadState, saveState } from "../services/storage";
import { runShipmentEnrichmentForTesting } from "../services/sync";

// Owner 2026-11-10 (item 1): a Home list pull obeys the per-waybill Picker/Moto 10-minute cooldown and writes its
// own answer into that cooldown. A row whose listed history is incomplete is exempt from the cooldown but keeps the
// 30-second minimum interval.

const WAYBILL = "78912345676250", PHONE = "13800001234";
const MOTO_PATH = "/api/express/timeline/public";
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

function manualRow(withPickup: boolean, attemptAtMs?: number): Shipment {
  const tracks = [NOW - 3 * 3600000, NOW - 9 * 3600000].map((at, index) => ({
    timeMs: at, timeText: providerTime(at),
    detail: index ? (withPickup ? "【杭州市】快件已揽收" : "【杭州市】快件离开中转部") : "【杭州市】快件运输中",
    statusCode: "", raw: {},
  }));
  const pack: TimelinePackage = {
    provider: "v4_query", waybill: WAYBILL, courierCode: "ZTO", rawCourierCode: "ZTO", companyName: "中通快递",
    semantic: "TRANSIT", structuredStatus: true, statusEventAtMs: tracks[0].timeMs,
    complete: false, latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks,
    successAtMs: NOW - 3 * 3600000,
  };
  return {
    identity: {
      id: `interface5:manual:${WAYBILL}`, bindingSource: "interface5", sourceOwner: "manual", sourceId: WAYBILL,
      phoneTail: PHONE.slice(-4), courierCode: "ZTO", rawCourierCode: "ZTO", companyName: "中通快递",
      manuallyAdded: true, createdAtMs: NOW - 86400000,
    },
    timeline: pack, sourceTimeline: null, manualTimelines: [pack], updatedAtMs: NOW - 3 * 3600000,
    ...(attemptAtMs ? { manualRefreshAttemptAtMs: attemptAtMs } : {}),
  };
}

const schedule = (row: Shipment) => manualProviderSchedule({ source: "interface5", waybill: WAYBILL,
  rawCourierCode: "ZTO", phoneTail: row.identity.phoneTail });

const motoAnswer = () => ({
  status: 0,
  data: {
    cpCode: "ZTO", cpName: "中通快递", logisticsStatus: "TRANSPORT",
    fullTraceDetail: [
      { time: providerTime(NOW - 600000), desc: "【杭州市】快件运输中" },
      { time: providerTime(NOW - 9 * 3600000), desc: "【杭州市】快件已揽收" },
    ],
  },
});

/** One Home list pull (forceManualRefresh, foreground host) through the real manual-query chain. */
async function listPull(row: Shipment) {
  memory.clear();
  setDiagnosticsEnabled(true);
  let base = saveState({ ...emptyState(), shipments: [row],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }] }, NOW);
  const checkpoint: Parameters<typeof runShipmentEnrichmentForTesting>[3] = (candidate, _routes, _stage, jobBase) => {
    const result = commitRefreshState(jobBase || base, candidate, "interface5", Date.now());
    assert.equal(result.applied, true);
    base = result.state;
    return base;
  };
  const paths: string[] = [];
  const work = { started: 0 };
  return { paths, work, run: async () => {
    const calls: Parameters<typeof queryManualForSource>[0][] = [];
    await runShipmentEnrichmentForTesting(loadState(NOW), "interface5", "list_pull", checkpoint, NOW + 60000,
      new Set(), true, false, undefined, {
        queryManualForSource: async input => {
          calls.push(input);
          return queryManualForSource({ ...input, dependencies: { now: () => NOW, post: async path => {
            paths.push(path);
            return motoAnswer();
          } } });
        },
      }, false, new Set(), undefined, false, () => { work.started++; });
    return calls;
  } };
}

const skipped = () => readDiagnostics().filter(entry =>
  entry.event === "refresh.stage.skipped" && entry.details.stage === "manual_refresh");

test("complete listed history: helper reports complete, incomplete without a start node", () => {
  assert.equal(manualPullHistoryIncomplete(manualRow(true)), false);
  assert.equal(manualPullHistoryIncomplete(manualRow(false)), true);
});

test("a list pull skips a complete row inside its Moto cooldown", async () => {
  const row = manualRow(true);
  const pull = await listPull(row);
  const { key, identityFingerprint } = schedule(row);
  recordRefreshProviderResult({ key, provider: "moto", identityFingerprint, result: "success", now: NOW - 60000 });
  const calls = await pull.run();
  assert.equal(calls.length, 0, "the cooled-down complete row is not queried by a pull");
  assert.deepEqual(pull.paths, []);
  assert.equal(skipped()[0]?.details.skipReason, "cooldown");
});

test("a list pull records its answer in the provider cooldown", async () => {
  const row = manualRow(true);
  const pull = await listPull(row);
  const { key, identityFingerprint } = schedule(row);
  assert.equal(refreshProviderDue(key, "moto", identityFingerprint, NOW), true);
  const calls = await pull.run();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scheduled, false, "the pull itself is not gated inside manual-query");
  assert.equal(calls[0].recordSchedule, true);
  assert.deepEqual(pull.paths, [MOTO_PATH]);
  assert.equal(refreshProviderDue(key, "moto", identityFingerprint, NOW + 1000), false,
    "the next pull or background round sees the pull's cooldown");
});

test("an incomplete row is exempt from the cooldown", async () => {
  const row = manualRow(false);
  const pull = await listPull(row);
  const { key, identityFingerprint } = schedule(row);
  recordRefreshProviderResult({ key, provider: "moto", identityFingerprint, result: "success", now: NOW - 60000 });
  const calls = await pull.run();
  assert.equal(calls.length, 1, "an incomplete row may pull inside the cooldown");
  assert.deepEqual(pull.paths, [MOTO_PATH]);
});

test("an incomplete row still keeps the 30-second minimum interval", async () => {
  const pull = await listPull(manualRow(false, NOW - 10_000));
  const calls = await pull.run();
  assert.equal(calls.length, 0, "a second pull within 30 seconds sends nothing");
  assert.deepEqual(pull.paths, []);
});

// C1 / T3 (review 2026-11-11): the pull is answered early (「列表已更新，轨迹在后台继续更新」) only when a job actually
// queries. A round whose every row is skipped by its cooldown or the 30-second floor must not report work started.
test("a round whose rows are all cooling never reports per-shipment work started (C1)", async () => {
  const row = manualRow(true);
  const pull = await listPull(row);
  const { key, identityFingerprint } = schedule(row);
  recordRefreshProviderResult({ key, provider: "moto", identityFingerprint, result: "success", now: NOW - 60000 });
  const calls = await pull.run();
  assert.equal(calls.length, 0, "fixture premise: the cooled-down row is skipped");
  assert.equal(pull.work.started, 0, "no early continuing answer when nothing is queried");
});

test("a row inside the 30-second floor never reports per-shipment work started (C1)", async () => {
  const pull = await listPull(manualRow(false, NOW - 10_000));
  const calls = await pull.run();
  assert.equal(calls.length, 0, "fixture premise: the floor skips the row");
  assert.equal(pull.work.started, 0, "no early continuing answer when nothing is queried");
});

test("a row that is due reports per-shipment work started before its query (C1)", async () => {
  const pull = await listPull(manualRow(true));
  const calls = await pull.run();
  assert.equal(calls.length, 1);
  assert.equal(pull.work.started, 1, "the early answer is given once the due row starts querying");
});
