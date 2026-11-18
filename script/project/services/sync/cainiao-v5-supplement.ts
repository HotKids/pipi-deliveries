/** Cainiao v5 background trajectory supplement, shared account-detail requests, and detail-entry queries. */
import type { AbortSignal } from "scripting";
import type { AccountBinding, AppState, BindingSource, RefreshSummary, Shipment, StatusSemantic } from "../../models";
import { parcelToShipment, prepareAccountParcelCarrier, refreshAccountParcel } from "../account-sync";
import type { AccountParcelDto } from "../account-parser";
import { replayPendingShipmentNotifications } from "../notifications";
import { applyTargetedAccountShipment, asAccountDetailObservation, cainiaoCandidateAlignsWithLatestStatus, cainiaoHasTrajectoryGap, cainiaoSupplementTimes, displayWaybill, isCainiaoV5AutomaticShipment, isShunFengSourceShipment, detailEntryQueryReason, selectShipmentTimeline, shipmentDetailIncompleteReason, shouldRefreshShipmentRow, signedRefreshFrozen, supportsOrdinaryAutomaticDetailSupplement, unprojectedAccountOrder, withDetailSelection } from "../shipment-policy";
import { bindingsForSource, commitTargetShipmentRefresh, loadState, privateHash, refreshValueFingerprint as shipmentEffectiveFingerprint } from "../storage";
import { isAccountUpdateSummary, isNonEventDetail, sortShipments, timedTracks, timelineDisplayDetail } from "../status";
import { recordRefreshProviderResult, refreshProviderDue, refreshProviderCooldownDetails } from "../refresh-runtime-state";
import { requestWidgetReload } from "../widgets";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey, saveAlignmentRecords, type AlignmentAttempt } from "../row-ledger";
import { alignmentOwnerCurrent } from "../status-alignment-state";
import { deadlineAfter, deadlineExpired, OperationTimeoutError } from "../deadline";
import { ACCOUNT_DETAIL_BUDGET_MS, accountChildDeadline } from "../account-sync-policy";
import { accountParcelWithProjectionReference } from "../account-order-reference";
import { enhancementPhone } from "../enhanced-account";
import { classifyDiagnosticError, diagnosticErrorDetails, flushDiagnostics, openStageCancellationEnd, writeDiagnostic } from "../logger";
import { SCRIPT_BINDING_SOURCE, requireScriptSource } from "../script-source";
import { carrierUnmatched } from "../carrier-gate";
import {
  assertRefreshSignal,
  commitCheckpoint,
  createSyncRuntimeState,
  homeAccountQueryEligible,
  operationRecognitionBudget,
  refreshProviderResultForError,
  replaceById,
  rethrowStageCancellation,
  shipmentDiagnosticDetails,
  type DeferredRouteMutations,
  type DetailEntryObservation,
  type ManualRefreshTask,
  type RefreshCheckpoint,
  type ShipmentRefreshResult,
  type SyncRuntimeState,
  type TargetRefreshLease,
} from "./shared";
import { deferIncomingRoute, publishDeferredRoutes } from "./route-publications";
import { storedCainiaoRoute, storedJingDongProjectionRoute } from "./h5-capture";

export function detailRequestFingerprint(shipment: Shipment, state: AppState): string {
  return privateHash(JSON.stringify({
    identity: [shipment.identity.id, shipment.identity.createdAtMs, shipment.identity.sourceOwner,
      shipment.identity.sourceProvider, displayWaybill(shipment), shipment.identity.courierCode,
      shipment.identity.rawCourierCode, shipment.identity.phoneTail, shipment.identity.manuallyAdded],
    record: shipment.accountRecord,
    binding: state.bindings.filter(binding => binding.source === shipment.identity.bindingSource &&
      binding.phone === shipment.identity.phone),
  }));
}

export function productImageOwnerFingerprint(shipment: Shipment, state: AppState): string {
  const identity = shipment.identity;
  return privateHash(JSON.stringify([
    identity.id, identity.bindingSource, identity.sourceId, identity.phone, identity.orderId,
    identity.sourceOwner, identity.sourceProvider,
    state.bindings.filter(binding => binding.source === identity.bindingSource && binding.phone === identity.phone),
  ]));
}

