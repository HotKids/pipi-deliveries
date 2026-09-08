import { normalizeTimelineSlot, TIMELINE_SLOT } from "./timeline-slot";
import type {
  AutomaticOwnership,
  AutomaticSourceObservation,
  Shipment,
  TimelinePackage,
  TrackNode,
} from "../models";
import {
  accountOrderSemantic,
  compareTimelinePackageCompleteness,
  compareTimelineProviderOrder,
  containsTimelinePickupTrack,
  containsTimelineStartTrack,
  manualTimelineIsComplete,
  mergeTimelineAuthorities,
  mergeTimelinePackage,
  mergeTracks,
  normalizedProjectedWaybill,
  normalizeWaybill,
  selectTimelineAuthority,
  splitJingDongH5Nodes,
  timedTracks,
  timelineCapability,
  timelineLatestEventAt,
  withMergedHeadline,
} from "./status";
import { incomingStatusAdvances, latestEventEvidence } from "./status";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";

export const MANUAL_REFRESH_MIN_INTERVAL_MS = 30_000;
export const AUTOMATIC_TAKEOVER_COOLDOWN_MS = 2 * 60 * 60 * 1_000;
export const AUTOMATIC_OWNER_MISS_LIMIT = 1;
import { SCRIPT_BINDING_SOURCE } from "./script-source";
import { projectedCarrierPresentation } from "./carrier-presentation";
import {
  resolveCarrierCpCode,
  resolveCarrierKuaidi100Code,
  resolveCarrierQuery,
} from "./carrier-query";
import { normalizeCarrierCode } from "./carrier-query";

function sourceTimeline(shipment: Shipment): TimelinePackage | null {
  if (shipment.identity.manuallyAdded) return null;
  return shipment.sourceTimeline || shipment.timeline;
}

function manualTimelines(shipment: Shipment): TimelinePackage[] {
  if (Array.isArray(shipment.manualTimelines)) {
    return [...shipment.manualTimelines];
  }
  return shipment.identity.manuallyAdded ? [shipment.timeline] : [];
}

/**
 * AGENTS §9 (user decision 2026-09-03, plan R-29): a manual provider package (Picker / K100 H5 /
 * KDNiao) for an account-projected waybill whose nodes predate the order's own first feed node by
 * more than a day belongs to another parcel — reused waybills make K100 answer with a foreign
 * history (the JT order on 2026-09-03 received 14 EMS nodes from 2025-11). Such a package is
 * dropped whole, never cached, and never selected; an older cache is repaired the same way.
 */
export const FOREIGN_PACKAGE_ANCHOR_SLACK_MS = 24 * 60 * 60 * 1000;

function accountAnchorPackage(shipment: Shipment): TimelinePackage | null {
  if (!shipment.identity.accountOrder || shipment.identity.manuallyAdded) return null;
  if (shipment.sourceTimeline) return shipment.sourceTimeline;
  const provider = String(shipment.timeline?.provider || "").trim().toLowerCase();
  return provider === "interface5" || provider === "interface6" || provider === "account"
    ? shipment.timeline
    : null;
}

export function foreignPackageAnchorMs(shipment: Shipment): number | null {
  const anchor = accountAnchorPackage(shipment);
  if (!anchor) return null;
  const times = timedTracks(anchor.tracks)
    .map((track) => track.timeMs)
    .filter((value): value is number => typeof value === "number" && value > 0);
  // Only the feed's own nodes anchor the package (AGENTS §9, and the same rule in Pipi's
  // `ExpressDetailTimelinePolicy` and Lite's `ExpressTimeline`). `identity.createdAtMs` is when
  // this device first saw the order, not when the parcel was created: using it turned a late
  // binding — an already-shipped order backfilled on first sync — into a false "foreign" verdict
  // that threw away the parcel's real history.
  if (!times.length) return null;
  // R-29 锚的是这张订单 feed 的**第一条**节点。签收之后 feed 只回最新那一条（签收），它是终点
  // 不是起点：拿它当锚会把这一票自己的历史（从揽收开始，早好几天）整包判成「别人的包裹」丢掉，
  // 于是每一轮全量刷新之后详情页只剩 feed 那个 0 节点的包，列表写「暂无物流动态」
  // （用户 2026-09-08 报，尾号 0238；本轮定位实测 3 个包进、0 个包出）。
  // 只有一条带时间的节点时那是状态摘要，不是历史，不足以当起点锚。
  if (times.length < 2) return null;
  return Math.min(...times) - FOREIGN_PACKAGE_ANCHOR_SLACK_MS;
}

export function isForeignManualPackage(
  shipment: Shipment,
  timeline: TimelinePackage,
): boolean {
  const anchorMs = foreignPackageAnchorMs(shipment);
  if (anchorMs == null) return false;
  const provider = timeline.provider.trim().toLowerCase();
  if (provider === "interface5" || provider === "interface6" || provider === "account") {
    return false;
  }
  return timedTracks(timeline.tracks).some((track) =>
    typeof track.timeMs === "number" && track.timeMs > 0 && track.timeMs < anchorMs
  );
}

function withoutForeignManualPackages(
  shipment: Shipment,
  values: readonly TimelinePackage[],
): TimelinePackage[] {
  return values.filter((timeline) => !isForeignManualPackage(shipment, timeline));
}

export function isVerifiedKuaidi100Timeline(
  timeline: TimelinePackage,
): boolean {
  const rawProvider = timeline.provider.trim().toLowerCase();
  if (normalizeTimelineSlot(rawProvider) !== TIMELINE_SLOT.K100_H5) return false;
  const expected = resolveCarrierQuery(timeline.courierCode);
  const rawCourierCode = String(timeline.rawCourierCode || "").trim();
  const rawCarrier = rawCourierCode
    ? resolveCarrierKuaidi100Code(rawCourierCode)
    : null;
  const tracks = timedTracks(timeline.tracks);
  if (!tracks.length) return false;
  // picker 按这张运单号给的 detailUrl 那一页（web-timeline.ts，旧 id `web`）抓的包，信任锚是链接
  // 本身，可以不带 com 标记；只有直连抓取器的旧 id `kuaidi100_h5` 必须逐节点校验承运商标记。
  const marked = tracks.some((track) =>
    String(track.raw?._pipiKuaidi100Com || "").trim()
  );
  if (!marked) return rawProvider !== "kuaidi100_h5";
  return Boolean(
    expected &&
    (!rawCourierCode || rawCarrier?.standardCode === expected.standardCode) &&
    tracks.length &&
    tracks.every((track) => {
      const marker = String(track.raw?._pipiKuaidi100Com || "").trim();
      const returned = resolveCarrierKuaidi100Code(marker);
      return returned?.standardCode === expected.standardCode &&
        (!rawCourierCode || marker === rawCourierCode);
    }),
  );
}

function selectedManualTimelines(shipment: Shipment): TimelinePackage[] {
  const values = withoutForeignManualPackages(shipment, manualTimelines(shipment));
  if (shipment.identity.manuallyAdded) return values;
  const providers = new Set<string>([
    TIMELINE_SLOT.V5_QUERY,
    TIMELINE_SLOT.V4_QUERY,
    TIMELINE_SLOT.V6_PICKER,
    TIMELINE_SLOT.V2_QUERY,
    TIMELINE_SLOT.CN_H5,
    TIMELINE_SLOT.K100_H5,
    TIMELINE_SLOT.JD_H5,
    TIMELINE_SLOT.KDNIAO,
    TIMELINE_SLOT.K100_PAID,
  ]);
  return values.filter((timeline) => {
    const provider = normalizeTimelineSlot(timeline.provider);
    return providers.has(provider) &&
      (provider !== TIMELINE_SLOT.K100_H5 || isVerifiedKuaidi100Timeline(timeline));
  });
}

const PRE_KDNIAO_TIMELINE_PROVIDERS = new Set<string>([
  TIMELINE_SLOT.V5_QUERY,
  TIMELINE_SLOT.V4_QUERY,
  TIMELINE_SLOT.V6_PICKER,
  TIMELINE_SLOT.V2_QUERY,
  TIMELINE_SLOT.CN_H5,
  TIMELINE_SLOT.K100_H5,
  TIMELINE_SLOT.JD_H5,
]);

function timelineForCapability(
  values: readonly TimelinePackage[],
  capability: "local" | "route" | "web" | "fallback",
): TimelinePackage | null {
  return selectTimelineAuthority(
    null,
    values.filter((timeline) => timelineCapability(timeline.provider) === capability),
  );
}

const TERMINAL_HISTORY_MIN_TRACKS = 2;

function timelineHasUsableHistory(value: TimelinePackage): boolean {
  const tracks = timedTracks(value.tracks);
  if (!tracks.length) return false;
  const terminal = value.semantic === "COMPLETED" ||
    value.semantic === "CANCELLED";
  return !terminal || tracks.length >= TERMINAL_HISTORY_MIN_TRACKS;
}

function supplementTimelineHistory(
  selected: TimelinePackage,
  candidates: readonly TimelinePackage[],
): TimelinePackage {
  const waybill = normalizeWaybill(selected.waybill);
  let tracks = [...selected.tracks];
  for (const candidate of candidates) {
    if (candidate === selected) continue;
    if (
      candidate.provider.trim().toLowerCase() !==
        selected.provider.trim().toLowerCase()
    ) continue;
    if (!waybill || normalizeWaybill(candidate.waybill) !== waybill) continue;
    if (!timedTracks(candidate.tracks).length) continue;
    // Only the selected provider's own cache may restore omitted incremental
    // nodes. Timeline nodes from different providers are never composable.
    tracks = mergeTracks(candidate.tracks, tracks);
  }
  // Same rule as every other merge: a track set that just grew owns the headline it carries.
  return withMergedHeadline({ ...selected, tracks });
}

function preservesTerminalStatus(
  previous: TimelinePackage | null | undefined,
  selected: TimelinePackage,
  allowCrossProvider = false,
): TimelinePackage {
  if (
    !allowCrossProvider &&
    previous?.provider.trim().toLowerCase() !==
      selected.provider.trim().toLowerCase()
  ) {
    return selected;
  }
  const previousTerminal = previous?.semantic === "COMPLETED" ||
    previous?.semantic === "CANCELLED";
  const selectedTerminal = selected.semantic === "COMPLETED" ||
    selected.semantic === "CANCELLED";
  if (!previousTerminal || selectedTerminal) {
    return selected;
  }
  return {
    ...selected,
    semantic: previous?.semantic === "CANCELLED" ? "CANCELLED" : "COMPLETED",
    statusEventAtMs: previous?.statusEventAtMs ?? null,
  };
}

function hasSourceProvider(shipment: Shipment | undefined, expected: string): boolean {
  return String(shipment?.identity.sourceProvider || "")
    .trim()
    .toLowerCase() === expected.toLowerCase();
}

export function isShunFengSourceShipment(shipment: Shipment): boolean {
  return hasSourceProvider(shipment, "ShunFeng");
}

export function isJingDongSourceShipment(shipment: Shipment): boolean {
  return hasSourceProvider(shipment, "JingDong");
}


function withoutFeedRebuildFlag(timeline: TimelinePackage): TimelinePackage {
  if (!timeline.feedRebuildPending) return timeline;
  const copy: TimelinePackage = { ...timeline };
  delete copy.feedRebuildPending;
  return copy;
}

export function mergeAutomaticSourceTimeline(
  current: TimelinePackage | null,
  incoming: TimelinePackage,
): TimelinePackage {
  // 用户定 2026-09-05 晚：source 槽只装 feed 自己的增量；京东联合页的节点住 jd_h5 槽，不进
  // source，也不再让一个「完整的 H5 包」整包顶掉 feed 的轨迹。
  const feedCurrent = current ? splitJingDongH5Nodes(current).feed : null;
  return mergeTimelinePackage(feedCurrent, splitJingDongH5Nodes(incoming).feed);
}

