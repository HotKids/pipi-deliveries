import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { Shipment } from "../models";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, loadState, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import {
  applyAccountShipment,
  statusAlignmentOutOfStep,
  statusAlignmentTimes,
} from "../services/shipment-policy";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";

const WAYBILL = "YT0000000009401", PHONE = "13800009401";
const STATUS_AT = 1789104000000; // the list's structured status time
const NOW = STATUS_AT + 6 * 3600000;
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

function parcel(newestAt: number): AccountParcelDto {
  const tracks = [
    { timeText: providerTime(newestAt), detail: "快件派送中", statusCode: "" },
    { timeText: providerTime(STATUS_AT - 2 * 3600000), detail: "快件到达【测试驿站】", statusCode: "" },
    { timeText: providerTime(STATUS_AT - 86400000), detail: "已揽收", statusCode: "" },
  ].filter((track, index, all) => all.findIndex(other => other.timeText === track.timeText) === index);
  return {
    source: "interface5", ownerId: WAYBILL, waybill: WAYBILL, accountOrder: false,
    courierCode: "YTO", rawCourierCode: "YTO", companyName: "圆通速递", sourceProvider: "CaiNiao",
    sourceStateCode: "105", sourceStateText: "派送中", semantic: "DELIVERY", normalizedStatusScope: "SHIPMENT",
    normalizedStatusSemantic: "DELIVERY", normalizedStatusText: "派送中", receiverPhone: PHONE, senderPhone: "",
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks, routeUrl: "",
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic: "DELIVERY", code: "105", text: "派送中",
      priority: 0, eventAtMs: STATUS_AT, structured: true },
  } as AccountParcelDto;
}

function seed(): Shipment {
  memory.clear();
  setDiagnosticsEnabled(true);
  // The list reports 派送中 at STATUS_AT while its own newest node is two hours older.
  const row = applyAccountShipment(undefined, parcelToShipment(parcel(STATUS_AT - 2 * 3600000), [PHONE], NOW)!, NOW);
  return saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW).shipments[0]!;
}

const lease = { isCurrent: () => true, deadlineAtMs: NOW + 30000 };
const ALIGNMENT = { trigger: "status_alignment" as const, forceManualRefresh: true, includeKdniaoFallback: true,
  forceAccountOrderProjection: true };

function runtime(calls: string[], answer: AccountParcelDto | null) {
  return {
    refreshAccountParcel: async () => { calls.push("v5_query"); return answer; },
    refreshCainiaoH5: async () => { calls.push("cn_h5"); return null; },
    refreshWebTimeline: async () => { calls.push("k100_h5"); return null; },
    queryManualForSource: async (input: { fallbackOnly?: boolean; pickerOnly?: boolean }) => {
      calls.push(input.fallbackOnly ? "kdniao" : input.pickerOnly ? "v6_query" : "manual");
      return { shipment: null, pending: null, routeUrl: "" };
    },
  };
}

// 用户 2026-10-03「按件查询对齐了就不开菜鸟页」（优化 8-2）：菜鸟来源件的状态对齐强刷先问按件详情（v5_query）；问完以后
// 状态、头条与本地详情已对上（任两个相差不过五分钟），就此停下，不开菜鸟页。改前：问完照样开菜鸟页。
test("a Cainiao row aligned by its per-parcel query does not open the Cainiao page", async () => {
  const row = seed();
  const before = statusAlignmentTimes(row)!;
  assert.ok(statusAlignmentOutOfStep(before), "the status is two hours ahead of the headline and the detail");
  const calls: string[] = [];
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, ALIGNMENT,
    runtime(calls, parcel(STATUS_AT)));
  assert.deepEqual(calls, ["v5_query"], "the query aligned the row: no Cainiao page, nothing after it");
  const after = loadState(NOW).shipments[0]!;
  assert.equal(statusAlignmentOutOfStep(statusAlignmentTimes(after)!), false);
  assert.equal(result.shipment.identity.id, row.identity.id);
  const skipped = readDiagnostics().filter(entry => entry.event === "detail.refresh.skipped" &&
    entry.details.skipReason === "aligned_after_query");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.details.trigger, "status_alignment");
  assert.doesNotMatch(JSON.stringify(skipped), new RegExp(WAYBILL));
});

// 仍对不上（按件详情没有更新的节点，或请求失败）才开菜鸟页。
test("a Cainiao row still out of step after its query opens the Cainiao page", async () => {
  for (const answer of [parcel(STATUS_AT - 2 * 3600000), null]) {
    const row = seed();
    const calls: string[] = [];
    await runShipmentRefreshForTesting(row.identity.id, lease, ALIGNMENT, runtime(calls, answer));
    assert.equal(calls[0], "v5_query");
    assert.ok(calls.includes("cn_h5"), `${answer ? "an unhelpful answer" : "no answer"}: the Cainiao page opens`);
    assert.equal(readDiagnostics().some(entry => entry.details.skipReason === "aligned_after_query"), false);
  }
});

// A detail pull is unchanged: it never stops at this check.
test("the check belongs to the alignment run only", async () => {
  const row = seed();
  const calls: string[] = [];
  await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_pull", forceManualRefresh: true,
    includeKdniaoFallback: true }, runtime(calls, parcel(STATUS_AT)));
  assert.equal(calls.includes("v5_query"), false, "a pull asks no per-parcel query first");
  assert.equal(readDiagnostics().some(entry => entry.details.skipReason === "aligned_after_query"), false);
});
