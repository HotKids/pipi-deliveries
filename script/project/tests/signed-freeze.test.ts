import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { AppState, Shipment, TimelinePackage, TrackNode } from "../models";
import { parseAccountSyncResponse, type AccountParcelDto } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, forceCompleteShipment, loadState, saveState } from "../services/storage";
import { parseProviderTime } from "../services/status";
import { shipmentNotificationEvent } from "../services/notification-events";
import { saveOrderProjectionReferences } from "../services/routes";
import {
  applyAccountShipment,
  FORCED_COMPLETION_REFRESH_WINDOW_MS,
  forcedCompletionRefreshOpen,
  jingDongSignedHistoryGap,
  needsDetailEntryQuery,
  selectShipmentTimeline,
  shipmentDetailIncompleteReason,
  shouldRefreshShipmentRow,
  signedRefreshFrozen,
  signedTripleReached,
  STATUS_ALIGNMENT_MS,
  statusAlignmentTimes,
} from "../services/shipment-policy";
import { runShipmentEnrichmentForTesting, runShipmentRefreshForTesting } from "../services/sync";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { runStatusAlignmentPass, type StatusAlignmentRecordStore } from "../services/status-alignment";
import { recordSignedRelease, signedReleaseUsed } from "../services/row-ledger";
import { seedRecognizedCarriers } from "./carrier-recognition-seed";

// 用户 2026-10-02「头条 状态 详情页 都推进到了签收状态（之前京东定的那种临时签收例外）就冻结快递 后续不再进行任何刷新」
// 「我已取件这种硬冻结 也要等三态都是签收才冻结」，弹窗全部选推荐（「按时间对齐」「只停本机发起的请求」「显示已签收、照常刷新」
// 「来源报的结构化签收」「点击后满 3 天也冻结」「iOS 右滑签收一起改」）。
// 合成数据（no real parcel data）：运单号、订单号、手机号都是编的。

const WAYBILL = "SF0000000009101";
const PHONE = "13800009101";
const at = (text: string) => parseProviderTime(text)!;
const SIGNED_TEXT = "快递已完成签收";
const DELIVERING_TEXT = "快件派送中";
const STORE_TEXT = "快件到达【测试驿站】";
const PICKUP_TEXT = "顺丰速运 已收取快件";
const SIGNED_AT = "2026-09-08 13:31:00";

const actualNow = Date.now;
let now = NOW;
Date.now = () => now;
process.on("exit", () => { Date.now = actualNow; });

function node(timeText: string, detail: string, raw: TrackNode["raw"] = {}): TrackNode {
  return { timeText, timeMs: at(timeText), detail, statusCode: "", raw };
}

function feed(nodes: readonly [string, string][], statusAtText: string,
  semantic: TimelinePackage["semantic"] = "COMPLETED", structuredStatus = true): TimelinePackage {
  const tracks = nodes.map(([timeText, detail]) => node(timeText, detail));
  return { provider: "interface5", waybill: WAYBILL, courierCode: "SF", companyName: "顺丰速运",
    semantic, structuredStatus, statusEventAtMs: at(statusAtText), complete: false,
    latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail, successAtMs: NOW - 3_600_000, tracks };
}

function k100(nodes: readonly [string, string][]): TimelinePackage {
  const tracks = nodes.map(([timeText, detail]) => node(timeText, detail, { _pipiStatusSource: "web" }));
  return { provider: "k100_h5", waybill: WAYBILL, courierCode: "SF", companyName: "顺丰速运",
    semantic: "UNKNOWN", structuredStatus: false, statusEventAtMs: null, complete: true,
    latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail, successAtMs: NOW - 3_600_000, tracks };
}

/** An SF automatic row: the feed owns the status, the list headline and the detail follow the K100 package. */
function sfRow(source: TimelinePackage, manual: TimelinePackage, extra: Partial<Shipment> = {}): Shipment {
  return { identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL, bindingSource: "interface5",
    sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng", courierCode: "SF", rawCourierCode: "SF",
    companyName: "顺丰速运", phone: PHONE, phoneTail: "9101", manuallyAdded: false, createdAtMs: NOW - 86_400_000 },
    timeline: source, sourceTimeline: source, manualTimelines: [manual], updatedAtMs: NOW - 3_600_000,
    accountRecord: { waybill: WAYBILL, companyCode: "SF", provider: "ShunFeng", phone: PHONE, stateNumber: 3 },
    ...extra } as Shipment;
}

