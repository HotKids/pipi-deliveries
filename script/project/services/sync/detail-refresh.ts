/** Targeted per-shipment detail refresh flow, JD H5 reopen, Cainiao H5 fallback, and manual contest runner. */
import { sharedData, withSharedFileTransaction } from "../shared-file-transaction";
import { normalizeTimelineSlot, TIMELINE_SLOT } from "../timeline-slot";
import type { AppState, Shipment } from "../../models";
import { accountOrderTextWaybill, accountParcelWithExistingProjection, normalizeAccountParcelCarrierBestEffort, parcelToShipment, applyEnhancementMetadata, refreshAccountParcel, withRecognizedAccountOrderTextWaybill } from "../account-sync";
import type { AccountParcelDto } from "../account-parser";
import { queryManualForSource, type ManualQueryOutcome } from "../manual-query";
import { replayPendingShipmentNotifications } from "../notifications";
import { loadOrderProjectionReference, saveOrderProjectionReferences } from "../routes";
import { activateCainiaoManualFallback, applyManualShipment, rebaseManualTimelineCaches, applyTargetedAccountShipment, cainiaoAutomaticNeedsH5Supplement, clearCainiaoManualFallback, displayWaybill, FORCED_COMPLETION_REFRESH_WINDOW_MS, forcedCompletedAt, hasCachedKdniaoTimeline, hasEligibleShunFengManualTimeline, hasPickerTimelineStart, hasSettledTimelineHistory, hasUsableShipmentDynamics, hasTimelineStartBeforeKdniao, isJingDongSourceShipment, isShunFengSourceShipment, shipmentDetailCandidateEvidence, jingDongFeedReachedPickup, jingDongSignedGapCompletionAt, jingDongSignedHistoryGap, needsAutomaticManualFallback, needsDetailFallback, selectShipmentDetailTimeline, selectShipmentTimeline, shipmentDetailComplete, shipmentDetailIncompleteReason, shouldRefreshShipmentRow, shouldScheduleManualRefresh, refreshGateView, signedRefreshFrozen, statusAlignmentOutOfStep, statusAlignmentTimes, supportsOrdinaryAutomaticDetailSupplement, unprojectedAccountOrder, usesManualSourceQuery, withDetailSelection, withoutForcedCompletion } from "../shipment-policy";
import { bindingsForSource, commitTargetShipmentRefresh, loadState, stateRetentionExpired, pruneRoutesForState as safelyPruneRoutes, refreshValueFingerprint as shipmentEffectiveFingerprint } from "../storage";
import { normalizeWaybill, normalizedProjectedWaybill, containsTimelinePickupTrack, timedTracks, timelineLatestTrackAt } from "../status";
import { acquireRenewingDurableRefreshLease, durableRefreshLeaseRemainingMs } from "../refresh-runtime-state";
import { requestWidgetReload } from "../widgets";
import { alignmentOwnerCurrent } from "../status-alignment-state";
import { assertWithinDeadline, deadlineAfter, deadlineExpired, OperationTimeoutError, waitForRefresh } from "../deadline";
import { ACCOUNT_DETAIL_BUDGET_MS, ACCOUNT_H5_BUDGET_MS, ACCOUNT_ORDER_PROJECTION_BUDGET_MS, accountOrderReadyForProjection, accountOrderPageConfirmedEmpty, accountChildDeadline, shouldRetryAccountOrderProjection, shouldRetryAccountOrderProjectionUnprompted, accountOrderProjectionRetryReason, accountOrderProjectionRiskRemainingMs } from "../account-sync-policy";
import type { ExpressToastKey } from "../express-toast-copy";
import { accountParcelWithProjectionReference } from "../account-order-reference";
import { enhanceAccountParcels, enhancementPhone, withCurrentAccountEnhancement } from "../enhanced-account";
import { createDiagnosticFlowId, diagnosticErrorDetails, diagnosticState, writeDiagnostic } from "../logger";
import { SCRIPT_BINDING_SOURCE, requireScriptSource } from "../script-source";
import { SCRIPT_CLIENT_BUILD, SCRIPT_VERSION } from "../build-track";
import type { AccountOrderProjectionDiagnostics } from "../account-order-projection";
import { CarrierRecognitionBudget, recognizeNonSyncCarrier, type CarrierRecognitionResult } from "../carrier-recognition";
import { needsProjectedCarrierRepair, repairProjectedShipmentCarrier } from "../account-carrier-normalization";
import { carrierUnmatched } from "../carrier-gate";
import { GatewayError } from "../gateway";
import { trustedCainiaoH5Route, type CainiaoH5Diagnostics } from "../cainiao-h5";
import type { WebTimelineDiagnostics } from "../web-timeline";
import { needsManualPhoneTail, primaryH5Provider } from "../jt-h5";
import { runManualDetailSourceContest } from "../manual-detail-refresh";
import { projectionSceneActive } from "../projection-viewport";
import { recordSignedRelease } from "../row-ledger";
import {
  ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS,
  assertRefreshSignal,
  cainiaoH5DiagnosticDetails,
  DETAIL_MANUAL_REFRESH_BUDGET_MS,
  isCainiaoAutomaticShipment,
  MANUAL_QUERY_BUDGET_MS,
  operationRecognitionBudget,
  ownsProjectionAttempt,
  projectionOwnerFingerprint,
  projectionOwnerId,
  recognizeAwaitingCarrier,
  rejectForeignManualResult,
  rethrowRefreshCancellation,
  rethrowStageCancellation,
  rowClassifyAnchor,
  shipmentDiagnosticDetails,
  stageBudgetMs,
  withRuntimeManualRefreshAttempt,
  type DeferredRouteMutations,
  type ProjectionAttemptField,
  type ShipmentRefreshOptions,
  type ShipmentRefreshResult,
  type SyncRuntimeState,
  type TargetRefreshLease,
} from "./shared";
import { deferIncomingRoute, publishDeferredRoutes } from "./route-publications";
import {
  refreshCainiaoH5,
  refreshWebTimeline,
  storedCainiaoRoute,
  storedJingDongProjectionRoute,
} from "./h5-capture";
import {
  heldCarrierSettleable,
  heldProjectionParcel,
  legacyOrderNumberGate,
  orderProjectionFailureRetry,
  projectAccountOrderWithCarrier,
  projectionAttempt,
  projectionAwaitingCarrier,
  projectionCooldownKey,
  projectionFailureRetry,
  releaseExhaustedProjection,
  restoreEnhancementBlockedProjection,
  retainObservedProjectionRisk,
  trackProjectionAttempt,
  unionPageGaveAnswer,
  unionPageSceneGate,
  UnionPageSkipped,
  waitForProjectionAttemptRelease,
  withHeldProjection,
  withProjectionAttemptRecord,
  withProjectionRetry,
  type HeldProjection,
} from "./jd-order-projection";
import {
  cainiaoHasRealIncomingTracks,
  detailRequestFingerprint,
  productImageOwnerFingerprint,
  runDetailEntryQuery,
  shouldRequestDetailProductImage,
  statusAlignmentEntryQuerySupported,
} from "./cainiao-v5-supplement";

export type ShipmentRefreshRuntimeOverrides = Partial<{
  refreshAccountParcel: typeof refreshAccountParcel;
  queryManualForSource: typeof queryManualForSource;
  refreshWebTimeline: typeof refreshWebTimeline;
  refreshCainiaoH5: typeof refreshCainiaoH5;
  projectAccountOrderWithCarrier: typeof projectAccountOrderWithCarrier;
}>;

/**
 * 用户 2026-09-28：a detail refresh that logged detail.refresh.started still ends when the parent refresh is
 * cancelled — detail.refresh.skipped with skipReason "interrupted", Lite's and Pipi's end for an interrupted
 * detail refresh — before the cancellation escapes. The flow's own catches keep letting cancellation escape
 * first; the end is written here, where it leaves the flow.
 */
export async function runShipmentRefreshById(
  runtimeState: SyncRuntimeState,
  shipmentId: string,
  lease: TargetRefreshLease,
  options: ShipmentRefreshOptions = {},
  runtimeOverrides: ShipmentRefreshRuntimeOverrides = {},
): Promise<ShipmentRefreshResult> {
  const interrupted: { end?: () => void; releaseProjection?: () => void } = {};
  try {
    return await runShipmentRefreshFlow(runtimeState, shipmentId, lease, options, runtimeOverrides, interrupted);
  } catch (error) {
    if (lease.signal?.aborted) interrupted.end?.();
    throw error;
  } finally {
    interrupted.releaseProjection?.();
  }
}

