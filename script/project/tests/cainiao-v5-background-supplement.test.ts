import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { commitRefreshState, emptyState, loadState, saveState } from "../services/storage";
import { listRefreshInProgress, refreshAllShipments, refreshShipmentById } from "../services/sync";
import { parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import {
  applyAccountShipment,
  applyTargetedAccountShipment,
  asAccountDetailObservation,
  cainiaoHasTrajectoryGap,
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
  shipmentDetailIncompleteReason,
  signedRefreshFrozen,
} from "../services/shipment-policy";
import { saveGatewayToken } from "../services/credentials";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey } from "../services/row-ledger";
import { parseProviderTime, shipmentPresentationStatus } from "../services/status";
import { OperationTimeoutError } from "../services/deadline";

const PHONE = "13800000000";
const WAYBILL_3585 = "SYNTHSTO0003585";
const GENERIC = "快递状态已更新，点击查看>>";

const realNow = Date.now;
let clock = parseProviderTime("2026-09-12 19:15:00")!;
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });

Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });

const scheduledNotifications: { title?: string; body?: string }[] = [];
Object.assign(globalThis, {
  Notification: {
    schedule: async (payload: { title?: string; body?: string }) => {
      scheduledNotifications.push(payload);
    },
  },
  Widget: { reloadAll() {} },
  Script: {
    directory: "/synthetic",
    name: "Synthetic",
    createRunSingleURLScheme: () => "synthetic://shipment",
  },
  WebViewController: class {
    constructor() {
      assert.fail("Cainiao v5 background supplement must never open WebView");
    }
  },
});

const jsonResponse = (value: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(value),
});

function dayDates(dayNumber: number) {
  const day = `2026-09-${String(dayNumber).padStart(2, "0")}`;
  return {
    day,
    pickedAt: `${day} 14:46:00`,
    seedAt: `${day} 15:00:00`,
    transitAt: `${day} 19:07:00`,
    round1At: `${day} 19:15:00`,
    round2At: `${day} 19:20:00`,
    round3At: `${day} 19:25:00`,
    lateDeliveryAt: `${day} 19:14:00`,
    deliveryAt: `${day} 20:05:00`,
    waitingAt: `${day} 20:10:00`,
    signedAt: `${day} 21:10:00`,
  };
}

function cainiaoRecord(
  stateNum: number,
  details: { time: string; desc: string }[],
  mailNo = WAYBILL_3585,
) {
  return {
    mailNo,
    provider: "CaiNiao",
    cpCode: "STO",
    name: "申通快递",
    phone: PHONE,
    stateNum,
    details,
  };
}

function seedAligned3585(dates: ReturnType<typeof dayDates>) {
  clock = parseProviderTime(dates.round1At)!;
  memory.clear();
  scheduledNotifications.length = 0;
  setDiagnosticsEnabled(true);
  const seedAt = parseProviderTime(dates.seedAt)!;
  const listDto = parseAccountSyncResult("interface5", {
    code: 0,
    data: { expressList: [cainiaoRecord(103, [{ time: dates.pickedAt, desc: GENERIC }])] },
  }).parcels[0];
  let row = applyAccountShipment(undefined, parcelToShipment(listDto, [PHONE], seedAt)!, seedAt);
  const detailDto = parseAccountSyncResult("interface5", {
    code: 0,
    data: { expressList: [cainiaoRecord(103, [{ time: dates.pickedAt, desc: "广东东莞公司 已揽收" }])] },
  }).parcels[0];
  const detailIncoming = parcelToShipment(detailDto, [PHONE], seedAt)!;
  row = applyTargetedAccountShipment(row, asAccountDetailObservation(row, detailIncoming), seedAt);
  saveState({
    ...emptyState(),
    shipments: [row],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: seedAt - 86_400_000 }],
    feedSlotRebuiltAtMs: seedAt - 86_400_000,
  }, seedAt);
  saveGatewayToken("AbCdEfGh_123-456");
  const initial = loadState(clock).shipments[0];
  assert.equal(shipmentPresentationStatus(initial).semantic, "PICKED");
  assert.equal(initial.timeline.latestDetail, "广东东莞公司 已揽收");
  assert.equal(initial.timeline.latestTimeText, dates.pickedAt);
  assert.equal(cainiaoHasTrajectoryGap(initial, clock), false);
  return initial.identity.id;
}

