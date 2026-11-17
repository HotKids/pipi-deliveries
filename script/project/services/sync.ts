/**
 * Pipi Deliveries iOS 快递同步总编排器（AGENTS §9 / §11）。
 *
 * - **职责边界**：协调接口 5 账号列表/按件详情同步、增强元数据补全、前台京东联盟页运单投影、
 *   顺丰与手动件链（Online -> 主轮 -> 快递鸟）、承运商先识别后推送（T23）及状态对齐强刷。
 * - **跨宿主并发契约**：App、小组件与 App Intent 共享 App Group 存储，状态落盘统一经
 *   `shared-file-transaction.ts` 乐观代次事务与 `refresh-runtime-state.ts` 租约栅栏串行提交。
 * - **跨端对等文件**：Pipi `ExpressPoller.java` / `ExpressRepository.java`、
 *   Lite `ExpressSyncManager.java` / `ExpressRepository.java`、Bot `pipi-bot/bot.py`。
 */
import type { AbortSignal } from "scripting";
import type { AppState, BindingSource, RefreshSummary } from "../models";
import { replayPendingShipmentNotifications } from "./notifications";
import { replayEnhancementUnsubscribes } from "./enhancement-unsubscribe";
import { saveAccountAppRoutes } from "./routes";
import { automaticBindingIdentityOf, cainiaoHasTrajectoryGap, isHomeAccountQuerySource } from "./shipment-policy";
import { loadState } from "./storage";
import { timedTracks, timelineDisplayDetail } from "./status";
import { acquireRenewingDurableRefreshLease, durableRefreshLeaseDiagnostics, recordNetworkRefreshSuccess } from "./refresh-runtime-state";
import { requestWidgetReload } from "./widgets";
import { refreshCarrierAuthorityIfNeeded } from "./carrier-authority";
import { assertWithinDeadline, deadlineAfter, deadlineExpired } from "./deadline";
import { createDiagnosticFlowId, diagnosticErrorDetails, diagnosticState, writeDiagnostic } from "./logger";
import { SCRIPT_BINDING_SOURCE, requireScriptSource } from "./script-source";
import { SCRIPT_CLIENT_BUILD, SCRIPT_VERSION } from "./build-track";
import { CarrierRecognitionBudget } from "./carrier-recognition";
import type { FullRefreshLease } from "./refresh-coordination";
import { FULL_REFRESH_FINALIZATION_RESERVE_MS, fullRefreshHostPolicy } from "./refresh-mode";
import { projectionSceneActive } from "./projection-viewport";
import {
  cainiaoListHasUpdate,
  createSyncRuntimeState,
  FULL_REFRESH_COORDINATION_WAIT_MS,
  isCainiaoAutomaticShipment,
  statePresentationFingerprint,
  type DeferredRouteMutations,
  type FullRefreshOutcome,
  type ShipmentRefreshOptions,
  type ShipmentRefreshResult,
  type SyncRuntimeState,
  type TargetRefreshLease,
} from "./sync/shared";
import { fullRefreshCheckpoints } from "./sync/route-publications";
import { withH5Controller } from "./sync/h5-capture";
import { logJingDongListRecords, synchronizeAccountList } from "./sync/account-list-sync";
import {
  hasActiveAccountOrderProjection as hasActiveAccountOrderProjectionWithRuntime,
  listParcelStructuredSemantic,
  listRefreshInProgress as listRefreshInProgressWithRuntime,
  persistAccountOrderProjectionReferences,
  projectAccountOrders,
  projectStoredAccountOrders as projectStoredAccountOrdersWithRuntime,
  recordAccountOrderProjectionCommits,
  UnionPageSkipped,
  type StoredOrderProjectionResult,
} from "./sync/jd-order-projection";
import {
  continueManualShipmentPreview as continueManualShipmentPreviewWithRuntime,
  type ManualShipmentPreview,
} from "./sync/manual-chain-runner";
import {
  refreshShipmentById as refreshShipmentByIdWithRuntime,
  runShipmentRefreshById,
  runTargetedShipmentRefresh,
  runTargetedShipmentRefreshWithProjectionWait,
  type ShipmentRefreshRuntimeOverrides,
} from "./sync/detail-refresh";
import { refreshShipmentEnrichment } from "./sync/enrichment-scheduler";