async function runShipmentRefreshFlow(
  runtimeState: SyncRuntimeState,
  shipmentId: string,
  lease: TargetRefreshLease,
  options: ShipmentRefreshOptions,
  runtimeOverrides: ShipmentRefreshRuntimeOverrides,
  interrupted: { end?: () => void; releaseProjection?: () => void },
): Promise<ShipmentRefreshResult> {
  const runtime = {
    refreshAccountParcel,
    queryManualForSource,
    refreshWebTimeline: (
      shipment: Shipment,
      deadline?: number,
      observe?: Parameters<typeof refreshWebTimeline>[2],
      sig?: AbortSignal,
      onAttempted?: (authorized: boolean) => void,
      tails?: readonly string[],
      before?: () => void,
    ) => refreshWebTimeline(shipment, deadline, observe, sig, onAttempted, tails, before, runtimeState),
    refreshCainiaoH5: (
      shipment: Shipment,
      routeUrl: string,
      deadline?: number,
      observe?: Parameters<typeof refreshCainiaoH5>[3],
      sig?: AbortSignal,
      onAttempted?: (authorized: boolean) => void,
      before?: () => void,
    ) => refreshCainiaoH5(shipment, routeUrl, deadline, observe, sig, onAttempted, before, runtimeState),
    projectAccountOrderWithCarrier: (
      parcel: AccountParcelDto,
      projDeadline: number | undefined,
      recDeadline: number | undefined,
      observe?: Parameters<typeof projectAccountOrderWithCarrier>[3],
      sig?: AbortSignal,
      beforeLoad?: () => void,
      recBudget?: CarrierRecognitionBudget,
    ) => projectAccountOrderWithCarrier(parcel, projDeadline, recDeadline, observe, sig, beforeLoad, recBudget, runtimeState),
    ...runtimeOverrides,
  };
  const startedAt = Date.now();
  const flowId = createDiagnosticFlowId("detail");
  let base = loadState(startedAt);
  const initial = base.shipments.find(
    (item) => item.identity.id === shipmentId,
  );
  if (!initial) throw new Error("该快递已从列表中移除");
  let original = initial;
  // The frozen-join repair must keep its identity fence through the scheduled flow startup.
  if (lease.expectedFingerprint != null && detailRequestFingerprint(original, base) !== lease.expectedFingerprint) {
    return { state: base, shipment: original, refreshed: false, querySucceeded: false };
  }
  if (lease.expectedImageOwner != null && productImageOwnerFingerprint(original, base) !== lease.expectedImageOwner) {
    return { state: base, shipment: original, refreshed: false, querySucceeded: false };
  }
  const source = requireScriptSource(
    original.identity.bindingSource || SCRIPT_BINDING_SOURCE,
  );
  const deadlineAtMs = lease.deadlineAtMs;
  const signal = lease.signal;
  const trigger = options.trigger || "detail_open";
  // 用户 2026-10-02「加一个限制 头条跟状态有一个更新时 另外（包含本地详情页）就要强制刷新跟上（以时间为准）」，弹窗
  // 「同取件码强刷（推荐）」：状态对齐强刷跑这一行显式下拉的链（iOS 下拉不问 Online，EXPRESS_THREE_CLIENT_PARITY
  // ShunFeng 一行；顺丰来源件例外，见下面 picker_query「四端都先问 Picker」），越过签收冻结、完整缓存 / 详情已完整闸、
  // owner 自身揽收闸与普通冷却；风控冷却、京东联合页按订单冷却、付费快递鸟的触发条件与冷却照旧。
  const aligning = trigger === "status_alignment";
  let queryReservationFailed = false;
  const beforeQuery = aligning && options.beforeQuery ? () => {
    try { options.beforeQuery!(); }
    catch (error) { queryReservationFailed = true; throw error; }
  } : undefined;
  const pull = trigger === "detail_pull" || aligning;
  let identityApplied = false;
  if (trigger === "product_image" && options.requestProductImage &&
      shouldRequestDetailProductImage(original, base.bindings)) {
    const reference = accountParcelWithProjectionReference(original, null, "", true);
    if (reference) {
      const [metadata] = await enhanceAccountParcels([reference], bindingsForSource(base, source),
        { purpose: "image", deadlineAtMs, signal, flowId, trigger });
      const enriched = applyEnhancementMetadata(original, metadata, Date.now());
      if (enriched !== original) {
        const commit = commitTargetShipmentRefresh(base, enriched, Date.now(), lease);
        base = commit.state;
        original = base.shipments.find(shipment => shipment.identity.id === shipmentId)!;
        identityApplied = commit.applied;
        if (!original) throw new Error("该快递已从列表中移除");
      }
    }
  }
  if (trigger === "product_image") return { state: base, shipment: original, refreshed: identityApplied };
  // Old cached feed text can resolve identity without waiting for another provider response.
  // T23 (user 2026-09-26, 跨端对齐裁决 #28): its waybill — or a union-page waybill held for its carrier — is recognised
  // first and projected only with a matched carrier; otherwise the order stays as it is and no page is opened here.
  if (unprojectedAccountOrder(original)) {
    const cachedReference = accountParcelWithProjectionReference(original, null, "");
    const reference = cachedReference && withCurrentAccountEnhancement(cachedReference, base.bindings);
    const held = original.identity.pendingProjection;
    const recognitionDeadlineAtMs = accountChildDeadline(deadlineAtMs, ACCOUNT_DETAIL_BUDGET_MS);
    let parcel = reference;
    if (reference && accountOrderTextWaybill(reference)) {
      parcel = await withRecognizedAccountOrderTextWaybill(reference,
        { deadlineAtMs: recognitionDeadlineAtMs, signal, budget: operationRecognitionBudget(lease) });
    } else if (reference && !reference.enhancedMode && held?.waybill && heldCarrierSettleable(held.waybill, Date.now())) {
      const candidate = releaseExhaustedProjection(
        await normalizeAccountParcelCarrierBestEffort(heldProjectionParcel(reference, held),
          { deadlineAtMs: recognitionDeadlineAtMs, signal, budget: operationRecognitionBudget(lease) }),
        reference.rawCourierCode,
      );
      if (!projectionAwaitingCarrier(candidate)) parcel = candidate;
    }
    assertRefreshSignal(signal);
    if (!lease.isCurrent()) throw new OperationTimeoutError();
    const incoming = parcel && parcelToShipment(parcel, bindingsForSource(base, source).map(b => b.phone), Date.now());
    if (incoming && (normalizedProjectedWaybill(incoming.identity) ||
      incoming.identity.productImageURL !== original.identity.productImageURL)) {
      const local = reference?.enhancedMode
        ? applyEnhancementMetadata(original, parcel!, Date.now())
        : applyTargetedAccountShipment(original, incoming, Date.now());
      const commit = commitTargetShipmentRefresh(base, local, Date.now(), lease);
      identityApplied = commit.applied;
      if (identityApplied) requestWidgetReload();
      base = commit.state;
      original = base.shipments.find(s => s.identity.id === shipmentId)!;
      if (!original) throw new Error("该快递已从列表中移除");
    }
  }
  // 签收冻结（用户 2026-10-02「头条 状态 详情页 都推进到了签收状态（之前京东定的那种临时签收例外）就冻结快递 后续不再进行
  // 任何刷新」）：状态、头条、本地详情都到了签收的行，本机不再为它发任何逐票请求——打开详情、详情下拉、状态对齐强刷、手动链、
  // 京粉页、快递100、快递鸟都不跑，详情页照常显示缓存。右滑签收的行（用户 2026-10-02「我已取件这种硬冻结 也要等三态都是签收
  // 才冻结」，iOS 右滑签收统一适用同一硬冻结条件）在来源三态到签收或点击满 72 小时后硬冻结，之前与普通行一样刷新。
  // 承运商识别不在冻结之列（协调方规格「身份不是刷新」）：普通行照旧先识别承运商。用户 2026-10-03「硬冻结也照常识别承运商」
  // （优化 4）：右滑签收硬冻结的行与三态冻结的行一样先识别承运商（只认身份，不刷轨迹、不发通知），再在下面停下。
  // 还没投影出运单号的京东订单从不冻结（用户 2026-10-02 未投影出真实运单号前不冻结，取到运单号后再判定，signedTripleReached）。
  const signedFrozen = signedRefreshFrozen(original, Date.now());
  const skipSignedFrozen = (shipment: Shipment, state: AppState): ShipmentRefreshResult => {
    writeDiagnostic("detail.refresh.skipped", {
      flowId,
      source: shipment.identity.bindingSource || state.activeSource,
      trigger,
      ...diagnosticState(state),
      ...shipmentDiagnosticDetails(shipment),
      skipReason: "signed_frozen",
      result: "signed_frozen",
    });
    return { state, shipment, refreshed: identityApplied, skipReason: "signed_frozen" };
  };
  // T23 (user 2026-09-26): a row showing a real waybill without a matched carrier is recognised again on its detail
  // page and on a pull, and the carrier is committed on its own. A manual row has no account query to wait for, so it
  // is asked here; an automatic row is asked after its own account query (below, and in the entry query), as the
  // projected-order repair always was.
  const commitRecognizedCarrier = async (): Promise<void> => {
    const recognized = await recognizeAwaitingCarrier(original!,
      accountChildDeadline(deadlineAtMs, ACCOUNT_DETAIL_BUDGET_MS), signal, operationRecognitionBudget(lease));
    assertRefreshSignal(signal);
    if (!lease.isCurrent()) throw new OperationTimeoutError();
    if (recognized === original) return;
    const commit = commitTargetShipmentRefresh(base, recognized, Date.now(), lease);
    if (commit.applied) {
      identityApplied = true;
      requestWidgetReload();
    }
    base = commit.state;
    const current = base.shipments.find(s => s.identity.id === shipmentId);
    if (!current) throw new Error("该快递已从列表中移除");
    original = current;
  };
  if (original.identity.manuallyAdded && carrierUnmatched(original)) await commitRecognizedCarrier();
  if (trigger === "detail_open") {
    if (signedFrozen) return skipSignedFrozen(original, base);
    const entry = await runDetailEntryQuery(base, original, lease, runtime.refreshAccountParcel, flowId, false, undefined, runtimeState);
    // Entry query text may resolve the identity. Otherwise the original projection path runs
    // independently of history completeness, under the same lease and page cooldown.
    if (unprojectedAccountOrder(entry.shipment)) {
      const projection = await runShipmentRefreshById(runtimeState, shipmentId, lease, {
        ...options, trigger: "identity_projection", forceAccountOrderProjection: true,
        requestProductImage: false,
        forceManualRefresh: false, includeKdniaoFallback: false,
      }, runtimeOverrides);
      return { ...projection, refreshed: identityApplied || entry.refreshed || projection.refreshed,
        detailEntry: entry.detailEntry };
    }
    return { ...entry, refreshed: identityApplied || entry.refreshed };
  }
  if (aligning && !signedFrozen && statusAlignmentEntryQuerySupported(original)) {
    // An explicit pull follows the detail page's own entry query; the alignment run asks it first, past the freeze.
    const entry = await runDetailEntryQuery(base, original, lease, runtime.refreshAccountParcel, flowId, true, beforeQuery, runtimeState);
    base = entry.state;
    original = entry.shipment;
    identityApplied ||= entry.refreshed;
    // 用户 2026-10-03「按件查询对齐了就不开菜鸟页」（优化 8-2）：菜鸟来源件按件详情问过以后，状态、头条与本地详情已不再
    // 对不上（与触发强刷同一个判断：任两个都有的时间相差不过五分钟），这次强刷就到此为止，不再开菜鸟页；仍对不上才往下走。
    const alignedTimes = statusAlignmentTimes(original, Date.now());
    if (isCainiaoAutomaticShipment(original) && (!alignedTimes || !statusAlignmentOutOfStep(alignedTimes))) {
      writeDiagnostic("detail.refresh.skipped", {
        flowId,
        source,
        trigger,
        ...diagnosticState(base),
        ...shipmentDiagnosticDetails(original),
        skipReason: "aligned_after_query",
        result: "aligned_after_query",
      });
      return { ...entry, state: base, shipment: original, refreshed: identityApplied };
    }
  }
  if (trigger === "identity_projection" && !unprojectedAccountOrder(original)) {
    return { state: base, shipment: original, refreshed: identityApplied };
  }
  // A projected order keeps its own repair below; any other automatic row is asked here (T23).
  if (!original.identity.manuallyAdded && !original.identity.accountOrder &&
      carrierUnmatched(original)) await commitRecognizedCarrier();
  // Only an explicit detail pull can finish incomplete source history after the shared freeze.
  if (signedFrozen) {
    const forcedAt = forcedCompletedAt(original);
    // An explicit pull may finish source history; it cannot bypass the independent 72-hour sign-off freeze.
    const repairHistory = trigger === "detail_pull" &&
      (!forcedAt || Date.now() - forcedAt < FORCED_COMPLETION_REFRESH_WINDOW_MS) &&
      shipmentDetailIncompleteReason(withoutForcedCompletion(original)) !== null;
    if (!repairHistory) return skipSignedFrozen(original, base);
  }
  const missingHistoryRefresh = trigger === "missing_history" &&
    !hasUsableShipmentDynamics(original) && !original.emptyTimelineHiddenAtMs;
  if (original.emptyTimelineHiddenAtMs) {
    return { shipment: original, state: base, refreshed: false };
  }
  // The shared Home resolver already borrows eligible cached structured status.
  // A detail package's legacy or prose-derived semantic cannot satisfy that gap.
  // A right-swipe signed row inside its refresh window reads its own status here (用户 2026-10-02「显示已签收、照常刷新」).
  const lacksStatus = (shipment: Shipment) =>
    selectShipmentTimeline(refreshGateView(shipment)).semantic === "UNKNOWN";
  const missingStatusRefresh = pull &&
    !unprojectedAccountOrder(original) && lacksStatus(original);
  const usableManualSupplement = (shipment: Shipment | null | undefined): shipment is Shipment =>
    !!shipment && (timedTracks(shipment.timeline.tracks).length > 0 ||
      (missingStatusRefresh && shipment.timeline.structuredStatus === true &&
        shipment.timeline.semantic !== "UNKNOWN"));
  let querySucceeded: boolean | undefined;
  let queryFailureObserved = false;
  let emptyResponseObserved = false;
  const observeManualOutcome = (outcome: ManualQueryOutcome) => {
    queryFailureObserved ||= outcome.result === "query_failed";
    emptyResponseObserved ||= outcome.result === "empty_response";
    return outcome;
  };
  let completedSourceQuery = false;
  let sourceAccessRejected = false;
  const onQueryAttempted = (authorized: boolean) => {
    if (authorized) completedSourceQuery = true;
    else sourceAccessRejected = true;
  };
  const needsAutomaticFallback = needsAutomaticManualFallback(original);
  // Complete history suppresses timeline supplementation; explicit missing-status
  // repair still needs structured evidence from an allowed provider.
  const incompleteReason = shipmentDetailIncompleteReason(original);
  const detailComplete = incompleteReason === null;
  // The alignment run is not stopped by complete cached history (用户 2026-10-02「同取件码强刷」).
  const historyRefreshOpen = aligning || !detailComplete;
  const requestedJingDongDetailSupplement = historyRefreshOpen &&
    isJingDongSourceShipment(original) && (
      pull ||
      missingHistoryRefresh
    );
  const explicitTimelineRefresh = historyRefreshOpen && (
    missingHistoryRefresh ||
    pull ||
    trigger === "manual_submit" ||
    requestedJingDongDetailSupplement
  );
  assertRefreshSignal(signal);
  assertWithinDeadline(deadlineAtMs);
  writeDiagnostic("detail.refresh.started", {
    flowId,
    source,
    trigger,
    detailStatusSemantic: selectShipmentDetailTimeline(original).semantic,
    missingStatusRefresh,
    unprojectedOrder: unprojectedAccountOrder(original),
    detailComplete,
    incompleteReason: incompleteReason ?? undefined,
    scriptVersion: SCRIPT_VERSION,
    clientBuild: SCRIPT_CLIENT_BUILD,
    baseActiveSource: base.activeSource,
    baseRevision: base.revision,
    ...shipmentDiagnosticDetails(original),
  });
  interrupted.end = () => writeDiagnostic("detail.refresh.skipped", {
    flowId,
    source,
    durationMs: Date.now() - startedAt,
    ...shipmentDiagnosticDetails(original!),
    persisted: false,
    skipReason: "interrupted",
    result: "interrupted",
  });
  const forceAccountOrderProjection = Boolean(
    unprojectedAccountOrder(original) && isJingDongSourceShipment(original),
  );
  const usesManualQuery = usesManualSourceQuery(original);
  const jingDongProjectionRoute = storedJingDongProjectionRoute(
    original,
    startedAt,
  );
  const settledHistory = hasSettledTimelineHistory(original);
  const requestedKuaidi100Timeline = explicitTimelineRefresh && (
    original.identity.manuallyAdded ||
    isShunFengSourceShipment(original)
  );
  const requestedFinalFallback = Boolean(
    options.includeKdniaoFallback === true &&
    explicitTimelineRefresh &&
    !unprojectedAccountOrder(original) &&
    needsDetailFallback(original) &&
    !hasCachedKdniaoTimeline(original),
  );
  const refreshDue = forceAccountOrderProjection ||
    missingStatusRefresh || missingHistoryRefresh ||
    Boolean(options.forceManualRefresh) ||
    requestedJingDongDetailSupplement ||
    requestedKuaidi100Timeline ||
    requestedFinalFallback ||
    (explicitTimelineRefresh && needsAutomaticFallback) ||
    (!settledHistory && (
      Boolean(jingDongProjectionRoute || options.includeKdniaoFallback) ||
      (usesManualQuery || needsAutomaticFallback
        ? shouldScheduleManualRefresh(withRuntimeManualRefreshAttempt(original, Date.now()), Date.now())
        : shouldRefreshShipmentRow(original, Date.now()))
    ));
  if (!refreshDue) {
    writeDiagnostic("detail.refresh.skipped", {
      flowId,
      source: original.identity.bindingSource || base.activeSource,
      ...diagnosticState(base),
      ...shipmentDiagnosticDetails(original),
      skipReason: "not_due",
      result: "not_due",
    });
    return { shipment: original, state: base, refreshed: false };
  }
  const sourceBindings = bindingsForSource(base, source);
  const routeMutations: DeferredRouteMutations = new Map();
  // Status-only repair keeps the complete package already displayed by this detail page.
  let refreshed = missingStatusRefresh && detailComplete
    ? withDetailSelection(original, startedAt) : original;
  let cainiaoRouteUrl = storedCainiaoRoute(original, startedAt);
  let changed = false;
  let expressToast: ExpressToastKey | "" = "";
  let expressToastRemainingMs = 0;
  let stage = "dispatch";
  let carrierRepair: CarrierRecognitionResult | null = null;
  /**
   * 这一轮开始前**存储里**那一行，让提交栅栏始终拿它跟存储比。承运商修复和下面那次接口 5 按件
   * 详情都会替换 `original`，两者都必须先在这里留下存储版本。
   */
  let storedRowBaseline: Shipment | null = null;
  if (needsProjectedCarrierRepair(original.identity)) {
    // The projected identity lacks a valid built-in carrier: recognise the real waybill. `base`
    // stays the stored state: the commit fence compares its copy of the shipment with storage,
    // so the repair travels in `refreshed` only.
    try {
      const recognition = await recognizeNonSyncCarrier(
        normalizedProjectedWaybill(original.identity),
        { deadlineAtMs, signal, budget: operationRecognitionBudget(lease),
          // 优化 5 (user 2026-10-03): the row's own waybill-reuse anchor goes with the paid stage, the one it first sent.
          parcelAnchorAtMs: rowClassifyAnchor(original) },
      );
      const repaired = repairProjectedShipmentCarrier(
        original, recognition.normalization, recognition.displayName);
      if (repaired !== original) {
        carrierRepair = recognition;
        // The later stages read the repaired carrier from `original`, but the commit fence and
        // the account-error gate must still see the row as it was stored: comparing the repaired
        // row with itself made the repair look like "no change" and never committed it, and an
        // early `changed = true` swallowed a real projection error at the `!changed` gate below.
        storedRowBaseline = original;
        original = repaired;
        refreshed = repaired;
        writeDiagnostic("detail.refresh.carrier_repaired", {
          flowId,
          source,
          carrierCode: repaired.identity.courierCode,
        });
      }
    } catch (error) {
      rethrowRefreshCancellation(error, signal);
    }
  }
  try {
      let accountError: unknown = null;
      // The entry query is already committed. Nonempty query history can still be incomplete;
      // only the shared completeness check above may satisfy the requested history repair.
      // 已签收、feed 有揽收但显示的历史没到签收：只有详情下拉放行一次京粉页（见 jingDongSignedHistoryGap）。
      const signedHistoryGap = trigger === "detail_pull" && requestedJingDongDetailSupplement &&
        jingDongSignedHistoryGap(original);
      // The owner's own pickup does not stop the alignment run; the per-order cooldown below still does.
      const unionPageAllowed = aligning || !isJingDongSourceShipment(original) ||
        forceAccountOrderProjection || !jingDongFeedReachedPickup(original) || signedHistoryGap;
      if (original.accountRecord && isJingDongSourceShipment(original) && unionPageAllowed &&
          (requestedJingDongDetailSupplement || forceAccountOrderProjection)) {
        stage = "cached_order_projection";
        try {
          let projectionCaptured = false;
          let projectionRetry:
            Shipment["identity"]["orderProjectionRetry"] = undefined;
          // T23: a projection held for its carrier, and a reservation that loaded no page to give back.
          let heldProjection: HeldProjection | null = null;
          let projectionRestore: { retry: Shipment["identity"]["orderProjectionRetry"] } | null = null;
          let reopenRetry: Shipment["identity"]["jingDongH5Retry"] = undefined;
          // 用户 2026-10-03「所有开京粉页的路都检查」（代码 4）：a reservation the scene gate gave back before any page loaded.
          let pageSkippedRestore: {
            ownerId: string;
            routeHash: string;
            attemptId: string;
            field: ProjectionAttemptField;
            retry: Shipment["identity"]["orderProjectionRetry"];
            enhancementBlocked: boolean;
          } | null = null;
          let querySucceededBeforePage: boolean | undefined;
          // 用户 2026-10-03「这轮就统一」（优化 1）：the signed generation this load belongs to, and whether the page answered.
          const signedGapCompletedAt = jingDongSignedGapCompletionAt(original);
          let unionPageAnswered = false;
          const savedProjectionUrl = original.identity.accountOrder
            ? loadOrderProjectionReference(
                original.identity.id,
                source,
                Date.now(),
              )
            : "";
          let parcel = accountParcelWithProjectionReference(
            original,
            null,
            savedProjectionUrl,
          );
          // Signed parcels may repair incomplete detail on explicit pull. An old expanded
          // capture does not satisfy current history; the existing order cooldown still applies.
          const reopenForTimeline = Boolean(
            normalizedProjectedWaybill(original.identity) &&
              requestedJingDongDetailSupplement &&
              // The feed owns every field it provides, the timeline included: the H5 page is
              // captured ONLY while the feed's own incremental cache is still incomplete (user
              // rule, 2026-09-04). This holds for an explicit pull too — a pull on a parcel whose
              // feed already reaches 揽收 has nothing to add, and the load would take that order's
              // ten-minute cooldown slot away from a capture that is actually needed. 判据是**揽收**
              // （用户定 2026-09-04）：只有「已下单」不算，与 Pipi 的 hasPickupEvidence 同义。
              // 例外（2026-09-24）：已签收而显示的历史没到签收，签收节点只在京粉页里，下拉放行一次。
              (!jingDongFeedReachedPickup(original) || signedHistoryGap) &&
              parcel?.projectionUrl,
          ) || Boolean(
            // 状态对齐强刷（用户 2026-10-02「同取件码强刷」）越过 feed 揽收这道闸；按订单冷却照旧（下面同一个判断）。
            aligning && normalizedProjectedWaybill(original.identity) &&
              requestedJingDongDetailSupplement && parcel?.projectionUrl,
          );
          if (
                        parcel?.accountOrder &&
            (!enhancementPhone(parcel, base.bindings) || reopenForTimeline) &&
            (parcel.projectionUrl || parcel.textIdentity?.waybill) &&
            (forceAccountOrderProjection || accountOrderReadyForProjection(
              parcel.normalizedStatusSemantic || parcel.semantic,
            )) &&
            (!normalizedProjectedWaybill(original.identity) || reopenForTimeline) &&
            !deadlineExpired(deadlineAtMs)
          ) {
            const ownerId = projectionOwnerId(parcel);
            const ownerFingerprint = projectionOwnerFingerprint(ownerId);
            const routeHash = projectionCooldownKey(parcel);
            const freshBase = loadState();
            const freshOwner = freshBase.shipments.find(
              (shipment) => shipment.identity.id === ownerId,
            );
            if (
              freshOwner &&
              normalizedProjectedWaybill(freshOwner.identity) &&
              !reopenForTimeline
            ) {
              parcel = accountParcelWithExistingProjection(parcel, [freshOwner]);
              writeDiagnostic("order.projection.skipped", {
                flowId,
                source,
                stage: "detail_webview",
                ownerFingerprint,
                result: "already_projected",
              });
            } else if (
              !reopenForTimeline && (
                freshOwner?.identity.pendingProjection?.waybill ||
                (parcel.textIdentity?.waybill &&
                  !heldCarrierSettleable(parcel.textIdentity.waybill, Date.now()))
              )
            ) {
              // T23 (user 2026-09-26): the order already has its waybill (a held union page, or feed text) and only
              // lacks a carrier; recognition ran at the start of this refresh, so no page is loaded for it.
              writeDiagnostic("order.projection.skipped", {
                flowId,
                source,
                stage: "detail_webview",
                ownerFingerprint,
                result: "carrier_pending",
              });
            } else if (
              runtimeState.activeProjectionAttempts.has(ownerId) ||
              ((reopenForTimeline || !parcel.textIdentity?.waybill) && !(
                // 方案 A (2026-09-25): detail entry leaves a confirmed empty page closed; an explicit
                // pull is the user's own request and bypasses only the ordinary rest.
                trigger === "identity_projection" && !reopenForTimeline
                  ? shouldRetryAccountOrderProjectionUnprompted(
                      freshOwner?.identity.orderProjectionRetry,
                      routeHash,
                      Date.now(),
                    )
                  : shouldRetryAccountOrderProjection(
                      reopenForTimeline
                        ? freshOwner?.identity.jingDongH5Retry
                        : freshOwner?.identity.orderProjectionRetry,
                      routeHash,
                      Date.now(),
                      trigger === "detail_pull" ? "detail_pull" : "automatic",
                    )
              ))
            ) {
              const gatingRetry = reopenForTimeline
                ? freshOwner?.identity.jingDongH5Retry
                : freshOwner?.identity.orderProjectionRetry;
              const reason = runtimeState.activeProjectionAttempts.has(ownerId) ? "active_attempt"
                : trigger === "identity_projection" && !reopenForTimeline &&
                    accountOrderPageConfirmedEmpty(gatingRetry, routeHash) ? "confirmed_empty"
                : accountOrderProjectionRetryReason(gatingRetry, routeHash);
              if (reason === "risk_control_cooldown") {
                if (trigger === "detail_pull") expressToast = "jdRiskControl";
                expressToastRemainingMs = accountOrderProjectionRiskRemainingMs(gatingRetry, routeHash);
              }
              writeDiagnostic("order.projection.skipped", {
                flowId,
                source,
                stage: "detail_webview",
                ownerFingerprint,
                result: reason ?? undefined,
                ...(reopenForTimeline ? { reopen: true } : {}),
              });
            } else if (
              freshOwner &&
              (reopenForTimeline || !parcel.textIdentity?.waybill) &&
              !projectionSceneActive()
            ) {
              // 用户 2026-10-03「所有开京粉页的路都检查」（代码 4）：开京粉页前判 App 是否在前台（场景 active），不在就跳过
              // 这一级——不预约、不占按订单冷却、不算放行用掉——后面各级照常；与列表全量刷新那条路同一个跳过原因。
              writeDiagnostic("order.projection.skipped", {
                flowId,
                source,
                stage: "detail_webview",
                ownerFingerprint,
                result: "not_foreground",
                ...(reopenForTimeline ? { reopen: true } : {}),
              });
            } else if (freshOwner) {
              const attemptId = createDiagnosticFlowId("projection");
              const projectionDeadlineAtMs = accountChildDeadline(
                deadlineAtMs,
                ACCOUNT_ORDER_PROJECTION_BUDGET_MS,
              );
              const attemptDeadlineAtMs = accountChildDeadline(
                deadlineAtMs,
                ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS,
              );
              const attemptField: ProjectionAttemptField = reopenForTimeline
                ? "jingDongH5Retry"
                : "orderProjectionRetry";
              const reserved = projectionAttempt(
                freshOwner,
                routeHash,
                attemptId,
                Date.now(),
                attemptDeadlineAtMs,
                attemptField,
              );
              const reservationCommit = commitTargetShipmentRefresh(
                freshBase,
                reserved,
                Date.now(),
                lease,
              );
              const reservedOwner = reservationCommit.state.shipments.find(
                (shipment) => shipment.identity.id === ownerId,
              );
              if (!ownsProjectionAttempt(
                reservedOwner,
                routeHash,
                attemptId,
                Date.now(),
                attemptField,
              )) {
                parcel = reservedOwner &&
                    normalizedProjectedWaybill(reservedOwner.identity)
                  ? accountParcelWithExistingProjection(parcel, [reservedOwner])
                  : parcel;
                writeDiagnostic("order.projection.skipped", {
                  flowId,
                  source,
                  stage: "detail_webview",
                  ownerFingerprint,
                  result: "reserved_elsewhere",
                });
              } else {
                base = reservationCommit.state;
                original = reservedOwner!;
                refreshed = original;
                interrupted.releaseProjection = trackProjectionAttempt(runtimeState, ownerId);
                try {
                  saveOrderProjectionReferences([{
                    ownerId,
                    source,
                    url: parcel.projectionUrl,
                  }]);
                } catch {
                  /* the in-memory reference remains usable for this targeted attempt */
                }
                let projectionDiagnostics:
                  AccountOrderProjectionDiagnostics | null = null;
                writeDiagnostic("order.projection.started", {
                  flowId,
                  source,
                  stage: "detail_webview",
                  ownerFingerprint,
                  result: reopenForTimeline
                    ? "timeline_reopen"
                    : forceAccountOrderProjection ? "forced" : "scheduled",
                });
                try {
                  const unresolvedOwner = parcel.ownerId;
                  const unresolvedParcel = parcel;
                  const textProjection = !reopenForTimeline && Boolean(parcel.textIdentity?.waybill);
                  const projectedBefore = normalizedProjectedWaybill(original.identity);
                  querySucceededBeforePage = querySucceeded;
                  querySucceeded = false;
                  parcel = await runtime.projectAccountOrderWithCarrier(
                    // A reopen must load the page: the feed text identity would short-circuit it.
                    reopenForTimeline ? { ...parcel, textIdentity: undefined } : parcel,
                    projectionDeadlineAtMs,
                    deadlineAtMs,
                    (diagnostics) => {
                      projectionDiagnostics = diagnostics;
                    },
                    signal,
                    // 代码 4: asked again right before the page loads (the viewport wait can outlast the foreground).
                    () => {
                      if (!reopenForTimeline) legacyOrderNumberGate(parcel!);
                      unionPageSceneGate(); beforeQuery?.();
                    },
                    operationRecognitionBudget(lease),
                  );
                  assertRefreshSignal(signal);
                  projectionCaptured = true;
                  // Record the returned package before identity and cache guards can discard it.
                  const captured = parcel.projectionTimeline;
                  // 优化 1「拿到回答就算用掉」：the page answered — a package, partial or not, or a complete answer without
                  // logistics; risk control and a load that failed or timed out are no answer.
                  unionPageAnswered = !textProjection && unionPageGaveAnswer(projectionDiagnostics, captured);
                  writeDiagnostic("detail.timeline.candidate", {
                    flowId, source, stage: "detail_webview", timelineProvider: TIMELINE_SLOT.JD_H5,
                    effectiveTrackCount: timedTracks(captured?.tracks || []).length,
                    captureComplete: captured?.complete === true,
                    latestTrackAtMs: captured ? timelineLatestTrackAt(captured) : 0,
                    statusSemantic: captured?.semantic || "UNKNOWN",
                    structuredStatus: captured?.structuredStatus === true,
                    ...(captured ? shipmentDetailCandidateEvidence(original, captured) : {}),
                    result: captured ? "available" : "empty",
                  });
                  // AGENTS §9: the page was loaded, so the order rests for ten minutes (an hour
                  // after risk control) whichever way it went. Without this a successful but
                  // partial first projection left no record at all, and the very next detail
                  // render reopened the union page seconds later.
                  reopenRetry = projectionFailureRetry(
                    routeHash,
                    projectionDiagnostics,
                    Date.now(),
                  );
                  if (reopenForTimeline) {
                    if (normalizeWaybill(parcel.waybill) !== projectedBefore) {
                      // The reopened page must name the same carrier waybill; otherwise the
                      // existing projection stands and nothing from this load is applied.
                      parcel = accountParcelWithExistingProjection(
                        { ...parcel, waybill: parcel.ownerId, projectionTimeline: null },
                        [original],
                      );
                    }
                  } else {
                    // 跨端对齐裁决 #32: an exhausted recognition no longer holds the order at its order stage.
                    parcel = releaseExhaustedProjection(parcel, unresolvedParcel.rawCourierCode);
                  }
                  writeDiagnostic(
                    normalizeWaybill(parcel.waybill) !==
                        normalizeWaybill(unresolvedOwner)
                      ? "order.projection.extracted"
                      : "order.projection.empty",
                    {
                      flowId,
                      source,
                      stage: "detail_webview",
                      ownerFingerprint,
                      ...(projectionDiagnostics || {}),
                    },
                    normalizeWaybill(parcel.waybill) !==
                        normalizeWaybill(unresolvedOwner)
                      ? "info"
                      : "warning",
                  );
                  if (
                    normalizeWaybill(parcel.waybill) ===
                      normalizeWaybill(unresolvedOwner)
                  ) {
                    projectionRetry = orderProjectionFailureRetry(
                      original,
                      routeHash,
                      projectionDiagnostics,
                      Date.now(),
                    );
                  } else if (!reopenForTimeline && projectionAwaitingCarrier(parcel)) {
                    // T23（用户 2026-09-26，跨端对齐裁决 #28）：运单号拿到了、承运商没对上——订单保持原样、不推。页面给的运单号
                    // 与轨迹挂起（页面冷却照 §9 记，空壳计数按「页面给过运单号」清零）；文案没开页，投影记录恢复成预约前。
                    if (textProjection) {
                      projectionRestore = { retry: freshOwner.identity.orderProjectionRetry };
                    } else {
                      projectionRetry = orderProjectionFailureRetry(
                        original,
                        routeHash,
                        projectionDiagnostics,
                        Date.now(),
                        true,
                      );
                      heldProjection = {
                        waybill: normalizeWaybill(parcel.waybill),
                        timeline: parcel.projectionTimeline || null,
                        capturedAtMs: Date.now(),
                      };
                    }
                    writeDiagnostic("order.projection.rejected", {
                      flowId,
                      source,
                      stage: "detail_webview",
                      ownerFingerprint,
                      result: "carrier_pending",
                    });
                    parcel = unresolvedParcel;
                  } else {
                    projectionRetry = undefined;
                  }
                } catch (error) {
                  if ((error instanceof UnionPageSkipped || queryReservationFailed) && !signal?.aborted) {
                    // No page loaded when the scene or required alignment reservation refused it; preserve JD's rest.
                    pageSkippedRestore = { ownerId, routeHash, attemptId, field: attemptField,
                      retry: freshOwner.identity[attemptField],
                      enhancementBlocked: error instanceof UnionPageSkipped && error.reason === "enhancement_active" };
                    querySucceeded = querySucceededBeforePage;
                    writeDiagnostic("order.projection.skipped", {
                      flowId,
                      source,
                      stage: "detail_webview",
                      ownerFingerprint,
                      result: error instanceof UnionPageSkipped ? error.reason : "alignment_reservation_unavailable",
                      ...(reopenForTimeline ? { reopen: true } : {}),
                    });
                  } else {
                    if (signal?.aborted) retainObservedProjectionRisk(
                      ownerId, routeHash, attemptId, attemptField, projectionDiagnostics);
                    rethrowStageCancellation(signal, () => writeDiagnostic("order.projection.failed", {
                      flowId,
                      source,
                      stage: "detail_webview",
                      ownerFingerprint,
                      ...(projectionDiagnostics || {}),
                      errorCategory: "cancelled",
                    }, "warning"));
                    projectionRetry = orderProjectionFailureRetry(
                      original,
                      routeHash,
                      projectionDiagnostics,
                      Date.now(),
                    );
                    if (reopenForTimeline) reopenRetry = projectionRetry;
                    writeDiagnostic("order.projection.failed", {
                      flowId,
                      source,
                      stage: "detail_webview",
                      ownerFingerprint,
                      ...diagnosticErrorDetails(error),
                      ...(projectionDiagnostics || {}),
                    }, "warning");
                  }
                }
                if (projectionRetry?.riskControlAtMs || reopenRetry?.riskControlAtMs) {
                  // Unified express toast (AGENTS §11): the user asked for this detail and JD
                  // answered with risk control, so say why nothing new arrived.
                  expressToast = "jdRiskControl";
                  expressToastRemainingMs = accountOrderProjectionRiskRemainingMs(
                    reopenRetry || projectionRetry, routeHash,
                  );
                }
                const ownershipState = loadState();
                const ownershipOwner = ownershipState.shipments.find(
                  (shipment) => shipment.identity.id === ownerId,
                );
                if (!ownsProjectionAttempt(
                  ownershipOwner,
                  routeHash,
                  attemptId,
                  Date.now(),
                  attemptField,
                )) {
                  base = ownershipState;
                  if (!ownershipOwner) {
                    throw new Error("该快递已从列表中移除");
                  }
                  original = ownershipOwner;
                  refreshed = ownershipOwner;
                  parcel = null;
                  projectionRetry = undefined;
                  pageSkippedRestore = null;
                  writeDiagnostic("order.projection.skipped", {
                    flowId,
                    source,
                    stage: "detail_webview_commit",
                    ownerFingerprint,
                    result: "ownership_lost",
                  }, "warning");
                }
              }
            }
          }
          if (parcel && projectionCaptured) {
            const stateParcel = parcel;
            const incoming = parcelToShipment(
              stateParcel,
              sourceBindings.map((binding) => binding.phone),
              Date.now(),
            );
            if (incoming) {
              refreshed = applyTargetedAccountShipment(
                original,
                incoming,
                Date.now(),
                { existingCainiaoRouteAvailable: Boolean(cainiaoRouteUrl) },
              );
              if (incoming.route?.kind === "cainiao" && parcel.routeUrl) {
                cainiaoRouteUrl = parcel.routeUrl;
              }
              refreshed = deferIncomingRoute(
                refreshed,
                incoming,
                parcel.routeUrl,
                Date.now(),
                routeMutations,
              );
              if (
                projectionRetry &&
                !normalizedProjectedWaybill(refreshed.identity)
              ) {
                refreshed = {
                  ...refreshed,
                  identity: {
                    ...refreshed.identity,
                    orderProjectionRetry: projectionRetry,
                  },
                };
              }
              changed = true;
              querySucceeded = Boolean(normalizedProjectedWaybill(refreshed.identity)) ||
                timedTracks(parcel.projectionTimeline?.tracks || []).length > 0;
            }
          }
          if (
            projectionRetry &&
            !normalizedProjectedWaybill(refreshed.identity)
          ) {
            refreshed = {
              ...refreshed,
              identity: {
                ...refreshed.identity,
                orderProjectionRetry: projectionRetry,
              },
            };
            changed = true;
          }
          if (projectionRestore && !normalizedProjectedWaybill(refreshed.identity)) {
            refreshed = withProjectionRetry(refreshed, projectionRestore.retry);
            changed = true;
          }
          if (heldProjection && !normalizedProjectedWaybill(refreshed.identity)) {
            refreshed = {
              ...refreshed,
              identity: { ...refreshed.identity, pendingProjection: heldProjection },
            };
            changed = true;
          }
          if (pageSkippedRestore) {
            if (pageSkippedRestore.enhancementBlocked) {
              const state = restoreEnhancementBlockedProjection(pageSkippedRestore.ownerId,
                pageSkippedRestore.routeHash, pageSkippedRestore.attemptId,
                pageSkippedRestore.field, pageSkippedRestore.retry);
              const shipment = state.shipments.find(item => item.identity.id === pageSkippedRestore.ownerId);
              if (!shipment) throw new Error("该快递已从列表中移除");
              return { state, shipment, refreshed: identityApplied };
            }
            refreshed = withProjectionAttemptRecord(refreshed, pageSkippedRestore.field, pageSkippedRestore.retry);
            changed = true;
          }
          if (unionPageAnswered && signedGapCompletedAt > 0 && Date.now() >= signedGapCompletedAt) {
            // 优化 1：签收后（同一个完成时间 T）京粉页有过回答，这一代的签收缺口放行就用掉了（没轨迹、部分包也算）。
            recordSignedRelease(original.identity.id, signedGapCompletedAt, "jingDongUnionGap");
          }
          if (reopenRetry) {
            // Every page load rests the order (10 min, 60 min after risk control), whether it
            // was the first projection or a timeline reopen.
            refreshed = {
              ...refreshed,
              identity: {
                ...refreshed.identity,
                jingDongH5Retry: reopenRetry,
              },
            };
            changed = true;
          }
        } catch (error) {
          rethrowRefreshCancellation(error, signal);
          accountError = error;
        }
      }

      let enrichmentBase = refreshed;
      const enrichmentStartedAt = Date.now();
      let cainiaoDiagnostics: CainiaoH5Diagnostics | null = null;
      let webDiagnostics: WebTimelineDiagnostics | null = null;
      const cachedJingDongH5 = (enrichmentBase.manualTimelines || []).filter(
        timeline => normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.JD_H5,
      );
      // The standalone final fallback below still only asks whether a JD H5 capture has pickup.
      const jingDongAutomaticH5Available = cachedJingDongH5.some(
        timeline => containsTimelinePickupTrack(timeline.tracks),
      );
      // 用户 2026-09-24 采纳：缓存的京粉页包有揽收 ≠ 显示的历史有揽收。只有详情选包对这一包也判完整
      // （同一个 shipmentDetailCandidateEvidence：有揽收、最新节点不落后参照超过 30 分钟）时，它才替手动链作主；
      // 落后于列表的旧包会被更新的账号历史挤掉，显示出来的就没有揽收，K100 / 快递鸟照常要跑。
      // The alignment run (用户 2026-10-02) is stopped only by a complete page it loaded itself, never by a cached one.
      const jingDongAutomaticH5Complete = cachedJingDongH5.some(
        timeline => (!aligning || timeline.successAtMs >= startedAt) &&
          shipmentDetailCandidateEvidence(enrichmentBase, timeline).detailComplete,
      );
      // 用户 2026-10-02「付费快递鸟按原链（前面都没起点证据才问，其冷却也照旧）」：状态对齐强刷越过的那几道闸
      // （完整缓存、feed 自己的揽收、缓存里完整的京粉页）不替付费快递鸟打开；这一行在普通下拉里问得到快递鸟时，
      // 强刷才问，问之前照旧看前面各级攒下的起点证据（hasTimelineStartBeforeKdniao）。
      const paidFallbackGateOpen = !aligning || (!detailComplete && (
        isJingDongSourceShipment(enrichmentBase)
          ? !jingDongFeedReachedPickup(enrichmentBase) && !cachedJingDongH5.some(
            timeline => shipmentDetailCandidateEvidence(enrichmentBase, timeline).detailComplete)
          : supportsOrdinaryAutomaticDetailSupplement(enrichmentBase)
            ? needsAutomaticManualFallback(enrichmentBase)
            : true
      ));
      // Automatic feed pickup and a complete same-waybill H5 package stop the manual chain
      // before Picker. A cached manual origin is evaluated only after refreshing Picker.
      // The alignment run passes the owner's own pickup (用户 2026-10-02「同取件码强刷」).
      const jingDongManualFallbackRequested =
        requestedJingDongDetailSupplement &&
        !unprojectedAccountOrder(enrichmentBase) &&
        (aligning || !jingDongFeedReachedPickup(enrichmentBase)) &&
        !jingDongAutomaticH5Complete;
      let cainiaoH5Succeeded = false;
      // 用户定 2026-09-05：缓存里的详情已完整（有揽收）就不再重拉，下拉只绕节流。这道门看的是
      // **选中的详情包**（任一槽），不只是 feed：feed 没揽收但 k100_h5 缓存已完整时同样不跑。
      // 状态对齐强刷（用户 2026-10-02）越过完整缓存与 feed 揽收这两道闸，打开这一行自己的菜鸟页；只有 feed 本来就缺
      // 揽收时，菜鸟页落空才照旧转手动链（feed 已有揽收的菜鸟件，手动链的包不进详情选包，跑了也显示不出来）。
      const cainiaoOwnerNeedsH5 = cainiaoAutomaticNeedsH5Supplement(enrichmentBase);
      const cainiaoH5Requested = explicitTimelineRefresh &&
        (cainiaoOwnerNeedsH5 || (aligning && isCainiaoAutomaticShipment(enrichmentBase))) &&
        (aligning || !shipmentDetailComplete(enrichmentBase));
      if (cainiaoH5Requested) {
        querySucceeded = false;
        const cainiaoH5StartedAt = Date.now();
        const cainiaoH5DeadlineAtMs = accountChildDeadline(
          deadlineAtMs,
          ACCOUNT_H5_BUDGET_MS,
          0,
          cainiaoH5StartedAt,
        );
        stage = "cainiao_h5";
        writeDiagnostic("detail.refresh.stage_started", {
          flowId,
          source,
          stage,
          ...shipmentDiagnosticDetails(enrichmentBase, TIMELINE_SLOT.CN_H5),
          timelineProvider: TIMELINE_SLOT.CN_H5,
          routePresent: Boolean(cainiaoRouteUrl),
          routeTrusted: trustedCainiaoH5Route(cainiaoRouteUrl),
          budgetMs: stageBudgetMs(cainiaoH5DeadlineAtMs, cainiaoH5StartedAt),
        });
        try {
          const cainiaoH5 = await runtime.refreshCainiaoH5(
            enrichmentBase,
            cainiaoRouteUrl,
            cainiaoH5DeadlineAtMs,
            (diagnostics) => { cainiaoDiagnostics = diagnostics; },
            signal,
            onQueryAttempted,
            beforeQuery,
          );
          assertRefreshSignal(signal);
          if (cainiaoH5) {
            querySucceeded = true;
            // 用户定 2026-09-04：抓到节点 ≠ 抓够了。终止判据与全局一致——**揽收（PICKED）**。
            // 原来只要 H5 回了 ≥1 条带时间的节点就判成功并终止整条链，于是只抓到一条「已下单」
            // 时 picker / moto / 快递100 / kdniao 全都不跑，用户反复下拉也看不到揽收之后的轨迹。
            // 抓到的包照常保留（来源返回什么就存什么），只是不再拿它当链子的终点。
            const capturedCainiaoH5 = (cainiaoH5.manualTimelines || []).find(
              (timeline) =>
                normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.CN_H5,
            ) || null;
            // 用户 2026-09-24 采纳（三端，审计 D4）：有揽收还不够，这个菜鸟页包还要在详情选包里判完整——有揽收、
            // 最新节点不落后账号参照超过 30 分钟，与京粉页同一次评判（shipmentDetailCandidateEvidence）；落后于列表的
            // 旧包不再挡住后面的补查。
            cainiaoH5Succeeded = Boolean(
              capturedCainiaoH5 &&
                containsTimelinePickupTrack(capturedCainiaoH5.tracks) &&
                shipmentDetailCandidateEvidence(cainiaoH5, capturedCainiaoH5).detailComplete,
            );
            refreshed = cainiaoH5Succeeded
              ? clearCainiaoManualFallback(cainiaoH5)
              : cainiaoH5;
            enrichmentBase = refreshed;
            changed = true;
            writeDiagnostic("detail.refresh.stage_succeeded", {
              flowId,
              source,
              stage,
              ...shipmentDiagnosticDetails(refreshed, TIMELINE_SLOT.CN_H5,
                capturedCainiaoH5 || cainiaoH5.timeline),
              durationMs: Date.now() - cainiaoH5StartedAt,
              result: "timed_tracks",
              ...cainiaoH5DiagnosticDetails(cainiaoDiagnostics),
            });
          } else {
            emptyResponseObserved = true;
            writeDiagnostic("detail.refresh.stage_failed", {
              flowId,
              source,
              stage,
              ...shipmentDiagnosticDetails(refreshed, TIMELINE_SLOT.CN_H5),
              timelineProvider: TIMELINE_SLOT.CN_H5,
              durationMs: Date.now() - cainiaoH5StartedAt,
              result: "no_timed_tracks",
              ...cainiaoH5DiagnosticDetails(cainiaoDiagnostics),
            }, "warning");
          }
        } catch (error) {
          rethrowStageCancellation(signal, () => writeDiagnostic("detail.refresh.stage_failed", {
            flowId,
            source,
            stage,
            ...shipmentDiagnosticDetails(refreshed, TIMELINE_SLOT.CN_H5),
            timelineProvider: TIMELINE_SLOT.CN_H5,
            durationMs: Date.now() - cainiaoH5StartedAt,
            ...cainiaoH5DiagnosticDetails(cainiaoDiagnostics),
            errorCategory: "cancelled",
          }, "warning"));
          queryFailureObserved = true;
          writeDiagnostic("detail.refresh.stage_failed", {
            flowId,
            source,
            stage,
            ...shipmentDiagnosticDetails(refreshed, TIMELINE_SLOT.CN_H5),
            timelineProvider: TIMELINE_SLOT.CN_H5,
            durationMs: Date.now() - cainiaoH5StartedAt,
            ...diagnosticErrorDetails(error),
            ...cainiaoH5DiagnosticDetails(cainiaoDiagnostics),
          }, "warning");
        }
      }
      const cainiaoManualFallbackRequested = cainiaoH5Requested &&
        !cainiaoH5Succeeded && cainiaoOwnerNeedsH5;
      if (cainiaoManualFallbackRequested) {
        const activated = activateCainiaoManualFallback(refreshed);
        changed ||= activated !== refreshed;
        refreshed = activated;
        enrichmentBase = activated;
      }
      // The alignment run passes the owner's own pickup here as well (用户 2026-10-02).
      const ordinaryAutomaticSupplement = (shipment: Shipment) => aligning
        ? supportsOrdinaryAutomaticDetailSupplement(shipment)
        : needsAutomaticManualFallback(shipment);
      const ordinaryAutomaticSupplementRequested = explicitTimelineRefresh &&
        ordinaryAutomaticSupplement(enrichmentBase);
      const pickerSupplementRequested = missingStatusRefresh
        ? lacksStatus(enrichmentBase)
        : ordinaryAutomaticSupplementRequested || requestedKuaidi100Timeline ||
          jingDongManualFallbackRequested || cainiaoManualFallbackRequested;
      // A pull does not ask Online here (EXPRESS_THREE_CLIENT_PARITY ShunFeng row). 用户 2026-10-02 四端对齐强刷顺丰件均先查
      // Picker：状态对齐强刷里顺丰来源件先问 Online（Picker，v6_query refresh）——顺丰的列表头条归 Picker；
      // 其余行的强刷照旧不问。问过之后这一轮的其余各级照旧各跑一次。
      const alignmentAsksOnline = aligning && isShunFengSourceShipment(enrichmentBase);
      let pickerSupplementSucceeded = false;
      if (pickerSupplementRequested && (!aligning || alignmentAsksOnline) &&
          trigger !== "detail_pull" && !unprojectedAccountOrder(enrichmentBase)) {
        stage = "picker_query";
        const pickerOutcome = await runtime.queryManualForSource({
          onQueryAttempted,
          beforeQuery,
          source,
          bindings: sourceBindings,
          waybill: displayWaybill(enrichmentBase),
          phoneTail: enrichmentBase.identity.phoneTail,
          rawCourierCode: enrichmentBase.identity.rawCourierCode,
          courierCode: enrichmentBase.identity.courierCode,
          companyName: enrichmentBase.identity.companyName,
          sourceProvider: enrichmentBase.identity.sourceProvider,
          deadlineAtMs: accountChildDeadline(
            deadlineAtMs,
            DETAIL_MANUAL_REFRESH_BUDGET_MS,
          ),
          pickerOnly: true,
          currentShipment: enrichmentBase,
          diagnosticFlowId: flowId,
          diagnosticStage: stage,
          signal,
        }).catch((error): ManualQueryOutcome => {
          if (!(error instanceof OperationTimeoutError) || queryReservationFailed) throw error;
          rethrowRefreshCancellation(error, signal);
          // An Online child deadline must not cancel the remaining original chain.
          writeDiagnostic("detail.refresh.stage_failed", { flowId, source, stage,
            ...shipmentDiagnosticDetails(refreshed, TIMELINE_SLOT.V6_QUERY),
            ...diagnosticErrorDetails(error) }, "warning");
          return { shipment: null, pending: null, routeUrl: "", result: "query_failed" };
        }).then(observeManualOutcome);

        assertRefreshSignal(signal);
        if (isShunFengSourceShipment(enrichmentBase)) {
          const latest = loadState();
          const current = latest.shipments.find(item => item.identity.id === original.identity.id);
          if (!alignmentOwnerCurrent(base, original, latest)) {
            if (!current) throw new Error("该快递已从列表中移除");
            return { state: latest, shipment: current, refreshed: false };
          }
          // Online completion must be judged against state accepted while the request was pending.
          refreshed = rebaseManualTimelineCaches(current!, refreshed, Date.now());
          enrichmentBase = refreshed;
        }
        const pickerShipment = rejectForeignManualResult(
          refreshed,
          pickerOutcome.shipment,
          { flowId, source, stage, timelineProvider: TIMELINE_SLOT.V6_QUERY },
        );
        if (usableManualSupplement(pickerShipment)) {
          pickerSupplementSucceeded = true;
          refreshed = applyManualShipment(
            refreshed,
            pickerShipment,
            Date.now(),
          );
          enrichmentBase = refreshed;
          changed = true;
        }
      }
      const hasRealWaybill = !unprojectedAccountOrder(enrichmentBase);
      // A prior Online origin remains paid-fallback evidence, but must not block a
      // requested free refresh while the selected current detail is incomplete.
      const primaryNeeded = missingStatusRefresh
        ? lacksStatus(enrichmentBase)
        : pull
          ? aligning || !shipmentDetailComplete(enrichmentBase)
          : !hasPickerTimelineStart(enrichmentBase);
      const ordinaryAutomaticPrimaryRequested = explicitTimelineRefresh && (
        ordinaryAutomaticSupplement(enrichmentBase) || cainiaoManualFallbackRequested ||
        jingDongManualFallbackRequested
      );
      const primaryContestRequested = hasRealWaybill && primaryNeeded && (
        requestedKuaidi100Timeline || ordinaryAutomaticPrimaryRequested || missingStatusRefresh
      );
      const h5Kind = primaryContestRequested ? "web" : "none";
      const provider = String(enrichmentBase.identity.sourceProvider || "").toLowerCase();
      const motoSupported = primaryContestRequested &&
        (enrichmentBase.identity.manuallyAdded || provider === "cainiao") &&
        enrichmentBase.identity.courierCode.toUpperCase() !== "SF";
      const h5Provider = primaryH5Provider(enrichmentBase.identity.courierCode);
      const h5Stage = h5Provider === "jt_h5" ? "jt_h5" : "kuaidi100_query";
      const h5StartedAt = Date.now();
      const h5DeadlineAtMs = accountChildDeadline(
        deadlineAtMs,
        ACCOUNT_H5_BUDGET_MS,
        0,
        h5StartedAt,
      );
      if (h5Kind !== "none") {
        writeDiagnostic("detail.refresh.stage_started", {
          flowId,
          source,
          stage: h5Stage,
          ...shipmentDiagnosticDetails(enrichmentBase, h5Provider),
          timelineProvider: h5Provider,
          budgetMs: stageBudgetMs(h5DeadlineAtMs, h5StartedAt),
        });
      }
      const queryH5 = async () => {
        if (deadlineExpired(deadlineAtMs) || h5Kind !== "web") return null;
        const result = await runtime.refreshWebTimeline(
            enrichmentBase,
            h5DeadlineAtMs,
            (diagnostics) => { webDiagnostics = diagnostics; },
            signal,
            onQueryAttempted,
            sourceBindings.map(binding => binding.phone.slice(-4)),
            beforeQuery,
          );
        return result;
      };

      let h5Result: Shipment | null = null;
      let h5Error: unknown = null;
      let motoResult: Shipment | null = null;
      let motoError: unknown = null;
      let kdniaoResult: Shipment | null = null;
      let kdniaoError: unknown = null;
      let primarySuccessCount = -1;
      let primaryReachedTimelineStart = false;
      let kdniaoAttempted = false;
      const endH5StageOnCancellation = () => {
        if (h5Kind === "none") return;
        writeDiagnostic("detail.refresh.stage_failed", {
          flowId,
          source,
          stage: h5Stage,
          ...shipmentDiagnosticDetails(refreshed, h5Provider),
          timelineProvider: h5Provider,
          durationMs: Date.now() - h5StartedAt,
          ...(webDiagnostics || {}),
          errorCategory: "cancelled",
        }, "warning");
      };
      if (primaryContestRequested) {
        querySucceeded ??= false;
        const contest = await runManualDetailSourceContest({
          queryMoto: async () => {
            if (!motoSupported) return null;
            const outcome = await runtime.queryManualForSource({
              onQueryAttempted,
              beforeQuery,
              source,
              bindings: sourceBindings,
              waybill: displayWaybill(enrichmentBase),
              phoneTail: enrichmentBase.identity.phoneTail,
              rawCourierCode: enrichmentBase.identity.rawCourierCode,
              courierCode: enrichmentBase.identity.courierCode,
              companyName: enrichmentBase.identity.companyName,
              sourceProvider: enrichmentBase.identity.sourceProvider,
              deadlineAtMs: accountChildDeadline(
                deadlineAtMs,
                DETAIL_MANUAL_REFRESH_BUDGET_MS,
              ),
              includeKdniaoFallback: false,
              motoOnly: true,
              diagnosticFlowId: flowId,
              diagnosticStage: "moto_query",
              signal,
            }).then(observeManualOutcome);
            return usableManualSupplement(outcome.shipment) ? outcome.shipment : null;
          },
          queryKuaidi100: queryH5,
          ...(options.includeKdniaoFallback === true && paidFallbackGateOpen
            ? {
                queryKdniao: async () => {
                  stage = "kdniao_fallback";
                  const outcome = await runtime.queryManualForSource({
                    onQueryAttempted,
                    beforeQuery,
                    source,
                    bindings: sourceBindings,
                    waybill: displayWaybill(enrichmentBase),
                    phoneTail: enrichmentBase.identity.phoneTail,
                    rawCourierCode: enrichmentBase.identity.rawCourierCode,
                    courierCode: enrichmentBase.identity.courierCode,
                    companyName: enrichmentBase.identity.companyName,
                    sourceProvider: enrichmentBase.identity.sourceProvider,
                    deadlineAtMs: accountChildDeadline(
                      deadlineAtMs,
                      DETAIL_MANUAL_REFRESH_BUDGET_MS,
                    ),
                    includeKdniaoFallback: true,
                    fallbackOnly: true,
                    diagnosticFlowId: flowId,
                    diagnosticStage: "kdniao_fallback",
                    signal,
                  }).then(observeManualOutcome);
                  return usableManualSupplement(outcome.shipment) ? outcome.shipment : null;
                },
              }
            : {}),
          canQueryKdniao: () =>
            !signal?.aborted && !deadlineExpired(deadlineAtMs),
          hasAccumulatedTimelineStart: (shipments) => {
            let accumulated = enrichmentBase;
            if (isShunFengSourceShipment(enrichmentBase)) {
              const latest = loadState();
              // A provider wait cannot decide paid work using an obsolete status or parcel owner.
              if (!alignmentOwnerCurrent(base, original, latest)) return true;
              const current = latest.shipments.find(item => item.identity.id === original.identity.id)!;
              accumulated = rebaseManualTimelineCaches(current, enrichmentBase, Date.now());
            }
            for (const shipment of shipments) {
              accumulated = applyManualShipment(
                accumulated,
                shipment,
                Date.now(),
              );
            }
            // Pickup closes a history gap, but it cannot stand in for a missing status.
            return missingStatusRefresh ? !lacksStatus(accumulated)
              : hasTimelineStartBeforeKdniao(accumulated);
          },
        });
        rethrowStageCancellation(signal, endH5StageOnCancellation);
        motoResult = contest.moto.shipment;
        motoError = contest.moto.error;
        h5Result = contest.kuaidi100.shipment;
        h5Error = contest.kuaidi100.error;
        queryFailureObserved ||= Boolean(contest.moto.error || contest.kuaidi100.error || contest.kdniao.error);
        kdniaoResult = contest.kdniao.shipment;
        kdniaoError = contest.kdniao.error;
        primarySuccessCount = contest.primarySuccessCount;
        primaryReachedTimelineStart = contest.primaryReachedTimelineStart;
        kdniaoAttempted = contest.kdniaoAttempted;
        if (motoResult) {
          querySucceeded = true;
          refreshed = applyManualShipment(refreshed, motoResult, Date.now());
          changed = true;
        }
      } else {
        try {
          h5Result = await queryH5();
          assertRefreshSignal(signal);
        } catch (error) {
          rethrowStageCancellation(signal, endH5StageOnCancellation);
          h5Error = error;
        }
      }
      h5Result = rejectForeignManualResult(refreshed, h5Result, {
        flowId,
        source,
        stage: h5Stage,
        timelineProvider: h5Provider,
      });
      if (h5Result) {
        querySucceeded = true;
        refreshed = primaryContestRequested
          ? applyManualShipment(refreshed, h5Result, Date.now())
          : h5Result;
        changed = true;
        const capturedTimeline = (h5Result.manualTimelines || []).find(timeline =>
          normalizeTimelineSlot(timeline.provider) === h5Provider) || h5Result.timeline;
        writeDiagnostic("detail.refresh.stage_succeeded", {
          flowId,
          source,
          stage: h5Stage,
          ...shipmentDiagnosticDetails(refreshed, h5Provider, capturedTimeline),
          durationMs: Date.now() - h5StartedAt,
          result: "timed_tracks",
        });
      } else if (h5Kind !== "none") {
        queryFailureObserved ||= Boolean(h5Error);
        emptyResponseObserved ||= !h5Error;
        writeDiagnostic("detail.refresh.stage_failed", {
          flowId,
          source,
          stage: h5Stage,
          ...shipmentDiagnosticDetails(refreshed, h5Provider),
          timelineProvider: h5Provider,
          durationMs: Date.now() - h5StartedAt,
          ...(webDiagnostics || {}),
          ...(h5Error
            ? diagnosticErrorDetails(h5Error)
            : {
                result: "no_timed_tracks",
              }),
        }, "warning");
      }

      kdniaoResult = rejectForeignManualResult(refreshed, kdniaoResult, {
        flowId,
        source,
        stage: "kdniao_fallback",
        timelineProvider: "kdniao",
      });
      if (kdniaoResult) {
        querySucceeded = true;
        refreshed = applyManualShipment(refreshed, kdniaoResult, Date.now());
        changed = true;
      } else if (kdniaoError) {
        rethrowRefreshCancellation(kdniaoError, signal);
        writeDiagnostic("detail.refresh.fallback_failed", {
          flowId,
          source,
          stage: "kdniao_fallback",
          ...shipmentDiagnosticDetails(refreshed, TIMELINE_SLOT.KDNIAO),
          durationMs: Date.now() - enrichmentStartedAt,
          ...diagnosticErrorDetails(kdniaoError),
        }, "warning");
      }
      if (primaryContestRequested) {
        const selected = selectShipmentDetailTimeline(refreshed);
        const selectedTrackCount = timedTracks(selected.tracks).length;
        writeDiagnostic("detail.refresh.primary_contest.completed", {
          flowId,
          source,
          stage: "primary_contest",
          ...shipmentDiagnosticDetails(refreshed),
          v4QuerySupported: motoSupported,
          ...(motoSupported ? { v4QuerySucceeded: Boolean(motoResult) } : {}),
          ...(h5Provider === TIMELINE_SLOT.JT_H5
            ? { jtH5Succeeded: Boolean(h5Result) } : { k100H5Succeeded: Boolean(h5Result) }),
          primarySuccessCount,
          primaryReachedTimelineStart,
          kdniaoAttempted,
          ...(kdniaoAttempted ? { kdniaoSucceeded: Boolean(kdniaoResult) } : {}),
          detailTimelineProvider: selected.provider,
          detailEffectiveTrackCount: selectedTrackCount,
          durationMs: Date.now() - enrichmentStartedAt,
        });
      }

      if (
        !primaryContestRequested &&
        !unprojectedAccountOrder(refreshed) &&
        options.includeKdniaoFallback === true && paidFallbackGateOpen &&
        !deadlineExpired(deadlineAtMs) && (
          missingStatusRefresh ? lacksStatus(refreshed)
            : !jingDongAutomaticH5Available && !cainiaoH5Succeeded &&
              needsDetailFallback(refreshed) && !hasCachedKdniaoTimeline(refreshed) &&
              explicitTimelineRefresh
        )
      ) {
        stage = "kdniao_fallback";
        querySucceeded ??= false;
        try {
          const outcome = await runtime.queryManualForSource({
            onQueryAttempted,
            beforeQuery,
            source,
            bindings: sourceBindings,
            waybill: displayWaybill(refreshed),
            phoneTail: refreshed.identity.phoneTail,
            rawCourierCode: refreshed.identity.rawCourierCode,
            courierCode: refreshed.identity.courierCode,
            companyName: refreshed.identity.companyName,
            sourceProvider: refreshed.identity.sourceProvider,
            deadlineAtMs: accountChildDeadline(
              deadlineAtMs,
              DETAIL_MANUAL_REFRESH_BUDGET_MS,
            ),
            includeKdniaoFallback: true,
            fallbackOnly: true,
            diagnosticFlowId: flowId,
            diagnosticStage: stage,
            signal,
          }).then(observeManualOutcome);
          assertRefreshSignal(signal);
          if (usableManualSupplement(outcome.shipment)) {
            querySucceeded = true;
            kdniaoResult = outcome.shipment;
            refreshed = applyManualShipment(
              refreshed,
              outcome.shipment,
              Date.now(),
            );
            changed = true;
          }
        } catch (error) {
          rethrowRefreshCancellation(error, signal);
          kdniaoError = error;
          queryFailureObserved = true;
          writeDiagnostic("detail.refresh.fallback_failed", {
            flowId,
            source,
            stage,
            ...shipmentDiagnosticDetails(refreshed, TIMELINE_SLOT.KDNIAO),
            durationMs: Date.now() - enrichmentStartedAt,
            ...diagnosticErrorDetails(error),
          }, "warning");
        }
      }
      if (refreshed.identity.manuallyAdded && explicitTimelineRefresh &&
          !pickerSupplementSucceeded && !motoResult && !h5Result && !kdniaoResult &&
          !shipmentDetailComplete(refreshed) &&
          [motoError, h5Error, kdniaoError].some(needsManualPhoneTail)) {
        expressToast = "manualPhoneTailRequired";
      }
      // A carrier repair is not a refresh result: it must never mask a real projection error.
      if (!changed && accountError && !(missingHistoryRefresh && completedSourceQuery && !sourceAccessRejected &&
          (accountError instanceof GatewayError || accountError instanceof OperationTimeoutError))) {
        throw accountError;
      }
      if (storedRowBaseline) changed = true;
  } catch (error) {
    rethrowRefreshCancellation(error, signal);
    const failureState = loadState();
    safelyPruneRoutes(failureState);
    writeDiagnostic("detail.refresh.failed", {
      flowId,
      source,
      baseActiveSource: base.activeSource,
      baseRevision: base.revision,
      durationMs: Date.now() - startedAt,
      stage,
      ...shipmentDiagnosticDetails(original),
      persisted: false,
      ...diagnosticErrorDetails(error),
    }, "warning");
    throw error;
  }

  if (carrierRepair && needsProjectedCarrierRepair(refreshed.identity)) {
    // An ownership reservation or takeover above may have rebuilt the shipment from storage;
    // the recognised carrier must still reach the committed row.
    const repairedFinal = repairProjectedShipmentCarrier(
      refreshed, carrierRepair.normalization, carrierRepair.displayName);
    if (repairedFinal !== refreshed) {
      refreshed = repairedFinal;
      changed = true;
    }
  }

  assertRefreshSignal(signal);
  if (missingHistoryRefresh && completedSourceQuery && !sourceAccessRejected && !deadlineExpired(deadlineAtMs) &&
      refreshed.timeline.semantic === "COMPLETED" &&
      !unprojectedAccountOrder(refreshed) && !hasUsableShipmentDynamics(refreshed)) {
    refreshed = { ...refreshed, emptyTimelineHiddenAtMs: Date.now() };
    changed = true;
  }

  if (pull && querySucceeded === false && isShunFengSourceShipment(refreshed) &&
      !hasEligibleShunFengManualTimeline(refreshed)) {
    const fallback = (refreshed.manualTimelines || []).find(timeline =>
      normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.V5_QUERY && timedTracks(timeline.tracks).length > 0);
    if (fallback) {
      refreshed = { ...refreshed, detailSelection: {
        provider: TIMELINE_SLOT.V5_QUERY, selectedAtMs: Date.now(), reason: "sf_refresh_failed",
      } };
      refreshed = { ...refreshed, timeline: selectShipmentTimeline(refreshed) };
      changed = true;
    }
  }

  if (
    changed &&
    shipmentEffectiveFingerprint(refreshed) ===
      shipmentEffectiveFingerprint(storedRowBaseline || original)
  ) {
    changed = false;
  }

  if (!changed) {
    const state = loadState();
    const current = state.shipments.find(item => item.identity.id === original.identity.id);
    if (!current) throw new Error("该快递已从列表中移除");
    safelyPruneRoutes(state);
    const result = querySucceeded === true ? "unchanged"
      : queryFailureObserved ? "query_failed"
      : emptyResponseObserved ? "empty_response"
      : shipmentDetailComplete(current) ? "complete_cache" : "not_attempted";
    writeDiagnostic("detail.refresh.skipped", {
      flowId,
      source,
      ...diagnosticState(state),
      durationMs: Date.now() - startedAt,
      ...shipmentDiagnosticDetails(current),
      persisted: false,
      finalTimelineProvider: String(current.timeline.provider || "")
        .trim()
        .toLowerCase(),
      skipReason: result,
      result,
    });
    return {
      shipment: current,
      state,
      refreshed: false,
      querySucceeded,
      completedSourceQuery: completedSourceQuery && !sourceAccessRejected,
      ...(expressToast ? { expressToast } : {}),
      ...(expressToastRemainingMs > 0 ? { expressToastRemainingMs } : {}),
    };
  }
  if (deadlineExpired(deadlineAtMs) || !lease.isCurrent()) {
    throw new OperationTimeoutError();
  }
  // 粘性选包（用户定 2026-09-05 晚）：落库前记下这轮详情页会显示的包，下一轮默认还显示它。
  const commit = commitTargetShipmentRefresh(
    base,
    withDetailSelection(refreshed, Date.now()),
    Date.now(),
    lease,
  );
  let committed = commit.state;
  if (!commit.applied) {
    safelyPruneRoutes(committed);
    const current = committed.shipments.find(
      (item) => item.identity.id === original.identity.id,
    );
    writeDiagnostic("detail.refresh.skipped", {
      flowId,
      source,
      baseActiveSource: base.activeSource,
      baseRevision: base.revision,
      ...diagnosticState(committed),
      durationMs: Date.now() - startedAt,
      ...shipmentDiagnosticDetails(current || original),
      persisted: false,
      finalTimelineProvider: String((current || original).timeline.provider || "")
        .trim()
        .toLowerCase(),
      skipReason: current ? "state_changed" : "removed",
      result: current ? "state_changed" : "removed",
    });
    if (!current) throw new Error("该快递已从列表中移除");
    return {
      shipment: current,
      state: committed,
      refreshed: false,
      ...(expressToast ? { expressToast } : {}),
      ...(expressToastRemainingMs > 0 ? { expressToastRemainingMs } : {}),
    };
  }
  let next = committed;
  try {
    next = publishDeferredRoutes(committed, routeMutations, Date.now());
  } catch (error) {
    writeDiagnostic("detail.route_publish_failed", {
      flowId,
      source,
      stage: "route_publish",
      durationMs: Date.now() - startedAt,
      ...diagnosticErrorDetails(error),
    }, "warning");
  }
  safelyPruneRoutes(next);
  requestWidgetReload();
  // Notification ACKs and edits accepted during the host wait belong to the returned state.
  next = await replayPendingShipmentNotifications(lease.isCurrent) ?? next;
  const persisted = next.shipments.find(
    (item) => item.identity.id === refreshed.identity.id,
  ) || refreshed;
  const persistedDetailTimeline = selectShipmentDetailTimeline(persisted);
  writeDiagnostic("detail.refresh.committed", {
    flowId,
    source,
    baseActiveSource: base.activeSource,
    baseRevision: base.revision,
    resultRevision: next.revision,
    ...diagnosticState(next),
    durationMs: Date.now() - startedAt,
    ...shipmentDiagnosticDetails(persisted),
    persisted: true,
    finalTimelineProvider: String(persisted.timeline.provider || "")
      .trim()
      .toLowerCase(),
    detailTimelineProvider: String(persistedDetailTimeline.provider || "")
      .trim()
      .toLowerCase(),
    detailEffectiveTrackCount: timedTracks(
      persistedDetailTimeline.tracks,
    ).length,
    result: "applied",
  });
  return {
    shipment: persisted,
    state: next,
    refreshed: true,
    querySucceeded,
    completedSourceQuery: completedSourceQuery && !sourceAccessRejected,
    ...(expressToast ? { expressToast } : {}),
    ...(expressToastRemainingMs > 0 ? { expressToastRemainingMs } : {}),
  };
}

