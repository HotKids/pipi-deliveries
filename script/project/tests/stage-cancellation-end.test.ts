import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { Shipment, TimelinePackage } from "../models";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment, applySameSourceTimeline } from "../services/shipment-policy";
import { commitRefreshState, emptyState, saveState } from "../services/storage";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { runShipmentEnrichmentForTesting, runShipmentRefreshForTesting } from "../services/sync";

// 用户 2026-09-28（「7 条都按说的修」第 6 条）：父刷新被取消时，已经记了开始的那一阶段照样记结束——
// 它自己的失败事件，errorCategory=cancelled——然后取消照旧往外抛。原来 rethrowRefreshCancellation 直接抛出，
// 这一阶段在日志里只有开始没有结束。Identities and node texts are synthetic.
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const cancelled = (error: unknown) => error instanceof Error && error.name === "OperationTimeoutError";

function stageEnds(event: string) {
  return readDiagnostics().filter(entry => entry.event === event).map(entry => entry.details);
}

function assertOneCancelledEnd(event: string, stage: string) {
  const ends = stageEnds(event).filter(details => details.stage === stage);
  assert.equal(ends.length, 1, `${event} ${stage}: ${JSON.stringify(readDiagnostics().map(e => [e.event, e.details.stage]))}`);
  assert.equal(ends[0].errorCategory, "cancelled");
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

test("a detail entry query cut off by the parent refresh ends its stage as cancelled", async () => {
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
      queryManualForSource: async () => ({ result: "empty_response" as const, shipment: null, pending: null, routeUrl: "" }),
    }), cancelled);
  assertOneCancelledEnd("detail.refresh.stage_failed", "v5_query");
});

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
function lateCainiaoPage(): TimelinePackage {
  const tracks = nodes(LIST_AT - 65 * 60_000, 4, true, "cn");
  return { provider: "cn_h5", waybill: CN_WAYBILL, courierCode: "YTO", companyName: "圆通速递",
    semantic: "UNKNOWN", structuredStatus: false, complete: false, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: NOW };
}
const emptyManual = async () => ({ result: "empty_response" as const, shipment: null, pending: null, routeUrl: "" });
const pull = { trigger: "detail_pull" as const, forceManualRefresh: true, includeKdniaoFallback: true };

test("a Cainiao page cut off by the parent refresh ends its stage as cancelled", async () => {
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
  assertOneCancelledEnd("detail.refresh.stage_failed", "cn_h5");
});

test("a primary H5 page cut off by the parent refresh ends its stage as cancelled", async () => {
  const row = cainiaoRow();
  const controller = new AbortController();
  await assert.rejects(runShipmentRefreshForTesting(row.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30000, signal: controller.signal }, pull, {
      refreshAccountParcel: async () => { throw new Error("a pull does not query v5 here"); },
      refreshCainiaoH5: async (shipment: Shipment) => applySameSourceTimeline(shipment, lateCainiaoPage(), NOW),
      refreshWebTimeline: async () => {
        controller.abort();
        return null;
      },
      queryManualForSource: emptyManual,
    }), cancelled);
  assertOneCancelledEnd("detail.refresh.stage_failed", "k100_h5");
  assert.equal(stageEnds("detail.refresh.stage_succeeded").filter(d => d.stage === "cn_h5").length, 1,
    "the finished Cainiao stage keeps its own end");
});

// ---- list refresh stages ----
const SF_WAYBILL = "SF9990000000004", SF_PHONE = "13800009994";
function jdListRow(): Shipment {
  const tracks = Array.from({ length: 3 }, (_, index) => ({ timeMs: NOW - 60_000 - index * 1000,
    timeText: "2026-09-08 13:59:00", detail: index ? "已揽收" : "Parcel event", statusCode: "", raw: {} }));
  const timeline: TimelinePackage = { provider: "interface5", waybill: SF_WAYBILL, courierCode: "SF",
    companyName: "Carrier", semantic: "UNKNOWN", structuredStatus: false, statusEventAtMs: null,
    latestDetail: "Source headline without a date", latestTimeText: "", successAtMs: NOW - 60_000,
    complete: true, tracks };
  return { identity: { id: `interface5:account:${SF_WAYBILL}`, sourceId: SF_WAYBILL,
    sourceOwner: "interface5:parcel", sourceProvider: "JingDong", bindingSource: "interface5", phone: SF_PHONE,
    phoneTail: "9994", manuallyAdded: false, courierCode: "SF", rawCourierCode: "SF", companyName: "Carrier",
    createdAtMs: NOW - 86_400_000 }, timeline, sourceTimeline: timeline, manualTimelines: [],
    accountRecord: null, updatedAtMs: NOW - 60_000 };
}

