/** Manual & Online/Moto/KDNiao refresh tasks, SF background alignment, and manual preview submission/continuation. */
import type { AbortSignal } from "scripting";
import { withSharedFileTransaction } from "../shared-file-transaction";
import { normalizeTimelineSlot, TIMELINE_SLOT } from "../timeline-slot";
import type { AppState, BindingSource, PendingManualQuery, RefreshSummary, Shipment } from "../../models";
import { manualProviderSchedule, queryManualForSource, type ManualCarrierDetection, type ManualQueryOutcome, type ManualSourceDependencies } from "../manual-query";
import { committedPendingPromotionShipmentId } from "../pending-promotion";
import { loadShipmentRoute, saveShipmentRoute } from "../routes";
import { applyManualShipment, beginManualRefreshAttempt, displayWaybill, MANUAL_REFRESH_MIN_INTERVAL_MS, forcedCompletedAt, hasPickerTimelineStart, hasTimelineStartBeforeKdniao, isShunFengSourceShipment, isHomeAccountQuerySource, ownsManualRefreshLease, releaseManualRefreshLease, shipmentSelectionEvidence, shipmentHeadlineMatchesStatus, shipmentDetailComplete, shouldRefreshShipmentRow, shouldScheduleManualRefresh, manualPullHistoryIncomplete, refreshGateView, signedRefreshFrozen, statusAlignmentOutOfStep, statusAlignmentTimes, type StatusAlignmentTimes, unprojectedAccountOrder } from "../shipment-policy";
import { bindingsForSource, commitRefreshState, commitRoutePointers, loadState, pruneRoutesForState as safelyPruneRoutes, saveState } from "../storage";
import { normalizeWaybill, shipmentPresentationStatus, sortShipments, timedTracks } from "../status";
import { acquireRenewingDurableRefreshLease, beginRuntimeManualRefreshAttempt, ownsRuntimeManualRefreshAttempt, refreshProviderDue, refreshProviderCooldownDetails, releaseRuntimeManualRefreshAttempt } from "../refresh-runtime-state";
import { requestWidgetReload } from "../widgets";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey, type AlignmentAttempt } from "../row-ledger";
import { alignmentAttemptDue, alignmentOwnerCurrent, alignmentTimesKey, reserveAlignmentAttempt, finishAlignmentAttempt, newerAlignmentEvidence, publishAlignmentPresentation } from "../status-alignment-state";
import { assertWithinDeadline, deadlineAfter, deadlineExpired } from "../deadline";
import { accountChildDeadline, oldestBatchIndices } from "../account-sync-policy";
import { pendingManualPreviewShipment, prepareManualPreview } from "../manual-preview";
import { applyRecognizedPickup } from "../parcel-pickup";
import type { ParcelLookup } from "../parcel-code-ocr";
import { createDiagnosticFlowId, diagnosticErrorDetails, openStageCancellationEnd, writeDiagnostic } from "../logger";
import { requireScriptSource } from "../script-source";
import { CarrierRecognitionBudget } from "../carrier-recognition";
import { needsManualPhoneTail } from "../jt-h5";
import { runManualDetailSourceContest } from "../manual-detail-refresh";
import {
  assertRefreshSignal,
  commitCheckpoint,
  homeAccountQueryEligible,
  MANUAL_QUERY_BUDGET_MS,
  MANUAL_REFRESH_TASK_BUDGET_MS,
  recognizeAwaitingCarrier,
  rejectForeignManualResult,
  replaceById,
  rethrowStageCancellation,
  shipmentDiagnosticDetails,
  stageBudgetMs,
  withRuntimeManualRefreshAttempt,
  type DeferredRouteMutations,
  type ManualRefreshTask,
  type RefreshCheckpoint,
  type ShipmentRefreshResult,
  type SyncRuntimeState,
} from "./shared";
import {
  adoptPendingRoute,
  deferIncomingRoute,
  deferPendingRoute,
  pendingGenerationVersion,
  publishDeferredRoutes,
  safelyRemoveRoutes,
} from "./route-publications";
import { refreshWebTimeline } from "./h5-capture";

/** The signed background exception is Online-only; the foreground retains its complete source chain. */
export function backgroundSfAlignmentTimes(shipment: Shipment, now: number): StatusAlignmentTimes | null {
  if (shipment.identity.manuallyAdded || !isShunFengSourceShipment(shipment) ||
      shipment.timeline.provider === "demo" || forcedCompletedAt(shipment) || signedRefreshFrozen(shipment, now) ||
      shipmentHeadlineMatchesStatus(shipment)) return null;
  const times = statusAlignmentTimes(shipment, now);
  if (!times || times.statusSemantic !== "COMPLETED" || !statusAlignmentOutOfStep(times)) return null;
  const record = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(shipment.identity.id)]);
  return alignmentAttemptDue(record, times, now, MANUAL_REFRESH_MIN_INTERVAL_MS) ? times : null;
}