const runtimeState = createSyncRuntimeState();

export function subscribeRefreshState(listener: (state: AppState) => void): () => void {
  runtimeState.refreshStateListeners.add(listener);
  return () => { runtimeState.refreshStateListeners.delete(listener); };
}

export function subscribeFullRefreshOutcome(
  listener: (outcome: FullRefreshOutcome) => void,
): () => void {
  runtimeState.fullRefreshOutcomeListeners.add(listener);
  return () => { runtimeState.fullRefreshOutcomeListeners.delete(listener); };
}

async function runFullRefresh(
  source: BindingSource,
  deadlineAtMs: number | undefined,
  flowId: string,
  skipRefreshIds: ReadonlySet<string>,
  accountOrderProjection: boolean,
  backgroundHostSafe: boolean,
  forceManualRefresh: boolean,
  accountListOnly: boolean,
  accountSourceFollowup: boolean,
  lease: FullRefreshLease,
  onAccountPhase?: (summary: RefreshSummary) => void,
): Promise<RefreshSummary> {
  requireScriptSource(source);
  lease.assertCurrent();
  const preparationStartedAt = Date.now();
  writeDiagnostic("refresh.preparation.started", { flowId, source, stage: "preparation" });
  if (!backgroundHostSafe) {
    await refreshCarrierAuthorityIfNeeded();
    lease.assertCurrent();
  }
  const hostPolicy = fullRefreshHostPolicy({
    accountOrderProjection,
    backgroundHostSafe,
  });
  const startedAt = Date.now();
  const initial = loadState(startedAt);
  writeDiagnostic("refresh.preparation.completed", {
    flowId, source, stage: "preparation", durationMs: Date.now() - preparationStartedAt,
    pendingNotifications: initial.pendingNotifications?.length || 0,
  });
  const orderMerges = new Map<string, string[]>();
  const notificationContext = {
    previousById: new Map(initial.shipments.map((shipment) => [shipment.identity.id, shipment])),
    batchId: flowId,
    orderMerges,
  };
  let currentState = initial;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let accountListUpdated = false;
  const cainiaoFollowupIds = new Set<string>();
  const cainiaoListUpdatedIds = new Set<string>();
  let summary: RefreshSummary | undefined;
  const promotedPendingShipmentIds: string[] = [];

  const { checkpoint, projectionCheckpoint } = fullRefreshCheckpoints(
    runtimeState, source, flowId, lease, initial, notificationContext,
  );
  // 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒。One sync round: the list's recognition before it is stored,
  // the projection passes and the manual rows' recognition all wait on this one budget, each stage still within its
  // own deadline. A waybill left when it runs out stays held (T23) until a later round.
  // 用户 2026-09-27 第二轮清单：截断排后；同步轮里被任一时限截住的也记，是截断排后细则，用户 2026-09-27 提交前核对答
  // 「这样做」。The waybills any time limit of this round cuts off go last in the next rounds.
  const recognitionBudget = new CarrierRecognitionBudget(undefined, { syncRound: true });

  try {
    const accountMutations: DeferredRouteMutations = new Map();
    const accountDeadlineAtMs = deadlineAtMs == null
      ? undefined
      : Math.max(
          startedAt + 1,
          deadlineAtMs - FULL_REFRESH_FINALIZATION_RESERVE_MS,
        );
    const accountStartedAt = Date.now();
    const account = await synchronizeAccountList(
      initial,
      source,
      startedAt,
      accountMutations,
      flowId,
      accountDeadlineAtMs,
      hostPolicy.accountFollowupReserveMs,
      lease.signal,
      orderMerges,
      recognitionBudget,
    );
    attempted += account.attempted;
    succeeded += account.succeeded;
    failed += account.failed;
    writeDiagnostic("refresh.account.completed", {
      flowId, source, result: account.canContinue ? "continue" : "stop",
      attempted: account.attempted, succeeded: account.succeeded, failed: account.failed,
      durationMs: Date.now() - accountStartedAt,
    });
    if (!account.canContinue) {
      return summary = {
        attempted,
        succeeded,
        failed,
        state: initial,
        promotedPendingShipmentIds,
      };
    }
    if (account.succeeded > 0) {
      const previousById = new Map(initial.shipments.map(shipment => [shipment.identity.id, shipment]));
      for (const shipment of account.state.shipments) {
        if (cainiaoListHasUpdate(previousById.get(shipment.identity.id), shipment)) {
          cainiaoListUpdatedIds.add(shipment.identity.id);
          cainiaoFollowupIds.add(shipment.identity.id);
        }
      }
      currentState = checkpoint(account.state, accountMutations, "account_list");
      logJingDongListRecords(account.parcels, initial, account.state, currentState, flowId, startedAt);
      accountListUpdated = true;
      recordNetworkRefreshSuccess("account");
      const appRoutes = account.parcels.flatMap((parcel) => {
        if (!parcel.appRoute) return [];
        const owner = currentState.shipments.find((item) =>
          item.identity.bindingSource === source && !item.identity.manuallyAdded &&
          item.accountRecord?.waybill === parcel.ownerId &&
          item.identity.sourceProvider?.toLowerCase() === parcel.sourceProvider.toLowerCase() &&
          item.accountRecord.companyCode === parcel.rawCourierCode);
        return owner?.accountRecord ? [{ record: owner.accountRecord, route: parcel.appRoute }] : [];
      });
      try {
        const saved = saveAccountAppRoutes(appRoutes);
        writeDiagnostic("account.external.cached", { source, records: saved, flowId });
      } catch (error) {
        writeDiagnostic("detail.external.cache_failed", { source, ...diagnosticErrorDetails(error) }, "warning");
      }
      persistAccountOrderProjectionReferences(
        account.parcels,
        currentState,
        source,
        flowId,
      );
    }
    if (!accountListOnly && (account.succeeded > 0 || forceManualRefresh)) {
      const listUnavailable = account.succeeded === 0 && account.failed > 0;
      const gapNow = Date.now();
      for (const shipment of currentState.shipments) {
        if (!isHomeAccountQuerySource(shipment) || !isCainiaoAutomaticShipment(shipment)) continue;
        const ownerKey = `${shipment.identity.id}\u0000${automaticBindingIdentityOf(shipment)}`;
        // Supplement whenever saved list status and real tracks still have an unaligned gap,
        // even if the list status and event time did not change on this round.
        if ((account.succeeded > 0 && account.observedOwnerKeys.has(ownerKey) && cainiaoHasTrajectoryGap(shipment, gapNow)) ||
            (forceManualRefresh && (listUnavailable || account.observedOwnerKeys.has(ownerKey)) &&
              !timelineDisplayDetail(shipment.timeline) && !timedTracks(shipment.timeline.tracks).length)) {
          cainiaoFollowupIds.add(shipment.identity.id);
        }
      }
    }

    // E1 (owner 2026-11-10): the account phase is stored (checkpointed and published above). A list pull
    // waiting for this refresh is answered with the account part's counts while the order projection and
    // per-shipment enrichment below go on in this same refresh, under the same full:<source> lease.
    // PF5: the answer is given only when that work actually starts (a union page is about to be reserved
    // or the first enrichment job starts); a refresh with nothing left answers once, at its end, with
    // the ordinary summary instead of the early `refreshContinuing` answer.
    const accountPhaseSummary: RefreshSummary = {
      attempted, succeeded, failed, accountListUpdated, continuing: true,
      state: currentState, promotedPendingShipmentIds: [],
    };
    let accountPhaseAnswered = false;
    const answerAccountPhase = () => {
      if (accountPhaseAnswered || !onAccountPhase || accountListOnly) return;
      accountPhaseAnswered = true;
      try {
        onAccountPhase(accountPhaseSummary);
      } catch { /* answering the pull cannot change the refresh */ }
    };

    const enrichmentDeadlineAtMs = deadlineAtMs == null
      ? undefined
      : deadlineAtMs - FULL_REFRESH_FINALIZATION_RESERVE_MS;
    if (!accountListOnly && !deadlineExpired(enrichmentDeadlineAtMs)) {
      // 用户 2026-09-25 同意：刷新流程只在前台开京粉页；已过期限或租约的流程一页都不开，照旧失败收尾。
      const unionPageGate = () => {
        lease.assertCurrent();
        if (!projectionSceneActive()) throw new UnionPageSkipped("not_foreground");
        answerAccountPhase();
      };
      const projection = await projectAccountOrders(
      runtimeState,
      currentState,
      account.parcels,
      source,
      Date.now(),
      flowId,
      checkpoint,
      projectionCheckpoint,
      enrichmentDeadlineAtMs,
      skipRefreshIds,
      true,
      lease.signal,
      !hostPolicy.accountOrderProjection,
      listParcelStructuredSemantic,
      false,
      unionPageGate,
      recognitionBudget,
    );
      attempted += projection.attempted;
      succeeded += projection.succeeded;
      failed += projection.failed;
      currentState = projection.state;
      if (projection.stateChanged) {
        recordAccountOrderProjectionCommits(
          projection.projectedOwnerIds, account.parcels, currentState, flowId, source,
        );
      }
    }

    writeDiagnostic("refresh.enrichment.started", { flowId, source, result: accountListOnly ? "skipped" : "eligible" });
    const enrichment = accountListOnly ? {
      state: currentState, attempted: 0, succeeded: 0, failed: 0, promotedPendingShipmentIds: [],
    } : await refreshShipmentEnrichment(
      runtimeState,
      currentState, source, flowId, checkpoint, enrichmentDeadlineAtMs,
      skipRefreshIds, forceManualRefresh, hostPolicy.accountOrderProjection, lease.signal,
      {}, accountSourceFollowup, cainiaoFollowupIds, recognitionBudget, backgroundHostSafe,
      answerAccountPhase, cainiaoListUpdatedIds,
    );
    currentState = enrichment.state;
    attempted += enrichment.attempted;
    succeeded += enrichment.succeeded;
    failed += enrichment.failed;
    promotedPendingShipmentIds.push(...enrichment.promotedPendingShipmentIds);
    writeDiagnostic("refresh.enrichment.completed", {
      flowId, source, attempted: enrichment.attempted, succeeded: enrichment.succeeded, failed: enrichment.failed,
    });

    lease.assertCurrent();
    if (backgroundHostSafe && succeeded > 0) {
      recordNetworkRefreshSuccess("background");
    }
    return summary = {
      attempted,
      succeeded,
      failed,
      accountListUpdated,
      state: currentState,
      promotedPendingShipmentIds,
    };
  } finally {
    // Drain the durable outbox once, after account work, within the remaining host budget.
    // A best-effort notification timeout must not replace a committed refresh result.
    if (lease.isCurrent()) {
      const finalizationStartedAt = Date.now();
      writeDiagnostic("refresh.finalization.started", { flowId, source, stage: "notifications" });
      // Keep the existing finalization reserve for durable ACKs and lease release.
      const notificationDeadlineAtMs = deadlineAtMs == null
        ? undefined : deadlineAtMs - FULL_REFRESH_FINALIZATION_RESERVE_MS;
      const finalized = await replayPendingShipmentNotifications(lease.isCurrent, {
        deadlineAtMs: notificationDeadlineAtMs, flowId,
      });
      // The return above already captured the summary; include the drain's durable ACKs.
      if (summary && finalized) summary.state = finalized;
      try {
        if (lease.isCurrent() && !deadlineExpired(notificationDeadlineAtMs) &&
            (finalized || loadState()).pendingEnhancementUnsubscribes?.length) {
          const unsubscribed = await replayEnhancementUnsubscribes({
            deadlineAtMs: notificationDeadlineAtMs, isCurrent: lease.isCurrent,
          });
          if (summary && unsubscribed) summary.state = unsubscribed;
        }
      } catch { /* Optional unsubscribe replay cannot replace the committed refresh result. */ }
      writeDiagnostic("refresh.finalization.completed", {
        flowId, source, stage: "notifications", durationMs: Date.now() - finalizationStartedAt,
      });
    } else {
      writeDiagnostic("refresh.finalization.skipped", {
        flowId, source, stage: "notifications",
        result: deadlineExpired(deadlineAtMs) ? "budget_exhausted" : "ownership_lost",
      });
    }
  }
}

