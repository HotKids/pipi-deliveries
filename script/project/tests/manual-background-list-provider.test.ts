import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { manualProviderSchedule, queryManualForSource } from "../services/manual-query";
import { recordRefreshProviderResult } from "../services/refresh-runtime-state";
import { hasTimelineStartBeforeKdniao, selectShipmentTimeline, shipmentDetailCandidateEvidence, shipmentSelectionEvidence } from "../services/shipment-policy";
import { commitRefreshState, emptyState, loadState, saveState } from "../services/storage";
import { runShipmentEnrichmentForTesting } from "../services/sync";

// 用户定 2026-09-24（与 Pipi 对齐）：手动件的后台刷新（manual_refresh）回头问的是列表正显示的那一级。
// 列表是 v4_query（免费、非网页的手动源）就只问 v4_query；网页/H5、付费、v6_query 或没有时照旧问 Online。
// 失败、冷却都不换级。实例：尾号 6250 的中通手动件，列表显示 v4_query「运输中」，后台一直在问 v6_query，
// 502/超时，只有详情下拉（主竞赛跑 v4_query）才拿到已签收。
// The October 19 amendment lets background hosts follow selected KDNiao history; foreground entries retain Online.

const WAYBILL = "78912345676250", PHONE = "13800001234";
const MOTO_PATH = "/api/express/timeline/public", ONLINE_PATH = "/api/express/timeline/source";
const PAID_PATH = "/api/express/timeline/fallback";
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

function manualRow(provider: "v4_query" | "k100_h5"): Shipment {
  const tracks = [NOW - 3 * 3600000, NOW - 9 * 3600000].map((at, index) => ({
    timeMs: at, timeText: providerTime(at), detail: index ? "【杭州市】快件已揽收" : "【杭州市】快件运输中",
    statusCode: "", raw: {},
  }));
  const pack: TimelinePackage = {
    provider, waybill: WAYBILL, courierCode: "ZTO", rawCourierCode: "ZTO", companyName: "中通快递",
    semantic: "TRANSIT", structuredStatus: provider === "v4_query", statusEventAtMs: tracks[0].timeMs,
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
  };
}

/**
 * 后台刷新一轮（排程触发，不是用户下拉），真走 queryManualForSource，只把网关请求换成记录。回调里的
 * 错误会被手动链吞掉，所以断言一律看记下来的 paths，不在回调里断言。
 */
async function backgroundRound(row: Shipment, post: (path: string) => Record<string, unknown>,
  options: { background?: boolean; force?: boolean } = {}) {
  memory.clear();
  setDiagnosticsEnabled(true);
  let base = saveState({ ...emptyState(), shipments: [row],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }] }, NOW);
  const paths: string[] = [];
  const checkpoint: Parameters<typeof runShipmentEnrichmentForTesting>[3] = (candidate, _routes, _stage, jobBase) => {
    const result = commitRefreshState(jobBase || base, candidate, "interface5", Date.now());
    assert.equal(result.applied, true);
    base = result.state;
    return base;
  };
  return { paths, run: async () => {
    const calls: Parameters<typeof queryManualForSource>[0][] = [];
    await runShipmentEnrichmentForTesting(loadState(NOW), "interface5", "background", checkpoint, NOW + 60000,
      new Set(), options.force === true, false, undefined, {
        queryManualForSource: async input => {
          calls.push(input);
          return queryManualForSource({ ...input, dependencies: { now: () => NOW, post: async path => {
            paths.push(path);
            return post(path);
          } } });
        },
      }, false, new Set(), undefined, options.background !== false);
    return calls;
  } };
}

const signedMoto = () => ({
  status: 0,
  data: {
    cpCode: "ZTO", cpName: "中通快递", logisticsStatus: "SIGN",
    fullTraceDetail: [
      { time: providerTime(NOW - 600000), desc: "【杭州市】快件已签收" },
      { time: providerTime(NOW - 3 * 3600000), desc: "【杭州市】快件运输中" },
      { time: providerTime(NOW - 9 * 3600000), desc: "【杭州市】快件已揽收" },
    ],
  },
});

function stageEvents(event: string) {
  return readDiagnostics().filter(entry => entry.event === event && entry.details.stage === "manual_refresh");
}

