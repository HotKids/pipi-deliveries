import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { memory } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { Shipment, TimelinePackage } from "../models";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import {
  selectShipmentDetailTimeline,
  shipmentDetailCandidateEvidence,
  shipmentDetailIncompleteReason,
} from "../services/shipment-policy";
import { containsTimelinePickupTrack } from "../services/status";
import { setDiagnosticsEnabled } from "../services/logger";

// 用户 2026-09-24 采纳（Pixel 上 Pipi 的实测，三端同一套逻辑）：顺丰承运的京东订单，缓存的京粉页包有 6 条节点、
// 含「顺丰速运 已收取快件」，最新一条 16:16；账号列表最新 17:21。详情选包判京粉页包不完整
// （rankingComplete=false），显示的是更新的 2 条账号历史，里面没有揽收；可 K100 / 快递鸟一次都没跑，理由是
// 「京粉页有揽收」。缓存的京粉页包只有在详情选包也判它完整时，才能替手动链作主。
// 节点内容为合成数据，时钟取自实测：列表 17:21，京粉页 16:16。

const LIST_AT = Date.UTC(2026, 8, 24, 9, 21); // 17:21 Beijing
const NOW = LIST_AT + 20 * 60_000;
const ORDER = "3622448007489901", WAYBILL = "SF1234567890127", PHONE = "13800002424";
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

/** The account list: two carrier nodes, neither of them the pickup. */
function listParcel(): AccountParcelDto {
  const tracks = [
    { timeText: providerTime(LIST_AT), detail: "Synthetic list transit 1", statusCode: "" },
    { timeText: providerTime(LIST_AT - 40 * 60_000), detail: "Synthetic list transit 0", statusCode: "" },
  ];
  return {
    source: "interface5", ownerId: ORDER, orderId: ORDER, accountOrder: true, waybill: WAYBILL,
    courierCode: "SF", rawCourierCode: "SF", companyName: "顺丰速运", sourceProvider: "JingDong",
    sourceStateCode: "104", sourceStateText: "TRANSIT", semantic: "TRANSIT",
    normalizedStatusScope: "SHIPMENT", normalizedStatusSemantic: "TRANSIT", normalizedStatusText: "运输中",
    receiverPhone: PHONE, senderPhone: "", latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail,
    tracks, routeUrl: "", projectionUrl: "",
  };
}

/** A captured union-page package: six nodes ending at the carrier pickup, newest at `newestAt`. */
function unionPage(newestAt: number): TimelinePackage {
  const tracks = Array.from({ length: 6 }, (_, i) => ({
    timeMs: newestAt - i * 30 * 60_000,
    timeText: providerTime(newestAt - i * 30 * 60_000),
    detail: i === 5 ? "顺丰速运 已收取快件" : `Synthetic union transit ${5 - i}`,
    statusCode: "",
    raw: { _pipiStatusSource: "jingdong_h5" },
  }));
  return {
    provider: "jd_h5", waybill: WAYBILL, courierCode: "SF", companyName: "顺丰速运",
    semantic: "UNKNOWN", structuredStatus: false, complete: true, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: newestAt + 60_000,
  };
}

function seed(unionPageNewestAt: number): Shipment {
  memory.clear();
  setDiagnosticsEnabled(true);
  const row = parcelToShipment(
    { ...listParcel(), projectionTimeline: unionPage(unionPageNewestAt) }, [PHONE], NOW)!;
  return saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW).shipments[0];
}

/** A K100 page answering with the whole history, pickup included, up to the list's clock. */
function kuaidi100Answer(shipment: Shipment): Shipment {
  const tracks = [LIST_AT, LIST_AT - 40 * 60_000, LIST_AT - 5 * 3600_000].map((at, i) => ({
    timeMs: at, timeText: providerTime(at), statusCode: "", raw: {},
    detail: i === 2 ? "顺丰速运 已收取快件" : `Synthetic K100 transit ${2 - i}`,
  }));
  const timeline: TimelinePackage = {
    provider: "k100_h5", waybill: WAYBILL, courierCode: "SF", companyName: "顺丰速运",
    semantic: "TRANSIT", structuredStatus: false, statusEventAtMs: LIST_AT, complete: true, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: NOW,
  };
  return { ...shipment, timeline, sourceTimeline: null, manualTimelines: [timeline] };
}