/**
 * The status-alignment forced refreshes of this runtime, by row, while they hold the row's `detail:<id>` lease
 * (services/status-alignment.ts). 用户 2026-10-02 详情下拉复用在途对齐强刷并等待完成后展示: a pull on that row's detail page
 * meeting one does not start a second refresh and does not return at once (which read as a failed pull when nothing
 * was cached); it waits for the forced refresh, within the pull's own deadline, and shows its outcome as its own.
 */
async function pullAfterStatusAlignment(
  runtimeState: SyncRuntimeState,
  shipmentId: string,
  forced: Promise<ShipmentRefreshResult>,
  options: ShipmentRefreshOptions,
  runtimeOverrides: ShipmentRefreshRuntimeOverrides,
): Promise<ShipmentRefreshResult> {
  const startedAt = Date.now();
  const deadlineAtMs = options.deadlineAtMs ?? deadlineAfter(MANUAL_QUERY_BUDGET_MS);
  const waitingState = loadState();
  const waitingShipment = waitingState.shipments.find(item => item.identity.id === shipmentId);
  const expectedFingerprint = waitingShipment ? detailRequestFingerprint(waitingShipment, waitingState) : null;
  let outcome: ShipmentRefreshResult | null = null;
  try {
    outcome = await waitForRefresh(forced, deadlineAtMs,
      options.signal);
  } catch (error) {
    // A closed page cancels its pull as before; a forced refresh that failed, or outlived the pull's deadline, reads as
    // a pull whose query failed.
    rethrowRefreshCancellation(error, options.signal);
  }
  const state = loadState();
  const shipment = state.shipments.find((item) => item.identity.id === shipmentId);
  if (!shipment) throw new Error("该快递已从列表中移除");
  // One line for the pull that joined the forced refresh (the forced refresh logs its own flow).
  writeDiagnostic("detail.refresh.skipped", {
    source: SCRIPT_BINDING_SOURCE,
    trigger: options.trigger,
    ...shipmentDiagnosticDetails(shipment),
    skipReason: "coalesced_detail_refresh",
    result: outcome ? (outcome.refreshed ? "refreshed" : "unchanged") : "failed",
    durationMs: Date.now() - startedAt,
  });
  const forcedAt = forcedCompletedAt(shipment);
  // Only a no-query frozen outcome leaves the pull's distinct history operation unperformed.
  // The old pull cannot query for a replacement row or a rebound account after its wait.
  if (outcome?.skipReason === "signed_frozen" && options.trigger === "detail_pull" &&
      !options.signal?.aborted && !deadlineExpired(deadlineAtMs) &&
      expectedFingerprint !== null && detailRequestFingerprint(shipment, state) === expectedFingerprint &&
      (!forcedAt || Date.now() - forcedAt < FORCED_COMPLETION_REFRESH_WINDOW_MS) &&
      shipmentDetailIncompleteReason(withoutForcedCompletion(shipment)) !== null) {
    return runTargetedShipmentRefresh(runtimeState, shipmentId, { ...options, deadlineAtMs }, runtimeOverrides, expectedFingerprint);
  }
  const result = outcome
    ? { ...outcome, state, shipment, detailEntry: options.detailEntry }
    : { state, shipment, refreshed: false, querySucceeded: false };
  return result;
}