test("a manual row whose list shows v4_query is refreshed from v4_query in the background", async () => {
  const row = manualRow("v4_query");
  assert.equal(shipmentSelectionEvidence(row).historyProvider, "v4_query");
  const round = await backgroundRound(row, path => path === MOTO_PATH ? signedMoto() : { code: 502 });
  const calls = await round.run();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].motoOnly, true);
  assert.notEqual(calls[0].pickerOnly, true);
  assert.equal(calls[0].includeKdniaoFallback, false);
  assert.equal(calls[0].scheduled, true);
  assert.deepEqual(round.paths, [MOTO_PATH], "the background refresh does not ask Online");
  const stored = loadState(NOW).shipments[0];
  assert.equal(selectShipmentTimeline(stored).semantic, "COMPLETED");
  assert.equal(selectShipmentTimeline(stored).provider, "v4_query");
  assert.equal(stageEvents("refresh.stage.started")[0]?.details.requestProvider, "v4_query",
    "the stage log names the provider actually asked");
  assert.equal(stageEvents("refresh.stage.succeeded")[0]?.details.requestProvider, "v4_query");
});

test("a manual row whose list shows k100_h5 still refreshes from Online", async () => {
  const row = manualRow("k100_h5");
  assert.equal(shipmentSelectionEvidence(row).historyProvider, "k100_h5");
  const round = await backgroundRound(row, () => ({ code: 502 }));
  const calls = await round.run();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pickerOnly, true);
  assert.notEqual(calls[0].motoOnly, true);
  assert.ok(round.paths.length > 0 && round.paths.every(path => path === ONLINE_PATH));
  assert.equal(stageEvents("refresh.stage.started")[0]?.details.requestProvider, "v6_query");
});

test("a failed v4_query background refresh does not fall through to another provider", async () => {
  const round = await backgroundRound(manualRow("v4_query"), () => { throw new Error("Synthetic 502"); });
  const calls = await round.run();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].motoOnly, true);
  assert.deepEqual(round.paths, [MOTO_PATH], "neither Online nor KDNiao is asked after the failure");
  const failed = stageEvents("refresh.stage.failed")[0];
  assert.equal(failed?.details.requestProvider, "v4_query");
  assert.equal(loadState(NOW).shipments[0].manualTimelines?.length, 1, "no other provider package appears");
});

test("a v4_query cooldown skips the round instead of asking Online", async () => {
  const row = manualRow("v4_query");
  const round = await backgroundRound(row, () => ({ code: 502 }));
  const schedule = manualProviderSchedule({ source: "interface5", waybill: WAYBILL, rawCourierCode: "ZTO",
    phoneTail: row.identity.phoneTail });
  recordRefreshProviderResult({ key: schedule.key, provider: "moto",
    identityFingerprint: schedule.identityFingerprint, result: "success", now: NOW - 60000 });
  const calls = await round.run();
  assert.equal(calls.length, 0);
  assert.deepEqual(round.paths, [], "a cooled-down round sends no request to any provider");
  const skipped = stageEvents("refresh.stage.skipped")[0];
  assert.equal(skipped?.details.skipReason, "cooldown");
  assert.equal(skipped?.details.requestProvider, "v4_query");
});

