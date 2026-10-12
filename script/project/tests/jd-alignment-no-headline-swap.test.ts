import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { AppState, Shipment, TimelinePackage, TrackNode } from "../models";
import { emptyState, saveState } from "../services/storage";
import { parseProviderTime, signedRetentionAtMs } from "../services/status";
import {
  selectShipmentTimeline,
  statusAlignmentOutOfStep,
  statusAlignmentReason,
  statusAlignmentTimes,
  statusPackageHeadlineShown,
} from "../services/shipment-policy";
import { runStatusAlignmentPass, type StatusAlignmentRecordStore } from "../services/status-alignment";
import { setDiagnosticsEnabled } from "../services/logger";

// 用户 2026-10-02 弹窗「只强刷、不换头条」：京东业务来源的自动件不做状态包换头条（与 Pipi ExpressSourcePolicy.isJdBusinessSource
// 同一范围）；头条照 AGENTS §9 的京东规则定，状态对齐强刷照旧。「按列表实际显示的时间」：留存读列表显示的那条头条时间，
// 京东行这里只是少了换头条。合成数据（no real parcel data）：运单号、手机号都是编的。

const WAYBILL = "JD0000000009401";
const PHONE = "13800009401";
const at = (text: string) => parseProviderTime(text)!;
const STATUS_AT = "2026-09-08 13:30:00";
const FEED_NEWEST = "2026-09-08 10:30:00";
const actualNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = actualNow; });

function node(timeText: string, detail: string): TrackNode {
  return { timeText, timeMs: at(timeText), detail, statusCode: "", raw: {} };
}

function pack(provider: string, nodes: readonly [string, string][]): TimelinePackage {
  const tracks = nodes.map(([timeText, detail]) => node(timeText, detail));
  return { provider, waybill: WAYBILL, courierCode: "JD", companyName: "京东快递", semantic: "DELIVERY",
    structuredStatus: true, statusEventAtMs: at(STATUS_AT), complete: false,
    latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail, successAtMs: NOW - 3_600_000, tracks };
}

/**
 * A JD waybill row reporting 派送中 at 13:30: its list feed's newest node is three hours older, while the same-ticket
 * query (same status, same clock) has the 13:30 node. Status-package headline swapping would put that node on the list.
 */
function jdRow(sourceProvider = "JingDong"): Shipment {
  const pickup: [string, string] = ["2026-09-07 18:00:00", "京东快递 已揽收"];
  const feed = pack("interface5", [[FEED_NEWEST, "您的快件已到达【测试站】"], pickup]);
  const query = pack("v5_query", [[STATUS_AT, "您的快件正在派送中，请您准备签收"], [FEED_NEWEST, "您的快件已到达【测试站】"],
    pickup]);
  return { identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL, bindingSource: "interface5",
    sourceOwner: "interface5:parcel", sourceProvider, courierCode: "JD", rawCourierCode: "JD",
    companyName: "京东快递", phone: PHONE, phoneTail: "9401", manuallyAdded: false, createdAtMs: NOW - 86_400_000 },
    timeline: feed, sourceTimeline: feed, manualTimelines: [query], updatedAtMs: NOW - 3_600_000,
    accountRecord: { waybill: WAYBILL, companyCode: "JD", provider: sourceProvider, phone: PHONE, stateNumber: 5 },
  } as Shipment;
}

test("a JD row whose status is ahead of its headline keeps the headline and is still forced", async () => {
  memory.clear();
  setDiagnosticsEnabled(true);
  const row = jdRow();
  const listed = selectShipmentTimeline(row);
  assert.equal(listed.semantic, "DELIVERY");
  assert.equal(listed.statusEventAtMs, at(STATUS_AT));
  assert.equal(listed.latestTimeText, FEED_NEWEST, "the headline stays under the JD rules, not swapped");
  assert.equal(listed.latestDetail, "您的快件已到达【测试站】");
  assert.equal(statusPackageHeadlineShown(row), false);
  const times = statusAlignmentTimes(row)!;
  assert.deepEqual([times.statusAtMs, times.headlineAtMs], [at(STATUS_AT), at(FEED_NEWEST)]);
  assert.equal(statusAlignmentOutOfStep(times), true);
  assert.equal(statusAlignmentReason(times), "status_ahead");

  // Stored and retained by the time the list shows (「按列表实际显示的时间」): the unswapped headline.
  const stored = saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 },
  ] }, NOW).shipments[0]!;
  assert.equal(stored.timeline.latestTimeText, FEED_NEWEST);

  // The status alignment run still forces it once.
  const records: Record<string, string> = {};
  const store: StatusAlignmentRecordStore = {
    load: () => ({ ...records }),
    save: (next) => { for (const key of Object.keys(records)) delete records[key]; Object.assign(records, next); },
  };
  const state: AppState = { ...emptyState(), shipments: [stored] };
  const forced: string[] = [];
  const result = await runStatusAlignmentPass({}, {
    appHost: () => true, busy: () => false, load: () => state, records: store, now: () => NOW,
    refresh: async (id, beforeQuery) => { beforeQuery(); forced.push(id); return { state }; },
  });
  assert.equal(result.result, "attempted");
  assert.deepEqual(forced, [stored.identity.id]);
});

test("a JD row's retention reads the headline the list shows", () => {
  const signed = jdRow();
  const completed: TimelinePackage = { ...signed.sourceTimeline!, semantic: "COMPLETED" };
  const query: TimelinePackage = { ...signed.manualTimelines![0]!, semantic: "COMPLETED",
    tracks: [node(STATUS_AT, "您的快件已签收"), ...signed.manualTimelines![0]!.tracks.slice(1)],
    latestDetail: "您的快件已签收" };
  const row = { ...signed, timeline: completed, sourceTimeline: completed, manualTimelines: [query] };
  const stored = saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 },
  ] }, NOW).shipments[0]!;
  const shown = selectShipmentTimeline(stored);
  assert.equal(stored.timeline.latestTimeText, shown.latestTimeText, "storage keeps what the list shows");
  assert.equal(signedRetentionAtMs(stored, NOW), at(shown.latestTimeText), "retention counts from that time");
});

test("a non-JD source with the same packages still gets the status package's headline", () => {
  const row = jdRow("DouYin");
  const listed = selectShipmentTimeline(row);
  assert.equal(statusPackageHeadlineShown(row), true, "the swap is unchanged outside JD business sources");
  assert.equal(listed.latestTimeText, STATUS_AT);
  assert.equal(listed.latestDetail, "您的快件正在派送中，请您准备签收");
});
