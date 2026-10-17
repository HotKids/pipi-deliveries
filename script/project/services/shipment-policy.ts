import { nodeNormalizedStatus, timelineNormalizedStatus, statusPriority, statusProjectionFields } from "./worker-status";
import { normalizeTimelineSlot, TIMELINE_SLOT } from "./timeline-slot";
import type {
  AutomaticOwnership,
  AutomaticSourceObservation,
  Shipment,
  StatusSemantic,
  TimelinePackage,
  TrackNode,
} from "../models";
import {
  accountOrderSemantic,
  accountListOriginAtMs,
  withAccountListOrigin,
  compareTimelinePackageCompleteness,
  compareTimelineProviderOrder,
  containsTimelinePickupTrack,
  containsTimelineStartTrack,
  latestTimelineTrackStatuses,
  latestTimelineTrackSemantic,
  manualTimelineIsComplete,
  isAccountUpdateSummary,
  isNonEventDetail,
  headlineTrack,
  mergeTimelineAuthorities,
  mergeTimelinePackage,
  mergeTracks,
  normalizedProjectedWaybill,
  normalizeWaybill,
  parseProviderTime,
  selectTimelineAuthority,
  splitJingDongH5Nodes,
  terminalEvidenceAtMs,
  shipmentDetailPresentationStatus,
  shouldRefreshShipment,
  timedTracks,
  timelineCapability,
  timelineLatestEventAt,
  timelineLatestTrackAt,
  withMergedHeadline,
  isJingDongOrderCompletionNode,
  jingDongAnchorEvidence,
  jingDongSignedAnchorAtMs,
  withoutJingDongOrderCompletion,
} from "./status";
import { incomingStatusAdvances, latestEventEvidence } from "./status";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import {
  newerWaybillReuseGeneration,
  shipmentReusesWaybill as presentedShipmentReusesWaybill,
} from "./waybill-reuse";

export const MANUAL_REFRESH_MIN_INTERVAL_MS = 30_000;
export const AUTOMATIC_TAKEOVER_COOLDOWN_MS = 2 * 60 * 60 * 1_000;
export const AUTOMATIC_OWNER_MISS_LIMIT = 1;
import { SCRIPT_BINDING_SOURCE } from "./script-source";
import { alignmentAttemptFinished, signedReleaseUsed } from "./row-ledger";
import { projectedCarrierPresentation } from "./carrier-presentation";
import {
  resolveCarrierCpCode,
  resolveCarrierKuaidi100Code,
  resolveCarrierQuery,
} from "./carrier-query";
import { normalizeCarrierCode } from "./carrier-query";
import { primaryH5Provider } from "./jt-h5";

function sourceTimeline(shipment: Shipment): TimelinePackage | null {
  if (shipment.identity.manuallyAdded) return null;
  return withoutJingDongOrderCompletion(
    shipment.sourceTimeline || shipment.timeline, shipment.identity,
    false, jingDongSignedAnchorAtMs(shipment), jingDongAnchorEvidence(shipment),
  );
}

