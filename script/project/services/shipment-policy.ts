import type {
  AutomaticOwnership,
  AutomaticSourceObservation,
  Shipment,
  TimelinePackage,
} from "../models";
import {
  accountOrderSemantic,
  compareTimelinePackageCompleteness,
  containsTimelinePickupTrack,
  containsTimelineStartTrack,
  manualTimelineIsComplete,
  mergeTracks,
  mergeTimelineAuthorities,
  mergeTimelinePackage,
  normalizeWaybill,
  normalizedProjectedWaybill,
  selectTimelineAuthority,
  timelineCapability,
  timedTracks,
} from "./status";
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

export function isVerifiedKuaidi100Timeline(
  timeline: TimelinePackage,
): boolean {
  if (timeline.provider.trim().toLowerCase() !== "kuaidi100_h5") return false;
  const expected = resolveCarrierQuery(timeline.courierCode);
  const rawCourierCode = String(timeline.rawCourierCode || "").trim();
  const rawCarrier = rawCourierCode
    ? resolveCarrierKuaidi100Code(rawCourierCode)
    : null;
  const tracks = timedTracks(timeline.tracks);
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
  const values = manualTimelines(shipment);
  if (shipment.identity.manuallyAdded) return values;
  const providers = new Set([
    "local",
    "route",
    "web",
    "fallback",
    "cainiao_h5",
    "kuaidi100_h5",
    "moto",
    "meizu",
    "oppo",
    "kdniao",
    "kuaidi100",
  ]);
  return values.filter((timeline) => {
    const provider = timeline.provider.trim().toLowerCase();
    return providers.has(provider) &&
      (provider !== "kuaidi100_h5" || isVerifiedKuaidi100Timeline(timeline));
  });
}

