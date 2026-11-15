import type { Shipment, TimelinePackage, TrackNode } from "../models";
import {
  isAccountUpdateSummary,
  isJingDongOrderCompletionNode,
  isNonEventDetail,
  timedTracks,
  timelineCapability,
} from "./status";
import { normalizeTimelineSlot, TIMELINE_SLOT } from "./timeline-slot";
import { nodeNormalizedStatus } from "./worker-status";

/**
 * 京东订单阶段轨迹拼接与冗余订单完成伪节点过滤策略（`B-04` / `D-8`，2026-11-15 三端统一口径）：
 * 1. 当已选包裹具备真实承运商物流轨迹时，仅将早于承运商首条有效时间节点的账号订单阶段节点（下单、拣货、待出库等）
 *    按时间倒序整段接在承运商轨迹末尾，绝不穿插；
 * 2. 一旦承运商物流轨迹已存在，隐藏订单侧冗余的订单完成/评价伪节点（`ORDER` 作用域 `COMPLETED`、`订单已完成` 等），
 *    未揽收前（尚无承运商轨迹时）完整保留下单/拣货节点。
 */
export function isRedundantOrderCompletionTrack(
  track: TrackNode,
  ownerTimeline?: TimelinePackage | null,
  ownerShipment?: Shipment,
): boolean {
  const projected = nodeNormalizedStatus(track.raw);
  if (projected?.scope === "ORDER" && projected.semantic === "COMPLETED") {
    return true;
  }
  const statusDesc = String(
    track.raw?.logisticsStatusDesc || track.raw?.logisticStatusDesc || "",
  ).trim();
  if (statusDesc === "评价赢京豆") {
    return true;
  }
  const compact = track.detail.trim().replace(/\s+/g, "");
  if (!compact) return false;
  if (compact.includes("订单已完成") || compact === "订单完成") {
    return true;
  }
  if (ownerTimeline && ownerShipment) {
    return isJingDongOrderCompletionNode(ownerTimeline, ownerShipment.identity, track.detail);
  }
  return false;
}

/** Grafted JD H5 rows and provider-tagged rows are not the feed's own nodes (Pipi sameSourceOwnerTracks). */
function isOwnerFeedTrack(track: TrackNode): boolean {
  const tagged = String(track.raw?._pipiStatusSource || "").trim().toLowerCase();
  return !tagged || timelineCapability(tagged) === "account";
}

export function withAttachedOrderStage(
  shown: TimelinePackage,
  attachedOrders: readonly Shipment[],
  sourceTimelineOf: (shipment: Shipment) => TimelinePackage | null,
): TimelinePackage {
  if (!attachedOrders.length) return shown;
  const shownTimes = timedTracks(shown.tracks)
    .filter((track) => !isNonEventDetail(track.detail))
    .map((track) => track.timeMs as number);
  if (!shownTimes.length) return shown;
  const earliest = Math.min(...shownTimes);
  const seen = new Set<string>();
  const orderStage: TrackNode[] = [];
  for (const order of attachedOrders) {
    if (order.identity.manuallyAdded || !order.identity.accountOrder) continue;
    const orderFeed = sourceTimelineOf(order);
    for (const track of timedTracks(orderFeed?.tracks || [])) {
      if (
        (track.timeMs as number) >= earliest ||
        !track.detail.trim() ||
        isNonEventDetail(track.detail) ||
        isAccountUpdateSummary(track.detail) ||
        !isOwnerFeedTrack(track) ||
        isRedundantOrderCompletionTrack(track, orderFeed, order)
      ) {
        continue;
      }
      // Two attached orders can repeat one shared node.
      const key = `${track.timeMs}\u0000${track.detail.trim().replace(/\s+/g, "")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      orderStage.push(track);
    }
  }
  if (!orderStage.length) return shown;
  orderStage.sort((left, right) => (right.timeMs as number) - (left.timeMs as number));
  return { ...shown, tracks: [...shown.tracks, ...orderStage] };
}

export function withJingDongOwnerOrderStage(
  shipment: Shipment,
  selected: TimelinePackage,
  isJingDongSource: boolean,
  sourceTimelineOf: (shipment: Shipment) => TimelinePackage | null,
): TimelinePackage {
  if (shipment.identity.manuallyAdded || !isJingDongSource) return selected;
  const provider = selected.provider.trim().toLowerCase();
  if (
    timelineCapability(provider) === "account" ||
    normalizeTimelineSlot(provider) === TIMELINE_SLOT.JD_H5 ||
    provider === "jingdong_h5"
  ) {
    return selected;
  }
  const source = sourceTimelineOf(shipment);
  if (!source || source.provider.trim().toLowerCase() === provider) return selected;
  const fallbackTimes = timedTracks(selected.tracks).map((track) => track.timeMs as number);
  if (!fallbackTimes.length) return selected;
  const earliest = Math.min(...fallbackTimes);
  const orderStage = timedTracks(source.tracks)
    .filter((track) =>
      isOwnerFeedTrack(track) &&
      (track.timeMs as number) < earliest &&
      !isAccountUpdateSummary(track.detail) &&
      !isRedundantOrderCompletionTrack(track, source, shipment))
    .sort((left, right) => (right.timeMs as number) - (left.timeMs as number));
  if (!orderStage.length) return selected;
  return { ...selected, tracks: [...selected.tracks, ...orderStage] };
}