test("3585 sequence: interrupted Round 1 v5_query keeps 14:46 PICKED pair, unchanged 19:20 Round 2 auto-supplements and publishes 19:07 TRANSIT + headline + detail cache atomically", async () => {
  const dates = dayDates(12);
  const rowId = seedAligned3585(dates);
  const list1907 = cainiaoRecord(104, [{ time: dates.transitAt, desc: GENERIC }]);
  let queryCalls = 0;
  let startedFlushedBeforeAbort = false;

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") {
      return jsonResponse({ code: 0, data: { expressList: [list1907] } });
    }
    assert.equal(path, "/api/express/timeline/source");
    queryCalls++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.interface, "v5");
    assert.equal(body.mode, "detail");
    assert.equal(body.record.waybill, WAYBILL_3585);
    startedFlushedBeforeAbort = readDiagnostics().some(
      entry => entry.event === "refresh.stage.started" &&
        entry.details.stage === "v5_query" &&
        entry.details.stagePhase === "query" &&
        entry.details.waybillTail === "3585",
    );
    return await new Promise((_resolve, reject) => {
      const abortNow = () => {
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      };
      init.signal?.addEventListener("abort", abortNow, { once: true });
      // Simulate iOS background task cutting off the refresh mid-v5_query once host budget expires.
      clock += 30_000;
      listRefreshInProgress("interface5");
    });
  }) as typeof fetch;

  // 19:15 Round 1: list reports 19:07 TRANSIT, per-parcel v5_query starts and is interrupted mid-flight.
  await assert.rejects(
    refreshAllShipments("interface5", {
      backgroundHostSafe: true,
      budgetMs: 30_000,
    }),
  );
  assert.equal(queryCalls, 1);
  assert.equal(startedFlushedBeforeAbort, true, "refresh.stage.started must flush before query completes");

  const cancelledDiag = readDiagnostics().find(
    entry => entry.event === "refresh.stage.failed" &&
      entry.details.stage === "v5_query" &&
      entry.details.waybillTail === "3585",
  );
  assert.ok(cancelledDiag, "interrupted v5_query must durably flush a terminal stage failure log");
  assert.equal(cancelledDiag.details.stagePhase, "query");
  assert.equal(cancelledDiag.details.result, "cancelled");
  assert.equal(cancelledDiag.details.errorCategory, "cancelled");

  const afterRound1 = loadState(clock).shipments[0];
  assert.equal(afterRound1.sourceTimeline?.semantic, "TRANSIT", "raw 19:07 list status is preserved");
  assert.equal(afterRound1.sourceTimeline?.statusEventAtMs, parseProviderTime(dates.transitAt));
  assert.equal(afterRound1.sourceTimeline?.latestDetail, GENERIC);
  assert.equal(cainiaoHasTrajectoryGap(afterRound1, clock), true, "gap remains open for Round 2");
  assert.equal(shipmentPresentationStatus(afterRound1).semantic, "PICKED",
    "status must NOT advance to TRANSIT while headline is still 14:46 PICKED");
  assert.equal(afterRound1.timeline.semantic, "PICKED");
  assert.equal(afterRound1.timeline.latestDetail, "广东东莞公司 已揽收");
  assert.equal(afterRound1.timeline.latestTimeText, dates.pickedAt);
  assert.equal(selectShipmentTimeline(afterRound1).semantic, "PICKED");
  assert.equal(selectShipmentDetailTimeline(afterRound1).tracks.length, 1);
  assert.equal(selectShipmentDetailTimeline(afterRound1).tracks[0].detail, "广东东莞公司 已揽收");
  assert.equal(scheduledNotifications.length, 0, "no split status/headline notification may fire on Round 1");

  const ledgerAfterRound1 = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(rowId)]);
  assert.equal(ledgerAfterRound1?.attempts, 1, "the (19:07, 14:46, 14:46) tuple recorded its single forced refresh");

  // 19:20 Round 2: list returns the exact same 19:07 TRANSIT; background auto-supplements without DetailPage.
  clock = parseProviderTime(dates.round2At)!;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") {
      return jsonResponse({ code: 0, data: { expressList: [list1907] } });
    }
    assert.equal(path, "/api/express/timeline/source");
    queryCalls++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.record.waybill, WAYBILL_3585);
    return jsonResponse({
      code: 0,
      data: {
        ...list1907,
        details: [
          { time: dates.transitAt, desc: "快件已发往【虎门转运中心】" },
          { time: dates.pickedAt, desc: "广东东莞公司 已揽收" },
        ],
      },
    });
  }) as typeof fetch;

  const round2 = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(round2.failed, 0);
  assert.equal(queryCalls, 2, "unchanged 19:20 background round must supplement 3585 via v5_query");

  const afterRound2 = loadState(clock).shipments[0];
  assert.equal(shipmentPresentationStatus(afterRound2).semantic, "TRANSIT");
  assert.equal(afterRound2.timeline.semantic, "TRANSIT");
  assert.equal(afterRound2.timeline.statusEventAtMs, parseProviderTime(dates.transitAt));
  assert.equal(afterRound2.timeline.latestDetail, "快件已发往【虎门转运中心】");
  assert.equal(afterRound2.timeline.latestTimeText, dates.transitAt);
  assert.equal(selectShipmentDetailTimeline(afterRound2).provider, "v5_query");
  assert.deepEqual(
    selectShipmentDetailTimeline(afterRound2).tracks.map(track => track.detail),
    ["快件已发往【虎门转运中心】", "广东东莞公司 已揽收"],
  );
  assert.equal(cainiaoHasTrajectoryGap(afterRound2, clock), false);
  assert.equal(shipmentDetailIncompleteReason(afterRound2), null);
  assert.equal(scheduledNotifications.length, 1, "aligned status + headline notification fires once tracks commit");

  const succeededDiag = readDiagnostics().find(
    entry => entry.event === "refresh.stage.succeeded" &&
      entry.details.stage === "v5_query" &&
      entry.details.waybillTail === "3585",
  );
  assert.ok(succeededDiag);
  assert.equal(succeededDiag.details.stagePhase, "write");
  assert.equal(succeededDiag.details.result, "aligned");

  // 19:25 Round 3: gap is filled, unchanged list makes 0 v5_query requests.
  clock = parseProviderTime(dates.round3At)!;
  await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 2, "once aligned, unchanged list must not re-query");
});