export function shouldRequestDetailProductImage(
  shipment: Shipment, bindings: readonly AccountBinding[] | (() => readonly AccountBinding[]),
): boolean {
  if (shipment.identity.productImageURL) return false;
  const reference = accountParcelWithProjectionReference(shipment, null, "", true);
  if (!reference || reference.source !== SCRIPT_BINDING_SOURCE || reference.sourceProvider.toLowerCase() !== "jingdong") return false;
  return Boolean(enhancementPhone(reference, typeof bindings === "function" ? bindings() : bindings));
}

const defaultAccountDetailRuntimeState = createSyncRuntimeState();

export function requestAccountDetail(
  runtimeState: SyncRuntimeState,
  shipment: Shipment, state: AppState, query: typeof refreshAccountParcel,
  deadlineAtMs: number | undefined, signal?: AbortSignal,
  beforeQuery?: () => void,
): Promise<AccountParcelDto | null> {
  const source = requireScriptSource(shipment.identity.bindingSource);
  const deadline = accountChildDeadline(deadlineAtMs, ACCOUNT_DETAIL_BUDGET_MS);
  // Share only the live transport observation; each consumer retains its own commit fence.
  return runtimeState.accountDetailRequests.runIndependentDetail(detailRequestFingerprint(shipment, state), source,
    sharedSignal => query(shipment, deadlineAfter(ACCOUNT_DETAIL_BUDGET_MS), sharedSignal, undefined,
      { recognizeCarrier: false, beforeQuery }), deadline, signal);
}

export function cainiaoHasRealIncomingTracks(incoming: Shipment): boolean {
  const candidate = incoming.sourceTimeline || incoming.timeline;
  return timedTracks(candidate.tracks).some(track =>
    Boolean(String(track.detail || "").trim()) &&
    !isAccountUpdateSummary(track.detail) &&
    !isNonEventDetail(track.detail),
  );
}

export function cainiaoForcedSupplementDue(
  shipment: Shipment,
  cainiaoListUpdated: boolean,
  now: number,
): Readonly<{ forced: boolean; timesKey: string; statusSemantic: StatusSemantic }> {
  const supplement = cainiaoSupplementTimes(shipment, now);
  if (!supplement) return { forced: false, timesKey: "", statusSemantic: "UNKNOWN" };
  const { timesKey, statusAtMs, headlineAtMs, detailAtMs, statusSemantic } = supplement;
  const hasPriorComparison = statusAtMs > 0 && (headlineAtMs > 0 || detailAtMs > 0);
  if (!cainiaoListUpdated && !hasPriorComparison) {
    return { forced: false, timesKey, statusSemantic };
  }
  let record: AlignmentAttempt | null = null;
  try {
    record = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(shipment.identity.id)]);
  } catch { /* best-effort read falls back to normal eligibility */ }
  const alreadyForced = Boolean(
    record &&
    record.times === timesKey &&
    record.attempts >= 1 &&
    (!record.completionStatus || record.completionStatus === statusSemantic),
  );
  return { forced: !alreadyForced, timesKey, statusSemantic };
}

export function recordCainiaoSupplementAttempt(
  rowId: string,
  timesKey: string,
  statusSemantic: StatusSemantic,
  now: number,
  complete: boolean,
): void {
  if (!timesKey) return;
  try {
    const current = loadAlignmentRecords();
    const key = rowLedgerKey(rowId);
    const old = parseAlignmentAttempt(current[key]);
    const sameGroup = Boolean(
      old &&
      old.times === timesKey &&
      (!old.completionStatus || old.completionStatus === statusSemantic),
    );
    const next: AlignmentAttempt = {
      times: timesKey,
      attempts: sameGroup ? Math.max(1, old!.attempts) : 1,
      lastAttemptAtMs: now,
      complete,
      finished: true,
      completionStatus: statusSemantic,
    };
    current[key] = JSON.stringify(next);
    saveAlignmentRecords(current);
  } catch { /* best-effort ledger persistence cannot fail background supplement */ }
}

