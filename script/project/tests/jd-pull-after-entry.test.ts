import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { memory } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { AccountOrderProjectionDiagnostics } from "../services/account-order-projection";
import type { Shipment, StatusSemantic, TimelinePackage } from "../models";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, loadState, saveState } from "../services/storage";
import { saveOrderProjectionReferences } from "../services/routes";
import { runShipmentRefreshForTesting } from "../services/sync";
import {
  FORCED_COMPLETION_REFRESH_WINDOW_MS,
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  jingDongSignedHistoryGap,
  needsDetailEntryQuery,
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
  shipmentDetailIncompleteReason,
  signedRefreshFrozen,
  statusAlignmentOutOfStep,
  statusAlignmentTimes,
} from "../services/shipment-policy";
import { runStatusAlignmentPass } from "../services/status-alignment";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey } from "../services/row-ledger";
import { setProjectionSceneActive } from "../services/projection-viewport";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { buildWidgetSnapshot } from "../services/status";
import { OperationTimeoutError } from "../services/deadline";

// Build 95's observed event clocks and counts; identities and node contents are synthetic.
const EVENT = 1789085861000, OLD_EVENT = 1789056101000, NOW = EVENT + 12 * 3600000;
const ORDER = "3610000000000001", WAYBILL = "JD000000000001", PHONE = "13800000000";
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
function parcel(count = 6, semantic: StatusSemantic = "DELIVERY"): AccountParcelDto {
  const tracks = Array.from({ length: count }, (_, i) => ({
    timeText: providerTime(EVENT - i * 60000), detail: `Synthetic account event ${i}`, statusCode: "",
  }));
  return {
    source: "interface5", ownerId: ORDER, orderId: ORDER, accountOrder: true, waybill: WAYBILL,
    courierCode: "JD", rawCourierCode: "JD", companyName: "Synthetic carrier", sourceProvider: "JingDong",
    sourceStateCode: semantic === "COMPLETED" ? "107" : "105", sourceStateText: semantic,
    semantic, normalizedStatusScope: "SHIPMENT", normalizedStatusSemantic: semantic,
    normalizedStatusText: semantic, receiverPhone: PHONE, senderPhone: "",
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks, routeUrl: "",
    projectionUrl: "https://u.jd.com/forward?test=pull",
  };
}
function history(at = OLD_EVENT): TimelinePackage {
  const tracks = Array.from({ length: 8 }, (_, i) => ({
    timeMs: at - i * 60000, timeText: providerTime(at - i * 60000),
    detail: i === 7 ? "已揽收" : `Synthetic H5 event ${i}`, statusCode: "",
    raw: { _pipiStatusSource: "jingdong_h5" },
  }));
  return { provider: "jd_h5", waybill: WAYBILL, courierCode: "JD", companyName: "Synthetic carrier",
    semantic: "UNKNOWN", structuredStatus: false, complete: true, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: NOW - 3600000 };
}
function seed(semantic: StatusSemantic = "DELIVERY", currentHistory = false, base = parcel(6, semantic),
  historyAt = currentHistory ? EVENT : OLD_EVENT) {
  memory.clear();
  v5Queries = 0;
  const row = parcelToShipment({ ...base, projectionTimeline: history(historyAt) }, [PHONE], NOW)!;
  row.detailSelection = { provider: currentHistory ? "jd_h5" : "v5_list", selectedAtMs: NOW - 60000 };
  const state = saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  saveOrderProjectionReferences([{ ownerId: row.identity.id, source: "interface5", url: parcel().projectionUrl }], NOW);
  setDiagnosticsEnabled(true);
  return state.shipments[0];
}
const lease = { isCurrent: () => true, deadlineAtMs: NOW + 30000 };
const pull = { trigger: "detail_pull" as const, forceManualRefresh: true, includeKdniaoFallback: true };
// sync.ts 把 refreshAccountParcel 抛出的错误都吞成 stage_failed，这里写 assert.fail 拦不住任何一次查询。
// 改成计数：每跑完一次，在不该查 v5 的地方断言计数为 0（takeV5Queries 读完清零）。
let v5Queries = 0;
// 网页、手动链、京粉页的桩同样在 sync.ts 的 try/catch 里，assert.fail 也会被吞：改成记下来，每个测试
// 结束时断言一个都没有（照旧抛错，流程不变）。
const unexpectedRequests: string[] = [];
function unexpectedRequest(message: string): never {
  unexpectedRequests.push(message);
  throw new Error(message);
}
afterEach(() => {
  assert.deepEqual(unexpectedRequests.splice(0), [], "a stubbed request that must not run was called");
});
function takeV5Queries(): number {
  const count = v5Queries;
  v5Queries = 0;
  return count;
}
const noExtraRequests = {
  refreshAccountParcel: async (): Promise<AccountParcelDto | null> => {
    v5Queries++;
    throw new Error("Synthetic unexpected v5 query");
  },
  refreshWebTimeline: async () => { unexpectedRequest("cached pickup must not expand the primary round"); },
  queryManualForSource: async () => { unexpectedRequest("pull must not add v6 or paid fallback"); },
};
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

