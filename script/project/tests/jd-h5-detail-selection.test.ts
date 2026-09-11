import assert from "node:assert/strict";
import { memory, NOW } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { TrackNode } from "../models";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, loadState, saveState } from "../services/storage";
import { needsDetailEntryQuery, selectShipmentDetailTimeline, selectShipmentTimeline, shipmentDetailComplete, shipmentSelectionEvidence } from "../services/shipment-policy";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { latestTimelineTrackSemantic } from "../services/status";
import { runShipmentRefreshForTesting } from "../services/sync";

const PHONE = "13800001234";
const WAYBILL = "JD000000007230";
// The observed JD wording, with station names and the contact footer removed.
const latestDetail = "您的订单已离开【始发站】，正在前往下一站【分拣中心】的途中";
const tracks: TrackNode[] = Array.from({ length: 7 }, (_, index) => ({
  timeMs: NOW - index * 60_000,
  timeText: `2026-09-08 14:${String(30 - index).padStart(2, "0")}:00`,
  detail: index === 0 ? latestDetail : index === 6 ? "快件已揽收" : `Logistics event ${index}`,
  statusCode: "",
  raw: { _pipiStatusSource: "jingdong_h5" },
}));
const parcel: AccountParcelDto = {
  source: "interface5", ownerId: "3610000000001323", orderId: "3610000000001323",
  accountOrder: true, waybill: WAYBILL, courierCode: "JD", rawCourierCode: "JDKD",
  companyName: "京东快递", sourceProvider: "JingDong", sourceStateCode: "104",
  sourceStateText: "运输中", semantic: "TRANSIT", normalizedStatusScope: "SHIPMENT",
  normalizedStatusSemantic: "TRANSIT", normalizedStatusText: "运输中",
  receiverPhone: PHONE, senderPhone: "", latestTimeText: tracks[0].timeText,
  latestDetail: "预计明天送达", routeUrl: "", projectionUrl: "",
  tracks: tracks.slice(0, 4).map((track, index) => ({
    timeText: track.timeText, detail: `预计明天送达 ${index}`, statusCode: "",
  })),
  projectionTimeline: {
    provider: "jd_h5", waybill: WAYBILL, courierCode: "JD", companyName: "京东快递",
    semantic: "UNKNOWN", structuredStatus: false, complete: true, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: NOW,
  },
};
const row = parcelToShipment(parcel, [PHONE], NOW)!;
assert.ok(row);
const h5 = row.manualTimelines!.find(timeline => timeline.provider === "jd_h5")!;
assert.equal(h5.tracks.length, 7);
// Use the parser's time basis so selection is independent of the test runner's timezone.
h5.tracks = h5.tracks.map((track, index) => ({
  ...track, timeMs: row.sourceTimeline!.tracks[0].timeMs! - index * 60_000,
}));
const previousQuery = { ...row.sourceTimeline!, provider: "v5_query",
  tracks: row.sourceTimeline!.tracks.slice(0, 3) };
row.manualTimelines!.push(previousQuery);
row.detailSelection = { provider: "v5_query", selectedAtMs: NOW - 60_000 };

// AGENTS §9: JD H5 is an independent detail candidate; it cannot replace feed presentation.
for (const shipment of [row, (() => {
  memory.clear();
  saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 },
  ] }, NOW);
  return loadState(NOW).shipments[0];
})()]) {
  const selected = selectShipmentDetailTimeline(shipment);
  assert.equal(selected.provider, "jd_h5", "the complete H5 package must participate in selection");
  assert.deepEqual(selected.tracks, h5.tracks, "select the single H5 package without merging feed/query rows");
  assert.equal(selected.semantic, "TRANSIT", "the feed retains status authority");
  assert.equal(latestTimelineTrackSemantic(selected.tracks), "UNKNOWN");
  assert.equal(shipmentDetailComplete(shipment), true, "unverifiable node status does not veto pickup and time evidence");
  assert.equal(needsDetailEntryQuery(shipment), false, "unknown node wording alone does not schedule an entry query");
  const home = selectShipmentTimeline(shipment);
  assert.deepEqual(home.tracks, h5.tracks, "Home and detail select the same whole history package");
  assert.equal(home.latestDetail, row.sourceTimeline!.latestDetail);
  const evidence = shipmentSelectionEvidence(shipment);
  assert.equal(evidence.historyProvider, "jd_h5");
  assert.equal(evidence.headlineProvider, row.sourceTimeline!.provider);
  assert.equal(evidence.statusProvider, row.sourceTimeline!.provider);
  assert.ok(["complete_replaces_partial", "complete_history"].includes(evidence.selectionReason));
}

const updatedQuery = { ...previousQuery, tracks: [...h5.tracks, {
  ...h5.tracks.at(-1)!, timeMs: h5.tracks.at(-1)!.timeMs! - 60_000, detail: "Order event",
}] };
const afterQuery = { ...row, manualTimelines: [h5, updatedQuery] };
assert.equal(selectShipmentDetailTimeline(afterQuery).provider, "v5_query",
  "the existing complete eight-row query remains selected over a seven-row H5 package");
assert.equal(shipmentDetailComplete(afterQuery), true);

const actualNow = Date.now;
Date.now = () => NOW;
try {
  setDiagnosticsEnabled(true);
  const result = await runShipmentRefreshForTesting(row.identity.id, { isCurrent: () => true },
    { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshAccountParcel: async () => { assert.fail("pull never repeats the entry query"); },
      projectAccountOrderWithCarrier: async () => { assert.fail("unverified node status alone does not reopen H5"); },
      refreshWebTimeline: async () => { assert.fail("sufficient cached history needs no primary request"); },
      queryManualForSource: async () => { assert.fail("sufficient cached history needs no manual fallback"); },
    });
  assert.equal(shipmentDetailComplete(result.shipment), true);
  assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "jd_h5");
  assert.equal(readDiagnostics().find(record => record.event === "detail.refresh.skipped")?.details.result, "complete_cache");
} finally { Date.now = actualNow; }

const partial = { ...h5, tracks: h5.tracks.slice(0, 2) };
assert.equal(selectShipmentDetailTimeline({ ...row,
  manualTimelines: [partial, previousQuery],
}).provider, "v5_query", "declared capture completeness must not bypass the existing pickup/sticky rules");

assert.equal(selectShipmentDetailTimeline({ ...row,
  identity: { ...row.identity, sourceProvider: "UnrelatedSource" },
}).provider, "v5_query", "the JD exception must not make its H5 package eligible for unrelated automatic sources");

console.log("JD H5 detail eligibility, persistence, feed authority and unchanged selection gates passed");
