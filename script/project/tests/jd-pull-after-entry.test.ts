import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { AccountOrderProjectionDiagnostics } from "../services/account-order-projection";
import type { StatusSemantic, TimelinePackage } from "../models";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, loadState, saveState } from "../services/storage";
import { saveOrderProjectionReferences } from "../services/routes";
import { runShipmentRefreshForTesting } from "../services/sync";
import { shipmentDetailIncompleteReason, selectShipmentDetailTimeline } from "../services/shipment-policy";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";

// Build 95's observed event clocks and counts; identities and node contents are synthetic.
const EVENT = 1789085861000, OLD_EVENT = 1789056101000, NOW = EVENT + 12 * 3600000;
const ORDER = "3610000000000001", WAYBILL = "JD000000000001", PHONE = "13800000000";
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
function parcel(count = 6, semantic: StatusSemantic = "DELIVERY"): AccountParcelDto {
  const tracks = Array.from({ length: count }, (_, i) => ({
    timeText: providerTime(EVENT - i * 60000), detail: `Synthetic account event ${i}`, statusCode: "",
  }));
  return {
    source: "interface5", ownerId: ORDER, orderId: ORDER, accountOrder: true, waybill: WAYBILL,
    courierCode: "JD", rawCourierCode: "JD", companyName: "Synthetic carrier", sourceProvider: "JingDong",
    sourceStateCode: semantic === "COMPLETED" ? "106" : "105", sourceStateText: semantic,
    semantic, normalizedStatusScope: "SHIPMENT", normalizedStatusSemantic: semantic,
    normalizedStatusText: semantic, receiverPhone: PHONE, senderPhone: "",
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks, routeUrl: "",
    projectionUrl: "https://u.jd.com/forward?test=pull",
  };
}
function history(at = OLD_EVENT): TimelinePackage {
  const tracks = Array.from({ length: 8 }, (_, i) => ({
    timeMs: at - i * 60000, timeText: providerTime(at - i * 60000),
    detail: i === 7 ? "已揽收" : `Synthetic H5 event ${i}`, statusCode: "",
    raw: { _pipiStatusSource: "jingdong_h5" },
  }));
  return { provider: "jd_h5", waybill: WAYBILL, courierCode: "JD", companyName: "Synthetic carrier",
    semantic: "UNKNOWN", structuredStatus: false, complete: true, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: NOW - 3600000 };
}
function seed(semantic: StatusSemantic = "DELIVERY", currentHistory = false) {
  memory.clear();
  const row = parcelToShipment({ ...parcel(6, semantic), projectionTimeline: history(currentHistory ? EVENT : OLD_EVENT) }, [PHONE], NOW)!;
  row.detailSelection = { provider: currentHistory ? "jd_h5" : "v5_list", selectedAtMs: NOW - 60000 };
  const state = saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  saveOrderProjectionReferences([{ ownerId: row.identity.id, source: "interface5", url: parcel().projectionUrl }], NOW);
  setDiagnosticsEnabled(true);
  return state.shipments[0];
}
const lease = { isCurrent: () => true, deadlineAtMs: NOW + 30000 };
const pull = { trigger: "detail_pull" as const, forceManualRefresh: true, includeKdniaoFallback: true };
const noExtraRequests = {
  refreshAccountParcel: async () => { assert.fail("pull must not repeat v5"); },
  refreshWebTimeline: async () => { assert.fail("cached pickup must not expand the primary round"); },
  queryManualForSource: async () => { assert.fail("pull must not add v6 or paid fallback"); },
};
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