test("a nonempty but incomplete entry query does not suppress the requested JD H5 load", async () => {
  const row = seed();
  let queries = 0, captures = 0;
  const entry = await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
    ...noExtraRequests,
    refreshAccountParcel: async () => { queries++; return parcel(18); },
    projectAccountOrderWithCarrier: async () => { unexpectedRequest("resolved entry must not load H5"); },
  });
  assert.equal(queries, 1);
  assert.equal(entry.detailEntry?.gaveTimeline, true);
  assert.equal(entry.shipment.manualTimelines?.find(p => p.provider === "v5_query")?.tracks.length, 18);
  assert.equal(shipmentDetailIncompleteReason(entry.shipment), "missing_pickup");
  const freshHistory = history(EVENT);
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, { ...pull, detailEntry: entry.detailEntry }, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async input => {
      captures++;
      assert.equal(input.ownerId, ORDER);
      assert.equal(input.projectionUrl, parcel().projectionUrl);
      return { ...input, waybill: WAYBILL, projectionTimeline: freshHistory };
    },
  });
  assert.equal(takeV5Queries(), 0, "pull must not repeat v5");
  assert.equal(captures, 1, "incomplete cached query must allow the same-ticket H5 stage");
  assert.equal(result.querySucceeded, true);
  assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "jd_h5");
  assert.equal(shipmentDetailIncompleteReason(result.shipment), null);
  assert.equal(selectShipmentDetailTimeline(loadState(NOW).shipments[0]).provider, "jd_h5");
  assert.ok(readDiagnostics().some(e => e.event === "order.projection.started" && e.details.result === "timeline_reopen"));
  const captured = readDiagnostics().find(e => e.event === "detail.timeline.candidate" &&
    e.details.stage === "detail_webview")!.details;
  assert.equal(captured.effectiveTrackCount, freshHistory.tracks.length);
  assert.equal(captured.latestTrackAtMs, EVENT);
  assert.equal(captured.hasPickup, true);
  assert.equal(captured.foreignPackage, false);
  assert.equal(captured.waybillMatches, true);
  assert.equal(readDiagnostics().some(e => e.event === "detail.refresh.stage_skipped" && e.details.stage === "jd_h5"), false,
    "a completed capture must not emit the old feed-count skip event");
});

test("a new pull immediately retries ordinary timeout while reopening projected JD history", async () => {
  const row = seed();
  let captures = 0;
  const runtime = {
    ...noExtraRequests,
    refreshWebTimeline: async () => null,
    queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "" }),
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => {
      captures++;
      if (captures === 1) throw new OperationTimeoutError("Synthetic projected history timeout");
      return { ...input, waybill: WAYBILL, projectionTimeline: history(EVENT) };
    },
  };
  await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime);
  const failed = loadState(NOW).shipments[0];
  assert.equal(failed.identity.projectedWaybill, WAYBILL);
  assert.ok(failed.identity.jingDongH5Retry?.failedAtMs);
  assert.equal(failed.identity.jingDongH5Retry?.riskControlAtMs, undefined);
  assert.ok(shipmentDetailIncompleteReason(failed));
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime);
  assert.equal(captures, 2, "history reopen uses the same ordinary-cooldown bypass as first identity capture");
  assert.equal(result.shipment.identity.projectedWaybill, WAYBILL);
  assert.equal(shipmentDetailIncompleteReason(result.shipment), null);
  assert.equal(takeV5Queries(), 0, "neither explicit history pull adds a v5 account query");
});

test("timeout preserves the signed-gap allowance for the next independent pull", async () => {
  const row = withJingDongH5CapturedAt(seed("COMPLETED", false, signedParcelWithPickup()), OLD_EVENT + 60000);
  assert.equal(jingDongSignedHistoryGap(row), true);
  let captures = 0;
  const runtime = {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => {
      captures++;
      if (captures === 1) throw new OperationTimeoutError("Synthetic signed-gap timeout");
      return { ...input, waybill: WAYBILL, projectionTimeline: history(EVENT - 2000) };
    },
  };
  await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime);
  const failed = loadState(NOW).shipments[0];
  assert.ok(failed.identity.jingDongH5Retry?.failedAtMs);
  assert.equal(jingDongSignedHistoryGap(failed), true, "a timeout supplies no answer and cannot spend the signed gap");
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime);
  assert.equal(captures, 2, "a later gesture retries the unspent signed gap without ordinary waiting");
  assert.equal(shipmentDetailIncompleteReason(result.shipment), null);
  assert.equal(jingDongSignedHistoryGap(result.shipment), false, "the real answer spends the existing allowance");
  assert.equal(takeV5Queries(), 0);
});