test("empty result, lagging tracks, and query timeout keep aligned 14:46 pair, log distinct phases, obey cooldown, and recover", async () => {
  const dates = dayDates(13);
  seedAligned3585(dates);
  const list1907 = cainiaoRecord(104, [{ time: dates.transitAt, desc: GENERIC }]);
  let mode: "empty" | "lagging" | "timeout" | "aligned" = "empty";
  let queryCalls = 0;

  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") {
      return jsonResponse({ code: 0, data: { expressList: [list1907] } });
    }
    assert.equal(path, "/api/express/timeline/source");
    queryCalls++;
    if (mode === "empty") return jsonResponse({ code: 0, data: { expressList: [] } });
    if (mode === "lagging") {
      return jsonResponse({
        code: 0,
        data: cainiaoRecord(103, [{ time: dates.pickedAt, desc: "广东东莞公司 已揽收" }]),
      });
    }
    if (mode === "timeout") throw new OperationTimeoutError("v5_query timed out");
    return jsonResponse({
      code: 0,
      data: cainiaoRecord(104, [
        { time: dates.transitAt, desc: "快件已到达【虎门转运中心】" },
        { time: dates.pickedAt, desc: "广东东莞公司 已揽收" },
      ]),
    });
  }) as typeof fetch;

  // 1) Empty result -> stagePhase="parse", result="empty"
  const emptyRun = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 1);
  assert.equal(emptyRun.failed, 1);
  let stored = loadState(clock).shipments[0];
  assert.equal(stored.timeline.semantic, "PICKED");
  assert.equal(stored.timeline.latestDetail, "广东东莞公司 已揽收");
  assert.equal(stored.sourceTimeline?.semantic, "TRANSIT");
  const emptyDiag = readDiagnostics().find(
    entry => entry.event === "refresh.stage.failed" && entry.details.result === "empty",
  );
  assert.ok(emptyDiag);
  assert.equal(emptyDiag.details.stagePhase, "parse");
  assert.equal(emptyDiag.details.errorCategory, "no_result");

  // 2) Past account_list 60s cooldown (+70s) but inside account_detail 5-min no_result cooldown -> skips without repeating forced refresh
  clock += 70_000;
  await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 1, "same tuple must not force-refresh a second time inside cooldown");
  const cooldownSkip = readDiagnostics().find(
    entry => entry.event === "refresh.stage.skipped" &&
      entry.details.stage === "v5_query" &&
      entry.details.skipReason === "cooldown",
  );
  assert.ok(cooldownSkip);
  assert.equal(cooldownSkip.details.cooldownReason, "no_result");

  // 3) Past 5-min no_result cooldown, query returns lagging 14:46 tracks -> stagePhase="write", result="lagging"
  clock += 6 * 60_000;
  mode = "lagging";
  const laggingRun = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 2);
  assert.equal(laggingRun.failed, 1);
  stored = loadState(clock).shipments[0];
  assert.equal(stored.timeline.semantic, "PICKED");
  assert.equal(stored.timeline.latestDetail, "广东东莞公司 已揽收");
  assert.equal(stored.timeline.latestTimeText, dates.pickedAt);
  assert.equal(cainiaoHasTrajectoryGap(stored, clock), true);
  const laggingDiag = readDiagnostics().find(
    entry => entry.event === "refresh.stage.failed" && entry.details.result === "lagging",
  );
  assert.ok(laggingDiag);
  assert.equal(laggingDiag.details.stagePhase, "write");
  assert.equal(laggingDiag.details.errorCategory, "stale_timeline");

  // 4) Past 5-min no_result cooldown, query times out -> stagePhase="query", result="timeout"
  clock += 6 * 60_000;
  mode = "timeout";
  const timeoutRun = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 3);
  assert.equal(timeoutRun.failed, 1);
  stored = loadState(clock).shipments[0];
  assert.equal(stored.timeline.semantic, "PICKED");
  assert.equal(stored.timeline.latestDetail, "广东东莞公司 已揽收");
  const timeoutDiag = readDiagnostics().find(
    entry => entry.event === "refresh.stage.failed" && entry.details.result === "timeout",
  );
  assert.ok(timeoutDiag);
  assert.equal(timeoutDiag.details.stagePhase, "query");
  assert.equal(timeoutDiag.details.errorCategory, "timeout");

  // 5) Past 4-min timeout backoff (3rd consecutive failure), matching 19:07 tracks arrive -> atomic publish
  clock += 5 * 60_000;
  mode = "aligned";
  const alignedRun = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 4);
  assert.equal(alignedRun.failed, 0);
  stored = loadState(clock).shipments[0];
  assert.equal(stored.timeline.semantic, "TRANSIT");
  assert.equal(stored.timeline.latestDetail, "快件已到达【虎门转运中心】");
  assert.equal(stored.timeline.latestTimeText, dates.transitAt);
  assert.equal(cainiaoHasTrajectoryGap(stored, clock), false);
});

