import type { AppState, BindingSource, Shipment } from "../models";
import { createDiagnosticFlowId, diagnosticErrorDetails, writeDiagnostic } from "./logger";
import { projectionViewportHostAvailable } from "./projection-viewport";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey, saveAlignmentRecords } from "./row-ledger";
import { SCRIPT_BINDING_SOURCE } from "./script-source";
import {
  displayWaybill,
  isShunFengSourceShipment,
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  selectShipmentTimeline,
  signedRefreshFrozen,
  statusAlignmentOutOfStep,
  statusAlignmentReason,
  statusAlignmentTimes,
  statusPackageHeadlineShown,
  type StatusAlignmentReason,
  type StatusAlignmentTimes,
} from "./shipment-policy";
import { isAccountUpdateSummary, normalizeWaybill, shipmentPresentationStatus, timelineLatestTrackAt } from "./status";
import { loadState, peekStateRevision, visibleShipments } from "./storage";
import { replayPendingShipmentNotifications } from "./notifications";
import {
  listRefreshInProgress,
  refreshShipmentById,
  statusAlignmentHasSource,
  subscribeFullRefreshOutcome,
  type FullRefreshOutcome,
} from "./sync";

/**
 * The app host repairs visible mismatches through the existing forced-detail chain after list work settles.
 * Each S/H/D group gets at most three attempts, at the row's ordinary minimum interval; only newer node/status
 * evidence completes it. Unavailable hosts/sources reserve nothing, and signed-frozen rows stay untouched.
 * The shared row ledger retains hidden rows and migrates old start-only records without claiming success.
 * See docs/EXPRESS_HEAD_STATUS_ALIGNMENT_20261002.md, the 2026-10-08 revision.
 */

export type StatusAlignmentRecordStore = Readonly<{
  load: () => Record<string, string>;
  save: (records: Record<string, string>) => void;
}>;

const ledgerRecordStore: StatusAlignmentRecordStore = {
  load: loadAlignmentRecords,
  save: saveAlignmentRecords,
};

function rowKey(shipment: Shipment): string {
  return rowLedgerKey(shipment.identity.id);
}

type Times = Readonly<StatusAlignmentTimes>;

function timesKey(times: Times): string {
  return `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`;
}

/** A source may correct a known enum without changing its clock; that does not restore consumed attempts. */
function completionApplies(record: ReturnType<typeof parseAlignmentAttempt>, times: Times): boolean {
  return Boolean(record?.complete && record.completionStatus && record.completionHeadline &&
    (!times.statusSemantic || times.statusSemantic === "UNKNOWN" || times.statusSemantic === record.completionStatus) &&
    (!times.headlineSemantic || times.headlineSemantic === "UNKNOWN" || times.headlineSemantic === record.completionHeadline));
}

export type StatusAlignmentCandidate = Readonly<{
  shipment: Shipment;
  times: Times;
  reason: StatusAlignmentReason;
}>;

/**
 * Visible rows with an unfinished attempt allowance, in list order; one chain visits each row once.
 * Signed-frozen rows are not checked, and temporarily hidden rows keep their ledger.
 */
export function dueStatusAlignments(
  state: AppState,
  now: number,
  records: Readonly<Record<string, string>>,
  excludeIds: ReadonlySet<string> = new Set(),
  includeWaiting = false,
): StatusAlignmentCandidate[] {
  const due: StatusAlignmentCandidate[] = [];
  for (const shipment of visibleShipments(state, now)) {
    if (shipment.timeline.provider === "demo" ||
        shipmentPresentationStatus(shipment).semantic === "CANCELLED") continue;
    if (excludeIds.has(shipment.identity.id) || signedRefreshFrozen(shipment, now)) continue;
    const times = statusAlignmentTimes(shipment, now);
    if (!times || !statusAlignmentOutOfStep(times)) continue;
    const record = parseAlignmentAttempt(records[rowKey(shipment)]);
    if (record?.times === timesKey(times) && (completionApplies(record, times) || record.attempts >= 3 ||
        (!includeWaiting && now - record.lastAttemptAtMs < MANUAL_REFRESH_MIN_INTERVAL_MS))) continue;
    due.push({ shipment, times, reason: statusAlignmentReason(times) });
  }
  return due;
}