// The user's detail-only completeness clarification permits the existing history operation without changing the shared freeze.
test("an incomplete signed triple permits its explicit history operation without changing shared freeze", async () => {
  const row = seed("COMPLETED");
  assert.ok(shipmentDetailIncompleteReason(row));
  assert.equal(signedRefreshFrozen(row, NOW), true);
  let captures = 0;
  const freshHistory = history(EVENT);
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, pull, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async input => {
      captures++;
      return { ...input, waybill: WAYBILL, projectionTimeline: freshHistory };
    },
  });
  assert.equal(takeV5Queries(), 0);
  assert.equal(captures, 1, "the explicit pull may run its existing union-page operation");
  assert.equal(result.querySucceeded, true);
  assert.equal(shipmentDetailIncompleteReason(result.shipment), null);
  assert.deepEqual(selectShipmentDetailTimeline(result.shipment).tracks, [...freshHistory.tracks, ...history().tracks]);
  assert.equal(signedRefreshFrozen(result.shipment, NOW), true, "the shared signed freeze remains unchanged");
  assert.deepEqual(statusAlignmentTimes(result.shipment, NOW), statusAlignmentTimes(row, NOW));
  await runShipmentRefreshForTesting(row.identity.id, lease, pull, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async input => { captures++; return input; },
  });
  assert.equal(captures, 1, "the existing same-generation release and cooldown do not reopen the page");
  assert.equal(takeV5Queries(), 0);
});

for (const includeKdniaoFallback of [true, false]) {
  test(`the original signed-triple partial response keeps its existing fallback eligibility: paid ${includeKdniaoFallback}`,
    async () => {
      const row = seed("COMPLETED");
      assert.ok(shipmentDetailIncompleteReason(row));
      assert.equal(signedRefreshFrozen(row, NOW), true);
      const calls: string[] = [];
      const paidAttempts: { fallbackOnly?: boolean; includeKdniaoFallback?: boolean; pickerOnly?: boolean }[] = [];
      const result = await runShipmentRefreshForTesting(row.identity.id, lease,
        { ...pull, includeKdniaoFallback }, {
          ...noExtraRequests,
          projectAccountOrderWithCarrier: async input => { calls.push("jd_h5"); return input; },
          refreshWebTimeline: async () => { calls.push("k100_h5"); return null; },
          queryManualForSource: async input => {
            calls.push("kdniao");
            paidAttempts.push({ fallbackOnly: input.fallbackOnly,
              includeKdniaoFallback: input.includeKdniaoFallback, pickerOnly: input.pickerOnly });
            return { shipment: null, pending: null, routeUrl: "" };
          },
        });
      assert.equal(takeV5Queries(), 0);
      assert.deepEqual(calls, includeKdniaoFallback ? ["jd_h5", "k100_h5", "kdniao"] : ["jd_h5", "k100_h5"]);
      assert.deepEqual(paidAttempts, includeKdniaoFallback
        ? [{ fallbackOnly: true, includeKdniaoFallback: true, pickerOnly: undefined }] : []);
      assert.ok(shipmentDetailIncompleteReason(result.shipment), "the unchanged partial response does not become complete");
      assert.equal(signedRefreshFrozen(result.shipment, NOW), true);
      assert.deepEqual(statusAlignmentTimes(result.shipment, NOW), statusAlignmentTimes(row, NOW));
      assert.deepEqual(result.shipment.manualTimelines, row.manualTimelines, "the old partial history is retained");
    });
}

// 状态已签收、头条与本地详情还停在签收之前五分钟以上：没到签收三态，详情下拉照旧补历史。
test("signed incomplete history may reopen despite an already expanded old H5 package", async () => {
  const row = seed("COMPLETED", false, { ...parcel(6, "COMPLETED"), normalizedStatus: { version: 1,
    scope: "SHIPMENT", semantic: "COMPLETED", code: "107", text: "已完成", priority: 0,
    eventAtMs: EVENT + 10 * 60000, structured: true } } as AccountParcelDto);
  assert.ok(shipmentDetailIncompleteReason(row));
  assert.equal(signedRefreshFrozen(row, NOW), false, "status ten minutes ahead of the headline and the detail");
  await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async () => { unexpectedRequest("signed entry must wait for an explicit pull"); },
  });
  assert.equal(takeV5Queries(), 0, "a signed entry does not query v5");
  let captures = 0;
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, pull, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async input => {
      captures++;
      return { ...input, waybill: WAYBILL, projectionTimeline: history(EVENT - 2000) };
    },
  });
  assert.equal(takeV5Queries(), 0, "pull must not repeat v5");
  assert.equal(captures, 1, "signed status freezes scheduling, not explicit repair of incomplete history");
  assert.equal(shipmentDetailIncompleteReason(result.shipment), null);
  assert.equal(selectShipmentDetailTimeline(result.shipment).semantic, "COMPLETED");
  assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "jd_h5");
  const cached = loadState(NOW).shipments[0];
  assert.equal(selectShipmentDetailTimeline(cached).provider, "jd_h5");
  assert.equal(shipmentDetailIncompleteReason(cached), null);
});

