import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import { parcelToShipment } from "../services/account-sync";
import type { AccountParcelDto } from "../services/account-parser";
import { addBinding, emptyState, forceCompleteShipment, loadState, removeBinding, removeShipment,
  saveState } from "../services/storage";
import { parseProviderTime } from "../services/status";
import { FORCED_COMPLETION_REFRESH_WINDOW_MS, selectShipmentDetailTimeline, selectShipmentTimeline,
  shipmentDetailIncompleteReason, signedRefreshFrozen, statusAlignmentTimes } from "../services/shipment-policy";
import { runShipmentRefreshForTesting, runTargetedShipmentRefreshForTesting } from "../services/sync";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { recordSignedRelease, signedReleaseUsed } from "../services/row-ledger";
import { OperationTimeoutError } from "../services/deadline";

// Synthetic protocol packets; the user limited complete-history repair to an explicit detail operation.
const WAYBILL = "SF900000001009";
const PHONE = "13800001009";
const SIGNED_AT = parseProviderTime("2026-09-08 13:31:00")!;
const realNow = Date.now;
let now = NOW;
const time = (at: number) => new Date(at + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
beforeEach(() => { now = NOW; Date.now = () => now; memory.clear(); setDiagnosticsEnabled(true); });
afterEach(() => { Date.now = realNow; });

function track(at: number, detail: string, semantic: "COMPLETED" | "DELIVERY" | "PICKED"): TrackNode {
  return { timeText: time(at), timeMs: at, detail, statusCode: semantic,
    raw: { normalizedStatus: { version: 1, scope: "SHIPMENT", semantic, code: semantic,
      text: semantic, priority: 0, eventAtMs: at, structured: true } } };
}
const SIGNED = track(SIGNED_AT, "Synthetic signed parcel", "COMPLETED");
const PICKED = track(SIGNED_AT - 86_400_000, "Synthetic pickup", "PICKED");

function packet(provider: string, tracks: TrackNode[], waybill = WAYBILL, courierCode = "SF"): TimelinePackage {
  return { provider, waybill, courierCode, companyName: "Synthetic carrier",
    semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: SIGNED_AT,
    complete: tracks.some(node => node.statusCode === "PICKED"), successAtMs: NOW - 3_600_000,
    latestTimeText: tracks[0]?.timeText || "", latestDetail: tracks[0]?.detail || "", tracks };
}

function seed(complete = false, sf = true, stale = false, moving = false): Shipment {
  const waybill = sf ? WAYBILL : "ZTO900000001009";
  const carrier = sf ? "SF" : "ZTO";
  const newest = moving ? track(SIGNED_AT, "Synthetic current delivery", "DELIVERY") : SIGNED;
  const source = { ...packet("interface5", [newest], waybill, carrier),
    semantic: moving ? "DELIVERY" as const : "COMPLETED" as const };
  const online = packet("v6_query", stale
    ? [track(SIGNED_AT - 10 * 60_000, "Synthetic older delivery", "DELIVERY")]
    : complete ? [newest, PICKED] : [newest], waybill, carrier);
  if (moving) online.semantic = "DELIVERY";
  const shipment: Shipment = { identity: { id: `interface5:account:${waybill}`, sourceId: waybill,
    bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceProvider: sf ? "ShunFeng" : "CaiNiao",
    courierCode: sf ? "SF" : "ZTO", rawCourierCode: sf ? "SF" : "ZTO", companyName: "Synthetic carrier",
    phone: PHONE, phoneTail: "1009", manuallyAdded: false, createdAtMs: NOW - 86_400_000 },
    timeline: source, sourceTimeline: source, manualTimelines: sf ? [online] : [],
    updatedAtMs: NOW - 3_600_000,
    accountRecord: { waybill, companyCode: carrier, provider: sf ? "ShunFeng" : "CaiNiao",
      phone: PHONE, stateNumber: 3 } } as Shipment;
  return saveState({ ...emptyState(), shipments: [shipment],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 }] }, now).shipments[0]!;
}