export function manualRefreshTasks(
  state: AppState, source: BindingSource, now: number,
  skipRefreshIds: ReadonlySet<string>, forceManualRefresh: boolean,
  accountSourceFollowup = false,
  cainiaoFollowupIds: ReadonlySet<string> = new Set(),
  /** A Home follow-up the signed freeze stopped (its list did update), for the round's skip line. */
  onSignedFrozen?: (shipment: Shipment) => void,
  backgroundStatusAlignment = false,
  cainiaoListUpdatedIds: ReadonlySet<string> = cainiaoFollowupIds,
): ManualRefreshTask[] {
  const homeFollowup = (current: Shipment): boolean => {
    if (!homeAccountQueryEligible(current, cainiaoFollowupIds.has(current.identity.id))) return false;
    if (!signedRefreshFrozen(current, now)) return true;
    if (cainiaoListUpdatedIds.has(current.identity.id)) onSignedFrozen?.(current);
    return false;
  };
  // Scheduled, background and Home-pull per-row work: a row at the signed freeze is never queued (用户 2026-10-02
  // 「头条 状态 详情页 都推进到了签收状态…就冻结快递 后续不再进行任何刷新」); a right-swipe signed row inside its refresh
  // window is judged by its own status (shouldRefreshShipmentRow / refreshGateView). These rows were already left out
  // by the terminal freeze before, so no skip line is written for them each round.
  const tasks = state.shipments.filter(current =>
    current.identity.bindingSource === source && !skipRefreshIds.has(current.identity.id) && (
      accountSourceFollowup && isHomeAccountQuerySource(current)
        ? homeFollowup(current)
        : (backgroundStatusAlignment && Boolean(backgroundSfAlignmentTimes(current, now))) ||
          (!unprojectedAccountOrder(current) && current.timeline.provider !== "demo" &&
          shouldRefreshShipmentRow(current, now) &&
          shipmentPresentationStatus(refreshGateView(current, now)).semantic !== "CANCELLED" &&
          shouldScheduleManualRefresh(withRuntimeManualRefreshAttempt(current, now), now))
    )
  ).map(current => {
    const effective = withRuntimeManualRefreshAttempt(current, now);
    return {
      id: current.identity.id,
      lastAttemptAtMs: Number(effective.manualRefreshAttemptAtMs) || 0,
      accountDetail: accountSourceFollowup && isHomeAccountQuerySource(current),
      backgroundAlignment: backgroundStatusAlignment && Boolean(backgroundSfAlignmentTimes(current, now)),
      cainiaoFollowup: cainiaoFollowupIds.has(current.identity.id),
      cainiaoListUpdated: cainiaoListUpdatedIds.has(current.identity.id),
    };
  });
  return oldestBatchIndices(tasks.map(task => task.lastAttemptAtMs), tasks.length, state.revision)
    .map(position => tasks[position]);
}