const PRE_KDNIAO_TIMELINE_PROVIDERS = new Set([
  "local",
  "route",
  "web",
  "cainiao_h5",
  "kuaidi100_h5",
  "moto",
  "meizu",
  "oppo",
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
  return { ...selected, tracks };
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

function isJingDongH5TimelinePackage(
  timeline: TimelinePackage | null | undefined,
): boolean {
  return Boolean(
    timeline && timedTracks(timeline.tracks).some((track) =>
      String(track.raw?._pipiStatusSource || "")
        .trim()
        .toLowerCase() === "jingdong_h5"
    ),
  );
}

function mergeAutomaticSourceTimeline(
  current: TimelinePackage | null,
  incoming: TimelinePackage,
): TimelinePackage {
  const currentIsJingDongH5 = isJingDongH5TimelinePackage(current);
  const incomingIsJingDongH5 = isJingDongH5TimelinePackage(incoming);
  if (!currentIsJingDongH5 && !incomingIsJingDongH5) {
    return mergeTimelinePackage(current, incoming);
  }
  if (!currentIsJingDongH5) return incoming;
  if (!incomingIsJingDongH5) return current!;
  const currentComplete = current!.complete === true;
  const incomingComplete = incoming.complete === true;
  if (currentComplete !== incomingComplete) {
    return incomingComplete ? incoming : current!;
  }
  return incoming.successAtMs >= current!.successAtMs ? incoming : current!;
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

export function jingDongAutomaticH5TimelineAvailable(
  shipment: Shipment,
): boolean {
  if (
    shipment.identity.manuallyAdded ||
    !shipment.identity.accountOrder ||
    !isJingDongSourceShipment(shipment)
  ) return false;
  const projectedWaybill = normalizedProjectedWaybill(shipment.identity);
  const source = sourceTimeline(shipment);
  return Boolean(
    projectedWaybill &&
      source &&
      source.complete === true &&
      normalizeWaybill(source.waybill) === projectedWaybill &&
      isJingDongH5TimelinePackage(source),
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
      timeline.provider.trim().toLowerCase(),
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

export function selectShipmentTimeline(shipment: Shipment): TimelinePackage {
  const source = sourceTimeline(shipment);
  const selectedManuals = selectedManualTimelines(shipment);
  const manuals = cainiaoAutomaticNeedsH5Supplement(shipment) &&
      !cainiaoManualFallbackActivated(shipment)
    ? selectedManuals.filter((timeline) =>
        timeline.provider.trim().toLowerCase() === "cainiao_h5"
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
    const jingDongManual = [...jingDongManualCandidates]
      .sort((left, right) => {
          const startCoverage = Number(containsTimelineStartTrack(right.tracks)) -
            Number(containsTimelineStartTrack(left.tracks));
          return startCoverage || compareTimelinePackageCompleteness(left, right);
        })[0] || null;
    const completeJingDongManual = [...jingDongManualCandidates]
      .filter(manualTimelineIsComplete)
      .sort(compareTimelinePackageCompleteness)[0] || null;
    const completeJingDongH5 = jingDongAutomaticH5TimelineAvailable(shipment);
    const incompleteJingDongH5 = Boolean(
      jingDongAccount &&
      isJingDongH5TimelinePackage(jingDongAccount) &&
      !completeJingDongH5,
    );
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
    selected = shipment.identity.manuallyAdded
      ? ordered[0] || manualRaceWinner || capabilityTimeline("fallback") ||
        selectTimelineAuthority(source, manuals) || shipment.timeline
      : isJingDongSourceShipment(shipment)
        ? completeJingDongH5 && jingDongAccount
          ? jingDongAccount
          : incompleteJingDongH5 && completeJingDongManual
          ? completeJingDongManual
          : jingDongAccount && containsTimelineStartTrack(jingDongAccount.tracks)
          ? jingDongAccount
          : jingDongManual || jingDongAccount || shipment.timeline
        : terminal || ordered[0] ||
          selectTimelineAuthority(source, manuals) || shipment.timeline;
  }
  const supplemented = supplementTimelineHistory(
    selected,
    [...(source ? [source] : []), ...manuals],
  );
  return applyForcedCompletion(
    shipment,
    isFrozenJingDongShipment(shipment)
      ? preservesTerminalStatus(shipment.timeline, supplemented, true)
      : supplemented,
  );
}

export function selectShipmentDetailTimeline(
  shipment: Shipment,
): TimelinePackage {
  const fallback = selectShipmentTimeline(shipment);
  const source = sourceTimeline(shipment);
  if (
    jingDongAutomaticH5TimelineAvailable(shipment) && source &&
    timedTracks(source.tracks).length
  ) {
    return applyForcedCompletion(shipment, source);
  }
  if (isJingDongSourceShipment(shipment) && sourceTimelineHasStart(shipment)) {
    return fallback;
  }
  const cainiaoNeedsH5 = cainiaoAutomaticNeedsH5Supplement(shipment);
  const cainiaoFallbackActive = cainiaoManualFallbackActivated(shipment);
  const manuals = selectedManualTimelines(shipment);
  if (cainiaoNeedsH5) {
    const cainiaoH5 = selectTimelineAuthority(
      null,
      manuals.filter((timeline) =>
        timeline.provider.trim().toLowerCase() === "cainiao_h5"
      ),
    );
    if (cainiaoH5 && timedTracks(cainiaoH5.tracks).length) {
      return applyForcedCompletion(shipment, cainiaoH5);
    }
    if (!cainiaoFallbackActive) return fallback;
  }
  const supportsPrimaryContest = shipment.identity.manuallyAdded ||
    isJingDongSourceShipment(shipment) ||
    isShunFengSourceShipment(shipment) ||
    cainiaoFallbackActive ||
    supportsOrdinaryAutomaticDetailSupplement(shipment);
  if (!supportsPrimaryContest) {
    return fallback;
  }
  const primary = manuals.filter((timeline) => {
    const capability = timelineCapability(timeline.provider);
    if (capability === "local") {
      return (shipment.identity.manuallyAdded ||
        cainiaoFallbackActive ||
        supportsOrdinaryAutomaticDetailSupplement(shipment)) &&
        !isJingDongSourceShipment(shipment);
    }
    if (capability === "route") {
      const provider = timeline.provider.trim().toLowerCase();
      const picker = provider === "route" || provider === "meizu";
      if (
        supportsOrdinaryAutomaticDetailSupplement(shipment) ||
        (picker && (
          shipment.identity.manuallyAdded ||
          isShunFengSourceShipment(shipment) ||
          cainiaoFallbackActive ||
          isJingDongSourceShipment(shipment)
        ))
      ) return true;
    }
    if (capability !== "web") return false;
    return shipment.identity.manuallyAdded ||
      isShunFengSourceShipment(shipment) ||
      isVerifiedKuaidi100Timeline(timeline);
  }).filter((timeline) => timedTracks(timeline.tracks).length > 0)
    .sort(compareTimelinePackageCompleteness)[0] || null;
  const kdniao = selectTimelineAuthority(
    null,
    manuals.filter((timeline) => timelineCapability(timeline.provider) === "fallback"),
  );
  const selected = [primary, kdniao]
    .filter((timeline): timeline is TimelinePackage => Boolean(timeline))
    .sort(compareTimelinePackageCompleteness)[0] || null;
  if (!selected) return fallback;
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
  const mergedSource = establishesProjection || reclassifiesAccountOrder
    ? incomingSource
    : rejectsUnprojectedOrderCompletion
    ? currentSource!
    : mergeAutomaticSourceTimeline(currentSource, incomingSource);
  let manuals = current && !reclassifiesAccountOrder
    ? manualTimelines(current)
    : [];
  for (const timeline of incoming.manualTimelines || []) {
    manuals = mergeTimelineAuthorities(manuals, timeline);
  }
  const preservesExistingProjection = Boolean(
    current?.identity.accountOrder &&
    currentProjection &&
    !nextProjection,
  );
  const projectedPresentation = nextProjection
    ? projectedCarrierPresentation(
        nextProjection,
        incoming.identity.courierCode || current?.identity.courierCode || "",
        incoming.identity.companyName || current?.identity.companyName || "",
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
          ? current.identity.courierCode
          : projectedPresentation?.courierCode || "",
        companyName: reclassifiesAccountOrder
          ? incoming.identity.companyName
          : preservesExistingProjection || !nextProjection
          ? current.identity.companyName
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
  return observeQualifiedAutomaticShipment(
    current,
    incoming,
    automaticSource,
    now,
  );
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
  if (incomingTimeline.provider.trim().toLowerCase() === "kuaidi100_h5") {
    if (!isVerifiedKuaidi100Timeline(incomingTimeline)) return current;
    const incomingCarrier = resolveCarrierQuery(incomingTimeline.courierCode);
    const incomingWaybill = normalizeWaybill(incomingTimeline.waybill);
    manuals = manuals.filter((timeline) =>
      timeline.provider.trim().toLowerCase() !== "kuaidi100_h5" ||
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
  let manuals = manualTimelines(current);
  for (const timeline of [
    ...(incoming.manualTimelines || []),
    incoming.timeline,
  ]) {
    manuals = mergeTimelineAuthorities(manuals, timeline);
  }
  const identity = current.identity.manuallyAdded
    ? {
        ...current.identity,
        ...incoming.identity,
        id: current.identity.id,
        bindingSource: current.identity.bindingSource,
        createdAtMs: current.identity.createdAtMs,
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
  const source = sourceTimeline(accountOwner);
  let manuals = manualTimelines(accountOwner);
  const historicalSource = sourceTimeline(historicalOwner);
  const authorities = [
    ...(historicalSource ? [historicalSource] : []),
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
