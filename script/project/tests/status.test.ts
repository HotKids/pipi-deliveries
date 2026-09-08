import assert from "node:assert/strict";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import {
  accountOrderSemantic,
  buildWidgetSnapshot,
  containsTimelineStartTrack,
  manualTimelineIsComplete,
  mergeTimelinePackage,
  mergeTracks,
  NOTE_SEPARATOR,
  packageSemantic,
  parseProviderTime,
  pruneShipments,
  selectTimelineAuthority,
  semanticFromAccountState,
  semanticFromText,
  shipmentDetailPresentationStatus,
  shipmentPresentationStatus,
  shouldRefreshShipment,
  sortShipments,
  statusLabel,
  statusTint,
  widgetStatusLabel,
  withNote,
  withShipmentNote,
} from "../services/status";
import { parseAccountSyncResponse } from "../services/account-parser";

const NOW = Date.UTC(2026, 7, 26, 4, 0, 0);

function track(
  timeText: string,
  detail: string,
  statusCode: string,
): TrackNode {
  return {
    timeText,
    timeMs: parseProviderTime(timeText),
    detail,
    statusCode,
    raw: { statusCode },
  };
}

function pack(
  semantic: TimelinePackage["semantic"],
  tracks: TrackNode[],
): TimelinePackage {
  const latest = tracks[0];
  return {
    provider: "kuaidi100",
    waybill: "SF2026000147",
    courierCode: "shunfeng",
    companyName: "顺丰速运",
    semantic,
    statusEventAtMs: latest?.timeMs || null,
    latestTimeText: latest?.timeText || "",
    latestDetail: latest?.detail || "",
    tracks,
    successAtMs: NOW,
  };
}

function shipment(
  id: string,
  semantic: TimelinePackage["semantic"],
  eventAtMs: number,
): Shipment {
  const node = track(
    new Date(eventAtMs).toISOString(),
    semantic,
    semantic === "COMPLETED" ? "3" : "",
  );
  return {
    identity: {
      id,
      bindingSource: null,
      sourceOwner: "manual",
      sourceId: id,
      phoneTail: "",
      courierCode: "demo",
      companyName: id,
      manuallyAdded: true,
      createdAtMs: eventAtMs,
    },
    timeline: {
      ...pack(semantic, [node]),
      waybill: id,
      companyName: id,
      statusEventAtMs: eventAtMs,
    },
    updatedAtMs: eventAtMs,
  };
}

