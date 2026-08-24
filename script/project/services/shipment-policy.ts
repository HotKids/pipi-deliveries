import type { Shipment, TimelinePackage } from "../models";
import {
  accountOrderSemantic,
  mergeTracks,
  mergeTimelineAuthorities,
  mergeTimelinePackage,
  normalizeWaybill,
  normalizedProjectedWaybill,
  selectTimelineAuthority,
  shouldRefreshShipment,
  timedTracks,
} from "./status";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";

export const MANUAL_REFRESH_MIN_INTERVAL_MS = 30_000;
import { SCRIPT_BINDING_SOURCE } from "./script-source";
import { projectedCarrierPresentation } from "./carrier-presentation";

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

export function manualTimelineOwnsShipment(shipment: Shipment): boolean {
  return !sourceTimelineOwnsShipment(shipment) && manualTimelines(shipment).some(
    (timeline) => timedTracks(timeline.tracks).length > 0,
  );
}

export function prefersKuaidi100First(shipment: Shipment | undefined): boolean {
  return Boolean(
    shipment &&
    shipment.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
    String(shipment.identity.sourceProvider || "").trim().toLowerCase() ===
      "shunfeng",
  );
}

/**
 * Interface 5 owns automatic shipment presentation when it returned a timed
 * timeline. ShunFeng is the one exception because its complete state is
 * supplied by the existing manual/K100 path.
 */
export function sourceTimelineOwnsShipment(shipment: Shipment): boolean {
  const source = sourceTimeline(shipment);
  return Boolean(
    !shipment.identity.manuallyAdded &&
    shipment.identity.bindingSource === SCRIPT_BINDING_SOURCE &&
    !prefersKuaidi100First(shipment) &&
    EXPRESS_POLICY.orders.preferTimedSource &&
    source?.provider.trim().toLowerCase() === SCRIPT_BINDING_SOURCE &&
    timedTracks(source.tracks).length > 0,
  );
}

function sourceWithCompletedHistory(
  source: TimelinePackage,
  manuals: readonly TimelinePackage[],
): TimelinePackage {
  if (source.semantic !== "COMPLETED") return source;
  const waybill = normalizeWaybill(source.waybill);
  if (!waybill) return source;
  let tracks = source.tracks;
  for (const manual of manuals) {
    if (
      normalizeWaybill(manual.waybill) !== waybill ||
      timedTracks(manual.tracks).length === 0
    ) {
      continue;
    }
    // The selected source still owns status and duplicate presentation; the
    // sidecar contributes only historical nodes that the final response omitted.
    tracks = mergeTracks(manual.tracks, tracks);
  }
  return tracks === source.tracks ? source : { ...source, tracks };
}

export function selectShipmentTimeline(shipment: Shipment): TimelinePackage {
  const source = sourceTimeline(shipment);
  const manuals = manualTimelines(shipment);
  let selected: TimelinePackage;
  if (sourceTimelineOwnsShipment({
    ...shipment,
    sourceTimeline: source,
    manualTimelines: manuals,
  })) {
    selected = sourceWithCompletedHistory(source as TimelinePackage, manuals);
  } else if (source && unprojectedAccountOrder(shipment)) {
    selected = {
      ...source,
      semantic: accountOrderSemantic(source.latestDetail),
    };
  } else {
    selected = selectTimelineAuthority(source, manuals) || shipment.timeline;
  }
  return applyForcedCompletion(shipment, selected);
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

/** A ShunFeng source summary cannot stop polling before a complete manual package exists. */
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
  if (prefersKuaidi100First(shipment)) {
    const manual = selectTimelineAuthority(null, manualTimelines(shipment));
    if (
      manual?.semantic === "COMPLETED" &&
      timedTracks(manual.tracks).length > 0
    ) {
      return false;
    }
    return true;
  }
  return shipment.timeline.semantic !== "COMPLETED"
    && shouldRefreshShipment(shipment, now);
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
  const merged = applyAccountShipment(current, incoming, now);
  if (merged.identity.id !== current.identity.id) {
    throw new Error("返回的物流信息与当前运单不符，请稍后重试");
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

export function applyAccountShipment(
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
  const mergedSource = mergeTimelinePackage(currentSource, incomingSource);
  const manuals = current ? manualTimelines(current) : [];
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
  const mergedIdentity = current
    ? {
        ...current.identity,
        ...incoming.identity,
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
        courierCode: preservesExistingProjection || !nextProjection
          ? current.identity.courierCode
          : projectedPresentation?.courierCode || "",
        companyName: preservesExistingProjection || !nextProjection
          ? current.identity.companyName
          : projectedPresentation?.companyName || "快递",
        sourceProvider: current.identity.sourceProvider ||
          incoming.identity.sourceProvider,
      }
    : mergedIdentity;
  const candidate: Shipment = {
    ...incoming,
    identity,
    timeline: mergedSource,
    sourceTimeline: mergedSource,
    manualTimelines: manuals,
    forcedCompletedAtMs:
      current?.forcedCompletedAtMs ?? incoming.forcedCompletedAtMs,
    manualRefreshAttemptAtMs:
      current?.manualRefreshAttemptAtMs ?? incoming.manualRefreshAttemptAtMs,
    manualRefreshLease:
      current?.manualRefreshLease ?? incoming.manualRefreshLease,
    route: current?.identity.accountOrder
      ? current.route || null
      : incoming.route || current?.route || null,
    accountRecord:
      incoming.accountRecord == null
        ? current?.accountRecord
        : incoming.accountRecord,
    updatedAtMs: now,
  };
  return { ...candidate, timeline: selectShipmentTimeline(candidate) };
}

export function applyManualShipment(
  current: Shipment | undefined,
  incoming: Shipment,
  now: number,
): Shipment {
  if (!current) {
    const manuals = mergeTimelineAuthorities([], incoming.timeline);
    return {
      ...incoming,
      timeline: selectTimelineAuthority(null, manuals) || incoming.timeline,
      sourceTimeline: null,
      manualTimelines: manuals,
      updatedAtMs: now,
    };
  }
  const source = sourceTimeline(current);
  const manuals = mergeTimelineAuthorities(
    manualTimelines(current),
    incoming.timeline,
  );
  const identity = current.identity.manuallyAdded
    ? {
        ...current.identity,
        ...incoming.identity,
        id: current.identity.id,
        bindingSource: current.identity.bindingSource,
        createdAtMs: current.identity.createdAtMs,
      }
    : current.identity;
  const candidate: Shipment = {
    ...current,
    identity,
    timeline: source || incoming.timeline,
    sourceTimeline: source,
    manualTimelines: manuals,
    forcedCompletedAtMs:
      current.forcedCompletedAtMs ?? incoming.forcedCompletedAtMs,
    updatedAtMs: now,
  };
  return { ...candidate, timeline: selectShipmentTimeline(candidate) };
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
  return { ...candidate, timeline: selectShipmentTimeline(candidate) };
}