export function refreshAllShipments(
  sourceOverride?: BindingSource,
  options: Parameters<typeof startFullRefresh>[1] = {},
): Promise<RefreshSummary> {
  const source = requireScriptSource(sourceOverride || SCRIPT_BINDING_SOURCE);
  const pending = runtimeState.interactiveFullRequests.get(source);
  if (options.forceManualRefresh && pending) return pending;
  let answerAccountPhase: (summary: RefreshSummary) => void = () => {};
  const accountPhase = new Promise<RefreshSummary>((resolve) => { answerAccountPhase = resolve; });
  const request = startFullRefresh(source, options.forceManualRefresh
    ? {
        ...options,
        onAccountPhase: (summary) => {
          answerAccountPhase(summary);
          options.onAccountPhase?.(summary);
        },
      }
    : options);
  if (!options.forceManualRefresh) return request;
  const tracked = request.finally(() => {
    if (runtimeState.interactiveFullRequests.get(source) === tracked) runtimeState.interactiveFullRequests.delete(source);
    if (runtimeState.interactiveAccountPhases.get(source)?.completion === tracked) runtimeState.interactiveAccountPhases.delete(source);
  });
  runtimeState.interactiveFullRequests.set(source, tracked);
  // The pull's answer: the account phase, or the whole refresh when it never reaches one (it then wins the race).
  const answer = Promise.race([accountPhase, tracked]);
  // Observed by the pull that awaits it; a refresh nobody pulls must not report an unhandled rejection.
  answer.catch(() => undefined);
  runtimeState.interactiveAccountPhases.set(source, { completion: tracked, accountPhase: answer });
  return tracked;
}

