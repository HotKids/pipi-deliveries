import assert from "node:assert/strict";
import type { Shipment } from "../models";
import { accountParcelWithProjectionReference } from "../services/account-order-reference";

const shipment = {
  identity: {
    id: "interface5:account:ORDER20260827001",
    sourceId: "ORDER20260827001",
    orderId: "ORDER20260827001",
    bindingSource: "interface5",
    accountOrder: true,
    manuallyAdded: false,
    companyName: "京东购物",
    courierCode: "JD_ORDER",
    rawCourierCode: "jd_order_source",
    rawCompanyName: "京东购物来源原名",
    phone: "18600000000",
  },
  timeline: {
    semantic: "ORDERED",
    waybill: "ORDER20260827001",
    latestTimeText: "2026-08-27 12:00:00",
    latestDetail: "订单已下单",
    provider: "interface5",
    tracks: [{
      timeText: "2026-08-27 12:00:00",
      detail: "订单已下单",
      statusCode: "ORDERED",
    }],
  },
  sourceTimeline: null,
  route: null,
  accountRecord: null,
  updatedAtMs: Date.UTC(2026, 7, 27, 12, 0, 0),
} as unknown as Shipment;

const projectionUrl = "https://h5.m.jd.com/order/detail?orderId=1";
const restored = accountParcelWithProjectionReference(
  shipment,
  null,
  projectionUrl,
);
assert.ok(restored);
assert.equal(restored?.ownerId, shipment.identity.sourceId);
assert.equal(restored?.waybill, shipment.identity.sourceId);
assert.equal(restored?.projectionUrl, projectionUrl);
assert.equal(restored?.tracks[0]?.detail, "订单已下单");
assert.equal(restored?.rawCourierCode, "jd_order_source");
assert.equal(restored?.rawCompanyName, "京东购物来源原名");

const detailWithoutProjection = {
  ...restored!,
  projectionUrl: "",
  latestDetail: "订单正在处理",
};
const patched = accountParcelWithProjectionReference(
  shipment,
  detailWithoutProjection,
  projectionUrl,
);
assert.equal(patched?.projectionUrl, projectionUrl);
assert.equal(patched?.latestDetail, "订单正在处理");

const projected = structuredClone(shipment);
projected.identity.projectedWaybill = "JD0123456789012";
const projectedReference = accountParcelWithProjectionReference(
  projected,
  null,
  projectionUrl,
);
assert.equal(projectedReference?.waybill, "JD0123456789012");
assert.equal(projectedReference?.projectionUrl, projectionUrl);

const unrelated = structuredClone(shipment);
unrelated.identity.accountOrder = false;
assert.equal(
  accountParcelWithProjectionReference(unrelated, null, projectionUrl),
  null,
);

console.log("account order projection reference tests passed");