const HISTORY: [string, string][] = [["2026-09-08 11:41:00", STORE_TEXT], ["2026-09-07 10:00:00", PICKUP_TEXT]];

/** Status, headline and local detail all at the signing: the feed signs at 13:31, K100 shows the same signing. */
function signedRow(newest: [string, string] = [SIGNED_AT, "快件已签收，签收人：本人"], extra: Partial<Shipment> = {}) {
  return sfRow(feed([[SIGNED_AT, SIGNED_TEXT]], SIGNED_AT), k100([newest, ...HISTORY]), extra);
}

/** The same parcel still on its way: the feed reports delivery, K100 is a step behind. */
function inTransitRow(extra: Partial<Shipment> = {}) {
  return sfRow(feed([["2026-09-08 12:30:00", DELIVERING_TEXT]], "2026-09-08 12:30:00", "DELIVERY"),
    k100(HISTORY), extra);
}

function persist(shipment: Shipment): Shipment {
  return saveState({ ...emptyState(), shipments: [shipment], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 },
  ] }, now).shipments[0]!;
}

const lease = () => ({ isCurrent: () => true, deadlineAtMs: now + 30_000 });

/** Every per-row provider a detail refresh can reach, recorded instead of answered. */
function recordingRuntime(calls: string[], k100Answer?: TimelinePackage) {
  return {
    refreshAccountParcel: async (): Promise<AccountParcelDto | null> => { calls.push("v5_query"); return null; },
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => { calls.push("jd_h5"); return input; },
    refreshCainiaoH5: async () => { calls.push("cn_h5"); return null; },
    refreshWebTimeline: async (shipment: Shipment) => {
      calls.push("k100_h5");
      return k100Answer ? { ...shipment, timeline: k100Answer, sourceTimeline: null, manualTimelines: [k100Answer] }
        : null;
    },
    queryManualForSource: async (input: { fallbackOnly?: boolean; pickerOnly?: boolean; motoOnly?: boolean }) => {
      calls.push(input.fallbackOnly ? "kdniao" : input.pickerOnly ? "v6_query" : input.motoOnly ? "v4_query" : "manual");
      return { shipment: null, pending: null, routeUrl: "" };
    },
  };
}

const PULL = { trigger: "detail_pull" as const, forceManualRefresh: true, includeKdniaoFallback: true,
  forceAccountOrderProjection: true };

function reset(): void {
  now = NOW;
  memory.clear();
  setDiagnosticsEnabled(true);
}

const skipLines = (event: string) => readDiagnostics()
  .filter(entry => entry.event === event && entry.details.skipReason === "signed_frozen");

// ---- 判据「按时间对齐」：S 已签收（结构化、时间有效），H 与 D 都不早于 T 五分钟以上；与状态对齐同一组三个时间。
test("the signed triple reads the status alignment's own three times", () => {
  reset();
  const row = signedRow();
  assert.deepEqual(statusAlignmentTimes(row), { statusAtMs: at(SIGNED_AT), headlineAtMs: at(SIGNED_AT),
    detailAtMs: at(SIGNED_AT), statusSemantic: "COMPLETED" });
  assert.equal(signedTripleReached(row, now), true);
  assert.equal(signedRefreshFrozen(row, now), true);
  assert.equal(shouldRefreshShipmentRow(row, now), false);

  // Exactly five minutes behind is still at the signing (the alignment's same five minutes); one second more is not.
  const fiveBehind = signedRow(["2026-09-08 13:26:00", DELIVERING_TEXT]);
  assert.equal(at(SIGNED_AT) - statusAlignmentTimes(fiveBehind)!.headlineAtMs, STATUS_ALIGNMENT_MS);
  assert.equal(signedTripleReached(fiveBehind, now), true);
  const sixBehind = signedRow(["2026-09-08 13:25:59", DELIVERING_TEXT]);
  assert.equal(signedTripleReached(sixBehind, now), false, "the headline and the detail stop before the signing");

  // A headline or detail later than the signing still counts as reached (only 「不早于」 is asked).
  assert.equal(signedTripleReached(signedRow(["2026-09-08 13:45:00", "快件已签收，客服回访"]), now), true);

  // Not signed, not structured, not a valid time, or cancelled: never reached.
  assert.equal(signedTripleReached(inTransitRow(), now), false);
  const prose = sfRow(feed([[SIGNED_AT, SIGNED_TEXT]], SIGNED_AT, "COMPLETED", false),
    k100([[SIGNED_AT, "快件已签收"], ...HISTORY]));
  assert.equal(signedTripleReached(prose, now), false, "a prose-derived completion is not a structured signing");
  now = at(SIGNED_AT) - 60_000;
  assert.equal(signedTripleReached(signedRow(), now), false, "a completion time in the future is not valid");
  now = NOW;
  const cancelled = sfRow(feed([[SIGNED_AT, "订单已取消"]], SIGNED_AT, "CANCELLED"),
    k100([[SIGNED_AT, "订单已取消"], ...HISTORY]));
  assert.equal(signedTripleReached(cancelled, now), false, "cancelled rows keep their own rules");
});