/**
 * E1 (owner 2026-11-10): the express list pull. Resolves as soon as the refresh it starts or joins has
 * stored its account phase (`summary.continuing`, the account part's counts); `completion` is that whole
 * refresh, whose per-shipment work goes on in the background and reaches the page through
 * subscribeRefreshState. A refresh that ends before an account phase answers with its full summary.
 */
export async function refreshAllShipmentsForPull(
  sourceOverride?: BindingSource,
  options: Parameters<typeof startFullRefresh>[1] = {},
): Promise<{ summary: RefreshSummary; completion: Promise<RefreshSummary> }> {
  const source = requireScriptSource(sourceOverride || SCRIPT_BINDING_SOURCE);
  const pulled = { ...options, forceManualRefresh: true };
  const completion = refreshAllShipments(source, pulled);
  const tracked = runtimeState.interactiveAccountPhases.get(source);
  const summary = tracked && tracked.completion === completion
    ? await tracked.accountPhase
    : await completion;
  return { summary, completion };
}

async function startFullRefresh(
  sourceOverride?: BindingSource,
  options: {
    budgetMs?: number;
    accountOrderProjection?: boolean;
    backgroundHostSafe?: boolean;
    forceManualRefresh?: boolean;
    accountListOnly?: boolean;
    /** Legacy caller hint; all non-list-only refreshes now share the account follow-up policy. */
    accountSourceFollowup?: boolean;
    /** E1: called once when the refresh's account phase is stored and enrichment follows. */
    onAccountPhase?: (summary: RefreshSummary) => void;
  } = {},
): Promise<RefreshSummary> {
  const source = requireScriptSource(
    sourceOverride || SCRIPT_BINDING_SOURCE,
  );
  // Every full-list entry shares account supplementation; host safety controls WebView and budgets.
  const accountSourceFollowup = !options.accountListOnly;
  const existing = runtimeState.refreshCoordinator.full(source);
  if (existing) return options.accountListOnly ||
    (accountSourceFollowup && !runtimeState.accountSourceFullRequests.has(existing)) ||
    (options.forceManualRefresh && !runtimeState.forcedManualFullRequests.has(existing))
    ? existing.catch(() => undefined).then(() => startFullRefresh(source, options))
    : existing;
  const flowId = createDiagnosticFlowId("refresh");
  const startedAt = Date.now();
  const requestedBudgetMs = Number(options.budgetMs);
  const budgetMs = Number.isFinite(requestedBudgetMs) && requestedBudgetMs > 0
    ? Math.max(1_000, Math.floor(requestedBudgetMs))
    : undefined;
  const deadlineAtMs = budgetMs == null
    ? undefined
    : deadlineAfter(budgetMs, startedAt);
  const trigger = options.backgroundHostSafe ? "background" : options.forceManualRefresh ? "list_pull" :
    options.accountListOnly ? "account_list_only" : "foreground";
  // 用户 2026-09-28：the lease itself is valid for 30 seconds and renewed while this refresh runs; this is
  // the longest the refresh may hold it, and the longest a user's pull waits for another live holder.
  const leaseMaxMs = Math.max(30_000, (budgetMs || 120_000) + 5_000);
  let durableLease = acquireRenewingDurableRefreshLease(
    `full:${source}`,
    leaseMaxMs,
    startedAt,
    { flowId, trigger },
  );
  if (!durableLease && options.forceManualRefresh) {
    // A user's pull must execute after the holder, not finish as a skipped background run.
    const waitDeadline = deadlineAtMs ?? startedAt + leaseMaxMs;
    writeDiagnostic("refresh.wait.started", { flowId, source, trigger,
      ...durableRefreshLeaseDiagnostics(`full:${source}`) });
    try {
      while (!durableLease) {
        assertWithinDeadline(waitDeadline);
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, waitDeadline - Date.now())));
        assertWithinDeadline(waitDeadline);
        durableLease = acquireRenewingDurableRefreshLease(`full:${source}`, leaseMaxMs, Date.now(), { flowId, trigger });
      }
      writeDiagnostic("refresh.wait.completed", { flowId, source, trigger, durationMs: Date.now() - startedAt });
    } catch (error) {
      durableLease?.release();
      writeDiagnostic("refresh.failed", { flowId, source, trigger, stage: "lease_wait",
        durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) }, "warning");
      throw error;
    }
  }
  if (!durableLease) {
    const state = loadState(startedAt);
    writeDiagnostic("refresh.skipped", {
      source,
      ...diagnosticState(state),
      result: "active_cross_runtime_refresh",
      trigger,
      ...durableRefreshLeaseDiagnostics(`full:${source}`),
    });
    // The app root waits for that holder and then runs its stored-row projection pass.
    runtimeState.publishFullRefreshOutcome({ source, trigger, skipReason: "active_cross_runtime_refresh" });
    return Promise.resolve({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      state,
      promotedPendingShipmentIds: [],
      skipReason: "active_cross_runtime_refresh",
    });
  }
  const coordinationDeadlineAtMs = deadlineAfter(
    FULL_REFRESH_COORDINATION_WAIT_MS,
    startedAt,
  );
  const blockerDeadlineAtMs = deadlineAtMs == null
    ? coordinationDeadlineAtMs
    : Math.min(deadlineAtMs, coordinationDeadlineAtMs);
  let before: AppState;
  try {
    before = loadState(startedAt);
    writeDiagnostic("refresh.started", {
      flowId,
      source,
      trigger,
      scriptVersion: SCRIPT_VERSION,
      clientBuild: SCRIPT_CLIENT_BUILD,
      baseActiveSource: before.activeSource,
      baseRevision: before.revision,
      executionBoundary: deadlineAtMs == null ? "per_stage" : "host_budget",
      ...(budgetMs == null ? {} : { budgetMs }),
    });
  } catch (error) {
    durableLease.release();
    throw error;
  }
  let blockedMs = 0;
  const coordinated = runtimeState.refreshCoordinator.runFull(
    source,
    async (skipRefreshIds, lease) => {
      blockedMs = Math.max(0, Date.now() - startedAt);
      return runFullRefresh(
        source,
        deadlineAtMs,
        flowId,
        skipRefreshIds,
        options.accountOrderProjection !== false,
        Boolean(options.backgroundHostSafe),
        Boolean(options.forceManualRefresh),
        Boolean(options.accountListOnly),
        accountSourceFollowup,
        lease,
        options.onAccountPhase,
      );
    },
    (detail) => detail.refreshed,
    {
      blockerDeadlineAtMs,
      ownership: durableLease,
      onInvalidated: reason => writeDiagnostic("refresh.ownership.invalidated", {
        flowId, source, trigger, result: reason, durationMs: Date.now() - startedAt,
        ...durableRefreshLeaseDiagnostics(`full:${source}`),
      }, "warning"),
      ...(deadlineAtMs == null ? {} : { operationDeadlineAtMs: deadlineAtMs }),
    },
  );
  if (accountSourceFollowup) runtimeState.accountSourceFullRequests.add(coordinated);
  if (options.forceManualRefresh) runtimeState.forcedManualFullRequests.add(coordinated);
  return coordinated.then(
    (summary) => {
      const failedCompletely = summary.attempted > 0 && summary.succeeded === 0;
      writeDiagnostic(failedCompletely ? "refresh.failed" : "refresh.succeeded", {
        flowId,
        source,
        ...diagnosticState(summary.state),
        attempted: summary.attempted,
        succeeded: summary.succeeded,
        failed: summary.failed,
        durationMs: Date.now() - startedAt,
        executionBoundary: deadlineAtMs == null ? "per_stage" : "host_budget",
        ...(budgetMs == null ? {} : { budgetMs }),
        blockedMs,
        ...(deadlineAtMs == null
          ? {}
          : { deadlineLagMs: Math.max(0, Date.now() - deadlineAtMs) }),
        result: failedCompletely
          ? "failed"
          : summary.failed > 0
            ? "partial"
            : "succeeded",
      }, failedCompletely ? "error" : summary.failed > 0 ? "warning" : "info");
      // Reloading at startup or inside checkpoints starts an independent widget
      // runtime that can commit an older snapshot while this refresh is writing.
      if (
        !options.backgroundHostSafe &&
        statePresentationFingerprint(summary.state) !==
          statePresentationFingerprint(before)
      ) {
        requestWidgetReload();
      }
      return summary;
    },
    (error) => {
      writeDiagnostic(
        "refresh.failed",
        {
          flowId,
          source,
          baseActiveSource: before.activeSource,
          baseRevision: before.revision,
          durationMs: Date.now() - startedAt,
          executionBoundary: deadlineAtMs == null ? "per_stage" : "host_budget",
          ...(budgetMs == null ? {} : { budgetMs }),
          blockedMs: blockedMs || Math.max(0, Date.now() - startedAt),
          ...(deadlineAtMs == null
            ? {}
            : { deadlineLagMs: Math.max(0, Date.now() - deadlineAtMs) }),
          ...diagnosticErrorDetails(error),
        },
        "error",
      );
      throw error;
    },
  ).finally(() => {
    durableLease.release();
    // Published after the release, so a listener's own pass can take the same lease.
    runtimeState.publishFullRefreshOutcome({ source, trigger });
  });
}

