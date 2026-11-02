import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { AccountOrderProjectionDiagnostics } from "../services/account-order-projection";
import type { Shipment, StatusSemantic, TimelinePackage, TrackNode } from "../models";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, loadState, removeShipment, saveState } from "../services/storage";
import { saveOrderProjectionReferences } from "../services/routes";
import { parseProviderTime } from "../services/status";
import { runShipmentRefreshForTesting } from "../services/sync";
import {
  jingDongSignedHistoryGap,
  shipmentDetailIncompleteReason,
  statusAlignmentTimes,
} from "../services/shipment-policy";
import {
  loadRowLedger,
  recordSignedRelease,
  rowLedgerKey,
  signedReleaseUsed,
} from "../services/row-ledger";
import { runStatusAlignmentPass } from "../services/status-alignment";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";

// 用户 2026-10-03 逐条决定（docs/EXPRESS_OPTIMIZATION_REVIEW_20261003.md 第四节）：
// - 优化 1「这轮就统一」：签收后的一次性放行合成每行一份持久化台账，按完成时间 T 分代；「拿到回答就算用掉」（有回答但没
//   轨迹、只抓到部分包也算），网络失败、超时、风控、冷却跳过不算。状态对齐「同组时间只刷一次」记在同一份台账里。
// - 优化 3「四端都持久化、不因暂时消失删除」：只在行真正删除（或运单号被新件接管）时清掉。
// 合成数据：订单号、运单号、手机号都是编的。

const EVENT = 1789085861000, OLD_EVENT = 1789056101000, NOW = EVENT + 12 * 3600000;
const ORDER = "3610000000009301", WAYBILL = "JD000000009301", PHONE = "13800009301";
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });

/** A signed JD parcel whose feed reached pickup three hours before its structured completion at `completedAt`. */
function signedParcel(completedAt = EVENT, semantic: StatusSemantic = "COMPLETED"): AccountParcelDto {
  const newest = EVENT - 3 * 3600000;
  const tracks = Array.from({ length: 6 }, (_, i) => ({
    timeText: providerTime(newest - i * 60000),
    detail: i === 5 ? "已揽收" : `Synthetic account event ${i}`, statusCode: "",
  }));
  return {
    source: "interface5", ownerId: ORDER, orderId: ORDER, accountOrder: true, waybill: WAYBILL,
    courierCode: "JD", rawCourierCode: "JD", companyName: "Synthetic carrier", sourceProvider: "JingDong",
    sourceStateCode: "107", sourceStateText: semantic, semantic, normalizedStatusScope: "SHIPMENT",
    normalizedStatusSemantic: semantic, normalizedStatusText: semantic, receiverPhone: PHONE, senderPhone: "",
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks, routeUrl: "",
    projectionUrl: "https://u.jd.com/forward?test=row-ledger",
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic, code: "107", text: semantic,
      priority: 0, eventAtMs: completedAt, structured: true },
  } as AccountParcelDto;
}

/** An expanded union page package captured before the completion (so the package rule alone leaves the gap open). */
function oldUnionPage(): TimelinePackage {
  const tracks = Array.from({ length: 8 }, (_, i) => ({
    timeMs: OLD_EVENT - i * 60000, timeText: providerTime(OLD_EVENT - i * 60000),
    detail: i === 7 ? "已揽收" : `Synthetic H5 event ${i}`, statusCode: "",
    raw: { _pipiStatusSource: "jingdong_h5" },
  }));
  return { provider: "jd_h5", waybill: WAYBILL, courierCode: "JD", companyName: "Synthetic carrier",
    semantic: "UNKNOWN", structuredStatus: false, complete: true, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: OLD_EVENT + 60000 };
}

function seedGapRow(completedAt = EVENT): Shipment {
  memory.clear();
  clock = NOW;
  setDiagnosticsEnabled(true);
  const row = parcelToShipment({ ...signedParcel(completedAt), projectionTimeline: oldUnionPage() }, [PHONE], NOW)!;
  const state = saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  saveOrderProjectionReferences([{ ownerId: row.identity.id, source: "interface5",
    url: signedParcel().projectionUrl! }], NOW);
  return state.shipments[0]!;
}