/** The alignment line's details for one row (its own flow). */
function alignmentDiagnosticDetails(candidate: StatusAlignmentCandidate) {
  const waybill = normalizeWaybill(displayWaybill(candidate.shipment));
  return {
    flowId: createDiagnosticFlowId("alignment"),
    source: SCRIPT_BINDING_SOURCE,
    trigger: "status_alignment",
    alignmentReason: candidate.reason,
    statusEventAtMs: candidate.times.statusAtMs,
    headlineAtMs: candidate.times.headlineAtMs,
    detailAtMs: candidate.times.detailAtMs,
    headlineAligned: statusPackageHeadlineShown(candidate.shipment),
    waybillTail: waybill.length > 4 ? waybill.slice(-4) : "",
    automatic: !candidate.shipment.identity.manuallyAdded,
    sourceProvider: String(candidate.shipment.identity.sourceProvider || "").trim().toLowerCase(),
    carrierCode: String(candidate.shipment.identity.courierCode || "").trim().toUpperCase(),
    statusSemantic: shipmentPresentationStatus(candidate.shipment).semantic,
  };
}

export type StatusAlignmentPassResult = Readonly<{
  result: "not_app_host" | "inactive" | "busy" | "nothing_due" | "attempted" | "failed";
  shipmentId?: string;
  /** Another row not excluded was due as well. */
  moreDue: boolean;
  /** The state after this pass's refresh (attempted only). */
  state?: AppState;
  retryPending?: boolean;
}>;

export type StatusAlignmentPassDependencies = Readonly<{
  appHost: () => boolean;
  busy: (source: BindingSource) => boolean;
  load: (now: number) => AppState;
  records: StatusAlignmentRecordStore;
  refresh: (shipmentId: string, beforeQuery: () => void) => Promise<{ state: AppState }>;
  now: () => number;
  canAsk: (shipment: Shipment) => boolean;
}>;

const defaultPassDependencies: StatusAlignmentPassDependencies = {
  appHost: projectionViewportHostAvailable,
  busy: listRefreshInProgress,
  load: loadState,
  records: ledgerRecordStore,
  refresh: (shipmentId, beforeQuery) => refreshShipmentById(shipmentId, {
    trigger: "status_alignment",
    beforeQuery,
    // The same options as the detail page's pull; the flow opens the gates the alignment run passes.
    forceAccountOrderProjection: true,
    forceManualRefresh: true,
    includeKdniaoFallback: true,
  }),
  now: Date.now,
  canAsk: statusAlignmentHasSource,
};

/** Keep the existing watch alive during the interval, including retries left by an earlier row in the chain. */
function pendingAlignmentRetry(state: AppState, now: number, records: Record<string, string>,
  canAsk: StatusAlignmentPassDependencies["canAsk"]): boolean {
  return dueStatusAlignments(state, now, records, new Set(), true).some(candidate => {
    const record = parseAlignmentAttempt(records[rowKey(candidate.shipment)]);
    return record?.times === timesKey(candidate.times) && record.attempts > 0 && canAsk(candidate.shipment);
  });
}

/** A new capture timestamp alone is not newer logistics evidence. */
function newerAlignmentEvidence(before: Shipment, after: Shipment | undefined): boolean {
  if (!after) return false;
  const packages = (shipment: Shipment) => {
    const slots = [shipment.sourceTimeline, ...shipment.manualTimelines || []]
      .filter((timeline): timeline is NonNullable<typeof timeline> => Boolean(timeline));
    return (slots.length ? slots : [shipment.timeline]).map(timeline => ({ ...timeline,
      tracks: timeline.tracks.filter(track => !isAccountUpdateSummary(track.detail)) }));
  };
  const previous = new Map(packages(before).map(timeline => [timeline.provider, timeline]));
  return packages(after).some(timeline => {
    const old = previous.get(timeline.provider);
    return timelineLatestTrackAt(timeline) > (old ? timelineLatestTrackAt(old) : 0) ||
      (timeline.structuredStatus === true && timeline.semantic !== "UNKNOWN" &&
        (timeline.statusEventAtMs || 0) > (old?.structuredStatus ? old.statusEventAtMs || 0 : 0));
  });
}

