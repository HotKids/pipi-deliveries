import assert from "node:assert/strict";
import type { NormalizedStatus, TrackNode } from "../models";
import { latestEventEvidence, latestTimelineTrackStatuses, parseProviderTime } from "../services/status";
import { nodeNormalizedStatus } from "../services/worker-status";

// 用户定 2026-10-01（「两边都改」）三端同一读法：节点上 structured=false、code 为空的 Worker 投影只说「这个节点
// 没有枚举」，不算节点的状态，节点自己的原始枚举照旧作数；code 非空的未知仍是权威的 UNKNOWN。iOS 现有的接口
// 5 / 6 节点下面没有被它挡住的原始枚举，这里只锁住读法。全部是合成数据。
const placeholder: NormalizedStatus = { version: 1, scope: "SHIPMENT", semantic: "UNKNOWN", code: "",
  text: "暂无状态", priority: 0, eventAtMs: 0, structured: false };
const explicit: NormalizedStatus = { ...placeholder, code: "FUTURE_WIRE_ENUM" };
const timeText = "2026-09-30 10:00:00";

function node(projection: NormalizedStatus): TrackNode {
  return { timeText, timeMs: parseProviderTime(timeText), detail: "快件离开【测试转运中心】",
    statusCode: "3", raw: { statusCode: "3", _pipiStatusSource: "kuaidi100", normalizedStatus: projection } };
}

assert.equal(nodeNormalizedStatus({ normalizedStatus: placeholder }), undefined);
assert.deepEqual(nodeNormalizedStatus({ normalizedStatus: explicit }), explicit);

assert.deepEqual(latestTimelineTrackStatuses([node(placeholder)]), ["COMPLETED"]);
assert.deepEqual(latestTimelineTrackStatuses([node(explicit)]), ["UNKNOWN"]);

const evidence = latestEventEvidence([node(placeholder)]);
assert.equal(evidence.semantic, "COMPLETED");
assert.equal(evidence.eventAtMs, parseProviderTime(timeText));
assert.equal(latestEventEvidence([node(explicit)]).semantic, "UNKNOWN");

console.log("Worker node placeholder tests passed");
