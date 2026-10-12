import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import { parseProviderTime } from "../services/status";
import { rowLedgerKey, saveAlignmentRecords } from "../services/row-ledger";
import {
  selectShipmentTimeline,
  shipmentSelectionEvidence,
  signedTripleReached,
  statusAlignmentReason,
  statusAlignmentTimes,
} from "../services/shipment-policy";

// D-23（用户 2026-10-02「修」）：顺丰来源的自动件，选中的 Picker / K100 手动包只有文案推出的状态（structuredStatus 不为真）
// 时，列表状态按 AGENTS §9「状态看结构化，不看文案」（2026-09-05）取同一运单各包里最新的结构化状态，与 Pipi
// applyStructuredStatus、Lite selectStructuredStatus 同口径；哪个包都没有结构化状态时才用文案。带结构化状态的手动包照旧
// 保留自己的状态。合成数据（no real parcel data）：运单号、手机号都是编的。

const WAYBILL = "SF0000000009201";
const PHONE = "13800009201";
const at = (text: string) => parseProviderTime(text)!;
const SIGNED_AT = "2026-09-08 13:31:00";
const HISTORY: [string, string][] = [["2026-09-08 11:41:00", "快件到达【测试驿站】"],
  ["2026-09-07 10:00:00", "顺丰速运 已收取快件"]];

const actualNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = actualNow; });

function node(timeText: string, detail: string, raw: TrackNode["raw"] = {}): TrackNode {
  return { timeText, timeMs: at(timeText), detail, statusCode: "", raw };
}

function feed(statusAtText: string, semantic: TimelinePackage["semantic"], structuredStatus = true): TimelinePackage {
  const tracks = [node(statusAtText, semantic === "COMPLETED" ? "快递已完成签收" : "快件派送中")];
  return { provider: "interface5", waybill: WAYBILL, courierCode: "SF", companyName: "顺丰速运",
    semantic, structuredStatus, statusEventAtMs: at(statusAtText), complete: false,
    latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail, successAtMs: NOW - 3_600_000, tracks };
}

/** A K100 page package: its newest node `newest`; its status from the text unless `structuredAt` is given. */
function k100(newest: [string, string], semantic: TimelinePackage["semantic"], structuredAt?: string): TimelinePackage {
  const tracks = [newest, ...HISTORY].map(([timeText, detail]) => node(timeText, detail, { _pipiStatusSource: "web" }));
  return { provider: "k100_h5", waybill: WAYBILL, courierCode: "SF", companyName: "顺丰速运",
    semantic, structuredStatus: structuredAt != null, statusEventAtMs: at(structuredAt ?? newest[0]), complete: true,
    latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail, successAtMs: NOW - 3_600_000, tracks };
}

function sfRow(source: TimelinePackage, manual: TimelinePackage): Shipment {
  return { identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL, bindingSource: "interface5",
    sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng", courierCode: "SF", rawCourierCode: "SF",
    companyName: "顺丰速运", phone: PHONE, phoneTail: "9201", manuallyAdded: false, createdAtMs: NOW - 86_400_000 },
    timeline: manual, sourceTimeline: source, manualTimelines: [manual], updatedAtMs: NOW - 3_600_000,
    accountRecord: { waybill: WAYBILL, companyCode: "SF", provider: "ShunFeng", phone: PHONE, stateNumber: 3 },
  } as Shipment;
}

