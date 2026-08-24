import assert from "node:assert/strict";
import type { AccountParcelDto } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { buildWidgetSnapshot } from "../services/status";

const NOW = Date.UTC(2026, 7, 27, 6, 46, 0);
const PHONE = "13800001515";

function order(waybill: string, courierCode: string, companyName: string) {
  return {
    source: "interface5",
    ownerId: "ORDER202608270001",
    waybill,
    orderId: "ORDER202608270001",
    accountOrder: true,
    courierCode,
    companyName,
    sourceProvider: "JingDong",
    sourceStateCode: "102",
    sourceStateText: "运输中",
    semantic: "TRANSIT",
    receiverPhone: PHONE,
    senderPhone: "",
    latestTimeText: "2026-08-27 03:17:48",
    latestDetail: "您的订单已离开分拣中心",
    tracks: [{
      timeText: "2026-08-27 03:17:48",
      detail: "您的订单已离开分拣中心",
      statusCode: "102",
    }],
    routeUrl: "",
    projectionUrl: "https://u.jd.com/example",
  } satisfies AccountParcelDto;
}

const unresolved = parcelToShipment(
  order("ORDER202608270001", "JD", "京东购物"),
  [PHONE],
  NOW,
)!;
assert.equal(unresolved.identity.companyName, "京东购物");
assert.equal(unresolved.identity.projectedWaybill, "");

const projected = parcelToShipment(
  order("JD0256747737308", "JD", "京东购物"),
  [PHONE],
  NOW,
)!;
assert.equal(projected.identity.companyName, "京东快递");
assert.equal(projected.identity.courierCode, "JD");
assert.equal(projected.identity.projectedWaybill, "JD0256747737308");
assert.equal(projected.timeline.companyName, "京东快递");
assert.equal(projected.timeline.courierCode, "JD");

const widget = buildWidgetSnapshot([projected], NOW);
assert.equal(widget.rows[0]?.companyName, "京东快递");
assert.equal(widget.rows[0]?.accountOrder, false);
assert.equal(widget.compactIcons[0]?.companyName, "京东快递");

const projectedSf = parcelToShipment(
  order("SF0256747737309", "JD", "京东购物"),
  [PHONE],
  NOW,
)!;
assert.equal(projectedSf.identity.courierCode, "SF");
assert.equal(projectedSf.identity.companyName, "顺丰速运");

console.log("account shipment presentation tests passed");