export function cainiaoAutomaticNeedsH5Supplement(
  shipment: Shipment,
): boolean {
  if (shipment.identity.manuallyAdded || !hasSourceProvider(shipment, "CaiNiao")) {
    return false;
  }
  const source = sourceTimeline(shipment);
  return Boolean(
    source &&
      source.semantic !== "UNKNOWN" &&
      !containsTimelinePickupTrack(source.tracks),
  );
}

export function activateCainiaoManualFallback(
  shipment: Shipment,
  now = Date.now(),
): Shipment {
  if (!cainiaoAutomaticNeedsH5Supplement(shipment)) return shipment;
  return {
    ...shipment,
    cainiaoH5FallbackActivatedAtMs: Math.max(1, now),
  };
}

export function clearCainiaoManualFallback(shipment: Shipment): Shipment {
  if (shipment.cainiaoH5FallbackActivatedAtMs == null) return shipment;
  return { ...shipment, cainiaoH5FallbackActivatedAtMs: undefined };
}

export function cainiaoManualFallbackActivated(
  shipment: Shipment,
): boolean {
  const activatedAtMs = Number(shipment.cainiaoH5FallbackActivatedAtMs);
  return cainiaoAutomaticNeedsH5Supplement(shipment) &&
    Number.isFinite(activatedAtMs) && activatedAtMs > 0;
}

/**
 * 签收即冻结（用户定 2026-09-04）：只有终态的京东件才停止重开联合页。
 *
 * 注意它和 jingDongAutomaticH5TimelineAvailable 的区别——后者读的是包上的 `complete`，而
 * `complete` 只证明「这次抓取把列表展开了」（≥2 条有时间节点的等价证明），**不代表这票的轨迹到此
 * 为止**。过去重开闸门用的是后者，于是一次抓到 9 条止于 06:17 的包被永久冻结，联合页再也不开，
 * 后续节点永远补不进来（2026-09-04 极兔 4547 观察）。展开证明归展开证明，终态归终态。
 */
export function jingDongTimelineSettled(shipment: Shipment): boolean {
  const semantic = shipment.timeline.semantic;
  return semantic === "COMPLETED" || semantic === "CANCELLED";
}

/**
 * 京东 H5 这一级算不算抓成功（用户定 2026-09-04）：**抓到 ≥2 条有时间的节点，或只抓到 1 条但那条
 * 就是揽收**。抓失败、或只返回一条非揽收的轨迹，都要继续后面的 picker → 快递100 → kdniao——
 * 一条非揽收多半说明联合页压根没展开。
 *
 * 只数 H5 自己嫁接进来的节点（`_pipiStatusSource === "jingdong_h5"`），不数 feed 本来就有的，
 * 否则 feed 自带的订单级节点会把「没展开」冒充成「抓到了」。
 */
export function jingDongH5CaptureSufficient(shipment: Shipment): boolean {
  if (!isJingDongSourceShipment(shipment)) return false;
  // 用户定 2026-09-05 晚：H5 包住 jd_h5 槽，不再混在 source 里；这里数的就是那个槽。
  const jdH5 = jingDongH5Package(shipment);
  const captured = jdH5 ? timedTracks(jdH5.tracks) : [];
  if (captured.length >= 2) return true;
  return captured.length === 1 && containsTimelinePickupTrack(captured);
}

/** 京东联合页抓到的包：jd_h5 槽（用户定 2026-09-05 晚：feed 增量与 query 独立）。 */
export function jingDongH5Package(shipment: Shipment): TimelinePackage | null {
  return manualTimelines(shipment).find((timeline) =>
    normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.JD_H5
  ) || null;
}

export function jingDongAutomaticH5TimelineAvailable(
  shipment: Shipment,
): boolean {
  if (
    shipment.identity.manuallyAdded ||
    !shipment.identity.accountOrder ||
    !isJingDongSourceShipment(shipment)
  ) return false;
  const projectedWaybill = normalizedProjectedWaybill(shipment.identity);
  const jdH5 = jingDongH5Package(shipment);
  return Boolean(
    projectedWaybill &&
      jdH5 &&
      jdH5.complete === true &&
      timedTracks(jdH5.tracks).length &&
      normalizeWaybill(jdH5.waybill) === projectedWaybill,
  );
}

export function isJingDongCarrierShipment(shipment: Shipment): boolean {
  if (isJingDongSourceShipment(shipment)) return true;
  const rawCode = String(shipment.identity.rawCourierCode || "").trim();
  const carrier = rawCode
    ? resolveCarrierCpCode(rawCode)
    : resolveCarrierQuery(shipment.identity.courierCode);
  return carrier?.iconKey === "jd";
}

/** A confirmed completed JD shipment cannot be downgraded by an order summary. */
export function isFrozenJingDongShipment(
  shipment: Shipment | undefined,
): boolean {
  return Boolean(
    shipment &&
    hasSourceProvider(shipment, "JingDong") &&
    !unprojectedAccountOrder(shipment) &&
    shipment.timeline.semantic === "COMPLETED",
  );
}