export function runTargetedShipmentRefresh(
  runtimeState: SyncRuntimeState,
  shipmentId: string,
  options: ShipmentRefreshOptions,
  runtimeOverrides: ShipmentRefreshRuntimeOverrides = {},
  expectedFingerprint?: string,
  imageOwner?: string,
): Promise<ShipmentRefreshResult> {
  const durableLease = acquireRenewingDurableRefreshLease(
    `detail:${shipmentId}`,
    35_000,
  );
  const forced = !durableLease && options.trigger === "detail_pull" ? runtimeState.statusAlignmentRefreshes.get(shipmentId) : undefined;
  if (forced) return pullAfterStatusAlignment(runtimeState, shipmentId, forced, options, runtimeOverrides);
  if (!durableLease && options.trigger === "product_image" && options.requestProductImage) {
    return (async () => {
      const readWaitingState = () => withSharedFileTransaction(() => {
        const state = loadState();
        return { state, stateRef: sharedData().stateRef };
      });
      let snapshot = readWaitingState();
      const waitingState = snapshot.state;
      const waitingShipment = waitingState.shipments.find(item => item.identity.id === shipmentId);
      if (!waitingShipment) throw new Error("该快递已从列表中移除");
      if (!shouldRequestDetailProductImage(waitingShipment, waitingState.bindings)) {
        return { state: waitingState, shipment: waitingShipment, refreshed: false, querySucceeded: false };
      }
      const expectedImageOwner = imageOwner || productImageOwnerFingerprint(waitingShipment, waitingState);
      const deadlineAtMs = options.deadlineAtMs ?? deadlineAfter(MANUAL_QUERY_BUDGET_MS);
      // A background detail holder does not perform the visible page's image request.
      try {
        while (durableRefreshLeaseRemainingMs(`detail:${shipmentId}`) > 0) {
          assertRefreshSignal(options.signal);
          assertWithinDeadline(deadlineAtMs);
          await waitForRefresh(new Promise<void>(resolve => setTimeout(resolve, 100)), deadlineAtMs, options.signal);
          // Lease renewal advances the journal without changing its authoritative state blob.
          if (snapshot.stateRef && sharedData().stateRef === snapshot.stateRef && !stateRetentionExpired(snapshot.state)) continue;
          snapshot = readWaitingState();
          const current = snapshot.state.shipments.find(item => item.identity.id === shipmentId);
          if (!current) throw new Error("该快递已从列表中移除");
          if (productImageOwnerFingerprint(current, snapshot.state) !== expectedImageOwner) {
            return { state: snapshot.state, shipment: current, refreshed: false, querySucceeded: false };
          }
        }
      } catch (error) {
        // Retry optional cleanup on every exit without replacing cancellation/deadline failures.
        try { loadState(); } catch (cleanupError) {
          writeDiagnostic("detail.image.wait_cleanup_failed", diagnosticErrorDetails(cleanupError), "warning");
        }
        throw error;
      }
      const currentState = loadState();
      const current = currentState.shipments.find(item => item.identity.id === shipmentId);
      if (!current) throw new Error("该快递已从列表中移除");
      if (productImageOwnerFingerprint(current, currentState) !== expectedImageOwner) {
        return { state: currentState, shipment: current, refreshed: false, querySucceeded: false };
      }
      assertRefreshSignal(options.signal);
      assertWithinDeadline(deadlineAtMs);
      return runTargetedShipmentRefresh(runtimeState, shipmentId, { ...options, deadlineAtMs },
        runtimeOverrides, undefined, expectedImageOwner);
    })();
  }
  if (!durableLease) {
    const state = loadState();
    const shipment = state.shipments.find(
      (item) => item.identity.id === shipmentId,
    );
    return shipment
      ? Promise.resolve({ shipment, state, refreshed: false, querySucceeded: false })
      : Promise.reject(new Error("该快递已从列表中移除"));
  }
  let active = true;
  const release = () => { active = false; durableLease.release(); };
  const cancelImage = () => {
    try { release(); }
    catch (error) { writeDiagnostic("detail.image.lease_release_failed", diagnosticErrorDetails(error), "warning"); }
  };
  // A page can cancel optional metadata before starting its next trajectory operation; its aborted writer cannot commit.
  if (options.trigger === "product_image") options.signal?.addEventListener("abort", cancelImage);
  const lease: TargetRefreshLease = {
    deadlineAtMs: options.deadlineAtMs,
    expectedFingerprint,
    expectedImageOwner: imageOwner,
    isCurrent: () =>
      active && durableLease.isCurrent() && !options.signal?.aborted,
    signal: options.signal,
  };
  const run = Promise.resolve().then(() =>
    runShipmentRefreshById(runtimeState, shipmentId, lease, options, runtimeOverrides)
  ).finally(() => {
    options.signal?.removeEventListener("abort", cancelImage);
    release();
  });
  if (options.trigger === "status_alignment") {
    runtimeState.statusAlignmentRefreshes.set(shipmentId, run);
    const settle = () => {
      if (runtimeState.statusAlignmentRefreshes.get(shipmentId) === run) runtimeState.statusAlignmentRefreshes.delete(shipmentId);
    };
    run.then(settle, settle);
  }
  return run;
}