test("storage write failure during v5_query commit retains 14:46 pair, logs stagePhase=write result=write_failed, and recovers next round", async () => {
  const dates = dayDates(14);
  seedAligned3585(dates);
  const list1907 = cainiaoRecord(104, [{ time: dates.transitAt, desc: GENERIC }]);
  let queryCalls = 0;
  let failAccountDetailWrite = false;
  const originalWriteAsStringSync = FileManager.writeAsStringSync;
  FileManager.writeAsStringSync = (path: string, value: string) => {
    if (failAccountDetailWrite && path.includes("/transactions-v1/") && path.endsWith("/state.json")) {
      failAccountDetailWrite = false;
      throw new Error("ENOSPC: synthetic durable write failure");
    }
    return originalWriteAsStringSync(path, value);
  };

  try {
    globalThis.fetch = (async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
      if (path === "/api/express/accounts/sync") {
        return jsonResponse({ code: 0, data: { expressList: [list1907] } });
      }
      assert.equal(path, "/api/express/timeline/source");
      queryCalls++;
      if (queryCalls === 1) failAccountDetailWrite = true;
      return jsonResponse({
        code: 0,
        data: cainiaoRecord(104, [
          { time: dates.transitAt, desc: "快件已发往【虎门转运中心】" },
          { time: dates.pickedAt, desc: "广东东莞公司 已揽收" },
        ]),
      });
    }) as typeof fetch;

    const failedWriteRun = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
    assert.equal(queryCalls, 1);
    assert.equal(failedWriteRun.failed, 1);

    const storedAfterWriteFailure = loadState(clock).shipments[0];
    assert.equal(storedAfterWriteFailure.sourceTimeline?.semantic, "TRANSIT",
      "list checkpoint preserved raw 19:07 status for future supplement");
    assert.equal(storedAfterWriteFailure.timeline.semantic, "PICKED",
      "failed v5_query write must retain aligned 14:46 PICKED status");
    assert.equal(storedAfterWriteFailure.timeline.latestDetail, "广东东莞公司 已揽收");
    assert.equal(storedAfterWriteFailure.timeline.latestTimeText, dates.pickedAt);
    assert.equal(selectShipmentDetailTimeline(storedAfterWriteFailure).tracks.length, 1);
    assert.equal(scheduledNotifications.length, 0);

    const writeFailedDiag = readDiagnostics().find(
      entry => entry.event === "refresh.stage.failed" &&
        entry.details.stage === "v5_query" &&
        entry.details.result === "write_failed",
    );
    assert.ok(writeFailedDiag);
    assert.equal(writeFailedDiag.details.stagePhase, "write");

    // Next round after 2-minute failure cooldown recovers and commits 19:07 TRANSIT + headline together.
    clock += 3 * 60_000;
    const recoveredRun = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
    assert.equal(queryCalls, 2);
    assert.equal(recoveredRun.failed, 0);
    const storedAfterRecovery = loadState(clock).shipments[0];
    assert.equal(storedAfterRecovery.timeline.semantic, "TRANSIT");
    assert.equal(storedAfterRecovery.timeline.latestDetail, "快件已发往【虎门转运中心】");
    assert.equal(storedAfterRecovery.timeline.latestTimeText, dates.transitAt);
    assert.equal(scheduledNotifications.length, 1);
  } finally {
    FileManager.writeAsStringSync = originalWriteAsStringSync;
  }
});

