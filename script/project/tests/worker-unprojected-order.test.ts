import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, loadState, saveState } from "../services/storage";
import { shipmentPresentationStatus, shipmentDetailPresentationStatus, buildWidgetSnapshot } from "../services/status";

const NOW = Date.UTC(2026, 8, 15, 6);
const ORDER = "3610448002878202";
const projection = { version: 1 as const, scope: "ORDER" as const, semantic: "PICKED" as const,
  code: "103", text: "已揽件", priority: 0, structured: true, eventAtMs: NOW - 1000 };
const parcel: AccountParcelDto = {
  source: "interface5", ownerId: ORDER, waybill: ORDER, orderId: ORDER, accountOrder: true,
  sourceProvider: "JingDong", courierCode: "", companyName: "京东购物", semantic: "PICKED",
  normalizedStatus: projection, normalizedStatusScope: "ORDER", normalizedStatusSemantic: "PICKED",
  normalizedStatusText: "已揽件", sourceStateCode: "103", sourceStateText: "已揽件",
  receiverPhone: "13800001234", senderPhone: "", latestTimeText: "2026-09-15 13:59:59",
  latestDetail: "Synthetic order event", tracks: [{ timeText: "2026-09-15 13:59:59",
    detail: "Synthetic order event", statusCode: "103", normalizedStatus: projection }],
  routeUrl: "", projectionUrl: "",
};
Date.now = () => NOW;
memory.clear();
const order = parcelToShipment(parcel, [parcel.receiverPhone], NOW)!;
assert.equal(order.timeline.semantic, "ORDERED", "identity still belongs to an order, not a carrier waybill");
assert.deepEqual(parcel.normalizedStatus, projection, "the input Worker projection remains unchanged");
saveState({ ...emptyState(), shipments: [order] }, NOW);
const restored = loadState(NOW).shipments[0]!;
assert.equal(shipmentPresentationStatus(restored).semantic, "ORDERED");
assert.equal(shipmentDetailPresentationStatus(restored, restored.timeline).text, "已下单");
assert.equal(buildWidgetSnapshot([restored], NOW).rows[0]?.semantic, "ORDERED");
assert.equal(shipmentPresentationStatus({ ...order, timeline: { ...order.timeline,
  semantic: "PICKED", normalizedStatus: projection } }).semantic, "ORDERED",
  "an existing normalized cache obeys the same unprojected identity boundary");
assert.equal(shipmentPresentationStatus({ ...order, timeline: { ...order.timeline,
  semantic: "PICKED", normalizedStatus: undefined }, statusPresentation: {
    scope: "ORDER", semantic: "COMPLETED", text: "已完成",
  } }).semantic, "COMPLETED", "legacy order presentation keeps its existing authority");
const resolved = parcelToShipment({ ...parcel, waybill: "JD1234567890123" }, [parcel.receiverPhone], NOW)!;
assert.equal(resolved.timeline.semantic, "PICKED");
assert.deepEqual(resolved.timeline.normalizedStatus, projection);
assert.equal(shipmentPresentationStatus(resolved).semantic, "PICKED");
const unknown = parcelToShipment({ ...parcel, semantic: "UNKNOWN", latestDetail: "已揽收",
  normalizedStatus: { ...projection, semantic: "UNKNOWN", code: "NEW_STATE", text: "",
    structured: false, eventAtMs: 0 }, normalizedStatusSemantic: "UNKNOWN", normalizedStatusText: "" },
  [parcel.receiverPhone], NOW)!;
assert.equal(unknown.timeline.semantic, "UNKNOWN", "Worker UNKNOWN cannot be replaced by pickup prose");
console.log("Worker status retains unprojected order presentation tests passed");