assert.equal(
  parseProviderTime("2026-08-26 10:00:00"),
  Date.UTC(2026, 7, 26, 2, 0, 0),
);
assert.equal(parseProviderTime("2026-02-30 10:00:00"), null);
assert.equal(parseProviderTime("2026-08-26T24:00:00"), null);
assert.equal(parseProviderTime("2026-08-26T10:00:00Z"), null);
assert.equal(accountOrderSemantic("订单已完成", "ORDERED"), "COMPLETED");
assert.equal(accountOrderSemantic("您的订单已由京东快递揽收", "PICKED"), "ORDERED");
assert.equal(accountOrderSemantic("运输中", "TRANSIT"), "TRANSIT");
assert.equal(semanticFromAccountState(106, ""), "WAITING_PICKUP");
assert.equal(semanticFromAccountState("107", ""), "COMPLETED");
assert.equal(widgetStatusLabel("DANGER"), "异常件");
assert.equal(widgetStatusLabel("UNKNOWN"), "暂无状态");
assert.equal(statusTint("COMPLETED"), "systemTeal");
assert.equal(statusTint("DELIVERY"), "systemGreen");
assert.equal(statusTint("ORDERED"), "systemYellow");
assert.equal(statusTint("CANCELLED"), "secondaryLabel");
assert.equal(
  containsTimelineStartTrack([
    track("2026-08-26 11:58:00", "快递已下单", ""),
  ]),
  true,
  "order prose must identify the start of the timeline",
);
assert.equal(
  containsTimelineStartTrack([
    track("2026-08-26 11:58:00", "操作完成", "101"),
  ]),
  true,
  "structured order codes must not depend on provider wording",
);
assert.equal(
  containsTimelineStartTrack([
    track("2026-08-26 11:55:00", "快件已揽收", ""),
  ]),
  true,
  "pickup prose must identify the earliest carrier scan",
);
assert.equal(semanticFromText("顺丰速运 已收取快件"), "PICKED");
// 「订单已完成配送」「配送完成」是送完了，不是刚下单（2026-09-08 更正，三端同改）。展示语义改成
// COMPLETED，起点闸门照旧关——这一票已经走完，没有更早的历史值得再抓，真值表一字不差。
assert.equal(
  semanticFromText("订单已完成配送，感谢您选择京东购物，期待再次为您服务"),
  "COMPLETED",
);
assert.equal(semanticFromText("配送完成"), "COMPLETED");
assert.equal(
  semanticFromText("您的订单已完成配送，包裹已放入丰巢快递柜，取件码 8-1-2345"),
  "WAITING_PICKUP",
  "a compound node keeps its pickup branch: the completion wording sits below it",
);
assert.equal(
  containsTimelineStartTrack([
    track("2026-09-07 20:48:38", "订单已完成配送，感谢您选择京东购物", ""),
  ]),
  true,
  "terminal order wording still closes the start gate (no new paid fallback)",
);
assert.equal(
  containsTimelineStartTrack([
    track("2026-09-05 10:00:00", "顺丰速运 已收取快件", ""),
  ]),
  true,
  "ShunFeng's pickup wording 已收取快件 closes the start gate too (2026-09-05)",
);
assert.equal(
  containsTimelineStartTrack([
    track("2026-08-26 11:55:00", "操作完成", "103"),
  ]),
  true,
  "structured pickup codes must not depend on provider wording",
);
const accountShipped = track(
  "2026-08-26 11:54:00",
  "状态更新",
  "102",
);
accountShipped.raw = {
  statusCode: "102",
  _pipiStatusSource: "interface5",
};
assert.equal(
  containsTimelineStartTrack([accountShipped]),
  false,
  "account state 102 means shipped and must not stop the fallback chain",
);
const pickerOrdered = track(
  "2026-08-26 11:53:00",
  "状态更新",
  "102",
);
pickerOrdered.raw = { statusCode: "102", _pipiStatusSource: "meizu" };
assert.equal(
  containsTimelineStartTrack([pickerOrdered]),
  true,
  "Picker event 102 means ordered and may stop the fallback chain",
);
assert.equal(
  containsTimelineStartTrack([
    track("2026-08-26 12:00:00", "运输中", "0"),
    track("2026-08-26 11:00:00", "已到达转运中心", "0"),
  ]),
  false,
  "track count alone must not mark a timeline as complete",
);

// One text→status table for the whole client. These three nodes were classified 已下单/待取件 by the
// account parser's private copy and UNKNOWN by this one, so the same row was 已下单 in the list and
// "no start node yet" to the fallback chain. The union is what survived the convergence.
const PICKING_NODE = "您的订单由第三方卖家拣货完成，待出库交付极兔速递";
const AGENT_PICKUP_NODE = "您的快递已放至代取件点，请及时领取";
assert.equal(semanticFromText(PICKING_NODE), "ORDERED");
assert.equal(semanticFromText(AGENT_PICKUP_NODE), "WAITING_PICKUP");
assert.equal(semanticFromText("包裹已送达，待领取"), "WAITING_PICKUP");
assert.equal(
  containsTimelineStartTrack([
    track("2026-09-03 17:22:00", PICKING_NODE, ""),
  ]),
  true,
  "the order feed's own start node must stop the KDNiao fallback chain",
);
const parserSemantics = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "79025657335746",
      cpCode: "ZTO",
      name: "中通快递",
      details: [{ time: "2026-09-03 17:22:00", desc: PICKING_NODE }],
    }, {
      mailNo: "79025657335747",
      cpCode: "ZTO",
      name: "中通快递",
      details: [{ time: "2026-09-03 17:22:00", desc: AGENT_PICKUP_NODE }],
    }],
  },
}).map((parcel) => parcel.semantic);
assert.deepEqual(
  parserSemantics,
  [semanticFromText(PICKING_NODE), semanticFromText(AGENT_PICKUP_NODE)],
  "the account parser must read node prose through this table, never through a copy of it",
);
assert.deepEqual(parserSemantics, ["ORDERED", "WAITING_PICKUP"]);