// 2026-09-24（Pipi 用户定，三端同口径）：feed 早有揽收，签收那一条是被拦掉的评价（或不带节点），显示的历史
// 停在签收之前三小时；签收节点只在京粉页里。只有详情下拉放行一次京粉页，打开详情不抓。
function signedParcelWithPickup(semantic: StatusSemantic = "COMPLETED"): AccountParcelDto {
  const newest = EVENT - 3 * 3600000;
  const tracks = Array.from({ length: 6 }, (_, i) => ({
    timeText: providerTime(newest - i * 60000),
    detail: i === 5 ? "已揽收" : `Synthetic account event ${i}`, statusCode: "",
  }));
  return {
    ...parcel(6, semantic), tracks, latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail,
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic, code: "107", text: semantic,
      priority: 0, eventAtMs: EVENT, structured: true },
  } as AccountParcelDto;
}

/** 把详情里京粉页那一包的抓取时间（successAtMs）改成 capturedAt 并落盘。 */
function withJingDongH5CapturedAt(row: Shipment, capturedAt: number): Shipment {
  const state = loadState(NOW);
  const updated = { ...row, manualTimelines: (row.manualTimelines || []).map(timeline =>
    timeline.provider === "jd_h5" ? { ...timeline, successAtMs: capturedAt } : timeline) };
  return saveState({ ...state, shipments: [updated] }, NOW).shipments[0];
}

test("a signed parcel whose feed reached pickup but stops before the signature reopens once on pull", async () => {
  // 已有的京粉页包是签收之前抓的（抓取时间早于完成时间）。
  const row = withJingDongH5CapturedAt(seed("COMPLETED", false, signedParcelWithPickup()), OLD_EVENT + 60000);
  assert.ok(shipmentDetailIncompleteReason(row));
  assert.equal(jingDongSignedHistoryGap(row), true);
  await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async () => { unexpectedRequest("opening the detail must not load the union page"); },
  });
  assert.equal(takeV5Queries(), 0, "list and detail agree, so opening a signed parcel does not query v5");
  let captures = 0;
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, pull, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async input => {
      captures++;
      return { ...input, waybill: WAYBILL, projectionTimeline: history(EVENT - 2000) };
    },
  });
  assert.equal(takeV5Queries(), 0, "pull must not repeat v5");
  assert.equal(captures, 1, "the pull reopens the union page once for the missing signature");
  assert.equal(shipmentDetailIncompleteReason(result.shipment), null);
  assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "jd_h5");
  // 首页表头随之取京粉页里最新的节点（问题 3 的例外）。
  assert.equal(selectShipmentTimeline(result.shipment).latestDetail, "Synthetic H5 event 0");
});

// 2026-09-24：每次完成只放行一次。完成包晚于真正签收好几天才到（自动确认收货）时，京粉页里的签收节点
// 比完成时间早几天，详情永远判不完整；完成时间之后已经抓过一次京粉页，再下拉不再开页。
test("a union page captured after a late auto-confirmed completion is not reopened for the gap", async () => {
  const signedAt = EVENT - 3 * 86400000;
  const feed = signedParcelWithPickup();
  const tracks = feed.tracks.map((track, i) => ({ ...track, timeText: providerTime(signedAt - 3600000 - i * 60000) }));
  const row = withJingDongH5CapturedAt(seed("COMPLETED", false,
    { ...feed, tracks, latestTimeText: tracks[0].timeText } as AccountParcelDto, signedAt), EVENT + 3600000);
  assert.ok(shipmentDetailIncompleteReason(row), "the late completion keeps the detail incomplete");
  assert.equal(jingDongSignedHistoryGap(row), false);
  let captures = 0;
  await runShipmentRefreshForTesting(row.identity.id, lease, pull, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async input => {
      captures++;
      return { ...input, waybill: WAYBILL, projectionTimeline: history(signedAt) };
    },
  });
  assert.equal(captures, 0, "the page captured after the completion is already the final history");
  assert.equal(takeV5Queries(), 0);
  // 同一单若京粉页是在完成之前抓的，缺口照旧放行一次。
  assert.equal(jingDongSignedHistoryGap(withJingDongH5CapturedAt(row, EVENT - 60000)), true);
});

test("the signed-gap exception needs a structured completion", () => {
  assert.equal(jingDongSignedHistoryGap(seed("DELIVERY", false, signedParcelWithPickup("DELIVERY"))), false);
  // 接口 5 的状态码 107 本身就是结构化枚举；两样都没有才算只有文字。
  assert.equal(jingDongSignedHistoryGap(seed("COMPLETED", false, {
    ...signedParcelWithPickup(), normalizedStatus: undefined, sourceStateCode: "",
  } as AccountParcelDto)), false);
});

// 用户定 2026-09-24（Fold7 9307）：列表最新一条是签收，详情只剩投影前抓的京粉页旧包，两边差了八个多小时。
// 用户 2026-10-03「v5 对不上并进对齐」（优化 2）：打开详情不再因为对不上单独查 v5（原来一分钟、只记在内存里），统一交给状态
// 对齐：超过五分钟的对不上由对齐强刷处理，京东件的强刷先问按件详情（v5_query），查回来的同票 query 补齐，详情与列表对齐。
// （改前：打开详情就查一次 v5。）
const alignmentRun = { trigger: "status_alignment" as const, forceManualRefresh: true, includeKdniaoFallback: true,
  forceAccountOrderProjection: true };