test("late v5_query response is re-validated against write-time status and rejected when status already advanced to 19:14 DELIVERY", async () => {
  const dates = dayDates(15);
  seedAligned3585(dates);
  const list1907 = cainiaoRecord(104, [{ time: dates.transitAt, desc: GENERIC }]);
  const list1914 = cainiaoRecord(105, [{ time: dates.lateDeliveryAt, desc: GENERIC }]);
  let queryCalls = 0;

  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") {
      return jsonResponse({ code: 0, data: { expressList: [queryCalls === 0 ? list1907 : list1914] } });
    }
    assert.equal(path, "/api/express/timeline/source");
    queryCalls++;
    if (queryCalls === 1) {
      // Simulate late arrival: while the 19:07 v5_query is in flight (2s network time), the parcel's persisted
      // source status advances to 19:14 DELIVERY (7 minutes ahead of 19:07 > STATUS_ALIGNMENT_MS).
      clock += 2_000;
      const before = loadState(clock);
      const newerDto = parseAccountSyncResult("interface5", {
        code: 0,
        data: { expressList: [list1914] },
      }).parcels[0];
      const updated = applyAccountShipment(
        before.shipments[0],
        parcelToShipment(newerDto, [PHONE], clock)!,
        clock,
      );
      commitRefreshState(before, { ...before, shipments: [updated] }, "interface5", clock);
      return jsonResponse({
        code: 0,
        data: cainiaoRecord(104, [
          { time: dates.transitAt, desc: "快件已发往【虎门转运中心】" },
          { time: dates.pickedAt, desc: "广东东莞公司 已揽收" },
        ]),
      });
    }
    return jsonResponse({
      code: 0,
      data: cainiaoRecord(105, [
        { time: dates.lateDeliveryAt, desc: "【东莞南城】派件员正在为您派送" },
        { time: dates.transitAt, desc: "快件已发往【虎门转运中心】" },
        { time: dates.pickedAt, desc: "广东东莞公司 已揽收" },
      ]),
    });
  }) as typeof fetch;

  const lateRun = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 1);
  assert.equal(lateRun.failed, 1);

  const afterLate = loadState(clock).shipments[0];
  assert.equal(afterLate.sourceTimeline?.semantic, "DELIVERY",
    "write-time latest 19:14 DELIVERY source status remains intact");
  assert.equal(afterLate.sourceTimeline?.statusEventAtMs, parseProviderTime(dates.lateDeliveryAt));
  assert.equal(afterLate.timeline.semantic, "PICKED",
    "late 19:07 transit tracks must NOT publish DELIVERY with a 19:07 headline or overwrite aligned 14:46 pair");
  assert.equal(afterLate.timeline.latestDetail, "广东东莞公司 已揽收");
  assert.equal(afterLate.timeline.latestTimeText, dates.pickedAt);
  assert.equal(cainiaoHasTrajectoryGap(afterLate, clock), true);

  const lateDiag = readDiagnostics().find(
    entry => entry.event === "refresh.stage.failed" &&
      entry.details.stage === "v5_query" &&
      entry.details.result === "lagging",
  );
  assert.ok(lateDiag);
  assert.equal(lateDiag.details.stagePhase, "write");

  // 70s later (inside account_detail 5-min no_result cooldown, past account_list 60s cooldown):
  // the new (19:14, 14:46, 14:46, DELIVERY) tuple force-refreshes once immediately and aligns!
  clock += 70_000;
  const catchupRun = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 2);
  assert.equal(catchupRun.failed, 0);
  const afterCatchup = loadState(clock).shipments[0];
  assert.equal(afterCatchup.timeline.semantic, "DELIVERY");
  assert.equal(afterCatchup.timeline.latestDetail, "【东莞南城】派件员正在为您派送");
  assert.equal(afterCatchup.timeline.latestTimeText, dates.lateDeliveryAt);
  assert.equal(selectShipmentDetailTimeline(afterCatchup).tracks.length, 3);
  assert.equal(cainiaoHasTrajectoryGap(afterCatchup, clock), false);
});

