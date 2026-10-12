import assert from "node:assert/strict";
import { NOW } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { TrackNode } from "../models";
import { parcelToShipment } from "../services/account-sync";
import { selectShipmentTimeline, shipmentSelectionEvidence } from "../services/shipment-policy";
import { parseProviderTime } from "../services/status";

// 2026-09-24（问题 3）：京东列表的完成事件是评价文案（被拦掉）或不带节点，feed 能显示的最新一条停在
// 更早的「派送中」，首页于是「已签收」配「派送中」；详情页选中的京粉页包里有签收节点。已签收且 feed
// 表头落后于完成时间时，表头改取详情排第一的包；在途件仍由 feed 定表头（AGENTS §9，见
// jd-h5-detail-selection.test.ts）。

const PHONE = "13800001906";
const ORDER = "3999999100001906";
const WAYBILL = "JD9990000001906";
const DELIVERING = "您的订单正在派送中，请您准备签收（快递员：测试员，电话：19900000000）";
const SIGNED = "您的订单已送达至【家门口有问题，联系快递员。】。如有疑问您可以联系配送员【测试员，" +
  "19900000000】确认。感谢您在京东购物，欢迎再次光临。";
const REVIEW = `您的订单${ORDER}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。`;
const at = (text: string) => parseProviderTime(text)!;

const H5_TRACKS: readonly [string, string][] = [
  ["2026-09-23 11:12:23", SIGNED],
  ["2026-09-23 08:02:00", DELIVERING],
  ["2026-09-23 07:23:00", "您的订单已到达【深圳万丰站】"],
  ["2026-09-22 20:00:00", "您的订单已由京东快递揽收"],
];

function h5Tracks(nodes: readonly [string, string][] = H5_TRACKS): TrackNode[] {
  return nodes.map(([timeText, detail]) => ({
    timeText, timeMs: at(timeText), detail, statusCode: "",
    raw: { _pipiStatusSource: "jingdong_h5" },
  }));
}

type RowOptions = Readonly<{
  completedAtText?: string;
  h5?: readonly [string, string][];
  successAtText?: string;
  sourceProvider?: string;
  semantic?: "COMPLETED" | "DELIVERY";
}>;

function completedRow(feedTracks: readonly [string, string][], options: RowOptions = {}) {
  const completedAt = at(options.completedAtText ?? "2026-09-23 11:12:27");
  const tracks = h5Tracks(options.h5);
  const semantic = options.semantic ?? "COMPLETED";
  const stateText = semantic === "COMPLETED" ? "已完成" : "派送中";
  const parcel: AccountParcelDto = {
    source: "interface5", ownerId: ORDER, orderId: ORDER,
    accountOrder: true, waybill: WAYBILL, courierCode: "JD", rawCourierCode: "JDKD",
    companyName: "京东快递", sourceProvider: options.sourceProvider ?? "JingDong",
    sourceStateCode: semantic === "COMPLETED" ? "107" : "105",
    sourceStateText: stateText, semantic, normalizedStatusScope: "ORDER",
    normalizedStatusSemantic: semantic, normalizedStatusText: stateText,
    normalizedStatus: {
      version: 1, scope: "ORDER", semantic, code: semantic === "COMPLETED" ? "107" : "105",
      text: stateText, priority: 0, eventAtMs: completedAt, structured: true,
    },
    receiverPhone: PHONE, senderPhone: "", latestTimeText: feedTracks[0]![0],
    latestDetail: feedTracks[0]![1], routeUrl: "", projectionUrl: "",
    tracks: feedTracks.map(([timeText, detail]) => ({ timeText, detail, statusCode: "" })),
    projectionTimeline: {
      provider: "jd_h5", waybill: WAYBILL, courierCode: "JD", companyName: "京东快递",
      semantic: "UNKNOWN", structuredStatus: false, complete: true, tracks,
      // Captured after the completion (11:12:27): only such a page may replace a first-signing review (2026-09-27).
      latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail,
      successAtMs: at(options.successAtText ?? "2026-09-23 11:12:30"),
    },
  } as AccountParcelDto;
  return parcelToShipment(parcel, [PHONE], NOW)!;
}

// 列表最新的是评价文案（会被拦掉），再往前只有派送中：表头取京粉页里的签收节点。
{
  const row = completedRow([
    ["2026-09-23 11:12:27", REVIEW],
    ["2026-09-23 08:02:00", DELIVERING],
  ]);
  const home = selectShipmentTimeline(row);
  assert.equal(home.semantic, "COMPLETED");
  assert.equal(home.latestDetail, SIGNED);
  assert.equal(home.latestTimeText, "2026-09-23 11:12:23");
  assert.equal(shipmentSelectionEvidence(row).headlineProvider, "jd_h5");
}

// feed 自己已经带着签收节点，但最新一条是保留下来的评价：2026-09-27 起表头取详情排第一的京粉页里晚于账号最后一条的
// 节点；用户 2026-09-28「改成严格晚于」：京粉页最新一条（签收 11:12:23）与账号最后一条同一时间，表头仍是这条评价。
{
  const row = completedRow([
    ["2026-09-23 11:12:27", REVIEW],
    ["2026-09-23 11:12:23", SIGNED],
    ["2026-09-23 08:02:00", DELIVERING],
  ]);
  const home = selectShipmentTimeline(row);
  assert.equal(home.latestDetail, REVIEW);
  assert.equal(home.latestTimeText, "2026-09-23 11:12:27");
  assert.notEqual(shipmentSelectionEvidence(row).headlineProvider, "jd_h5");
}

