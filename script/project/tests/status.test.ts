import assert from "node:assert/strict";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import {
  accountOrderSemantic,
  buildWidgetSnapshot,
  containsTimelineStartTrack,
  manualTimelineIsComplete,
  mergeTimelinePackage,
  mergeTracks,
  packageSemantic,
  parseProviderTime,
  pruneShipments,
  selectTimelineAuthority,
  semanticFromAccountState,
  shipmentDetailPresentationStatus,
  shipmentPresentationStatus,
  sortShipments,
  statusTint,
  statusLabel,
  widgetStatusLabel,
} from "../services/status";

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
assert.equal(statusTint("COMPLETED"), "systemGreen");
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

console.log("status policy tests passed");