const manualDetailOwner = shipment("manual-detail-owner", "UNKNOWN", NOW);
const manualDetailTimeline = pack("COMPLETED", [
  track("2026-08-26 12:00:00", "已签收", "3"),
]);
assert.deepEqual(
  shipmentDetailPresentationStatus(manualDetailOwner, manualDetailTimeline),
  { semantic: "COMPLETED", text: "已签收" },
  "a manual detail header must follow the timeline displayed on that page",
);
const meizuPickerTimeline: TimelinePackage = {
  ...pack("PICKED", [
    track("2026-08-26 11:55:00", "快件已揽收", "1"),
  ]),
  provider: "route",
};
const manualWithMeizuPicker: Shipment = {
  ...manualDetailOwner,
  timeline: meizuPickerTimeline,
  manualTimelines: [meizuPickerTimeline, manualDetailTimeline],
};
assert.deepEqual(
  shipmentPresentationStatus(manualWithMeizuPicker),
  { semantic: "PICKED", text: statusLabel("PICKED") },
  "the Home row for a manual query must keep Meizu Picker status ownership",
);
assert.deepEqual(
  shipmentDetailPresentationStatus(
    manualWithMeizuPicker,
    manualDetailTimeline,
  ),
  { semantic: "PICKED", text: statusLabel("PICKED") },
  "a richer detail timeline must not replace an available Meizu Picker status",
);
const unknownTrackedDetail = pack("UNKNOWN", [
  track("2026-08-26 12:00:00", "快件经过深圳处理中心", ""),
]);
assert.deepEqual(
  shipmentDetailPresentationStatus(manualDetailOwner, unknownTrackedDetail),
  { semantic: "TRANSIT", text: "运输中" },
  "a raced timeline with real events must not leave a manual detail header without status",
);
const automaticDetailOwner: Shipment = {
  ...manualDetailOwner,
  identity: {
    ...manualDetailOwner.identity,
    manuallyAdded: false,
  },
};
assert.equal(
  shipmentDetailPresentationStatus(
    automaticDetailOwner,
    manualDetailTimeline,
  ).semantic,
  "UNKNOWN",
  "an automatic shipment must retain source-owned status presentation",
);

const pickup = track("2026-08-26 10:00:00", "已存放至驿站", "501");
const completed = packageSemantic("3", [pickup]);
assert.equal(completed.semantic, "COMPLETED");
assert.equal(pickup.statusCode, "501");

const newerHeadlineWithoutStatus = packageSemantic("", [
  {
    ...track("2026-08-26 11:00:00", "快件状态已更新", ""),
    raw: { time: "2026-08-26 11:00:00", context: "快件状态已更新" },
  },
  {
    ...track("2026-08-26 10:00:00", "已存放至驿站", "501"),
    raw: {
      time: "2026-08-26 10:00:00",
      context: "已存放至驿站",
      statusCode: "501",
    },
  },
]);
assert.equal(newerHeadlineWithoutStatus.semantic, "WAITING_PICKUP");

