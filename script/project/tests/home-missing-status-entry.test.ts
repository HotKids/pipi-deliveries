import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { Shipment, TimelinePackage } from "../models";
import { needsDetailEntryQuery, selectShipmentTimeline, selectShipmentDetailTimeline } from "../services/shipment-policy";

const home = readFileSync(new URL("../pages/HomePage.tsx", import.meta.url), "utf8");
const expression = home.match(/refreshOnAppear=\{([\s\S]*?)\}\s+onStateChange=/)?.[1];
assert.ok(expression, "Home must declare the detail entry refresh trigger");
function trigger(homeStatus: string, detailStatus = homeStatus, preview = false, order = false, watch = false,
  watchRefreshes = true) {
  return runInNewContext(expression!, {
    internationalShipment: () => watch,
    watchDetailOpenRefreshes: () => watchRefreshes,
    needsDetailEntryQuery: () => homeStatus === "UNKNOWN",
    selected: {}, manualPreview: preview ? {} : null,
    manualPreviewNeedsDetailRefresh: () => true,
    unprojectedAccountOrder: () => order,
    needsAutomaticManualFallback: () => false,
    selectShipmentTimeline: () => ({ semantic: homeStatus }),
    selectShipmentDetailTimeline: () => ({ semantic: detailStatus }),
  });
}
assert.equal(trigger("UNKNOWN"), "detail_open", "opening an unresolved row must reach the status query path");
assert.equal(trigger("DELIVERY"), false, "Home follows a false query-eligibility result");
const now = Date.UTC(2026, 8, 9);
const waybill = "SF1234560058";
function packageWithStatus(semantic: TimelinePackage["semantic"], structuredStatus: boolean): TimelinePackage {
  return { provider: "v5_query", waybill, courierCode: "SF", companyName: "SF",
    semantic, structuredStatus, statusEventAtMs: now, latestDetail: "Carrier event",
    latestTimeText: new Date(now).toISOString(), successAtMs: now,
    tracks: [{ timeMs: now, timeText: new Date(now).toISOString(), detail: "Carrier event", statusCode: "", raw: {} }],
  };
}
const feed = { ...packageWithStatus("UNKNOWN", false), provider: "interface5" };
const shipment: Shipment = {
  identity: { id: "synthetic", sourceId: "361000000000001", sourceOwner: "account",
    bindingSource: "interface5", sourceProvider: "JingDong", accountOrder: true,
    orderId: "361000000000001", projectedWaybill: waybill, manuallyAdded: false,
    phone: "", phoneTail: "", courierCode: "SF", companyName: "SF", createdAtMs: now },
  timeline: feed, sourceTimeline: feed, manualTimelines: [], accountRecord: null, updatedAtMs: now,
};
for (const structured of [true, false]) {
  const row = { ...shipment, manualTimelines: [{ ...packageWithStatus("COMPLETED", structured), complete: true }] };
  const homeStatus = selectShipmentTimeline(row).semantic;
  const detailStatus = selectShipmentDetailTimeline(row).semantic;
  assert.equal(detailStatus, structured ? "COMPLETED" : "UNKNOWN");
  assert.equal(homeStatus, structured ? "COMPLETED" : "UNKNOWN");
  assert.equal(trigger(homeStatus, detailStatus), structured ? false : "detail_open",
    "only eligible structured detail evidence can satisfy Home status before querying");
}
assert.equal(trigger("UNKNOWN", "UNKNOWN", false, true), "detail_open");
assert.equal(trigger("COMPLETED", "COMPLETED", false, true), "detail_open",
  "an unresolved identity opens automatically even when history is complete");
assert.equal(trigger("UNKNOWN", "UNKNOWN", true), "manual_submit");
// Owner 2026-11-19 parity: a Watch row opens like any other row and refreshes its own cloud projection;
// the watch: branch never enters the domestic query chain (international-detail-refresh.test.ts).
assert.equal(trigger("DELIVERY", "DELIVERY", false, false, true), "detail_open",
  "a Watch row refreshes its own projection on open");
// G-MED-02: a terminal Watch row that already shows its scans opens from what is stored (international-detail-open).
assert.equal(trigger("COMPLETED", "COMPLETED", false, false, true, false), false,
  "Home follows the Watch rule's false result");
console.log("Home missing-status entry partitions passed");

// Exercise the real policy at the Home entry boundary, rather than the status-only stub above.
for (const carrier of ["JD", "SF", "ZTO"]) {
  const active = packageWithStatus("DELIVERY", true);
  active.tracks.push({ timeMs: now - 60000, timeText: new Date(now - 60000).toISOString(),
    detail: "已揽收", statusCode: "", raw: {} });
  const row: Shipment = { ...shipment, identity: { ...shipment.identity, courierCode: carrier },
    timeline: active, sourceTimeline: { ...active, provider: "v5_list" },
    accountRecord: { waybill, companyCode: carrier, provider: "JingDong", phone: "" } };
  assert.equal(runInNewContext(expression!, {
    needsDetailEntryQuery, selected: row, manualPreview: null, internationalShipment: () => false,
    unprojectedAccountOrder: () => false,
  }), "detail_open", "a JD-source row with complete active history starts one entry query");
}