export async function refreshHomeAccountShipment(
  runtimeState: SyncRuntimeState,
  state: AppState, source: BindingSource, flowId: string, checkpoint: RefreshCheckpoint,
  task: ManualRefreshTask, deadlineAtMs: number | undefined, signal: AbortSignal,
  query: typeof refreshAccountParcel,
  /** C1: called once this task passed its gates, right before it queries. */
  onQueryStarted: () => void = () => {},
  forceManualRefresh = false,
): Promise<RefreshSummary> {
  const now = Date.now();
  const original = state.shipments.find(item => item.identity.id === task.id);
  const summary = (next: AppState, attempted = 0, succeeded = 0, failed = 0) =>
    ({ state: next, attempted, succeeded, failed, promotedPendingShipmentIds: [] });
  if (!original || !homeAccountQueryEligible(original, Boolean(task.cainiaoFollowup)) ||
      deadlineExpired(deadlineAtMs)) return summary(state);
  if (signedRefreshFrozen(original, now)) {
    writeDiagnostic("refresh.stage.skipped", { flowId, source, stage: "account_detail",
      ...shipmentDiagnosticDetails(original, "v5_query"), result: "signed_frozen", skipReason: "signed_frozen" });
    return summary(state);
  }
  const hasGap = Boolean(task.cainiaoListUpdated) || cainiaoHasTrajectoryGap(original, now) ||
    (forceManualRefresh && !timelineDisplayDetail(original.timeline) && !timedTracks(original.timeline.tracks).length);
  if (!hasGap) return summary(state);
  const scheduleKey = `${source}:${original.identity.id}`;
  const providerFingerprint = [displayWaybill(original), original.identity.courierCode,
    original.identity.phoneTail].join(":");
  const forcedInfo = cainiaoForcedSupplementDue(original, Boolean(task.cainiaoListUpdated), now);
  const due = refreshProviderDue(scheduleKey, "account_detail", providerFingerprint, now);
  const cooldown = refreshProviderCooldownDetails(scheduleKey, "account_detail", providerFingerprint, now);
  const riskControlled = !due &&
    (cooldown.cooldownReason === "upstream_rejected" || cooldown.cooldownReason === "invalid_query");
  if (forcedInfo.forced) {
    if (riskControlled) {
      writeDiagnostic("refresh.stage.skipped", { flowId, source, stage: "account_detail",
        ...shipmentDiagnosticDetails(original, "v5_query"), ...cooldown, result: "cooldown", skipReason: "cooldown" });
      return summary(state);
    }
  } else {
    if (!shouldRefreshShipmentRow(original, now)) return summary(state);
    if (!due) {
      writeDiagnostic("refresh.stage.skipped", { flowId, source, stage: "account_detail",
        ...shipmentDiagnosticDetails(original, "v5_query"), ...cooldown, result: "cooldown", skipReason: "cooldown" });
      return summary(state);
    }
  }
  onQueryStarted();
  const startedAt = Date.now();
  let phase: "query" | "parse" | "write" = "query";
  let tupleRecorded = false;
  const recordAttempt = (complete = false) => {
    if (!forcedInfo.timesKey) return;
    tupleRecorded = true;
    recordCainiaoSupplementAttempt(original.identity.id, forcedInfo.timesKey,
      forcedInfo.statusSemantic, Date.now(), complete);
  };
  writeDiagnostic("refresh.stage.started", { flowId, source, stage: "account_detail", stagePhase: "query",
    budgetMs: ACCOUNT_DETAIL_BUDGET_MS, ...shipmentDiagnosticDetails(original, "v5_query") });
  flushDiagnostics();
  const stageCancelled = openStageCancellationEnd(flowId, signal, () => {
    writeDiagnostic("refresh.stage.failed", {
      flowId, source, stage: "account_detail", stagePhase: phase, result: "cancelled",
      ...shipmentDiagnosticDetails(original, "v5_query"),
      durationMs: Date.now() - startedAt, errorCategory: "cancelled",
    }, "warning");
    flushDiagnostics();
  });
  let parcel: AccountParcelDto | null;
  try {
    parcel = await requestAccountDetail(runtimeState, original, state, query, deadlineAtMs, signal, () => {
      if (!tupleRecorded) recordAttempt(false);
    });
    assertRefreshSignal(signal);
    if (forcedInfo.forced && !tupleRecorded) recordAttempt(false);
  } catch (error) {
    rethrowStageCancellation(signal, stageCancelled.end);
    stageCancelled.close();
    if (forcedInfo.forced && !tupleRecorded) recordAttempt(false);
    const providerResult = refreshProviderResultForError(error);
    recordRefreshProviderResult({ key: scheduleKey, provider: "account_detail",
      identityFingerprint: providerFingerprint, result: providerResult });
    const errorDetails = diagnosticErrorDetails(error);
    const result = errorDetails.errorCategory === "timeout" ? "timeout" : "query_failed";
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "account_detail", stagePhase: "query",
      result, ...shipmentDiagnosticDetails(original, "v5_query"),
      durationMs: Date.now() - startedAt, ...errorDetails }, "warning");
    flushDiagnostics();
    return summary(loadState(), 1, 0, 1);
  }

  phase = "parse";
  let incoming: Shipment | null = null;
  try {
    assertRefreshSignal(signal);
    incoming = parcel ? parcelToShipment(parcel, bindingsForSource(state, source).map(b => b.phone), Date.now()) : null;
  } catch (error) {
    rethrowStageCancellation(signal, stageCancelled.end);
    stageCancelled.close();
    recordRefreshProviderResult({ key: scheduleKey, provider: "account_detail",
      identityFingerprint: providerFingerprint, result: refreshProviderResultForError(error) });
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "account_detail", stagePhase: "parse",
      result: "parse_failed", ...shipmentDiagnosticDetails(original, "v5_query"),
      durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) }, "warning");
    flushDiagnostics();
    return summary(loadState(), 1, 0, 1);
  }
  if (!incoming || !parcel || !cainiaoHasRealIncomingTracks(incoming)) {
    stageCancelled.close();
    recordRefreshProviderResult({ key: scheduleKey, provider: "account_detail",
      identityFingerprint: providerFingerprint, result: "no_result" });
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "account_detail", stagePhase: "parse",
      result: "empty", errorCategory: "no_result", ...shipmentDiagnosticDetails(original, "v5_query"),
      durationMs: Date.now() - startedAt }, "warning");
    flushDiagnostics();
    return summary(loadState(), 1, 0, 1);
  }

  phase = "write";
  try {
    assertRefreshSignal(signal);
  } catch (error) {
    rethrowStageCancellation(signal, stageCancelled.end);
    stageCancelled.close();
    throw error;
  }
  const writeNow = Date.now();
  const latest = loadState(writeNow);
  const latestRow = latest.shipments.find(item => item.identity.id === original.identity.id);
  if (!latestRow || !alignmentOwnerCurrent(state, original, latest)) {
    stageCancelled.close();
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "account_detail", stagePhase: "write",
      result: "write_failed", errorCategory: latestRow ? "state_changed" : "removed",
      ...shipmentDiagnosticDetails(latestRow || original, "v5_query", incoming.timeline),
      durationMs: Date.now() - startedAt }, "warning");
    flushDiagnostics();
    return summary(latest, 1, 0, 1);
  }
  const routes: DeferredRouteMutations = new Map();
  let merged: Shipment;
  try {
    merged = applyTargetedAccountShipment(latestRow, asAccountDetailObservation(latestRow, incoming), writeNow,
      { existingCainiaoRouteAvailable: Boolean(storedCainiaoRoute(latestRow)) });
    merged = deferIncomingRoute(merged, incoming, parcel.routeUrl, writeNow, routes);
  } catch (error) {
    rethrowStageCancellation(signal, stageCancelled.end);
    stageCancelled.close();
    recordRefreshProviderResult({ key: scheduleKey, provider: "account_detail",
      identityFingerprint: providerFingerprint, result: "no_result" });
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "account_detail", stagePhase: "parse",
      result: "parse_failed", ...shipmentDiagnosticDetails(latestRow, "v5_query"),
      durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) }, "warning");
    flushDiagnostics();
    return summary(latest, 1, 0, 1);
  }
  if (isCainiaoV5AutomaticShipment(latestRow) && !cainiaoCandidateAlignsWithLatestStatus(merged, writeNow)) {
    stageCancelled.close();
    recordRefreshProviderResult({ key: scheduleKey, provider: "account_detail",
      identityFingerprint: providerFingerprint, result: "no_result" });
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "account_detail", stagePhase: "write",
      result: "lagging", errorCategory: "stale_timeline",
      ...shipmentDiagnosticDetails(latestRow, "v5_query", incoming.timeline),
      durationMs: Date.now() - startedAt }, "warning");
    flushDiagnostics();
    return summary(latest, 1, 0, 1);
  }
  let next: AppState;
  try {
    next = await commitCheckpoint(checkpoint, { ...latest, shipments: sortShipments(replaceById(latest.shipments,
      withDetailSelection(merged, writeNow))) }, routes, "account_detail", latest);
    stageCancelled.close();
  } catch (error) {
    rethrowStageCancellation(signal, stageCancelled.end);
    stageCancelled.close();
    const category = classifyDiagnosticError(error);
    if (category === "cancelled" || category === "timeout" || error instanceof OperationTimeoutError) {
      writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "account_detail", stagePhase: "write",
        result: category === "timeout" ? "timeout" : "cancelled",
        ...shipmentDiagnosticDetails(latestRow, "v5_query", incoming.timeline),
        durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) }, "warning");
      flushDiagnostics();
      throw error;
    }
    recordRefreshProviderResult({ key: scheduleKey, provider: "account_detail",
      identityFingerprint: providerFingerprint, result: "failed" });
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "account_detail", stagePhase: "write",
      result: "write_failed", ...shipmentDiagnosticDetails(latestRow, "v5_query", incoming.timeline),
      durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) }, "warning");
    flushDiagnostics();
    return summary(loadState(), 1, 0, 1);
  }
  const committedRow = next.shipments.find(item => item.identity.id === original.identity.id) || merged;
  recordRefreshProviderResult({ key: scheduleKey, provider: "account_detail",
    identityFingerprint: providerFingerprint, result: "success" });
  if (!cainiaoHasTrajectoryGap(committedRow, Date.now())) recordAttempt(true);
  writeDiagnostic("refresh.stage.succeeded", { flowId, source, stage: "account_detail", stagePhase: "write",
    result: "aligned", ...shipmentDiagnosticDetails(committedRow, "v5_query", incoming.timeline),
    durationMs: Date.now() - startedAt });
  flushDiagnostics();
  return summary(next, 1, 1);
}