// The signed row is the one exit that keeps its stored headline while absorbing newer nodes; every
// other merge re-reads the headline from the merged set (see 更新头条 below).
const cachedComplete = pack("COMPLETED", [pickup]);
const laterTransit = pack("TRANSIT", [
  track("2026-08-26 11:00:00", "运输中", "0"),
]);
const frozenComplete = mergeTimelinePackage(cachedComplete, laterTransit);
assert.equal(frozenComplete.semantic, "COMPLETED");
assert.equal(frozenComplete.latestDetail, cachedComplete.latestDetail);
assert.equal(frozenComplete.tracks.length, 2);
assert.equal(frozenComplete.tracks[0]?.detail, "运输中");

const olderComplete = track("2026-08-25 09:00:00", "已签收", "3");
const refreshedComplete = pack("COMPLETED", [olderComplete]);
const mergedComplete = mergeTimelinePackage(cachedComplete, refreshedComplete);
assert.equal(mergedComplete.semantic, "COMPLETED");
assert.equal(mergedComplete.latestDetail, cachedComplete.latestDetail);
assert.equal(mergedComplete.tracks.length, 2);

const equalTimeAccount = {
  ...pack("TRANSIT", [track("2026-08-26 12:00:00", "账号轨迹", "0")]),
  provider: "interface6",
  successAtMs: NOW + 1,
};
const equalTimeK100 = {
  ...pack("TRANSIT", [track("2026-08-26 12:00:00", "兜底轨迹", "0")]),
  provider: "kuaidi100",
  successAtMs: NOW + 1,
};
assert.equal(
  selectTimelineAuthority(null, [equalTimeK100, equalTimeAccount])?.provider,
  "kuaidi100",
);

const retainedAccount = {
  ...pack("TRANSIT", [track("2026-08-26 12:00:00", "账号最新正文", "0")]),
  provider: "interface6",
  successAtMs: NOW + 1_000,
};
const staleAccountRefresh = {
  ...pack("UNKNOWN", [track("2026-08-26 11:00:00", "较旧账号节点", "")]),
  provider: "interface6",
  successAtMs: NOW + 3_000,
};
const refreshedAccount = mergeTimelinePackage(retainedAccount, staleAccountRefresh);
assert.equal(refreshedAccount.latestDetail, "账号最新正文");
assert.equal(refreshedAccount.successAtMs, NOW + 3_000);
const middleK100 = {
  ...pack("TRANSIT", [track("2026-08-26 12:30:00", "K100 正文", "0")]),
  provider: "kuaidi100",
  successAtMs: NOW + 2_000,
};
assert.equal(
  selectTimelineAuthority(null, [middleK100, refreshedAccount])?.provider,
  "kuaidi100",
);

const newerPartialMoto = {
  ...pack("TRANSIT", [track("2026-08-26 13:00:00", "部分轨迹", "0")]),
  provider: "moto",
  complete: false,
  successAtMs: NOW + 10_000,
};
const olderCompleteKdniao = {
  ...pack("TRANSIT", [track("2026-08-26 11:00:00", "完整轨迹", "0")]),
  provider: "kdniao",
  complete: true,
  successAtMs: NOW,
};
const oneTrackTerminalKdniao = {
  ...olderCompleteKdniao,
  semantic: "COMPLETED" as const,
  latestDetail: "快件已签收",
};
assert.equal(manualTimelineIsComplete(oneTrackTerminalKdniao), false);
assert.equal(manualTimelineIsComplete({
  ...oneTrackTerminalKdniao,
  tracks: [
    ...oneTrackTerminalKdniao.tracks,
    track("2026-08-25 08:00:00", "快件已揽收", "1"),
  ],
}), true);
const accumulatedTerminalKdniao = mergeTimelinePackage(
  oneTrackTerminalKdniao,
  {
    ...oneTrackTerminalKdniao,
    tracks: [track("2026-08-25 08:00:00", "快件已揽收", "1")],
    successAtMs: NOW + 1_000,
  },
);
assert.equal(accumulatedTerminalKdniao.complete, true);
assert.equal(manualTimelineIsComplete(accumulatedTerminalKdniao), true);
assert.equal(
  selectTimelineAuthority(null, [newerPartialMoto, olderCompleteKdniao])
    ?.provider,
  "kdniao",
  "a complete whole package must outrank a newer partial package",
);