function runtime(calls: string[], fresh = true) {
  return {
    refreshAccountParcel: async () => { calls.push("v5_query"); return null; },
    refreshCainiaoH5: async () => { calls.push("cn_h5"); return null; },
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => { calls.push("jd_h5"); return input; },
    queryManualForSource: async (input: { fallbackOnly?: boolean; pickerOnly?: boolean }) => {
      calls.push(input.fallbackOnly ? "kdniao" : input.pickerOnly ? "v6_query" : "manual");
      return { shipment: null, pending: null, routeUrl: "" };
    },
    refreshWebTimeline: async (shipment: Shipment) => {
      calls.push("k100_h5");
      const detail = packet("k100_h5", [SIGNED, PICKED], shipment.identity.sourceId, shipment.identity.courierCode);
      return fresh ? { ...shipment, timeline: detail, sourceTimeline: null, manualTimelines: [detail] } : null;
    },
  };
}
const PULL = { trigger: "detail_pull" as const, forceManualRefresh: true, includeKdniaoFallback: true,
  forceAccountOrderProjection: true, deadlineAtMs: NOW + 30_000 };
const ALIGNMENT = { ...PULL, trigger: "status_alignment" as const };
const lease = () => ({ isCurrent: () => true, deadlineAtMs: now + 30_000 });

function signedOffPartial(): Shipment {
  const moving = seed(false, true, false, true);
  forceCompleteShipment(moving.identity.id, now);
  const state = loadState(now);
  const forced = state.shipments[0]!;
  assert.equal(forced.forcedCompletedAtMs, NOW, "the sign-off is performed while the source is still active");
  return saveState({ ...state, shipments: [{ ...forced,
    sourceTimeline: packet("interface5", [SIGNED]), manualTimelines: [packet("v6_query", [SIGNED])] }] }, now)
    .shipments[0]!;
}

test("a frozen single-node SF Online package is repaired only by the explicit pull", async () => {
  const row = seed();
  assert.equal(signedRefreshFrozen(row, now), true, "the shared list/background freeze is unchanged");
  assert.equal(shipmentDetailIncompleteReason(row), "missing_pickup");
  const originalTimes = statusAlignmentTimes(row, now);
  const calls: string[] = [];
  const result = await runShipmentRefreshForTesting(row.identity.id, lease(), PULL, runtime(calls));
  assert.deepEqual(calls, ["k100_h5"], "the existing pull repairs history without asking Online or paid fallback");
  assert.equal(result.refreshed, true);
  assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "k100_h5");
  assert.deepEqual(selectShipmentDetailTimeline(result.shipment).tracks, [SIGNED, PICKED]);
  assert.equal(shipmentDetailIncompleteReason(result.shipment), null);
  assert.equal(selectShipmentTimeline(result.shipment).semantic, "COMPLETED");
  assert.deepEqual(statusAlignmentTimes(result.shipment, now), originalTimes, "S/H/D alignment is preserved");
});

test("an ordinary frozen feed missing pickup can use its original explicit history chain", async () => {
  const row = seed(false, false);
  assert.equal(signedRefreshFrozen(row, now), true);
  assert.equal(shipmentDetailIncompleteReason(row), "missing_pickup");
  const calls: string[] = [];
  await runShipmentRefreshForTesting(row.identity.id, lease(), PULL, runtime(calls));
  assert.ok(calls.includes("cn_h5"), "the ordinary owner's original route is still attempted");
  assert.ok(calls.includes("k100_h5"), "its existing fallback repairs incomplete history");
  assert.equal(calls.includes("v6_query"), false, "a pull does not introduce an Online request");
});

test("complete Online history stays frozen on a pull", async () => {
  const row = seed(true);
  assert.equal(shipmentDetailIncompleteReason(row), null);
  const calls: string[] = [];
  const result = await runShipmentRefreshForTesting(row.identity.id, lease(), PULL, runtime(calls));
  assert.deepEqual(calls, []);
  assert.equal(result.refreshed, false);
});

for (const trigger of ["detail_open", "status_alignment", "missing_history"] as const) {
  test(`partial signed history stays frozen outside an explicit pull: ${trigger}`, async () => {
    const row = seed();
    const before = JSON.stringify(row);
    const calls: string[] = [];
    const result = await runShipmentRefreshForTesting(row.identity.id, lease(), { ...PULL, trigger }, runtime(calls));
    assert.deepEqual(calls, []);
    assert.equal(result.refreshed, false);
    assert.equal(JSON.stringify(result.shipment), before);
  });
}