function alignmentPass(runtime: Parameters<typeof runShipmentRefreshForTesting>[3]) {
  return runStatusAlignmentPass({}, {
    appHost: () => true, busy: () => false, load: () => loadState(NOW), now: () => NOW,
    refresh: (id, beforeQuery) => runShipmentRefreshForTesting(id, lease, { ...alignmentRun, beforeQuery }, {
      ...runtime,
      refreshAccountParcel: async (...args) => {
        args[4]?.beforeQuery?.();
        return runtime!.refreshAccountParcel!(...args);
      },
    }),
  });
}

test("a signed parcel whose detail lags the list is left to the status alignment, which asks v5 first", async () => {
  const signed = {
    ...parcel(1, "COMPLETED"),
    tracks: [{ timeText: providerTime(EVENT), detail: "您的快件已送达", statusCode: "" }],
    latestTimeText: providerTime(EVENT), latestDetail: "您的快件已送达",
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic: "COMPLETED", code: "107", text: "已完成",
      priority: 0, eventAtMs: EVENT, structured: true },
  } as AccountParcelDto;
  const row = seed("COMPLETED", false, signed);
  assert.equal(needsDetailEntryQuery(row), false, "opening the detail no longer queries v5 for a mismatch");
  await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async () => { unexpectedRequest("opening the detail must not load the union page"); },
  });
  assert.equal(takeV5Queries(), 0);
  assert.ok(statusAlignmentOutOfStep(statusAlignmentTimes(row)!), "the detail is eight hours behind the list");
  const calls: string[] = [];
  const result = await alignmentPass({
    ...noExtraRequests,
    refreshAccountParcel: async () => {
      calls.push("v5_query");
      return { ...parcel(18, "COMPLETED"), normalizedStatus: signed.normalizedStatus };
    },
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => { calls.push("jd_h5"); return input; },
    refreshWebTimeline: async () => { calls.push("k100_h5"); return null; },
    queryManualForSource: async () => ({ result: "empty_response" as const, shipment: null, pending: null,
      routeUrl: "" }),
  });
  assert.equal(result.result, "attempted");
  assert.equal(calls[0], "v5_query", "the alignment run asks the per-waybill query first");
  const stored = loadState(NOW).shipments[0];
  assert.equal(selectShipmentDetailTimeline(stored).provider, "v5_query");
  assert.equal(statusAlignmentOutOfStep(statusAlignmentTimes(stored)!), false, "list and detail now agree");
});

// A newly stored v5 slot is new evidence even when sticky H5 history still wins. Subsequent identical replies
// complete no new group; failures/cancellations retry at the ordinary interval (2026-10-08 alignment revision).
const COMPLETED_STATUS = { version: 1, scope: "SHIPMENT", semantic: "COMPLETED", code: "107", text: "已完成",
  priority: 0, eventAtMs: EVENT, structured: true } as const;
function signedSummary(): AccountParcelDto {
  return {
    ...parcel(1, "COMPLETED"),
    tracks: [{ timeText: providerTime(EVENT), detail: "您的快件已送达", statusCode: "" }],
    latestTimeText: providerTime(EVENT), latestDetail: "您的快件已送达", normalizedStatus: COMPLETED_STATUS,
  } as AccountParcelDto;
}
function unhelpfulQuery(): AccountParcelDto {
  // 同票 query 只有签收和一条中转，没有揽收：不完整，排不过完整的京粉页包。
  const tracks = [
    { timeText: providerTime(EVENT), detail: "您的快件已送达", statusCode: "" },
    { timeText: providerTime(EVENT - 20 * 60000), detail: "Synthetic account transit", statusCode: "" },
  ];
  return { ...parcel(2, "COMPLETED"), tracks, latestTimeText: tracks[0].timeText,
    latestDetail: tracks[0].detail, normalizedStatus: COMPLETED_STATUS } as AccountParcelDto;
}