const lease = () => ({ isCurrent: () => true, deadlineAtMs: clock + 30000 });
const PULL = { trigger: "detail_pull" as const, forceManualRefresh: true, includeKdniaoFallback: true };

function pageDiagnostics(overrides: Partial<AccountOrderProjectionDiagnostics> = {}): AccountOrderProjectionDiagnostics {
  return {
    loadSettled: true, loadCompleted: true, captureSeen: false, replayAttempted: false, replaySucceeded: false,
    probeInstalled: true, probeMatched: false, probeRequestCount: 1, unionSignalSeen: true, unionResourceSeen: true,
    resourceReplayBlockReason: "", domMatched: false, projectionComplete: false, projectionTrackCount: 0,
    requestCallbackCount: 1, evaluationAttempts: 1, evaluationFailures: 0, loadDurationMs: 1, resourceCount: 1,
    pageClass: "jd", readyState: "complete", visibilityState: "visible", viewportAvailable: true,
    viewportHosted: true, identitySource: "", unionResponseStatuses: "200", unionPendingCount: 0,
    probeCaptureCount: 0, ...overrides,
  };
}

/** One pull; the union page answers as `answer` says. Returns how many pages were opened. */
async function pullWith(
  id: string,
  answer: "empty" | "partial" | "risk" | "timeout" | "failure",
  trigger: "detail_pull" | "status_alignment" = "detail_pull",
): Promise<number> {
  let pages = 0;
  await runShipmentRefreshForTesting(id, lease(), { ...PULL, trigger }, {
    refreshAccountParcel: async () => null,
    refreshWebTimeline: async () => null,
    queryManualForSource: async () => ({ result: "empty_response" as const, shipment: null, pending: null,
      routeUrl: "" }),
    projectAccountOrderWithCarrier: async (input: AccountParcelDto, _projection?: number, _deadline?: number,
      observe?: (diagnostics: AccountOrderProjectionDiagnostics) => void) => {
      pages++;
      if (answer === "failure") throw new Error("Synthetic page failure");
      observe?.(answer === "risk" ? pageDiagnostics({ unionResponseStatuses: "403" })
        : answer === "timeout" ? pageDiagnostics({ loadCompleted: false, loadSettled: false, unionPendingCount: 1 })
        : answer === "partial" ? pageDiagnostics({ probeMatched: true, projectionTrackCount: 1 })
        : pageDiagnostics());
      if (answer !== "partial") return { ...input, waybill: WAYBILL };
      // One node only, and from before the order's own feed: the cache guard keeps nothing of it.
      const partial: TimelinePackage = { ...oldUnionPage(), complete: false,
        tracks: [{ ...oldUnionPage().tracks[0], timeMs: EVENT - 30 * 86400000,
          timeText: providerTime(EVENT - 30 * 86400000) }] };
      return { ...input, waybill: WAYBILL, projectionTimeline: partial };
    },
  });
  return pages;
}

// ---- 签收缺口那一次京粉页：拿到回答就算用掉。
test("an answered union page uses the signed gap up, even without tracks", async () => {
  const row = seedGapRow();
  assert.equal(jingDongSignedHistoryGap(row), true);
  assert.ok(shipmentDetailIncompleteReason(row));
  assert.equal(await pullWith(row.identity.id, "empty"), 1);
  assert.equal(signedReleaseUsed(row.identity.id, EVENT, "jingDongUnionGap"), true);
  assert.equal(jingDongSignedHistoryGap(loadState(clock).shipments[0]!), false, "the gap is used");
  assert.doesNotMatch(JSON.stringify(loadRowLedger()), new RegExp(`${WAYBILL}|${ORDER}`), "no waybill or order kept");
  clock = NOW + 61 * 60000;
  assert.equal(await pullWith(row.identity.id, "empty"), 0, "past every cooldown, the page is not opened again");
});