export async function refreshBackgroundSfAlignment(
  runtimeState: SyncRuntimeState,
  state: AppState, source: BindingSource, flowId: string, checkpoint: RefreshCheckpoint,
  task: ManualRefreshTask, deadlineAtMs: number | undefined, signal: AbortSignal,
  query: typeof queryManualForSource,
  /** C1: called once this task is past its cooldown and lease gates, right before it queries. */
  onQueryStarted: () => void = () => {},
): Promise<RefreshSummary> {
  let current = loadState(), attempted = 0, succeeded = 0, failed = 0;
  const summary = (): RefreshSummary => ({ state: current, attempted, succeeded, failed, promotedPendingShipmentIds: [] });
  const original = state.shipments.find(item => item.identity.id === task.id);
  if (!original || !alignmentOwnerCurrent(state, original, current) || signal.aborted || deadlineExpired(deadlineAtMs)) return summary();
  const times = backgroundSfAlignmentTimes(original, Date.now());
  if (!times) return summary();
  const schedule = manualProviderSchedule({ source, waybill: displayWaybill(original),
    rawCourierCode: original.identity.rawCourierCode, phoneTail: original.identity.phoneTail,
    sourceProvider: original.identity.sourceProvider });
  if (!refreshProviderDue(schedule.key, "picker", schedule.identityFingerprint)) return summary();
  const lease = acquireRenewingDurableRefreshLease(`detail:${task.id}`, 35_000);
  if (!lease) return summary();
  onQueryStarted();
  let attempt: AlignmentAttempt | undefined, reservationError: unknown;
  const staleReservation = new Error("Alignment owner or group changed");
  const isCurrent = () => !signal.aborted && lease.isCurrent();
  const beforeQuery = () => {
    if (reservationError) throw reservationError;
    if (attempt) return;
    try {
      assertRefreshSignal(signal);
      assertWithinDeadline(deadlineAtMs);
      const latest = loadState(), target = latest.shipments.find(item => item.identity.id === task.id);
      if (!lease.isCurrent() || !alignmentOwnerCurrent(state, original, latest) || !target) throw staleReservation;
      const fresh = backgroundSfAlignmentTimes(target, Date.now());
      if (!fresh || alignmentTimesKey(fresh) !== alignmentTimesKey(times)) throw staleReservation;
      attempt = reserveAlignmentAttempt(task.id, times, Date.now(), MANUAL_REFRESH_MIN_INTERVAL_MS);
    } catch (error) { reservationError = error; throw error; }
  };
  try {
    writeDiagnostic("detail.refresh.alignment", { flowId, source, trigger: "status_alignment",
      ...shipmentDiagnosticDetails(original), statusEventAtMs: times.statusAtMs,
      headlineAtMs: times.headlineAtMs, detailAtMs: times.detailAtMs });
    let outcome: ManualQueryOutcome | undefined, queryError: unknown;
    try {
      outcome = await query({ source, bindings: bindingsForSource(current, source),
        waybill: displayWaybill(original), phoneTail: original.identity.phoneTail,
        rawCourierCode: original.identity.rawCourierCode, courierCode: original.identity.courierCode,
        companyName: original.identity.companyName, sourceProvider: original.identity.sourceProvider,
        deadlineAtMs: accountChildDeadline(deadlineAtMs, MANUAL_REFRESH_TASK_BUDGET_MS), signal,
        diagnosticFlowId: flowId, diagnosticStage: "status_alignment", currentShipment: original,
        pickerOnly: true, pickerFirst: true, scheduled: true, hostSafe: true,
        includeKdniaoFallback: false, beforeQuery });
    } catch (error) { queryError = error; }
    assertRefreshSignal(signal);
    // A queued row can become obsolete before dispatch without cancelling unrelated rows in this batch.
    if (reservationError === staleReservation) {
      current = loadState();
      return summary();
    }
    if (reservationError) throw reservationError;
    if (!isCurrent() || !attempt) return summary();
    attempted = 1;
    current = loadState();
    const target = current.shipments.find(item => item.identity.id === task.id);
    if (!target || !alignmentOwnerCurrent(state, original, current)) return summary();
    const incoming = rejectForeignManualResult(target, outcome?.shipment ?? null, {
      flowId, source, stage: "status_alignment", timelineProvider: TIMELINE_SLOT.V6_QUERY,
    });
    if (incoming && timedTracks(incoming.timeline.tracks).length) {
      const mutations: DeferredRouteMutations = new Map();
      const merged = deferIncomingRoute(applyManualShipment(target, incoming, Date.now()),
        incoming, outcome?.routeUrl || "", Date.now(), mutations);
      current = await commitCheckpoint(checkpoint, { ...current, shipments: sortShipments(replaceById(current.shipments, merged)) },
        mutations, "status_alignment", current);
      succeeded = 1;
    } else failed = 1;
    assertRefreshSignal(signal);
    if (!isCurrent()) return summary();
    const after = current.shipments.find(item => item.identity.id === task.id);
    const complete = newerAlignmentEvidence(original, after);
    if (finishAlignmentAttempt(task.id, attempt, complete,
      complete && after ? statusAlignmentTimes(after) : null)) {
      const published = publishAlignmentPresentation(state, original, attempt, Date.now(), isCurrent);
      if (published) {
        current = published;
        runtimeState.publishRefreshState(current);
        requestWidgetReload();
      }
    }
    writeDiagnostic("detail.refresh.alignment", { flowId, source, trigger: "status_alignment",
      ...shipmentDiagnosticDetails(current.shipments.find(item => item.identity.id === task.id) || original),
      result: failed ? "failed" : "completed", ...(queryError ? diagnosticErrorDetails(queryError) : {}) },
      failed ? "warning" : "info");
    return summary();
  } finally { lease.release(); }
}

/** Explicit Home refresh retains Online even when background polling follows a paid history package. */
export function manualBackgroundProvider(
  shipment: Shipment,
  backgroundHostSafe: boolean,
): typeof TIMELINE_SLOT.V4_QUERY | typeof TIMELINE_SLOT.V6_QUERY | typeof TIMELINE_SLOT.KDNIAO {
  if (!shipment.identity.manuallyAdded) return TIMELINE_SLOT.V6_QUERY;
  const listed = normalizeTimelineSlot(shipmentSelectionEvidence(shipment).historyProvider);
  // The October 19 paid-refresh approval applies only to background hosts and the actual list selection.
  if (backgroundHostSafe && listed === TIMELINE_SLOT.KDNIAO) return TIMELINE_SLOT.KDNIAO;
  return listed === TIMELINE_SLOT.V4_QUERY ? TIMELINE_SLOT.V4_QUERY : TIMELINE_SLOT.V6_QUERY;
}

