import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { Shipment, TimelinePackage } from "../models";
import { selectShipmentTimeline, selectShipmentDetailTimeline } from "../services/shipment-policy";

const home = readFileSync(new URL("../pages/HomePage.tsx", import.meta.url), "utf8");
const expression = home.match(/refreshOnAppear=\{([\s\S]*?)\}\s+onStateChange=/)?.[1];
assert.ok(expression, "Home must declare the detail entry refresh trigger");
function trigger(homeStatus: string, detailStatus = homeStatus, preview = false, order = false) {
  return runInNewContext(expression!, {
    selected: {}, manualPreview: preview ? {} : null,
    manualPreviewNeedsDetailRefresh: () => true,
    unprojectedAccountOrder: () => order,
    needsAutomaticManualFallback: () => false,
    selectShipmentTimeline: () => ({ semantic: homeStatus }),
    selectShipmentDetailTimeline: () => ({ semantic: detailStatus }),
  });
}
assert.equal(trigger("UNKNOWN"), "detail_open", "opening an unresolved row must reach the status query path");
assert.equal(trigger("DELIVERY"), false, "complete known-status rows keep the existing no-query entry");
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
  assert.equal(detailStatus, "COMPLETED");
  assert.equal(homeStatus, structured ? "COMPLETED" : "UNKNOWN");
  assert.equal(trigger(homeStatus, detailStatus), structured ? false : "detail_open",
    "only eligible structured detail evidence can satisfy Home status before querying");
}
assert.equal(trigger("UNKNOWN", "UNKNOWN", false, true), "identity_projection");
assert.equal(trigger("UNKNOWN", "UNKNOWN", true), "manual_submit");
console.log("Home missing-status entry partitions passed");