export function forcedCompletedAt(shipment: Shipment): number {
  const value = Number(shipment.forcedCompletedAtMs);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function applyForcedCompletion(
  shipment: Shipment,
  timeline: TimelinePackage,
): TimelinePackage {
  const completedAtMs = forcedCompletedAt(shipment);
  if (!completedAtMs) return timeline;
  return {
    ...timeline,
    semantic: "COMPLETED",
    statusEventAtMs: completedAtMs,
    successAtMs: Math.max(timeline.successAtMs, completedAtMs),
  };
}

export function displayWaybill(shipment: Shipment): string {
  return normalizeWaybill(
    normalizedProjectedWaybill(shipment.identity) || shipment.timeline.waybill,
  );
}

export function unprojectedAccountOrder(shipment: Shipment): boolean {
  return Boolean(
    shipment.identity.accountOrder &&
    !normalizedProjectedWaybill(shipment.identity),
  );
}

/** Order completion is presentation-only until a real carrier waybill is known. */
export function isCompletedUnprojectedAccountOrder(
  shipment: Shipment | undefined,
): boolean {
  return Boolean(
    shipment &&
    unprojectedAccountOrder(shipment) &&
    shipment.statusPresentation?.scope === "ORDER" &&
    shipment.statusPresentation.semantic === "COMPLETED",
  );
}

export function manualTimelineOwnsShipment(shipment: Shipment): boolean {
  return !sourceTimelineOwnsShipment(shipment) && selectedManualTimelines(shipment).some(
    (timeline) => timedTracks(timeline.tracks).length > 0,
  );
}

export function usesManualSourceQuery(shipment: Shipment): boolean {
  return shipment.identity.manuallyAdded ||
    isShunFengSourceShipment(shipment) ||
    (
      hasSourceProvider(shipment, "CaiNiao") &&
      !sourceTimelineOwnsShipment(shipment)
    );
}

/** Ordinary automatic detail supplementation excludes every source-owned route. */
export function supportsOrdinaryAutomaticDetailSupplement(
  shipment: Shipment,
): boolean {
  return Boolean(
    !shipment.identity.manuallyAdded &&
    shipment.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
    !unprojectedAccountOrder(shipment) &&
    !hasSourceProvider(shipment, "CaiNiao") &&
    !isJingDongSourceShipment(shipment) &&
    !isShunFengSourceShipment(shipment) &&
    displayWaybill(shipment).length >= 6,
  );
}

/** The owner stays authoritative while detail may use one fuller provider package. */
export function needsAutomaticManualFallback(shipment: Shipment): boolean {
  if (!supportsOrdinaryAutomaticDetailSupplement(shipment)) return false;
  const source = sourceTimeline(shipment);
  if (source && sourceTimelineHasStart(shipment)) return false;
  return !source || !(
    timedTracks(source.tracks).length > 0 && manualTimelineIsComplete(source)
  );
}

/** Interface 5 owns automatic shipment presentation when it returned a timed timeline. */
export function sourceTimelineOwnsShipment(shipment: Shipment): boolean {
  const source = sourceTimeline(shipment);
  const projectedWaybill = normalizedProjectedWaybill(shipment.identity);
  const sourceWaybill = normalizeWaybill(source?.waybill || "");
  const sourceIsOrderSummary = Boolean(
    shipment.identity.accountOrder &&
      projectedWaybill &&
      sourceWaybill !== projectedWaybill,
  );
  return Boolean(
    !shipment.identity.manuallyAdded &&
    shipment.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
    EXPRESS_POLICY.orders.preferTimedSource &&
    !sourceIsOrderSummary &&
    source?.provider.trim().toLowerCase() === SCRIPT_BINDING_SOURCE &&
    timedTracks(source.tracks).length > 0,
  );
}

/** Detail refresh reuses these durable caches before requesting KDNiao. */
export function hasCachedTimelineBeforeKdniao(shipment: Shipment): boolean {
  const source = sourceTimeline(shipment);
  if (
    source && sourceTimelineOwnsShipment(shipment) &&
    timelineHasUsableHistory(source)
  ) return true;
  return manualTimelines(shipment).some((timeline) =>
    PRE_KDNIAO_TIMELINE_PROVIDERS.has(
      normalizeTimelineSlot(timeline.provider),
    ) && timelineHasUsableHistory(timeline)
  );
}

/** Evaluates the accumulated pre-fallback caches, not only this run's response. */
export function hasTimelineStartBeforeKdniao(shipment: Shipment): boolean {
  const source = sourceTimeline(shipment);
  return [
    ...(source ? [source] : []),
    ...manualTimelines(shipment).filter((timeline) =>
      PRE_KDNIAO_TIMELINE_PROVIDERS.has(
        timeline.provider.trim().toLowerCase(),
      )
    ),
  ].some((timeline) => containsTimelineStartTrack(timeline.tracks));
}

export function sourceTimelineHasStart(shipment: Shipment): boolean {
  const source = sourceTimeline(shipment);
  return Boolean(source && containsTimelineStartTrack(source.tracks));
}

/**
 * The account order's own incremental feed cache reaching the timeline start. A partial JD H5
 * projection is merged into the same source package, so its grafted pickup node must not count
 * here: AGENTS §9 lets a complete manual package outrank a partial H5, but never outrank the
 * feed's own 揽收 (user design 2026-09-04). Pipi has no equivalent test because its owner row is
 * never written by the H5 capture.
 */
export function jingDongFeedReachedStart(shipment: Shipment): boolean {
  if (!isJingDongSourceShipment(shipment)) return false;
  const source = sourceTimeline(shipment);
  return Boolean(source && containsFeedTimelineStartTrack(source.tracks));
}

/**
 * 用户定 2026-09-04：抓取的判据是**揽收**，只有「已下单」不算。这是 Pipi
 * `ExpressDetailTimelinePolicy.hasPickupEvidence`（orderedCounts=false）在 iOS 的同位实现；
 * 上面的 jingDongFeedReachedStart 仍认「已下单或揽收」，那是展示选包用的，两者不可互换。
 */
export function jingDongFeedReachedPickup(shipment: Shipment): boolean {
  if (!isJingDongSourceShipment(shipment)) return false;
  const source = sourceTimeline(shipment);
  return Boolean(source && containsTimelinePickupTrack(feedOwnTracks(source.tracks)));
}


/** True when preferring `candidate` would drop a terminal status that `rival` already carries. */
function losesTerminalSemantic(
  candidate: TimelinePackage | null,
  rival: TimelinePackage | null,
): boolean {
  const terminal = (value: TimelinePackage | null) =>
    value?.semantic === "COMPLETED" || value?.semantic === "CANCELLED";
  return terminal(rival) && !terminal(candidate);
}

/** The feed's own nodes: the H5 capture merges into the same package, and its grafted rows never count as feed evidence. */
function feedOwnTracks(tracks: readonly TrackNode[]): readonly TrackNode[] {
  return tracks.filter((track) =>
    String(track.raw?._pipiStatusSource || "").trim().toLowerCase() !==
      "jingdong_h5"
  );
}

function containsFeedTimelineStartTrack(tracks: readonly TrackNode[]): boolean {
  return containsTimelineStartTrack(feedOwnTracks(tracks));
}

function timelineCompleteEnoughForFallback(value: TimelinePackage | null): boolean {
  if (!value) return false;
  return timedTracks(value.tracks).length > 0 && manualTimelineIsComplete(value);
}

/** Source-specific final-fallback gate used only by an explicit detail refresh. */
export function needsDetailFallback(shipment: Shipment): boolean {
  if (
    containsTimelineStartTrack(
      selectShipmentDetailTimeline(shipment).tracks,
    )
  ) return false;
  const source = sourceTimeline(shipment);
  const manuals = selectedManualTimelines(shipment);
  const local = timelineForCapability(manuals, "local");
  const route = timelineForCapability(manuals, "route");
  const web = timelineForCapability(manuals, "web");
  if (shipment.identity.manuallyAdded) {
    return ![local, web, route].some(timelineCompleteEnoughForFallback);
  }
  if (isShunFengSourceShipment(shipment)) {
    return ![web, route, source].some((timeline) =>
      Boolean(timeline && timedTracks(timeline.tracks).length)
    );
  }
  if (hasSourceProvider(shipment, "JingDong")) {
    return ![source, web].some((timeline) =>
      Boolean(timeline && timedTracks(timeline.tracks).length)
    );
  }
  if (hasSourceProvider(shipment, "CaiNiao")) {
    return ![source, web, local].some(timelineCompleteEnoughForFallback);
  }
  return !hasCachedTimelineBeforeKdniao(shipment);
}

export function hasCachedKdniaoTimeline(shipment: Shipment): boolean {
  return manualTimelines(shipment).some((timeline) =>
    timelineCapability(timeline.provider) === "fallback" &&
    manualTimelineIsComplete(timeline)
  );
}

export function hasSettledTimelineHistory(shipment: Shipment): boolean {
  if (forcedCompletedAt(shipment)) return true;
  const timeline = shipment.timeline;
  return (
    timeline.semantic === "COMPLETED" || timeline.semantic === "CANCELLED"
  ) && timelineHasUsableHistory(timeline);
}

/**
 * 展示包空了就借同票别的槽的节点。supplementTimelineHistory 只回填「同 provider 同运单号」的
 * 缺口，跨槽的救不回来：一行签收之后 feed 只回摘要、按件详情又住在 v5_query，最后落到没有节点的
 * 占位包上，界面就成了「已签收 · 暂无物流动态」，而这一票的节点其实还在本地存着
 * （用户 2026-09-07 报）。状态与身份仍以选中的包为准，只借节点。
 */
function restoreDisplayableTracks(
  selected: TimelinePackage,
  candidates: readonly TimelinePackage[],
): TimelinePackage {
  if (timedTracks(selected.tracks).length) return selected;
  const richest = candidates
    .filter((candidate) => candidate !== selected)
    .filter((candidate) => timedTracks(candidate.tracks).length > 0)
    .sort(compareTimelinePackageCompleteness)[0];
  if (!richest) return selected;
  return {
    ...selected,
    tracks: richest.tracks,
    latestTimeText: selected.latestTimeText || richest.latestTimeText,
    latestDetail: selected.latestDetail || richest.latestDetail,
    statusEventAtMs: selected.statusEventAtMs ?? richest.statusEventAtMs,
  };
}

export function selectShipmentTimeline(shipment: Shipment): TimelinePackage {
  const source = sourceTimeline(shipment);
  const selectedManuals = selectedManualTimelines(shipment);
  const manuals = cainiaoAutomaticNeedsH5Supplement(shipment) &&
      !cainiaoManualFallbackActivated(shipment)
    ? selectedManuals.filter((timeline) =>
        normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.CN_H5
      )
    : selectedManuals;
  let selected: TimelinePackage;
  if (source && unprojectedAccountOrder(shipment)) {
    selected = {
      ...source,
      semantic: accountOrderSemantic(source.latestDetail, source.semantic),
    };
  } else {
    const capabilityTimeline = (
      capability: "account" | "local" | "route" | "web" | "fallback",
    ): TimelinePackage | null => capability === "account"
      ? source && timedTracks(source.tracks).length ? source : null
      : timelineForCapability(manuals, capability);
    const priorities: readonly (
      "account" | "local" | "route" | "web" | "fallback"
    )[] = shipment.identity.manuallyAdded
      ? ["route"]
      : isShunFengSourceShipment(shipment)
        ? ["route", "fallback", "account"]
        : isJingDongSourceShipment(shipment)
          ? ["account", "fallback"]
          : hasSourceProvider(shipment, "CaiNiao")
            ? ["account", "web", "local", "fallback"]
            : ["account", "web", "local", "route", "fallback"];
    const ordered = priorities
      .map(capabilityTimeline)
      .filter((timeline): timeline is TimelinePackage => Boolean(timeline));
    const jingDongAccount = isJingDongSourceShipment(shipment)
      ? capabilityTimeline("account")
      : null;
    const jingDongWeb = isJingDongSourceShipment(shipment)
      ? manuals.filter(isVerifiedKuaidi100Timeline)
        .filter((timeline) => timedTracks(timeline.tracks).length > 0)
        .sort(compareTimelinePackageCompleteness)[0] ||
        capabilityTimeline("web")
      : null;
    const jingDongManualCandidates = isJingDongSourceShipment(shipment)
      ? [jingDongWeb, capabilityTimeline("fallback")]
        .filter((timeline): timeline is TimelinePackage => Boolean(timeline))
      : [];
    const completeJingDongManual = [...jingDongManualCandidates]
      .filter(manualTimelineIsComplete)
      .sort(compareTimelinePackageCompleteness)[0] || null;
    const manualRaceWinner = shipment.identity.manuallyAdded
      ? [capabilityTimeline("local"), capabilityTimeline("web")]
        .filter((timeline): timeline is TimelinePackage => Boolean(timeline))
        .sort(compareTimelinePackageCompleteness)[0] || null
      : null;
    const terminal = shipment.identity.manuallyAdded ||
        isShunFengSourceShipment(shipment) ||
        supportsOrdinaryAutomaticDetailSupplement(shipment)
      ? null
      : ordered.find(
          (timeline) => timeline.semantic === "COMPLETED" ||
            timeline.semantic === "CANCELLED",
        );
    // 用户定 2026-09-05：手动件的首页头条/状态跟详情同一套选包（完整 → 节点数 → 层级 → 次序），
    // 不再由 picker 包独占——picker 只回几条且后续冷却时，首页会停在旧节点上（EMS 8146 实测）。
    selected = shipment.identity.manuallyAdded
      ? rankShipmentDetailCandidates(shipment) || ordered[0] || manualRaceWinner ||
        capabilityTimeline("fallback") ||
        selectTimelineAuthority(source, manuals) || shipment.timeline
      : isJingDongSourceShipment(shipment)
        // 用户定 2026-09-05 晚：京东行的列表归 feed——状态、头条、轨迹都是 feed 自己的包；联合页
        // H5 与后续手动包各住各的槽，只在详情页参与选包。feed 没有结构化终态、而某个完整的手动
        // 包已到终态时只借它的状态，不借它的轨迹（状态看结构化状态，展示包没有就用同票别的包）。
        ? withBorrowedTerminalSemantic(
            jingDongAccount || source || shipment.timeline,
            completeJingDongManual,
          )
        : terminal || ordered[0] ||
          selectTimelineAuthority(source, manuals) || shipment.timeline;
  }
  const supplemented = restoreDisplayableTracks(
    supplementTimelineHistory(
      selected,
      [...(source ? [source] : []), ...manuals],
    ),
    [...(source ? [source] : []), ...manuals],
  );
  return applyForcedCompletion(
    shipment,
    structuredStatusOverride(
      shipment,
      isFrozenJingDongShipment(shipment)
        ? preservesTerminalStatus(shipment.timeline, supplemented, true)
        : supplemented,
    ),
  );
}

/**
 * 用户定 2026-09-05：状态看来源**返回的结构化状态**，不看文案。展示包（比如 K100 页）自己没有
 * 结构化状态时，用同一票别的包里事件时间最新的那个结构化状态；一个都没有才轮到文案。
 * 只对走手动链的行（手动件、顺丰来源）生效——账号件的状态本来就是账号 feed 的结构化状态。
 */
function structuredStatusOverride(
  shipment: Shipment,
  selected: TimelinePackage,
): TimelinePackage {
  if (!(shipment.identity.manuallyAdded || isShunFengSourceShipment(shipment))) {
    return selected;
  }
  const selectedEvidence = selected.structuredStatus && selected.semantic !== "UNKNOWN"
    ? { semantic: selected.semantic, eventAtMs: selected.statusEventAtMs }
    : latestEventEvidence(selected.tracks);
  if (selectedEvidence.semantic !== "UNKNOWN") return selected;
  const packages = [sourceTimeline(shipment), ...selectedManualTimelines(shipment)]
    .filter((timeline): timeline is TimelinePackage => Boolean(timeline));
  let best: { semantic: StatusSemantic; eventAtMs: number | null } | null = null;
  for (const timeline of packages) {
    const evidence = timeline.structuredStatus && timeline.semantic !== "UNKNOWN"
      ? { semantic: timeline.semantic, eventAtMs: timeline.statusEventAtMs }
      : latestEventEvidence(timeline.tracks);
    if (evidence.semantic === "UNKNOWN") continue;
    if (!best || (evidence.eventAtMs || 0) > (best.eventAtMs || 0)) best = evidence;
  }
  if (!best) return selected;
  // 终态不退回（表格「若选中的包会丢掉终态，保留」）。
  if (
    (selected.semantic === "COMPLETED" || selected.semantic === "CANCELLED") &&
    best.semantic !== selected.semantic
  ) return selected;
  return {
    ...selected,
    semantic: best.semantic,
    statusEventAtMs: best.eventAtMs ?? selected.statusEventAtMs,
    structuredStatus: true,
  };
}

export function selectShipmentDetailTimeline(
  shipment: Shipment,
): TimelinePackage {
  return selectShipmentDetailTimelineInner(shipment);
}

/** 详情完整判据的容差：不同接口对同一事件的时间戳有偏差（实测 1m14s ~ 11m53s）。 */
const DETAIL_COMPLETE_SKEW_MS = 30 * 60_000;

/** feed 攒出历史（≥2 条有效节点）才算轨迹；只有一条时它是状态摘要。 */
const SOURCE_TIMELINE_MIN_TRACKS = 2;

/**
 * 详情页候选包的层级（用户定 2026-09-04，与 Pipi 的 ExpressDetailTimelinePolicy 同值）：
 * 接口完整轨迹 → 本地 feed 增量 → 免费手动包 → feed 摘要 → 付费手动包 → 顺丰粗轨迹。
 */
const DETAIL_TIER = {
  sourceComplete: 0,
  sourceIncrement: 1,
  freeManual: 2,
  sourceSummaryOnly: 3,
  paidManual: 4,
  coarseSource: 5,
} as const;

/**
 * 详情完整的判据（用户定 2026-09-04，三端同口径）：
 * `|该包最新节点时间 − feed 最新节点时间| ≤ 30 分钟` **且** 轨迹里有揽收。
 * feed 自己没有有效时间节点时，只看有没有揽收。
 *
 * 一致性那一半同时挡住串包：快递100 曾把 2025-11 的 EMS 轨迹返回给一票极兔（R-29 锚点就是
 * 为它加的），那种包的最新时间差几个月，判据直接出局，不会因为节点多就赢下展示。
 */
/** 选中的详情包是否已按统一判据完整（揽收 + 与 feed 时间对齐）；完整就不再重拉。 */
export function shipmentDetailComplete(shipment: Shipment): boolean {
  const selected = selectShipmentDetailTimeline(shipment);
  if (!timedTracks(selected.tracks).length) return false;
  const source = sourceTimeline(shipment);
  const sourceAt = source ? timelineLatestEventAt(source) : 0;
  // 没有 feed 作时间基准（纯手动件、feed 没有有效时间）时判不了「到此为止」：只有终态才算完整，
  // 在途的照常允许重拉——beta51 实测 EMS 手动件下拉被当成已完整、100ms 就跳过了。
  if (sourceAt <= 0) {
    return (selected.semantic === "COMPLETED" || selected.semantic === "CANCELLED") &&
      containsTimelinePickupTrack(selected.tracks);
  }
  return detailTimelineComplete(selected, source);
}

function detailTimelineComplete(
  timeline: TimelinePackage,
  source: TimelinePackage | null,
): boolean {
  if (!containsTimelinePickupTrack(timeline.tracks)) return false;
  const sourceAt = source ? timelineLatestEventAt(source) : 0;
  if (sourceAt <= 0) return true;
  const timelineAt = timelineLatestEventAt(timeline);
  if (timelineAt <= 0) return false;
  return Math.abs(timelineAt - sourceAt) <= DETAIL_COMPLETE_SKEW_MS;
}

/**
 * 付费兜底只有快递鸟一家（用户定 2026-09-04：「只有自动链、手动链免费接口都没有符合的数据时
 * 才调用 kdniao」）。不能用 `timelineCapability(...) === "fallback"` 代替——那个分类把免费的
 * 快递100 也归进了 fallback，会让免费包被当成付费包排到最后。
 */
function isPaidTimelineProvider(provider: string): boolean {
  const value = String(provider || "").trim().toLowerCase();
  return normalizeTimelineSlot(value) === TIMELINE_SLOT.KDNIAO;
}

/**
 * 详情页选包（完整判据 → 有效节点数 → 自报 complete → 层级 → 既有次序）；没有候选时返回 null。
 * 用户定 2026-09-05：手动件的首页头条与状态也用这一套选包，不再由 picker 包独占。
 */
export function rankShipmentDetailCandidates(
  shipment: Shipment,
): TimelinePackage | null {
  const source = sourceTimeline(shipment);
  const cainiaoNeedsH5 = cainiaoAutomaticNeedsH5Supplement(shipment);
  const cainiaoFallbackActive = cainiaoManualFallbackActivated(shipment);
  const manuals = selectedManualTimelines(shipment);
  const supportsPrimaryContest = shipment.identity.manuallyAdded ||
    isJingDongSourceShipment(shipment) ||
    isShunFengSourceShipment(shipment) ||
    cainiaoFallbackActive ||
    supportsOrdinaryAutomaticDetailSupplement(shipment);

  // 各来源的差别只体现在**候选资格**：京东链没有 moto、菜鸟在兜底激活前只认同票菜鸟 H5、
  // 顺丰不跑 moto。资格之外一律走下面同一套排序（用户定 2026-09-04：统一，不再分来源排序）。
  const eligible = manuals.filter((timeline) => {
    const capability = timelineCapability(timeline.provider);
    const provider = normalizeTimelineSlot(timeline.provider);
    if (cainiaoNeedsH5 && !cainiaoFallbackActive) return provider === TIMELINE_SLOT.CN_H5;
    // 接口 5 按件详情（v5_query）只有自动件才有，跟 feed 增量先竞争（用户定 2026-09-05 晚）。
    if (capability === "account") return !shipment.identity.manuallyAdded;
    if (!supportsPrimaryContest) return provider === TIMELINE_SLOT.CN_H5;
    if (capability === "local") {
      return (shipment.identity.manuallyAdded ||
        cainiaoFallbackActive ||
        supportsOrdinaryAutomaticDetailSupplement(shipment)) &&
        !isJingDongSourceShipment(shipment);
    }
    if (capability === "route") {
      const picker = provider === TIMELINE_SLOT.V6_PICKER;
      return supportsOrdinaryAutomaticDetailSupplement(shipment) ||
        (picker && (
          shipment.identity.manuallyAdded ||
          isShunFengSourceShipment(shipment) ||
          cainiaoFallbackActive ||
          isJingDongSourceShipment(shipment)
        ));
    }
    if (capability === "web") {
      return provider === TIMELINE_SLOT.CN_H5 ||
        shipment.identity.manuallyAdded ||
        isShunFengSourceShipment(shipment) ||
        isVerifiedKuaidi100Timeline(timeline);
    }
    return capability === "fallback";
  }).filter((timeline) => timedTracks(timeline.tracks).length > 0);

  const candidates = [
    ...(source && timedTracks(source.tracks).length ? [source] : []),
    ...eligible,
  ];
  if (!candidates.length) return null;

  // 优先级（用户定 2026-09-04）：接口完整轨迹 → 本地 feed 增量 → 免费手动包 → 付费手动包。
  // 顺丰是唯一例外：它的 feed 只有粗略轨迹，退到最后兜底，Picker 才是第一优先级。
  const sourceIsCoarseFallback = isShunFengSourceShipment(shipment);
  const tier = (timeline: TimelinePackage): number => {
    if (timeline === source) {
      if (sourceIsCoarseFallback) return DETAIL_TIER.coarseSource;
      if (detailTimelineComplete(timeline, source)) return DETAIL_TIER.sourceComplete;
      // 只有一条有效节点的 feed 是**状态摘要，不是轨迹**：两边都只有一条时让它赢，会把详情压回
      // 「已下单」而丢掉承运商刚给的那条。这条判据越不过前面的完整性和节点数。
      return timedTracks(timeline.tracks).length >= SOURCE_TIMELINE_MIN_TRACKS
        ? DETAIL_TIER.sourceIncrement
        : DETAIL_TIER.sourceSummaryOnly;
    }
    return isPaidTimelineProvider(timeline.provider)
      ? DETAIL_TIER.paidManual
      : DETAIL_TIER.freeManual;
  };
  // 先比完整性，再比节点覆盖，**层级只当并列时的 tiebreak**。层级不能压倒一切：一个 kdniao
  // 包能存在，本身就说明当时前面几级不够（付费兜底只在累计仍无起点时才调），拿「feed 有资格」
  // 去压它讲不通。这样 25 条完整 feed 胜过 22 条完整 kdniao，而 2 条 partial feed 输给它。
  const ranked = candidates.slice().sort((left, right) => {
    const completeness = Number(detailTimelineComplete(right, source)) -
      Number(detailTimelineComplete(left, source));
    if (completeness !== 0) return completeness;
    const coverage = timedTracks(right.tracks).length -
      timedTracks(left.tracks).length;
    if (coverage !== 0) return coverage;
    // 各家自报的 complete 只当同级之间的 tiebreak：它表示「这次抓取把列表展开了」，够格分辨
    // 两个同样大小的包，但压不过上面的完整判据和节点覆盖。
    const declared = Number(manualTimelineIsComplete(right)) -
      Number(manualTimelineIsComplete(left));
    if (declared !== 0) return declared;
    return tier(left) - tier(right) ||
      compareTimelineProviderOrder(left, right);
  });
  const winner = ranked[0];
  // 粘性选包（用户定 2026-09-05 晚，三端同口径）：上一轮显示过的包还在（没被判串包、没被清掉）
  // 就默认还显示它；只有它自己不完整、而排第一的包已完整时才换。
  const preferredProvider = String(shipment.detailSelection?.provider || "")
    .trim()
    .toLowerCase();
  const preferred = preferredProvider
    ? ranked.find((timeline) => timeline.provider.trim().toLowerCase() === preferredProvider)
    : undefined;
  if (!preferred || preferred === winner) return winner;
  return detailTimelineComplete(preferred, source) || !detailTimelineComplete(winner, source)
    ? preferred
    : winner;
}

/** 记住详情页这次显示的包，下一轮默认还显示它（粘性选包，用户定 2026-09-05 晚）。 */
export function withDetailSelection(shipment: Shipment, now: number): Shipment {
  const provider = selectShipmentDetailTimeline(shipment).provider.trim();
  if (!provider) return shipment;
  if (shipment.detailSelection?.provider.trim().toLowerCase() === provider.toLowerCase()) {
    return shipment;
  }
  return { ...shipment, detailSelection: { provider, selectedAtMs: now } };
}

function withBorrowedTerminalSemantic(
  selected: TimelinePackage,
  donor: TimelinePackage | null,
): TimelinePackage {
  if (!donor || !losesTerminalSemantic(selected, donor)) return selected;
  return {
    ...selected,
    semantic: donor.semantic,
    statusEventAtMs: donor.statusEventAtMs,
    structuredStatus: donor.structuredStatus === true,
  };
}

function selectShipmentDetailTimelineInner(
  shipment: Shipment,
): TimelinePackage {
  const selected = rankShipmentDetailCandidates(shipment);
  if (!selected) return selectShipmentTimeline(shipment);
  // 这里不做终态保护：2026-09-04「两票京东变成暂无状态」是**列表**的状态被顶掉，那由
  // selectShipmentTimeline 负责，跟详情展示哪条轨迹是两回事。在详情上加这道闸会把「账号说已
  // 签收但一条轨迹都没有、手动包却有实际节点」的情况整个挡住。
  return applyForcedCompletion(
    shipment,
    supplementTimelineHistory(selected, [selected]),
  );
}

export function activeManualRefreshLease(
  shipment: Shipment,
  now: number,
): boolean {
  const lease = shipment.manualRefreshLease;
  if (!lease || !String(lease.attemptId || "").trim()) return false;
  const startedAtMs = Number(lease.startedAtMs);
  const expiresAtMs = Number(lease.expiresAtMs);
  return Number.isFinite(startedAtMs) &&
    Number.isFinite(expiresAtMs) &&
    startedAtMs > 0 &&
    expiresAtMs > startedAtMs &&
    now >= startedAtMs &&
    now < expiresAtMs;
}

export function ownsManualRefreshLease(
  shipment: Shipment | undefined,
  attemptId: string,
): boolean {
  return Boolean(
    shipment?.manualRefreshLease?.attemptId &&
      shipment.manualRefreshLease.attemptId === attemptId,
  );
}

export function beginManualRefreshAttempt(
  shipment: Shipment,
  attemptId: string,
  startedAtMs: number,
  expiresAtMs: number,
): Shipment {
  return {
    ...shipment,
    manualRefreshAttemptAtMs: startedAtMs,
    manualRefreshLease: {
      attemptId,
      startedAtMs,
      expiresAtMs: Math.max(startedAtMs + 1, expiresAtMs),
    },
  };
}

export function releaseManualRefreshLease(
  shipment: Shipment,
  attemptId: string,
): Shipment {
  if (!ownsManualRefreshLease(shipment, attemptId)) return shipment;
  return { ...shipment, manualRefreshLease: undefined };
}

export function shouldScheduleManualRefresh(
  shipment: Shipment,
  now: number,
  force = false,
): boolean {
  if (forcedCompletedAt(shipment)) return false;
  // 用户定 2026-09-04：首页/列表页对终态件停止刷新，除非状态还没出来。终态 = 已签收或已取消
  // 且已有可用轨迹历史，所以零轨迹或非终态的行照常刷。与 Pipi 的
  // ExpressDetailTimelinePolicy.hasSettledTimelineHistory 同判据。下面各分支原来只看被选中那个
  // 手动包的 COMPLETED，既不认已取消，也没有统一的入口闸门。
  if (hasSettledTimelineHistory(shipment)) return false;
  if (activeManualRefreshLease(shipment, now)) return false;
  const lastAttemptAtMs = Number(shipment.manualRefreshAttemptAtMs);
  if (
    !force &&
    Number.isFinite(lastAttemptAtMs) &&
    lastAttemptAtMs > 0 &&
    now >= lastAttemptAtMs &&
    now - lastAttemptAtMs < MANUAL_REFRESH_MIN_INTERVAL_MS
  ) {
    return false;
  }
  if (shipment.identity.manuallyAdded) {
    const selectedManual = selectTimelineAuthority(
      null,
      selectedManualTimelines(shipment),
    );
    if (selectedManual?.semantic === "COMPLETED") {
      return !manualTimelineIsComplete(selectedManual);
    }
    return true;
  }
  if (hasSourceProvider(shipment, "ShunFeng")) {
    const selectedManual = selectTimelineAuthority(null, selectedManualTimelines(shipment));
    return !(
      selectedManual?.semantic === "COMPLETED" &&
      manualTimelineIsComplete(selectedManual)
    );
  }
  return false;
}

export function sameCanonicalWaybill(
  left: Shipment,
  right: Shipment,
): boolean {
  return sameDisplayedWaybill(left, right) &&
    left.identity.bindingSource === right.identity.bindingSource;
}

export function sameDisplayedWaybill(
  left: Shipment,
  right: Shipment,
): boolean {
  const leftWaybill = displayWaybill(left);
  const rightWaybill = displayWaybill(right);
  return Boolean(
    leftWaybill &&
    rightWaybill &&
    leftWaybill === rightWaybill,
  );
}

/**
 * An already projected owner keeps its carrier unless the incoming observation names a different,
 * resolvable carrier for the same projected waybill (feed text or H5 evidence); the order-stage
 * label is never such evidence.
 */
function repairedProjectedCarrier(
  current: Shipment["identity"],
  incoming: Shipment["identity"],
): { courierCode: string; companyName: string } {
  const incomingCode = normalizeCarrierCode(incoming.courierCode || "");
  const currentCode = normalizeCarrierCode(current.courierCode || "");
  if (
    incomingCode &&
    incomingCode !== currentCode &&
    normalizedProjectedWaybill(incoming) === normalizedProjectedWaybill(current) &&
    resolveCarrierQuery(incomingCode)
  ) {
    return {
      courierCode: incomingCode,
      companyName: incoming.companyName || current.companyName,
    };
  }
  return { courierCode: current.courierCode, companyName: current.companyName };
}
/**
 * 接口 5 按件详情（mode=detail）是 query 包，住 v5_query 槽；source 槽只装列表 feed 自己的增量
 * （用户定 2026-09-05 晚：feed 增量与 query 独立，不拼接）。以前详情结果原样走 applyAccountShipment，
 * 它的节点被并进了 source 槽——日志里那个 v5_query 其实是 feed ∪ 详情，同一分钟秒数不同的两条
 * 「预计…」就是这么来的（2026-09-06，京东订单 4424；Lite / Pipi 的 v5_query 是独立的 sidecar，
 * 所以没有）。这里把详情包摘到 v5_query 槽，身份、投影、路由、订单级展示仍按原路合并；source 槽
 * 用 current 自己的 feed 占位（带上详情给的运单号，好让投影照常建立），节点不动。
 */
export function asAccountDetailObservation(
  current: Shipment,
  incoming: Shipment,
): Shipment {
  const detail = incoming.sourceTimeline || incoming.timeline;
  const feed = sourceTimeline(current);
  // 没有 feed 槽时不要凭空造一个空包盖掉这一行：签收后详情只回摘要的那一轮，占位包会把已经
  // 存下来的节点整份抹掉，界面变成「已签收 · 暂无物流动态」，而且没有签收时间就连 7 天保留期
  // 都不会到期（用户 2026-09-07 报，下拉刷新才重新拉回来）。存着的节点优先当占位。
  const stored = current.timeline;
  const placeholder: TimelinePackage = feed
    ? { ...feed, waybill: detail.waybill || feed.waybill }
    : timedTracks(stored.tracks).length
      ? { ...stored, waybill: detail.waybill || stored.waybill }
      : { ...detail, tracks: [] };
  const queryPackage: TimelinePackage = { ...detail, provider: TIMELINE_SLOT.V5_QUERY };
  const manuals = timedTracks(detail.tracks).length
    ? mergeTimelineAuthorities(incoming.manualTimelines || [], queryPackage)
    : incoming.manualTimelines || [];
  return {
    ...incoming,
    timeline: placeholder,
    sourceTimeline: placeholder,
    manualTimelines: manuals,
  };
}

export function applyTargetedAccountShipment(
  current: Shipment,
  incoming: Shipment,
  now: number,
  options: Readonly<{
    existingCainiaoRouteAvailable?: boolean;
  }> = {},
): Shipment {
  const knownProjection = normalizeWaybill(
    normalizedProjectedWaybill(current.identity),
  );
  const matchesKnownProjection = Boolean(
    current.identity.accountOrder &&
    knownProjection &&
    normalizeWaybill(incoming.identity.sourceId) === knownProjection,
  );
  if (
    incoming.identity.id !== current.identity.id &&
    !matchesKnownProjection
  ) {
    throw new Error("返回的物流信息与当前运单不符，请稍后重试");
  }
  let merged = applyAccountShipment(current, incoming, now);
  if (merged.identity.id !== current.identity.id) {
    throw new Error("返回的物流信息与当前运单不符，请稍后重试");
  }
  const currentProvider = String(current.identity.sourceProvider || "")
    .trim()
    .toLowerCase();
  const mergedProvider = String(merged.identity.sourceProvider || "")
    .trim()
    .toLowerCase();
  if (
    options.existingCainiaoRouteAvailable &&
    currentProvider === "cainiao" &&
    mergedProvider === "cainiao" &&
    current.route?.kind === "cainiao" &&
    !merged.route
  ) {
    merged = { ...merged, route: current.route };
  }
  return merged;
}

export function isHistoricalAccountDuplicate(
  candidate: Shipment,
  accountOwner: Shipment,
): boolean {
  return Boolean(
    !candidate.identity.manuallyAdded &&
    candidate.identity.bindingSource == null &&
    !accountOwner.identity.manuallyAdded &&
    accountOwner.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
    sameDisplayedWaybill(candidate, accountOwner),
  );
}

function mergeAccountShipmentPackage(
  current: Shipment | undefined,
  incoming: Shipment,
  now: number,
): Shipment {
  const accountOrder = Boolean(
    current?.identity.accountOrder || incoming.identity.accountOrder,
  );
  const currentSourceValue = current ? sourceTimeline(current) : null;
  const incomingSourceValue = incoming.sourceTimeline || incoming.timeline;
  const currentSource = currentSourceValue;
  const incomingSource = incomingSourceValue;
  const incomingProjection = normalizeWaybill(
    normalizedProjectedWaybill(incoming.identity),
  );
  const currentProjection = normalizedProjectedWaybill(current?.identity);
  const currentSourceId = normalizeWaybill(current?.identity.sourceId || "");
  const incomingTimelineWaybill = normalizeWaybill(incoming.timeline.waybill);
  const detailProjection = current?.identity.accountOrder &&
      !incoming.identity.accountOrder &&
      incomingTimelineWaybill !== currentSourceId
    ? incomingTimelineWaybill
    : "";
  const nextProjection = incomingProjection || detailProjection;
  // The completed order snapshot is only a fallback until H5 establishes a
  // carrier waybill. It may neither replace nor contribute tracks to that
  // shipment, while later carrier packages remain mergeable.
  const rejectsUnprojectedOrderCompletion = Boolean(
    currentSource &&
      current?.identity.accountOrder &&
      incoming.identity.accountOrder &&
      currentProjection &&
      !incomingProjection &&
      incoming.statusPresentation?.scope === "ORDER" &&
      incoming.statusPresentation.semantic === "COMPLETED",
  );
  const establishesProjection = Boolean(
    current?.identity.accountOrder &&
      !currentProjection &&
      nextProjection,
  );
  const reclassifiesAccountOrder = Boolean(
    current &&
      !current.identity.accountOrder &&
      incoming.identity.accountOrder &&
      !nextProjection,
  );
  // 一次性修复（2026-09-06，见 TimelinePackage.feedRebuildPending）：带标记的 feed 槽被下一次列表
  // 同步整包替换；按件详情的占位副本自带标记，走不到这里的替换分支。
  const rebuildsFeedSlot = Boolean(
    currentSource?.feedRebuildPending &&
      !incomingSource.feedRebuildPending &&
      timedTracks(incomingSource.tracks).length,
  );
  const mergedSource = establishesProjection || reclassifiesAccountOrder
    ? withoutFeedRebuildFlag(incomingSource)
    : rejectsUnprojectedOrderCompletion
    ? currentSource!
    : rebuildsFeedSlot
    ? withoutFeedRebuildFlag(splitJingDongH5Nodes(incomingSource).feed)
    : mergeAutomaticSourceTimeline(currentSource, incomingSource);
  const anchorShipment: Shipment = {
    ...(current || incoming),
    identity: { ...(current || incoming).identity, accountOrder },
    sourceTimeline: mergedSource,
  };
  let manuals = current && !reclassifiesAccountOrder
    ? withoutForeignManualPackages(anchorShipment, manualTimelines(current))
    : [];
  // 混在 source 里的 H5 节点（老数据，或直接把 H5 包当 source 传进来的调用方）拆出来归 jd_h5
  // 槽；只收完整的包（用户定 2026-09-05 晚：不拼接，不完整的 H5 包不存）。
  for (const stranded of [
    currentSource && !reclassifiesAccountOrder
      ? splitJingDongH5Nodes(currentSource).jdH5
      : null,
    splitJingDongH5Nodes(incomingSource).jdH5,
  ]) {
    if (stranded && stranded.complete === true && timedTracks(stranded.tracks).length) {
      manuals = mergeTimelineAuthorities(manuals, stranded);
    }
  }
  for (const timeline of incoming.manualTimelines || []) {
    if (isForeignManualPackage(anchorShipment, timeline)) continue;
    manuals = mergeTimelineAuthorities(manuals, timeline);
  }
  const preservesExistingProjection = Boolean(
    current?.identity.accountOrder &&
    currentProjection &&
    !nextProjection,
  );
    // Establishing the projection may only use the incoming carrier evidence; the current
  // order-stage label (京东购物 / JDKD) is never carrier evidence for the carrier waybill.
  const projectedPresentation = nextProjection
    ? projectedCarrierPresentation(
        nextProjection,
        incoming.identity.courierCode ||
          (establishesProjection ? "" : current?.identity.courierCode || ""),
        incoming.identity.companyName ||
          (establishesProjection ? "" : current?.identity.companyName || ""),
      )
    : null;
  const incomingSourceProvider = String(incoming.identity.sourceProvider || "").trim();
  const currentSourceProvider = String(current?.identity.sourceProvider || "").trim();
  const mergedIdentity = current
    ? {
        ...current.identity,
        ...incoming.identity,
        sourceProvider: incomingSourceProvider || currentSourceProvider,
        createdAtMs: current.identity.createdAtMs,
      }
    : incoming.identity;
  const identity = current && accountOrder
    ? {
        ...mergedIdentity,
        id: current.identity.accountOrder
          ? current.identity.id
          : mergedIdentity.id,
        bindingSource: current.identity.accountOrder
          ? current.identity.bindingSource
          : mergedIdentity.bindingSource,
        sourceOwner: current.identity.accountOrder
          ? current.identity.sourceOwner
          : mergedIdentity.sourceOwner,
        sourceId: current.identity.accountOrder
          ? current.identity.sourceId
          : mergedIdentity.sourceId,
        orderId: current.identity.orderId || incoming.identity.orderId,
        projectedWaybill: nextProjection || currentProjection,
        orderProjectionRetry: nextProjection
          ? undefined
          : current.identity.orderProjectionRetry ||
            incoming.identity.orderProjectionRetry,
        accountOrder: true,
        manuallyAdded: false,
                courierCode: reclassifiesAccountOrder
          ? incoming.identity.courierCode
          : preservesExistingProjection || !nextProjection
          ? repairedProjectedCarrier(current.identity, incoming.identity).courierCode
          : projectedPresentation?.courierCode || "",
        companyName: reclassifiesAccountOrder
          ? incoming.identity.companyName
          : preservesExistingProjection || !nextProjection
          ? repairedProjectedCarrier(current.identity, incoming.identity).companyName
          : projectedPresentation?.companyName || "快递",
        sourceProvider: incomingSourceProvider || currentSourceProvider,
      }
    : mergedIdentity;
  const keepsCainiaoRoute = String(identity.sourceProvider || "")
    .trim()
    .toLowerCase() === "cainiao";
  const hasProjection = Boolean(nextProjection || currentProjection);
  const incomingOrderPresentation =
    incoming.statusPresentation?.scope === "ORDER" &&
      accountOrder &&
      !hasProjection
      ? incoming.statusPresentation
      : undefined;
  const sameUnprojectedAccountOrder = Boolean(
    current?.identity.accountOrder &&
    !hasProjection &&
    currentSourceId &&
    (
      normalizeWaybill(incoming.identity.sourceId) === currentSourceId ||
      incomingTimelineWaybill === currentSourceId
    ),
  );
  const retainedOrderPresentation =
    sameUnprojectedAccountOrder &&
      current?.statusPresentation?.scope === "ORDER"
      ? current.statusPresentation
      : undefined;
  const candidate: Shipment = {
    ...incoming,
    identity,
    timeline: mergedSource,
    sourceTimeline: mergedSource,
    manualTimelines: manuals,
    statusPresentation:
      incomingOrderPresentation || retainedOrderPresentation,
    forcedCompletedAtMs:
      current?.forcedCompletedAtMs ?? incoming.forcedCompletedAtMs,
    manualRefreshAttemptAtMs:
      current?.manualRefreshAttemptAtMs ?? incoming.manualRefreshAttemptAtMs,
    manualRefreshLease:
      current?.manualRefreshLease ?? incoming.manualRefreshLease,
    route: keepsCainiaoRoute
      ? incoming.route || current?.route || null
      : null,
    accountRecord:
      incoming.accountRecord == null
        ? current?.accountRecord
        : incoming.accountRecord,
    updatedAtMs: now,
  };
  const selected = selectShipmentTimeline(candidate);
  const protectsManualTerminal = Boolean(
    current &&
      !reclassifiesAccountOrder &&
      (isFrozenJingDongShipment(current) ||
        current.identity.manuallyAdded ||
        isShunFengSourceShipment(current) ||
        needsAutomaticManualFallback(current)),
  );
  return {
    ...candidate,
    timeline: protectsManualTerminal
      ? preservesTerminalStatus(
          current?.timeline,
          selected,
          isFrozenJingDongShipment(current),
        )
      : selected,
  };
}

function normalizedAutomaticSource(value: unknown): string {
  const source = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,48}$/.test(source) ? source : "";
}