test("a source-partial local sign-off permits detail repair before its independent 72-hour freeze", async () => {
  const forced = signedOffPartial();
  assert.equal(signedRefreshFrozen(forced, now), true);
  const calls: string[] = [];
  const result = await runShipmentRefreshForTesting(forced.identity.id, lease(), PULL, runtime(calls));
  assert.deepEqual(calls, ["k100_h5"]);
  assert.equal(result.shipment.forcedCompletedAtMs, NOW, "detail repair keeps the sign-off latch");
});

test("an explicit pull never bypasses the 72-hour local sign-off freeze", async () => {
  const row = signedOffPartial();
  now += FORCED_COMPLETION_REFRESH_WINDOW_MS;
  const calls: string[] = [];
  const result = await runShipmentRefreshForTesting(row.identity.id, lease(),
    { ...PULL, deadlineAtMs: now + 30_000 }, runtime(calls));
  assert.deepEqual(calls, []);
  assert.equal(result.refreshed, false);
  assert.equal(shipmentDetailIncompleteReason(result.shipment), "missing_pickup");
});

test("a pull joining a frozen alignment completes its distinct history operation after lease release", async () => {
  const row = seed();
  const forcedCalls: string[] = [];
  const pullCalls: string[] = [];
  const forced = runTargetedShipmentRefreshForTesting(row.identity.id, ALIGNMENT, runtime(forcedCalls));
  const pulled = runTargetedShipmentRefreshForTesting(row.identity.id, PULL, runtime(pullCalls));
  const [forcedResult, pullResult] = await Promise.all([forced, pulled]);
  assert.deepEqual(forcedCalls, [], "the shared frozen alignment performs no query");
  assert.deepEqual(pullCalls, ["k100_h5"], "the pull starts its own original history operation once");
  assert.equal(forcedResult.refreshed, false);
  assert.equal(pullResult.refreshed, true);
  assert.equal(shipmentDetailIncompleteReason(pullResult.shipment), null);
  assert.ok(readDiagnostics().some(entry => entry.details.skipReason === "coalesced_detail_refresh"),
    "the test traverses the actual durable-lease join");
});

for (const change of ["unbind", "rebind", "same-id replacement"] as const) {
  test(`a joined frozen alignment cannot start history repair after ${change}`, async () => {
    const row = seed();
    const forcedCalls: string[] = [];
    const pullCalls: string[] = [];
    const forced = runTargetedShipmentRefreshForTesting(row.identity.id, ALIGNMENT, runtime(forcedCalls));
    let settled = false;
    void forced.then(() => { settled = true; }, () => { settled = true; });
    const pulled = runTargetedShipmentRefreshForTesting(row.identity.id, PULL, runtime(pullCalls));
    assert.equal(settled, false, "the mutation occurs while the pull is waiting for the actual leased alignment");
    if (change === "same-id replacement") {
      const removed = removeShipment(row.identity.id, now);
      assert.equal(removed.shipments.some(item => item.identity.id === row.identity.id), false);
      saveState({ ...removed, shipments: [{ ...row,
        identity: { ...row.identity, createdAtMs: now + 1 }, updatedAtMs: now + 1 }] }, now + 1);
    } else {
      removeBinding("interface5", PHONE, now);
      if (change === "rebind") addBinding("interface5", PHONE, now + 1);
    }
    const changed = loadState(now).shipments.find(item => item.identity.id === row.identity.id)!;
    assert.equal(signedRefreshFrozen(changed, now), true);
    assert.notEqual(shipmentDetailIncompleteReason(changed), null, "the history gate alone would still permit a query");
    const expected = JSON.stringify(changed);
    const [forcedResult, pullResult] = await Promise.all([forced, pulled]);
    assert.equal(forcedResult.skipReason, "signed_frozen", "the joined owner performed no trajectory query");
    assert.deepEqual(forcedCalls, []);
    assert.deepEqual(pullCalls, [], "an old pull cannot query for a changed owner or binding generation");
    assert.equal(JSON.stringify(pullResult.shipment), expected);
    assert.equal(JSON.stringify(loadState(now).shipments.find(item => item.identity.id === row.identity.id)), expected);
    assert.ok(readDiagnostics().some(entry => entry.details.skipReason === "coalesced_detail_refresh"));
  });
}