export async function refreshOnlineShipment(
  state: AppState, source: BindingSource, flowId: string, checkpoint: RefreshCheckpoint,
  task: ManualRefreshTask, deadlineAtMs: number | undefined, forceManualRefresh: boolean,
  signal: AbortSignal, query: typeof queryManualForSource,
  recognitionBudget?: CarrierRecognitionBudget,
  backgroundHostSafe = false,
  /** C1: called once this task is past its cooldown and lease gates, right before it queries. */
  onQueryStarted: () => void = () => {},
): Promise<RefreshSummary> {
  let currentState = state;
  let attempted = 0, succeeded = 0, failed = 0;
  const summary = () => ({ state: currentState, attempted, succeeded, failed, promotedPendingShipmentIds: [] });
  let current = currentState.shipments.find(item => item.identity.id === task.id);
  if (!current || !manualRefreshTasks(currentState, source, Date.now(), new Set(), forceManualRefresh)
    .some(item => item.id === task.id) || deadlineExpired(deadlineAtMs)) return summary();
  let schedule = manualProviderSchedule({ source, waybill: displayWaybill(current),
    rawCourierCode: current.identity.rawCourierCode, phoneTail: current.identity.phoneTail,
    sourceProvider: current.identity.sourceProvider });
  const provider = manualBackgroundProvider(current, backgroundHostSafe && !forceManualRefresh);
  const moto = provider === TIMELINE_SLOT.V4_QUERY;
  const paid = provider === TIMELINE_SLOT.KDNIAO;
  const scheduleProvider = moto ? "moto" : paid ? "kdniao" : "picker";
  // Owner 2026-11-10 (item 1) & I-05: a Home list pull obeys the same per-waybill Picker/Moto cooldown as scheduled work;
  // check manual cooldown before carrier recognition so parcels in active manual cooldown skip network carrier detection.
  if ((!forceManualRefresh || !manualPullHistoryIncomplete(current)) &&
      !refreshProviderDue(schedule.key, scheduleProvider, schedule.identityFingerprint)) {
    writeDiagnostic("refresh.stage.skipped", { flowId, source, stage: "manual_refresh",
      ...shipmentDiagnosticDetails(current, provider),
      ...refreshProviderCooldownDetails(schedule.key, scheduleProvider, schedule.identityFingerprint),
      result: "cooldown", skipReason: "cooldown" });
    return summary();
  }
  if (current.identity.manuallyAdded) {
    const recognized = await recognizeAwaitingCarrier(current,
      accountChildDeadline(deadlineAtMs, MANUAL_REFRESH_TASK_BUDGET_MS), signal, recognitionBudget);
    assertRefreshSignal(signal);
    if (recognized !== current) {
      currentState = await commitCheckpoint(checkpoint, { ...currentState,
        shipments: sortShipments(replaceById(currentState.shipments, recognized)) }, new Map(), "manual_carrier");
      current = currentState.shipments.find(item => item.identity.id === task.id);
      if (!current) return summary();
      schedule = manualProviderSchedule({ source, waybill: displayWaybill(current),
        rawCourierCode: current.identity.rawCourierCode, phoneTail: current.identity.phoneTail,
        sourceProvider: current.identity.sourceProvider });
    }
  }
  // A pull's answer is recorded in the provider schedule too (recordSchedule), so the next pull or background round
  // sees it (owner 2026-11-10, item 1).
  const startedAt = Date.now();
  const taskDeadline = accountChildDeadline(deadlineAtMs, MANUAL_REFRESH_TASK_BUDGET_MS, 0, startedAt);
  const attemptId = createDiagnosticFlowId("manual");
  const commit = (shipment: Shipment, mutations: DeferredRouteMutations, stage: string) => {
    assertRefreshSignal(signal);
    currentState = checkpoint({ ...currentState, shipments: sortShipments(replaceById(currentState.shipments, shipment)) },
      mutations, stage);
  };
  const commitAsync = async (shipment: Shipment, mutations: DeferredRouteMutations, stage: string) => {
    assertRefreshSignal(signal);
    currentState = await commitCheckpoint(checkpoint,
      { ...currentState, shipments: sortShipments(replaceById(currentState.shipments, shipment)) },
      mutations, stage);
  };
  let reserved: Shipment | undefined;
  if (checkpoint.transientManualLease) {
    if (!beginRuntimeManualRefreshAttempt(current.identity.id, attemptId, startedAt, taskDeadline) ||
        !ownsRuntimeManualRefreshAttempt(current.identity.id, attemptId, startedAt)) {
      return summary();
    }
    reserved = current;
  } else {
    commit(beginManualRefreshAttempt(current, attemptId, startedAt, taskDeadline), new Map(), "manual_refresh_attempt");
    reserved = currentState.shipments.find(item => item.identity.id === task.id);
    if (!reserved || !ownsManualRefreshLease(reserved, attemptId)) return summary();
  }
  onQueryStarted();
  const release = () => {
    if (checkpoint.transientManualLease) {
      releaseRuntimeManualRefreshAttempt(task.id, attemptId);
      return;
    }
    reserved = currentState.shipments.find(item => item.identity.id === task.id);
    if (reserved && ownsManualRefreshLease(reserved, attemptId)) {
      commit(releaseManualRefreshLease(reserved, attemptId), new Map(), "manual_refresh_release");
    }
  };
  writeDiagnostic("refresh.stage.started", { flowId, source, stage: "manual_refresh",
    budgetMs: stageBudgetMs(taskDeadline, startedAt), ...shipmentDiagnosticDetails(reserved, provider) });
  const stageCancelled = openStageCancellationEnd(flowId, signal, () => writeDiagnostic("refresh.stage.failed", {
    flowId, source, stage: "manual_refresh", ...shipmentDiagnosticDetails(reserved || current, provider),
    durationMs: Date.now() - startedAt, errorCategory: "cancelled" }, "warning"));
  let outcome: Awaited<ReturnType<typeof queryManualForSource>>;
  try {
    outcome = await query({ source, bindings: bindingsForSource(currentState, source),
      waybill: displayWaybill(reserved), phoneTail: reserved.identity.phoneTail,
      rawCourierCode: reserved.identity.rawCourierCode, courierCode: reserved.identity.courierCode,
      companyName: reserved.identity.companyName, sourceProvider: reserved.identity.sourceProvider,
      deadlineAtMs: taskDeadline, signal, diagnosticFlowId: flowId, diagnosticStage: "manual_refresh",
      // Selected paid history is being refreshed directly, not competing with cached free history for fallback.
      currentShipment: paid ? undefined : reserved,
      ...(moto ? { motoOnly: true } : paid ? { fallbackOnly: true }
        : { pickerFirst: true, pickerOnly: true }),
      includeKdniaoFallback: paid, scheduled: !forceManualRefresh, recordSchedule: true, hostSafe: true });
    assertRefreshSignal(signal);
    stageCancelled.close();
  } catch (error) {
    rethrowStageCancellation(signal, stageCancelled.end);
    stageCancelled.close();
    release();
    attempted++; failed++;
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "manual_refresh", ...shipmentDiagnosticDetails(reserved || current, provider),
      durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) }, "warning");
    return summary();
  }
  if (outcome?.skipReason === "cooldown") {
    release();
    writeDiagnostic("refresh.stage.skipped", { flowId, source, stage: "manual_refresh",
      ...shipmentDiagnosticDetails(reserved || current, provider),
      ...refreshProviderCooldownDetails(schedule.key, scheduleProvider, schedule.identityFingerprint),
      result: "cooldown", skipReason: "cooldown" });
    return summary();
  }
  attempted++;
  const mutations: DeferredRouteMutations = new Map();
  if (outcome?.shipment && timedTracks(outcome.shipment.timeline.tracks).length) {
    const merged = deferIncomingRoute(applyManualShipment(reserved, outcome.shipment, Date.now()),
      outcome.shipment, outcome.routeUrl, Date.now(), mutations);
    await commitAsync({ ...releaseManualRefreshLease(merged, attemptId), manualRefreshAttemptAtMs: startedAt },
      mutations, "manual_refresh");
    release();
    succeeded++;
    writeDiagnostic("refresh.stage.succeeded", { flowId, source, stage: "manual_refresh", ...shipmentDiagnosticDetails(reserved || merged, provider, outcome.shipment.timeline), durationMs: Date.now() - startedAt });
  } else {
    if (outcome?.shipment && outcome.routeUrl && isShunFengSourceShipment(reserved)) {
      await commitAsync({
        ...releaseManualRefreshLease(deferIncomingRoute(reserved, outcome.shipment, outcome.routeUrl,
          Date.now(), mutations), attemptId),
        manualRefreshAttemptAtMs: startedAt,
      }, mutations, "manual_refresh_route");
    }
    release(); failed++;
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "manual_refresh", ...shipmentDiagnosticDetails(reserved || current, provider), result: outcome?.result || "no_result",
      durationMs: Date.now() - startedAt, routeCaptured: Boolean(outcome?.routeUrl && isShunFengSourceShipment(reserved)) }, "warning");
  }
  return summary();
}

