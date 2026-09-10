import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import { selectShipmentTimeline, selectShipmentDetailTimeline } from "../services/shipment-policy";
import { shipmentDetailPresentationStatus } from "../services/status";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";

const NOW = Date.UTC(2026, 8, 9, 4);
const WAYBILL = "SF1234560058";
const pack = (provider: string, semantic: TimelinePackage["semantic"], at = NOW): TimelinePackage => ({
  provider, semantic, waybill: WAYBILL, courierCode: "SF", companyName: "SF",
  structuredStatus: semantic !== "UNKNOWN", statusEventAtMs: at,
  latestDetail: "Carrier event", latestTimeText: new Date(at).toISOString(), successAtMs: NOW,
  tracks: [0, 1, 2].map((offset) => ({
    timeMs: at - offset * 60_000, timeText: new Date(at - offset * 60_000).toISOString(),
    detail: "Carrier event", statusCode: "", raw: {},
  })),
});
const feed = { ...pack("interface5", "UNKNOWN"), tracks: pack("interface5", "UNKNOWN").tracks.slice(0, 1) };
const query = pack("v5_query", "UNKNOWN");
const donor = { ...pack("kdniao", "COMPLETED", NOW - 60_000), tracks: pack("kdniao", "COMPLETED").tracks.slice(0, 1) };
const owner: Shipment = {
  identity: {
    id: "interface5:account:361000000000001", sourceId: "361000000000001",
    sourceOwner: "interface5:order", bindingSource: "interface5", sourceProvider: "JingDong",
    accountOrder: true, orderId: "361000000000001", projectedWaybill: WAYBILL,
    manuallyAdded: false, phone: "", phoneTail: "", courierCode: "SF", companyName: "SF",
    createdAtMs: NOW - 86400000,
  },
  timeline: feed, sourceTimeline: feed, manualTimelines: [query, donor], route: null,
  accountRecord: null, updatedAtMs: NOW,
};

const home = selectShipmentTimeline(owner);
const detail = selectShipmentDetailTimeline(owner);
for (const selected of [home, detail]) {
  assert.equal(selected.semantic, "COMPLETED", "automatic rows borrow a missing status from the same waybill");
  assert.equal(selected.statusEventAtMs, donor.statusEventAtMs, "borrow status and its time together");

}
assert.deepEqual(home.tracks, feed.tracks, "Home keeps its feed tracks while borrowing status");
assert.deepEqual(detail.tracks, query.tracks, "detail keeps its query tracks while borrowing status");
assert.equal(home.provider, "interface5");
assert.equal(detail.provider, "v5_query");
assert.equal(shipmentDetailPresentationStatus(owner, detail).semantic, "COMPLETED",
  "an automatic detail with an unknown Home status may use its resolved structured status");

const recovered = { ...owner, sourceTimeline: pack("interface5", "DELIVERY"),
  manualTimelines: [pack("v5_query", "DELIVERY"), { ...donor, complete: true }] };
assert.equal(selectShipmentTimeline(recovered).semantic, "DELIVERY", "a valid owner status retains authority");
assert.equal(selectShipmentDetailTimeline(recovered).semantic, "DELIVERY");

for (const invalid of [
  { ...donor, waybill: "SF9876540000" },
  { ...donor, provider: "jd_h5" },
  { ...donor, structuredStatus: false },
]) {
  const row = { ...owner, manualTimelines: [query, invalid] };
  assert.equal(selectShipmentTimeline(row).semantic, "UNKNOWN", "untrusted status cannot fill an empty state");
  assert.equal(selectShipmentDetailTimeline(row).semantic, "UNKNOWN");
}
const undated = selectShipmentTimeline({ ...owner, manualTimelines: [query, { ...donor, statusEventAtMs: null }] });
assert.equal(undated.semantic, "COMPLETED");
assert.equal(undated.statusEventAtMs, null, "an undated status cannot inherit the selected headline's time");

const enumQuery = { ...query, tracks: query.tracks.map((track, index) => ({
  ...track, raw: index ? {} : { statusCode: "107", _pipiStatusSource: "interface5" },
})) };
assert.equal(selectShipmentDetailTimeline({ ...owner, manualTimelines: [enumQuery] }).semantic, "COMPLETED",
  "a selected package's own enum can restore a missing summary status");
console.log("missing status source tests passed");

for (const stateNum of [107, 0]) {
  const parsed = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: WAYBILL, cpCode: "SF", name: "SF", provider: "JingDong", stateNum,
    receiverPhone: "13800001234",
    details: [{ time: "2026-09-09 11:00:00", desc: "您的快件已送达至家门口" }],
  }] } })[0]!;
  const row = parcelToShipment(parsed, ["13800001234"], NOW)!;
  assert.equal(row.timeline.structuredStatus, stateNum === 107,
    "account provenance must distinguish provider enums from a delivery sentence");
}