test("a replacement queued between joined lease reacquisition and flow startup cannot be queried", async () => {
  const row = seed();
  const forcedCalls: string[] = [];
  const pullCalls: string[] = [];
  const forced = runTargetedShipmentRefreshForTesting(row.identity.id, ALIGNMENT, runtime(forcedCalls));
  const pulled = runTargetedShipmentRefreshForTesting(row.identity.id, PULL, runtime(pullCalls));
  let expected = "";
  const mutation = forced.then(() => Promise.resolve().then(() => {
    assert.ok(readDiagnostics().some(entry => entry.details.skipReason === "coalesced_detail_refresh"),
      "the join resumed before this mutation; its new flow is still queued");
    const removed = removeShipment(row.identity.id, now);
    saveState({ ...removed, shipments: [{ ...row,
      identity: { ...row.identity, createdAtMs: now + 1 }, updatedAtMs: now + 1 }] }, now + 1);
    expected = JSON.stringify(loadState(now).shipments.find(item => item.identity.id === row.identity.id));
  }));
  const [forcedResult, pullResult] = await Promise.all([forced, pulled, mutation]);
  assert.equal(forcedResult.skipReason, "signed_frozen");
  assert.deepEqual(forcedCalls, []);
  assert.deepEqual(pullCalls, [], "the scheduled history flow must retain the old pull's identity fence");
  assert.equal(JSON.stringify(pullResult.shipment), expected);
  assert.equal(JSON.stringify(loadState(now).shipments.find(item => item.identity.id === row.identity.id)), expected);
});

test("a joined alignment that already queried but remains partial never starts a second history query", async () => {
  const row = seed(false, true, true);
  assert.equal(signedRefreshFrozen(row, now), false);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const forcedCalls: string[] = [];
  const pullCalls: string[] = [];
  const forcedRuntime = runtime(forcedCalls, false);
  const forced = runTargetedShipmentRefreshForTesting(row.identity.id, ALIGNMENT, {
    ...forcedRuntime,
    queryManualForSource: async input => {
      const outcome = await forcedRuntime.queryManualForSource(input);
      if (!input.pickerOnly) return outcome;
      const online = packet("v6_query", [SIGNED]);
      return { shipment: { ...row, timeline: online, sourceTimeline: null, manualTimelines: [online] },
        pending: null, routeUrl: "" };
    },
    refreshWebTimeline: async shipment => { entered(); await gate; return forcedRuntime.refreshWebTimeline(shipment); },
  });
  await Promise.race([started, forced.then(() => assert.fail("the alignment must reach its actual H5 boundary"))]);
  const pulled = runTargetedShipmentRefreshForTesting(row.identity.id, PULL, runtime(pullCalls));
  release();
  const [forcedResult, pullResult] = await Promise.all([forced, pulled]);
  assert.ok(forcedCalls.includes("k100_h5"));
  assert.equal(signedRefreshFrozen(forcedResult.shipment, now), true);
  assert.notEqual(shipmentDetailIncompleteReason(forcedResult.shipment), null);
  assert.deepEqual(pullCalls, [], "an actual-query outcome is reused without a second request");
  assert.equal(pullResult.refreshed, forcedResult.refreshed);
});

test("complete history also stays frozen when the pull joins an alignment", async () => {
  const row = seed(true);
  const calls: string[] = [];
  const forced = runTargetedShipmentRefreshForTesting(row.identity.id, ALIGNMENT, runtime(calls));
  const pulled = runTargetedShipmentRefreshForTesting(row.identity.id, PULL, runtime(calls));
  const results = await Promise.all([forced, pulled]);
  assert.deepEqual(calls, []);
  assert.equal(results[1].refreshed, false);
  assert.equal(shipmentDetailIncompleteReason(results[1].shipment), null);
});

test("a joined pull respects the independent 72-hour sign-off freeze", async () => {
  const row = signedOffPartial();
  now += FORCED_COMPLETION_REFRESH_WINDOW_MS;
  const calls: string[] = [];
  const forced = runTargetedShipmentRefreshForTesting(row.identity.id,
    { ...ALIGNMENT, deadlineAtMs: now + 30_000 }, runtime(calls));
  const pulled = runTargetedShipmentRefreshForTesting(row.identity.id,
    { ...PULL, deadlineAtMs: now + 30_000 }, runtime(calls));
  await Promise.all([forced, pulled]);
  assert.deepEqual(calls, []);
});