export {
  type DetailEntryObservation,
  type FullRefreshOutcome,
} from "./sync/shared";
export {
  bindPhone,
  mergeAccountParcel,
  synchronizeAccountList as synchronizeAccountListForTesting,
  unbindPhone,
} from "./sync/account-list-sync";
export {
  applyAccountOrderProjectionToOwner,
  type StoredOrderProjectionResult,
} from "./sync/jd-order-projection";
export {
  commitManualShipmentPreview,
  queryManualShipmentPreview,
  type ManualPreviewContinuationDependencies,
  type ManualShipmentPreview,
} from "./sync/manual-chain-runner";
export {
  shouldRequestDetailProductImage,
  statusAlignmentHasSource,
} from "./sync/cainiao-v5-supplement";
export { publishDeferredRoutes as publishDeferredRoutesForTesting } from "./sync/route-publications";

export function hasActiveAccountOrderProjection(shipmentId: string): boolean {
  return hasActiveAccountOrderProjectionWithRuntime(runtimeState, shipmentId);
}

export function continueManualShipmentPreview(
  preview: ManualShipmentPreview,
  options?: Parameters<typeof continueManualShipmentPreviewWithRuntime>[2],
): Promise<ShipmentRefreshResult> {
  return continueManualShipmentPreviewWithRuntime(runtimeState, preview, options);
}

