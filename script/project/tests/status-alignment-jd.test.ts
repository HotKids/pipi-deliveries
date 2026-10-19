import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { Shipment, StatusSemantic, TimelinePackage } from "../models";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, loadState, saveState } from "../services/storage";
import { saveOrderProjectionReferences } from "../services/routes";
import { runShipmentRefreshForTesting, runProjectionAwareShipmentRefreshForTesting } from "../services/sync";
import { accountOrderProjectionRouteHash } from "../services/account-sync-policy";
import {
  jingDongSignedHistoryGap,
  selectShipmentTimeline,
  statusAlignmentOutOfStep,
  statusAlignmentTimes,
} from "../services/shipment-policy";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";

// 用户 2026-10-02 弹窗「同取件码强刷（推荐）」：越过签收冻结、完整缓存 / 详情已完整闸、owner 自身揽收闸与普通冷却；
// 不越过风控冷却、京东联合页按订单冷却（10/60 分钟，§9 规定用户主动操作也不解除）、付费快递鸟的触发条件与冷却。
// 京东件在 iOS 的链：打开详情的按件详情（v5_query），下拉的京粉页，京粉页没有完整包时的快递100 → 快递鸟。
// 合成数据：订单号、运单号、手机号都是编的。

const EVENT = 1789085861000, NOW = EVENT + 12 * 3600000;
const ORDER = "3610000000009002", WAYBILL = "JD000000009002", PHONE = "13800009002";
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

/** A signed JD parcel: the feed reached pickup three hours before its structured completion. */
function signedParcel(semantic: StatusSemantic = "COMPLETED"): AccountParcelDto {
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
    projectionUrl: "https://u.jd.com/forward?test=alignment",
    normalizedStatus: { version: 1, scope: "SHIPMENT", semantic, code: "107", text: semantic,
      priority: 0, eventAtMs: EVENT, structured: true },
  } as AccountParcelDto;
}

/** A union page package: complete, with pickup, newest node at `at`, captured at `capturedAt`. */
function unionPage(at: number, capturedAt: number): TimelinePackage {
  const tracks = Array.from({ length: 8 }, (_, i) => ({
    timeMs: at - i * 60000, timeText: providerTime(at - i * 60000),
    detail: i === 7 ? "已揽收" : `Synthetic H5 event ${i}`, statusCode: "",
    raw: { _pipiStatusSource: "jingdong_h5" },
  }));
  return { provider: "jd_h5", waybill: WAYBILL, courierCode: "JD", companyName: "Synthetic carrier",
    semantic: "UNKNOWN", structuredStatus: false, complete: true, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: capturedAt };
}

function seed(): Shipment {
  memory.clear();
  // The union page was last captured after the completion, three hours behind it: the 2026-09-24 signed gap no
  // longer opens it, and the feed's own pickup closes every other pull gate.
  const row = parcelToShipment({ ...signedParcel(), projectionTimeline: unionPage(EVENT - 3 * 3600000, EVENT + 60000) },
    [PHONE], NOW)!;
  const state = saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  saveOrderProjectionReferences([{ ownerId: row.identity.id, source: "interface5",
    url: signedParcel().projectionUrl! }], NOW);
  setDiagnosticsEnabled(true);
  return state.shipments[0]!;
}

const lease = { isCurrent: () => true, deadlineAtMs: NOW + 30000 };
const options = (trigger: "detail_pull" | "status_alignment") => ({
  trigger, forceManualRefresh: true, includeKdniaoFallback: true, forceAccountOrderProjection: true,
});
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

function runtime(calls: string[], page: TimelinePackage | null) {
  return {
    refreshAccountParcel: async (): Promise<AccountParcelDto | null> => {
      calls.push("v5_query");
      return signedParcel();
    },
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => {
      calls.push("jd_h5");
      return { ...input, waybill: WAYBILL, projectionTimeline: page };
    },
    refreshWebTimeline: async () => { calls.push("k100_h5"); return null; },
    queryManualForSource: async (input: { fallbackOnly?: boolean }) => {
      calls.push(input.fallbackOnly ? "kdniao" : "v6_query");
      return { shipment: null, pending: null, routeUrl: "" };
    },
  };
}