// The package the KDNiao adapter actually writes carries provider "fallback" (manual-query.ts), so
// the terminal minimum has to be keyed by that id as well — keyed by "kdniao" alone the guard never
// ran outside these tests, and a one-node 已签收 answer froze the row as a complete package.
const oneTrackTerminalFallback = {
  ...oneTrackTerminalKdniao,
  provider: "fallback",
};
assert.equal(
  manualTimelineIsComplete(oneTrackTerminalFallback),
  false,
  "a signed fallback package with a single node is not a complete timeline",
);
assert.equal(manualTimelineIsComplete({
  ...oneTrackTerminalFallback,
  tracks: [
    ...oneTrackTerminalFallback.tracks,
    track("2026-08-25 08:00:00", "快件已揽收", "1"),
  ],
}), true);
const accumulatedTerminalFallback = mergeTimelinePackage(
  oneTrackTerminalFallback,
  {
    ...oneTrackTerminalFallback,
    tracks: [track("2026-08-25 08:00:00", "快件已揽收", "1")],
    successAtMs: NOW + 1_000,
  },
);
assert.equal(accumulatedTerminalFallback.complete, true);
assert.equal(manualTimelineIsComplete(accumulatedTerminalFallback), true);

const fresherCompleteK100 = {
  ...pack("TRANSIT", [track("2026-08-26 14:00:00", "更新完整轨迹", "0")]),
  provider: "kuaidi100",
  complete: true,
  successAtMs: NOW - 10_000,
};
assert.equal(
  selectTimelineAuthority(null, [olderCompleteKdniao, fresherCompleteK100])
    ?.provider,
  "kuaidi100",
);

const accumulatedComplete = mergeTimelinePackage(
  { ...olderCompleteKdniao, complete: true },
  {
    ...olderCompleteKdniao,
    complete: false,
    tracks: [track("2026-08-26 12:00:00", "增量节点", "0")],
    successAtMs: NOW + 20_000,
  },
);
assert.equal(accumulatedComplete.complete, true);

const structuredKdniao = {
  ...olderCompleteKdniao,
  structuredStatus: true,
};
const laterUnstructuredKdniao = {
  ...olderCompleteKdniao,
  structuredStatus: false,
  tracks: [track("2026-08-26 12:00:00", "基础 State 新状态", "")],
  statusEventAtMs: parseProviderTime("2026-08-26 12:00:00"),
  latestTimeText: "2026-08-26 12:00:00",
  latestDetail: "基础 State 新状态",
};
const mergedUnstructuredKdniao = mergeTimelinePackage(
  structuredKdniao,
  laterUnstructuredKdniao,
);
assert.equal(mergedUnstructuredKdniao.latestDetail, "基础 State 新状态");
assert.equal(mergedUnstructuredKdniao.structuredStatus, false);

const cachedRawMoto = {
  ...newerPartialMoto,
  rawCourierCode: "JDVD",
};
const newerMotoWithoutRaw = {
  ...newerPartialMoto,
  latestTimeText: "2026-08-26 14:00:00",
  latestDetail: "较新但无原码的旧格式响应",
  tracks: [track("2026-08-26 14:00:00", "较新但无原码的旧格式响应", "0")],
  successAtMs: NOW + 20_000,
};
assert.equal(
  mergeTimelinePackage(cachedRawMoto, newerMotoWithoutRaw).rawCourierCode,
  "JDVD",
  "a same-provider refresh in the legacy shape must not erase a persisted raw code",
);

const conflicting = mergeTracks(
  [track("2026-08-26 10:00:00", "同一节点", "501")],
  [track("2026-08-26 10:00:00", "同一节点", "3")],
);
assert.equal(conflicting.length, 2);