test("a prose-only K100 status gives way to the feed's structured signing", () => {
  const row = sfRow(feed(SIGNED_AT, "COMPLETED"), k100(["2026-09-08 13:29:00", "快件派送中"], "DELIVERY"));
  const listed = selectShipmentTimeline(row);
  assert.equal(listed.semantic, "COMPLETED", "not the 派送中 the K100 text implies");
  assert.equal(listed.structuredStatus, true);
  assert.equal(listed.statusEventAtMs, at(SIGNED_AT), "the feed's own time");
  assert.equal(listed.provider, "k100_h5", "the history and headline stay the K100 package's");
  assert.equal(listed.latestDetail, "快件派送中");
  assert.equal(shipmentSelectionEvidence(row).statusProvider, "interface5");
  // The status alignment and the signed triple read the same structured status (H and D two minutes before T).
  assert.deepEqual(statusAlignmentTimes(row), { statusAtMs: at(SIGNED_AT), headlineAtMs: at("2026-09-08 13:29:00"),
    detailAtMs: at("2026-09-08 13:29:00"), statusSemantic: "COMPLETED" });
  assert.equal(signedTripleReached(row, NOW), true);
});

test("a prose-only K100 status uses a coarse signed headline only after the first forced attempt finishes", () => {
  memory.clear();
  const row = sfRow(feed(SIGNED_AT, "COMPLETED"), k100(["2026-09-08 11:50:00", "快件派送中"], "DELIVERY"));
  const originalTracks = structuredClone(row.timeline.tracks);
  const before = selectShipmentTimeline(row);
  assert.equal(before.semantic, "COMPLETED");
  assert.equal(before.statusEventAtMs, at(SIGNED_AT));
  assert.equal(before.latestDetail, "快件派送中", "the detailed headline stays during the first forced attempt");
  assert.equal(before.latestTimeText, "2026-09-08 11:50:00");
  assert.deepEqual(before.tracks, originalTracks);
  const times = statusAlignmentTimes(row)!;
  assert.deepEqual(times, { statusAtMs: at(SIGNED_AT), headlineAtMs: at("2026-09-08 11:50:00"),
    detailAtMs: at("2026-09-08 11:50:00"), statusSemantic: "COMPLETED", needsNonCoarse: true });
  assert.equal(statusAlignmentReason(times), "status_ahead");
  assert.equal(signedTripleReached(row, NOW), false);
  saveAlignmentRecords({ [rowLedgerKey(row.identity.id)]: JSON.stringify({
    times: `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`,
    attempts: 1, lastAttemptAtMs: NOW, complete: false, finished: true,
  }) });
  try {
    const listed = selectShipmentTimeline(row);
    assert.equal(listed.semantic, "COMPLETED");
    assert.equal(listed.statusEventAtMs, at(SIGNED_AT));
    assert.equal(listed.latestDetail, "快递已完成签收", "the completed first attempt permits the final coarse same-state fallback");
    assert.equal(listed.latestTimeText, SIGNED_AT);
    assert.equal(statusAlignmentReason(statusAlignmentTimes(row)!), "status_ahead");
    assert.equal(signedTripleReached(row, NOW), false, "the headline before the swap and the detail are behind");
    assert.deepEqual(listed.tracks, originalTracks, "the fallback headline never replaces detailed history");
    assert.deepEqual(statusAlignmentTimes(row), times, "the finished attempt still belongs to the original tuple");
  } finally {
    memory.clear();
  }
});

test("a K100 package with a structured status keeps its own", () => {
  const row = sfRow(feed(SIGNED_AT, "COMPLETED"),
    k100(["2026-09-08 13:29:00", "快件派送中"], "DELIVERY", "2026-09-08 13:29:00"));
  const listed = selectShipmentTimeline(row);
  assert.equal(listed.semantic, "DELIVERY");
  assert.equal(listed.structuredStatus, true);
  assert.equal(listed.statusEventAtMs, at("2026-09-08 13:29:00"));
});

test("without a structured status anywhere the text stays the fallback", () => {
  const row = sfRow(feed(SIGNED_AT, "COMPLETED", false), k100(["2026-09-08 13:29:00", "快件派送中"], "DELIVERY"));
  const listed = selectShipmentTimeline(row);
  assert.equal(listed.semantic, "DELIVERY");
  assert.equal(listed.structuredStatus, false);
  assert.equal(statusAlignmentTimes(row), null);
  assert.equal(signedTripleReached(row, NOW), false);
});