// ---- 冻结只停本机发起的逐票请求：打开详情、详情下拉、状态对齐强刷都不再跑，详情页照常显示缓存。
test("a row at the signed triple sends no per-row request from the detail page or the alignment run", async () => {
  reset();
  const stored = persist(signedRow());
  assert.equal(needsDetailEntryQuery(stored), false);
  for (const options of [PULL, { trigger: "detail_open" as const },
    { ...PULL, trigger: "status_alignment" as const }]) {
    const calls: string[] = [];
    const result = await runShipmentRefreshForTesting(stored.identity.id, lease(), options, recordingRuntime(calls));
    assert.deepEqual(calls, [], `${options.trigger}: nothing is requested`);
    assert.equal(result.refreshed, false);
    assert.equal(result.shipment.identity.id, stored.identity.id, "the cached row is handed back to the page");
  }
  const skipped = skipLines("detail.refresh.skipped");
  assert.equal(skipped.length, 3, "each stopped refresh writes one skip line");
  assert.deepEqual(skipped.map(entry => entry.details.trigger).sort(), ["detail_open", "detail_pull", "status_alignment"]);
  assert.equal(skipped[0]!.details.result, "signed_frozen");
  assert.equal(skipped[0]!.details.waybillTail, "9101");
  assert.doesNotMatch(JSON.stringify(skipped), new RegExp(WAYBILL));
});

// A signed row whose headline and detail stop before the signing, with incomplete history, still refreshes on a pull.
test("a row short of the signed triple keeps its pull", async () => {
  reset();
  const stored = persist(sfRow(feed([[SIGNED_AT, SIGNED_TEXT]], SIGNED_AT),
    k100([["2026-09-08 13:20:00", DELIVERING_TEXT], ["2026-09-08 11:41:00", STORE_TEXT]])));
  assert.equal(signedRefreshFrozen(stored, now), false);
  const calls: string[] = [];
  await runShipmentRefreshForTesting(stored.identity.id, lease(), PULL, recordingRuntime(calls));
  assert.ok(calls.includes("k100_h5"), "the incomplete signed detail is still repaired on pull");
  assert.equal(skipLines("detail.refresh.skipped").length, 0);
});

// ---- 状态对齐：三态都到签收、但三个时间仍对不上（头条比状态新）的行不强刷。用户 2026-10-03「已冻结的行不进对齐检查」
// （优化 3）：冻结的行根本不进检查——不记记录、不写日志（改前：同一组时间记一次 signed_frozen 跳过并写一条日志）。
test("the alignment pass does not check a frozen row out of step", async () => {
  reset();
  const row = persist(signedRow(["2026-09-08 13:45:00", "快件已签收，客服回访"]));
  const records: Record<string, string> = {};
  const store: StatusAlignmentRecordStore = {
    load: () => ({ ...records }),
    save: (next) => { for (const key of Object.keys(records)) delete records[key]; Object.assign(records, next); },
  };
  const state: AppState = loadState(now);
  let refreshed = 0;
  const pass = () => runStatusAlignmentPass({}, {
    appHost: () => true, busy: () => false, load: () => state, records: store, now: () => now,
    refresh: async () => { refreshed++; return { state }; },
  });
  assert.equal(signedRefreshFrozen(row, now), true);
  assert.equal((await pass()).result, "nothing_due");
  assert.equal((await pass()).result, "nothing_due");
  assert.equal(refreshed, 0, "the frozen row is never forced");
  assert.equal(readDiagnostics().filter(entry => entry.event === "detail.refresh.alignment").length, 0,
    "a frozen row writes no alignment line");
  assert.deepEqual(records, {}, "and leaves no record");
});