const lease = { isCurrent: () => true, deadlineAtMs: NOW + 30000 };
const pull = { trigger: "detail_pull" as const, forceManualRefresh: true, includeKdniaoFallback: true };
const unexpected: string[] = [];
afterEach(() => {
  assert.deepEqual(unexpected.splice(0), [], "a stubbed request that must not run was called");
});
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

type Calls = { k100: number; kdniao: number; other: number };
function runtime(calls: Calls, k100: (shipment: Shipment) => Shipment | null = () => null) {
  return {
    refreshAccountParcel: async (): Promise<AccountParcelDto | null> => {
      unexpected.push("a pull does not query v5 here");
      throw new Error("Synthetic unexpected v5 query");
    },
    projectAccountOrderWithCarrier: async (): Promise<AccountParcelDto> => {
      unexpected.push("no page reference is saved, so the union page cannot open");
      throw new Error("Synthetic unexpected union page");
    },
    refreshWebTimeline: async (shipment: Shipment) => {
      calls.k100++;
      return k100(shipment);
    },
    queryManualForSource: async (input: { fallbackOnly?: boolean }) => {
      if (input.fallbackOnly) calls.kdniao++;
      else calls.other++;
      return { result: "empty_response" as const, shipment: null, pending: null, routeUrl: "" };
    },
  };
}

test("the Pixel case: a cached union page with pickup that detail selection rejects no longer stops K100 and KDNiao", async () => {
  const row = seed(LIST_AT - 65 * 60_000); // 16:16
  const union = row.manualTimelines!.find((timeline) => timeline.provider === "jd_h5")!;
  const evidence = shipmentDetailCandidateEvidence(row, union);
  assert.equal(evidence.hasPickup, true, "the cached package does contain the pickup");
  assert.equal(evidence.detailComplete, false, "detail selection does not count it complete");
  assert.equal(evidence.incompleteReason, "time_mismatch", "65 minutes behind the list is outside the 30-minute lag");
  const displayed = selectShipmentDetailTimeline(row);
  assert.notEqual(displayed.provider, "jd_h5", "the newer account history is displayed");
  assert.equal(displayed.tracks.length, 2);
  assert.equal(containsTimelinePickupTrack(displayed.tracks), false, "the displayed history has no pickup");
  assert.equal(shipmentDetailIncompleteReason(row), "missing_pickup");

  const calls = { k100: 0, kdniao: 0, other: 0 };
  await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime(calls));
  assert.equal(calls.k100, 1, "the free K100 page runs");
  assert.equal(calls.kdniao, 1, "K100 found nothing, so the paid fallback runs as before");
  assert.equal(calls.other, 0);
});

test("KDNiao keeps its own conditions: a K100 answer reaching pickup, or a pull without the paid fallback, stops it", async () => {
  const answered = { k100: 0, kdniao: 0, other: 0 };
  let row = seed(LIST_AT - 65 * 60_000);
  await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime(answered, kuaidi100Answer));
  assert.equal(answered.k100, 1);
  assert.equal(answered.kdniao, 0, "a free answer reaching pickup leaves the paid fallback unused");

  const free = { k100: 0, kdniao: 0, other: 0 };
  row = seed(LIST_AT - 65 * 60_000);
  await runShipmentRefreshForTesting(row.identity.id, lease,
    { trigger: "detail_pull", forceManualRefresh: true }, runtime(free));
  assert.equal(free.k100, 1);
  assert.equal(free.kdniao, 0, "without includeKdniaoFallback the paid fallback never runs");
});

test("a cached union page inside the 30-minute lag is complete and still stops the manual chain", async () => {
  const row = seed(LIST_AT - 10 * 60_000);
  const union = row.manualTimelines!.find((timeline) => timeline.provider === "jd_h5")!;
  assert.equal(shipmentDetailCandidateEvidence(row, union).detailComplete, true);
  assert.equal(selectShipmentDetailTimeline(row).provider, "jd_h5");
  const calls = { k100: 0, kdniao: 0, other: 0 };
  await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime(calls));
  assert.deepEqual(calls, { k100: 0, kdniao: 0, other: 0 });
});
