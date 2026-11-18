import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import {
  compactTimelineTime,
  formatListTime,
  timelineTimeParts,
} from "../services/time-presentation";
import { shipmentDetailPhoneTail } from "../services/status";

assert.deepEqual(timelineTimeParts("2026-08-27 03:17:48"), {
  date: "08-27",
  time: "03:17",
});
assert.equal(
  compactTimelineTime("2026-08-27 03:17:48", new Date(2026, 7, 27, 8)),
  "03:17",
);
assert.equal(
  compactTimelineTime("2026-08-26 22:41:01", new Date(2026, 7, 27, 8)),
  "08-26",
);
assert.equal(compactTimelineTime("刚刚更新", new Date()), "刚刚更新");

assert.equal(formatListTime("2026-09-13 15:49:59"), "2026-09-13 15:49");
assert.equal(formatListTime("2026-09-13T15:49"), "2026-09-13 15:49");
assert.equal(formatListTime("2026-09-13T07:49:59.637Z"), "2026-09-13 15:49");
assert.equal(formatListTime("2026-09-13T07:49+00:00"), "2026-09-13 15:49");
assert.equal(formatListTime("2026-09-13T23:49:00-04:00"), "2026-09-14 11:49");
assert.equal(formatListTime("2025-12-31T20:00:00Z"), "2026-01-01 04:00");
assert.equal(formatListTime("2026-02-30 15:49:00"), "2026-02-30 15:49:00");
assert.equal(formatListTime("刚刚更新"), "刚刚更新");
assert.equal(formatListTime(""), "");

const signing = Date.parse("2026-11-17T05:05:00Z");
const now = Date.parse("2026-11-18T04:00:00Z");
const timeline: TimelinePackage = {
  provider: "v5_list", waybill: "ZT0000000000123", courierCode: "ZTO", companyName: "中通快递",
  semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: signing,
  latestTimeText: "2026-11-18 09:30", latestDetail: "物流信息已更新", tracks: [], successAtMs: now,
};
const shipment: Shipment = { timeline, updatedAtMs: now, identity: {
  id: "receipt-test", bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceId: timeline.waybill,
  phoneTail: "0329", courierCode: "ZTO", companyName: "中通快递", manuallyAdded: false, createdAtMs: signing - 60000,
} };
assert.equal(shipmentDetailPhoneTail(shipment), "0329");
assert.equal(shipmentDetailPhoneTail({ ...shipment, timeline: { ...timeline, semantic: "TRANSIT" } }), "0329");
const noTail = { ...shipment, identity: { ...shipment.identity, phoneTail: "" } };
assert.equal(shipmentDetailPhoneTail(noTail), "");
assert.equal(shipmentDetailPhoneTail({ ...noTail, identity: { ...noTail.identity, phone: "13000000042" } }), "0042");