test("a partial answer uses the gap up even when its package is not kept", async () => {
  const row = seedGapRow();
  assert.equal(await pullWith(row.identity.id, "partial"), 1);
  const stored = loadState(clock).shipments[0]!;
  assert.equal((stored.manualTimelines || []).some(timeline => timeline.provider === "jd_h5" &&
    timeline.successAtMs >= EVENT), false, "no union page package of this generation was kept");
  assert.equal(jingDongSignedHistoryGap(stored), false, "the answer alone uses the gap up");
});

for (const answer of ["risk", "timeout", "failure"] as const) {
  test(`a page that gave no answer (${answer}) leaves the gap open`, async () => {
    const row = seedGapRow();
    assert.equal(await pullWith(row.identity.id, answer), 1);
    assert.equal(signedReleaseUsed(row.identity.id, EVENT, "jingDongUnionGap"), false);
    assert.equal(jingDongSignedHistoryGap(loadState(clock).shipments[0]!), true);
    // Automatic work still rests; a cooldown skip cannot spend the signed-gap allowance.
    clock = NOW + 5 * 60000;
    assert.equal(await pullWith(row.identity.id, "empty", answer === "risk" ? "detail_pull" : "status_alignment"),
      0, "automatic ordinary cooldown and manual risk-control cooldown remain binding");
    assert.ok(readDiagnostics().some(entry => entry.event === "order.projection.skipped" &&
      String(entry.details.result).endsWith("cooldown")));
    assert.equal(jingDongSignedHistoryGap(loadState(clock).shipments[0]!), true, "a cooldown skip uses nothing");
    if (answer === "risk") clock = NOW + 61 * 60000;
    assert.equal(await pullWith(row.identity.id, "empty"), 1);
    assert.equal(jingDongSignedHistoryGap(loadState(clock).shipments[0]!), false);
  });
}

test("a new completion time is a new generation", async () => {
  const row = seedGapRow();
  assert.equal(await pullWith(row.identity.id, "empty"), 1);
  assert.equal(jingDongSignedHistoryGap(loadState(clock).shipments[0]!), false);
  // The source reports its completion again, later (a new T): the one pass is open again for it.
  const state = loadState(clock);
  const stored = state.shipments[0]!;
  const laterCompletion = EVENT + 2 * 3600000;
  saveState({ ...state, shipments: [{ ...stored,
    sourceTimeline: { ...stored.sourceTimeline!, statusEventAtMs: laterCompletion } }] }, clock);
  const moved = loadState(clock).shipments[0]!;
  assert.equal(signedReleaseUsed(moved.identity.id, laterCompletion, "jingDongUnionGap"), false);
  assert.equal(jingDongSignedHistoryGap(moved), true);
});

// ---- 台账只随行真正删除、或运单号被新件接管而清掉。
test("deleting the row clears its ledger; hiding or keeping it does not", () => {
  const row = seedGapRow();
  recordSignedRelease(row.identity.id, EVENT, "jingDongUnionGap", clock);
  saveState(loadState(clock), clock);
  assert.equal(signedReleaseUsed(row.identity.id, EVENT, "jingDongUnionGap"), true, "an ordinary save keeps it");
  removeShipment(row.identity.id, clock);
  assert.equal(signedReleaseUsed(row.identity.id, EVENT, "jingDongUnionGap"), false);
  assert.deepEqual(loadRowLedger(), {});
});

test("a new parcel taking the row over on a reused waybill clears its ledger", () => {
  const row = seedGapRow();
  recordSignedRelease(row.identity.id, EVENT, "jingDongUnionGap", clock);
  const state = loadState(clock);
  saveState({ ...state, shipments: [{ ...state.shipments[0]!, waybillReuseAtMs: clock }] }, clock);
  assert.equal(signedReleaseUsed(row.identity.id, EVENT, "jingDongUnionGap"), false);
});