test("a nonempty but incomplete entry query does not suppress the requested JD H5 load", async () => {
  const row = seed();
  let queries = 0, captures = 0;
  const entry = await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
    ...noExtraRequests,
    refreshAccountParcel: async () => { queries++; return parcel(18); },
    projectAccountOrderWithCarrier: async () => { assert.fail("resolved entry must not load H5"); },
  });
  assert.equal(queries, 1);
  assert.equal(entry.detailEntry?.gaveTimeline, true);
  assert.equal(entry.shipment.manualTimelines?.find(p => p.provider === "v5_query")?.tracks.length, 18);
  assert.equal(shipmentDetailIncompleteReason(entry.shipment), "missing_pickup");
  const freshHistory = history(EVENT);
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, { ...pull, detailEntry: entry.detailEntry }, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async input => {
      captures++;
      assert.equal(input.ownerId, ORDER);
      assert.equal(input.projectionUrl, parcel().projectionUrl);
      return { ...input, waybill: WAYBILL, projectionTimeline: freshHistory };
    },
  });
  assert.equal(captures, 1, "incomplete cached query must allow the same-ticket H5 stage");
  assert.equal(result.querySucceeded, true);
  assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "jd_h5");
  assert.equal(shipmentDetailIncompleteReason(result.shipment), null);
  assert.equal(selectShipmentDetailTimeline(loadState(NOW).shipments[0]).provider, "jd_h5");
  assert.ok(readDiagnostics().some(e => e.event === "order.projection.started" && e.details.result === "timeline_reopen"));
  const captured = readDiagnostics().find(e => e.event === "detail.timeline.candidate" &&
    e.details.stage === "detail_webview")!.details;
  assert.equal(captured.effectiveTrackCount, freshHistory.tracks.length);
  assert.equal(captured.latestTrackAtMs, EVENT);
  assert.equal(captured.hasPickup, true);
  assert.equal(captured.foreignPackage, false);
  assert.equal(captured.waybillMatches, true);
  assert.equal(readDiagnostics().some(e => e.event === "detail.refresh.stage_skipped" && e.details.stage === "jd_h5"), false,
    "a completed capture must not emit the old feed-count skip event");
});

test("signed incomplete history may reopen despite an already expanded old H5 package", async () => {
  const row = seed("COMPLETED");
  assert.ok(shipmentDetailIncompleteReason(row));
  await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async () => { assert.fail("signed entry must wait for an explicit pull"); },
  });
  let captures = 0;
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, pull, {
    ...noExtraRequests,
    projectAccountOrderWithCarrier: async input => {
      captures++;
      return { ...input, waybill: WAYBILL, projectionTimeline: history(EVENT - 2000) };
    },
  });
  assert.equal(captures, 1, "signed status freezes scheduling, not explicit repair of incomplete history");
  assert.equal(shipmentDetailIncompleteReason(result.shipment), null);
  assert.equal(selectShipmentDetailTimeline(result.shipment).semantic, "COMPLETED");
  assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "jd_h5");
  const cached = loadState(NOW).shipments[0];
  assert.equal(selectShipmentDetailTimeline(cached).provider, "jd_h5");
  assert.equal(shipmentDetailIncompleteReason(cached), null);
});

test("current complete signed history stays frozen on entry and pull", async () => {
  const row = seed("COMPLETED", true);
  assert.equal(shipmentDetailIncompleteReason(row), null);
  for (const options of [{ trigger: "detail_open" as const }, pull]) {
    await runShipmentRefreshForTesting(row.identity.id, lease, options, {
      ...noExtraRequests,
      projectAccountOrderWithCarrier: async () => { assert.fail("complete signed history must not reopen"); },
    });
  }
});

for (const risk of [false, true]) {
  test(`repeated pull preserves the ${risk ? "60-minute risk" : "10-minute ordinary"} cooldown`, async () => {
    const row = seed(); let captures = 0;
    const runtime = {
      ...noExtraRequests,
      projectAccountOrderWithCarrier: async (input: AccountParcelDto, _projection?: number, _deadline?: number,
        observe?: (diagnostics: AccountOrderProjectionDiagnostics) => void) => {
        captures++;
        if (risk) observe?.({
          loadSettled: true, loadCompleted: true, captureSeen: false, replayAttempted: false,
          replaySucceeded: false, probeInstalled: true, probeMatched: true, probeRequestCount: 1,
          unionSignalSeen: true, unionResourceSeen: true, resourceReplayBlockReason: "", domMatched: false,
          projectionComplete: false, projectionTrackCount: 0, requestCallbackCount: 1,
          evaluationAttempts: 1, evaluationFailures: 0, loadDurationMs: 1, resourceCount: 1,
          pageClass: "jd", readyState: "complete", visibilityState: "visible", viewportAvailable: true,
          viewportHosted: true, identitySource: "", unionResponseStatuses: "403", probeCaptureCount: 0,
        });
        return { ...input, waybill: WAYBILL, projectionTimeline: history() };
      },
    };
    await runShipmentRefreshForTesting(row.identity.id, lease, pull, runtime);
    assert.equal(captures, 1);
    Date.now = () => NOW + (risk ? 20 : 5) * 60000;
    try {
      await runShipmentRefreshForTesting(row.identity.id, { isCurrent: () => true }, pull, runtime);
      assert.equal(captures, 1, "an explicit gesture does not clear the existing cooldown");
      assert.ok(readDiagnostics().some(e => e.event === "order.projection.skipped" &&
        e.details.result === (risk ? "risk_control_cooldown" : "cooldown")));
    } finally { Date.now = () => NOW; }
  });
}