// ---- 首页下拉 / 后台里这一行的逐票工作：菜鸟件列表更新后的按件详情不再查（列表同步本身照常）。
test("the Home account follow-up skips a Cainiao row at the signed triple", async () => {
  reset();
  const signedFeed: TimelinePackage = { ...feed([[SIGNED_AT, SIGNED_TEXT], ["2026-09-08 11:41:00", STORE_TEXT],
    ["2026-09-07 10:00:00", "已揽收"]], SIGNED_AT), provider: "v5_list", courierCode: "YTO", companyName: "圆通速递" };
  const cainiao = (suffix: string, timeline: TimelinePackage): Shipment => {
    const waybill = `YT00000091${suffix}`;
    const own = { ...timeline, waybill };
    return { identity: { id: `interface5:account:${waybill}`, sourceId: waybill, bindingSource: "interface5",
      sourceProvider: "CaiNiao", sourceOwner: "interface5:parcel", manuallyAdded: false, courierCode: "YTO",
      rawCourierCode: "YTO", companyName: "圆通速递", phone: PHONE, phoneTail: "9101", createdAtMs: NOW - 86_400_000 },
      timeline: own, sourceTimeline: own, manualTimelines: [], updatedAtMs: NOW - 60_000,
      accountRecord: { waybill, provider: "CaiNiao", companyCode: "YTO", phone: PHONE } } as Shipment;
  };
  const frozen = cainiao("01", signedFeed);
  const moving = cainiao("02", { ...signedFeed, semantic: "DELIVERY",
    statusEventAtMs: at("2026-09-08 13:20:00"), tracks: signedFeed.tracks.slice(1) });
  let base = saveState({ ...emptyState(), shipments: [frozen, moving], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 },
  ] }, now);
  assert.equal(signedRefreshFrozen(base.shipments.find(s => s.identity.id === frozen.identity.id)!, now), true);
  const calls: string[] = [];
  await runShipmentEnrichmentForTesting(base, "interface5", "signed-freeze-home", (candidate) => {
    base = saveState(candidate, now);
    return base;
  }, now + 30_000, new Set(), true, false, undefined, {
    refreshAccountParcel: async (shipment: Shipment) => { calls.push(shipment.identity.id); return null; },
    queryManualForSource: async () => { assert.fail("the Home follow-up never enters manual providers"); },
  }, true, new Set([frozen.identity.id, moving.identity.id]));
  assert.deepEqual(calls, [moving.identity.id], "only the row short of the signing is queried");
  const skipped = skipLines("refresh.stage.skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.details.stage, "v5_query");
});

// ---- 条件不再成立（状态离开签收，如退回）时自然解冻。
test("a row leaving the signing thaws", () => {
  reset();
  const returned = sfRow(feed([["2026-09-08 13:50:00", "快件退回中"], [SIGNED_AT, SIGNED_TEXT]],
    "2026-09-08 13:50:00", "DANGER"), k100([["2026-09-08 13:50:00", "快件退回中"], [SIGNED_AT, "快件已签收"],
    ...HISTORY]));
  assert.equal(signedTripleReached(returned, now), false);
  assert.equal(signedRefreshFrozen(returned, now), false);
  assert.equal(shouldRefreshShipmentRow(returned, now), true);
});