test("an expired joined pull cannot start a new history operation", async () => {
  const row = seed();
  const calls: string[] = [];
  const forced = runTargetedShipmentRefreshForTesting(row.identity.id, ALIGNMENT, runtime(calls));
  const pulled = runTargetedShipmentRefreshForTesting(row.identity.id,
    { ...PULL, deadlineAtMs: now - 1 }, runtime(calls));
  const results = await Promise.all([forced, pulled]);
  assert.deepEqual(calls, []);
  assert.equal(results[1].querySucceeded, false);
});

test("cancelling a joined pull cannot start history repair or cancel the alignment owner", async () => {
  const row = seed();
  const calls: string[] = [];
  const forced = runTargetedShipmentRefreshForTesting(row.identity.id, ALIGNMENT, runtime(calls));
  const cancellation = new AbortController();
  cancellation.abort();
  const pulled = runTargetedShipmentRefreshForTesting(row.identity.id,
    { ...PULL, signal: cancellation.signal }, runtime(calls));
  await assert.rejects(pulled, OperationTimeoutError);
  const result = await forced;
  assert.equal(result.refreshed, false);
  assert.deepEqual(calls, []);
});

test("concurrent joined pulls acquire the released detail lease for at most one history query", async () => {
  const row = seed();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const forcedCalls: string[] = [];
  const pullCalls: string[] = [];
  const pullRuntime = runtime(pullCalls);
  const waiting = { ...pullRuntime,
    refreshWebTimeline: async shipment => { entered(); await gate; return pullRuntime.refreshWebTimeline(shipment); } };
  const forced = runTargetedShipmentRefreshForTesting(row.identity.id, ALIGNMENT, runtime(forcedCalls));
  const first = runTargetedShipmentRefreshForTesting(row.identity.id, PULL, waiting);
  const second = runTargetedShipmentRefreshForTesting(row.identity.id, PULL, waiting);
  try {
    await Promise.race([started, Promise.all([forced, first, second]).then(() =>
      assert.fail("one joined pull must reach the history capture boundary"))]);
  } finally { release(); }
  const results = await Promise.all([forced, first, second]);
  assert.deepEqual(forcedCalls, []);
  assert.deepEqual(pullCalls, ["k100_h5"]);
  assert.ok(results.slice(1).some(result => result.refreshed));
});

test("a used JD signed-history release is not recreated by an incomplete detail pull", async () => {
  const parcel: AccountParcelDto = { source: "interface5", ownerId: "3999999000010090",
    orderId: "3999999000010090", accountOrder: true, waybill: "JD900000001009",
    courierCode: "JD", rawCourierCode: "JD", companyName: "Synthetic JD carrier", sourceProvider: "JingDong",
    sourceStateCode: "107", sourceStateText: "已签收", semantic: "COMPLETED", normalizedStatusScope: "SHIPMENT",
    normalizedStatus: SIGNED.raw.normalizedStatus, receiverPhone: PHONE, senderPhone: "",
    latestTimeText: time(SIGNED_AT), latestDetail: "Synthetic delivery node",
    tracks: [track(SIGNED_AT, "Synthetic delivery node", "DELIVERY"), PICKED].map(node => ({
      timeText: node.timeText, detail: node.detail, statusCode: node.statusCode,
      normalizedStatus: node.raw.normalizedStatus })),
    routeUrl: "", projectionUrl: "https://u.jd.com/forward?synthetic=history-pull" } as AccountParcelDto;
  const incoming = parcelToShipment(parcel, [PHONE], now)!;
  const row = saveState({ ...emptyState(), shipments: [incoming],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 }] }, now).shipments[0]!;
  recordSignedRelease(row.identity.id, SIGNED_AT, "jingDongUnionGap", now);
  assert.equal(shipmentDetailIncompleteReason(row), "status_mismatch");
  const calls: string[] = [];
  await runShipmentRefreshForTesting(row.identity.id, lease(), PULL, runtime(calls));
  assert.deepEqual(calls, [], "owner pickup and the spent release preserve the original query gates");
  assert.equal(signedReleaseUsed(row.identity.id, SIGNED_AT, "jingDongUnionGap"), true);
  assert.equal(signedReleaseUsed(row.identity.id, SIGNED_AT + 1, "jingDongUnionGap"), false);
});
