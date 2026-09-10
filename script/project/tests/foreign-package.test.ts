import assert from "node:assert/strict";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import {
  FOREIGN_PACKAGE_ANCHOR_SLACK_MS,
  applyManualShipment,
  foreignPackageAnchorMs,
  mergeAutomaticSourceTimeline,
  isForeignManualPackage,
  selectShipmentDetailTimeline,
} from "../services/shipment-policy";

// AGENTS §9 / plan R-29 (user decision 2026-09-03): a Picker / K100 H5 / KDNiao package whose nodes
// predate the account order's first feed node by more than a day belongs to another parcel. The
// JT order created on 2026-09-03 received 14 EMS nodes from 2025-11 out of Kuaidi100.
const ORDER_CREATED = Date.UTC(2026, 8, 3, 6, 49, 35);
const PICKUP = ORDER_CREATED + 3 * 60 * 60 * 1000;

function track(timeMs: number, detail: string, extra: Record<string, unknown> = {}): TrackNode {
  return {
    timeText: new Date(timeMs).toISOString(),
    timeMs,
    detail,
    statusCode: "",
    raw: extra,
  };
}

function pkg(provider: string, tracks: TrackNode[], overrides: Partial<TimelinePackage> = {}): TimelinePackage {
  return {
    provider,
    waybill: "JT4006839564547",
    courierCode: "JTSD",
    companyName: "极兔速递",
    semantic: "TRANSIT",
    statusEventAtMs: tracks[0]?.timeMs ?? null,
    latestTimeText: tracks[0]?.timeText ?? "",
    latestDetail: tracks[0]?.detail ?? "",
    tracks,
    successAtMs: PICKUP,
    complete: true,
    ...overrides,
  };
}

const accountPackage = pkg("interface5", [
  track(ORDER_CREATED + 2 * 60 * 60 * 1000, "您的订单由第三方卖家拣货完成，待出库交付极兔速递"),
  track(ORDER_CREATED, "您提交了订单，请等待第三方卖家系统确认"),
], { complete: false, courierCode: "JD", companyName: "京东购物" });

const order: Shipment = {
  identity: {
    id: "interface5:account:3610448002878202",
    bindingSource: "interface5",
    sourceOwner: "interface5:order",
    sourceId: "3610448002878202",
    phoneTail: "8098",
    phone: "13800008098",
    courierCode: "JTSD",
    rawCourierCode: "",
    companyName: "极兔速递",
    sourceProvider: "jingdong",
    orderId: "3610448002878202",
    projectedWaybill: "JT4006839564547",
    accountOrder: true,
    manuallyAdded: false,
    createdAtMs: ORDER_CREATED,
  },
  timeline: accountPackage,
  sourceTimeline: accountPackage,
  manualTimelines: [],
  route: null,
  accountRecord: null,
  updatedAtMs: PICKUP,
};

assert.equal(foreignPackageAnchorMs(order), ORDER_CREATED - FOREIGN_PACKAGE_ANCHOR_SLACK_MS);

const foreignEms = pkg("kuaidi100_h5", [
  track(Date.UTC(2025, 10, 18, 7, 3, 4), "您的快件已代收【物业代收】", { _pipiKuaidi100Com: "jtexpress" }),
  track(Date.UTC(2025, 10, 17, 1, 0, 0), "快件正在派送中", { _pipiKuaidi100Com: "jtexpress" }),
]);
const genuinePicker = pkg("meizu", [track(PICKUP + 60 * 60 * 1000, "取货调度，取货员：杨江01")], { complete: false });
const sameDayKdniao = pkg("kdniao", [
  track(PICKUP, "【DK江门维达网点】的谭秀文已取件"),
  track(ORDER_CREATED - 12 * 60 * 60 * 1000, "揽收前一天的仓内备货"),
]);

assert.equal(isForeignManualPackage(order, foreignEms), true);
assert.equal(isForeignManualPackage(order, genuinePicker), false);
assert.equal(isForeignManualPackage(order, sameDayKdniao), false, "within one day of the first feed node is not foreign");
assert.equal(isForeignManualPackage(order, accountPackage), false, "the account package is the anchor, never foreign");