test("a list/detail mismatch the query cannot resolve is forced once per set of times", async () => {
  const row = seed("COMPLETED", false, signedSummary(), EVENT - 10 * 60000);
  assert.equal(needsDetailEntryQuery(row), false);
  assert.ok(statusAlignmentOutOfStep(statusAlignmentTimes(row)!), "ten minutes apart");
  let queries = 0;
  const runtime = {
    ...noExtraRequests,
    refreshAccountParcel: async () => { queries++; return unhelpfulQuery(); },
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => input,
    refreshWebTimeline: async () => null,
    queryManualForSource: async () => ({ result: "empty_response" as const, shipment: null, pending: null,
      routeUrl: "" }),
  };
  assert.equal((await alignmentPass(runtime)).result, "attempted");
  assert.equal(queries, 1);
  const first = loadState(NOW).shipments[0];
  assert.equal(selectShipmentDetailTimeline(first).provider, "jd_h5", "the query did not change the selection");
  assert.ok(statusAlignmentOutOfStep(statusAlignmentTimes(first)!), "the mismatch persists");
  assert.equal((await alignmentPass(runtime)).result, "nothing_due", "the same times are not forced again");
  assert.equal(queries, 1);
  // Opening the detail does not query either.
  await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, runtime);
  assert.equal(queries, 1, "a second open with the same list and detail times sends no query");

  // 列表表头往后挪了两分钟（feed 自己的节点变了）：新的一组时间，再强刷一次。
  const state = loadState(NOW);
  const stored = state.shipments[0];
  const movedAt = EVENT + 2 * 60000;
  const moved = { ...stored.sourceTimeline!, latestTimeText: providerTime(movedAt),
    latestDetail: "您的快件已送达，感谢使用",
    tracks: stored.sourceTimeline!.tracks.map(track => ({ ...track, timeMs: movedAt,
      timeText: providerTime(movedAt), detail: "您的快件已送达，感谢使用" })) };
  saveState({ ...state, shipments: [{ ...stored, sourceTimeline: moved }] }, NOW);
  const relisted = loadState(NOW).shipments[0];
  assert.equal(selectShipmentTimeline(relisted).latestTimeText, providerTime(movedAt));
  assert.equal((await alignmentPass(runtime)).result, "attempted");
  assert.equal(queries, 2, "a changed list time is forced once again");
  assert.equal((await alignmentPass(runtime)).result, "nothing_due");
  assert.equal(queries, 2);
  assert.equal(takeV5Queries(), 0);
});

for (const mode of ["failure", "cancelled"] as const) {
  test(`a ${mode} in the actual JD alignment query leaves the same group retryable`, async () => {
    const row = seed("COMPLETED", false, signedSummary(), EVENT - 10 * 60000);
    let clock = NOW, queries = 0;
    Date.now = () => clock;
    try {
      const pass = () => {
        const controller = new AbortController();
        const currentLease = { isCurrent: () => true, deadlineAtMs: clock + 60000, signal: controller.signal };
        return runStatusAlignmentPass({}, {
          appHost: () => true, busy: () => false, load: () => loadState(clock), now: () => clock,
          refresh: (id, beforeQuery) => runShipmentRefreshForTesting(id, currentLease,
            { ...alignmentRun, signal: controller.signal, beforeQuery }, {
              refreshAccountParcel: async (_row, _deadline, _signal, _observe, options) => {
                options?.beforeQuery?.();
                queries++;
                if (mode === "cancelled") controller.abort();
                throw new Error(`Synthetic ${mode}`);
              },
              projectAccountOrderWithCarrier: async (input: AccountParcelDto) => input,
              refreshWebTimeline: async () => null,
              queryManualForSource: async () => ({ result: "empty_response" as const,
                shipment: null, pending: null, routeUrl: "" }),
            }),
        });
      };
      await pass();
      const record = () => parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(row.identity.id)])!;
      assert.equal(queries, 1);
      assert.equal(record().complete, false);
      const originalTimes = record().times;
      assert.equal((await pass()).result, "nothing_due", "the row interval still applies after failure");
      clock += MANUAL_REFRESH_MIN_INTERVAL_MS;
      await pass();
      assert.equal(queries, 2, "the owning v5 caller is invoked again without moving the group's times");
      assert.equal(record().times, originalTimes);
      assert.equal(record().attempts, 2);
      assert.equal(record().complete, false);
    } finally {
      Date.now = () => NOW;
    }
  });
}

// 用户 2026-10-02「我已取件这种硬冻结 也要等三态都是签收才冻结」，弹窗「点击后满 3 天也冻结」「iOS 右滑签收一起改」：
// 右滑签收满 72 小时（或来源三态到签收）才硬冻结；之前与普通行一样按来源自己的时间参与状态对齐（优化 2 之后打开详情不再为
// 对不上查 v5；改前：打开详情照查一次 v5）。
test("a forced-completed parcel inside its refresh window takes part in the alignment by its source's times", async () => {
  const seeded = seed("COMPLETED", false, signedSummary(), EVENT - 10 * 60000);
  const state = loadState(NOW);
  saveState({ ...state, shipments: [{ ...state.shipments[0], forcedCompletedAtMs: NOW - 60000 }] }, NOW);
  const row = loadState(NOW).shipments[0];
  assert.deepEqual(statusAlignmentTimes(row), statusAlignmentTimes(seeded), "the source's own times");
  assert.ok(statusAlignmentOutOfStep(statusAlignmentTimes(row)!));
  assert.equal(needsDetailEntryQuery(row), false, "Home opens the detail without a mismatch query");
  await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async () => { unexpectedRequest("detail entry never loads the union page"); },
  });
  assert.equal(takeV5Queries(), 0);
  assert.equal(selectShipmentTimeline(loadState(NOW).shipments[0]).semantic, "COMPLETED", "the sign-off stays shown");
});