function normalizedAutomaticBindingIdentity(value: unknown): string {
  const identity = String(value || "").trim().toLowerCase();
  return /^(?:phone:\d{4,32}|tail:\d{4}|unbound)$/.test(identity)
    ? identity
    : "";
}

export function automaticBindingIdentityForPhone(value: unknown): string {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 && digits.length <= 32 ? `phone:${digits}` : "";
}

export function automaticBindingIdentityOf(shipment: Shipment): string {
  const phone = automaticBindingIdentityForPhone(
    shipment.identity.phone || shipment.accountRecord?.phone,
  );
  if (phone) return phone;
  const tail = String(shipment.identity.phoneTail || "").replace(/\D/g, "");
  return /^\d{4}$/.test(tail) ? `tail:${tail}` : "unbound";
}

export function automaticSourceOf(
  shipment: Shipment,
  override = "",
): string {
  const explicit = normalizedAutomaticSource(override);
  if (explicit) return explicit;
  const binding = normalizedAutomaticSource(shipment.identity.bindingSource);
  if (binding) return binding;
  const owner = normalizedAutomaticSource(
    String(shipment.identity.sourceOwner || "").split(":", 1)[0],
  );
  if (owner && owner !== "manual") return owner;
  return normalizedAutomaticSource(
    (shipment.sourceTimeline || shipment.timeline).provider,
  );
}