/** One check of the stored list and, when a row is due, its one forced refresh. */
export async function runStatusAlignmentPass(
  options: Readonly<{ isActive?: () => boolean; excludeIds?: ReadonlySet<string> }> = {},
  overrides: Partial<StatusAlignmentPassDependencies> = {},
): Promise<StatusAlignmentPassResult> {
  const dependencies = { ...defaultPassDependencies, ...overrides };
  if (!dependencies.appHost()) return { result: "not_app_host", moreDue: false };
  if (options.isActive && !options.isActive()) return { result: "inactive", moreDue: false };
  if (dependencies.busy(SCRIPT_BINDING_SOURCE)) return { result: "busy", moreDue: false };
  const now = dependencies.now();
  const records = dependencies.records.load();
  const state = dependencies.load(now);
  const due = dueStatusAlignments(state, now, records, options.excludeIds);
  const target = due.find(candidate => dependencies.canAsk(candidate.shipment));
  if (!target) return { result: "nothing_due", moreDue: false,
    retryPending: pendingAlignmentRetry(state, now, records, dependencies.canAsk) };
  const key = rowKey(target.shipment), times = timesKey(target.times);
  let attempt: NonNullable<ReturnType<typeof parseAlignmentAttempt>> | undefined;
  let reservationError: unknown;
  const beforeQuery = () => {
    if (reservationError) throw reservationError;
    if (attempt) return;
    try {
      const current = dependencies.records.load();
      const old = parseAlignmentAttempt(current[key]);
      const startedAtMs = dependencies.now();
      if (old?.times === times && (completionApplies(old, target.times) || old.attempts >= 3 ||
          startedAtMs - old.lastAttemptAtMs < MANUAL_REFRESH_MIN_INTERVAL_MS)) {
        throw new Error("Alignment attempt is no longer due");
      }
      const reserved = { times, attempts: (old?.times === times ? old.attempts : 0) + 1,
        lastAttemptAtMs: startedAtMs, complete: false, finished: false };
      current[key] = JSON.stringify(reserved);
      dependencies.records.save(current);
      attempt = reserved;
    } catch (error) {
      reservationError = error;
      throw error;
    }
  };
  const finish = (state?: AppState) => {
    if (!attempt) return;
    const current = dependencies.records.load();
    const reserved = parseAlignmentAttempt(current[key]);
    if (reserved?.lastAttemptAtMs !== attempt.lastAttemptAtMs || reserved.times !== times ||
        reserved.attempts !== attempt.attempts) return;
    const after = state?.shipments.find(shipment => shipment.identity.id === target.shipment.identity.id);
    const complete = newerAlignmentEvidence(target.shipment, after);
    const snapshot = complete && after ? statusAlignmentTimes(after, now) : null;
    current[key] = JSON.stringify({ ...attempt, finished: true,
      complete,
      ...(snapshot ? { completionStatus: snapshot.statusSemantic || "UNKNOWN",
        completionHeadline: snapshot.headlineSemantic || "UNKNOWN" } : {}) });
    dependencies.records.save(current);
  };
  const details = alignmentDiagnosticDetails(target);
  const flowId = details.flowId;
  writeDiagnostic("detail.refresh.alignment", { ...details, candidateCount: due.length });
  let refreshedState: AppState;
  let refreshFailed = false;
  let refreshError: unknown;
  try {
    refreshedState = (await dependencies.refresh(target.shipment.identity.id, beforeQuery)).state;
  } catch (error) {
    refreshFailed = true;
    refreshError = error;
    refreshedState = dependencies.load(now);
  }
  // Source flows may turn a transport exception into an unchanged result; a failed reservation still fails this pass.
  if (reservationError) throw reservationError;
  if (!attempt) {
    const current = dependencies.records.load();
    const blocked = dueStatusAlignments(refreshedState, now, current, new Set(), true).some(candidate =>
      candidate.shipment.identity.id === target.shipment.identity.id && dependencies.canAsk(candidate.shipment));
    return { result: "nothing_due", shipmentId: target.shipment.identity.id, moreDue: due.length > 1,
      retryPending: blocked || pendingAlignmentRetry(refreshedState, now, current, dependencies.canAsk) };
  }
  finish(refreshedState);
  const signedTarget = refreshedState.shipments.find(shipment => shipment.identity.id === target.shipment.identity.id);
  if (signedTarget && isShunFengSourceShipment(signedTarget) &&
      shipmentPresentationStatus(signedTarget).semantic === "COMPLETED" &&
      refreshedState.pendingNotifications?.some(event => event.shipmentId === signedTarget.identity.id &&
        event.semantic === "COMPLETED" && !event.awaitingCarrier)) {
    // The existing finished attempt unlocks SF's final coarse fallback even without newer evidence.
    // Keep its queued signing until the unified presentation has a same-state headline.
    refreshedState = await replayPendingShipmentNotifications(() => !options.isActive || options.isActive(), {
      alignedShipmentId: signedTarget.identity.id,
    }) ?? refreshedState;
  }
  if (refreshFailed) {
    // The refresh flow records its own failure; this line closes the alignment flow.
    writeDiagnostic("detail.refresh.alignment", {
      flowId,
      source: SCRIPT_BINDING_SOURCE,
      trigger: "status_alignment",
      result: "failed",
      ...diagnosticErrorDetails(refreshError),
    }, "warning");
    return { result: "failed", shipmentId: target.shipment.identity.id, moreDue: due.length > 1,
      retryPending: pendingAlignmentRetry(refreshedState, now, dependencies.records.load(), dependencies.canAsk) };
  }
  return { result: "attempted", shipmentId: target.shipment.identity.id, moreDue: due.length > 1,
    retryPending: pendingAlignmentRetry(refreshedState, now, dependencies.records.load(), dependencies.canAsk),
    state: { ...refreshedState, shipments: refreshedState.shipments.map(shipment =>
      shipment.identity.id === target.shipment.identity.id
        ? { ...shipment, timeline: selectShipmentTimeline(shipment) } : shipment) } };
}