// Lite Fold7 2026-09-24 实测：京粉页在签收前抓过一次，重抓后同源增量合并，包上存的表头字段还停在第一次
// 那条（09-22 22:12:48），轨迹里却已有 11:12:23 的签收，首页表头随之倒退。iOS 的同源合并会按轨迹重读表头，
// 但三端同一口径：表头只认轨迹里最新的有效节点，不读包上存的字段。
{
  const row = completedRow([
    ["2026-09-23 11:12:27", REVIEW],
    ["2026-09-23 08:02:00", DELIVERING],
  ]);
  const stale = {
    ...row,
    manualTimelines: (row.manualTimelines || []).map(timeline => timeline.provider === "jd_h5"
      ? {
        ...timeline,
        latestTimeText: "2026-09-22 22:12:48",
        latestDetail: "您的订单已离开【佛山博展三期接货仓】，正在发往下一站【佛山狮山集散分拣中心】的路上",
      }
      : timeline),
  };
  assert.ok((stale.manualTimelines || []).some(timeline => timeline.provider === "jd_h5"));
  const home = selectShipmentTimeline(stale);
  assert.equal(home.latestDetail, SIGNED);
  assert.equal(home.latestTimeText, "2026-09-23 11:12:23");
}

// 用户 2026-10-01「改成「不晚于」，三端一起」：feed 自己最新的一条就是签收，结构化完成时间与它相同。详情排第一的
// 京粉页（完成之后抓到）里有严格晚于它的节点时，表头换成那个节点；状态、结构化时间不动。
const FEED_SIGNED = `${SIGNED}（feed）`;
const HANDED_OVER = "您的订单已签收，签收人：本人";
const FEED_SIGNED_AT_NEWEST: readonly [string, string][] = [
  ["2026-09-23 11:12:23", FEED_SIGNED],
  ["2026-09-23 08:02:00", DELIVERING],
];
const LATER_H5: readonly [string, string][] = [["2026-09-23 11:20:00", HANDED_OVER], ...H5_TRACKS];
const signedAtNewest = (options: RowOptions = {}) => completedRow(FEED_SIGNED_AT_NEWEST, {
  completedAtText: "2026-09-23 11:12:23", h5: LATER_H5, successAtText: "2026-09-23 11:20:30", ...options,
});
{
  const row = signedAtNewest();
  assert.equal(row.timeline.latestTimeText, "2026-09-23 11:12:23");
  const unswapped = selectShipmentTimeline({ ...row, manualTimelines: [] });
  const home = selectShipmentTimeline(row);
  assert.equal(home.latestDetail, HANDED_OVER);
  assert.equal(home.latestTimeText, "2026-09-23 11:20:00");
  assert.equal(home.semantic, "COMPLETED");
  assert.equal(home.structuredStatus, true);
  assert.equal(home.statusEventAtMs, at("2026-09-23 11:12:23"));
  const evidence = shipmentSelectionEvidence(row);
  assert.equal(evidence.headlineProvider, "jd_h5");
  assert.equal(evidence.statusProvider, "interface5");
  // Interface 5 rows draw their history from the top-ranked package with or without this exception (the same
  // jd_h5 history as the unchanged guard below); the exception replaces only the two headline fields.
  assert.equal(evidence.historyProvider, "jd_h5");
  // The feed's own presentation without the detail package: same status and status time.
  assert.equal(unswapped.latestDetail, FEED_SIGNED);
  assert.equal(unswapped.semantic, home.semantic);
  assert.equal(unswapped.statusEventAtMs, home.statusEventAtMs);
}

// 同上，京粉页最新一条与 feed 的签收同一时间：不是严格晚于，表头不换。
{
  const row = signedAtNewest({ h5: H5_TRACKS });
  const home = selectShipmentTimeline(row);
  assert.equal(home.latestDetail, FEED_SIGNED);
  assert.equal(home.latestTimeText, "2026-09-23 11:12:23");
  assert.equal(shipmentSelectionEvidence(row).historyProvider, "jd_h5");
  assert.equal(shipmentSelectionEvidence(row).headlineProvider, "interface5");
}

// 同上，唯一的京粉页是在完成之前抓的，没有晚于 feed 的节点：表头不换（这一支不看抓取时间，靠「严格晚于」挡住）。
{
  const home = selectShipmentTimeline(signedAtNewest({
    h5: H5_TRACKS.slice(1), successAtText: "2026-09-23 09:00:00",
  }));
  assert.equal(home.latestDetail, FEED_SIGNED);
  assert.equal(home.latestTimeText, "2026-09-23 11:12:23");
}

// 不是京东来源：例外不适用，表头不因它换成京粉页的节点。
{
  const row = signedAtNewest({ sourceProvider: "CaiNiao" });
  assert.notEqual(shipmentSelectionEvidence(row).headlineProvider, "jd_h5");
  assert.equal(selectShipmentTimeline(row).latestDetail, FEED_SIGNED);
  assert.equal(selectShipmentTimeline(row).latestTimeText, "2026-09-23 11:12:23");
}

// 没签收（派送中，结构化时间就是 feed 最新一条）：表头仍归 feed。
{
  const row = completedRow([
    ["2026-09-23 08:02:00", DELIVERING],
    ["2026-09-22 20:00:00", "您的订单已由京东快递揽收"],
  ], { completedAtText: "2026-09-23 08:02:00", h5: LATER_H5, semantic: "DELIVERY",
    successAtText: "2026-09-23 11:20:30" });
  const home = selectShipmentTimeline(row);
  assert.equal(home.semantic, "DELIVERY");
  assert.equal(home.latestDetail, DELIVERING);
  assert.equal(home.latestTimeText, "2026-09-23 08:02:00");
}

console.log("jd completed stale headline tests passed");