function observationFromShipment(
  shipment: Shipment,
  source: string,
  observedAtMs: number,
): AutomaticSourceObservation {
  return {
    source,
    bindingIdentity: automaticBindingIdentityOf(shipment),
    bindingValid: true,
    observedAtMs,
    identity: { ...shipment.identity, manuallyAdded: false },
    sourceTimeline: shipment.sourceTimeline || shipment.timeline,
    statusPresentation: shipment.statusPresentation,
    routeCapability: shipment.route || null,
    accountRecord: shipment.accountRecord || null,
  };
}

function mergeAutomaticObservation(
  previous: AutomaticSourceObservation | undefined,
  incoming: AutomaticSourceObservation,
): AutomaticSourceObservation {
  if (!previous) return incoming;
  const previousProjection = normalizedProjectedWaybill(previous.identity);
  const incomingProjection = normalizedProjectedWaybill(incoming.identity);
  const establishesProjection = Boolean(
    previous.identity.accountOrder &&
      incoming.identity.accountOrder &&
      !previousProjection &&
      incomingProjection,
  );
  const rejectsUnprojectedOrderCompletion = Boolean(
    previous.identity.accountOrder &&
      incoming.identity.accountOrder &&
      previousProjection &&
      !incomingProjection &&
      incoming.statusPresentation?.scope === "ORDER" &&
      incoming.statusPresentation.semantic === "COMPLETED",
  );
  const latest = incoming.observedAtMs >= previous.observedAtMs
    ? incoming
    : previous;
  const earlier = latest === incoming ? previous : incoming;
  return {
    ...latest,
    observedAtMs: Math.max(previous.observedAtMs, incoming.observedAtMs),
    identity: establishesProjection
      ? incoming.identity
      : rejectsUnprojectedOrderCompletion
      ? previous.identity
      : latest.identity,
    statusPresentation: establishesProjection
      ? incoming.statusPresentation
      : rejectsUnprojectedOrderCompletion
      ? previous.statusPresentation
      : latest.statusPresentation,
    sourceTimeline: establishesProjection
      ? incoming.sourceTimeline
      : rejectsUnprojectedOrderCompletion
      ? previous.sourceTimeline
      : mergeAutomaticSourceTimeline(
          earlier.sourceTimeline,
          latest.sourceTimeline,
        ),
    routeCapability:
      latest.routeCapability || earlier.routeCapability || null,
    accountRecord:
      latest.accountRecord == null
        ? earlier.accountRecord || null
        : latest.accountRecord,
  };
}