test("DetailPage v5_query coalescing, upstream_rejected risk-control cooldown, and signed_frozen are preserved", async () => {
  const dates = dayDates(16);
  const rowId = seedAligned3585(dates);
  const list1907 = cainiaoRecord(104, [{ time: dates.transitAt, desc: GENERIC }]);
  let queryCalls = 0;
  let releaseQuery!: () => void;
  const queryGate = new Promise<void>(resolve => { releaseQuery = resolve; });
  let detailPromise: Promise<unknown> | undefined;

  // 1) Coalescing: background v5_query and concurrent DetailPage detail_open share a single upstream request.
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") {
      return jsonResponse({ code: 0, data: { expressList: [list1907] } });
    }
    assert.equal(path, "/api/express/timeline/source");
    queryCalls++;
    detailPromise = refreshShipmentById(rowId, { trigger: "detail_open" });
    releaseQuery();
    await queryGate;
    return jsonResponse({
      code: 0,
      data: cainiaoRecord(104, [
        { time: dates.transitAt, desc: "快件已发往【虎门转运中心】" },
        { time: dates.pickedAt, desc: "广东东莞公司 已揽收" },
      ]),
    });
  }) as typeof fetch;

  await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  await detailPromise;
  assert.equal(queryCalls, 1, "concurrent DetailPage and background supplement coalesce into 1 v5_query request");

  // 2) Risk control (HTTP 429 -> upstream_rejected 60-min cooldown) blocks even a brand-new tuple.
  clock = parseProviderTime(`${dates.day} 20:06:00`)!;
  const list2005 = cainiaoRecord(105, [{ time: dates.deliveryAt, desc: GENERIC }]);
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") {
      return jsonResponse({ code: 0, data: { expressList: [list2005] } });
    }
    queryCalls++;
    return { ok: false, status: 429, text: async () => "Too Many Requests" };
  }) as typeof fetch;

  const rateLimited = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 2);
  assert.equal(rateLimited.failed, 1);

  // 5 minutes later, even if list advances again to 20:10 WAITING_PICKUP, 60-min risk-control cooldown holds!
  clock += 5 * 60_000;
  const list2010 = cainiaoRecord(106, [{ time: dates.waitingAt, desc: GENERIC }]);
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") {
      return jsonResponse({ code: 0, data: { expressList: [list2010] } });
    }
    queryCalls++;
    return jsonResponse({ code: 0, data: { expressList: [] } });
  }) as typeof fetch;
  await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 2, "upstream_rejected risk-control cooldown must block forced refresh");

  // 3) Past 60-min risk-control cooldown (+67m to clear ±10% jitter), parcel signs at 21:10 -> aligns once and enters signed_frozen!
  clock += 67 * 60_000;
  const list2110 = cainiaoRecord(107, [{ time: dates.signedAt, desc: GENERIC }]);
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    if (path === "/api/express/accounts/sync") {
      return jsonResponse({ code: 0, data: { expressList: [list2110] } });
    }
    queryCalls++;
    return jsonResponse({
      code: 0,
      data: cainiaoRecord(107, [
        { time: dates.signedAt, desc: "已签收，签收人凭取货码签收" },
        { time: dates.transitAt, desc: "快件已发往【虎门转运中心】" },
        { time: dates.pickedAt, desc: "广东东莞公司 已揽收" },
      ]),
    });
  }) as typeof fetch;
  await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 3);
  const signedRow = loadState(clock).shipments[0];
  assert.equal(signedRow.timeline.semantic, "COMPLETED");
  assert.equal(signedRow.timeline.latestDetail, "已签收，签收人凭取货码签收");
  assert.equal(signedRefreshFrozen(signedRow, clock), true);

  clock += 10 * 60_000;
  await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(queryCalls, 3, "signed_frozen row must not issue any further v5_query");
});