// ---- 京东：被保留为首次签收证据的评价 / 订单完成节点（临时头条）不算到达签收；签收缺口那一次京粉页没用掉也不算。
const ORDER = "3999999000009101", JD_WAYBILL = "JD9990000009101";
const REVIEW = `您的订单${ORDER}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。`;
const JD_EVENT = at("2026-09-08 12:00:00");
const providerTime = (value: number) => new Date(value + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

/** A signed JD parcel whose feed reached pickup; `newestStillDelivering` gives its newest node a structured 派送中. */
function jdParcel(newestDetail: string, newestStillDelivering = false): AccountParcelDto {
  const tracks = [
    { timeText: providerTime(JD_EVENT), detail: newestDetail, statusCode: newestStillDelivering ? "105" : "",
      ...(newestStillDelivering ? { normalizedStatus: { version: 1, scope: "SHIPMENT", semantic: "DELIVERY",
        code: "105", text: "派送中", priority: 5, eventAtMs: JD_EVENT, structured: true } } : {}) },
    { timeText: providerTime(JD_EVENT - 2 * 60_000), detail: "您的快件已到达【测试站】", statusCode: "" },
    { timeText: providerTime(JD_EVENT - 3 * 3_600_000), detail: "京东快递 已揽收", statusCode: "" },
  ];
  return {
    source: "interface5", ownerId: ORDER, orderId: ORDER, accountOrder: true, waybill: JD_WAYBILL,
    courierCode: "JD", rawCourierCode: "JD", companyName: "京东快递", sourceProvider: "JingDong",
    sourceStateCode: "107", sourceStateText: "已签收", semantic: "COMPLETED", normalizedStatusScope: "SHIPMENT",
    normalizedStatusSemantic: "COMPLETED", normalizedStatusText: "已签收", receiverPhone: PHONE, senderPhone: "",
    latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail, tracks, routeUrl: "",
    projectionUrl: "https://u.jd.com/forward?test=signed-freeze",
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic: "COMPLETED", code: "107", text: "已签收",
      priority: 0, eventAtMs: JD_EVENT, structured: true },
  } as AccountParcelDto;
}

function jdRow(parcel: AccountParcelDto, union: TimelinePackage | null = null): Shipment {
  const row = parcelToShipment({ ...parcel, projectionTimeline: union }, [PHONE], now)!;
  return saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 },
  ] }, now).shipments[0]!;
}

test("JD: a kept review heading the list is a temporary signing and does not freeze", () => {
  reset();
  const review = jdRow(jdParcel(REVIEW));
  assert.equal(jingDongSignedHistoryGap(review), true);
  assert.equal(shipmentDetailIncompleteReason(review), null, "the gap is not owed: only the review keeps it open");
  assert.equal(selectShipmentTimeline(review).latestDetail, REVIEW, "the review is the list headline (2026-09-27)");
  const times = statusAlignmentTimes(review)!;
  assert.ok(times.headlineAtMs >= times.statusAtMs - STATUS_ALIGNMENT_MS,
    "without the review the real nodes are within five minutes: only the temporary headline keeps it open");
  assert.equal(signedTripleReached(review, now), false);
  assert.equal(signedRefreshFrozen(review, now), false);
});

test("JD: the signed-history union page still owed keeps the row open until it was used", () => {
  reset();
  // The feed reached pickup and signs at JD_EVENT, but its node at that second still reports 派送中: the detail is not
  // complete, and no union page was captured since the completion, so the one pull (2026-09-24) is still owed.
  const owed = jdRow(jdParcel("您的快件正在派送中，请您准备签收", true));
  const times = statusAlignmentTimes(owed)!;
  assert.deepEqual([times.headlineAtMs, times.detailAtMs], [times.statusAtMs, times.statusAtMs], "the times agree");
  assert.equal(jingDongSignedHistoryGap(owed), true);
  assert.notEqual(shipmentDetailIncompleteReason(owed), null);
  assert.equal(signedTripleReached(owed, now), false, "the signed-gap union page has not run yet");
  assert.equal(signedRefreshFrozen(owed, now), false);
  // The page consumes the gap, but a known delivery headline still cannot certify signing (2026-10-08).
  const union: TimelinePackage = { provider: "jd_h5", waybill: JD_WAYBILL, courierCode: "JD", companyName: "京东快递",
    semantic: "UNKNOWN", structuredStatus: false, complete: true, successAtMs: JD_EVENT + 60_000,
    latestTimeText: providerTime(JD_EVENT), latestDetail: "您的快件已签收",
    tracks: [JD_EVENT, JD_EVENT - 2 * 60_000, JD_EVENT - 3 * 3_600_000].map((value, index) => ({
      timeMs: value, timeText: providerTime(value), statusCode: "", raw: { _pipiStatusSource: "jingdong_h5" },
      detail: ["您的快件已签收", "您的快件正在派送中，请您准备签收", "您的快件已由京东快递揽收"][index]!,
    })) };
  const used = jdRow(jdParcel("您的快件正在派送中，请您准备签收", true), union);
  assert.equal(jingDongSignedHistoryGap(used), false);
  assert.equal(signedTripleReached(used, now), false, "the feed headline still carries a delivery enum");
  // 用户 2026-10-03「这轮就统一」（优化 1）：the pending-release check reads the row's signed ledger. An answer of the union
  // page in this generation (no package kept: an empty page) uses the pass up just the same.
  const answered = jdRow(jdParcel("您的快件正在派送中，请您准备签收", true));
  assert.equal(signedTripleReached(answered, now), false);
  recordSignedRelease(answered.identity.id, JD_EVENT, "jingDongUnionGap", now);
  assert.equal(jingDongSignedHistoryGap(answered), false);
  assert.equal(signedTripleReached(answered, now), false, "a used release does not change the headline's enum");
  assert.equal(signedReleaseUsed(answered.identity.id, JD_EVENT + 60_000, "jingDongUnionGap"), false,
    "another completion time is a new generation");
  // Without the union page, a row whose detail is already complete owes nothing either.
  assert.equal(signedTripleReached(jdRow(jdParcel("您的快件已签收")), now), true);
});