export type ScenePhase = "active" | "inactive" | "background";

/** How often, while on screen, the persisted revision is read (the foreground order projection's interval). */
export const STATUS_ALIGNMENT_WATCH_INTERVAL_MS = 3_000;

export type StatusAlignmentControllerDependencies = Readonly<{
  runPass: (options: Readonly<{
    isActive: () => boolean;
    excludeIds: ReadonlySet<string>;
  }>) => Promise<StatusAlignmentPassResult>;
  subscribeRefreshOutcome: (listener: (outcome: FullRefreshOutcome) => void) => () => void;
  peekRevision: () => number;
  applyState: (state: AppState) => void;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (handle: unknown) => void;
  watchIntervalMs?: number;
}>;

export type StatusAlignmentController = Readonly<{
  scenePhaseChanged: (phase: ScenePhase) => void;
  stop: () => void;
}>;

/**
 * The app root's check: after this runtime's sync round ends, on return to the foreground, and when the persisted
 * revision moves while on screen (another runtime's round, a detail refresh commit). One chain forces at most one row
 * at a time and each row once. Its own commits do not start another chain; unfinished attempts wait for the row
 * interval. A check that found the list still being written retries on the next tick.
 */
export function createStatusAlignment(
  dependencies: StatusAlignmentControllerDependencies,
): StatusAlignmentController {
  const watchIntervalMs = dependencies.watchIntervalMs ?? STATUS_ALIGNMENT_WATCH_INTERVAL_MS;
  let active = true;
  let stopped = false;
  let scheduled = false;
  let running = false;
  let rerun = false;
  let retryWhenSettled = false;
  let watchTimer: unknown = null;
  const onScreen = () => active && !stopped;
  const peek = () => {
    try { return dependencies.peekRevision(); } catch { return 0; }
  };
  let seenRevision = peek();

  function request(): void {
    if (!onScreen() || scheduled) return;
    if (running) {
      rerun = true;
      return;
    }
    scheduled = true;
    // Never inside the caller's stack: a refresh publishing its outcome finishes first.
    dependencies.setTimer(() => {
      scheduled = false;
      running = true;
      void runChain();
    }, 0);
  }

  async function runChain(): Promise<void> {
    const forced = new Set<string>();
    try {
      while (onScreen()) {
        const outcome = await dependencies.runPass({ isActive: onScreen, excludeIds: forced });
        if (outcome.state) dependencies.applyState(outcome.state);
        retryWhenSettled = outcome.result === "busy" || outcome.retryPending === true;
        if (!outcome.shipmentId) break;
        forced.add(outcome.shipmentId);
        if (!outcome.moreDue) break;
        // A macrotask between rows lets a pull that queued behind this run go first.
        await new Promise<void>((resolve) => { dependencies.setTimer(resolve, 0); });
      }
    } catch {
      // Storage recovery must re-read the durable allowance even when no business revision changes.
      retryWhenSettled = true;
    } finally {
      running = false;
      seenRevision = peek();
      if (rerun) {
        rerun = false;
        request();
      }
    }
  }

  function watch(): void {
    watchTimer = null;
    if (!onScreen()) return;
    if (!running && !scheduled) {
      const revision = peek();
      if (revision > seenRevision || retryWhenSettled) {
        seenRevision = Math.max(seenRevision, revision);
        request();
      } else if (revision > 0 && revision < seenRevision) {
        seenRevision = revision;
      }
    }
    watchTimer = dependencies.setTimer(watch, watchIntervalMs);
  }

  function startWatching(): void {
    if (watchTimer == null && onScreen()) {
      watchTimer = dependencies.setTimer(watch, watchIntervalMs);
    }
  }

  function stopWatching(): void {
    if (watchTimer == null) return;
    dependencies.clearTimer(watchTimer);
    watchTimer = null;
  }

  const unsubscribe = dependencies.subscribeRefreshOutcome(() => request());
  startWatching();

  return {
    scenePhaseChanged(phase) {
      if (stopped) return;
      active = phase === "active";
      if (!active) {
        stopWatching();
        return;
      }
      startWatching();
      request();
    },
    stop() {
      stopped = true;
      stopWatching();
      unsubscribe();
    },
  };
}

/** The app root's wiring; widget and App Intent entry points never import this module. */
export function startStatusAlignment(
  host: Readonly<{ applyState: (state: AppState) => void }>,
): StatusAlignmentController {
  return createStatusAlignment({
    runPass: (options) => runStatusAlignmentPass(options),
    subscribeRefreshOutcome: subscribeFullRefreshOutcome,
    peekRevision: peekStateRevision,
    applyState: host.applyState,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
}
