import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import { emptyState, loadState, saveState } from "../services/storage";
import { parseProviderTime } from "../services/status";
import { selectShipmentTimeline } from "../services/shipment-policy";
import { runTargetedShipmentRefreshForTesting } from "../services/sync";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";

// 用户 2026-10-02 弹窗「下拉等那次强刷跑完再显示」：状态对齐强刷（status_alignment）占着这一行的 detail:<id> 租约时，详情页
// 下拉不再立刻返回（没有缓存时那会被当成「轨迹更新失败」），也不另起第二次刷新；等强刷跑完（在下拉自己的预算内），把它的结果
// 当作这次下拉的结果显示。合成数据（no real parcel data）：运单号、手机号都是编的。

const WAYBILL = "SF0000000009301";
const PHONE = "13800009301";
const at = (text: string) => parseProviderTime(text)!;
const actualNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = actualNow; });

function node(timeText: string, detail: string, raw: TrackNode["raw"] = {}): TrackNode {
  return { timeText, timeMs: at(timeText), detail, statusCode: "", raw };
}

function k100(nodes: readonly [string, string][]): TimelinePackage {
  const tracks = nodes.map(([timeText, detail]) => node(timeText, detail, { _pipiStatusSource: "web" }));
  return { provider: "k100_h5", waybill: WAYBILL, courierCode: "SF", companyName: "顺丰速运",
    semantic: "UNKNOWN", structuredStatus: false, statusEventAtMs: null, complete: true,
    latestTimeText: tracks[0]?.timeText || "", latestDetail: tracks[0]?.detail || "", successAtMs: NOW - 3_600_000,
    tracks };
}

/** An SF row signed in its feed at 13:31; `cached` is the K100 history the detail page shows (maybe none). */
function seed(cached: readonly [string, string][]): Shipment {
  memory.clear();
  setDiagnosticsEnabled(true);
  const signed = node("2026-09-08 13:31:00", "快递已完成签收");
  const source: TimelinePackage = { provider: "interface5", waybill: WAYBILL, courierCode: "SF", companyName: "顺丰速运",
    semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: at("2026-09-08 13:31:00"), complete: false,
    latestTimeText: cached.length ? signed.timeText : "", latestDetail: cached.length ? signed.detail : "",
    successAtMs: NOW - 3_600_000, tracks: cached.length ? [signed] : [] };
  const row = { identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL, bindingSource: "interface5",
    sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng", courierCode: "SF", rawCourierCode: "SF",
    companyName: "顺丰速运", phone: PHONE, phoneTail: "9301", manuallyAdded: false, createdAtMs: NOW - 86_400_000 },
    timeline: source, sourceTimeline: source, manualTimelines: cached.length ? [k100(cached)] : [],
    updatedAtMs: NOW - 3_600_000,
    accountRecord: { waybill: WAYBILL, companyCode: "SF", provider: "ShunFeng", phone: PHONE, stateNumber: 3 },
  } as Shipment;
  return saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 },
  ] }, NOW).shipments[0]!;
}

const FRESH = k100([["2026-09-08 13:31:00", "快件已签收，签收人：本人"], ["2026-09-08 13:20:00", "快件派送中"],
  ["2026-09-08 11:41:00", "快件到达【测试驿站】"], ["2026-09-07 10:00:00", "顺丰速运 已收取快件"]]);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The forced refresh's chain: Online first for an SF row, then a K100 page held until `gate` opens. */
function runtime(calls: string[], gate: Promise<void>) {
  return {
    refreshAccountParcel: async () => { calls.push("v5_query"); return null; },
    queryManualForSource: async (input: { fallbackOnly?: boolean; pickerOnly?: boolean }) => {
      calls.push(input.fallbackOnly ? "kdniao" : input.pickerOnly ? "v6_query" : "manual");
      return { shipment: null, pending: null, routeUrl: "" };
    },
    refreshWebTimeline: async (shipment: Shipment) => {
      calls.push("k100_h5");
      await gate;
      return { ...shipment, timeline: FRESH, sourceTimeline: null, manualTimelines: [FRESH] };
    },
  };
}

const ALIGNMENT = { trigger: "status_alignment" as const, forceManualRefresh: true, includeKdniaoFallback: true,
  forceAccountOrderProjection: true, deadlineAtMs: NOW + 30_000 };
const PULL = { trigger: "detail_pull" as const, forceManualRefresh: true, includeKdniaoFallback: true,
  forceAccountOrderProjection: true, deadlineAtMs: NOW + 30_000 };

for (const cached of [true, false]) {
  test(`a pull during the forced refresh waits for it and shows its result (${cached ? "cached detail" : "no cache"})`,
    async () => {
      const row = seed(cached ? [["2026-09-08 11:41:00", "快件到达【测试驿站】"],
        ["2026-09-07 10:00:00", "顺丰速运 已收取快件"]] : []);
      const gate = deferred();
      const calls: string[] = [];
      const forced = runTargetedShipmentRefreshForTesting(row.identity.id, ALIGNMENT, runtime(calls, gate.promise));
      await tick();
      assert.ok(calls.includes("k100_h5"), "the forced refresh is waiting on its K100 page");
      let pulledResult: Awaited<ReturnType<typeof runTargetedShipmentRefreshForTesting>> | null = null;
      const pulled = runTargetedShipmentRefreshForTesting(row.identity.id, PULL, runtime(calls, gate.promise))
        .then((result) => { pulledResult = result; return result; });
      await tick();
      await tick();
      assert.equal(pulledResult, null, "the pull does not return while the forced refresh runs");
      const before = calls.length;
      gate.resolve();
      const [forcedResult, pullResult] = await Promise.all([forced, pulled]);
      assert.equal(calls.length, before, "no second refresh was started for the row");
      assert.equal(calls.filter((call) => call === "k100_h5").length, 1);
      assert.equal(forcedResult.refreshed, true);
      assert.equal(pullResult.refreshed, true, "the pull presents the forced refresh's outcome");
      assert.notEqual(pullResult.querySucceeded, false, "never read as a failed pull (no failure toast)");
      assert.equal(selectShipmentTimeline(pullResult.shipment).latestDetail, "快件已签收，签收人：本人",
        "the refreshed row, as stored");
      assert.equal(pullResult.shipment.updatedAtMs, loadState(NOW).shipments[0]!.updatedAtMs);
      const joined = readDiagnostics().find((entry) => entry.event === "detail.refresh.skipped" &&
        entry.details.skipReason === "coalesced_detail_refresh")!;
      assert.equal(joined.details.trigger, "detail_pull");
      assert.equal(joined.details.result, "refreshed");
    });
}

test("once the forced refresh is over, a pull runs its own refresh as before", async () => {
  const row = seed([["2026-09-08 11:41:00", "快件到达【测试驿站】"], ["2026-09-07 10:00:00", "顺丰速运 已收取快件"]]);
  const open = deferred();
  open.resolve();
  const calls: string[] = [];
  await runTargetedShipmentRefreshForTesting(row.identity.id, ALIGNMENT, runtime(calls, open.promise));
  const forcedCalls = calls.length;
  // The detail is now complete: an ordinary pull of a signed row stops at its complete cache, without waiting.
  const result = await runTargetedShipmentRefreshForTesting(row.identity.id, PULL, runtime(calls, open.promise));
  assert.equal(calls.length, forcedCalls, "the pull's own chain: nothing left to ask");
  assert.equal(result.refreshed, false);
  assert.equal(readDiagnostics().some((entry) => entry.details.skipReason === "coalesced_detail_refresh"), false);
});
