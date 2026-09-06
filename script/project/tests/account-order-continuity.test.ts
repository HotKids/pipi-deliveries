import assert from "node:assert/strict";

import type { Shipment } from "../models";
import { parcelToShipment } from "../services/account-sync";
import type { AccountParcelDto } from "../services/account-parser";
import { mergeAccountParcel } from "../services/sync";

const NOW = Date.UTC(2026, 8, 3, 10, 0, 0);
const PHONE = "13800001515";
function track(timeText: string, detail: string) {
  return { timeText, detail, statusCode: "" };
}
function orderParcel(overrides: Partial<AccountParcelDto> = {}): AccountParcelDto {
  return {
    source: "interface5", ownerId: "3610448002878202", waybill: "3610448002878202",
    orderId: "3610448002878202", accountOrder: true, courierCode: "JDKD",
    rawCourierCode: "JDKD", rawCompanyName: "京东购物", companyName: "京东购物",
    carrierNormalization: null, sourceProvider: "JingDong", sourceStateCode: "1",
    sourceStateText: "已下单", semantic: "ORDERED", normalizedStatusScope: "ORDER",
    normalizedStatusSemantic: "ORDERED", normalizedStatusText: "已下单",
    receiverPhone: PHONE, senderPhone: "", latestTimeText: "2026-09-03 17:54:00",
    latestDetail: "预计 9 月 4 日送达",
    tracks: [
      track("2026-09-03 17:54:00", "预计 9 月 4 日(周五)送达"),
      track("2026-09-03 17:49:00", "【DK江门维达网点】的谭秀文已取件"),
      track("2026-09-03 17:22:00", "您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547"),
      track("2026-09-03 14:49:00", "最快9月3日发货，9月4日(周五)送达"),
    ],
    routeUrl: "", projectionUrl: "https://u.jd.com/forward?token=opaque",
    textIdentity: { waybill: "JT4006839564547", courierCode: "JTSD", companyName: "极兔速递" },
    ...overrides,
  } as unknown as AccountParcelDto;
}
function projectedOwner(semantic: "PICKED" | "DELIVERY", parcel: AccountParcelDto): Shipment {
  const base = parcelToShipment(parcel, [PHONE], NOW - 60_000)!;
  const timeline = {
    provider: "interface5", waybill: "JT4006839564547", courierCode: "JD", companyName: "京东快递",
    semantic, statusEventAtMs: Date.UTC(2026, 8, 3, 9, 48, 0), latestTimeText: "2026-09-03 17:48:00",
    latestDetail: "[江门市]【DK江门维达网点】的谭秀文已取件", complete: false,
    tracks: [{
      timeText: "2026-09-03 17:48:00", timeMs: Date.UTC(2026, 8, 3, 9, 48, 0),
      detail: "[江门市]【DK江门维达网点】的谭秀文已取件", statusCode: "",
      raw: { _pipiStatusSource: "jingdong_h5" },
    }],
    successAtMs: NOW - 60_000,
  } as Shipment["timeline"];
  return {
    ...base,
    identity: {
      ...base.identity,
      projectedWaybill: "JT4006839564547", courierCode: "JD", companyName: "京东快递",
    },
    timeline,
    sourceTimeline: timeline,
  };
}

// A build-39 owner: projected to the JT waybill, mislabelled 京东快递, holding one partial H5 node.
{
  const parcel = orderParcel();
  const owner = projectedOwner("PICKED", parcel);
  const merged = mergeAccountParcel(
    { shipments: [owner] } as never, [owner], parcel, [PHONE], "interface5", NOW, new Map(),
  )[0]!;
  assert.equal(merged.identity.projectedWaybill, "JT4006839564547");
  assert.equal(merged.identity.courierCode, "JTSD", "feed text repairs the order-stage carrier");
  assert.equal(merged.identity.companyName, "极兔速递");
  // 用户定 2026-09-05 晚：feed 增量与 query 独立。source 只装 feed 自己的四条节点，老行里混进
  // 来的那条 H5 节点拆出去（不完整的 H5 包不存）；列表状态归 feed。
  assert.equal(merged.timeline.tracks.length, 4, "the source keeps only the feed's own nodes");
  assert.equal(merged.timeline.tracks.some((track) => track.raw?._pipiStatusSource === "jingdong_h5"), false);
  assert.equal(merged.timeline.semantic, "ORDERED", "the list status is the feed's own status");
}

// A signed order: the account's terminal COMPLETED always wins over a stale partial H5 stage.
{
  const parcel = orderParcel({
    semantic: "COMPLETED", normalizedStatusSemantic: "COMPLETED", normalizedStatusText: "已签收",
    sourceStateText: "已签收", latestDetail: "订单已完成配送，感谢您选择京东购物",
    tracks: [
      track("2026-09-03 18:33:00", "订单已完成配送，感谢您选择京东购物，期待再次为您服务"),
      track("2026-09-03 17:49:00", "【DK江门维达网点】的谭秀文已取件"),
    ],
  });
  const owner = projectedOwner("PICKED", parcel);
  const merged = mergeAccountParcel(
    { shipments: [owner] } as never, [owner], parcel, [PHONE], "interface5", NOW, new Map(),
  )[0]!;
  assert.equal(merged.timeline.semantic, "COMPLETED", "a terminal account status always applies");
  assert.equal(merged.timeline.tracks.length, 2, "the stale partial H5 node never joins the feed");
}

// 小米京东来源的按件详情要用**订单号**去问 /cpa/express/v2/query，身份三件套保持上游那一行
// 自己的：provider=JingDong、cpCode=JDKD、name=京东商品快递（用户定 2026-09-05）。联合页回填出
// 来的真实承运商只属于展示层——拿极兔的 cpCode 去问小米，小米不认这一行。
{
  const projectedCarrier = orderParcel({
    rawCourierCode: "JTSD",
    rawCompanyName: "极兔速递",
    courierCode: "JTSD",
    companyName: "极兔速递",
  });
  const owner = parcelToShipment(projectedCarrier, [PHONE], NOW)!;
  assert.equal(owner.accountRecord?.waybill, "3610448002878202", "按订单号查，不是运单号");
  assert.equal(owner.accountRecord?.provider, "JingDong");
  assert.equal(owner.accountRecord?.companyCode, "JDKD");
  assert.equal(owner.accountRecord?.name, "京东商品快递");
}

// 非京东来源的行照旧用自己的承运商身份。
{
  const cainiao = orderParcel({
    accountOrder: false,
    orderId: "",
    ownerId: "78123456789012",
    waybill: "78123456789012",
    rawCourierCode: "ZTO",
    rawCompanyName: "中通快递",
    sourceProvider: "Cainiao",
  });
  const owner = parcelToShipment(cainiao, [PHONE], NOW)!;
  assert.equal(owner.accountRecord?.waybill, "78123456789012");
  assert.equal(owner.accountRecord?.provider, "Cainiao");
  assert.equal(owner.accountRecord?.companyCode, "ZTO");
  assert.equal(owner.accountRecord?.name, "中通快递");
}

console.log("account order continuity tests passed");