export async function runTargetedShipmentRefreshWithProjectionWait(
  runtimeState: SyncRuntimeState,
  shipmentId: string,
  options: ShipmentRefreshOptions,
  runtimeOverrides: ShipmentRefreshRuntimeOverrides = {},
): Promise<ShipmentRefreshResult> {
  const forced = options.trigger === "detail_pull" ? runtimeState.statusAlignmentRefreshes.get(shipmentId) : undefined;
  if (forced) return pullAfterStatusAlignment(runtimeState, shipmentId, forced, options, runtimeOverrides);
  if (options.forceAccountOrderProjection || options.trigger === "detail_pull") {
    const completed = await waitForProjectionAttemptRelease(
      runtimeState,
      shipmentId,
      options.signal,
      options.deadlineAtMs,
      options.trigger === "detail_pull",
    );
    if (completed && (options.trigger === "detail_pull" || !options.includeKdniaoFallback)) {
      return completed;
    }
  }
  return runTargetedShipmentRefresh(runtimeState, shipmentId, options, runtimeOverrides);
}

export function refreshShipmentById(
  runtimeState: SyncRuntimeState,
  shipmentId: string,
  options: ShipmentRefreshOptions = {},
): Promise<ShipmentRefreshResult> {
  const state = loadState();
  const shipment = state.shipments.find(item => item.identity.id === shipmentId);
  if (!shipment) return Promise.reject(new Error("该快递已从列表中移除"));
  const source = requireScriptSource(shipment.identity.bindingSource || SCRIPT_BINDING_SOURCE);
  const trigger = options.trigger || "detail_open";
  const deadlineAtMs = options.deadlineAtMs ?? deadlineAfter(MANUAL_QUERY_BUDGET_MS);
  const key = JSON.stringify([shipmentId, detailRequestFingerprint(shipment, state), trigger,
    Boolean(options.requestProductImage),
    Boolean(options.includeKdniaoFallback), Boolean(options.forceManualRefresh),
    Boolean(options.forceAccountOrderProjection), options.detailEntry]);
  return runtimeState.refreshCoordinator.runIndependentDetail(key, source, signal =>
    runTargetedShipmentRefreshWithProjectionWait(runtimeState, shipmentId, { ...options, deadlineAtMs, signal }),
    deadlineAtMs, options.signal);
}