test("a newer Online foreground package advances a manual row selected from KDNiao", async () => {
  const old = manualRow("v4_query");
  const paid = { ...old.timeline, provider: "kdniao", complete: true,
    tracks: [...old.timeline.tracks, { ...old.timeline.tracks[1], timeMs: NOW - 12 * 3600000,
      timeText: providerTime(NOW - 12 * 3600000), detail: "Earlier paid-provider event" }] };
  const row = { ...old, timeline: paid, manualTimelines: [paid],
    detailSelection: { provider: "kdniao", selectedAtMs: NOW - 3600000 } };
  const fresh = { ...paid, provider: "v6_query", structuredStatus: true,
    semantic: "DELIVERY" as const, statusEventAtMs: NOW - 60000,
    latestTimeText: providerTime(NOW - 60000), latestDetail: "Current Online delivery event",
    tracks: [{ timeMs: NOW - 60000, timeText: providerTime(NOW - 60000),
      detail: "Current Online delivery event", statusCode: "5", raw: { statusCode: "5" } },
      ...old.timeline.tracks], successAtMs: NOW };
  const round = await backgroundRound(row, () => ({ code: 200,
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic: "DELIVERY", code: "DELIVERY", text: "Delivery",
      priority: 0, eventAtMs: NOW - 60000, structured: true },
    value: { nu: WAYBILL, com: "ZTO", tracks: fresh.tracks.map((track, index) => ({
      time: track.timeText, context: track.detail, ...(index ? {} : { state: "DELIVERY" }),
    })) },
  }), { background: false });
  assert.equal(shipmentSelectionEvidence(loadState(NOW).shipments[0]).historyProvider, "kdniao");
  const calls = await round.run();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pickerOnly, true, "foreground list refresh retains Online for KDNiao history");
  assert.equal(calls[0].includeKdniaoFallback, false);
  assert.deepEqual(round.paths, [ONLINE_PATH]);
  const stored = loadState(NOW).shipments[0];
  const selected = selectShipmentTimeline(stored);
  assert.equal(selected.provider, "v6_query", "stale paid history is incomplete against the newer response");
  assert.equal(selected.latestDetail, fresh.latestDetail);
  assert.equal(selected.semantic, "DELIVERY");
  assert.equal(shipmentDetailCandidateEvidence(stored, paid).incompleteReason, "time_mismatch");
});

test("a one-node foreground Online reply keeps its isolated status evidence without bypassing sticky history", async () => {
  const old = manualRow("v4_query");
  const paid = { ...old.timeline, provider: "kdniao", complete: true };
  const row = { ...old, timeline: paid, manualTimelines: [paid],
    detailSelection: { provider: "kdniao", selectedAtMs: NOW - 3600000 } };
  const round = await backgroundRound(row, () => ({ code: 200,
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic: "DELIVERY", code: "DELIVERY", text: "Delivery",
      priority: 0, eventAtMs: NOW - 60000, structured: true },
    value: { nu: WAYBILL, com: "ZTO", time: providerTime(NOW - 60000), context: "Current Online event",
      state: "DELIVERY" },
  }), { background: false });
  const calls = await round.run();
  assert.equal(calls[0].pickerOnly, true);
  assert.equal(calls[0].includeKdniaoFallback, false);
  assert.deepEqual(round.paths, [ONLINE_PATH]);
  const stored = loadState(NOW).shipments[0];
  const online = stored.manualTimelines!.find(timeline => timeline.provider === "v6_query")!;
  assert.equal(online.tracks.length, 1);
  assert.equal(online.semantic, "DELIVERY");
  assert.equal(online.structuredStatus, true);
  assert.equal(shipmentDetailCandidateEvidence(stored, online).incompleteReason, "missing_pickup");
  assert.equal(selectShipmentTimeline(stored).provider, "kdniao",
    "freshness alone cannot replace the selected package with incomplete history");
  assert.equal(selectShipmentTimeline(stored).semantic, paid.semantic,
    "the existing donor rule fills missing status; it does not replace a selected known status");
});

function paidRow(): Shipment {
  const old = manualRow("v4_query");
  const paid = { ...old.timeline, provider: "kdniao", complete: true };
  return { ...old, timeline: paid, manualTimelines: [paid],
    detailSelection: { provider: "kdniao", selectedAtMs: NOW - 3600000 } };
}

const signedPaid = () => ({
  success: true, shipperCode: "ZTO", logisticCode: WAYBILL, state: "3",
  traces: [
    { acceptTime: providerTime(NOW - 600000), acceptStation: "【杭州市】快件已签收" },
    { acceptTime: providerTime(NOW - 3 * 3600000), acceptStation: "【杭州市】快件运输中" },
    { acceptTime: providerTime(NOW - 9 * 3600000), acceptStation: "【杭州市】快件已揽收" },
  ],
});