function replaceAutomaticObservation(
  ownership: AutomaticOwnership,
  incoming: AutomaticSourceObservation,
): AutomaticOwnership {
  const previous = ownership.observations.find(
    (observation) =>
      observation.source === incoming.source &&
      observation.bindingIdentity === incoming.bindingIdentity,
  );
  const merged = mergeAutomaticObservation(previous, incoming);
  return {
    ...ownership,
    observations: [
      ...ownership.observations.filter(
        (observation) =>
          observation.source !== incoming.source ||
          observation.bindingIdentity !== incoming.bindingIdentity,
      ),
      merged,
    ],
  };
}

/** Freezes legacy automatic rows to their currently displayed owner. */
export function normalizeAutomaticOwnership(
  shipment: Shipment,
  now = shipment.updatedAtMs || Date.now(),
): Shipment {
  if (shipment.identity.manuallyAdded) {
    if (!shipment.automaticOwnership) return shipment;
    const { automaticOwnership: _ownership, ...manual } = shipment;
    return manual;
  }
  const currentSource = automaticSourceOf(shipment);
  const raw = shipment.automaticOwnership;
  const observations = (raw?.observations || []).flatMap((observation) => {
    const source = normalizedAutomaticSource(observation?.source);
    const bindingIdentity = normalizedAutomaticBindingIdentity(
      observation?.bindingIdentity,
    ) || automaticBindingIdentityOf({
      ...shipment,
      identity: observation.identity,
      accountRecord: observation.accountRecord || null,
    });
    const observedAtMs = Number(observation?.observedAtMs);
    if (
      !source ||
      !Number.isFinite(observedAtMs) ||
      observedAtMs <= 0 ||
      !observation.identity ||
      !observation.sourceTimeline
    ) {
      return [];
    }
    return [{
      ...observation,
      source,
      bindingIdentity,
      bindingValid: observation.bindingValid !== false,
      observedAtMs,
    }];
  });
  const ownerSource = raw
    ? normalizedAutomaticSource(raw.ownerSource) || null
    : currentSource || null;
  const currentBindingIdentity = automaticBindingIdentityOf(shipment);
  const ownerBindingIdentity = ownerSource
    ? normalizedAutomaticBindingIdentity(raw?.ownerBindingIdentity) ||
      (ownerSource === currentSource ? currentBindingIdentity : "") ||
      observations.find((observation) => observation.source === ownerSource)
        ?.bindingIdentity ||
      "unbound"
    : null;
  let ownership: AutomaticOwnership = {
    ownerSource,
    ownerBindingIdentity,
    claimedAtMs: Number.isFinite(Number(raw?.claimedAtMs))
      ? Math.max(0, Number(raw?.claimedAtMs))
      : ownerSource
        ? shipment.identity.createdAtMs || now
        : 0,
    lastTakeoverAtMs: Number.isFinite(Number(raw?.lastTakeoverAtMs))
      ? Math.max(0, Number(raw?.lastTakeoverAtMs))
      : 0,
    ownerMisses: Number.isInteger(raw?.ownerMisses) &&
        Number(raw?.ownerMisses) >= 0
      ? Number(raw?.ownerMisses)
      : 0,
    takeoverPending: Boolean(raw?.takeoverPending),
    observations,
  };
  if (
    currentSource &&
    (!raw || ownerSource === currentSource) &&
    !ownership.observations.some(
      (observation) =>
        observation.source === currentSource &&
        observation.bindingIdentity === currentBindingIdentity,
    )
  ) {
    ownership = replaceAutomaticObservation(
      ownership,
      observationFromShipment(
        shipment,
        currentSource,
        shipment.updatedAtMs || now,
      ),
    );
  }
  return { ...shipment, automaticOwnership: ownership };
}

