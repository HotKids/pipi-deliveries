import assert from "node:assert/strict";
import "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { activeWatchScope, internationalShipmentSnapshot } from "../services/international-records";
import { shipmentPresentationStatus } from "../services/status";
import { commitWatchSnapshot, loadWidgetSnapshot, visibleShipments } from "../services/storage";

// 2026-11-20 review, supplement 4: an international parcel whose newest scan is out for delivery
// reads 派送中 like an ordinary parcel. The Bot owns the status and syncs it as the Watch record's
// structured DELIVERY; Deliveries iOS shows that status and never derives one from scan prose.
// The tracks use the review's FedEx example shape, oldest first as an upstream may send them.
saveGatewayToken("SyntheticKey_004");
const scope = activeWatchScope();
assert.ok(scope);
const now = Date.now();
const outForDeliveryAt = now - 60_000;
const record = (status: string, statusText: string) => ({
  id: "00000000-0000-0000-0000-000000000004", waybill: "SYNTHETIC0004", carrierCode: "fedex",
  carrierName: "FedEx", icon: "fedex", status, statusText, updatedAt: now - 1_000,
  tracks: [
    { at: outForDeliveryAt - 2 * 86_400_000, time: "", detail: "Shenzhen, CN · Picked up" },
    { at: outForDeliveryAt, time: "", detail: "Shanghai, CN · Out for Delivery" },
  ],
});

const delivery = internationalShipmentSnapshot(record("DELIVERY", "派送中"), now);
assert.equal(delivery.timeline.semantic, "DELIVERY");
assert.equal(delivery.timeline.latestDetail, "Shanghai, CN · Out for Delivery");
assert.equal(delivery.timeline.statusEventAtMs, outForDeliveryAt);
const [listed] = visibleShipments(commitWatchSnapshot({ scope, snapshot: "snapshot-ofd", observedAtMs: now, shipments: [delivery] }));
assert.deepEqual(shipmentPresentationStatus(listed), { semantic: "DELIVERY", text: "派送中" });
const [row] = loadWidgetSnapshot().rows;
assert.equal(row.shipmentId, delivery.identity.id);
assert.equal(row.semantic, "DELIVERY");
assert.equal(row.statusLabel, "派送中");

// The record's structured status owns the word: scan prose alone never moves a TRANSIT record.
const transit = internationalShipmentSnapshot(record("TRANSIT", "运输中"), now);
assert.deepEqual(shipmentPresentationStatus(transit), { semantic: "TRANSIT", text: "运输中" });
assert.equal(transit.timeline.latestDetail, "Shanghai, CN · Out for Delivery");
console.log("An out-for-delivery Watch reads 派送中 on the list, detail and widget");