test("background KDNiao refresh advances its selected manual history despite an Online cooldown and then freezes", async () => {
  const row = paidRow();
  const round = await backgroundRound(row, path => path === PAID_PATH ? signedPaid() : { code: 502 });
  const schedule = manualProviderSchedule({ source: "interface5", waybill: WAYBILL,
    rawCourierCode: "ZTO", phoneTail: row.identity.phoneTail });
  recordRefreshProviderResult({ key: schedule.key, provider: "picker",
    identityFingerprint: schedule.identityFingerprint, result: "invalid_query", now: NOW - 60000 });
  const calls = await round.run();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fallbackOnly, true);
  assert.equal(calls[0].includeKdniaoFallback, true);
  assert.equal(calls[0].scheduled, true);
  assert.deepEqual(round.paths, [PAID_PATH]);
  const selected = selectShipmentTimeline(loadState(NOW).shipments[0]);
  assert.equal(selected.provider, "kdniao");
  assert.equal(selected.semantic, "COMPLETED");
  assert.equal(selected.tracks.length, 3);
  assert.equal(stageEvents("refresh.stage.succeeded")[0]?.details.requestProvider, "kdniao");
  assert.equal((await round.run()).length, 0, "signed history stops further background requests");
  assert.deepEqual(round.paths, [PAID_PATH]);
});

test("background KDNiao cooldown logs its schedule and never switches to Online", async () => {
  const row = paidRow();
  const round = await backgroundRound(row, () => signedPaid());
  const schedule = manualProviderSchedule({ source: "interface5", waybill: WAYBILL,
    rawCourierCode: "ZTO", phoneTail: row.identity.phoneTail });
  recordRefreshProviderResult({ key: schedule.key, provider: "kdniao",
    identityFingerprint: schedule.identityFingerprint, result: "upstream_rejected", now: NOW - 60000 });
  assert.equal((await round.run()).length, 0);
  assert.deepEqual(round.paths, []);
  const details = stageEvents("refresh.stage.skipped")[0]?.details;
  assert.equal(details?.requestProvider, "kdniao");
  assert.equal(details?.cooldownReason, "upstream_rejected");
  assert.equal(details?.providerLastAttemptAtMs, NOW - 60000);
  assert.equal(details?.providerFailures, 1);
  assert.ok(Number(details?.cooldownRemainingMs) >= 3180000);
  assert.equal(Number(details?.providerNextDueAtMs), NOW + Number(details?.cooldownRemainingMs));
});

test("a failed background KDNiao refresh does not switch providers or discard history", async () => {
  const row = paidRow();
  const round = await backgroundRound(row, () => { throw new Error("Synthetic paid source failure"); });
  const calls = await round.run();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fallbackOnly, true);
  assert.deepEqual(round.paths, [PAID_PATH]);
  assert.equal(stageEvents("refresh.stage.failed")[0]?.details.requestProvider, "kdniao");
  assert.equal(selectShipmentTimeline(loadState(NOW).shipments[0]).semantic, "TRANSIT");
  assert.equal((await round.run()).length, 0, "failed attempts use KDNiao's own cooldown");
  assert.deepEqual(round.paths, [PAID_PATH]);
});

test("selected KDNiao background refresh is not blocked by an aligned free cache", async () => {
  const row = paidRow();
  row.manualTimelines = [...row.manualTimelines!, { ...row.timeline, provider: "v4_query" }];
  assert.equal(shipmentSelectionEvidence(row).historyProvider, "kdniao");
  assert.equal(hasTimelineStartBeforeKdniao(row), true,
    "the free cache would stop an ordinary paid fallback contest");
  const round = await backgroundRound(row, () => signedPaid());
  await round.run();
  assert.deepEqual(round.paths, [PAID_PATH], "a direct background refresh must query its selected provider");
  assert.equal(selectShipmentTimeline(loadState(NOW).shipments[0]).semantic, "COMPLETED");
});

test("a non-selected KDNiao candidate never opens background paid refresh", async () => {
  const row = manualRow("v4_query");
  row.manualTimelines = [...row.manualTimelines!, { ...paidRow().timeline,
    tracks: row.timeline.tracks.slice(0, 1), complete: false }];
  const round = await backgroundRound(row, () => signedMoto());
  assert.equal(shipmentSelectionEvidence(row).historyProvider, "v4_query");
  assert.equal((await round.run())[0]?.motoOnly, true);
  assert.deepEqual(round.paths, [MOTO_PATH]);
});

test("explicit Home pull retains Online for a KDNiao-selected manual row", async () => {
  const round = await backgroundRound(paidRow(), () => ({ code: 502 }), { force: true });
  const calls = await round.run();
  assert.equal(calls[0]?.pickerOnly, true);
  assert.equal(calls[0]?.includeKdniaoFallback, false);
  assert.ok(round.paths.length > 0 && round.paths.every(path => path === ONLINE_PATH));
});