test("a hard-frozen forced-completed parcel takes no part in the alignment and sends no query", async () => {
  const seeded = seed("COMPLETED", false, signedSummary(), EVENT - 10 * 60000);
  assert.ok(statusAlignmentOutOfStep(statusAlignmentTimes(seeded)!));
  const state = loadState(NOW);
  saveState({ ...state, shipments: [{ ...state.shipments[0],
    forcedCompletedAtMs: NOW - FORCED_COMPLETION_REFRESH_WINDOW_MS }] }, NOW);
  const row = loadState(NOW).shipments[0];
  assert.equal(statusAlignmentTimes(row), null);
  assert.equal(needsDetailEntryQuery(row), false, "Home does not open the detail with a v5 query");
  await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async () => { unexpectedRequest("a forced completion never loads the union page"); },
  });
  assert.equal(takeV5Queries(), 0);
});

for (const carrier of ["JD", "SF", "ZTO"]) {
  test(`complete active JD-source history still checks account status (${carrier})`, async () => {
    const original = seed("DELIVERY", true);
    const state = loadState(NOW);
    const row = { ...original, identity: { ...original.identity, courierCode: carrier } };
    saveState({ ...state, shipments: [row] }, NOW);
    assert.equal(shipmentDetailIncompleteReason(row), null, "history coverage is already complete");
    let queries = 0;
    const response = parcel(9, "COMPLETED");
    response.sourceStateCode = "107";
    response.courierCode = carrier;
    response.rawCourierCode = carrier;
    response.latestTimeText = providerTime(EVENT + 3600000);
    response.latestDetail = "Synthetic shipment delivered";
    response.tracks[0] = { timeText: response.latestTimeText, detail: response.latestDetail, statusCode: "107" };
    response.tracks[8].detail = "已揽收";
    const result = await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
      ...noExtraRequests,
      refreshAccountParcel: async input => {
        queries++;
        assert.equal(input.identity.id, row.identity.id);
        assert.equal(input.identity.sourceProvider?.toLowerCase(), "jingdong");
        return response;
      },
      projectAccountOrderWithCarrier: async () => { unexpectedRequest("status query cannot launch JD H5"); },
    });
    assert.equal(queries, 1, "complete active history must not suppress the account query");
    assert.equal(result.querySucceeded, true);
    assert.equal(result.shipment.timeline.semantic, "COMPLETED");
    const stored = loadState(NOW).shipments[0];
    assert.equal(stored.timeline.semantic, "COMPLETED");
    assert.equal(selectShipmentDetailTimeline(stored).semantic, "COMPLETED");
    assert.equal(buildWidgetSnapshot([stored], NOW).rows[0]?.semantic, "COMPLETED");
    assert.equal(stored.sourceTimeline?.semantic, "DELIVERY", "query must not rewrite the list snapshot");
    for (const options of [{ trigger: "detail_open" as const }, { ...pull, detailEntry: result.detailEntry }]) {
      await runShipmentRefreshForTesting(row.identity.id, lease, options, noExtraRequests);
      assert.equal(takeV5Queries(), 0, `${options.trigger}: the signed query result is not queried again`);
    }
  });
}

test("failed active JD status query keeps complete history and pull does not retry it", async () => {
  const row = seed("DELIVERY", true);
  let queries = 0;
  const entry = await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
    ...noExtraRequests,
    refreshAccountParcel: async () => { queries++; throw new Error("Synthetic upstream failure"); },
  });
  assert.equal(queries, 1);
  assert.equal(entry.querySucceeded, false);
  assert.equal(selectShipmentDetailTimeline(entry.shipment).provider, "jd_h5");
  assert.equal(entry.shipment.timeline.semantic, "DELIVERY");
  await runShipmentRefreshForTesting(row.identity.id, lease, { ...pull, detailEntry: entry.detailEntry }, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async () => { unexpectedRequest("retained complete history does not need H5"); },
  });
  assert.equal(takeV5Queries(), 0, "pull does not retry the failed v5 query");
  assert.equal(loadState(NOW).shipments[0].timeline.semantic, "DELIVERY");
});

test("current complete signed history stays frozen on entry and pull", async () => {
  const row = seed("COMPLETED", true);
  assert.equal(shipmentDetailIncompleteReason(row), null);
  for (const options of [{ trigger: "detail_open" as const }, pull]) {
    await runShipmentRefreshForTesting(row.identity.id, lease, options, {
      ...noExtraRequests,
      projectAccountOrderWithCarrier: async () => { unexpectedRequest("complete signed history must not reopen"); },
    });
    assert.equal(takeV5Queries(), 0, `${options.trigger}: complete signed history does not query v5`);
  }
});