/**
 * The rows whose detail page opens with their own per-waybill account query (detailEntryQueryReason), without
 * its freeze and complete-cache gates: the status alignment run asks that query first (用户 2026-10-02).
 */
export function statusAlignmentEntryQuerySupported(shipment: Shipment): boolean {
  const provider = String(shipment.identity.sourceProvider || "").toLowerCase();
  return !shipment.identity.manuallyAdded && Boolean(shipment.accountRecord) &&
    (provider === "jingdong" || provider === "cainiao") &&
    selectShipmentTimeline(shipment).semantic !== "CANCELLED";
}

/** The app host must have an actual permitted source before reserving an alignment attempt. */
export function statusAlignmentHasSource(shipment: Shipment): boolean {
  if (shipment.identity.bindingSource !== SCRIPT_BINDING_SOURCE || shipment.timeline.provider === "demo") return false;
  if (statusAlignmentEntryQuerySupported(shipment)) return true;
  if (unprojectedAccountOrder(shipment)) return Boolean(storedJingDongProjectionRoute(shipment, Date.now()));
  if (displayWaybill(shipment).length < 6) return false;
  return shipment.identity.manuallyAdded || isShunFengSourceShipment(shipment) ||
    supportsOrdinaryAutomaticDetailSupplement(shipment) || Boolean(storedCainiaoRoute(shipment));
}

