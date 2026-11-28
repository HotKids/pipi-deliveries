import assert from "node:assert/strict";
import "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { activeWatchScope, internationalShipmentSnapshot } from "../services/international-records";
import { displayedPlatformFields } from "../services/platform-parcel-merge";
import { shipmentPresentationStatus } from "../services/status";
import { commitWatchSnapshot, forceCompleteShipment, loadWidgetSnapshot,
  removeShipment, setShipmentNote, setShipmentProductName, visibleShipments } from "../services/storage";

saveGatewayToken("SyntheticKey_001");
const scope = activeWatchScope();
assert.ok(scope);
const now = Date.now();
const eta = new Date(now + 86_400_000);
const estimate = `预计${eta.getFullYear()}年${eta.getMonth() + 1}月${eta.getDate()}日送达`;
const raw = {
  id: "00000000-0000-0000-0000-000000000012",
  waybill: "WATCHTEST8085", carrierName: "FedEx", icon: "fedex", status: "TRANSIT", statusText: "运输中",
  updatedAt: now - 2_000,
  tracks: [{ at: now - 2_000, time: new Date(now - 2_000).toISOString(), detail: "Synthetic tracking scan" }],
  deliveryEstimate: estimate, deliveryEstimateObservedAt: now - 2_000,
};
const row = internationalShipmentSnapshot(raw, now);
const inbound = { scope, snapshot: "snapshot-a", observedAtMs: now - 1_000, shipments: [row] };
const state = commitWatchSnapshot(inbound);
const [visible] = visibleShipments(state);
assert.equal(visible.identity.id, row.identity.id);
assert.equal(loadWidgetSnapshot().rows[0].shipmentId, row.identity.id);
assert.equal(displayedPlatformFields(visible).estimate, "预计明天送达");

setShipmentNote(visible, "Test note");
setShipmentProductName(visible, "Test title");
const next = commitWatchSnapshot({ ...inbound, snapshot: "snapshot-b", observedAtMs: now });
assert.equal(visibleShipments(next)[0].note, "Test note");
assert.equal(displayedPlatformFields(visibleShipments(next)[0]).title, "Test title");
assert.equal(loadWidgetSnapshot().rows[0].note, "Test note");
const completed = forceCompleteShipment(row.identity.id);
assert.equal(shipmentPresentationStatus(visibleShipments(completed)[0]).text, "已签收");
assert.equal(displayedPlatformFields(visibleShipments(completed)[0]).estimate, "");
assert.equal(visibleShipments(removeShipment(row.identity.id)).length, 0);
assert.equal(visibleShipments(commitWatchSnapshot(inbound)).length, 0,
  "an in-flight snapshot must not reinsert a row deleted after it started");

const stale = internationalShipmentSnapshot({ ...raw, status: "CANCELLED", statusText: "已取消",
  tracks: [{ at: now - 5 * 3600_000, time: "", detail: "Synthetic return scan" }] }, now);
assert.equal(visibleShipments(commitWatchSnapshot({ ...inbound, snapshot: "snapshot-c",
  shipments: [stale], observedAtMs: Date.now() })).length, 0);
const unchangedScan = commitWatchSnapshot({ ...inbound, observedAtMs: now + 500, snapshot: "snapshot-d" });
assert.equal(visibleShipments(unchangedScan).length, 0,
  "a changed page without a newer scan timestamp must not revive a deleted Watch");
const newerScanRow = internationalShipmentSnapshot({
  ...raw, updatedAt: now + 1_000,
  tracks: [{ at: now + 1_000, time: new Date(now + 1_000).toISOString(), detail: "Newer tracking scan" }],
}, now + 1_000);
const restored = commitWatchSnapshot({ ...inbound, shipments: [newerScanRow], observedAtMs: now + 1_000, snapshot: "snapshot-e" });
assert.equal(visibleShipments(restored).length, 1);
saveGatewayToken("SyntheticKey_002");
assert.equal(visibleShipments(restored).length, 0);
assert.equal(loadWidgetSnapshot().rows.length, 0);
console.log("Watch shares parcel actions, widget identity, retention, metadata and credential scope");
