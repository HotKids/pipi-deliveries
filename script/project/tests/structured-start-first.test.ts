import assert from "node:assert/strict";
import type { NormalizedStatus, TrackNode } from "../models";
import {
  containsTimelineOriginTrack,
  containsTimelinePickupTrack,
  containsTimelineStartTrack,
  parseProviderTime,
} from "../services/status";

// 用户定 2026-10-02「三端统一改成结构化优先」（Pipi 2026-10-01「结构化优先」）：起点 / 揽收闸门里，节点有真实
// 结构化状态时由状态定；揽收、下单、终点文案只认没有结构化状态的节点。占位投影（structured=false、code 为空）
// 不算结构化状态，起点词表本身不变。合成数据，形状照 Pixel 尾号 7407 那一类：配了 TRANSPORT 的「您的快件已揽收完成」。
const placeholder: NormalizedStatus = { version: 1, scope: "SHIPMENT", semantic: "UNKNOWN", code: "",
  text: "暂无状态", priority: 0, eventAtMs: 0, structured: false };
const picked: NormalizedStatus = { version: 1, scope: "SHIPMENT", semantic: "PICKED", code: "ACCEPT",
  text: "已揽件", priority: 0, eventAtMs: parseProviderTime("2026-09-27 08:00:52")!, structured: true };
const timeText = "2026-09-27 08:00:52";

function node(detail: string, statusCode = "", projection?: NormalizedStatus): TrackNode {
  return { timeText, timeMs: parseProviderTime(timeText), detail, statusCode,
    raw: { ...(statusCode ? { statusCode } : {}), ...(projection ? { normalizedStatus: projection } : {}) } };
}

// A structured TRANSPORT decides: the pickup, order and completion words on it are no start.
const transportPickup = node("您的快件已揽收完成", "TRANSPORT", placeholder);
assert.equal(containsTimelinePickupTrack([transportPickup]), false);
assert.equal(containsTimelineOriginTrack([transportPickup]), false);
assert.equal(containsTimelineStartTrack([transportPickup]), false);
assert.equal(containsTimelineStartTrack([node("您提交了订单，请等待第三方卖家系统确认", "TRANSPORT")]), false);
assert.equal(containsTimelineStartTrack([node("订单已完成配送，感谢您选择京东购物", "TRANSPORT")]), false);

// Text-only nodes still count, a no-enum placeholder included.
assert.equal(containsTimelinePickupTrack([node("您的快件已揽收完成")]), true);
assert.equal(containsTimelinePickupTrack([node("您的快件已揽收完成", "", placeholder)]), true);
assert.equal(containsTimelineOriginTrack([node("您提交了订单，请等待第三方卖家系统确认")]), true);
assert.equal(containsTimelineStartTrack([node("订单已完成配送，感谢您选择京东购物")]), true);

// A structured pickup still counts, by raw code or by Worker projection.
assert.equal(containsTimelinePickupTrack([node("快件离开【测试转运中心】", "ACCEPT")]), true);
assert.equal(containsTimelinePickupTrack([node("快件离开【测试转运中心】", "", picked)]), true);

console.log("Structured-first start gate tests passed");