// ---- 状态对齐的记录在同一份台账里；原来单独的 Storage 键里的记录原样搬过来，已记过的那组时间不再刷。
const SF = "SF0000000009301";
const at = (text: string) => parseProviderTime(text)!;
function node(timeText: string, detail: string, raw: TrackNode["raw"] = {}): TrackNode {
  return { timeText, timeMs: at(timeText), detail, statusCode: "", raw };
}
function outOfStepRow(): Shipment {
  const feed: TimelinePackage = { provider: "interface5", waybill: SF, courierCode: "SF", companyName: "顺丰速运",
    semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: at("2026-09-08 13:31:00"), complete: false,
    latestTimeText: "2026-09-08 13:31:00", latestDetail: "快递已完成签收", successAtMs: NOW - 3600000,
    tracks: [node("2026-09-08 13:31:00", "快递已完成签收")] };
  const k100Tracks = [node("2026-09-08 11:41:00", "快件到达【测试驿站】", { _pipiStatusSource: "web" }),
    node("2026-09-07 10:00:00", "顺丰速运 已收取快件", { _pipiStatusSource: "web" })];
  const k100: TimelinePackage = { provider: "k100_h5", waybill: SF, courierCode: "SF", companyName: "顺丰速运",
    semantic: "UNKNOWN", structuredStatus: false, statusEventAtMs: null, complete: true,
    latestTimeText: k100Tracks[0].timeText, latestDetail: k100Tracks[0].detail, successAtMs: NOW - 3600000,
    tracks: k100Tracks };
  return { identity: { id: `interface5:account:${SF}`, sourceId: SF, bindingSource: "interface5",
    sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng", courierCode: "SF", rawCourierCode: "SF",
    companyName: "顺丰速运", phone: PHONE, phoneTail: "9301", manuallyAdded: false, createdAtMs: NOW - 86400000 },
    timeline: feed, sourceTimeline: feed, manualTimelines: [k100], updatedAtMs: NOW - 3600000,
    accountRecord: { waybill: SF, companyCode: "SF", provider: "ShunFeng", phone: PHONE, stateNumber: 3 },
  } as Shipment;
}

function seedAlignmentRow(): Shipment {
  memory.clear();
  clock = NOW;
  setDiagnosticsEnabled(true);
  return saveState({ ...emptyState(), shipments: [outOfStepRow()], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW).shipments[0]!;
}

function alignmentPass(calls: string[]) {
  return runStatusAlignmentPass({}, {
    appHost: () => true, busy: () => false, load: () => loadState(clock), now: () => clock,
    refresh: async (id, beforeQuery) => { beforeQuery(); calls.push(id); return { state: loadState(clock) }; },
  });
}

test("an earlier start-only alignment record migrates as one unfinished attempt", async () => {
  const row = seedAlignmentRow();
  const times = statusAlignmentTimes(row)!;
  memory.set("pipi_deliveries_status_alignment_v1", JSON.stringify({
    [rowLedgerKey(row.identity.id)]: `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`,
  }));
  const calls: string[] = [];
  assert.equal((await alignmentPass(calls)).result, "attempted", "a start-only record proves no update");
  assert.deepEqual(calls, [row.identity.id]);
  const migrated = JSON.parse(loadRowLedger()[rowLedgerKey(row.identity.id)]!.alignment!);
  assert.equal(migrated.times, `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`);
  assert.equal(migrated.attempts, 2, "the earlier attempt still counts toward the limit");
  assert.equal(migrated.complete, false);
});

test("an alignment record goes with the deleted row and comes back with nothing", async () => {
  const row = seedAlignmentRow();
  const calls: string[] = [];
  assert.equal((await alignmentPass(calls)).result, "attempted");
  assert.equal((await alignmentPass(calls)).result, "nothing_due");
  // Any save that keeps the row keeps its record.
  const state = loadState(clock);
  saveState({ ...state, shipments: state.shipments.map(item => ({ ...item })) }, clock);
  assert.ok(loadRowLedger()[rowLedgerKey(row.identity.id)]?.alignment, "an ordinary save keeps the record");
  removeShipment(row.identity.id, clock);
  assert.deepEqual(loadRowLedger(), {}, "a real deletion clears it");
  // The same parcel added again with the same times is a new row: it is forced once more.
  saveState({ ...loadState(clock), shipments: [outOfStepRow()] }, clock);
  assert.equal((await alignmentPass(calls)).result, "attempted");
  assert.equal(calls.length, 2);
});