// 同包内同文案、5 分钟内的节点合并（用户定 2026-09-06，三端同 Pipi）：保留较新的一条，老的补空字段；
// 相隔更久的同文案仍是两条事件；结构化状态冲突的不合并。
{
  const nearDuplicates = mergeTracks(
    [track("2026-09-06 00:19:43", "预计9月6日发货，9月8日(周二)送达", "")],
    [track("2026-09-06 00:19:45", "预计9月6日发货，9月8日(周二)送达", "101")],
  );
  assert.equal(nearDuplicates.length, 1);
  assert.equal(nearDuplicates[0].timeText, "2026-09-06 00:19:45");
  assert.equal(nearDuplicates[0].statusCode, "101");
  const farApart = mergeTracks(
    [track("2026-09-05 13:48:17", "温馨提示：您的订单预计9月6日09:00-15:00送达", "")],
    [track("2026-09-05 14:28:08", "温馨提示：您的订单预计9月6日09:00-15:00送达", "")],
  );
  assert.equal(farApart.length, 2);
  const conflictingNear = mergeTracks(
    [track("2026-09-06 00:19:43", "您的快件已揽收完成", "501")],
    [track("2026-09-06 00:19:45", "您的快件已揽收完成。", "3")],
  );
  assert.equal(conflictingNear.length, 2, "conflicting structured codes are never collapsed");
  const punctuationOnly = mergeTracks(
    [track("2026-09-05 15:47:18", "您的快件已揽收完成。", "")],
    [track("2026-09-05 15:47:28", "您的快件已揽收完成", "")],
  );
  assert.equal(punctuationOnly.length, 1);
}

const cachedWithoutStatus = track(
  "2026-08-26 10:00:00",
  "  快件 已到达；  ",
  "",
);
const refreshedWithStatus = track(
  "2026-08-26 10:00:00",
  "快件 已到达",
  "501",
);
const supplemented = mergeTracks(
  [cachedWithoutStatus],
  [refreshedWithStatus],
);
assert.equal(supplemented.length, 1);
assert.equal(supplemented[0].statusCode, "501");
assert.equal(supplemented[0].detail, "快件 已到达");

const refreshedWithoutStatus = track(
  "2026-08-26 10:00:00",
  "快件 已到达！",
  "",
);
const retainedMetadata = mergeTracks(
  [refreshedWithStatus],
  [refreshedWithoutStatus],
);
assert.equal(retainedMetadata.length, 1);
assert.equal(retainedMetadata[0].statusCode, "501");
assert.equal(retainedMetadata[0].detail, "快件 已到达！");

const retainedStatusOnly = mergeTracks(
  [],
  [{
    timeText: "2026-08-26 12:00:00",
    timeMs: parseProviderTime("2026-08-26 12:00:00"),
    detail: "",
    statusCode: "501",
    raw: { time: "2026-08-26 12:00:00", statusCode: "501" },
  }],
);
assert.equal(retainedStatusOnly.length, 1);
assert.equal(retainedStatusOnly[0].statusCode, "501");

const equalTime = "2026-08-26 12:30:00";
const currentProgress = pack("TRANSIT", [track(equalTime, "运输中", "0")]);
const staleEqualTime = pack("ORDERED", [track(equalTime, "已下单", "101")]);
const equalTimeMerged = mergeTimelinePackage(currentProgress, staleEqualTime);
assert.equal(equalTimeMerged.semantic, "TRANSIT");
assert.equal(
  equalTimeMerged.latestDetail,
  "运输中",
  "an equal-time lower-stage response must not regress the current status",
);