// ---- 右滑签收（forcedCompletedAtMs）：展示照旧（立即已签收、不发通知），刷新要等来源三态到签收或满 72 小时。
test("a right-swipe sign-off keeps refreshing by its source until the signed triple", async () => {
  reset();
  const stored = persist(inTransitRow());
  const unforcedTimes = statusAlignmentTimes(stored);
  const unforcedRefresh = shouldRefreshShipmentRow(stored, now);
  forceCompleteShipment(stored.identity.id, now);
  const forced = loadState(now).shipments[0]!;
  const forcedAt = forced.forcedCompletedAtMs!;
  assert.equal(forcedAt, now);

  // Shown signed at once, its status latched to the click.
  assert.equal(selectShipmentTimeline(forced).semantic, "COMPLETED");
  assert.equal(selectShipmentTimeline(forced).statusEventAtMs, forcedAt);
  // Refreshed as the ordinary row its source makes it: the click is not signing evidence.
  assert.equal(forcedCompletionRefreshOpen(forced, now), true);
  assert.equal(signedRefreshFrozen(forced, now), false);
  assert.equal(signedTripleReached(forced, now), false);
  assert.equal(shouldRefreshShipmentRow(forced, now), unforcedRefresh);
  assert.equal(unforcedRefresh, true);
  assert.deepEqual(statusAlignmentTimes(forced), unforcedTimes, "the alignment reads the source's own status");

  // A pull still runs its chain; the headline and detail follow the source while the status stays signed.
  const calls: string[] = [];
  const fresher = k100([["2026-09-08 13:10:00", DELIVERING_TEXT], ...HISTORY]);
  await runShipmentRefreshForTesting(forced.identity.id, lease(), PULL, recordingRuntime(calls, fresher));
  assert.ok(calls.includes("k100_h5"), "the pull asks K100 as for the unsigned row");
  const after = loadState(now).shipments[0]!;
  const listed = selectShipmentTimeline(after);
  assert.equal(listed.semantic, "COMPLETED", "the sign-off stays shown");
  assert.equal(listed.statusEventAtMs, forcedAt);
  assert.equal(listed.latestDetail, DELIVERING_TEXT, "the refreshed headline shows");
  assert.equal(listed.latestTimeText, "2026-09-08 13:10:00");
  assert.equal(shipmentNotificationEvent(forced, after), null, "a signed-off row never notifies");
  assert.equal(skipLines("detail.refresh.skipped").length, 0);

  // Scheduled per-row work runs too (an SF row asks Online in the list round).
  const scheduled: string[] = [];
  let state = loadState(now);
  await runShipmentEnrichmentForTesting(state, "interface5", "signed-freeze-forced", (candidate) => {
    state = saveState(candidate, now);
    return state;
  }, now + 30_000, new Set(), true, false, undefined, recordingRuntime(scheduled));
  assert.deepEqual(scheduled, ["v6_query"]);
});