test("a list manual refresh cut off by the parent refresh ends its stage as cancelled", async () => {
  memory.clear();
  setDiagnosticsEnabled(true);
  let current = saveState({ ...emptyState(), shipments: [jdListRow()], bindings: [
    { source: "interface5", phone: SF_PHONE, boundAtMs: NOW - 86_400_000 },
  ] }, NOW);
  const controller = new AbortController();
  let queried = 0;
  await assert.rejects(runShipmentEnrichmentForTesting(current, "interface5", "cancelled-list-stage",
    (candidate, _routes, _stage, base) => current = commitRefreshState(base || current, candidate, "interface5", NOW).state,
    NOW + 60_000, new Set(), false, false, controller.signal, {
      refreshAccountParcel: async () => { throw new Error("this row has no native detail record"); },
      queryManualForSource: async () => {
        queried++;
        controller.abort();
        throw new Error("Synthetic request cut off");
      },
    }), cancelled);
  assert.equal(queried, 1);
  const ends = stageEnds("refresh.stage.failed");
  assert.equal(ends.length, 1, JSON.stringify(readDiagnostics().map(e => [e.event, e.details.stage])));
  assert.equal(ends[0].errorCategory, "cancelled");
});

const HOME_WAYBILL = "YT9990000000005", HOME_PHONE = "13800009995";
function cainiaoHomeRow(): Shipment {
  const timeline: TimelinePackage = { provider: "v5_list", waybill: HOME_WAYBILL, courierCode: "YTO",
    companyName: "Carrier", semantic: "TRANSIT", structuredStatus: true, statusEventAtMs: NOW - 60000,
    latestDetail: "Earlier carrier event", latestTimeText: String(NOW - 60000), successAtMs: NOW,
    tracks: [{ timeMs: NOW - 60000, timeText: String(NOW - 60000), detail: "Earlier carrier event",
      statusCode: "", raw: {} }] };
  return { identity: { id: `interface5:account:${HOME_WAYBILL}`, sourceId: HOME_WAYBILL,
    bindingSource: "interface5", sourceProvider: "CaiNiao", sourceOwner: "interface5:parcel",
    manuallyAdded: false, courierCode: "YTO", rawCourierCode: "YTO", companyName: "Carrier",
    phone: HOME_PHONE, phoneTail: "9995", createdAtMs: NOW - 86400000 },
    timeline, sourceTimeline: timeline, manualTimelines: [], updatedAtMs: NOW - 60000,
    accountRecord: { waybill: HOME_WAYBILL, provider: "CaiNiao", companyCode: "YTO", phone: HOME_PHONE } };
}

test("a Home account query cut off by the parent refresh ends its stage as cancelled", async () => {
  memory.clear();
  setDiagnosticsEnabled(true);
  const initial = saveState({ ...emptyState(), shipments: [cainiaoHomeRow()],
    bindings: [{ source: "interface5", phone: HOME_PHONE, boundAtMs: NOW - 86400000 }] }, NOW);
  const controller = new AbortController();
  await assert.rejects(runShipmentEnrichmentForTesting(initial, "interface5", "cancelled-home-stage",
    (candidate, _routes, _stage, base) => commitRefreshState(base || initial, candidate, "interface5", NOW).state,
    NOW + 30000, new Set(), true, false, controller.signal, {
      refreshAccountParcel: async () => {
        controller.abort();
        throw new Error("Synthetic request cut off");
      },
      queryManualForSource: async () => { throw new Error("source-only Home work stops at the account query"); },
    }, true, new Set(initial.shipments.map(value => value.identity.id))), cancelled);
  const ends = stageEnds("refresh.stage.failed");
  assert.equal(ends.length, 1, JSON.stringify(readDiagnostics().map(e => [e.event, e.details.stage])));
  assert.equal(ends[0].stage, "v5_query");
  assert.equal(ends[0].errorCategory, "cancelled");
});