// 更新头条: a same-provider refresh may carry strictly newer nodes and no recognizable state at all
// (「已发出」 matches no pattern), and the row must not keep showing 13:53 while tracks[0] is 14:57.
const retainedTransit = pack("TRANSIT", [
  track("2026-08-26 13:53:00", "快件已到达深圳中转场", "0"),
]);
const newerUnknownRefresh = pack("UNKNOWN", [
  track("2026-08-26 14:57:00", "您的快件已发出", ""),
  track("2026-08-26 14:52:00", "您的快件已打包", ""),
]);
const refreshedHeadline = mergeTimelinePackage(
  retainedTransit,
  newerUnknownRefresh,
);
assert.equal(
  refreshedHeadline.semantic,
  "TRANSIT",
  "an unrecognized refresh proves no new status",
);
assert.equal(refreshedHeadline.tracks[0]?.detail, "您的快件已发出");
assert.equal(
  refreshedHeadline.latestDetail,
  "您的快件已发出",
  "the headline must be the newest node of the merged set, not the retained summary",
);
assert.equal(refreshedHeadline.latestTimeText, "2026-08-26 14:57:00");

const compactableTracks = Array.from({ length: 170 }, (_, index) => ({
  ...track("2026-08-26 12:00:00", `运输节点 ${index}`, "0"),
  timeMs: NOW - index * 60_000,
}));
const oldestOrdered = compactableTracks[compactableTracks.length - 1];
oldestOrdered.detail = "快递已下单";
oldestOrdered.statusCode = "101";
oldestOrdered.raw = { statusCode: "101", _pipiStatusSource: "meizu" };
const compactedTracks = mergeTracks([], compactableTracks);
assert.ok(compactedTracks.length <= 160);
assert.equal(
  containsTimelineStartTrack(compactedTracks),
  true,
  "track compaction must retain the oldest order or pickup boundary",
);

// 备注（用户定 2026-09-05 晚）：状态词 · 备注，列表页、详情页、桌面卡片同一格式；没有备注就是状态词。
{
  const plain = shipment("noted", "TRANSIT", NOW - 60_000);
  assert.equal(withShipmentNote("运输中", plain), "运输中");
  assert.equal(withShipmentNote("运输中", { ...plain, note: "  " }), "运输中");
  assert.equal(
    withShipmentNote("运输中", { ...plain, note: "给妈妈的" }),
    `运输中${NOTE_SEPARATOR}给妈妈的`,
  );
  // 桌面卡片：行里状态词与备注分开带；4×2 用 withNote 拼，2×2 放不下只显示状态词（用户定 2026-09-06）。
  const notedWidget = buildWidgetSnapshot([{ ...plain, note: " 给妈妈的 " }], NOW);
  assert.equal(notedWidget.rows[0]?.statusLabel, "运输中");
  assert.equal(notedWidget.rows[0]?.note, "给妈妈的");
  assert.equal(withNote("运输中", notedWidget.rows[0]?.note), `运输中${NOTE_SEPARATOR}给妈妈的`);
  assert.equal(withNote("运输中", undefined), "运输中");
}

const widget = buildWidgetSnapshot([
  shipment("complete", "COMPLETED", NOW - 60_000),
  shipment("transit", "TRANSIT", NOW - 120_000),
  shipment("waiting", "WAITING_PICKUP", NOW - 180_000),
], NOW);
assert.equal(widget.headline?.semantic, "WAITING_PICKUP");
assert.equal(widget.activeCount, 2);
assert.deepEqual(widget.rows.map((row) => row.shipmentId), [
  "waiting",
  "transit",
  "complete",
]);

assert.deepEqual(
  sortShipments([
    shipment("complete", "COMPLETED", NOW),
    shipment("cancelled", "CANCELLED", NOW),
    shipment("unknown", "UNKNOWN", NOW),
    shipment("danger", "DANGER", NOW),
    shipment("ordered", "ORDERED", NOW),
    shipment("shipped", "SHIPPED", NOW),
    shipment("picked", "PICKED", NOW),
    shipment("transit", "TRANSIT", NOW),
    shipment("delivery", "DELIVERY", NOW),
    shipment("waiting", "WAITING_PICKUP", NOW),
  ]).map((item) => item.identity.id),
  [
    "waiting",
    "delivery",
    "transit",
    "picked",
    "shipped",
    "ordered",
    "danger",
    "unknown",
    "cancelled",
    "complete",
  ],
);