test("a right-swipe sign-off hard-freezes once its source reaches the signed triple", async () => {
  reset();
  const stored = persist(inTransitRow());
  forceCompleteShipment(stored.identity.id, now);
  // The source then reports the signing, and the list headline and the detail reach it.
  now = NOW + 60_000;
  const signed = signedRow();
  const current = loadState(now).shipments[0]!;
  const reached = saveState({ ...loadState(now), shipments: [{ ...current, sourceTimeline: signed.sourceTimeline,
    manualTimelines: signed.manualTimelines }] }, now).shipments[0]!;
  assert.equal(reached.forcedCompletedAtMs, NOW);
  assert.equal(signedTripleReached(reached, now), true, "the source's own signing, not the click");
  assert.equal(forcedCompletionRefreshOpen(reached, now), false);
  assert.equal(signedRefreshFrozen(reached, now), true);
  assert.equal(shouldRefreshShipmentRow(reached, now), false);
  assert.equal(statusAlignmentTimes(reached), null, "a hard-frozen sign-off takes no part in the alignment");
  const calls: string[] = [];
  await runShipmentRefreshForTesting(reached.identity.id, lease(), PULL, recordingRuntime(calls));
  assert.deepEqual(calls, []);
  assert.equal(skipLines("detail.refresh.skipped").length, 1);
  const scheduled: string[] = [];
  const state = loadState(now);
  await runShipmentEnrichmentForTesting(state, "interface5", "signed-freeze-hard", (candidate) => saveState(candidate, now),
    now + 30_000, new Set(), true, false, undefined, recordingRuntime(scheduled));
  assert.deepEqual(scheduled, []);
});

test("a right-swipe sign-off hard-freezes 72 hours after the click without a source signing", async () => {
  reset();
  const stored = persist(inTransitRow());
  forceCompleteShipment(stored.identity.id, now);
  const forced = loadState(now).shipments[0]!;
  now = NOW + FORCED_COMPLETION_REFRESH_WINDOW_MS - 1;
  assert.equal(forcedCompletionRefreshOpen(forced, now), true);
  assert.equal(signedRefreshFrozen(forced, now), false);
  now = NOW + FORCED_COMPLETION_REFRESH_WINDOW_MS;
  assert.equal(FORCED_COMPLETION_REFRESH_WINDOW_MS, 72 * 3_600_000);
  assert.equal(forcedCompletionRefreshOpen(forced, now), false);
  assert.equal(signedRefreshFrozen(forced, now), true);
  assert.equal(shouldRefreshShipmentRow(forced, now), false);
  assert.equal(needsDetailEntryQuery(forced), false);
  assert.equal(statusAlignmentTimes(forced, now), null);
  const calls: string[] = [];
  await runShipmentRefreshForTesting(forced.identity.id, lease(), PULL, recordingRuntime(calls));
  assert.deepEqual(calls, []);
  assert.equal(selectShipmentTimeline(loadState(now).shipments[0]!).semantic, "COMPLETED");
});

// ---- 用户 2026-10-03「硬冻结也照常识别承运商」（优化 4）：右滑签收硬冻结只停轨迹刷新，承运商识别照常（仍不通知）——
// 与三态冻结的行一样，详情页先识别承运商，再停下（改前：硬冻结的行在识别之前就返回）。
test("a hard-frozen sign-off still recognises its carrier and requests nothing else", async () => {
  reset();
  const waybill = "MANUAL000009101";
  const timeline = { ...k100([["2026-09-08 12:30:00", DELIVERING_TEXT], ...HISTORY]), provider: "v6_query", waybill,
    courierCode: "", companyName: "", semantic: "DELIVERY" as const, structuredStatus: true,
    statusEventAtMs: at("2026-09-08 12:30:00") };
  const manual = { identity: { id: `interface5:manual:${waybill}`, bindingSource: "interface5", sourceOwner: "manual",
    sourceId: waybill, phoneTail: "9101", courierCode: "", companyName: "", manuallyAdded: true,
    createdAtMs: NOW - 86_400_000 }, timeline, sourceTimeline: null, manualTimelines: [timeline],
    updatedAtMs: NOW - 3_600_000 } as unknown as Shipment;
  const stored = persist(manual);
  forceCompleteShipment(stored.identity.id, now);
  now = NOW + FORCED_COMPLETION_REFRESH_WINDOW_MS;
  const frozen = loadState(now).shipments[0]!;
  assert.equal(signedRefreshFrozen(frozen, now), true, "hard-frozen 72 hours after the click");
  seedRecognizedCarriers({ [waybill]: "ZTO" }, now);
  for (const trigger of ["detail_open", "detail_pull"] as const) {
    const calls: string[] = [];
    await runShipmentRefreshForTesting(frozen.identity.id, lease(), trigger === "detail_pull" ? PULL : { trigger },
      recordingRuntime(calls));
    assert.deepEqual(calls, [], `${trigger}: no timeline request`);
    const after = loadState(now).shipments[0]!;
    assert.equal(after.identity.companyName, "中通快递", `${trigger}: the carrier is recognised`);
    assert.equal(after.identity.courierCode, "ZTO");
    assert.equal(after.forcedCompletedAtMs, NOW, "the sign-off stays");
    assert.equal(selectShipmentTimeline(after).semantic, "COMPLETED");
    assert.equal(shipmentNotificationEvent(frozen, after), null, "a signed-off row never notifies");
    assert.deepEqual(after.manualTimelines, frozen.manualTimelines, "no timeline changes");
  }
  assert.equal(skipLines("detail.refresh.skipped").length, 2, "each refresh still stops at the freeze");
});