export async function runDetailEntryQuery(
  base: AppState,
  original: Shipment,
  lease: TargetRefreshLease,
  query: typeof refreshAccountParcel,
  flowId: string,
  /**
   * 用户 2026-10-02 状态对齐强刷越过冷却与完整闸门口径同取件码强刷：状态对齐强刷先问这一行自己的按件详情（v5_query），签收冻结与完整缓存
   * 不挡这一次；资格（自动件、有账号记录、京东 / 菜鸟来源）照旧由调用方判。
   */
  statusAlignment = false,
  beforeQuery?: () => void,
  runtimeState: SyncRuntimeState = defaultAccountDetailRuntimeState,
): Promise<ShipmentRefreshResult> {
  const observation: DetailEntryObservation = {
    fingerprint: detailRequestFingerprint(original, base), gaveTimeline: false,
  };
  const reason = statusAlignment ? "status_alignment" : detailEntryQueryReason(original);
  if (!reason) {
    return { state: base, shipment: original, refreshed: false, detailEntry: observation };
  }
  const source = requireScriptSource(original.identity.bindingSource);
  const startedAt = Date.now();
  const key = `${source}:${original.identity.id}`;
  const detailDeadline = accountChildDeadline(lease.deadlineAtMs, ACCOUNT_DETAIL_BUDGET_MS);
  const providerFingerprint = [displayWaybill(original), original.identity.courierCode,
    original.identity.phoneTail].join(":");
  let reservationFailed = false;
  const reserveBeforeQuery = beforeQuery ? () => {
    try { beforeQuery(); }
    catch (error) { reservationFailed = true; throw error; }
  } : undefined;
  const routes: DeferredRouteMutations = new Map();
  writeDiagnostic("detail.refresh.stage_started", {
    flowId, source, trigger: statusAlignment ? "status_alignment" : "detail_open", stage: "account_detail",
    budgetMs: ACCOUNT_DETAIL_BUDGET_MS,
    ...shipmentDiagnosticDetails(original, "v5_query"),
    incompleteReason: shipmentDetailIncompleteReason(original) ?? undefined,
  });
  try {
    const parcel = await requestAccountDetail(runtimeState, original, base, query, detailDeadline, lease.signal, reserveBeforeQuery);
    assertRefreshSignal(lease.signal);
    if (!lease.isCurrent()) throw new OperationTimeoutError();
    const incoming = parcel ? parcelToShipment(parcel, bindingsForSource(base, source).map(b => b.phone), Date.now()) : null;
    if (!incoming || !parcel || (isCainiaoV5AutomaticShipment(original) && !cainiaoHasRealIncomingTracks(incoming))) {
      recordRefreshProviderResult({ key, provider: "account_detail", identityFingerprint: providerFingerprint,
        result: "no_result" });
      writeDiagnostic("detail.refresh.stage_failed", {
        flowId, source, stage: "account_detail", stagePhase: "parse", result: "empty", errorCategory: "no_result",
        durationMs: Date.now() - startedAt, ...shipmentDiagnosticDetails(original, "v5_query"),
      }, "warning");
      const state = loadState();
      const shipment = state.shipments.find(item => item.identity.id === original.identity.id);
      if (!shipment) throw new Error("该快递已从列表中移除");
      return { state, shipment, refreshed: false, querySucceeded: false, detailEntry: observation };
    }
    const writeNow = Date.now();
    const latestState = loadState(writeNow);
    const latestRow = latestState.shipments.find(item => item.identity.id === original.identity.id);
    if (!latestRow) throw new Error("该快递已从列表中移除");
    const targetBase = isCainiaoV5AutomaticShipment(latestRow) ? latestState : base;
    const targetOriginal = isCainiaoV5AutomaticShipment(latestRow) ? latestRow : original;
    let merged = applyTargetedAccountShipment(targetOriginal, asAccountDetailObservation(targetOriginal, incoming), writeNow,
      { existingCainiaoRouteAvailable: Boolean(storedCainiaoRoute(targetOriginal)) });
    if (isCainiaoV5AutomaticShipment(targetOriginal) && !cainiaoCandidateAlignsWithLatestStatus(merged, writeNow)) {
      recordRefreshProviderResult({ key, provider: "account_detail", identityFingerprint: providerFingerprint,
        result: "no_result" });
      writeDiagnostic("detail.refresh.stage_failed", {
        flowId, source, stage: "account_detail", stagePhase: "write", result: "lagging", errorCategory: "stale_timeline",
        durationMs: Date.now() - startedAt, ...shipmentDiagnosticDetails(targetOriginal, "v5_query", incoming.timeline),
      }, "warning");
      return { state: latestState, shipment: latestRow, refreshed: false, querySucceeded: false, detailEntry: observation };
    }
    recordRefreshProviderResult({ key, provider: "account_detail", identityFingerprint: providerFingerprint,
      result: "success" });
    merged = deferIncomingRoute(merged, incoming, parcel.routeUrl, writeNow, routes);
    const commit = commitTargetShipmentRefresh(targetBase, withDetailSelection(merged, writeNow), writeNow, lease);
    if (!commit.applied) {
      const current = commit.state.shipments.find(s => s.identity.id === original.identity.id);
      if (!current) throw new Error("该快递已从列表中移除");
      return { state: commit.state, shipment: current, refreshed: false, querySucceeded: false, detailEntry: observation };
    }
    let state = commit.state;
    try { state = publishDeferredRoutes(state, routes, Date.now()); }
    catch (error) {
      writeDiagnostic("detail.route_publish_failed", { flowId, source, ...diagnosticErrorDetails(error) }, "warning");
    }
    // Home shares only the account observation. Carrier recognition belongs to this detail
    // consumer and rebases from the committed observation, which Home may have already stored.
    // T23 (2026-09-26): the shared observation shows an order's feed-text waybill only with a carrier already
    // matched, so the text waybill is recognised here and projected in the same commit as its carrier; any other
    // row still without a matched carrier is recognised here too.
    if (original.identity.accountOrder || carrierUnmatched(original)) {
      const recognized = await prepareAccountParcelCarrier(parcel,
        { deadlineAtMs: detailDeadline, signal: lease.signal, budget: operationRecognitionBudget(lease) });
      assertRefreshSignal(lease.signal);
      if (!lease.isCurrent()) throw new OperationTimeoutError();
      if (recognized !== parcel) {
        const carrierBase = state.shipments.find(s => s.identity.id === original.identity.id)!;
        const recognizedShipment = parcelToShipment(recognized, bindingsForSource(state, source).map(b => b.phone), Date.now());
        if (recognizedShipment) {
          const corrected = applyTargetedAccountShipment(carrierBase,
            asAccountDetailObservation(carrierBase, recognizedShipment), Date.now(),
            { existingCainiaoRouteAvailable: Boolean(storedCainiaoRoute(carrierBase)) });
          state = commitTargetShipmentRefresh(state, withDetailSelection(corrected, Date.now()), Date.now(), lease).state;
        }
      }
    }
    const shipment = state.shipments.find(s => s.identity.id === original.identity.id)!;
    writeDiagnostic("detail.refresh.stage_succeeded", {
      flowId, source, stage: "account_detail", durationMs: Date.now() - startedAt,
      ...shipmentDiagnosticDetails(shipment, "v5_query", incoming.timeline),
    });
    requestWidgetReload();
    await replayPendingShipmentNotifications(lease.isCurrent);
    return { state, shipment, refreshed: shipmentEffectiveFingerprint(original) !== shipmentEffectiveFingerprint(shipment),
      querySucceeded: true, completedSourceQuery: true,
      detailEntry: { fingerprint: detailRequestFingerprint(shipment, state),
        gaveTimeline: timedTracks(incoming.timeline.tracks).length > 0 } };
  } catch (error) {
    rethrowStageCancellation(lease.signal, () => writeDiagnostic("detail.refresh.stage_failed", {
      flowId, source, stage: "account_detail", durationMs: Date.now() - startedAt,
      ...shipmentDiagnosticDetails(original, "v5_query"), errorCategory: "cancelled",
    }, "warning"));
    // A rejected alignment reservation never reached this provider's transport.
    if (!reservationFailed) recordRefreshProviderResult({ key, provider: "account_detail",
      identityFingerprint: providerFingerprint, result: refreshProviderResultForError(error) });
    writeDiagnostic("detail.refresh.stage_failed", {
      flowId, source, stage: "account_detail", durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error),
      ...shipmentDiagnosticDetails(original, "v5_query"),
    }, "warning");
    const state = loadState();
    const shipment = state.shipments.find(s => s.identity.id === original.identity.id);
    if (!shipment) throw new Error("该快递已从列表中移除");
    return { state, shipment, refreshed: false, querySucceeded: false, detailEntry: observation };
  }
}