export type ManualShipmentPreview = {
  shipment: Shipment | null;
  pending: PendingManualQuery | null;
  routeUrl: string;
  hasTimedResult: boolean;
  /** True only after every source required for this manual round has settled. */
  roundComplete?: boolean;
  commitBase?: {
    shipment: Shipment | null;
    pending: PendingManualQuery | null;
  };
};

export async function queryManualShipmentPreview(input: {
  waybill: string;
  phoneTail?: string;
  presentation?: ManualCarrierDetection | null;
  deadlineAtMs?: number;
}, dependencies?: ManualSourceDependencies): Promise<ManualShipmentPreview> {
  const deadlineAtMs = Math.min(deadlineAfter(MANUAL_QUERY_BUDGET_MS), input.deadlineAtMs ?? Infinity);
  assertWithinDeadline(deadlineAtMs);
  const state = loadState();
  const canonicalInput = normalizeWaybill(input.waybill);
  const existingPending = state.pendingQueries.find(
    (pending) =>
      pending.source === state.activeSource &&
      normalizeWaybill(pending.waybill) === canonicalInput,
  );
  const current = state.shipments
    .filter(
      (item) =>
        item.identity.bindingSource === state.activeSource ||
        item.identity.bindingSource == null,
    )
    .sort((left, right) =>
      Number(left.identity.bindingSource == null) -
        Number(right.identity.bindingSource == null) ||
      Number(left.identity.manuallyAdded) - Number(right.identity.manuallyAdded)
    )
    .find((item) => displayWaybill(item) === canonicalInput);
  const outcome = await queryManualForSource({
    source: state.activeSource,
    bindings: bindingsForSource(state),
    waybill: input.waybill,
    phoneTail: input.phoneTail,
    rawCourierCode: current?.identity.rawCourierCode,
    courierCode: current?.identity.courierCode,
    companyName: current?.identity.companyName,
    sourceProvider: current?.identity.sourceProvider,
    presentation: input.presentation,
    currentShipment: current,
    deadlineAtMs,
    includeKdniaoFallback: false,
    pickerOnly: true,
    dependencies,
  });
  const prepared = prepareManualPreview(outcome);
  const queried = prepared.shipment;
  const previewAtMs = Math.max(
    Date.now(),
    (existingPending?.createdAtMs || 0) + 1,
  );
  const shipment = prepared.hasTimedResult && queried
    ? applyManualShipment(current, queried, previewAtMs)
    : current || queried || (prepared.pending
      ? pendingManualPreviewShipment(prepared.pending)
      : null);
  const pickerReachedStart = Boolean(shipment && hasPickerTimelineStart(shipment));
  const pending = current || pickerReachedStart
    ? null
    : {
        ...(prepared.pending || {}),
        id: `${state.activeSource}:${canonicalInput}`,
        source: state.activeSource,
        waybill: canonicalInput,
        phoneTail: String(input.phoneTail || "").trim(),
        courierCode:
          shipment?.identity.courierCode ||
          prepared.pending?.courierCode ||
          input.presentation?.courierCode ||
          "",
        rawCourierCode:
          shipment?.identity.rawCourierCode ||
          prepared.pending?.rawCourierCode ||
          "",
        companyName:
          shipment?.identity.companyName ||
          prepared.pending?.companyName ||
          input.presentation?.companyName ||
          "",
        createdAtMs: existingPending?.createdAtMs || previewAtMs,
        lastAttemptAtMs: previewAtMs,
        attempts: (existingPending?.attempts || 0) + 1,
        awaitingRoundCompletion: true,
        route: shipment?.route || prepared.pending?.route || null,
      } satisfies PendingManualQuery;
  return {
    shipment,
    pending,
    routeUrl: prepared.routeUrl,
    hasTimedResult: prepared.hasTimedResult,
    roundComplete: pickerReachedStart,
    commitBase: { shipment: current || null, pending: existingPending || null },
  };
}