test("the click time is never signing evidence", () => {
  reset();
  // The source reports delivery a minute before the click and the K100 page reaches it: with the latch read as a
  // signing at the click, status, headline and detail would all sit within five minutes.
  const stored = persist(sfRow(feed([["2026-09-08 13:59:00", DELIVERING_TEXT]], "2026-09-08 13:59:00", "DELIVERY"),
    k100([["2026-09-08 13:59:00", DELIVERING_TEXT], ...HISTORY])));
  forceCompleteShipment(stored.identity.id, now);
  const forced = loadState(now).shipments[0]!;
  assert.equal(forced.timeline.semantic, "COMPLETED");
  assert.equal(forced.timeline.statusEventAtMs, now, "the stored presentation carries the latch");
  assert.equal(signedTripleReached(forced, now), false);
  assert.equal(signedRefreshFrozen(forced, now), false);
});

// ---- 还没投影出运单号的京东订单从不冻结（用户 2026-10-02 弹窗「不冻结，取到号再判」，与 Lite 现状一致）：取号与既有的
// 刷新照旧跑；投影出运单号以后才按三态判。
test("an unprojected JD order is never frozen and is judged once its waybill is projected", async () => {
  reset();
  const order = "3999999000009102";
  const listed = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东快递", phone: PHONE, stateNum: 107,
    details: [{ time: "2026-09-08 12:00:00", desc: "您的订单已签收" }],
  }] } })[0]!;
  const row = applyAccountShipment(undefined, parcelToShipment(listed, [PHONE], now - 60_000)!, now - 60_000);
  const stored = persist(row);
  saveOrderProjectionReferences([{ ownerId: stored.identity.id, source: "interface5",
    url: "https://u.jd.com/forward?test=signed-freeze-order" }], now);
  const times = statusAlignmentTimes(stored)!;
  assert.deepEqual([times.headlineAtMs, times.detailAtMs], [times.statusAtMs, times.statusAtMs],
    "status, headline and detail all at the signing");
  assert.equal(signedTripleReached(stored, now), false, "no carrier waybill yet: never at the signed triple");
  assert.equal(signedRefreshFrozen(stored, now), false);
  const calls: string[] = [];
  await runShipmentRefreshForTesting(stored.identity.id, lease(), { trigger: "detail_open" }, recordingRuntime(calls));
  assert.deepEqual(calls, ["jd_h5"], "detail entry projects the waybill as it always did");
  assert.equal(skipLines("detail.refresh.skipped").length, 0);

  // A pull past the page's rest: the projection and the history stages that follow it run as before the freeze.
  now += 61 * 60_000;
  const pulled: string[] = [];
  const projected = "JD9990000009102";
  const result = await runShipmentRefreshForTesting(stored.identity.id, lease(), PULL, {
    ...recordingRuntime(pulled),
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => {
      pulled.push("jd_h5");
      return { ...input, waybill: projected, courierCode: "JD", rawCourierCode: "JD", companyName: "京东快递" };
    },
  });
  assert.deepEqual(pulled, ["jd_h5", "k100_h5", "kdniao"], "nothing of the pull chain is frozen for the order");
  assert.equal(skipLines("detail.refresh.skipped").length, 0);
  // Projected, the row is an ordinary signed parcel: the triple decides from now on.
  const projectedRow = loadState(now).shipments.find(item => item.identity.id === stored.identity.id)!;
  assert.equal(projectedRow.identity.projectedWaybill, projected);
  assert.equal(result.shipment.identity.projectedWaybill, projected);
  assert.equal(signedRefreshFrozen(projectedRow, now), true, "status, headline and detail are at the signing");
});