export function isQualifiedAutomaticShipment(
  shipment: Shipment,
  sourceInput = "",
): boolean {
  if (shipment.identity.manuallyAdded) return false;
  const source = automaticSourceOf(shipment, sourceInput);
  const declaredSource = automaticSourceOf(shipment);
  const sourceTimeline = shipment.sourceTimeline || shipment.timeline;
  const rawCarrierCode = String(shipment.identity.rawCourierCode || "").trim();
  const rawCompanyName = String(shipment.identity.rawCompanyName || "").trim();
  const trustedAccountProjection = Boolean(
    shipment.identity.accountOrder &&
      normalizedProjectedWaybill(shipment.identity),
  );
  return Boolean(
    source &&
    declaredSource === source &&
    // JD's order page can establish the carrier waybill even when the account
    // snapshot omits the raw carrier fields required from ordinary list rows.
    (rawCarrierCode || rawCompanyName || trustedAccountProjection) &&
    sourceTimeline.semantic !== "UNKNOWN" &&
    timedTracks(sourceTimeline.tracks).length > 0 &&
    normalizedAutomaticSource(sourceTimeline.provider) === source,
  );
}

function projectAutomaticObservation(
  current: Shipment,
  observation: AutomaticSourceObservation,
  ownership: AutomaticOwnership,
  now: number,
): Shipment {
  const candidate: Shipment = {
    ...current,
    identity: { ...observation.identity, manuallyAdded: false },
    timeline: observation.sourceTimeline,
    sourceTimeline: observation.sourceTimeline,
    statusPresentation: observation.statusPresentation,
    manualTimelines: manualTimelines(current),
    automaticOwnership: ownership,
    route: observation.routeCapability || null,
    accountRecord: observation.accountRecord || null,
    forcedCompletedAtMs: current.forcedCompletedAtMs,
    manualRefreshAttemptAtMs: current.manualRefreshAttemptAtMs,
    manualRefreshLease: current.manualRefreshLease,
    updatedAtMs: now,
  };
  return { ...candidate, timeline: selectShipmentTimeline(candidate) };
}

function takeAutomaticOwnership(
  current: Shipment,
  ownership: AutomaticOwnership,
  observation: AutomaticSourceObservation,
  now: number,
): Shipment {
  const nextOwnership: AutomaticOwnership = {
    ...ownership,
    ownerSource: observation.source,
    ownerBindingIdentity: observation.bindingIdentity,
    claimedAtMs: now,
    lastTakeoverAtMs: ownership.ownerSource ? now : ownership.lastTakeoverAtMs,
    ownerMisses: 0,
    takeoverPending: false,
  };
  return projectAutomaticObservation(current, observation, nextOwnership, now);
}

/**
 * Applies the four-part qualification gate only when ownership is established.
 * The frozen owner may keep updating when a later feed omits a qualifying field.
 */
export function observeQualifiedAutomaticShipment(
  currentInput: Shipment | undefined,
  incoming: Shipment,
  sourceInput = "",
  now = Date.now(),
): Shipment {
  const source = automaticSourceOf(incoming, sourceInput);
  if (!source) throw new Error("automatic source is required");
  const currentAutomatic = currentInput && !currentInput.identity.manuallyAdded
    ? normalizeAutomaticOwnership(currentInput, now)
    : null;
  const incomingBindingIdentity = automaticBindingIdentityOf(incoming);
  const updatesEstablishedOwner = Boolean(
    currentAutomatic?.automaticOwnership?.ownerSource === source &&
      currentAutomatic.automaticOwnership.ownerBindingIdentity ===
        incomingBindingIdentity,
  );
  if (
    !updatesEstablishedOwner &&
    !isQualifiedAutomaticShipment(incoming, source)
  ) {
    if (currentInput) return normalizeAutomaticOwnership(currentInput, now);
    const unowned: Shipment = {
      ...incoming,
      automaticOwnership: {
        ownerSource: null,
        ownerBindingIdentity: null,
        claimedAtMs: 0,
        lastTakeoverAtMs: 0,
        ownerMisses: 0,
        takeoverPending: false,
        observations: [],
      },
    };
    return { ...unowned, timeline: selectShipmentTimeline(unowned) };
  }
  const incomingPackage = mergeAccountShipmentPackage(undefined, incoming, now);
  if (!currentInput) {
    return normalizeAutomaticOwnership({
      ...incomingPackage,
      automaticOwnership: {
        ownerSource: source,
        ownerBindingIdentity: automaticBindingIdentityOf(incomingPackage),
        claimedAtMs: now,
        lastTakeoverAtMs: 0,
        ownerMisses: 0,
        takeoverPending: false,
        observations: [observationFromShipment(incomingPackage, source, now)],
      },
    }, now);
  }
  if (currentInput.identity.manuallyAdded) {
    const manuals = manualTimelines(currentInput);
    const claimed = normalizeAutomaticOwnership({
      ...incomingPackage,
      manualTimelines: manuals,
      route: incomingPackage.route || null,
      automaticOwnership: {
        ownerSource: source,
        ownerBindingIdentity: automaticBindingIdentityOf(incomingPackage),
        claimedAtMs: now,
        lastTakeoverAtMs: 0,
        ownerMisses: 0,
        takeoverPending: false,
        observations: [observationFromShipment(incomingPackage, source, now)],
      },
    }, now);
    return { ...claimed, timeline: selectShipmentTimeline(claimed) };
  }

  const current = currentAutomatic || normalizeAutomaticOwnership(currentInput, now);
  let ownership = current.automaticOwnership as AutomaticOwnership;
  const normalizedIncomingBindingIdentity = automaticBindingIdentityOf(incomingPackage);
  if (
    ownership.ownerSource === source &&
    ownership.ownerBindingIdentity === normalizedIncomingBindingIdentity
  ) {
    const merged = mergeAccountShipmentPackage(current, incoming, now);
    ownership = replaceAutomaticObservation(
      ownership,
      observationFromShipment(merged, source, now),
    );
    ownership = {
      ...ownership,
      ownerMisses: 0,
      takeoverPending: false,
    };
    return { ...merged, automaticOwnership: ownership };
  }

  ownership = replaceAutomaticObservation(
    ownership,
    observationFromShipment(incomingPackage, source, now),
  );
  const withCandidate = { ...current, automaticOwnership: ownership };
  const incomingObservation = ownership.observations.find(
    (observation) =>
      observation.source === source &&
      observation.bindingIdentity === normalizedIncomingBindingIdentity,
  );
  if (!incomingObservation) return withCandidate;
  if (!ownership.ownerSource) {
    return takeAutomaticOwnership(withCandidate, ownership, incomingObservation, now);
  }
  const outsideCooldown = !ownership.lastTakeoverAtMs ||
    now - ownership.lastTakeoverAtMs >= AUTOMATIC_TAKEOVER_COOLDOWN_MS;
  return ownership.takeoverPending && outsideCooldown
    ? takeAutomaticOwnership(withCandidate, ownership, incomingObservation, now)
    : withCandidate;
}

/**
 * Coalesces a second row for the same canonical waybill without re-arbitrating
 * the already claimed owner. Per-source observations remain independent and
 * the displayed package is rebuilt only from that frozen owner's observation.
 */
export function absorbAutomaticShipment(
  ownerInput: Shipment,
  duplicateInput: Shipment,
  now: number,
): Shipment {
  if (ownerInput.identity.manuallyAdded || duplicateInput.identity.manuallyAdded) {
    return ownerInput;
  }
  const owner = normalizeAutomaticOwnership(ownerInput, now);
  const duplicate = normalizeAutomaticOwnership(duplicateInput, now);
  let ownership = owner.automaticOwnership as AutomaticOwnership;
  for (const observation of duplicate.automaticOwnership?.observations || []) {
    ownership = replaceAutomaticObservation(ownership, observation);
  }
  let manuals = manualTimelines(owner);
  for (const timeline of manualTimelines(duplicate)) {
    manuals = mergeTimelineAuthorities(manuals, timeline);
  }
  const merged: Shipment = {
    ...owner,
    manualTimelines: manuals,
    automaticOwnership: ownership,
    updatedAtMs: now,
  };
  const ownerObservation = ownership.observations.find(
    (observation) =>
      observation.source === ownership.ownerSource &&
      observation.bindingIdentity === ownership.ownerBindingIdentity,
  );
  return ownerObservation
    ? projectAutomaticObservation(merged, ownerObservation, ownership, now)
    : { ...merged, timeline: selectShipmentTimeline(merged) };
}

export function applyAccountShipment(
  current: Shipment | undefined,
  incoming: Shipment,
  now: number,
  automaticSource = "",
): Shipment {
  return preserveUserFields(current, incoming, observeQualifiedAutomaticShipment(
    current,
    incoming,
    automaticSource,
    now,
  ));
}

/**
 * 用户自己写的字段不归任何来源：备注（用户定 2026-09-05 晚）跟着存着的那一行走，同步合并从不改它；
 * 粘性选包的记录以这次刷新盖的为准，没有就沿用存着的。合并函数里有些分支是重新拼对象的，所以在
 * 这里统一兜住，而不是逐个分支补字段。
 */
/**
 * 签收（或取消）那一刻的轨迹是这一票的定稿：进入终态之后，后续任何合并都不得让它的节点变少。
 * 用户定 2026-09-07：「签收之后所有状态、冻结之前的轨迹都要保留，直到生命周期结束」。
 * 冻结判据本身要求「终态 + 可用历史」，所以一旦节点被抹掉，这一行反而不再冻结、继续参与刷新，
 * 下一轮再抹一次——丢轨迹的行就是这么长期卡住的。这里只兜「不许变少」，变多（更完整的包）照收。
 */
/**
 * 「签收之后轨迹不许变少」（用户定 2026-09-07）。除了合并路径，落库前也要过一遍：整行被 feed
 * 重建（`current` 丢了）时合并里的这道闸根本不会执行，那一行会被写成只有 feed 包的空壳
 * （用户 2026-09-08 报：签收件每轮刷新之后「暂无物流动态」）。
 */
export function preserveSettledShipment(
  current: Shipment | undefined,
  merged: Shipment,
): Shipment {
  return preserveSettledTimeline(current, merged);
}

function preserveSettledTimeline(
  current: Shipment | undefined,
  merged: Shipment,
): Shipment {
  if (!current || !hasSettledTimelineHistory(current)) return merged;
  const kept = timedTracks(current.timeline.tracks).length;
  if (!kept) return merged;
  const next = timedTracks(merged.timeline.tracks).length;
  if (next >= kept) return merged;
  return {
    ...merged,
    timeline: current.timeline,
    sourceTimeline: current.sourceTimeline ?? merged.sourceTimeline,
    manualTimelines: manualTimelines(current).length
      ? manualTimelines(current)
      : merged.manualTimelines,
  };
}

function preserveUserFields(
  current: Shipment | undefined,
  incoming: Shipment,
  mergedInput: Shipment,
): Shipment {
  const merged = preserveSettledTimeline(current, mergedInput);
  const note = String(merged.note || current?.note || "").trim();
  const detailSelection = merged.detailSelection || incoming.detailSelection ||
    current?.detailSelection;
  if ((merged.note || "") === note && merged.detailSelection === detailSelection) {
    return merged;
  }
  const result: Shipment = { ...merged };
  if (note) result.note = note;
  else delete result.note;
  if (detailSelection) result.detailSelection = detailSelection;
  else delete result.detailSelection;
  return result;
}