assert.equal(
  pruneShipments(
    [shipment("old-complete", "COMPLETED", NOW - 7 * 24 * 60 * 60 * 1000)],
    NOW,
  ).length,
  0,
);
assert.equal(
  pruneShipments(
    [shipment("old-cancelled", "CANCELLED", NOW - 4 * 60 * 60 * 1000)],
    NOW,
  ).length,
  0,
);

// 没有可信节点时间的终态行，倒计时以 settledAtMs 为准，不再被 updatedAtMs 的每次写入重置
// （用户 2026-09-07 报：签收七天之后又被带回列表）。
{
  const settled = shipment("settled-blank", "COMPLETED", NOW);
  const blank: Shipment = {
    ...settled,
    timeline: { ...settled.timeline, statusEventAtMs: null, tracks: [] },
    updatedAtMs: NOW,
  };
  assert.equal(
    pruneShipments([{ ...blank, settledAtMs: NOW - 8 * 24 * 60 * 60 * 1000 }], NOW).length,
    0,
    "settled eight days ago expires even though it was just written",
  );
  assert.equal(
    pruneShipments([{ ...blank, settledAtMs: NOW - 60_000 }], NOW).length,
    1,
    "settled a minute ago stays for its retention window",
  );
  // 倒计时只认终态戳，不许每轮拿展示包里的签收时间重算：详情页下拉把 8 天前的真实轨迹刷回来的
  // 那一刻，这一行会当场过期被整行删掉，下一轮列表同步又把它当新件导回来——新行只有 feed 槽，
  // 详情抓回来的整包轨迹全丢，界面成了「已签收 · 暂无物流动态」（用户 2026-09-08 报：一个个点进去
  // 把轨迹刷新出来，关掉重新打开又回来了）。老件照旧会过期——终态戳本来就是按来源给的终态事件
  // 时间盖的（见 stampSettledAt），feed 自己带签收时间的老件一进来就是过期的。
  const withHistory: Shipment = {
    ...blank,
    settledAtMs: NOW - 60_000,
    timeline: {
      ...blank.timeline,
      statusEventAtMs: NOW - 8 * 24 * 60 * 60 * 1000,
      tracks: [{
        timeMs: NOW - 8 * 24 * 60 * 60 * 1000,
        timeText: "",
        detail: "您的快件已签收，感谢使用",
      }],
    },
  };
  assert.equal(
    pruneShipments([withHistory], NOW).length,
    1,
    "a fresh settled stamp survives a detail refresh that reveals an older signature",
  );
  assert.equal(
    pruneShipments([{ ...withHistory, settledAtMs: undefined }], NOW).length,
    0,
    "without a stamp the signature itself still decides",
  );
}

// 用户 2026-09-08 报「又回来了」：早前被清空的签收行手上一条节点都没有，冻结却把这个空壳锁死，
// 列表永远写「暂无物流动态」且再也不会自己补回来。冻结保护的是已经有的轨迹，空壳照旧允许刷新。
{
  const settled = shipment("thaw-empty", "COMPLETED", NOW - 3 * 24 * 60 * 60 * 1000);
  const withHistory: Shipment = {
    ...settled,
    timeline: {
      ...settled.timeline,
      tracks: [{
        timeMs: NOW - 3 * 24 * 60 * 60 * 1000,
        timeText: "",
        detail: "您的快件已签收",
      }],
    },
  };
  assert.equal(
    shouldRefreshShipment(withHistory, NOW),
    false,
    "a settled row that still has its history stays frozen",
  );
  const emptied: Shipment = {
    ...withHistory,
    timeline: { ...withHistory.timeline, tracks: [] },
    sourceTimeline: null,
    manualTimelines: [],
  };
  assert.equal(
    shouldRefreshShipment(emptied, NOW),
    true,
    "a settled row with no timed node left must still be allowed to refill",
  );
}

console.log("status policy tests passed");
