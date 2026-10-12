import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memory, NOW } from "./state-storage-mock";

import type { Shipment } from "../models";
import { carrierDisplayName, courierIconName, EMPTY_CARRIER_DISPLAY_NAME } from "../services/carrier-presentation";
import { shipmentNotificationEvent, shipmentNotificationPresentation } from "../services/notification-events";

// 其余裁决 35（用户 2026-09-27：「算了统一前面加 快递 两个字吧」）：承运商位置为空时，本地通知标题、列表行、小组件与
// 详情页头统一显示「快递」，例如「快递 0701 · 派送中」；有承运商名或原始码时照旧。只在展示层：存盘的 companyName 与查询用
// 的承运商码不动。取代 2026-09-15「不自造承运商名『快递』」在承运商为空这一种情形下的规定。

memory.clear();
assert.equal(EMPTY_CARRIER_DISPLAY_NAME, "快递");
assert.equal(carrierDisplayName(""), "快递");
assert.equal(carrierDisplayName("  "), "快递");
assert.equal(carrierDisplayName(undefined), "快递");
assert.equal(carrierDisplayName("中通快递"), "中通快递", "a carrier name is shown as it is");
assert.equal(carrierDisplayName("JDKD"), "JDKD", "a raw code is shown as it is");
assert.equal(carrierDisplayName("京东购物"), "京东购物");

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
function row(companyName: string, semantic: "TRANSIT" | "DELIVERY", at: number, detail: string): Shipment {
  const timeline = { provider: "v6_query", waybill: "MANUAL000000701", courierCode: "", companyName, semantic,
    structuredStatus: true, statusEventAtMs: at, latestTimeText: providerTime(at), latestDetail: detail,
    successAtMs: at, tracks: [{ timeMs: at, timeText: providerTime(at), detail, statusCode: "", raw: {} }] };
  return {
    identity: { id: "interface5:manual:MANUAL000000701", bindingSource: "interface5", sourceOwner: "manual",
      sourceId: "MANUAL000000701", phoneTail: "0701", courierCode: "", rawCourierCode: "", companyName,
      manuallyAdded: true, createdAtMs: NOW - 86400000 },
    timeline, sourceTimeline: null, manualTimelines: [timeline], updatedAtMs: at,
  };
}

// Notification title.
{
  const previous = row("", "TRANSIT", NOW - 86400000, "快件已到达【杭州转运中心】");
  const current = row("", "DELIVERY", NOW - 3600000, "【上海市】快件正在派送中");
  assert.equal(shipmentNotificationEvent(previous, current)?.title, "快递 0701 · 派送中");
  assert.equal(shipmentNotificationPresentation(current).title, "快递 0701 · 派送中");
  assert.equal(shipmentNotificationPresentation(row("JDKD", "DELIVERY", NOW, "x")).title, "JDKD 0701 · 派送中");
  assert.equal(shipmentNotificationPresentation(row("中通快递", "DELIVERY", NOW, "x")).title, "中通快递 0701 · 派送中");
  // Display only: the row keeps its empty carrier and its icon stays the generic one.
  assert.equal(current.identity.companyName, "");
  assert.equal(shipmentNotificationPresentation(current).iconName, null);
  assert.equal(courierIconName("", carrierDisplayName("")), courierIconName("", ""),
    "「快递」 resolves to no carrier, so no icon or colour changes with it");
}

// The list row, the widgets and the detail page header print the carrier through the same helper; the icon and the
// widget colours keep reading the stored name.
{
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const shipmentRow = source("../components/ShipmentRow.tsx");
  assert.match(shipmentRow, /\{carrierDisplayName\(item\.identity\.companyName\)\}/);
  assert.match(shipmentRow, /companyName=\{item\.identity\.companyName\}/, "the icon keeps the stored name");
  const detailPage = source("../pages/DetailPage.tsx");
  assert.match(detailPage, /<Text font=\{15\}>\{carrierDisplayName\(shipment\.identity\.companyName\)\}：<\/Text>/);
  const small = source("../widget/SmallWidget.tsx");
  assert.match(small, /`\$\{carrierDisplayName\(row\.companyName\)\} \$\{row\.waybillSuffix\}`/);
  assert.match(small, /:\s*carrierDisplayName\(row\.companyName\)\}/);
  const medium = source("../widget/MediumWidget.tsx");
  assert.match(medium, /\{carrierDisplayName\(props\.row\.companyName\)\} \{props\.row\.waybillSuffix\}/);
}

console.log("empty carrier display tests passed");