export function commitManualShipmentPreview(
  preview: ManualShipmentPreview,
  now = Date.now(),
  lookup?: ParcelLookup,
): AppState {
  // Only the owner reducer is retryable. Route publication and widget reload run once,
  // after its business state and provider packages have been accepted together.
  const committed = withSharedFileTransaction(() => {
    const state = loadState(now);
    const canonical = preview.shipment
      ? displayWaybill(preview.shipment)
      : normalizeWaybill(preview.pending?.waybill || "");
    const previewSource = preview.shipment?.identity.bindingSource ||
      preview.pending?.source || null;
    const current = state.shipments
      .filter(
        (item) =>
          item.identity.bindingSource === previewSource,
      )
      .sort((left, right) =>
        Number(left.identity.manuallyAdded) - Number(right.identity.manuallyAdded)
      )
      .find((item) => displayWaybill(item) === canonical);

    const currentPending = state.pendingQueries.find((item) =>
      item.source === previewSource && normalizeWaybill(item.waybill) === canonical
    );
    const base = preview.commitBase;
    // The first Picker wait can overlap pending promotion and deletion just like
    // the continuation round. A returned package is not authority to recreate it.
    if (!base ||
        JSON.stringify(base.shipment) !== JSON.stringify(current || null) ||
        (base.pending ? pendingGenerationVersion(base.pending) : "") !==
          (currentPending ? pendingGenerationVersion(currentPending) : "")) {
      throw new Error("该快递查询已被移除或更新");
    }

    if (!preview.hasTimedResult || preview.roundComplete === false) {
      if (!preview.pending || current) return state;
      const existingPending = state.pendingQueries.find(
        (item) => item.id === preview.pending?.id,
      );
      const existingRoute = existingPending?.route && Boolean(
        loadShipmentRoute(
          existingPending.id,
          existingPending.route.source,
          now,
          existingPending.route.kind,
        ),
      ) ? existingPending.route : null;
      let pending: PendingManualQuery = {
        ...preview.pending,
        route: existingRoute,
      };
      let next = saveState(
        {
          ...state,
          pendingQueries: [
            ...state.pendingQueries.filter((item) => item.id !== pending.id),
            pending,
          ],
        },
        now,
        {},
        state,
      );
      return () => {
        const pointer = preview.pending?.route || null;
        if (pointer && preview.routeUrl) {
          try {
            if (saveShipmentRoute(
              pending.id,
              pointer.source,
              preview.routeUrl,
              now,
              pointer.kind,
            )) {
              pending = { ...pending, route: pointer };
              next = commitRoutePointers(next, {
                ...next, pendingQueries: next.pendingQueries.map(item => item.id === pending.id ? pending : item),
              }, [{ owner: "pending", targetId: pending.id }], now);
            }
          } catch {
            if (!existingRoute) safelyRemoveRoutes([pending.id]);
          }
        }
        safelyPruneRoutes(next);
        return next;
      };
    }

    if (!preview.shipment) return state;
    const requested = preview.shipment;
    const manual = applyManualShipment(current, requested, now);
    const merged = lookup ? applyRecognizedPickup(manual, lookup) : manual;
    const existingRoute = current?.route && Boolean(
      loadShipmentRoute(
        current.identity.id,
        current.route.source,
        now,
        current.route.kind,
      ),
    ) ? current.route : null;
    let shipment: Shipment = { ...merged, route: existingRoute };
    const queued = state.pendingQueries.find(
      (pending) =>
        pending.source === requested.identity.bindingSource &&
        normalizeWaybill(pending.waybill) === canonical,
    );
    let next = saveState(
      {
        ...state,
        pendingQueries: state.pendingQueries.filter(
          (pending) =>
            pending.source !== requested.identity.bindingSource ||
            normalizeWaybill(pending.waybill) !== displayWaybill(shipment),
        ),
        shipments: replaceById(
          state.shipments.filter(
            (item) =>
              item.identity.id === shipment.identity.id ||
              item.identity.bindingSource !==
                requested.identity.bindingSource ||
              displayWaybill(item) !== canonical,
          ),
          shipment,
        ),
      },
      now,
      {},
      state,
    );
    return () => {
      const pointer = preview.shipment?.route || null;
      let routeReady = false;
      if (pointer && preview.routeUrl) {
        try {
          routeReady = saveShipmentRoute(
            shipment.identity.id,
            pointer.source,
            preview.routeUrl,
            now,
            pointer.kind,
          );
        } catch {
          routeReady = false;
        }
      } else if (!existingRoute && queued) {
        shipment = adoptPendingRoute(shipment, queued, now);
        routeReady = Boolean(shipment.route);
      }
      if (routeReady && pointer) shipment = { ...shipment, route: pointer };
      if (
        shipment.route &&
        (!existingRoute || shipment.route.source !== existingRoute.source)
      ) {
        try {
          next = commitRoutePointers(next,
            { ...next, shipments: replaceById(next.shipments, shipment) },
            [{ owner: "shipment", targetId: shipment.identity.id }], now);
        } catch {
          safelyRemoveRoutes([shipment.identity.id]);
          shipment = { ...shipment, route: null };
        }
      }
      if (queued && queued.id !== shipment.identity.id) {
        safelyRemoveRoutes([queued.id]);
      }
      safelyPruneRoutes(next);
      requestWidgetReload();
      return next;
    };
  });
  return typeof committed === "function" ? committed() : committed;
}

