import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { Shipment, TimelinePackage } from "../models";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment } from "../services/shipment-policy";
import { emptyState, saveState } from "../services/storage";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { runShipmentRefreshForTesting } from "../services/sync";
import { queryManualForSource } from "../services/manual-query";

// 用户 2026-09-28（日志类直接按建议修）：父刷新被取消时，已经记了 detail.refresh.started 的详情刷新以
// detail.refresh.skipped skipReason=interrupted 收尾（Lite / Pipi 的中断收尾），手动链里已经开始的一级
// （快递鸟 fallback 等）以 manual.source.failed errorCategory=cancelled 收尾。Identities are synthetic.
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const cancelled = (error: unknown) => error instanceof Error && error.name === "OperationTimeoutError";

function stageEnds(event: string) {
  return readDiagnostics().filter(entry => entry.event === event).map(entry => entry.details);
}

// ---- detail refresh: the v5 per-waybill query that detail entry runs ----
const ORDER = "3999999000000002", JD_WAYBILL = "JD9990000000002", JD_PHONE = "13800009992";
function jdParcel(): AccountParcelDto {
  const tracks = Array.from({ length: 6 }, (_, i) => ({
    timeText: providerTime(NOW - 3600000 - i * 60000), detail: `Synthetic account event ${i}`, statusCode: "",
  }));
  return {
    source: "interface5", ownerId: ORDER, orderId: ORDER, accountOrder: true, waybill: JD_WAYBILL,
    courierCode: "JD", rawCourierCode: "JD", companyName: "Synthetic carrier", sourceProvider: "JingDong",
    sourceStateCode: "105", sourceStateText: "DELIVERY", semantic: "DELIVERY", normalizedStatusScope: "SHIPMENT",
    normalizedStatusSemantic: "DELIVERY", normalizedStatusText: "DELIVERY", receiverPhone: JD_PHONE, senderPhone: "",
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks, routeUrl: "",
    projectionUrl: "https://u.jd.com/forward?test=cancelled-stage",
  };
}


// ---- detail refresh: the Cainiao page and the primary H5 page ----
const LIST_AT = NOW - 20 * 60_000;
const CN_WAYBILL = "YT9990000000003", CN_PHONE = "13800009993";
function nodes(newestAt: number, count: number, pickup: boolean, label: string) {
  return Array.from({ length: count }, (_, i) => ({
    timeMs: newestAt - i * 30 * 60_000, timeText: providerTime(newestAt - i * 30 * 60_000),
    detail: pickup && i === count - 1 ? "快件已揽收" : `Synthetic ${label} transit ${count - i}`,
    statusCode: "", raw: {},
  }));
}
function cainiaoRow(): Shipment {
  memory.clear();
  setDiagnosticsEnabled(true);
  const tracks = nodes(LIST_AT, 2, false, "list").map((track) => ({ ...track, statusCode: "104",
    raw: { statusCode: "104", _pipiStatusSource: "interface5" } }));
  const feed: TimelinePackage = {
    provider: "interface5", waybill: CN_WAYBILL, courierCode: "YTO", companyName: "圆通速递",
    semantic: "TRANSIT", structuredStatus: true, statusEventAtMs: LIST_AT, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: NOW,
  };
  const row: Shipment = applyAccountShipment(undefined, {
    identity: { id: `interface5:account:${CN_WAYBILL}`, bindingSource: "interface5", sourceOwner: "interface5",
      sourceId: CN_WAYBILL, sourceProvider: "CaiNiao", courierCode: "YTO", rawCourierCode: "YTO",
      companyName: "圆通速递", phone: CN_PHONE, phoneTail: "9993", manuallyAdded: false, createdAtMs: NOW },
    timeline: feed, sourceTimeline: feed, manualTimelines: [], route: { kind: "cainiao", source: "interface5" },
    accountRecord: null, updatedAtMs: NOW,
  }, NOW);
  return saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: CN_PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW).shipments[0];
}
const emptyManual = async () => ({ result: "empty_response" as const, shipment: null, pending: null, routeUrl: "" });
const pull = { trigger: "detail_pull" as const, forceManualRefresh: true, includeKdniaoFallback: true };