function manualTimelines(shipment: Shipment): TimelinePackage[] {
  if (Array.isArray(shipment.manualTimelines)) {
    return shipment.manualTimelines.map((timeline) =>
      withoutJingDongOrderCompletion(timeline, shipment.identity, false, jingDongSignedAnchorAtMs(shipment),
        jingDongAnchorEvidence(shipment))
    );
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
  // Keep the list's observed origin when its next snapshot replaces older nodes.
  const originAt = accountListOriginAtMs(anchor);
  return originAt > 0 ? originAt - FOREIGN_PACKAGE_ANCHOR_SLACK_MS : null;
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
  // The anchor judges only the Picker / K100 H5 / KDNiao packages (AGENTS §9, R-29). The order's own
  // per-waybill query and its own union page are this order's history, whatever its first feed node
  // says (audit D1, adopted 2026-09-25; Pipi already exempts both).
  const slot = normalizeTimelineSlot(provider);
  if (slot === TIMELINE_SLOT.V5_QUERY || slot === TIMELINE_SLOT.JD_H5) return false;
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
  // The H5 page is requested for this waybill; legacy `web` packages share that owner binding.
  // Only the legacy JSON-query id `kuaidi100_h5` requires a carrier marker on every node.
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
    TIMELINE_SLOT.V6_QUERY,
    TIMELINE_SLOT.V2_QUERY,
    TIMELINE_SLOT.CN_H5,
    TIMELINE_SLOT.K100_H5,
    TIMELINE_SLOT.JT_H5,
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

/** Only the owner's same-waybill account query can compete with its feed fields. */
function accountPresentationCandidates(shipment: Shipment): TimelinePackage[] {
  const source = sourceTimeline(shipment);
  if (!source || shipment.identity.manuallyAdded || isShunFengSourceShipment(shipment)) return source ? [source] : [];
  return [source, ...selectedManualTimelines(shipment).filter(timeline =>
    normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.V5_QUERY &&
    normalizeWaybill(timeline.waybill) === displayWaybill(shipment)
  )];
}

function accountPresentationReference(shipment: Shipment): TimelinePackage | null {
  return accountPresentationCandidates(shipment).reduce<TimelinePackage | null>((latest, candidate) =>
    !latest || timelineLatestEventAt(candidate) > timelineLatestEventAt(latest) ? candidate : latest,
  null);
}

/** The account reference detail ranking aligns to, read without temporary reviews (用户 2026-09-27「不算」). */
function rankingAccountReference(shipment: Shipment): TimelinePackage | null {
  return accountPresentationCandidates(shipment).map(candidate => withoutKeptReviewNodes(shipment, candidate))
    .reduce<TimelinePackage | null>((latest, candidate) =>
      !latest || timelineLatestEventAt(candidate) > timelineLatestEventAt(latest) ? candidate : latest,
    null);
}

/**
 * What a surface may show of one package: the provider's update placeholder (「快递状态已更新」 in any
 * of its forms) is never a timeline node or a headline, from any source (user instruction 2026-09-12,
 * restated 2026-09-26; previously Cainiao sources only). The stored package keeps it.
 */
function displayedTimelinePresentation(_shipment: Shipment, value: TimelinePackage): TimelinePackage {
  const tracks = value.tracks.filter(track => !isAccountUpdateSummary(track.detail));
  const summaryHeadline = isAccountUpdateSummary(value.latestDetail);
  if (tracks.length === value.tracks.length && !summaryHeadline) return value;
  const latest = headlineTrack(tracks);
  // Keep the raw source clock for change detection; only real nodes belong to the displayed package.
  return { ...value, tracks,
    ...(summaryHeadline ? { latestDetail: latest?.detail || "", latestTimeText: latest?.timeText || "" } : {}),
    ...(tracks.length ? {} : { complete: false }),
  };
}

function accountHeadlineReference(shipment: Shipment): TimelinePackage | null {
  if (!hasSourceProvider(shipment, "CaiNiao")) {
    const reference = accountPresentationReference(shipment);
    return reference ? displayedTimelinePresentation(shipment, reference) : null;
  }
  // A generic feed update may share the query's clock but never its actual event text.
  return accountPresentationCandidates(shipment)
    .map(candidate => displayedTimelinePresentation(shipment, candidate))
    .filter(candidate => candidate.latestDetail && !isNonEventDetail(candidate.latestDetail))
    .reduce<TimelinePackage | null>((latest, candidate) => !latest ||
      (parseProviderTime(candidate.latestTimeText) || 0) > (parseProviderTime(latest.latestTimeText) || 0)
      ? candidate : latest, null);
}

const PRE_KDNIAO_TIMELINE_PROVIDERS = new Set<string>([
  TIMELINE_SLOT.V5_QUERY,
  TIMELINE_SLOT.V4_QUERY,
  TIMELINE_SLOT.V6_QUERY,
  TIMELINE_SLOT.V2_QUERY,
  TIMELINE_SLOT.CN_H5,
  TIMELINE_SLOT.K100_H5,
  TIMELINE_SLOT.JT_H5,
  TIMELINE_SLOT.JD_H5,
]);

function isShunFengManualTimeline(timeline: TimelinePackage): boolean {
  return normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.V6_QUERY ||
    isVerifiedKuaidi100Timeline(timeline) || timelineCapability(timeline.provider) === "fallback";
}

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
  preserveCompletedClock = false,
): TimelinePackage {
  if (
    !allowCrossProvider && previous?.structuredStatus !== true &&
    previous?.provider.trim().toLowerCase() !==
      selected.provider.trim().toLowerCase()
  ) {
    return selected;
  }
  const previousTerminal = previous?.semantic === "COMPLETED" ||
    previous?.semantic === "CANCELLED";
  const selectedTerminal = selected.semantic === "COMPLETED" ||
    selected.semantic === "CANCELLED";
  // JD list and query are independent packages; a later order completion must
  // retain the shipment's already accepted signature rather than start its clock again.
  if (preserveCompletedClock && previous?.semantic === "COMPLETED" &&
      selected.semantic === "COMPLETED" && previous.structuredStatus === true &&
      previous.statusEventAtMs! > 0 && previous.statusEventAtMs! <= Date.now()) {
    return { ...selected, structuredStatus: true, statusEventAtMs: previous.statusEventAtMs,
      ...statusProjectionFields(previous, selected) };
  }
  // Matching H5 prose does not replace the structured confirmation already owned by the parcel.
  if (previousTerminal && selected.semantic === previous?.semantic &&
      previous.structuredStatus === true && selected.structuredStatus !== true) {
    return { ...selected, structuredStatus: true, statusEventAtMs: previous.statusEventAtMs,
      ...statusProjectionFields(previous, selected) };
  }
  if (!previousTerminal || selectedTerminal) {
    return selected;
  }
  return {
    ...selected,
    semantic: previous?.semantic === "CANCELLED" ? "CANCELLED" : "COMPLETED",
    statusEventAtMs: previous?.statusEventAtMs ?? null,
    structuredStatus: previous?.structuredStatus,
    ...statusProjectionFields(previous || undefined, selected),
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
  // v5 list owns a replaceable snapshot; query and H5 histories remain in their own slots.
  const feedCurrent = current ? splitJingDongH5Nodes(current).feed : null;
  const v5List = ["interface5", "account", "v5_list"].includes(incoming.provider.toLowerCase());
  return mergeTimelinePackage(feedCurrent, splitJingDongH5Nodes(incoming).feed, !v5List);
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

/** JingDong H5 remains independent of both account list and query history. */
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
    normalizedStatus: undefined,
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
  return !source || !containsTimelinePickupTrack(feedOwnTracks(source.tracks));
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
  if (isShunFengSourceShipment(shipment)) {
    return selectedManualTimelines(shipment).some((timeline) =>
      isShunFengManualTimeline(timeline) &&
      PRE_KDNIAO_TIMELINE_PROVIDERS.has(normalizeTimelineSlot(timeline.provider)) &&
      timelineHasUsableHistory(timeline)
    );
  }
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

/** Revalidate accumulated origin evidence against the current whole-package clock and status. */
export function hasTimelineStartBeforeKdniao(shipment: Shipment): boolean {
  const source = sourceTimeline(shipment);
  const sf = isShunFengSourceShipment(shipment);
  // SF account/query/H5 packages are display fallback, never evidence that its manual chain is complete.
  const manuals = sf
    ? selectedManualTimelines(shipment).filter(isShunFengManualTimeline)
    : manualTimelines(shipment);
  return hasAlignedTimelineStart(shipment, [
    ...(!sf && source ? [source] : []),
    ...manuals.filter((timeline) =>
      PRE_KDNIAO_TIMELINE_PROVIDERS.has(
        normalizeTimelineSlot(timeline.provider),
      )
    ),
  ]);
}

/** Only the refreshed Picker's aligned accumulated origin can stop the primary round. */
export function hasPickerTimelineStart(shipment: Shipment): boolean {
  return hasAlignedTimelineStart(shipment, manualTimelines(shipment).filter((timeline) =>
    normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.V6_QUERY
  ));
}

function hasAlignedTimelineStart(input: Shipment, packages: readonly TimelinePackage[]): boolean {
  // Judged as an ordinary row while a right-swipe sign-off still refreshes (用户 2026-10-02「显示已签收、照常刷新」).
  const shipment = withoutTemporaryReviews(refreshGateView(input));
  const candidates = packages.map((timeline) => withoutKeptReviewNodes(input, timeline));
  const pool = detailHistoryCandidates(shipment);
  const waybill = displayWaybill(shipment);
  const now = Date.now();
  const usesManualReference = isShunFengSourceShipment(shipment) || shipment.identity.manuallyAdded;
  const references = isShunFengSourceShipment(shipment) ? pool.sfManuals : pool.candidates;
  const reference = usesManualReference
    ? references.filter(candidate => normalizeWaybill(candidate.waybill) === waybill &&
      timelineLatestEventAt(candidate) > 0 && timelineLatestEventAt(candidate) <= now)
      .reduce<TimelinePackage | null>((latest, candidate) =>
      !latest || timelineLatestEventAt(candidate) > timelineLatestEventAt(latest) ? candidate : latest, null)
    : accountPresentationReference(shipment);
  const referenceAt = reference ? timelineLatestEventAt(reference) : 0;
  if (!(referenceAt > 0 && referenceAt <= now)) return false;
  const selected = selectShipmentDetailTimeline(shipment);
  const expected = shipmentDetailPresentationStatus(shipment, selected).semantic;
  const terminalAt = terminalEvidenceAtMs({ ...shipment, timeline: selected });
  return candidates.some(timeline =>
    normalizeWaybill(timeline.waybill) === waybill &&
    !isForeignManualPackage(shipment, timeline) &&
    detailTimelineIncompleteReason(timeline, reference, expected, terminalAt,
      containsTimelineStartTrack(timeline.tracks)) === null
  );
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

/**
 * 京东件签收那一条常是被拦掉的评价文案（或者根本没有节点），feed 虽然早有揽收，显示的历史却停在「派送中」，
 * 签收节点只在京粉页里。已签收（结构化、带完成时间）、已有真实运单号且 feed 已到揽收时，详情下拉放行一次
 * 京粉页（调用方另要求详情判为不完整、触发是详情下拉）；手动链照旧被揽收挡住，同单冷却照旧。Pipi
 * ExpressPoller.signedJdHistoryGap 是用户 2026-09-24 定的，这里与 Lite
 * ExpressDetailActivity.signedJingDongHistoryGap 按三端同口径跟上。
 *
 * 返回这一放行所属的完成时间 T（不满足上面这些条件时为 0）：用户 2026-10-03「这轮就统一」（优化 1），签收后的一次性
 * 放行记在每行一份、按 T 分代的台账里（services/row-ledger.ts）。
 */
export function jingDongSignedGapCompletionAt(shipment: Shipment): number {
  if (shipment.identity.manuallyAdded || !isJingDongSourceShipment(shipment) ||
      !normalizedProjectedWaybill(shipment.identity)) return 0;
  const source = sourceTimeline(shipment);
  const completedAt = source?.statusEventAtMs || 0;
  return source?.structuredStatus && source.semantic === "COMPLETED" && completedAt > 0 &&
      jingDongFeedReachedPickup(shipment)
    ? completedAt
    : 0;
}

/**
 * 上面那次京粉页还没用掉。每次完成只放行一次（2026-09-24）：完成包可能在真正签收几天后才到（自动确认收货），这时详情永远
 * 判不完整，每次下拉都会重开京粉页。完成时间当时或之后抓过的京粉页已经是这一单的最终历史，有它就不再开；用户 2026-10-03
 * 「这轮就统一」（优化 1，口径「拿到回答就算用掉」）：这一代（同一个 T）里京粉页有过回答——没轨迹、只抓到部分包也算——
 * 同样算用掉（台账 jingDongUnionGap）；网络失败、超时、风控、冷却跳过不记。T 变了是新的一代，放行重新算。
 */
export function jingDongSignedHistoryGap(shipment: Shipment): boolean {
  const completedAt = jingDongSignedGapCompletionAt(shipment);
  if (!completedAt) return false;
  if (manualTimelines(shipment).some(timeline =>
    normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.JD_H5 && timeline.successAtMs >= completedAt)) return false;
  return !signedReleaseUsed(shipment.identity.id, completedAt, "jingDongUnionGap");
}

/**
 * 首页投影只问「承运商揽收了没有、京粉页上有没有运单号」，跟上面那条问的「feed 历史全不全」不是一回事。
 * 京东列表经常只给最新一条（「您的订单正在派送中」），feed 里没有揽收字样，结构化状态却已经是派送中——
 * 只认文字节点时这类单首页永远投影不出来，只能靠详情页下拉（2026-09-24，与 Lite
 * ExpressHomeOrderProjectionCapture 同口径）。已下单、已发货不算揽收；已签收的单照旧只认文字节点，
 * 免得一次刷新给所有老单都开一遍京粉页。
 *
 * 未投影的订单行存盘时「已揽收」已被压成「已下单」（parcelToShipment），行上读不出结构化的 PICKED；
 * 调用方要把列表这一行压之前的结构化状态（accountParcelStructuredSemantic）传进来，否则 PICKED 永远
 * 不算（2026-09-24）。
 *
 * `includeCompleted`（用户 2026-09-25 同意）：App 在屏幕上时的存盘行投影也给已完成、还没运单号的订单
 * 取一次号——真实运单号出来了就不该再停在「京东购物 + 订单号」，同一个包裹另有一行运单时取号后并成一行。
 * 只有这一处传 true；小组件和同步本身照旧只认揽收。
 */
export function jingDongOrderPastPickup(
  shipment: Shipment,
  listStructuredSemantic: StatusSemantic | null = null,
  includeCompleted = false,
): boolean {
  if (jingDongFeedReachedPickup(shipment)) return true;
  if (!isJingDongSourceShipment(shipment)) return false;
  const source = sourceTimeline(shipment);
  const pastPickup = ["PICKED", "TRANSIT", "DELIVERY", "WAITING_PICKUP", ...(includeCompleted ? ["COMPLETED"] : [])];
  return [source?.structuredStatus ? source.semantic : null, listStructuredSemantic].some(semantic =>
    semantic != null && pastPickup.includes(semantic));
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
export function needsDetailFallback(input: Shipment): boolean {
  const shipment = withoutTemporaryReviews(input);
  if (isShunFengSourceShipment(shipment)) return !hasTimelineStartBeforeKdniao(shipment);
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

export function hasSettledTimelineHistory(input: Shipment, now = Date.now()): boolean {
  // A right-swipe sign-off settles the row only once it is hard-frozen (用户 2026-10-02「我已取件这种硬冻结 也要等三态都是
  // 签收才冻结」); before that its own sources decide, as for any row.
  const shipment = refreshGateView(input, now);
  if (forcedCompletedAt(shipment)) return true;
  const timeline = withoutTemporaryReviews(shipment).timeline;
  return (
    timeline.semantic === "COMPLETED" || timeline.semantic === "CANCELLED"
  ) && terminalEvidenceAtMs(shipment, now) > 0 && timelineHasUsableHistory(timeline);
}

export function hasUsableShipmentDynamics(shipment: Shipment): boolean {
  const timeline = selectShipmentTimeline(withoutTemporaryReviews(shipment));
  return Boolean(String(timeline.latestDetail || "").trim() &&
    !isNonEventDetail(timeline.latestDetail)) || timedTracks(timeline.tracks).length > 0;
}

/** An empty presentation may use a whole cached package, without relabelling its tracks. */
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
  return { ...richest, semantic: selected.semantic, structuredStatus: selected.structuredStatus,
    statusEventAtMs: selected.statusEventAtMs, ...statusProjectionFields(selected, richest) };
}

export type ShipmentSelectionEvidence = {
  historyProvider: string;
  headlineProvider: string;
  statusProvider: string;
  selectionReason: string;
};

export function shipmentSelectionEvidence(shipment: Shipment): ShipmentSelectionEvidence {
  const evidence = { historyProvider: "none", headlineProvider: "none",
    statusProvider: "none", selectionReason: "source_policy" };
  selectShipmentTimeline(shipment, evidence);
  return evidence;
}

/** Read the same-state node selected for every surface; prose never supplies a node's state. */
export function shipmentHeadlineMatchesStatus(shipment: Shipment): boolean {
  const evidence = { historyProvider: "none", headlineProvider: "none",
    statusProvider: "none", selectionReason: "source_policy" };
  const presented = selectShipmentTimeline(shipment, evidence);
  const reading = alignmentReading(shipment, presented, evidence.headlineProvider);
  if (reading?.times.needsNonCoarse) {
    const times = statusAlignmentTimes(shipment);
    if (!times || !alignmentAttemptFinished(shipment.identity.id,
      `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`)) return false;
  }
  return Boolean(reading?.headline &&
    sameStateNode(reading.headline.track, presented.semantic, reading.times.statusAtMs));
}

export function selectShipmentTimeline(
  shipment: Shipment, evidence?: ShipmentSelectionEvidence,
): TimelinePackage {
  const selection = { jingDongDetailHeadline: false };
  const selectedEvidence = evidence ?? { historyProvider: "none", headlineProvider: "none",
    statusProvider: "none", selectionReason: "source_policy" };
  const unaligned = selectUnalignedShipmentTimeline(shipment, selectedEvidence, selection);
  // 京东已签收头条例外（AGENTS §9，2026-09-24 / 09-27 / 09-28）选定的头条照旧：2026-10-02 的规则不改它（协调方规格
  // 「不变」一节）；它若仍落后于状态，只由状态对齐强刷去追。
  const presented = selection.jingDongDetailHeadline ? unaligned
    : withStatusPackageHeadline(shipment, unaligned, selectedEvidence.headlineProvider, selectedEvidence);
  const provider = selectedEvidence.headlineProvider;
  const donor = normalizeTimelineSlot(provider) === TIMELINE_SLOT.JT_H5
    ? alignmentPackages(shipment).filter(value => normalizeTimelineSlot(value.provider) === TIMELINE_SLOT.JT_H5)
      .flatMap(value => value.tracks).find(track => track.timeText === presented.latestTimeText && track.detail === presented.latestDetail)
    : undefined;
  return { ...presented, headlineDisplay: { provider, timeText: presented.latestTimeText, detail: presented.latestDetail,
    ...(typeof donor?.displayContext === "string" && donor.displayContext.trim() ? { displayContext: donor.displayContext } : {}) } };
}

/**
 * Status and headline more than this apart are out of step (用户 2026-10-02 弹窗判据填「五分钟」；与 Pipi
 * ExpressRepository.STATUS_ALIGNMENT_MILLIS 同值)。
 */
export const STATUS_ALIGNMENT_MS = 5 * 60_000;

/** Align display only; comparison-only times never become signing or notification evidence. */
function withStatusPackageHeadline(
  shipment: Shipment,
  presented: TimelinePackage,
  headlineProvider: string,
  evidence?: ShipmentSelectionEvidence,
): TimelinePackage {
  if (forcedCompletedAt(shipment) || presented.structuredStatus !== true ||
      presented.semantic === "UNKNOWN" || presented.semantic === "CANCELLED") return presented;
  if (!shipment.identity.manuallyAdded && isJingDongSourceShipment(shipment)) return presented;
  const reading = alignmentReading(shipment, presented, headlineProvider);
  if (!reading) return presented;
  const { statusAtMs: S, headlineAtMs: H } = reading.times;
  const Hs = reading.headlineSemantic;
  const headAhead = H > S + STATUS_ALIGNMENT_MS || (Hs !== "UNKNOWN" && H > S);
  const statusAhead = S > H || (Hs !== "UNKNOWN" && Hs !== presented.semantic && S >= H - STATUS_ALIGNMENT_MS);
  if (!headAhead && !statusAhead) return presented;
  // Identical nodes in different packages still retain the selected headline's source.
  if (headAhead && Hs !== "UNKNOWN" && !(presented.semantic === "COMPLETED" && Hs !== "COMPLETED") &&
      !coarseAlignmentPackage(shipment, { provider: headlineProvider })) {
    const projection = reading.headline && nodeNormalizedStatus(reading.headline.track.raw);
    return { ...presented, semantic: Hs, structuredStatus: true, statusEventAtMs: H,
      normalizedStatus: projection?.structured ? { ...projection, eventAtMs: H } : undefined };
  }
  const donor = sameStateHeadline(shipment, presented, reading);
  if (!donor) return presented;
  if (evidence) evidence.headlineProvider = donor.provider;
  return { ...presented, latestDetail: donor.track.detail, latestTimeText: donor.track.timeText };
}

export type StatusAlignmentReason = "status_ahead" | "headline_ahead" | "detail_behind";

export type StatusAlignmentTimes = { statusAtMs: number; headlineAtMs: number; detailAtMs: number;
  statusSemantic?: StatusSemantic; headlineSemantic?: StatusSemantic; needsNonCoarse?: boolean };

type HeadlineEvidence = { provider: string; track: TrackNode };
type AlignmentReading = { semantic: StatusSemantic; trustedTime: boolean; times: StatusAlignmentTimes;
  packages: TimelinePackage[]; donors: TimelinePackage[]; headline: HeadlineEvidence | null;
  headlineSemantic: StatusSemantic; detail: TrackNode | null; sf: boolean };

function alignmentPackages(shipment: Shipment): TimelinePackage[] {
  const source = sourceTimeline(shipment);
  return [...(source ? [source] : []), ...selectedManualTimelines(shipment)]
    .filter(timeline => normalizeWaybill(timeline.waybill) === displayWaybill(shipment))
    .map(timeline => displayedTimelinePresentation(shipment, timeline));
}

function coarseAlignmentPackage(shipment: Shipment, timeline: Pick<TimelinePackage, "provider">): boolean {
  if (!isShunFengSourceShipment(shipment)) return false;
  const source = sourceTimeline(shipment);
  return normalizeTimelineSlot(timeline.provider) === "v2_query" || Boolean(source &&
    normalizeTimelineSlot(timeline.provider) === normalizeTimelineSlot(source.provider));
}

function newestTrack(timeline: TimelinePackage): TrackNode | null {
  return timedTracks(timeline.tracks).reduce<TrackNode | null>((latest, track) =>
    !latest || track.timeMs! > latest.timeMs! ? track : latest, null);
}

function sameStateNode(track: TrackNode, semantic: StatusSemantic, statusAt: number): boolean {
  const own = latestTimelineTrackSemantic([track]);
  return own === semantic || (own === "UNKNOWN" && statusAt > 0 &&
    Math.abs(track.timeMs! - statusAt) <= STATUS_ALIGNMENT_MS);
}

function alignmentReading(shipment: Shipment, list: TimelinePackage,
  headlineProvider: string): AlignmentReading | null {
  if (list.structuredStatus !== true || list.semantic === "UNKNOWN" || list.semantic === "CANCELLED") return null;
  const packages = alignmentPackages(shipment);
  const donors = packages.filter(timeline => timeline.structuredStatus === true && timeline.semantic === list.semantic &&
    (timeline.statusEventAtMs || 0) === (list.statusEventAtMs || 0));
  const trustedTime = (list.statusEventAtMs || 0) > 0;
  const statusAtMs = list.statusEventAtMs || Math.max(0, ...donors.map(timelineLatestTrackAt));
  if (!(statusAtMs > 0)) return null;
  const headlineAtMs = parseProviderTime(list.latestTimeText || "") || 0;
  // A provider may retain milliseconds in its raw clock while its own time text has only seconds.
  // Read that exact textual clock as well, retaining package order and each node's original projection.
  const isHeadline = (track: TrackNode) => track.detail === list.latestDetail &&
    (track.timeMs === headlineAtMs || parseProviderTime(track.timeText) === headlineAtMs);
  const matches = packages.flatMap(timeline => timedTracks(timeline.tracks).filter(isHeadline)
    .map(track => ({ provider: timeline.provider, track })));
  // Selected history may belong to another provider than a metadata-only account headline.
  const ownHeadline = list.provider === headlineProvider ? timedTracks(list.tracks).find(isHeadline) : null;
  const headline = matches.find(item => item.provider === headlineProvider) ||
    (ownHeadline ? { provider: list.provider, track: ownHeadline } : null);
  const headlineSemantic = headline ? latestTimelineTrackSemantic([headline.track]) : "UNKNOWN";
  const detail = newestTrack(list);
  const sf = isShunFengSourceShipment(shipment);
  const nonCoarseMatch = packages.some(timeline => !coarseAlignmentPackage(shipment, timeline) &&
    timedTracks(timeline.tracks).some(track => sameStateNode(track, list.semantic, statusAtMs)));
  return { semantic: list.semantic, trustedTime, packages, donors, headline, headlineSemantic, detail, sf,
    times: { statusAtMs, headlineAtMs, detailAtMs: detail?.timeMs || 0,
      statusSemantic: list.semantic,
      ...(headlineSemantic !== "UNKNOWN" ? { headlineSemantic } : {}),
      ...(sf && donors.some(timeline => coarseAlignmentPackage(shipment, timeline)) && !nonCoarseMatch
        ? { needsNonCoarse: true } : {}) } };
}

function sameStateHeadline(shipment: Shipment, list: TimelinePackage, reading: AlignmentReading): HeadlineEvidence | null {
  const newest = (packages: readonly TimelinePackage[]) => packages.flatMap(timeline =>
    timedTracks(timeline.tracks).filter(track => sameStateNode(track, list.semantic, reading.times.statusAtMs))
      .map(track => ({ provider: timeline.provider, track })))
    .sort((left, right) => right.track.timeMs! - left.track.timeMs!)[0] || null;
  if (!reading.sf) return newest(reading.donors);
  const detailed = newest(reading.packages.filter(timeline => !coarseAlignmentPackage(shipment, timeline)));
  if (detailed) return detailed;
  const times = reading.times;
  return alignmentAttemptFinished(shipment.identity.id, `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`)
    ? newest(reading.donors) : null;
}

/**
 * Alignment reads the source status, pre-alignment headline and selected history, without temporary JD reviews.
 * Missing status time borrows a valid donor node only for comparison; a sign-off latch never supplies evidence.
 * See docs/EXPRESS_HEAD_STATUS_ALIGNMENT_20261002.md, the 2026-10-08 revision.
 */
export function statusAlignmentTimes(
  input: Shipment,
  now = Date.now(),
): StatusAlignmentTimes | null {
  const shipment = refreshGateView(input, now);
  if (forcedCompletedAt(shipment)) return null;
  return statusAlignmentReading(shipment)?.times ?? null;
}

/** The three times and the status they belong to, read on a row without the sign-off latch. */
function statusAlignmentReading(input: Shipment): AlignmentReading | null {
  const shipment = withoutTemporaryReviews(input);
  const evidence: ShipmentSelectionEvidence = { historyProvider: "none", headlineProvider: "none",
    statusProvider: "none", selectionReason: "source_policy" };
  return alignmentReading(shipment, selectUnalignedShipmentTimeline(shipment, evidence), evidence.headlineProvider);
}

/**
 * 手动签收后仍照常刷新的最长时间（用户 2026-10-02 弹窗「点击后满 3 天也冻结」）：满 72 小时仍未三态签收，也按硬冻结处理。
 */
export const FORCED_COMPLETION_REFRESH_WINDOW_MS = 72 * 60 * 60_000;

/**
 * 签收三态（用户 2026-10-02「头条 状态 详情页 都推进到了签收状态（之前京东定的那种临时签收例外）就冻结快递 后续不再进行任何
 * 刷新」，弹窗判据「按时间对齐」，协调方规格「签收三态冻结」）。三个时间就是状态对齐比较的那三个
 * （statusAlignmentTimes）：S 是已签收的结构化状态，状态时间 T 有效（> 0、不在未来）；头条时间 H 与本地详情最新一条 D 都有，
 * 且都不早于 T 五分钟以上（与状态对齐同一个五分钟）。iOS 详情页都是原生页，D 总在比较之列。另有两条：
 * - 京东业务来源行的头条或详情最新一条是 AGENTS §9 保留为首次签收证据的评价 / 订单完成节点（「临时头条」）时不算——识别沿用
 *   isJingDongOrderCompletionNode（已清理的包里还剩的这类节点就是保留下来的那条）；
 * - 京东签收缺口那一次京粉页（jingDongSignedHistoryGap，详情下拉在详情不完整时放行）还没用掉时不算：先跑那一次再冻结。
 *   用掉没有读每行的签收后台账（用户 2026-10-03「这轮就统一」，优化 1：这一代里京粉页有过回答就算用掉）。
 * 手动签收行读来源自己的结构化状态（withoutForcedCompletion），点击时间不算签收证据。取消件不参与。
 * 还没投影出真实运单号的京东订单行从不算到达（用户 2026-10-02 弹窗「不冻结，取到号再判」，与 Lite 现状一致）：取号与它
 * 既有的刷新照旧跑，投影出运单号以后才按上面的三态判。
 */
export function signedTripleReached(input: Shipment, now = Date.now()): boolean {
  const shipment = withoutForcedCompletion(input);
  if (unprojectedAccountOrder(shipment)) return false;
  const reading = statusAlignmentReading(shipment);
  if (!reading || reading.semantic !== "COMPLETED" || !reading.trustedTime) return false;
  if (reading.headlineSemantic !== "UNKNOWN" && reading.headlineSemantic !== "COMPLETED") return false;
  if (reading.detail && !["UNKNOWN", "COMPLETED"].includes(latestTimelineTrackSemantic([reading.detail]))) return false;
  if (reading.sf && (!reading.headline || reading.packages.some(timeline =>
      timeline.provider === reading.headline!.provider && coarseAlignmentPackage(shipment, timeline)) ||
      coarseAlignmentPackage(shipment, selectUnalignedShipmentTimeline(shipment)))) return false;
  const { statusAtMs, headlineAtMs, detailAtMs } = reading.times;
  const floor = statusAtMs - STATUS_ALIGNMENT_MS;
  if (!(statusAtMs <= now && headlineAtMs > 0 && headlineAtMs >= floor && detailAtMs > 0 && detailAtMs >= floor)) {
    return false;
  }
  const shown = selectUnalignedShipmentTimeline(shipment);
  const newest = timedTracks(shown.tracks).reduce<TrackNode | null>(
    (latest, track) => !latest || track.timeMs! > latest.timeMs! ? track : latest,
    null,
  );
  if (isJingDongOrderCompletionNode(shown, shipment.identity, shown.latestDetail) ||
      (newest && isJingDongOrderCompletionNode(shown, shipment.identity, newest.detail))) return false;
  return !(jingDongSignedHistoryGap(shipment) && shipmentDetailIncompleteReason(shipment) !== null);
}

/**
 * 右滑签收（forcedCompletedAtMs）之后还照常刷新吗（用户 2026-10-02「我已取件这种硬冻结 也要等三态都是签收才冻结」，弹窗
 * 「iOS 右滑签收一起改」「显示已签收、照常刷新」）：点击后来源自己的三态没到签收、也没满 72 小时时为真。展示不变（立即已签收、
 * 状态闩住、不发通知、只能删行撤销）。
 */
export function forcedCompletionRefreshOpen(shipment: Shipment, now = Date.now()): boolean {
  const forcedAt = forcedCompletedAt(shipment);
  if (!forcedAt || now - forcedAt >= FORCED_COMPLETION_REFRESH_WINDOW_MS) return false;
  return !signedTripleReached(shipment, now);
}

/**
 * 签收冻结：本机不再为这一行发起任何逐票请求（定时 / 后台、打开详情与详情下拉、手动链、京粉页、快递100、快递鸟、
 * 状态对齐强刷、首页下拉里这一行的逐票工作）。普通行在三态到签收时冻结；手动签收行在三态到签收或点击满 72 小时
 * 后进入硬冻结。来源账号的列表同步、承运商识别与身份（运单号）提取不在此列；条件不再成立时自然解冻。
 */
export function signedRefreshFrozen(shipment: Shipment, now = Date.now()): boolean {
  return forcedCompletedAt(shipment)
    ? !forcedCompletionRefreshOpen(shipment, now)
    : signedTripleReached(shipment, now);
}

/**
 * The row as its sources report it, without the right-swipe sign-off latch: the selection is redone with no
 * forcedCompletedAtMs, and a stored presentation that only carries the latch (COMPLETED at the click time) is
 * not kept as an already shown terminal status — the click is not signing evidence (用户 2026-10-02 弹窗「来源报的
 * 结构化签收」). Rows without the latch come back unchanged.
 */
export function withoutForcedCompletion(shipment: Shipment): Shipment {
  const forcedAt = forcedCompletedAt(shipment);
  if (!forcedAt) return shipment;
  const { forcedCompletedAtMs: _latch, ...rest } = shipment;
  const stored = shipment.timeline;
  const unlatched: Shipment = stored.semantic === "COMPLETED" && stored.statusEventAtMs === forcedAt
    ? { ...rest, timeline: { ...stored, semantic: "UNKNOWN", structuredStatus: false, statusEventAtMs: null,
        normalizedStatus: undefined } }
    : rest;
  return { ...unlatched, timeline: selectShipmentTimeline(unlatched) };
}

/**
 * What the refresh gates read: a right-swipe signed row still inside its refresh window is judged as the ordinary row
 * its own sources make it (用户 2026-10-02「显示已签收、照常刷新」); every other row, including a hard-frozen signed
 * one, is read as it is.
 */
export function refreshGateView(shipment: Shipment, now = Date.now()): Shipment {
  return forcedCompletionRefreshOpen(shipment, now) ? withoutForcedCompletion(shipment) : shipment;
}

/**
 * The row-level counterpart of status.ts shouldRefreshShipment for scheduled and explicit refresh decisions: the
 * signed freeze above, and a right-swipe signed row inside its window refreshes by its own status.
 */
export function shouldRefreshShipmentRow(shipment: Shipment, now = Date.now()): boolean {
  return shouldRefreshShipment(refreshGateView(shipment, now), now) &&
    (forcedCompletedAt(shipment) > 0 || !signedTripleReached(shipment, now));
}

/** Time skew, a known conflicting headline enum, or SF's missing non-coarse same-state history needs repair. */
export function statusAlignmentOutOfStep(
  times: Readonly<StatusAlignmentTimes>,
): boolean {
  const values = [times.statusAtMs, times.headlineAtMs, times.detailAtMs];
  return times.needsNonCoarse === true || Boolean(times.headlineSemantic && times.statusSemantic &&
    times.headlineSemantic !== times.statusSemantic) || values.some((left, index) => values.slice(index + 1).some(right =>
    left > 0 && right > 0 && Math.abs(left - right) > STATUS_ALIGNMENT_MS));
}

/** Which side is behind, for the log only (Pipi ExpressStatusAlignment.reason, same order). */
export function statusAlignmentReason(
  times: Readonly<{ statusAtMs: number; headlineAtMs: number; detailAtMs: number }>,
): StatusAlignmentReason {
  if (times.headlineAtMs > 0 && times.statusAtMs - times.headlineAtMs > STATUS_ALIGNMENT_MS) return "status_ahead";
  if (times.headlineAtMs > 0 && times.headlineAtMs - times.statusAtMs > STATUS_ALIGNMENT_MS) return "headline_ahead";
  return "detail_behind";
}

/** Whether the list currently shows the status package's node in place of its own headline (diagnostics). */
export function statusPackageHeadlineShown(shipment: Shipment): boolean {
  const selection = { jingDongDetailHeadline: false };
  const evidence = { historyProvider: "none", headlineProvider: "none",
    statusProvider: "none", selectionReason: "source_policy" };
  const unaligned = selectUnalignedShipmentTimeline(shipment, evidence, selection);
  return !selection.jingDongDetailHeadline &&
    withStatusPackageHeadline(shipment, unaligned, evidence.headlineProvider) !== unaligned;
}

function selectUnalignedShipmentTimeline(
  shipment: Shipment, evidence?: ShipmentSelectionEvidence,
  selection?: { jingDongDetailHeadline: boolean },
): TimelinePackage {
  const rawSource = sourceTimeline(shipment);
  const source = rawSource ? displayedTimelinePresentation(shipment, rawSource) : null;
  const selectedManuals = selectedManualTimelines(shipment)
    .filter(timeline => !unprojectedAccountOrder(shipment) ||
      !detailManualRejectionReason(shipment, timeline))
    // Empty source presentation must not restore a query rejected by the same-waybill rank gate.
    .filter(timeline => !hasSourceProvider(shipment, "CaiNiao") ||
      normalizeTimelineSlot(timeline.provider) !== TIMELINE_SLOT.V5_QUERY ||
      normalizeWaybill(timeline.waybill) === displayWaybill(shipment))
    .map(timeline => displayedTimelinePresentation(shipment, timeline));
  // V5 list gaps may use already persisted detail/Online history without opening H5.
  const manuals = cainiaoAutomaticNeedsH5Supplement(shipment) &&
      !cainiaoManualFallbackActivated(shipment) &&
      !(shipment.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
        !timedTracks(source?.tracks || []).length)
    ? selectedManuals.filter((timeline) =>
        normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.CN_H5
      )
    : selectedManuals;
  const onSelection = (reason: string) => {
    if (evidence) evidence.selectionReason = reason;
  };
  // 详情候选排第一的包；这条选包路径排过才有值（接口 5 的行都排），没排过是 undefined。
  let rankedDetail: TimelinePackage | null | undefined = undefined;
  let selected: TimelinePackage;
  if (source && unprojectedAccountOrder(shipment)) {
    const orderTimeline = accountPresentationReference(shipment) || source;
    // Order identity does not exempt its account history from the shared summary gate.
    rankedDetail = rankShipmentDetailCandidates(shipment, onSelection);
    const history = rankedDetail || orderTimeline;
    selected = {
      ...history,
      semantic: timelineNormalizedStatus(source) ? source.semantic
        : accountOrderSemantic(orderTimeline.latestDetail, source.semantic),
      structuredStatus: source.structuredStatus,
      statusEventAtMs: source.statusEventAtMs,
      ...statusProjectionFields(source, history),
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
    // SF uses the same whole manual package on Home and detail, including a usable partial K100 package.
    const ranksDetail = shipment.identity.manuallyAdded || isShunFengSourceShipment(shipment) ||
      shipment.identity.bindingSource === SCRIPT_BINDING_SOURCE;
    if (ranksDetail) rankedDetail = rankShipmentDetailCandidates(shipment, onSelection);
    selected = ranksDetail
      ? rankedDetail || ordered[0] || manualRaceWinner ||
        capabilityTimeline("fallback") ||
        selectTimelineAuthority(source, manuals) || shipment.timeline
      : isJingDongSourceShipment(shipment)
        // Keep feed ownership; the shared resolver below fills only a missing status.
        ? jingDongAccount || source || shipment.timeline
        : terminal || ordered[0] ||
          selectTimelineAuthority(source, manuals) || shipment.timeline;
  }
  let supplemented = restoreDisplayableTracks(
    supplementTimelineHistory(
      selected,
      [...(source ? [source] : []), ...manuals],
    ),
    [...(source ? [source] : []), ...manuals],
  );
  if (evidence) {
    evidence.historyProvider = supplemented.provider || "none";
    evidence.headlineProvider = supplemented.latestDetail ? supplemented.provider : "none";
    evidence.statusProvider = supplemented.semantic === "UNKNOWN" ? "none" : supplemented.provider;
  }
  const statusResolved = withAttachedCarrierStatus(
    shipment, structuredStatusOverride(shipment, supplemented, evidence), evidence,
  );
  // 首页和详情页走的是同一个选包（selectShipmentDetailTimeline 就是本函数），这里只换表头两个字段，
  // 轨迹、状态不动；接口 5 的行上表头取自的正是上面选中的那个包。
  const detailHeadline = jingDongDetailHeadlineAheadOfFeed(shipment, statusResolved, rankedDetail);
  if (detailHeadline && evidence) evidence.headlineProvider = detailHeadline.provider;
  if (detailHeadline && selection) selection.jingDongDetailHeadline = true;
  const resolved = detailHeadline
    ? { ...statusResolved, latestDetail: detailHeadline.latestDetail, latestTimeText: detailHeadline.latestTimeText }
    : statusResolved;
  const presented = applyForcedCompletion(
    shipment,
    preservesTerminalStatus(
      withoutJingDongOrderCompletion(shipment.timeline, shipment.identity,
        false, jingDongSignedAnchorAtMs(shipment), jingDongAnchorEvidence(shipment)),
      resolved,
      isFrozenJingDongShipment(shipment) || shipment.timeline.structuredStatus === true,
      isFrozenJingDongShipment(shipment),
    ),
  );
  if (evidence && (presented.semantic !== resolved.semantic ||
      presented.statusEventAtMs !== resolved.statusEventAtMs)) {
    evidence.statusProvider = shipment.forcedCompletedAtMs ? "forced_completion" : "retained_terminal";
  }
  return displayedTimelinePresentation(shipment, presented);
}

/**
 * 列表归 feed 的一个窄口子（2026-09-24，问题 3）：京东列表的完成事件常是被拦掉的评价文案，或者根本
 * 不带节点，feed 能显示的最新一条就停在更早的「派送中」，于是首页「已签收」配「派送中」，而详情页选中的
 * 包（京粉页）里明明有签收节点。只在「结构化状态已签收、feed 能显示的最新节点不晚于完成时间（用户 2026-10-01
 * 「改成「不晚于」」，原为「早于」）、详情排第一的包有比它更新的节点」时，表头取那个包里最新的有效节点；其它情况
 * 仍由 feed 定表头。与 Lite、Pipi 同口径：
 * 只认轨迹，不读包上存的 latestDetail/latestTimeText（Lite 的同源合并会让它们停在旧包那条，Fold7
 * 2026-09-24 京粉页重抓后首页表头因此倒退到 09-22 22:12）。
 */
function jingDongDetailHeadlineAheadOfFeed(
  shipment: Shipment,
  homeHeadline: TimelinePackage,
  rankedDetail: TimelinePackage | null | undefined,
): TimelinePackage | null {
  if (shipment.identity.manuallyAdded || !isJingDongSourceShipment(shipment)) return null;
  const source = sourceTimeline(shipment);
  if (!source?.structuredStatus || source.semantic !== "COMPLETED") return null;
  if (isJingDongOrderCompletionNode(source, shipment.identity, homeHeadline.latestDetail)) {
    return signingTraceOverTemporaryReview(shipment, source, rankedDetail);
  }
  const feedHeadlineAt = parseProviderTime(homeHeadline.latestTimeText || "") || 0;
  // 用户 2026-10-01「改成「不晚于」，三端一起」：feed 表头可以与完成时间相同；没有完成时间照旧不算（Pipi 的状态证据要求有）。
  const completedAt = source.statusEventAtMs || 0;
  if (!(completedAt > 0 && completedAt >= feedHeadlineAt)) return null;
  // selectShipmentTimeline 每次加载、保存、小组件都跑：接口 5 的行在选包时已经排过一次，直接用那个
  // 结果，不再排第二遍；只有没排过的路径（非接口 5 的京东行）才在这里排。
  const detail = rankedDetail === undefined ? rankShipmentDetailCandidates(shipment) : rankedDetail;
  const newest = timedTracks(detail?.tracks || []).reduce<TrackNode | null>(
    (latest, track) => !latest || track.timeMs! > latest.timeMs! ? track : latest,
    null,
  );
  if (!detail || !newest || !(newest.timeMs! > feedHeadlineAt)) return null;
  return { ...detail, latestDetail: newest.detail, latestTimeText: newest.timeText };
}

/**
 * 用户 2026-09-27：「这个已完成只能当作临时轨迹 打开详情页时签收轨迹可以覆盖列表页头条轨迹」，取详情页排第一的包，
 * 原为「不早于账号最后一条」，用户 2026-09-28「改成严格晚于」。表头是临时评价时：B 是这一行自己的账号包（feed 与同
 * 账号的 v5_query）里最新的非临时节点；详情排第一的包不是账号自己的包、是完成时间当时或之后抓到的（「要求」），且它
 * 最新的非临时节点严格晚于 B，表头和时间就换成那个节点，否则表头仍是这条评价。
 * 2026-09-24 例外的其余条件（结构化签收、基准不晚于完成时间）照旧，基准换成 B；用户 2026-10-01「除了 13 14 16 17 其他都做」
 * 批准这一支也改成「不晚于」（原为完成时间晚于 B）。
 */
function signingTraceOverTemporaryReview(
  shipment: Shipment,
  source: TimelinePackage,
  rankedDetail: TimelinePackage | null | undefined,
): TimelinePackage | null {
  const own = accountPresentationCandidates(shipment);
  const accountAt = Math.max(0, ...own.map(timeline =>
    timelineLatestTrackAt(withoutKeptReviewNodes(shipment, displayedTimelinePresentation(shipment, timeline)))));
  // 用户 2026-10-01：B 可以与完成时间相同；没有完成时间照旧不算（与非评价一支同一个零值守卫）。
  const completedAt = source.statusEventAtMs || 0;
  if (!(completedAt > 0 && completedAt >= accountAt)) return null;
  const detail = rankedDetail === undefined ? rankShipmentDetailCandidates(shipment) : rankedDetail;
  if (!detail || own.some(timeline =>
    normalizeTimelineSlot(timeline.provider) === normalizeTimelineSlot(detail.provider) &&
    normalizeWaybill(timeline.waybill) === normalizeWaybill(detail.waybill))) return null;
  // 用户 2026-09-27「要求」：只有完成时间当时或之后抓到的包能换掉临时评价，与签收缺口「完成之后抓过」同一口径。
  if (!capturedAtOrAfterCompletion(shipment, detail)) return null;
  const newest = timedTracks(withoutKeptReviewNodes(shipment, detail).tracks).reduce<TrackNode | null>(
    (latest, track) => !latest || track.timeMs! > latest.timeMs! ? track : latest,
    null,
  );
  // 用户 2026-09-28「改成严格晚于」：只有严格晚于账号最后一条的节点才换上去。
  if (!newest || !(newest.timeMs! > 0 && newest.timeMs! > accountAt)) return null;
  return { ...detail, latestDetail: newest.detail, latestTimeText: newest.timeText };
}

const temporaryReviewViews = new WeakMap<Shipment, Shipment>();

/**
 * The row as HEAD saw it (助手按用户 2026-09-27 规则对齐): every package without its kept review nodes, status
 * untouched. Refresh, complete-cache, freeze and entry-query gates read this; display and ranking read the row itself.
 */
function withoutTemporaryReviews(shipment: Shipment): Shipment {
  const cached = temporaryReviewViews.get(shipment);
  if (cached) return cached;
  const strip = (timeline: TimelinePackage) => withoutKeptReviewNodes(shipment, timeline);
  const timeline = strip(shipment.timeline);
  const source = shipment.sourceTimeline ? strip(shipment.sourceTimeline) : shipment.sourceTimeline;
  const manuals = shipment.manualTimelines?.map(strip);
  const changed = timeline !== shipment.timeline || source !== shipment.sourceTimeline ||
    Boolean(manuals?.some((value, index) => value !== shipment.manualTimelines![index]));
  const value = changed
    ? { ...shipment, timeline, sourceTimeline: source, ...(manuals ? { manualTimelines: manuals } : {}) }
    : shipment;
  temporaryReviewViews.set(shipment, value);
  return value;
}

/**
 * A package without the review nodes kept as first signing (用户 2026-09-27: temporary nodes), for the
 * baselines that ask how far the real trace reached. Status fields stay as the package gave them.
 */
function withoutKeptReviewNodes(shipment: Shipment, timeline: TimelinePackage): TimelinePackage {
  const isReview = (detail: string) => isJingDongOrderCompletionNode(timeline, shipment.identity, detail);
  const tracks = timeline.tracks.filter((track) => !isReview(track.detail));
  if (tracks.length === timeline.tracks.length && !isReview(timeline.latestDetail)) return timeline;
  const latest = timedTracks(tracks).reduce<TrackNode | null>(
    (newest, track) => !newest || track.timeMs! > newest.timeMs! ? track : newest,
    null,
  ) || tracks[0];
  return { ...timeline, tracks, latestDetail: latest?.detail || "", latestTimeText: latest?.timeText || "" };
}

function isTerminalSemantic(semantic: string): boolean {
  return semantic === "COMPLETED" || semantic === "CANCELLED";
}

const STATUS_SEMANTICS = new Set<string>([
  "CANCELLED", "DANGER", "ORDERED", "SHIPPED", "PICKED", "TRANSIT", "DELIVERY", "WAITING_PICKUP",
  "COMPLETED", "UNKNOWN",
]);

/**
 * 订单先占号时的签收（用户 2026-09-26 采纳 A）：订单先取到运单号、同一运单自己的承运商记录后来才出现并被挂靠时，
 * 可见订单行的状态与表头采用挂靠承运商记录报出的更新的结构化状态，做法与「同票 v5_query 比 feed 新就由列表采用」
 * 相同（structuredStatusOverride / accountHeadlineReference）。轨迹各存各的：这里只换状态和表头两件事。
 * 反方向不成立：挂靠的订单从不把状态借给运单行（落库时只给先占号的投影订单带上这份状态）。
 */
function withAttachedCarrierStatus(
  shipment: Shipment,
  selected: TimelinePackage,
  selectionEvidence?: ShipmentSelectionEvidence,
): TimelinePackage {
  const carrier = shipment.attachedCarrierStatus;
  if (!carrier || shipment.identity.manuallyAdded || !shipment.identity.accountOrder ||
      !normalizedProjectedWaybill(shipment.identity)) return selected;
  const eventAt = Number(carrier.statusEventAtMs);
  if (!STATUS_SEMANTICS.has(carrier.semantic) || carrier.semantic === "UNKNOWN" ||
      !Number.isFinite(eventAt) || eventAt <= 0) return selected;
  const ownAt = Number(selected.statusEventAtMs) || 0;
  const donor: TimelinePackage = { ...selected, semantic: carrier.semantic, structuredStatus: true,
    statusEventAtMs: eventAt, normalizedStatus: carrier.normalizedStatus };
  // Lite and iOS combined (user 2026-09-26, 其余裁决 9): a newer carrier event takes the status; with
  // the same status a higher source priority also takes it, a lower one never does; a signed or
  // cancelled row never falls back to a non-terminal status. Priority is the Worker's own
  // (normalizedStatus.priority), the one Lite reads through WorkerStatusProjection.priority.
  if (selected.semantic !== "UNKNOWN") {
    const sameSemantic = carrier.semantic === selected.semantic;
    const ownPriority = statusPriority(selected);
    const carrierPriority = statusPriority(donor);
    const takes = (!sameSemantic || carrierPriority >= ownPriority) &&
      (eventAt > ownAt || (sameSemantic && carrierPriority > ownPriority)) &&
      !(isTerminalSemantic(selected.semantic) && !isTerminalSemantic(carrier.semantic));
    if (!takes) return selected;
  }
  // The headline follows the newest node: an older carrier headline does not replace a newer one.
  const takesHeadline = Boolean(carrier.latestDetail && !isNonEventDetail(carrier.latestDetail)) &&
    (parseProviderTime(carrier.latestTimeText) || 0) >= (parseProviderTime(selected.latestTimeText) || 0);
  if (selectionEvidence) {
    selectionEvidence.statusProvider = "attached_carrier";
    if (takesHeadline) selectionEvidence.headlineProvider = "attached_carrier";
  }
  return {
    ...selected,
    semantic: carrier.semantic,
    structuredStatus: true,
    statusEventAtMs: eventAt,
    ...statusProjectionFields(donor, selected),
    ...(takesHeadline ? { latestDetail: carrier.latestDetail, latestTimeText: carrier.latestTimeText } : {}),
  };
}

/**
 * 用户 2026-10-02「对齐 Lite」（3611）：feed 只有「快递状态已更新」占位时，列表退到非账号包（菜鸟页等）；
 * 账号头条（v5_query）比这个包自己的头条旧时不换，与 Lite restoreAccountActivity「query 更新才接管」同口径。
 * feed 自己有能显示的头条（哪怕不带时间）、或列表包是 feed / v5_query 时，照旧由账号头条定。
 */
function fallbackHeadlineNewerThanAccount(
  shipment: Shipment, selected: TimelinePackage, reference: TimelinePackage,
): boolean {
  const source = sourceTimeline(shipment);
  const feedHeadline = source ? displayedTimelinePresentation(shipment, source).latestDetail : "";
  if (feedHeadline && !isNonEventDetail(feedHeadline)) return false;
  const slot = normalizeTimelineSlot(selected.provider);
  if (slot === TIMELINE_SLOT.V5_QUERY ||
      slot === normalizeTimelineSlot(source?.provider || "")) return false;
  if (!selected.latestDetail || isNonEventDetail(selected.latestDetail)) return false;
  return (parseProviderTime(selected.latestTimeText) || 0) > (parseProviderTime(reference.latestTimeText) || 0);
}

/** Account query takeover is independent of H5/manual history selection. */
function structuredStatusOverride(
  shipment: Shipment,
  selected: TimelinePackage,
  selectionEvidence?: ShipmentSelectionEvidence,
): TimelinePackage {
  if (unprojectedAccountOrder(shipment) &&
      normalizeTimelineSlot(selected.provider) !== TIMELINE_SLOT.V5_QUERY) return selected;
  if (!shipment.identity.manuallyAdded && !isShunFengSourceShipment(shipment)) {
    const source = sourceTimeline(shipment);
    const reference = accountHeadlineReference(shipment);
    // Other providers only fill absent account fields; they do not inherit v5 query authority.
    if (reference?.latestDetail && !isNonEventDetail(reference.latestDetail) &&
        !fallbackHeadlineNewerThanAccount(shipment, selected, reference)) {
      selected = { ...selected, latestDetail: reference.latestDetail, latestTimeText: reference.latestTimeText };
      if (selectionEvidence) selectionEvidence.headlineProvider = reference.provider;
    }
    let authority = source;
    for (const candidate of accountPresentationCandidates(shipment)) {
      if (candidate.structuredStatus !== true || candidate.semantic === "UNKNOWN" ||
          !(candidate.statusEventAtMs! > 0)) continue;
      const priorityDifference = authority?.semantic === candidate.semantic
        ? statusPriority(candidate) - statusPriority(authority) : 0;
      if (!authority || authority.semantic === "UNKNOWN" || priorityDifference > 0 ||
          (priorityDifference === 0 && candidate.statusEventAtMs! > (authority.statusEventAtMs || 0))) authority = candidate;
    }
    if (authority?.semantic !== "UNKNOWN" && authority) {
      if (selectionEvidence) selectionEvidence.statusProvider = authority.provider;
      return { ...selected, semantic: authority.semantic, structuredStatus: authority.structuredStatus,
        statusEventAtMs: authority.statusEventAtMs, ...statusProjectionFields(authority, selected) };
    }
    if (normalizeTimelineSlot(selected.provider) === TIMELINE_SLOT.V5_QUERY) {
      selected = { ...selected, semantic: "UNKNOWN", structuredStatus: false, statusEventAtMs: null, normalizedStatus: undefined };
      if (selectionEvidence) selectionEvidence.statusProvider = "none";
    }
  }
  // Legacy automatic packages may lack the provenance flag; missing-status fallback
  // does not authorize replacing a status they already own.
  const preserveAutomaticStatus = !shipment.identity.manuallyAdded && selected.semantic !== "UNKNOWN";
  if (preserveAutomaticStatus && !isShunFengSourceShipment(shipment)) return selected;
  const evidenceOf = (timeline: TimelinePackage) => {
    if (normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.JD_H5) {
      return { semantic: "UNKNOWN" as const, eventAtMs: null };
    }
    const projection = timelineNormalizedStatus(timeline);
    if (projection) return { semantic: projection.structured ? projection.semantic : "UNKNOWN" as const,
      eventAtMs: projection.eventAtMs || null };
    return timeline.structuredStatus && timeline.semantic !== "UNKNOWN"
      ? { semantic: timeline.semantic, eventAtMs: timeline.statusEventAtMs }
      : latestEventEvidence(timeline.tracks.map((track) => ({ ...track, detail: "" })));
  };
  const selectedEvidence = evidenceOf(selected);
  const source = sourceTimeline(shipment);
  const packages = [source, ...selectedManualTimelines(shipment)]
    .filter((timeline): timeline is TimelinePackage => timeline != null &&
      normalizeWaybill(timeline.waybill) === displayWaybill(shipment));
  const donors = packages.flatMap(timeline => {
    const evidence = evidenceOf(timeline);
    return evidence.semantic === "UNKNOWN" ? [] : [{ timeline, ...evidence,
      normalizedStatus: timelineNormalizedStatus(timeline) }];
  });
  const coarseSource = isShunFengSourceShipment(shipment);
  // Missing-status history cannot change the quality reference of status-bearing donors.
  const reference = coarseSource && donors.length
    ? donors.map(donor => donor.timeline).reduce((latest, candidate) =>
      timelineLatestEventAt(candidate) > timelineLatestEventAt(latest) ? candidate : latest)
    : accountPresentationReference(shipment);
  type Donor = typeof donors[number];
  const qualities = new Map<Donor, DetailTimelineQuality>();
  const quality = (donor: Donor): DetailTimelineQuality => {
    const existing = qualities.get(donor);
    if (existing) return existing;
    const presented = { ...donor.timeline, semantic: donor.semantic,
      statusEventAtMs: donor.eventAtMs, structuredStatus: true };
    const value = detailTimelineQuality(donor.timeline,
      detailTimelineComplete(donor.timeline, reference, donor.semantic,
        terminalEvidenceAtMs({ ...shipment, timeline: presented })), source, coarseSource);
    qualities.set(donor, value);
    return value;
  };
  const compareDonors = (left: Donor, right: Donor): number =>
    (right.eventAtMs || 0) - (left.eventAtMs || 0) ||
    compareDetailTimelineQuality(quality(left), quality(right));
  if (selectedEvidence.semantic !== "UNKNOWN") {
    const preferred = donors.filter(donor =>
      donor.timeline.semantic === selectedEvidence.semantic && donor.timeline.structuredStatus &&
      statusPriority(donor.timeline) > statusPriority(selected))
      .sort((left, right) => statusPriority(right.timeline) - statusPriority(left.timeline) ||
        compareDonors(left, right))[0]?.timeline;
    if (preferred) {
      if (selectionEvidence) selectionEvidence.statusProvider = preferred.provider;
      return { ...selected, semantic: preferred.semantic, structuredStatus: true,
        statusEventAtMs: preferred.statusEventAtMs, ...statusProjectionFields(preferred, selected) };
    }
  }
  // D-23（用户 2026-10-02「修」）：顺丰来源件选中的 Picker / K100 手动包只有文案推出的状态（structuredStatus 不为真）时不保留
  // 它，按 AGENTS §9「状态看结构化，不看文案」（2026-09-05）改用同一运单各包里事件时间最新的结构化状态（下面的 donors），
  // 一个都没有才回到文案——与 Pipi applyStructuredStatus、Lite selectStructuredStatus 同口径。这一行自己的来源包（legacy
  // 自动包可能缺来源标记）与带结构化状态的包照旧保留自己的状态。
  const keepsOwnStatus = preserveAutomaticStatus && (selected.structuredStatus === true ||
    normalizeTimelineSlot(selected.provider) === normalizeTimelineSlot(source?.provider || ""));
  if (keepsOwnStatus) return selected;
  if (selectedEvidence.semantic !== "UNKNOWN") {
    if (selectionEvidence) selectionEvidence.statusProvider = selected.provider;
    return selected.semantic !== "UNKNOWN" ? selected : {
      ...selected, semantic: selectedEvidence.semantic,
      statusEventAtMs: selectedEvidence.eventAtMs, structuredStatus: true, normalizedStatus: undefined,
    };
  }
  // Pairwise subtype priority versus cross-semantic time can form a comparison cycle.
  // Choose one representative per semantic before comparing their event clocks.
  const representatives = new Map<StatusSemantic, Donor>();
  for (const donor of donors) {
    const current = representatives.get(donor.semantic);
    const priorityDifference = (donor.normalizedStatus?.priority || 0) -
      (current?.normalizedStatus?.priority || 0);
    if (!current || priorityDifference > 0 ||
        (priorityDifference === 0 && compareDonors(donor, current) < 0)) {
      representatives.set(donor.semantic, donor);
    }
  }
  const best = [...representatives.values()].sort(compareDonors)[0];
  if (!best) return selected;
  // 终态不退回（表格「若选中的包会丢掉终态，保留」）。
  if (
    (selected.semantic === "COMPLETED" || selected.semantic === "CANCELLED") &&
    best.semantic !== selected.semantic
  ) return selected;
  if (selectionEvidence) selectionEvidence.statusProvider = best.timeline.provider;
  return {
    ...selected,
    semantic: best.semantic,
    statusEventAtMs: best.eventAtMs,
    normalizedStatus: best.normalizedStatus,
    structuredStatus: true,
  };
}

export function selectShipmentDetailTimeline(
  shipment: Shipment,
): TimelinePackage {
  return selectShipmentDetailTimelineInner(shipment);
}

/**
 * JD detail presentation (Pipi 1.4.0 `ExpressDetailTimelinePolicy.prependOwnerOrderStage`, user
 * decision 2026-09-17, parity backlog D-8): a selected carrier fallback package stays the sole
 * authority for the courier phase; only the feed's own timed nodes older than the package's
 * earliest timed node — the shopping-order stage reported before a waybill existed — follow it,
 * newest first, never interleaved. Account packages and JD H5 already carry that stage. Detail
 * completeness keeps judging the raw selected package.
 */
export function selectShipmentDetailPresentation(
  shipment: Shipment,
  attachedOrders: readonly Shipment[] = [],
): TimelinePackage {
  return withAttachedOrderStage(
    withJingDongOwnerOrderStage(shipment, selectShipmentDetailTimeline(shipment)),
    attachedOrders,
  );
}

export function jingDongOrderStagePrepended(
  shipment: Shipment,
  attachedOrders: readonly Shipment[] = [],
): boolean {
  const selected = selectShipmentDetailTimeline(shipment);
  return selectShipmentDetailPresentation(shipment, attachedOrders).tracks.length !== selected.tracks.length;
}

/**
 * 归属-2（用户 2026-09-25，允许差异已登记）：先占号的可见行的详情页，接上挂靠在它后面的投影订单自己 feed 里、早于
 * 所示包最早节点的订单阶段节点，沿用 09-17 D-8 的口径：新的在前、整段接在最后、不穿插。只在详情页展示，列表、行本身
 * 和缓存都不变；详情完整判据仍只看所选的包。订单的京粉页与按订单号的 v5_query 不接到运单行上。
 */
function withAttachedOrderStage(
  shown: TimelinePackage,
  attachedOrders: readonly Shipment[],
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
    for (const track of timedTracks(sourceTimeline(order)?.tracks || [])) {
      if ((track.timeMs as number) >= earliest || !track.detail.trim() ||
          isNonEventDetail(track.detail) || isAccountUpdateSummary(track.detail) ||
          !isOwnerFeedTrack(track)) continue;
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

function withJingDongOwnerOrderStage(shipment: Shipment, selected: TimelinePackage): TimelinePackage {
  if (shipment.identity.manuallyAdded || !isJingDongSourceShipment(shipment)) return selected;
  const provider = selected.provider.trim().toLowerCase();
  if (timelineCapability(provider) === "account" ||
      normalizeTimelineSlot(provider) === TIMELINE_SLOT.JD_H5 ||
      provider === "jingdong_h5") return selected;
  const source = sourceTimeline(shipment);
  if (!source || source.provider.trim().toLowerCase() === provider) return selected;
  const fallbackTimes = timedTracks(selected.tracks).map(track => track.timeMs as number);
  if (!fallbackTimes.length) return selected;
  const earliest = Math.min(...fallbackTimes);
  const orderStage = timedTracks(source.tracks)
    .filter(track => isOwnerFeedTrack(track) && (track.timeMs as number) < earliest &&
      !isAccountUpdateSummary(track.detail))
    .sort((left, right) => (right.timeMs as number) - (left.timeMs as number));
  if (!orderStage.length) return selected;
  return { ...selected, tracks: [...selected.tracks, ...orderStage] };
}

/** Grafted JD H5 rows and provider-tagged rows are not the feed's own nodes (Pipi sameSourceOwnerTracks). */
function isOwnerFeedTrack(track: TrackNode): boolean {
  const tagged = String(track.raw?._pipiStatusSource || "").trim().toLowerCase();
  return !tagged || timelineCapability(tagged) === "account";
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

type DetailTimelineQuality = {
  timeline: TimelinePackage;
  complete: boolean;
  coverage: number;
  declared: boolean;
  tier: number;
};

function detailTimelineQuality(timeline: TimelinePackage, complete: boolean,
  source: TimelinePackage | null, coarseSource: boolean, ranked = timeline): DetailTimelineQuality {
  const coverage = timedTracks(ranked.tracks).length;
  const tier = timeline === source
    ? coarseSource ? DETAIL_TIER.coarseSource : complete ? DETAIL_TIER.sourceComplete
      : coverage >= SOURCE_TIMELINE_MIN_TRACKS ? DETAIL_TIER.sourceIncrement : DETAIL_TIER.sourceSummaryOnly
    : isPaidTimelineProvider(timeline.provider) ? DETAIL_TIER.paidManual : DETAIL_TIER.freeManual;
  return { timeline, complete, coverage, declared: manualTimelineIsComplete(ranked), tier };
}

/** History and equal-time status donors share quality rules without invoking selection. */
function compareDetailTimelineQuality(left: DetailTimelineQuality, right: DetailTimelineQuality): number {
  return Number(right.complete) - Number(left.complete) || right.coverage - left.coverage ||
    Number(right.declared) - Number(left.declared) || left.tier - right.tier ||
    compareTimelineProviderOrder(left.timeline, right.timeline);
}

/**
 * Missing node enums leave status consistency unverified, not disproven.
 * Known latest-node conflicts still veto history independently of pickup and event-time checks.
 */
export type DetailIncompleteReason = "no_tracks" | "status_unknown" |
  "status_mismatch" | "sf_active" | "missing_source_time" | "missing_pickup" | "time_mismatch";

export function shipmentDetailComplete(shipment: Shipment): boolean {
  return shipmentDetailIncompleteReason(shipment) === null;
}

/**
 * 刷新、完整缓存、冻结、进详情查询这些闸门照 HEAD 的样子判（助手按用户 2026-09-27 规则对齐）：临时评价不算，按去掉它
 * 的整行来看。
 */
export function shipmentDetailIncompleteReason(input: Shipment): DetailIncompleteReason | null {
  // A right-swipe signed row inside its refresh window is judged by its own status, as an ordinary row (用户 2026-10-02
  // 「显示已签收、照常刷新」).
  const shipment = withoutTemporaryReviews(refreshGateView(input));
  const selected = selectShipmentDetailTimeline(shipment);
  if (!timedTracks(selected.tracks).length) return "no_tracks";
  const expected = shipmentDetailPresentationStatus(shipment, selected).semantic;
  const terminalAt = terminalEvidenceAtMs({ ...shipment, timeline: selected });
  const statusReason = timelineStatusIncompleteReason(selected, expected, terminalAt);
  if (statusReason) return statusReason;
  // SF's coarse feed can stay unchanged while the carrier adds events; alignment cannot freeze an active parcel.
  if (isShunFengSourceShipment(shipment) && selected.semantic !== "COMPLETED" && selected.semantic !== "CANCELLED") {
    return "sf_active";
  }
  const source = accountPresentationReference(shipment);
  const sourceAt = source ? timelineLatestEventAt(source) : 0;
  // 没有 feed 作时间基准（纯手动件、feed 没有有效时间）时判不了「到此为止」：只有终态才算完整，
  // 在途的照常允许重拉——beta51 实测 EMS 手动件下拉被当成已完整、100ms 就跳过了。
  if (sourceAt <= 0) {
    if (selected.semantic !== "COMPLETED" && selected.semantic !== "CANCELLED") return "missing_source_time";
    return containsTimelinePickupTrack(selected.tracks) ? null : "missing_pickup";
  }
  return detailTimelineIncompleteReason(selected, source, expected, terminalAt);
}

function detailTimelineComplete(
  timeline: TimelinePackage,
  source: TimelinePackage | null,
  expectedStatus: StatusSemantic,
  terminalAt: number,
): boolean {
  return detailTimelineIncompleteReason(timeline, source, expectedStatus, terminalAt) === null;
}

function timelineStatusIncompleteReason(
  timeline: TimelinePackage, expected: StatusSemantic, terminalAt: number,
): DetailIncompleteReason | null {
  if (expected === "UNKNOWN") return "status_unknown";
  // Undated completion cannot certify older history or suppress its refresh.
  if (expected === "COMPLETED" && terminalAt <= 0) return "missing_source_time";
  return latestTimelineTrackStatuses(timeline.tracks).some(
    semantic => semantic !== "UNKNOWN" && semantic !== expected,
  ) ? "status_mismatch" : null;
}

function detailTimelineIncompleteReason(
  timeline: TimelinePackage,
  source: TimelinePackage | null,
  expectedStatus: StatusSemantic,
  terminalAt: number,
  hasStart = containsTimelinePickupTrack(timeline.tracks),
): DetailIncompleteReason | null {
  const statusReason = timelineStatusIncompleteReason(timeline, expectedStatus, terminalAt);
  if (statusReason) return statusReason;
  if (!hasStart) return "missing_pickup";
  const sourceAt = source ? timelineLatestEventAt(source) : 0;
  if (sourceAt <= 0) return null;
  const timelineAt = timelineLatestTrackAt(timeline);
  if (timelineAt <= 0) return "time_mismatch";
  // Account updates may lag carrier history; only older tracks need a tolerance.
  return sourceAt - timelineAt <= DETAIL_COMPLETE_SKEW_MS ? null : "time_mismatch";
}

/** Inspect every candidate at the same eligibility and completeness boundaries as selection. */
export function shipmentDetailCandidateEvidence(input: Shipment, timeline: TimelinePackage) {
  // Its completeness is a refresh gate: a right-swipe signed row inside its refresh window is judged by its own status
  // (用户 2026-10-02「显示已签收、照常刷新」).
  const shipment = refreshGateView(input);
  const candidate = displayedTimelinePresentation(shipment,
    withoutJingDongOrderCompletion(timeline, shipment.identity, false, jingDongSignedAnchorAtMs(shipment),
      jingDongAnchorEvidence(shipment)));
  const tracks = timedTracks(candidate.tracks);
  const presented = withSelectedDetailStatus(shipment, candidate);
  const pool = detailHistoryCandidates(shipment);
  const isSource = !shipment.identity.manuallyAdded &&
    normalizeTimelineSlot(candidate.provider) === normalizeTimelineSlot(sourceTimeline(shipment)?.provider || "");
  const gateReason = !tracks.length ? "no_tracks" : isSource
    ? pool.sfManuals.length ? "sf_manual_authority" : pool.sourceSummaryOnly ? "source_summary_only" : null
    : isForeignManualPackage(shipment, candidate) ? "foreign_package"
    : !selectedManualTimelines({ ...shipment, manualTimelines: [candidate] }).length ? "provider_not_qualified"
    : pool.sfManuals.length && !isShunFengManualTimeline(candidate) ? "sf_manual_authority"
    : detailManualRejectionReason(shipment, candidate);
  // A gate (sync's cached JD H5 check): judged as HEAD did, without temporary reviews (助手按用户 2026-09-27 规则对齐).
  const evaluated = withoutKeptReviewNodes(shipment, candidate);
  const reference = isShunFengSourceShipment(shipment) || shipment.identity.manuallyAdded
    ? pool.candidates.reduce<TimelinePackage | null>((latest, value) =>
      !latest || timelineLatestEventAt(value) > timelineLatestEventAt(latest) ? value : latest, null)
    : accountPresentationReference(withoutTemporaryReviews(shipment));
  const incompleteReason = timedTracks(evaluated.tracks).length
    ? detailTimelineIncompleteReason(evaluated, reference,
        presented.semantic, terminalEvidenceAtMs({ ...shipment, timeline: presented }))
    : "no_tracks";
  return {
    candidateEligible: gateReason === null,
    gateReason: gateReason ?? undefined,
    cainiaoFallbackActive: cainiaoManualFallbackActivated(shipment),
    hasPickup: containsTimelinePickupTrack(candidate.tracks),
    foreignPackage: isForeignManualPackage(shipment, candidate),
    foreignAnchorAtMs: foreignPackageAnchorMs(shipment) || 0,
    earliestTrackAtMs: tracks.length ? Math.min(...tracks.map(track => track.timeMs!)) : 0,
    waybillMatches: normalizeWaybill(candidate.waybill) === displayWaybill(shipment),
    waybillMatchesOrder: Boolean(shipment.identity.accountOrder &&
      normalizeWaybill(candidate.waybill) === normalizeWaybill(shipment.identity.sourceId)),
    detailComplete: incompleteReason === null,
    incompleteReason: incompleteReason ?? undefined,
  };
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

/** Diagnostics and ranking must reject a cached provider at the same source boundary. */
function detailManualRejectionReason(shipment: Shipment, timeline: TimelinePackage): string | null {
  const cainiaoNeedsH5 = cainiaoAutomaticNeedsH5Supplement(shipment);
  const cainiaoFallbackActive = cainiaoManualFallbackActivated(shipment);
  const supportsPrimaryContest = shipment.identity.manuallyAdded ||
    isJingDongSourceShipment(shipment) ||
    isShunFengSourceShipment(shipment) ||
    cainiaoFallbackActive ||
    supportsOrdinaryAutomaticDetailSupplement(shipment);

  const capability = timelineCapability(timeline.provider);
  const provider = normalizeTimelineSlot(timeline.provider);
  if (provider === TIMELINE_SLOT.V5_QUERY &&
      normalizeWaybill(timeline.waybill) !== displayWaybill(shipment)) return "waybill_mismatch";
  if (unprojectedAccountOrder(shipment) && provider !== TIMELINE_SLOT.V5_QUERY) return "unprojected_order";
  if (cainiaoNeedsH5 && !cainiaoFallbackActive) return provider === TIMELINE_SLOT.CN_H5 ||
    provider === TIMELINE_SLOT.V5_QUERY ? null : "cainiao_h5_required";
  const allowed = () => {
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
      const picker = provider === TIMELINE_SLOT.V6_QUERY;
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
        (provider === TIMELINE_SLOT.JD_H5 && isJingDongSourceShipment(shipment)) ||
        (provider === TIMELINE_SLOT.JT_H5 &&
          primaryH5Provider(shipment.identity.courierCode) === TIMELINE_SLOT.JT_H5 &&
          normalizeWaybill(timeline.waybill) === displayWaybill(shipment)) ||
        shipment.identity.manuallyAdded ||
        isShunFengSourceShipment(shipment) ||
        isVerifiedKuaidi100Timeline(timeline);
    }
    return capability === "fallback";
  };
  return allowed() ? null : "source_policy";
}

function eligibleDetailManuals(shipment: Shipment): TimelinePackage[] {
  return selectedManualTimelines(shipment)
    .map(timeline => displayedTimelinePresentation(shipment, timeline))
    .filter(timeline => !detailManualRejectionReason(shipment, timeline) && timedTracks(timeline.tracks).length > 0);
}

function detailHistoryCandidates(shipment: Shipment) {
  const rawSource = sourceTimeline(shipment);
  const source = rawSource ? displayedTimelinePresentation(shipment, rawSource) : null;
  const eligible = eligibleDetailManuals(shipment);
  const sfManuals = isShunFengSourceShipment(shipment) ? eligible.filter(isShunFengManualTimeline) : [];
  // A fresh list summary updates presentation, but cannot erase already loaded history.
  const presentedSource = source ? withSelectedDetailStatus(shipment, source) : null;
  const sourceSummaryOnly = Boolean(source && timedTracks(source.tracks).length < SOURCE_TIMELINE_MIN_TRACKS &&
    !detailTimelineComplete(source, accountPresentationReference(shipment), presentedSource!.semantic,
      terminalEvidenceAtMs({ ...shipment, timeline: presentedSource! })) &&
    eligible.some(timeline => timedTracks(timeline.tracks).length >= SOURCE_TIMELINE_MIN_TRACKS));
  const candidates = sfManuals.length ? sfManuals : [
    ...(source && !sourceSummaryOnly && timedTracks(source.tracks).length ? [source] : []), ...eligible,
  ];
  return { source, eligible, sfManuals, sourceSummaryOnly, candidates };
}

/** Rank eligible whole packages by completeness, coverage, capture proof and source priority. */
export function rankShipmentDetailCandidates(
  shipment: Shipment,
  onSelection?: (reason: string) => void,
): TimelinePackage | null {
  const finish = (timeline: TimelinePackage | null, reason: string) => {
    onSelection?.(reason);
    return timeline;
  };
  const { source, eligible, sfManuals, candidates } = detailHistoryCandidates(shipment);
  const sourceIsCoarseFallback = isShunFengSourceShipment(shipment);
  if (sourceIsCoarseFallback && !sfManuals.length && shipment.detailSelection?.reason === "sf_refresh_failed") {
    const fallback = eligible.find(timeline => normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.V5_QUERY);
    if (fallback) return finish(fallback, "sf_cached_query_fallback");
  }
  if (!candidates.length) return finish(null, "no_eligible_history");

  const accountCandidates = accountPresentationCandidates(shipment);
  const isAccountCandidate = (timeline: TimelinePackage): boolean =>
    !sourceIsCoarseFallback && accountCandidates.some(candidate =>
      candidate.provider === timeline.provider && candidate.waybill === timeline.waybill);
  const rank = (pool: readonly TimelinePackage[], view: (timeline: TimelinePackage) => TimelinePackage,
    accountReference: TimelinePackage | null) => rankDetailPackages(shipment, pool, {
    source, sfManuals, sourceIsCoarseFallback, isAccountCandidate, view, accountReference,
  });
  // 用户 2026-09-27「不算」「收窄」「要求」定了取舍；下面的比较顺序是助手按这些规则对齐的：作为第一次签收保留下来的
  // 评价（临时评价）照原来的排法算进账号自己的包（feed、v5_query）。先比一轮：去掉它的账号包对完成时间当时或之后抓到的非账号包（jd_h5 / cn_h5 / 手动链）——
  // 完整性（含账号参照对齐）、最新节点、节点数和粘性选包都按去掉它来算，胜出的是非账号包就选它。否则账号包与
  // 完成之前抓到的非账号包按原来的排法（评价照算）再比。没有临时评价的行与原来一字不差。选中的包照原样显示。
  const accounts = candidates.filter(isAccountCandidate);
  const stripped = new Map(accounts.map(timeline => [timeline, withoutKeptReviewNodes(shipment, timeline)]));
  if (accounts.every(timeline => stripped.get(timeline) === timeline)) {
    const [original, reason] = rank(candidates, (timeline) => timeline, accountPresentationReference(shipment));
    return finish(original, reason);
  }
  const captured = candidates.filter(timeline =>
    !isAccountCandidate(timeline) && capturedAtOrAfterCompletion(shipment, timeline));
  if (captured.length) {
    const [winner, reason] = rank(candidates.filter(timeline => isAccountCandidate(timeline) || captured.includes(timeline)),
      (timeline) => stripped.get(timeline) || timeline, rankingAccountReference(shipment));
    if (!isAccountCandidate(winner)) return finish(winner, reason);
  }
  const [winner, reason] = rank(candidates.filter(timeline => !captured.includes(timeline)),
    (timeline) => timeline, accountPresentationReference(shipment));
  return finish(winner, reason);
}

/**
 * 「完成之后抓到」（用户 2026-09-27「要求」；判法是助手按该规则对齐的）：包的抓取时间（successAtMs）不早于 feed 结构化签收的时间，与签收缺口
 * 「完成时间当时或之后抓过」同一口径。没有结构化签收时间就谈不上完成之后。
 */
function capturedAtOrAfterCompletion(shipment: Shipment, timeline: TimelinePackage): boolean {
  const source = sourceTimeline(shipment);
  const completedAt = source?.structuredStatus === true && source.semantic === "COMPLETED"
    ? source.statusEventAtMs || 0 : 0;
  return completedAt > 0 && Number(timeline.successAtMs) >= completedAt;
}

function rankDetailPackages(
  shipment: Shipment,
  candidates: readonly TimelinePackage[],
  context: Readonly<{
    source: TimelinePackage | null;
    sfManuals: readonly TimelinePackage[];
    sourceIsCoarseFallback: boolean;
    isAccountCandidate: (timeline: TimelinePackage) => boolean;
    view: (timeline: TimelinePackage) => TimelinePackage;
    accountReference: TimelinePackage | null;
  }>,
): [TimelinePackage, string] {
  const { source, sfManuals, sourceIsCoarseFallback, isAccountCandidate, view, accountReference } = context;
  const latestTrackAt = (timeline: TimelinePackage): number => timelineLatestTrackAt(view(timeline));
  // 优先级（用户定 2026-09-04）：接口完整轨迹 → 本地 feed 增量 → 免费手动包 → 付费手动包。
  // 顺丰是唯一例外：它的 feed 只有粗略轨迹，退到最后兜底，Picker 才是第一优先级。
  // SF's coarse feed is not a freshness ceiling. Only eligible same-parcel packages may advance the reference.
  const completenessSource = sourceIsCoarseFallback || shipment.identity.manuallyAdded
    ? view(candidates.reduce((latest, candidate) =>
      timelineLatestEventAt(view(candidate)) > timelineLatestEventAt(view(latest)) ? candidate : latest
    ))
    : accountReference;
  const complete = (timeline: TimelinePackage): boolean => {
    const presented = withSelectedDetailStatus(shipment, timeline);
    // SF/manual selection can advance its own status; other automatic sources retain owner status.
    const expected = presented.semantic;
    return detailTimelineComplete(view(timeline), completenessSource, expected,
      terminalEvidenceAtMs({ ...shipment, timeline: presented }));
  };
  const qualities = new Map<TimelinePackage, DetailTimelineQuality>();
  const quality = (timeline: TimelinePackage): DetailTimelineQuality => {
    const existing = qualities.get(timeline);
    if (existing) return existing;
    const value = detailTimelineQuality(timeline, complete(timeline), source, sourceIsCoarseFallback, view(timeline));
    qualities.set(timeline, value);
    return value;
  };
  const ranked = candidates.slice().sort((left, right) =>
    compareDetailTimelineQuality(quality(left), quality(right)));
  // A newer account clock cannot bypass history that still passes the shared completeness check.
  // Incomplete older history may yield; complete history retains the existing ranking and sticky rules.
  const newestAccountAt = Math.max(0, ...ranked.filter(isAccountCandidate).map(latestTrackAt));
  const accountAdvances = newestAccountAt > 0 && ranked.every(candidate => {
    const at = latestTrackAt(candidate);
    return at > 0 && (isAccountCandidate(candidate)
      ? at <= newestAccountAt
      : at < newestAccountAt && !complete(candidate));
  });
  const finalists = accountAdvances
    ? ranked.filter(candidate => isAccountCandidate(candidate) && latestTrackAt(candidate) === newestAccountAt)
    : ranked;
  const winner = finalists[0];
  // 粘性选包（用户定 2026-09-05 晚，三端同口径）：上一轮显示过的包还在（没被判串包、没被清掉）
  // 就默认还显示它；只有它自己不完整、而排第一的包已完整时才换。
  const preferredProvider = String(shipment.detailSelection?.provider || "")
    .trim()
    .toLowerCase();
  const preferred = preferredProvider
    ? finalists.find((timeline) => timeline.provider.trim().toLowerCase() === preferredProvider)
    : undefined;
  if (preferred && preferred !== winner) {
    return complete(preferred) || !complete(winner)
      ? [preferred, "sticky_history"]
      : [winner, "complete_replaces_partial"];
  }
  const runner = finalists[1];
  const reason = accountAdvances && finalists.length < ranked.length ? "newer_account_history"
    : !runner ? sfManuals.length ? "sf_manual_history" : "only_eligible_history"
    : complete(winner) !== complete(runner) ? "complete_history"
    : quality(winner).coverage !== quality(runner).coverage ? "track_coverage"
    : quality(winner).declared !== quality(runner).declared ? "capture_complete"
    : quality(winner).tier !== quality(runner).tier ? "source_tier" : "provider_order";
  return [winner, reason];
}

export function hasEligibleShunFengManualTimeline(shipment: Shipment): boolean {
  const selected = isShunFengSourceShipment(shipment) ? rankShipmentDetailCandidates(shipment) : null;
  return selected != null && isShunFengManualTimeline(selected);
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

function selectShipmentDetailTimelineInner(
  shipment: Shipment,
): TimelinePackage {
  return selectShipmentTimeline(shipment);
}

function withSelectedDetailStatus(shipment: Shipment, selected: TimelinePackage): TimelinePackage {
  return applyForcedCompletion(
    shipment,
    preservesTerminalStatus(
      withoutJingDongOrderCompletion(shipment.timeline, shipment.identity,
        false, jingDongSignedAnchorAtMs(shipment), jingDongAnchorEvidence(shipment)),
      structuredStatusOverride(shipment, selected),
      shipment.timeline.structuredStatus === true,
      isFrozenJingDongShipment(shipment),
    ),
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
  input: Shipment,
  now: number,
  force = false,
): boolean {
  // A right-swipe signed row inside its refresh window is scheduled by its own status (用户 2026-10-02「显示已签收、
  // 照常刷新」); once hard-frozen the latch below stops it, as before.
  const shipment = refreshGateView(input, now);
  if (Number(shipment.emptyTimelineHiddenAtMs) > 0) return false;
  if (forcedCompletedAt(shipment)) return false;
  // A local retention anchor is not delivery evidence; undated completion still needs refresh.
  if (hasSettledTimelineHistory(shipment, now)) return false;
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
    if (selectedManual?.semantic === "COMPLETED" &&
      terminalEvidenceAtMs({ ...shipment, timeline: selectedManual }, now) > 0) {
      return !manualTimelineIsComplete(selectedManual);
    }
    return true;
  }
  if (hasSourceProvider(shipment, "ShunFeng")) {
    const selectedManual = selectTimelineAuthority(null, selectedManualTimelines(shipment));
    return !(
      selectedManual?.semantic === "COMPLETED" &&
      terminalEvidenceAtMs({ ...shipment, timeline: selectedManual }, now) > 0 &&
      manualTimelineIsComplete(selectedManual)
    );
  }
  return needsAutomaticListSupplement(shipment);
}

/** List supplementation fills missing status or timed history after same-ticket cache selection. */
export function needsAutomaticListSupplement(shipment: Shipment): boolean {
  if (shipment.identity.manuallyAdded || shipment.identity.bindingSource !== "interface5" ||
      unprojectedAccountOrder(shipment) || displayWaybill(shipment).length < 6) return false;
  const selected = selectShipmentTimeline(withoutTemporaryReviews(shipment));
  return selected.semantic === "UNKNOWN" || timedTracks(selected.tracks).length === 0;
}

/** Home handles these account sources before considering independent manual work. */
export function isHomeAccountQuerySource(shipment: Shipment): boolean {
  const provider = String(shipment.identity.sourceProvider || "").toLowerCase();
  return !shipment.identity.manuallyAdded && shipment.identity.bindingSource === "interface5" &&
    (provider === "jingdong" || provider === "cainiao");
}

/** 打开详情时查 v5 的理由：账号状态要刷新。 */
export type DetailEntryQueryReason = "refresh";

/**
 * 用户 2026-10-03「v5 对不上并进对齐」（优化 2）：京东接口 5 列表最新一条与详情最新一条对不上（原来一分钟、只记在内存里）
 * 不再是打开详情查 v5 的理由；超过五分钟的由状态对齐（services/status-alignment.ts）按同一份持久化的「同组时间只刷一次」
 * 记录强刷，京东件的强刷先问按件详情。打开详情的其余行为不变。
 */
export function detailEntryQueryReason(input: Shipment): DetailEntryQueryReason | null {
  // 签收三态冻结（用户 2026-10-02「头条 状态 详情页 都推进到了签收状态…就冻结快递 后续不再进行任何刷新」）：打开详情不再查，
  // 详情页照常显示缓存。右滑签收的行在硬冻结之前按来源自己的状态判（用户 2026-10-02「我已取件这种硬冻结 也要等三态都是签收
  // 才冻结」）。
  if (signedRefreshFrozen(input)) return null;
  const shipment = refreshGateView(input);
  const provider = String(shipment.identity.sourceProvider || "").toLowerCase();
  const selected = selectShipmentTimeline(shipment);
  if (shipment.identity.manuallyAdded || !shipment.accountRecord ||
      (provider !== "jingdong" && provider !== "cainiao") ||
      // Complete cached JD history does not prove its account status is still current.
      !((provider === "jingdong" && selected.semantic !== "CANCELLED") ||
        !shipmentDetailComplete(shipment) || selected.semantic === "UNKNOWN")) return null;
  return shouldRefreshShipment({ ...shipment, timeline: selected }) ? "refresh" : null;
}

export function needsDetailEntryQuery(shipment: Shipment): boolean {
  return detailEntryQueryReason(shipment) !== null;
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
 * Detail responses belong to v5_query and must not rewrite the raw list snapshot.
 * JingDong may subsequently extend this query with matching list increments
 * (user decision, 2026-09-13); H5 and other providers remain independent.
 * The list placeholder carries accepted identity without copying query nodes.
 */
export function asAccountDetailObservation(
  current: Shipment,
  incoming: Shipment,
): Shipment {
  const detail = incoming.sourceTimeline || incoming.timeline;
  const feed = sourceTimeline(current);
  // 没有 feed 槽时不要凭空造一个空包盖掉这一行：签收后详情只回摘要的那一轮，占位包会把已经
  // 存下来的节点整份抹掉，界面变成「已签收 · 暂无物流动态」，而且没有签收时间就连 14 天保留期
  // 都不会到期（用户 2026-09-07 报，下拉刷新才重新拉回来）。存着的节点优先当占位。
  const stored = current.timeline;
  const placeholder: TimelinePackage = feed
    ? { ...feed, waybill: detail.waybill || feed.waybill }
    : timedTracks(stored.tracks).length
      ? { ...stored, waybill: detail.waybill || stored.waybill }
      : { ...detail, tracks: [] };
  const queryPackage: TimelinePackage = { ...detail, provider: TIMELINE_SLOT.V5_QUERY };
  const manuals = timedTracks(detail.tracks).length || (detail.structuredStatus && detail.semantic !== "UNKNOWN")
    ? mergeTimelineAuthorities(incoming.manualTimelines || [], queryPackage)
    : incoming.manualTimelines || [];
  return {
    ...incoming,
    // Query evidence has its own slot; the durable request tuple belongs to the list row.
    accountRecord: current.accountRecord ?? incoming.accountRecord,
    identity: { ...incoming.identity, sender: current.identity.sender ?? incoming.identity.sender },
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

/**
 * 归属方案 T1（用户 2026-09-25 采纳）：同一来源的两条上游记录（订单号的行与运单号的行、两张订单）各写各的行和观测槽，
 * 从不合并；记录号就是行 id。例外只有一个：已投影订单按件详情回来的包以投影运单号为号，仍是这张订单自己的。
 * 不同来源对同一运单的观测照 §5.1 各自留存，不在此列。
 */
export function isDifferentAccountRecord(current: Shipment, incoming: Shipment): boolean {
  if (current.identity.manuallyAdded || incoming.identity.manuallyAdded) return false;
  if (current.identity.id === incoming.identity.id) return false;
  if (automaticSourceOf(current) !== automaticSourceOf(incoming)) return false;
  const projection = normalizedProjectedWaybill(current.identity);
  return !(current.identity.accountOrder && projection &&
    normalizeWaybill(incoming.identity.sourceId) === projection);
}

function mergeAccountShipmentPackage(
  current: Shipment | undefined,
  incoming: Shipment,
  now: number,
): Shipment {
  if (current && isDifferentAccountRecord(current, incoming)) return current;
  const accountOrder = Boolean(
    current?.identity.accountOrder || incoming.identity.accountOrder,
  );
  const currentSourceValue = current ? sourceTimeline(current) : null;
  const incomingSourceValue = withoutJingDongOrderCompletion(
    incoming.sourceTimeline || incoming.timeline, incoming.identity,
    false, jingDongSignedAnchorAtMs(current), jingDongAnchorEvidence(current),
  );
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
    ? withoutFeedRebuildFlag(establishesProjection
      ? withAccountListOrigin(currentSource, incomingSource) : incomingSource)
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
    manuals = mergeTimelineAuthorities(manuals,
      withoutJingDongOrderCompletion(timeline, incoming.identity, false, jingDongSignedAnchorAtMs(current),
        jingDongAnchorEvidence(current)));
  }
  // JingDong list/detail share account evidence. Only an accepted same-waybill list advance
  // extends an existing query; independent H5/manual packages remain untouched.
  if (!rejectsUnprojectedOrderCompletion && !reclassifiesAccountOrder &&
      isJingDongSourceShipment(incoming) && timelineCapability(mergedSource.provider) === "account" &&
      ["interface5", "account", "v5_list"].includes(mergedSource.provider.toLowerCase()) &&
      normalizeWaybill(mergedSource.waybill)) {
    manuals = manuals.map(timeline => normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.V5_QUERY &&
      normalizeWaybill(timeline.waybill) === normalizeWaybill(mergedSource.waybill) &&
      timelineLatestTrackAt(mergedSource) > timelineLatestTrackAt(timeline)
      ? mergeTimelinePackage(timeline, { ...mergedSource, provider: timeline.provider })
      : timeline);
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
  let identity: Shipment["identity"] = current && accountOrder
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
          : projectedPresentation?.companyName || "",
        sourceProvider: incomingSourceProvider || currentSourceProvider,
      }
    : mergedIdentity;
  // T23 (user 2026-09-26): a union-page waybill held for its carrier ends once the order is projected.
  if (identity.pendingProjection && (nextProjection || currentProjection)) {
    const { pendingProjection: _settled, ...rest } = identity;
    identity = rest;
  }
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
    // The account response cannot revoke eligibility already established by this owner's H5 attempt.
    cainiaoH5FallbackActivatedAtMs:
      current?.cainiaoH5FallbackActivatedAtMs ?? incoming.cainiaoH5FallbackActivatedAtMs,
    route: keepsCainiaoRoute
      ? incoming.route || current?.route || null
      : null,
    accountRecord:
      incoming.accountRecord == null
        ? current?.accountRecord
        : incoming.accountRecord,
    // The ownership bookkeeping of this row (occupied-at, the carried carrier status) is not the package's to drop;
    // every save recomputes both from the whole list.
    ...((current || incoming).occupiedAtMs !== undefined
      ? { occupiedAtMs: (current || incoming).occupiedAtMs } : {}),
    ...((current || incoming).attachedCarrierStatus
      ? { attachedCarrierStatus: (current || incoming).attachedCarrierStatus } : {}),
    // The list sync owns the stored list status (audit L8); a detail or query packet keeps it.
    ...((current || incoming).listStructuredSemantic
      ? { listStructuredSemantic: (current || incoming).listStructuredSemantic } : {}),
    updatedAtMs: now,
  };
  const selected = selectShipmentTimeline(candidate);
  const protectsManualTerminal = Boolean(
    current &&
      !reclassifiesAccountOrder &&
      (isFrozenJingDongShipment(current) || current.timeline.structuredStatus === true ||
        current.identity.manuallyAdded ||
        isShunFengSourceShipment(current) ||
        needsAutomaticManualFallback(current)),
  );
  return {
    ...candidate,
    timeline: protectsManualTerminal
      ? preservesTerminalStatus(
          current ? withoutJingDongOrderCompletion(current.timeline, current.identity,
            false, jingDongSignedAnchorAtMs(current), jingDongAnchorEvidence(current)) : null,
          selected,
          isFrozenJingDongShipment(current),
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
      ? withAccountListOrigin(previous.sourceTimeline, incoming.sourceTimeline)
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
      sourceTimeline: withoutJingDongOrderCompletion(
        observation.sourceTimeline, observation.identity,
        false, jingDongSignedAnchorAtMs(shipment), jingDongAnchorEvidence(shipment),
      ),
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
  const validRawCarrier = (value: string) => Boolean(value) &&
    !["NULL", "OTHER", "UNKNOWN", "未知", "其他"].includes(value.normalize("NFKC").toUpperCase());
  const trustedAccountProjection = Boolean(
    shipment.identity.accountOrder &&
      normalizedProjectedWaybill(shipment.identity),
  );
  return Boolean(
    source &&
    declaredSource === source &&
    // JD's order page can establish the carrier waybill even when the account
    // snapshot omits the raw carrier fields required from ordinary list rows.
    (validRawCarrier(rawCarrierCode) || validRawCarrier(rawCompanyName) || trustedAccountProjection) &&
    sourceTimeline.semantic !== "UNKNOWN" &&
    // Local timeline ownership is the provider identity, not a minimum node count.
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
  // T1: another record of the same source never writes this row or its observation slots.
  if (currentInput && isDifferentAccountRecord(currentInput, incoming)) {
    return normalizeAutomaticOwnership(currentInput, now);
  }
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
 * A different record of the same source is never absorbed (T1, user 2026-09-25): it keeps its own row.
 */
export function absorbAutomaticShipment(
  ownerInput: Shipment,
  duplicateInput: Shipment,
  now: number,
): Shipment {
  if (ownerInput.identity.manuallyAdded || duplicateInput.identity.manuallyAdded ||
      isDifferentAccountRecord(ownerInput, duplicateInput)) {
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

/**
 * 运单号重用只看来源自己报的终态（用户 2026-10-02「修，和 Pipi 一致」）：右滑签收（forcedCompletedAtMs）既不是终态，也不是
 * 终态时间。两边都按去掉签收闩锁、由来源自己重新选出的展示去比（withoutForcedCompletion）；来源不是终态的行不论有没有闩锁
 * 都不是重用对象，来源自己终态的行照常按来源的终态时间判。
 */
function shipmentReusesWaybill(current: Shipment, incoming: Shipment, now: number): boolean {
  return presentedShipmentReusesWaybill(withoutForcedCompletion(current), withoutForcedCompletion(incoming), now);
}

/**
 * 承运商复用旧运单号（用户 2026-10-01/02「C 新件优先（含 A）」「至少晚 24 小时」，四端；services/waybill-reuse.ts）：
 * 这条账号记录是这一行号码上的新件——旧件已签收或已取消，新件锚点不早于旧件终态 24 小时，且新件这一轮能建立归属。
 * 京东业务来源两边都排除。
 */
export function accountShipmentReusesWaybill(
  current: Shipment | undefined,
  incoming: Shipment,
  now: number,
  automaticSource = "",
): boolean {
  return Boolean(
    current &&
    !current.identity.manuallyAdded &&
    !incoming.identity.manuallyAdded &&
    sameCanonicalWaybill(current, incoming) &&
    shipmentReusesWaybill(current, incoming, now) &&
    automaticSourceOf(incoming, automaticSource) &&
    isQualifiedAutomaticShipment(incoming, automaticSourceOf(incoming, automaticSource)),
  );
}

/** Detail 4: an old signed (or cancelled) manual row of the number is taken over by the new automatic record. */
export function manualShipmentReusedBy(
  manual: Shipment,
  incoming: Shipment,
  now: number,
  automaticSource = "",
): boolean {
  return Boolean(
    manual.identity.manuallyAdded &&
    !incoming.identity.manuallyAdded &&
    sameCanonicalWaybill(manual, incoming) &&
    shipmentReusesWaybill(manual, incoming, now) &&
    automaticSourceOf(incoming, automaticSource) &&
    isQualifiedAutomaticShipment(incoming, automaticSourceOf(incoming, automaticSource)),
  );
}

/** The old record of a number a newer parcel already took: it never writes the row again (detail 5). */
export function accountShipmentIsSupersededRecord(
  current: Shipment | undefined,
  incoming: Shipment,
  now: number,
): boolean {
  return Boolean(
    current &&
    !incoming.identity.manuallyAdded &&
    sameCanonicalWaybill(current, incoming) &&
    shipmentReusesWaybill(incoming, current, now),
  );
}

/**
 * The new parcel takes the row as a first sighting: nothing of the old record stays — not its packages and manual
 * timelines, settled clock, note, forced completion, detail selection, Cainiao fallback, empty-history hiding or
 * refresh lease. `waybillReuseAtMs` marks the new generation for storage (no settled clock carried, no notification).
 */
export function reusedWaybillShipment(incomingInput: Shipment, now: number, automaticSource = ""): Shipment {
  const {
    manualTimelines: _manualTimelines,
    detailSelection: _detailSelection,
    note: _note,
    forcedCompletedAtMs: _forcedCompletedAtMs,
    settledAtMs: _settledAtMs,
    cainiaoH5FallbackActivatedAtMs: _cainiaoH5FallbackActivatedAtMs,
    emptyTimelineHiddenAtMs: _emptyTimelineHiddenAtMs,
    manualRefreshAttemptAtMs: _manualRefreshAttemptAtMs,
    manualRefreshLease: _manualRefreshLease,
    waybillReuseAtMs: _waybillReuseAtMs,
    ...incoming
  } = incomingInput;
  const fresh = observeQualifiedAutomaticShipment(
    undefined,
    { ...incoming, manualTimelines: [] },
    automaticSource,
    now,
  );
  return { ...fresh, waybillReuseAtMs: Math.max(1, now) };
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
  // A number a carrier reused: the old parcel's settled history is not the new parcel's (user 2026-10-02).
  if (newerWaybillReuseGeneration(current, merged)) return merged;
  // History remains durable even when a missing terminal timestamp keeps refresh eligible.
  if (!current || (!forcedCompletedAt(current) &&
    !((current.timeline.semantic === "COMPLETED" || current.timeline.semantic === "CANCELLED") &&
      timelineHasUsableHistory(current.timeline)))) return merged;
  const kept = timedTracks(current.timeline.tracks).length;
  if (!kept) return merged;
  const next = timedTracks(merged.timeline.tracks).length;
  if (next >= kept) return merged;
  // A shorter complete package may close the status gap in an older terminal snapshot.
  // Its independent provider slots retain the previous history.
  if (shipmentDetailComplete(merged) && !shipmentDetailComplete(current)) return merged;
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
  const settled = preserveSettledTimeline(current, mergedInput);
  // The takeover generation of a reused number stays with the row through later merges (user 2026-10-02).
  const merged = current?.waybillReuseAtMs && !settled.waybillReuseAtMs
    ? { ...settled, waybillReuseAtMs: current.waybillReuseAtMs }
    : settled;
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
    detailSelection: current.detailSelection?.reason === "sf_refresh_failed" &&
      timedTracks(incomingTimeline.tracks).length > 0 &&
      !isForeignManualPackage(current, incomingTimeline)
      ? undefined : current.detailSelection,
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
  if (current?.detailSelection?.reason === "sf_refresh_failed" && timedTracks(incoming.timeline.tracks).length &&
      !isForeignManualPackage(current, incoming.timeline)) {
    current = { ...current, detailSelection: undefined };
    incoming = { ...incoming, detailSelection: undefined };
  }
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
  const protectsManualTerminal = isFrozenJingDongShipment(current) || current.timeline.structuredStatus === true ||
    current.identity.manuallyAdded ||
    isShunFengSourceShipment(current) || needsAutomaticManualFallback(current);
  return {
    ...candidate,
    timeline: protectsManualTerminal
      ? preservesTerminalStatus(
          withoutJingDongOrderCompletion(current.timeline, current.identity,
            false, jingDongSignedAnchorAtMs(current), jingDongAnchorEvidence(current)),
          selected,
          isFrozenJingDongShipment(current),
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
  const protectsManualTerminal = isFrozenJingDongShipment(accountOwner) || accountOwner.timeline.structuredStatus === true ||
    accountOwner.identity.manuallyAdded ||
    isShunFengSourceShipment(accountOwner) ||
    needsAutomaticManualFallback(accountOwner);
  return {
    ...candidate,
    timeline: protectsManualTerminal
      ? preservesTerminalStatus(
          withoutJingDongOrderCompletion(accountOwner.timeline, accountOwner.identity,
            false, jingDongSignedAnchorAtMs(accountOwner), jingDongAnchorEvidence(accountOwner)),
          selected,
          isFrozenJingDongShipment(accountOwner),
          isFrozenJingDongShipment(accountOwner),
        )
      : selected,
  };
}