export type ManualPreviewContinuationDependencies = Readonly<{
  now?: () => number;
  queryMoto?: (
    seed: Shipment,
    deadlineAtMs: number,
    signal?: AbortSignal,
  ) => Promise<Shipment | null>;
  queryKuaidi100?: (
    seed: Shipment,
    deadlineAtMs: number,
    signal?: AbortSignal,
  ) => Promise<Shipment | null>;
  queryKdniao?: (
    seed: Shipment,
    deadlineAtMs: number,
    signal?: AbortSignal,
  ) => Promise<Shipment | null>;
}>;

function applyManualRoundPackages(
  seed: Shipment,
  packages: readonly (Shipment | null)[],
  now: number,
): Shipment {
  let accumulated = seed;
  for (const shipment of packages) {
    if (!shipment || !timedTracks(shipment.timeline.tracks).length) continue;
    accumulated = applyManualShipment(accumulated, shipment, now);
  }
  return accumulated;
}

/**
 * Finishes the first pure-manual round while the Picker package remains a
 * detail-only preview. The first owner and every provider package become
 * visible through one fenced state commit after all required sources settle.
 */
export async function continueManualShipmentPreview(
  runtimeState: SyncRuntimeState,
  preview: ManualShipmentPreview,
  options: Readonly<{
    signal?: AbortSignal;
    backgroundHostSafe?: boolean;
    deadlineAtMs?: number;
    lookup?: ParcelLookup;
    dependencies?: ManualPreviewContinuationDependencies;
    onPreview?: (shipment: Shipment) => void;
  }> = {},
): Promise<ShipmentRefreshResult> {
  const seedPreview = preview.shipment;
  const previewPending = preview.pending;
  if (!seedPreview || !previewPending || preview.roundComplete !== false) {
    throw new Error("手动查询续跑状态无效");
  }
  const source = requireScriptSource(previewPending.source);
  const dependencies = options.dependencies || {};
  const now = dependencies.now || Date.now;
  const startedAtMs = now();
  const deadlineAtMs = Math.min(deadlineAfter(MANUAL_QUERY_BUDGET_MS, startedAtMs), options.deadlineAtMs ?? Infinity);
  assertRefreshSignal(options.signal);
  assertWithinDeadline(deadlineAtMs, startedAtMs);
  const base = loadState(startedAtMs);
  const pending = base.pendingQueries.find(
    (candidate) => candidate.id === previewPending.id,
  );
  if (
    !pending ||
    pendingGenerationVersion(pending) !==
      pendingGenerationVersion(previewPending)
  ) {
    throw new Error("该快递查询已被移除或更新");
  }
  const canonical = normalizeWaybill(pending.waybill);
  if (
    displayWaybill(seedPreview) !== canonical ||
    seedPreview.identity.bindingSource !== source
  ) {
    throw new Error("手动查询续跑状态无效");
  }
  const seed: Shipment = {
    ...seedPreview,
    identity: {
      ...seedPreview.identity,
      id: `${source}:manual:${canonical}`,
      bindingSource: source,
      sourceId: canonical,
      createdAtMs: pending.createdAtMs,
      // 2026-10-08 用户决定 #6：用户填的尾号要随种子身份走，K100 页（refreshWebTimeline 读 identity.phoneTail）才带得上它。
      phoneTail: pending.phoneTail || seedPreview.identity.phoneTail,
    },
    route: pending.route || null,
  };
  const bindings = bindingsForSource(base, source);
  const manualQueryInput = {
    source,
    bindings,
    waybill: canonical,
    phoneTail: pending.phoneTail,
    rawCourierCode: pending.rawCourierCode,
    courierCode: pending.courierCode,
    companyName: pending.companyName,
    deadlineAtMs,
    signal: options.signal,
    currentShipment: seed,
    includeKdniaoFallback: false,
  } as const;
  const queryMoto = dependencies.queryMoto || (async () => {
    const outcome = await queryManualForSource({
      ...manualQueryInput,
      motoOnly: true,
      diagnosticStage: "moto_query",
    });
    return outcome.shipment;
  });
  const queryKuaidi100 = options.backgroundHostSafe ? async () => null : dependencies.queryKuaidi100 || ((shipment) =>
    refreshWebTimeline(
      shipment,
      deadlineAtMs,
      undefined,
      options.signal,
      undefined,
      bindings.map(binding => binding.phone.slice(-4)),
      undefined,
      runtimeState,
    ));
  const queryKdniao = dependencies.queryKdniao || (async () => {
    const outcome = await queryManualForSource({
      ...manualQueryInput,
      fallbackOnly: true,
      includeKdniaoFallback: true,
      diagnosticStage: "kdniao_fallback",
    });
    return outcome.shipment;
  });

  let progressivePreview = seed;
  const previewResult = async (task: Promise<Shipment | null>): Promise<Shipment | null> => {
    const result = await task;
    assertRefreshSignal(options.signal);
    if (result && timedTracks(result.timeline.tracks).length) {
      progressivePreview = applyManualRoundPackages(progressivePreview, [result], now());
      options.onPreview?.(progressivePreview);
    }
    return result;
  };
  const contest = await runManualDetailSourceContest({
    queryMoto: () => previewResult(queryMoto(seed, deadlineAtMs, options.signal)),
    queryKuaidi100: () =>
      previewResult(queryKuaidi100(seed, deadlineAtMs, options.signal)),
    queryKdniao: () => previewResult(queryKdniao(seed, deadlineAtMs, options.signal)),
    hasAccumulatedTimelineStart: (primary) =>
      hasTimelineStartBeforeKdniao(
        applyManualRoundPackages(seed, primary, now()),
      ),
  });
  assertRefreshSignal(options.signal);
  const settledAtMs = now();
  const accumulated = applyManualRoundPackages(seed, [
    contest.moto.shipment,
    contest.kuaidi100.shipment,
    contest.kdniao.shipment,
  ], settledAtMs);
  const roundSucceeded = preview.hasTimedResult || [
    contest.moto.shipment, contest.kuaidi100.shipment, contest.kdniao.shipment,
  ].some(shipment => shipment && timedTracks(shipment.timeline.tracks).length > 0);
  const phoneToast = !roundSucceeded && !shipmentDetailComplete(accumulated) &&
    [contest.moto.error, contest.kuaidi100.error, contest.kdniao.error].some(needsManualPhoneTail)
      ? "manualPhoneTailRequired" as const : undefined;
  const acceptsGeneration = (latest: AppState) => {
    const currentPending = latest.pendingQueries.find(
      (candidate) => candidate.id === pending.id,
    );
    return Boolean(
      currentPending &&
      pendingGenerationVersion(currentPending) ===
        pendingGenerationVersion(pending) &&
      !latest.shipments.some(
        (shipment) =>
          shipment.identity.bindingSource === source &&
          displayWaybill(shipment) === canonical,
      ),
    );
  };
  const fence = {
    isCurrent: () => !options.signal?.aborted,
    acceptsState: acceptsGeneration,
  };
  const hasTimedResult = (accumulated.manualTimelines || []).some(
    (timeline) => timedTracks(timeline.tracks).length > 0,
  );
  if (!hasTimedResult) {
    const candidate: AppState = {
      ...base,
      pendingQueries: base.pendingQueries.map((candidate) =>
        candidate.id === pending.id
          ? {
              ...candidate,
              lastAttemptAtMs: settledAtMs,
              attempts: candidate.attempts + 1,
              awaitingRoundCompletion: false,
            }
          : candidate,
      ),
    };
    const commit = commitRefreshState(base, candidate, source, settledAtMs, fence);
    if (!commit.applied) throw new Error("该快递查询已被移除或更新");
    return {
      shipment: accumulated,
      state: commit.state,
      refreshed: false,
      ...(phoneToast ? { expressToast: phoneToast } : {}),
    };
  }

  const routeMutations: DeferredRouteMutations = new Map();
  const withPickup = options.lookup ? applyRecognizedPickup(accumulated, options.lookup) : accumulated;
  let shipment = deferPendingRoute(
    { ...withPickup, updatedAtMs: settledAtMs },
    pending,
    settledAtMs,
    routeMutations,
  );
  const candidate: AppState = {
    ...base,
    pendingQueries: base.pendingQueries.filter(
      (candidate) => candidate.id !== pending.id,
    ),
    shipments: replaceById(base.shipments, shipment),
  };
  const commit = commitRefreshState(base, candidate, source, settledAtMs, fence);
  if (!commit.applied) throw new Error("该快递查询已被移除或更新");
  let committedState = commit.state;
  try {
    committedState = publishDeferredRoutes(
      committedState,
      routeMutations,
      settledAtMs,
      commit,
    );
  } catch {
    /* The atomic owner and provider packages remain usable without the route. */
  }
  const promotedId = committedPendingPromotionShipmentId(
    committedState,
    pending.id,
    shipment.identity.id,
  );
  if (!promotedId) throw new Error("该快递查询已被移除或更新");
  shipment = committedState.shipments.find(
    (candidate) => candidate.identity.id === promotedId,
  )!;
  requestWidgetReload();
  return {
    shipment,
    state: committedState,
    refreshed: true,
    ...(phoneToast ? { expressToast: phoneToast } : {}),
  };
}