test("a detail refresh cut off by the parent refresh ends as interrupted", async () => {
  const row = cainiaoRow();
  const controller = new AbortController();
  await assert.rejects(runShipmentRefreshForTesting(row.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30000, signal: controller.signal }, pull, {
      refreshAccountParcel: async () => { throw new Error("a pull does not query v5 here"); },
      refreshCainiaoH5: async () => {
        controller.abort();
        throw new Error("Synthetic page cut off");
      },
      refreshWebTimeline: async () => null,
      queryManualForSource: emptyManual,
    }), cancelled);
  const started = readDiagnostics().filter(entry => entry.event === "detail.refresh.started");
  const ends = readDiagnostics().filter(entry => entry.event === "detail.refresh.skipped" ||
    entry.event === "detail.refresh.failed" || entry.event === "detail.refresh.committed");
  assert.equal(started.length, 1);
  assert.equal(ends.length, 1, JSON.stringify(readDiagnostics().map(e => [e.event, e.details.skipReason])));
  assert.equal(ends[0].event, "detail.refresh.skipped");
  assert.equal(ends[0].details.skipReason, "interrupted");
  assert.equal(ends[0].details.result, "interrupted");
  assert.equal(ends[0].details.flowId, started[0].details.flowId);
});

test("a detail entry query cancelled before the flow starts ends no flow", async () => {
  memory.clear();
  setDiagnosticsEnabled(true);
  const row = parcelToShipment(jdParcel(), [JD_PHONE], NOW)!;
  saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: JD_PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  const controller = new AbortController();
  await assert.rejects(runShipmentRefreshForTesting(row.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30000, signal: controller.signal }, { trigger: "detail_open" }, {
      refreshAccountParcel: async () => {
        controller.abort();
        throw new Error("Synthetic request cut off");
      },
      projectAccountOrderWithCarrier: async () => { throw new Error("no page in this test"); },
      refreshWebTimeline: async () => null,
      queryManualForSource: emptyManual,
    }), cancelled);
  assert.equal(stageEnds("detail.refresh.started").length, 0);
  assert.equal(stageEnds("detail.refresh.skipped").length, 0, "no flow was started, so none ends");
});

test("a KDNiao fallback cut off by the parent refresh ends its source as cancelled", async () => {
  memory.clear();
  setDiagnosticsEnabled(true);
  const controller = new AbortController();
  let posted = 0;
  await assert.rejects(queryManualForSource({
    source: "interface5", bindings: [{ source: "interface5", phone: CN_PHONE, boundAtMs: NOW - 86400000 }],
    waybill: CN_WAYBILL, rawCourierCode: "YTO", courierCode: "YTO", companyName: "圆通速递",
    sourceProvider: "CaiNiao", includeKdniaoFallback: true, fallbackOnly: true, signal: controller.signal,
    deadlineAtMs: NOW + 30000, diagnosticFlowId: "detail-kdniao-cancelled", diagnosticStage: "kdniao_fallback",
    dependencies: { now: () => NOW, post: async () => {
      posted++;
      controller.abort();
      throw new Error("Synthetic request cut off");
    } },
  }), cancelled);
  assert.equal(posted, 1);
  const started = stageEnds("manual.source.started");
  const failed = stageEnds("manual.source.failed");
  assert.equal(started.length, 1);
  assert.equal(failed.length, 1, JSON.stringify(readDiagnostics().map(e => [e.event, e.details.stage])));
  assert.equal(failed[0].stage, started[0].stage);
  assert.equal(failed[0].errorCategory, "cancelled");
  assert.equal(failed[0].flowId, "detail-kdniao-cancelled");
});