/** Explicit unbind/credential revocation only; request failures must not call this. */
export function invalidateAutomaticOwner(
  shipmentInput: Shipment,
  sourceInput: string,
  now = Date.now(),
  bindingIdentityInput = "",
): Shipment {
  const shipment = normalizeAutomaticOwnership(shipmentInput, now);
  const ownership = shipment.automaticOwnership;
  const source = normalizedAutomaticSource(sourceInput);
  const bindingIdentity = normalizedAutomaticBindingIdentity(bindingIdentityInput) ||
    automaticBindingIdentityForPhone(bindingIdentityInput) ||
    ownership?.ownerBindingIdentity || "";
  if (!ownership || !source || !bindingIdentity) return shipment;
  const hasBindingObservation = ownership.observations.some(
    (observation) =>
      observation.source === source &&
      observation.bindingIdentity === bindingIdentity &&
      observation.bindingValid !== false,
  );
  if (!hasBindingObservation) return shipment;
  const retainedObservations = ownership.observations.map(
    (observation) =>
      observation.source === source &&
        observation.bindingIdentity === bindingIdentity
        ? { ...observation, bindingValid: false }
        : observation,
  );
  const invalidatesOwner = ownership.ownerSource === source &&
    ownership.ownerBindingIdentity === bindingIdentity;
  if (!invalidatesOwner) {
    return {
      ...shipment,
      automaticOwnership: { ...ownership, observations: retainedObservations },
    };
  }
  const replacement = [...retainedObservations]
    .filter((observation) => observation.bindingValid !== false)
    .sort((left, right) =>
      right.observedAtMs - left.observedAtMs ||
      left.source.localeCompare(right.source) ||
      left.bindingIdentity.localeCompare(right.bindingIdentity)
    )[0];
  const retainedOwnership = { ...ownership, observations: retainedObservations };
  if (replacement) {
    return takeAutomaticOwnership(shipment, retainedOwnership, replacement, now);
  }
  return {
    ...shipment,
    route: null,
    automaticOwnership: {
      ...ownership,
      ownerSource: null,
      ownerBindingIdentity: null,
      observations: retainedObservations,
      claimedAtMs: 0,
      ownerMisses: 0,
      takeoverPending: false,
    },
  };
}

export type AutomaticRefreshExecution = "not_executed" | "observed" | "missing";

export function recordAutomaticOwnerRefresh(
  shipmentInput: Shipment,
  sourceInput: string,
  execution: AutomaticRefreshExecution,
  now = Date.now(),
): Shipment {
  const shipment = normalizeAutomaticOwnership(shipmentInput, now);
  const ownership = shipment.automaticOwnership;
  const source = normalizedAutomaticSource(sourceInput);
  if (!ownership || ownership.ownerSource !== source || execution === "not_executed") {
    return shipment;
  }
  if (execution === "observed") {
    return {
      ...shipment,
      automaticOwnership: {
        ...ownership,
        ownerMisses: 0,
        takeoverPending: false,
      },
    };
  }
  if (selectShipmentTimeline(shipment).semantic === "COMPLETED") return shipment;
  if (
    ownership.lastTakeoverAtMs &&
    now - ownership.lastTakeoverAtMs < AUTOMATIC_TAKEOVER_COOLDOWN_MS
  ) {
    return shipment;
  }
  const ownerMisses = ownership.ownerMisses + 1;
  const pending: Shipment = {
    ...shipment,
    automaticOwnership: {
      ...ownership,
      ownerMisses,
      takeoverPending: ownerMisses >= AUTOMATIC_OWNER_MISS_LIMIT,
    },
  };
  if (ownerMisses < AUTOMATIC_OWNER_MISS_LIMIT) return pending;
  const replacement = [...ownership.observations]
    .filter((observation) =>
      observation.bindingValid !== false &&
      (
        observation.source !== source ||
        observation.bindingIdentity !== ownership.ownerBindingIdentity
      )
    )
    .sort((left, right) =>
      right.observedAtMs - left.observedAtMs ||
      left.source.localeCompare(right.source) ||
      left.bindingIdentity.localeCompare(right.bindingIdentity)
    )[0];
  return replacement
    ? takeAutomaticOwnership(
        pending,
        pending.automaticOwnership as AutomaticOwnership,
        replacement,
        now,
      )
    : pending;
}

/** Caches hidden H5 extraction as an independent incremental authority. */
export function applySameSourceTimeline(
  current: Shipment,
  incomingTimeline: TimelinePackage,
  now: number,
): Shipment {
  if (!current.identity.manuallyAdded && !current.identity.bindingSource) {
    return current;
  }
  let manuals = manualTimelines(current);
  if (normalizeTimelineSlot(incomingTimeline.provider) === TIMELINE_SLOT.K100_H5) {
    if (!isVerifiedKuaidi100Timeline(incomingTimeline)) return current;
    const incomingCarrier = resolveCarrierQuery(incomingTimeline.courierCode);
    const incomingWaybill = normalizeWaybill(incomingTimeline.waybill);
    manuals = manuals.filter((timeline) =>
      normalizeTimelineSlot(timeline.provider) !== TIMELINE_SLOT.K100_H5 ||
      (
        isVerifiedKuaidi100Timeline(timeline) &&
        resolveCarrierQuery(timeline.courierCode)?.standardCode ===
          incomingCarrier?.standardCode &&
        normalizeWaybill(timeline.waybill) === incomingWaybill
      )
    );
  }
  manuals = mergeTimelineAuthorities(manuals, incomingTimeline);
  const candidate: Shipment = {
    ...current,
    manualTimelines: manuals,
    updatedAtMs: now,
  };
  return {
    ...candidate,
    timeline: selectShipmentTimeline(candidate),
  };
}

export function applyManualShipment(
  current: Shipment | undefined,
  incoming: Shipment,
  now: number,
): Shipment {
  return preserveUserFields(
    current,
    incoming,
    applyManualShipmentInner(current, incoming, now),
  );
}

function applyManualShipmentInner(
  current: Shipment | undefined,
  incoming: Shipment,
  now: number,
): Shipment {
  if (!current) {
    let manuals: TimelinePackage[] = [];
    for (const timeline of [
      ...(incoming.manualTimelines || []),
      incoming.timeline,
    ]) {
      manuals = mergeTimelineAuthorities(manuals, timeline);
    }
    const keepsCainiaoRoute = String(incoming.identity.sourceProvider || "")
      .trim()
      .toLowerCase() === "cainiao";
    const route = incoming.identity.manuallyAdded && incoming.route?.kind === "web"
      ? incoming.route
      : keepsCainiaoRoute && incoming.route?.kind === "cainiao"
        ? incoming.route
        : null;
    return {
      ...incoming,
      route,
      timeline: selectTimelineAuthority(null, manuals) || incoming.timeline,
      sourceTimeline: null,
      manualTimelines: manuals,
      updatedAtMs: now,
    };
  }
  const source = sourceTimeline(current);
  let manuals = withoutForeignManualPackages(current, manualTimelines(current));
  for (const timeline of [
    ...(incoming.manualTimelines || []),
    incoming.timeline,
  ]) {
    // R-29: a provider package from another parcel never enters the cache.
    if (isForeignManualPackage(current, timeline)) continue;
    manuals = mergeTimelineAuthorities(manuals, timeline);
  }
  const identity = current.identity.manuallyAdded
    ? {
        ...current.identity,
        ...incoming.identity,
        id: current.identity.id,
        bindingSource: current.identity.bindingSource,
        createdAtMs: current.identity.createdAtMs,
        // 尾号是用户自己输进来的，后续刷新的来源包不一定带它；这里是整份 spread，空值会把它
        // 覆盖掉，之后需要校验尾号的承运商就再也查不动了（2026-09-07 复查）。空值一律不覆盖。
        phoneTail: String(incoming.identity.phoneTail || "").trim() ||
          current.identity.phoneTail,
        phone: String(incoming.identity.phone || "").trim() || current.identity.phone,
      }
    : current.identity;
  const keepsCainiaoRoute = String(identity.sourceProvider || "")
    .trim()
    .toLowerCase() === "cainiao";
  const route = identity.manuallyAdded && (
      current.route?.kind === "web" || incoming.route?.kind === "web"
    )
    ? current.route?.kind === "web" ? current.route : incoming.route || null
    : keepsCainiaoRoute && current.route?.kind === "cainiao"
      ? current.route
      : null;
  const candidate: Shipment = {
    ...current,
    identity,
    timeline: source || incoming.timeline,
    sourceTimeline: source,
    manualTimelines: manuals,
    route,
    forcedCompletedAtMs:
      current.forcedCompletedAtMs ?? incoming.forcedCompletedAtMs,
    updatedAtMs: now,
  };
  const selected = selectShipmentTimeline(candidate);
  const protectsManualTerminal = isFrozenJingDongShipment(current) ||
    current.identity.manuallyAdded ||
    isShunFengSourceShipment(current) || needsAutomaticManualFallback(current);
  return {
    ...candidate,
    timeline: protectsManualTerminal
      ? preservesTerminalStatus(
          current.timeline,
          selected,
          isFrozenJingDongShipment(current),
        )
      : selected,
  };
}

export function absorbManualShipment(
  accountOwner: Shipment,
  manualOwner: Shipment,
  now: number,
): Shipment {
  let result = accountOwner;
  for (const timeline of manualTimelines(manualOwner)) {
    result = applyManualShipment(
      result,
      { ...manualOwner, timeline },
      now,
    );
  }
  return result;
}

export function absorbHistoricalShipment(
  accountOwner: Shipment,
  historicalOwner: Shipment,
  now: number,
): Shipment {
  const accountSource = sourceTimeline(accountOwner);
  let manuals = manualTimelines(accountOwner);
  const historicalSource = sourceTimeline(historicalOwner);
  // 老行的 feed 若来自同一个 feed 来源（interface5），并进 source 槽——当前行的 feed 拥有展示，老节点
  // 只补空；以前它被当成 provider=interface5 的手动包，读盘改名后就混进了 v5_query 槽（2026-09-06）。
  // 别的来源（interface6）的老包照旧当手动权威保留。
  const sameFeed = Boolean(
    historicalSource &&
      historicalSource.provider.trim().toLowerCase() ===
        (accountSource?.provider || SCRIPT_BINDING_SOURCE).trim().toLowerCase(),
  );
  const source = sameFeed && historicalSource
    ? accountSource
      ? mergeAutomaticSourceTimeline(historicalSource, accountSource)
      : historicalSource
    : accountSource;
  const authorities = [
    ...(historicalSource && !sameFeed ? [historicalSource] : []),
    ...manualTimelines(historicalOwner),
  ];
  for (const timeline of authorities) {
    const provider = timeline.provider.trim().toLowerCase();
    const previous = manuals.find(
      (item) => item.provider.trim().toLowerCase() === provider,
    ) || null;
    manuals = [
      ...manuals.filter(
        (item) => item.provider.trim().toLowerCase() !== provider,
      ),
      mergeTimelinePackage(previous, timeline),
    ];
  }
  const candidate: Shipment = {
    ...accountOwner,
    timeline: source || accountOwner.timeline,
    sourceTimeline: source,
    manualTimelines: manuals,
    updatedAtMs: now,
  };
  const selected = selectShipmentTimeline(candidate);
  const protectsManualTerminal = isFrozenJingDongShipment(accountOwner) ||
    accountOwner.identity.manuallyAdded ||
    isShunFengSourceShipment(accountOwner) ||
    needsAutomaticManualFallback(accountOwner);
  return {
    ...candidate,
    timeline: protectsManualTerminal
      ? preservesTerminalStatus(
          accountOwner.timeline,
          selected,
          isFrozenJingDongShipment(accountOwner),
        )
      : selected,
  };
}