export function refreshShipmentById(
  shipmentId: string,
  options?: ShipmentRefreshOptions,
): Promise<ShipmentRefreshResult> {
  return refreshShipmentByIdWithRuntime(runtimeState, shipmentId, options);
}

export function listRefreshInProgress(source: BindingSource = SCRIPT_BINDING_SOURCE): boolean {
  return listRefreshInProgressWithRuntime(runtimeState, source);
}

export function projectStoredAccountOrders(
  options?: Parameters<typeof projectStoredAccountOrdersWithRuntime>[1],
): Promise<StoredOrderProjectionResult> {
  return projectStoredAccountOrdersWithRuntime(runtimeState, options);
}

export function runShipmentRefreshForTesting(
  shipmentId: string,
  lease: TargetRefreshLease,
  options?: ShipmentRefreshOptions,
  runtimeOverrides?: ShipmentRefreshRuntimeOverrides,
): Promise<ShipmentRefreshResult> {
  return runShipmentRefreshById(runtimeState, shipmentId, lease, options, runtimeOverrides);
}

/** The lease-holding detail refresh (refreshShipmentById without its in-process coordinator), for tests. */
export function runTargetedShipmentRefreshForTesting(
  shipmentId: string,
  options: ShipmentRefreshOptions,
  runtimeOverrides?: ShipmentRefreshRuntimeOverrides,
  expectedFingerprint?: string,
  imageOwner?: string,
): Promise<ShipmentRefreshResult> {
  return runTargetedShipmentRefresh(runtimeState, shipmentId, options, runtimeOverrides, expectedFingerprint, imageOwner);
}

export function runProjectionAwareShipmentRefreshForTesting(
  shipmentId: string,
  options: ShipmentRefreshOptions,
  runtimeOverrides?: ShipmentRefreshRuntimeOverrides,
): Promise<ShipmentRefreshResult> {
  return runTargetedShipmentRefreshWithProjectionWait(runtimeState, shipmentId, options, runtimeOverrides);
}

export function runParcelWebRead<T>(
  capture: () => Promise<T>,
  deadlineAtMs?: number,
  signal?: AbortSignal,
): Promise<T> {
  return withH5Controller(runtimeState, capture, deadlineAtMs, signal);
}

export const runH5CaptureForTesting = runParcelWebRead;

export function runShipmentEnrichmentForTesting(
  ...args: Parameters<typeof refreshShipmentEnrichment> extends [SyncRuntimeState, ...infer Rest] ? Rest : never
): Promise<RefreshSummary> {
  return refreshShipmentEnrichment(runtimeState, ...args);
}