// 用户 2026-09-08 报：签收之后账号 feed 只剩最近几条（派送、签收），起点早被它自己截掉了。
// 拿这种摘要的最早一条当「第一条」锚，这一票从揽收开始的历史整包被判成别人的包裹丢掉，于是
// 手动刷回来的轨迹下一轮又没了。feed 自己没到起点就没资格当锚——一条也好两条也好都一样。
const signedSummary = pkg("interface5", [
  track(PICKUP + 5 * 24 * 60 * 60 * 1000, "您的快件已签收"),
  track(PICKUP + 5 * 24 * 60 * 60 * 1000 - 3600 * 1000, "快件正在派送中"),
]);
const signedSummaryOnly: Shipment = {
  ...order,
  timeline: signedSummary,
  sourceTimeline: signedSummary,
};
assert.equal(foreignPackageAnchorMs(signedSummaryOnly), null);
assert.equal(
  isForeignManualPackage(signedSummaryOnly, genuinePicker),
  false,
  "a one-node signed feed summary must not condemn the parcel's own history",
);
assert.equal(isForeignManualPackage(signedSummaryOnly, sameDayKdniao), false);

// No anchor without an account order or without timed feed nodes.
const manual: Shipment = {
  ...order,
  identity: { ...order.identity, accountOrder: false, manuallyAdded: true },
  sourceTimeline: null,
  timeline: foreignEms,
};
assert.equal(foreignPackageAnchorMs(manual), null);
assert.equal(isForeignManualPackage(manual, foreignEms), false);
// Only the feed's own timed nodes anchor the package. Without them there is no anchor at all:
// `identity.createdAtMs` is when this device first saw the order, so a late binding (an
// already-shipped order backfilled on first sync) would otherwise discard its real history.
const untimedOrder: Shipment = {
  ...order,
  sourceTimeline: pkg("interface5", [], { complete: false }),
  timeline: pkg("interface5", [], { complete: false }),
};
assert.equal(foreignPackageAnchorMs(untimedOrder), null);
assert.equal(isForeignManualPackage(untimedOrder, foreignEms), false);
assert.equal(isForeignManualPackage(untimedOrder, genuinePicker), false);
const lateBinding: Shipment = {
  ...order,
  identity: { ...order.identity, createdAtMs: ORDER_CREATED + 3 * 24 * 60 * 60 * 1000 },
};
assert.equal(foreignPackageAnchorMs(lateBinding), ORDER_CREATED - FOREIGN_PACKAGE_ANCHOR_SLACK_MS);
assert.equal(isForeignManualPackage(lateBinding, genuinePicker), false);

// Applying a foreign result never caches it; a genuine one still merges.
const foreignResult: Shipment = {
  ...order,
  timeline: foreignEms,
  sourceTimeline: null,
  manualTimelines: [foreignEms],
};
const afterForeign = applyManualShipment(order, foreignResult, PICKUP + 1);
assert.deepEqual(afterForeign.manualTimelines, []);
assert.equal(selectShipmentDetailTimeline(afterForeign).provider, "interface5");

const pickerResult: Shipment = {
  ...order,
  timeline: genuinePicker,
  sourceTimeline: null,
  manualTimelines: [genuinePicker],
};
const afterPicker = applyManualShipment(afterForeign, pickerResult, PICKUP + 2);
assert.equal(afterPicker.manualTimelines?.length, 1);
assert.equal(afterPicker.manualTimelines?.[0].provider, "meizu");

// An older cache that still carries the foreign package is repaired at selection time.
const staleCache: Shipment = { ...order, manualTimelines: [foreignEms, genuinePicker] };
const selected = selectShipmentDetailTimeline(staleCache);
assert.notEqual(selected.provider, "kuaidi100_h5");
assert.equal(selected.tracks.some((item) => item.detail.includes("物业代收")), false);



// Completion can stop a query, but cannot anchor the beginning of a parcel's history.
const completionSummary = pkg("interface5", [track(PICKUP + 5 * 86400000, "订单已完成配送")]);
assert.equal(foreignPackageAnchorMs({ ...order, sourceTimeline: completionSummary }), null);
const accumulatedFeed = mergeAutomaticSourceTimeline(accountPackage, completionSummary);
assert.equal(foreignPackageAnchorMs({ ...order, sourceTimeline: accumulatedFeed }),
  ORDER_CREATED - FOREIGN_PACKAGE_ANCHOR_SLACK_MS);
assert.equal(isForeignManualPackage({ ...order, sourceTimeline: accumulatedFeed }, foreignEms), true);
assert.equal(isForeignManualPackage({ ...order, sourceTimeline: accumulatedFeed }, genuinePicker), false);

console.log("foreign package tests passed");