// 用户 2026-10-03「所有开京粉页的路都检查」（代码 4）：详情下拉开京粉页之前判 App 是否在前台；不在就跳过这一级（不预约、
// 不占按订单冷却），后面各级照常——这里京粉页之后的快递100 照跑。回到前台再下拉，京粉页当场就开。
test("a pull off screen skips the union page and goes on with the rest of the chain", async () => {
  const row = seed();
  const calls: string[] = [];
  const runtime = {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async (input: AccountParcelDto, _projection?: number, _deadline?: number,
      _observe?: unknown, _signal?: AbortSignal, beforeLoad?: () => void) => {
      beforeLoad?.();
      calls.push("jd_h5");
      return { ...input, waybill: WAYBILL, projectionTimeline: history(EVENT) };
    },
    refreshWebTimeline: async () => { calls.push("k100_h5"); return null; },
    queryManualForSource: async () => ({ result: "empty_response" as const, shipment: null, pending: null,
      routeUrl: "" }),
  };
  setProjectionSceneActive(false);
  try {
    await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime);
  } finally {
    setProjectionSceneActive(true);
  }
  assert.deepEqual(calls, ["k100_h5"], "the union page is skipped, the next level still runs");
  const skipped = readDiagnostics().filter(e => e.event === "order.projection.skipped" &&
    e.details.result === "not_foreground");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].details.stage, "detail_webview");
  assert.equal(loadState(NOW).shipments[0].identity.jingDongH5Retry, undefined, "no cooldown was taken");
  calls.length = 0;
  await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime);
  assert.deepEqual(calls, ["jd_h5"], "back on screen the union page opens at once");
  assert.equal(takeV5Queries(), 0);
});

// The app leaves the foreground after the reservation, while the page waits: the gate asked right before the load gives
// the reservation back, and the chain goes on.
test("a pull whose app leaves before the page loads gives the reservation back", async () => {
  const row = seed();
  const calls: string[] = [];
  await runShipmentRefreshForTesting(row.identity.id, lease, pull, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async (input: AccountParcelDto, _projection?: number, _deadline?: number,
      _observe?: unknown, _signal?: AbortSignal, beforeLoad?: () => void) => {
      assert.ok(loadState(NOW).shipments[0].identity.jingDongH5Retry?.attemptId, "reserved before the load");
      setProjectionSceneActive(false);
      try {
        beforeLoad?.();
      } finally {
        setProjectionSceneActive(true);
      }
      calls.push("jd_h5");
      return input;
    },
    refreshWebTimeline: async () => { calls.push("k100_h5"); return null; },
    queryManualForSource: async () => ({ result: "empty_response" as const, shipment: null, pending: null,
      routeUrl: "" }),
  });
  assert.deepEqual(calls, ["k100_h5"]);
  assert.equal(loadState(NOW).shipments[0].identity.jingDongH5Retry, undefined, "the reservation is given back");
  assert.equal(readDiagnostics().filter(e => e.event === "order.projection.failed").length, 0);
});

for (const risk of [false, true]) {
  test(`${risk ? "repeated pull preserves the 60-minute risk" : "automatic alignment preserves the 10-minute ordinary"} cooldown`, async () => {
    const row = seed(); let captures = 0;
    const runtime = {
      ...noExtraRequests,
      // 2026-09-24 采纳：这里抓回来的京粉页包比列表旧八个多小时，详情选包不判它完整，它就不再替手动链
      // 作主，K100 / 快递鸟照常跑（行为见 jd-h5-stale-pickup-chain.test.ts）；这两个用例只看京粉页冷却。
      refreshWebTimeline: async () => null,
      refreshAccountParcel: async () => parcel(),
      queryManualForSource: async () => ({ result: "empty_response" as const, shipment: null,
        pending: null, routeUrl: "" }),
      projectAccountOrderWithCarrier: async (input: AccountParcelDto, _projection?: number, _deadline?: number,
        observe?: (diagnostics: AccountOrderProjectionDiagnostics) => void) => {
        captures++;
        if (risk) observe?.({
          loadSettled: true, loadCompleted: true, captureSeen: false, replayAttempted: false,
          replaySucceeded: false, probeInstalled: true, probeMatched: true, probeRequestCount: 1,
          unionSignalSeen: true, unionResourceSeen: true, resourceReplayBlockReason: "", domMatched: false,
          projectionComplete: false, projectionTrackCount: 0, requestCallbackCount: 1,
          evaluationAttempts: 1, evaluationFailures: 0, loadDurationMs: 1, resourceCount: 1,
          pageClass: "jd", readyState: "complete", visibilityState: "visible", viewportAvailable: true,
          viewportHosted: true, identitySource: "", unionResponseStatuses: "403", probeCaptureCount: 0,
        });
        return { ...input, waybill: WAYBILL, projectionTimeline: history() };
      },
    };
    await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime);
    assert.equal(takeV5Queries(), 0, "pull must not repeat v5");
    assert.equal(captures, 1);
    Date.now = () => NOW + (risk ? 20 : 5) * 60000;
    try {
      await runShipmentRefreshForTesting(row.identity.id, { isCurrent: () => true }, risk ? pull : alignmentRun, runtime);
      assert.equal(captures, 1, risk ? "a user gesture cannot bypass risk control" :
        "automatic alignment force options cannot bypass ordinary cooldown");
      assert.ok(readDiagnostics().some(e => e.event === "order.projection.skipped" &&
        e.details.result === (risk ? "risk_control_cooldown" : "cooldown")));
    } finally { Date.now = () => NOW; }
  });
}