test("a signed JD row out of step: the pull is closed, the alignment run reopens its own chain once", async () => {
  const row = seed();
  assert.equal(jingDongSignedHistoryGap(row), false, "the signed gap was already used");
  const times = statusAlignmentTimes(row)!;
  assert.ok(times && statusAlignmentOutOfStep(times), "status 3 h after the headline and the detail");

  const pulled: string[] = [];
  await runShipmentRefreshForTesting(row.identity.id, lease, options("detail_pull"), runtime(pulled, null));
  assert.deepEqual(pulled, [], "a pull stops at the feed's own pickup");

  seed();
  const aligned: string[] = [];
  const fresh = unionPage(EVENT - 2000, NOW);
  await runShipmentRefreshForTesting(row.identity.id, lease, options("status_alignment"), runtime(aligned, fresh));
  assert.deepEqual(aligned, ["v5_query", "jd_h5"],
    "the per-waybill query past the freeze, then the union page past the pickup gate; a complete page stops the chain");
  const started = readDiagnostics().find(entry => entry.event === "detail.refresh.started")!;
  assert.equal(started.details.trigger, "status_alignment");
  const persisted = loadState(NOW).shipments[0]!;
  assert.equal(selectShipmentTimeline(persisted).latestDetail, "Synthetic H5 event 0",
    "the signed-headline exception (2026-09-24) takes the union page's newest node; status unchanged");
  assert.equal(selectShipmentTimeline(persisted).semantic, "COMPLETED");
  assert.equal(statusAlignmentOutOfStep(statusAlignmentTimes(persisted)!), false);
});

test("the alignment run keeps the union page's per-order cooldown and the paid fallback's own condition", async () => {
  const row = seed();
  const first: string[] = [];
  await runShipmentRefreshForTesting(row.identity.id, lease, options("status_alignment"),
    runtime(first, unionPage(EVENT - 3 * 3600000 + 60000, NOW)));
  assert.deepEqual(first, ["v5_query", "jd_h5", "k100_h5"],
    "an incomplete page passes to the free level once; the feed's own pickup keeps the paid fallback closed");
  // Run again within ten minutes (another set of times): the order still rests, so no page loads. The cached page
  // does not stop the run, so the next level is asked once; pickup already reached keeps the paid fallback closed.
  const second: string[] = [];
  await runShipmentRefreshForTesting(row.identity.id, lease, options("status_alignment"),
    runtime(second, unionPage(EVENT - 2000, NOW)));
  assert.equal(second.includes("jd_h5"), false, "the per-order union page cooldown still applies");
  assert.ok(readDiagnostics().some(entry => entry.event === "order.projection.skipped" &&
    entry.details.result === "cooldown"));
  assert.deepEqual(second, ["v5_query", "k100_h5"]);
  assert.equal(second.includes("kdniao"), false, "KDNiao keeps its trigger condition");
  assert.equal(second.includes("v6_query"), false, "a pull, the alignment run included, does not ask Online");
});


test("a pull joins the full JD alignment past the capture reservation window", async () => {
  const row = seed();
  let clock = NOW;
  Date.now = () => clock;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const webEntered = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  const providers = { ...runtime(calls, null), refreshWebTimeline: async () => {
    calls.push("k100_h5"); entered(); await gate; return null;
  } };
  const forced = runProjectionAwareShipmentRefreshForTesting(row.identity.id,
    { ...options("status_alignment"), deadlineAtMs: NOW + 30000 }, providers);
  await webEntered;
  let pullEnded = false;
  const pulled = runProjectionAwareShipmentRefreshForTesting(row.identity.id,
    { ...options("detail_pull"), deadlineAtMs: NOW + 30000 }, providers)
    .then(result => { pullEnded = true; return result; });
  try {
    clock += 22101;
    await new Promise(resolve => setTimeout(resolve, 150));
    const endedBeforeAlignment = pullEnded;
    release();
    const [alignment, result] = await Promise.all([forced, pulled]);
    assert.equal(endedBeforeAlignment, false, "the active alignment still owns the pull's complete result");
    assert.equal(result.querySucceeded, alignment.querySucceeded);
    assert.equal(result.refreshed, alignment.refreshed);
    assert.deepEqual(calls, ["v5_query", "jd_h5", "k100_h5"]);
  } finally { release(); await Promise.allSettled([forced, pulled]); Date.now = () => NOW; }
});

test("an orphan JD reservation gates the page without swallowing the pull's remaining providers", async () => {
  memory.clear();
  const parcel = signedParcel("TRANSIT");
  parcel.tracks = parcel.tracks.filter(track => track.detail !== "已揽收");
  const row = parcelToShipment(parcel, [PHONE], NOW)!;
  row.identity.jingDongH5Retry = {
    routeHash: accountOrderProjectionRouteHash(row.identity.id), failedAtMs: NOW,
    attemptId: "synthetic-orphan", attemptExpiresAtMs: NOW + 2000,
  };
  saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  saveOrderProjectionReferences([{ ownerId: row.identity.id, source: "interface5", url: parcel.projectionUrl }], NOW);
  let clock = NOW;
  Date.now = () => clock;
  const calls: string[] = [];
  const pull = runProjectionAwareShipmentRefreshForTesting(row.identity.id,
    { ...options("detail_pull"), deadlineAtMs: NOW + 30000 }, runtime(calls, null));
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    const dispatchedBeforeExpiry = calls.includes("k100_h5");
    clock += 2001;
    await pull;
    assert.equal(dispatchedBeforeExpiry, true, "a reservation is a page fence, not a promise to join");
    assert.equal(calls.includes("jd_h5"), false, "the active durable reservation still protects the page");
  } finally { clock += 30000; await pull; Date.now = () => NOW; }
});
