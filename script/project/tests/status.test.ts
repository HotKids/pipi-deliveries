import assert from "node:assert/strict";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import {
  accountOrderSemantic,
  buildWidgetSnapshot,
  mergeTimelinePackage,
  mergeTracks,
  packageSemantic,
  parseProviderTime,
  pruneShipments,
  selectTimelineAuthority,
  semanticFromAccountState,
  sortShipments,
  statusTint,
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
assert.equal(accountOrderSemantic("订单已完成"), "ORDERED");
assert.equal(semanticFromAccountState(106, ""), "WAITING_PICKUP");
assert.equal(semanticFromAccountState("107", ""), "COMPLETED");
assert.equal(widgetStatusLabel("DANGER"), "异常件");
assert.equal(widgetStatusLabel("UNKNOWN"), "暂无状态");
assert.equal(statusTint("COMPLETED"), "systemGreen");

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
  "interface6",
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
  "interface6",
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

const widget = buildWidgetSnapshot([
  shipment("complete", "COMPLETED", NOW - 60_000),
  shipment("transit", "TRANSIT", NOW - 120_000),
  shipment("waiting", "WAITING_PICKUP", NOW - 180_000),
]);
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
