import assert from "node:assert/strict";

import type { Shipment } from "../models";
import { parcelToShipment } from "../services/account-sync";
import type { AccountParcelDto } from "../services/account-parser";
import { parseAccountSyncResponse } from "../services/account-parser";
import { mergeAccountParcel } from "../services/sync";
import { selectShipmentDetailTimeline } from "../services/shipment-policy";
import { withoutJingDongOrderCompletion } from "../services/status";

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
function projectedOwner(semantic: "PICKED" | "DELIVERY" | "COMPLETED", parcel: AccountParcelDto): Shipment {
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

// A carrier-scoped signature advances a stale partial H5 stage.
{
  const parcel = orderParcel({
    semantic: "COMPLETED", normalizedStatusSemantic: "COMPLETED", normalizedStatusText: "已签收",
    normalizedStatusScope: "SHIPMENT",
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

// An established carrier package survives a later order-only completion, at either stage.
for (const semantic of ["PICKED", "COMPLETED"] as const) {
  const initial = orderParcel();
  const owner = projectedOwner(semantic, initial);
  const priorDetail = semantic === "COMPLETED" ? "包裹已签收" : "已揽收";
  owner.timeline = { ...owner.timeline, latestDetail: priorDetail, tracks: [
    { timeText: "2026-09-03 17:48:00", timeMs: NOW - 720000,
      detail: priorDetail, statusCode: "", raw: {} },
    { timeText: "2026-09-01 17:48:00", timeMs: NOW - 2 * 86400000 - 720000,
      detail: "已揽收", statusCode: "", raw: {} },
  ] };
  owner.sourceTimeline = owner.timeline;
  const lateOrder = orderParcel({ textIdentity: undefined, semantic: "COMPLETED",
    normalizedStatusSemantic: "COMPLETED", normalizedStatusScope: "ORDER",
    normalizedStatusText: "已完成", sourceStateText: "订单已完成",
    latestDetail: "您的订单已完成，期待您对本次购物进行评价", latestTimeText: "2026-09-04 18:00:00",
    tracks: [track("2026-09-04 18:00:00", "您的订单已完成，期待您对本次购物进行评价")],
  });
  const merged = mergeAccountParcel(
    { shipments: [owner] } as never, [owner], lateOrder, [PHONE], "interface5", NOW + 86400000, new Map(),
  )[0]!;
  assert.equal(merged.identity.projectedWaybill, owner.identity.projectedWaybill);
  assert.equal(merged.timeline.semantic, semantic);
  assert.notEqual(merged.statusPresentation?.scope, "ORDER");
  assert.equal(merged.timeline.latestDetail, owner.timeline.latestDetail);
  assert.equal(merged.timeline.latestTimeText, owner.timeline.latestTimeText);
  assert.deepEqual(merged.timeline.tracks, owner.timeline.tracks);
}

// A legacy projection can have no timed feed nodes after its H5 nodes are split out.
{
  const owner = projectedOwner("PICKED", orderParcel());
  owner.timeline = { ...owner.timeline, complete: true };
  owner.sourceTimeline = owner.timeline;
  const orderOnly = orderParcel({ textIdentity: undefined, semantic: "COMPLETED",
    normalizedStatusSemantic: "COMPLETED", normalizedStatusScope: "ORDER",
    normalizedStatusText: "已完成", sourceStateText: "订单已完成",
    latestDetail: "您的订单已完成，期待评价", latestTimeText: "2026-09-04 18:00:00",
    tracks: [track("2026-09-04 18:00:00", "您的订单已完成，期待评价")],
  });
  const merged = mergeAccountParcel({ shipments: [owner] } as never, [owner],
    orderOnly, [PHONE], "interface5", NOW + 86400000, new Map())[0]!;
  assert.equal(merged.identity.projectedWaybill, owner.identity.projectedWaybill);
  assert.equal(merged.timeline.semantic, "PICKED");
  assert.equal(merged.timeline.tracks.some((node) => node.detail.includes("期待评价")), false);
  assert.equal(selectShipmentDetailTimeline(merged).latestDetail, owner.timeline.latestDetail);
}

// A full history can contain the later shopping-completion event even though its
// identity already names a carrier waybill. Only that exact order event is excluded.
{
  const orderId = "3610448002878202";
  const completion = `您的订单${orderId}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。`;
  const delivered = { ...track("2026-09-03 17:00:00", "包裹已签收"), statusCode: "107" };
  const forecast = track("2026-09-03 16:00:00", "温馨提示：您的订单预计今天送达");
  const deliveryCompletion = track("2026-09-03 15:00:00", "订单已完成配送，感谢您选择京东购物");
  const parcel = orderParcel({
    waybill: "JT4006839564547", semantic: "COMPLETED",
    normalizedStatusScope: "SHIPMENT", normalizedStatusSemantic: "COMPLETED",
    normalizedStatusText: "已签收", latestDetail: completion,
    latestTimeText: "2026-09-04 18:00:00",
    tracks: [track("2026-09-04 18:00:00", completion), delivered, forecast, deliveryCompletion],
  });
  const first = parcelToShipment(parcel, [PHONE], NOW + 86400000)!;
  assert.deepEqual(first.timeline.tracks.map((node) => node.detail),
    [delivered.detail, forecast.detail, deliveryCompletion.detail],
    "a first projected full history excludes only this order's shopping completion");
  assert.equal(first.timeline.latestDetail, delivered.detail);
  assert.equal(first.timeline.latestTimeText, delivered.timeText);
  assert.equal(first.timeline.semantic, "COMPLETED");
  assert.equal(first.timeline.statusEventAtMs, Date.UTC(2026, 8, 3, 9));
  const merged = mergeAccountParcel({ shipments: [first] } as never, [first],
    parcel, [PHONE], "interface5", NOW + 86400001, new Map())[0]!;
  assert.deepEqual(merged.timeline.tracks.map((node) => node.detail),
    first.timeline.tracks.map((node) => node.detail),
    "a later mixed full history cannot reintroduce the order event");
  assert.equal(selectShipmentDetailTimeline(merged).latestDetail, delivered.detail);

  const anotherOrder = parcelToShipment({ ...parcel, orderId: "3610448002878203" },
    [PHONE], NOW + 86400000)!;
  assert.equal(anotherOrder.timeline.tracks.length, 4,
    "order-like wording must not be removed without the exact owning order identity");
  const unprojected = parcelToShipment({ ...parcel, waybill: orderId },
    [PHONE], NOW + 86400000)!;
  assert.equal(unprojected.timeline.tracks.length, 4,
    "an order that has no carrier waybill still owns its shopping status");

  const reward = "您的订单[lululemon 商品标题]已完成，40京豆等您拿，完成评价即有机会获得，不要错过呦！";
  const rewardParcel = { ...parcel, latestDetail: reward,
    tracks: [track("2026-09-04 18:00:00", reward), delivered, forecast] };
  const rewarded = parcelToShipment(rewardParcel, [PHONE], NOW + 86400000)!;
  assert.deepEqual(rewarded.timeline.tracks.map((node) => node.detail),
    [delivered.detail, forecast.detail],
    "the product-title shopping completion template belongs to this projected order too");
  const differentReward = parcelToShipment({ ...rewardParcel,
    latestDetail: reward.replace("40京豆", "100京豆"),
    tracks: rewardParcel.tracks.map((node) => ({ ...node, detail: node.detail.replace("40京豆", "100京豆") })),
  }, [PHONE], NOW + 86400000)!;
  assert.deepEqual(differentReward.timeline.tracks, rewarded.timeline.tracks,
    "the reward amount is a value within the same shopping-completion event");
  const empty = parcelToShipment({ ...rewardParcel, tracks: rewardParcel.tracks.slice(0, 1),
    normalizedStatusScope: "ORDER" }, [PHONE], NOW + 86400000)!;
  assert.equal(empty.timeline.tracks.length, 0);
  assert.equal(empty.timeline.latestDetail, "", "an empty package cannot refill its rejected headline");
  assert.equal(empty.timeline.latestTimeText, "");
  assert.equal(empty.timeline.statusEventAtMs, null);
  assert.equal(empty.timeline.semantic, "UNKNOWN");
  const ordinary = parcelToShipment({ ...rewardParcel, accountOrder: false, sourceProvider: "Cainiao" },
    [PHONE], NOW + 86400000)!;
  assert.equal(ordinary.timeline.tracks.length, 3,
    "this JD order rule cannot filter an ordinary carrier package");
  const deliveryOnly = parcelToShipment({ ...parcel, tracks: [
    parcel.tracks[0]!, { ...delivered, statusCode: "105", detail: "正在派送" },
  ] }, [PHONE], NOW + 86400000)!;
  assert.equal(deliveryOnly.timeline.semantic, "DELIVERY",
    "an order-completion timestamp cannot retain a false carrier terminal state");
  const noCarrierEnum = parcelToShipment({ ...parcel, tracks: [
    parcel.tracks[0]!, { ...delivered, statusCode: "" },
  ] }, [PHONE], NOW + 86400000)!;
  assert.equal(noCarrierEnum.timeline.semantic, "UNKNOWN",
    "a surviving signature sentence is not structured status evidence");
  assert.equal(noCarrierEnum.timeline.statusEventAtMs, null);
  const independentStatus = withoutJingDongOrderCompletion({
    ...first.timeline, latestDetail: completion, latestTimeText: "2026-09-04 18:00:00",
    tracks: [{ ...first.timeline.tracks[0]!, detail: completion,
      timeMs: NOW + 86400000, timeText: "2026-09-04 18:00:00" }, ...first.timeline.tracks],
  }, first.identity);
  assert.equal(independentStatus.semantic, first.timeline.semantic,
    "an independently established carrier status remains unchanged");
  assert.equal(independentStatus.statusEventAtMs, first.timeline.statusEventAtMs);

  const directParcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: "JDAP123456789012", cpCode: "JD", name: "京东快递", provider: "JingDong",
    receiverPhone: PHONE, stateNum: 107,
    details: [{ time: "2026-09-04 18:00:00", desc: completion },
      { time: "2026-09-03 17:00:00", desc: "您的快件已送达至【家门口】", statusCode: "107" }],
  }] } })[0]!;
  assert.equal(directParcel.accountOrder, false);
  assert.equal(directParcel.ownerId, directParcel.waybill,
    "the direct-waybill parser uses the waybill as its owner identity");
  assert.equal(directParcel.orderId, "");
  const direct = parcelToShipment(directParcel, [PHONE], NOW + 86400000)!;
  assert.equal(direct.timeline.tracks.length, 1,
    "a JD business-source parcel already identified by waybill rejects the same shopping event");
  assert.equal(direct.timeline.semantic, "COMPLETED");
  assert.equal(direct.timeline.latestDetail, "您的快件已送达至【家门口】");
  assert.equal(direct.timeline.statusEventAtMs, Date.UTC(2026, 8, 3, 9));
  assert.equal(withoutJingDongOrderCompletion({ ...direct.timeline,
    latestDetail: reward, tracks: [{ ...direct.timeline.tracks[0]!, detail: reward }],
  }, { ...direct.identity, manuallyAdded: true }).tracks.length, 1,
  "a manually added JD carrier is outside the shopping-source rule");
}

console.log("account order continuity tests passed");
