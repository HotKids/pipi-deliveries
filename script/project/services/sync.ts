/**
 * Pipi Deliveries iOS 快递同步总编排器（AGENTS §9 / §11）。
 *
 * - **职责边界**：协调接口 5 账号列表/按件详情同步、增强元数据补全、前台京东联盟页运单投影、
 *   顺丰与手动件链（Online -> 主轮 -> 快递鸟）、承运商先识别后推送（T23）及状态对齐强刷。
 * - **跨宿主并发契约**：App、小组件与 App Intent 共享 App Group 存储，状态落盘统一经
 *   `shared-file-transaction.ts` 乐观代次事务与 `refresh-runtime-state.ts` 租约栅栏串行提交。
 * - **跨端对等文件**：Pipi `ExpressPoller.java` / `ExpressRepository.java`、
 *   Lite `ExpressSyncManager.java` / `ExpressRepository.java`、Bot `pipi-bot/bot/bot.py`。
 */
import { AbortController, type AbortSignal } from "scripting";
import type { AppState, BindingSource, RefreshSummary } from "../models";
import { replayPendingShipmentNotifications } from "./notifications";
import { replayEnhancementUnsubscribes } from "./enhancement-unsubscribe";
import { saveAccountAppRoutes } from "./routes";
import { automaticBindingIdentityOf, cainiaoHasTrajectoryGap, isHomeAccountQuerySource } from "./shipment-policy";
import { loadState, loadStateSnapshot, readAppStateSnapshot, refreshStoredWatchShipments, saveCloudPddParcels, visibleShipments, type LoadedStateSnapshot } from "./storage";
import { listHeadline } from "./status";
import { acquireRenewingDurableRefreshLease, durableRefreshLeaseDiagnostics, recordNetworkRefreshSuccess } from "./refresh-runtime-state";
import { requestWidgetReload } from "./widgets";
import { refreshCarrierAuthorityIfNeeded } from "./carrier-authority";
import { assertWithinDeadline, deadlineAfter, deadlineExpired } from "./deadline";
import {
  beginDiagnosticFlow, beginDiagnosticOperation, changedSinceLastLogged, classifyDiagnosticError, createDiagnosticFlowId,
  diagnosticAppliedRevision, diagnosticErrorDetails, diagnosticRuntimeHost, diagnosticState, writeDiagnostic,
  type DiagnosticLevel,
} from "./logger";
import { SCRIPT_BINDING_SOURCE, requireScriptSource } from "./script-source";
import { SCRIPT_BUILD_TRACK, SCRIPT_CLIENT_BUILD, SCRIPT_VERSION } from "./build-track";
import { gatewayCredentialGeneration, onGatewayCredentialChanged } from "./credentials";
import { readCloudPddParcels } from "./pdd-cloud-records";
import { CarrierRecognitionBudget } from "./carrier-recognition";
import type { FullRefreshLease } from "./refresh-coordination";
import { FULL_REFRESH_FINALIZATION_RESERVE_MS, fullRefreshHostPolicy } from "./refresh-mode";
import { onProjectionSceneChange, projectionSceneActive, projectionViewportHostAvailable } from "./projection-viewport";
import {
  cainiaoListHasUpdate,
  createSyncRuntimeState,
  FULL_REFRESH_COORDINATION_WAIT_MS,
  isCainiaoAutomaticShipment,
  statePresentationFingerprint,
  type DeferredRouteMutations,
  type FullRefreshOutcome,
  type H5Priority,
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

/**
 * D158 (plan step 5, under D4 owner 2026-11-21 「开始并入终态，卡住另记（推荐）」): a full refresh writes its phases
 * into its own end line, not a start and an end line per phase.
 */
type RefreshPhases = {
  preparationMs?: number;
  pendingNotifications?: number;
  accountMs?: number;
  accountContinued?: boolean;
  enrichmentMs?: number;
  finalizationMs?: number;
  /**
   * D201 (owner 2026-11-21 「只记失败，成功并入流程终态（推荐）」): the cloud PDD read the refresh made, folded into its
   * end line: the parcels the read returned and whether saving them changed the stored list. A failed read keeps its
   * own cloud.sync line.
   */
  cloudPddRecords?: number;
  cloudPddChanged?: boolean;
};

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
  before: LoadedStateSnapshot,
  onAccountPhase?: (summary: RefreshSummary) => void,
  phases: RefreshPhases = {},
): Promise<RefreshSummary> {
  requireScriptSource(source);
  lease.assertCurrent();
  const preparationStartedAt = Date.now();
  if (!backgroundHostSafe) {
    await refreshCarrierAuthorityIfNeeded();
    lease.assertCurrent();
  }
  const hostPolicy = fullRefreshHostPolicy({
    accountOrderProjection,
    backgroundHostSafe,
  });
  const startedAt = Date.now();
  const initial = loadStateSnapshot(startedAt, before).state;
  phases.preparationMs = Date.now() - preparationStartedAt;
  phases.pendingNotifications = initial.pendingNotifications?.length || 0;
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
  const recognitionBudget = new CarrierRecognitionBudget(undefined, { syncRound: true, flowId });

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
    phases.accountMs = Date.now() - accountStartedAt;
    phases.accountContinued = account.canContinue;
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
        // D167: written when the number of cached source-app entries changes, not on every successful round.
        if (changedSinceLastLogged(`account.external.cached\u0000${source}`, String(saved))) {
          writeDiagnostic("account.external.cached", { source, records: saved, flowId });
        }
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
    if (!accountListOnly) {
      const listUnavailable = account.succeeded === 0 && account.failed > 0;
      const gapNow = Date.now();
      for (const shipment of currentState.shipments) {
        if (!isHomeAccountQuerySource(shipment) || !isCainiaoAutomaticShipment(shipment)) continue;
        const ownerKey = `${shipment.identity.id}\u0000${automaticBindingIdentityOf(shipment)}`;
        // Supplement whenever saved list status and real tracks still have an unaligned gap,
        // even if the list status and event time did not change on this round.
        if ((account.succeeded > 0 && account.observedOwnerKeys.has(ownerKey) && cainiaoHasTrajectoryGap(shipment, gapNow)) ||
            ((listUnavailable || (forceManualRefresh && account.observedOwnerKeys.has(ownerKey))) &&
              !listHeadline(shipment.timeline))) {
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

    const canPullCloudPdd = backgroundHostSafe
      ? (enrichmentDeadlineAtMs == null || enrichmentDeadlineAtMs - Date.now() >= 4_000)
      : projectionSceneActive() && !deadlineExpired(enrichmentDeadlineAtMs);
    if (SCRIPT_BUILD_TRACK === "formal" && !accountListOnly && canPullCloudPdd) {
      const generation = gatewayCredentialGeneration();
      if (generation !== null) {
        currentState = await pullCloudPddParcels({
          observed: currentState, source, signal: lease.signal,
          deadlineAtMs: Math.min(enrichmentDeadlineAtMs ?? Infinity, deadlineAfter(8_000)),
          isCurrent: () => lease.isCurrent() && (backgroundHostSafe || projectionSceneActive()) &&
            gatewayCredentialGeneration() === generation,
          publish: state => runtimeState.publishRefreshState(state),
          assertCurrent: () => lease.assertCurrent(),
          fold: (records, changed) => {
            phases.cloudPddRecords = records;
            phases.cloudPddChanged = changed;
          },
        });
      }
    }

    const enrichmentStartedAt = Date.now();
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
    if (!accountListOnly) phases.enrichmentMs = Date.now() - enrichmentStartedAt;

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
      phases.finalizationMs = Date.now() - finalizationStartedAt;
    } else {
      writeDiagnostic("refresh.finalization.skipped", {
        flowId, source, stage: "notifications",
        result: deadlineExpired(deadlineAtMs) ? "budget_exhausted" : "ownership_lost",
      });
    }
  }
}

/**
 * One read of the cloud PDD parcel list and its commit: a full refresh's own pass and the explicit cloud record
 * pull (refreshCloudPddParcels) share it. Records a commit or a failure; an unchanged list records nothing.
 * `assertCurrent` lets a refresh that lost its lease leave instead of recording a failure. `fold` receives a read that
 * answered inside a flow with its own end line (the full refresh, D201): the parcel count and whether the commit
 * changed the list go on that end line instead of a cloud.sync line of their own.
 */
async function pullCloudPddParcels(options: {
  observed: AppState;
  source?: BindingSource;
  signal: AbortSignal;
  deadlineAtMs: number;
  isCurrent: () => boolean;
  publish: (state: AppState) => void;
  assertCurrent?: () => void;
  fold?: (records: number, changed: boolean) => void;
}): Promise<AppState> {
  const { observed, source, signal, deadlineAtMs, isCurrent, publish, assertCurrent, fold } = options;
  // D188 (D29): the read is one cloud.sync line of the pdd domain.
  const finish = beginDiagnosticOperation("cloud.sync", { domain: "pdd", sourceProvider: "pinduoduo", source });
  let currentState = observed;
  let stage = "cloud_pdd_pull";
  let persisted = false;
  try {
    const parcels = await readCloudPddParcels(signal, deadlineAtMs);
    if (parcels.length && isCurrent()) {
      stage = "cloud_pdd_commit";
      const { state: saved, changed } = saveCloudPddParcels(parcels, currentState, isCurrent);
      persisted = changed;
      stage = "cloud_pdd_publish";
      if (saved.revision > currentState.revision) publish(saved);
      currentState = saved;
      if (persisted && !fold) finish("committed", { stage: "cloud_pdd_commit", records: parcels.length });
    }
    try { fold?.(parcels.length, persisted); } catch { /* Diagnostics are optional. */ }
    // A read that changed nothing is a successful request with no line of its own (D201, owner 2026-11-21 「只记失败，
    // 成功并入流程终态（推荐）」); its operation marker is closed without a line.
    finish.discard();
  } catch (error) {
    try { assertCurrent?.(); } catch (superseded) {
      // A superseded read ends without a line, as before; its marker is closed so no runtime reports it unfinished.
      finish.discard();
      throw superseded;
    }
    finish("unavailable", { stage, persisted, ...diagnosticErrorDetails(error) }, "warning");
  }
  return currentState;
}

let cloudPddPull: {
  generation: number;
  observedShipments: Map<string, AppState["shipments"][number]>;
  work: Promise<void>;
} | undefined;

/**
 * The cloud PDD parcel list outside a full refresh, for 立即同步 and an Access Key change (owner 2026-11-21:
 * 加上（推荐）). It reads the list once with the refresh's own rules (formal track, a saved Access Key, the app in
 * the foreground, 8 seconds), enriches newly added pending cloud PDD placeholders via non-WebView manual chain,
 * and does not run the account refresh. Calls for the same key share a running read while merging their observed
 * rows so an in-flight delete cannot resurrect. Never rejects.
 */
export function refreshCloudPddParcels(observed: AppState, publish: (state: AppState) => void): Promise<void> {
  if (SCRIPT_BUILD_TRACK !== "formal" || !projectionSceneActive()) return Promise.resolve();
  const generation = gatewayCredentialGeneration();
  if (generation === null) return Promise.resolve();
  if (cloudPddPull?.generation === generation) {
    for (const row of observed.shipments) cloudPddPull.observedShipments.set(row.identity.id, row);
    return cloudPddPull.work;
  }
  const observedShipments = new Map(observed.shipments.map(row => [row.identity.id, row]));
  const controller = new AbortController();
  const isCurrent = () => !controller.signal.aborted && projectionSceneActive() &&
    gatewayCredentialGeneration() === generation;
  const stopScene = onProjectionSceneChange(active => { if (!active) controller.abort(); });
  const stopCredential = onGatewayCredentialChanged(() => {
    if (gatewayCredentialGeneration() !== generation) controller.abort();
  });
  const observedProxy = new Proxy(observed, {
    get(target, prop, receiver) {
      if (prop === "shipments") return [...observedShipments.values()];
      return Reflect.get(target, prop, receiver);
    },
  });
  const work = (async () => {
    await pullCloudPddParcels({
      observed: observedProxy, signal: controller.signal, deadlineAtMs: deadlineAfter(8_000), publish, isCurrent,
    });
    if (!isCurrent()) return;
    await enrichPendingCloudShipments(publish);
  })().then(() => undefined, () => undefined).finally(() => {
    stopScene();
    stopCredential();
    if (cloudPddPull?.work === work) cloudPddPull = undefined;
  });
  cloudPddPull = { generation, observedShipments, work };
  return work;
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
    beginDiagnosticFlow("refresh.wait.started", { flowId, source, trigger,
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
      flowId,
      runtimeHost: diagnosticRuntimeHost(),
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
  let before: LoadedStateSnapshot;
  try {
    before = projectionViewportHostAvailable() && !options.backgroundHostSafe
      ? readAppStateSnapshot(startedAt) : loadStateSnapshot(startedAt);
    beginDiagnosticFlow("refresh.started", {
      flowId,
      source,
      trigger,
      scriptVersion: SCRIPT_VERSION,
      clientBuild: SCRIPT_CLIENT_BUILD,
      baseActiveSource: before.state.activeSource,
      baseRevision: before.state.revision,
      executionBoundary: deadlineAtMs == null ? "per_stage" : "host_budget",
      ...(budgetMs == null ? {} : { budgetMs }),
      runtimeHost: diagnosticRuntimeHost(),
    });
  } catch (error) {
    durableLease.release();
    // D102: the snapshot read after the lease failed; the refresh ends here and the error still reaches the caller.
    writeDiagnostic("refresh.failed", {
      flowId, source, trigger, stage: "state", durationMs: Date.now() - startedAt,
      runtimeHost: diagnosticRuntimeHost(), ...diagnosticErrorDetails(error),
    }, "warning");
    throw error;
  }
  let blockedMs = 0;
  const phases: RefreshPhases = {};
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
        before,
        options.onAccountPhase,
        phases,
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
        trigger,
        ...phases,
        ...(diagnosticAppliedRevision() == null ? {} : { appliedRevision: diagnosticAppliedRevision() }),
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
        // D174 (D3): a round that failed entirely is retried by the next round, so it is a WARNING like a partial one.
      }, failedCompletely || summary.failed > 0 ? "warning" : "info");
      // Reloading at startup or inside checkpoints starts an independent widget
      // runtime that can commit an older snapshot while this refresh is writing.
      if (
        !options.backgroundHostSafe &&
        statePresentationFingerprint(summary.state) !==
          statePresentationFingerprint(before.state)
      ) {
        requestWidgetReload();
      }
      return summary;
    },
    (error) => {
      // D174 (D3): only a failed local commit is an ERROR; a cancelled refresh is an expected end and anything else is
      // retried by a later round.
      const category = classifyDiagnosticError(error);
      const level: DiagnosticLevel = category === "storage" ? "error"
        : category === "cancelled" || category === "ownership_lost" ? "info" : "warning";
      writeDiagnostic(
        "refresh.failed",
        {
          flowId,
          source,
          trigger,
          ...phases,
          ...(diagnosticAppliedRevision() == null ? {} : { appliedRevision: diagnosticAppliedRevision() }),
          baseActiveSource: before.state.activeSource,
          baseRevision: before.state.revision,
          durationMs: Date.now() - startedAt,
          executionBoundary: deadlineAtMs == null ? "per_stage" : "host_budget",
          ...(budgetMs == null ? {} : { budgetMs }),
          blockedMs: blockedMs || Math.max(0, Date.now() - startedAt),
          ...(deadlineAtMs == null
            ? {}
            : { deadlineLagMs: Math.max(0, Date.now() - deadlineAtMs) }),
          ...diagnosticErrorDetails(error),
        },
        level,
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
  if (shipmentId.startsWith("watch:")) {
    return (async () => {
      // D104: an international row's detail refresh is the Watch page read; it ends with the same detail lines.
      const flowId = options?.diagnosticFlowId || createDiagnosticFlowId("detail");
      const startedAt = Date.now();
      const trigger = options?.trigger || "detail_open";
      const before = loadState();
      const previous = visibleShipments(before).find(row => row.identity.id === shipmentId);
      if (!previous) throw new Error("该快递已从列表中移除");
      const fresh = await refreshStoredWatchShipments();
      const state = fresh ?? before;
      const shipment = visibleShipments(state).find(row => row.identity.id === shipmentId);
      if (!shipment) {
        writeDiagnostic("detail.refresh.skipped", { flowId, trigger, stage: "watch_page",
          durationMs: Date.now() - startedAt, persisted: false, skipReason: "removed", result: "removed" });
        throw new Error("该快递已从列表中移除");
      }
      const refreshed = shipment.updatedAtMs > previous.updatedAtMs;
      const result = fresh === undefined ? "query_failed" : refreshed ? "applied" : "unchanged";
      writeDiagnostic(refreshed ? "detail.refresh.committed" : "detail.refresh.skipped", {
        flowId, trigger, stage: "watch_page", durationMs: Date.now() - startedAt, persisted: refreshed,
        result, ...(refreshed ? {} : { skipReason: result }),
      }, fresh === undefined ? "warning" : "info");
      return { state, shipment, refreshed, querySucceeded: fresh !== undefined };
    })();
  }
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
  priority: H5Priority = "interactive",
): Promise<T> {
  return withH5Controller(runtimeState, capture, deadlineAtMs, signal, priority);
}

export const runH5CaptureForTesting = runParcelWebRead;

export function runShipmentEnrichmentForTesting(
  ...args: Parameters<typeof refreshShipmentEnrichment> extends [SyncRuntimeState, ...infer Rest] ? Rest : never
): Promise<RefreshSummary> {
  return refreshShipmentEnrichment(runtimeState, ...args);
}

const enrichingPendingCloudShipmentIds = new Set<string>();

/**
 * Enriches non-deleted `timeline.provider === "pending"` cloud manual shipments (both `pddCloudOrigin` from
 * `express` / `express_pdd_link` and ordinary cloud manual `express`) immediately via the non-WebView manual chain
 * (`pdd_h5` when a PDD session is active + `phone4` + `v6_query -> v4_query -> kdniao`), suppressing first-discovery
 * status-transition notifications and reloading widgets when visible presentation changes.
 */
export async function enrichPendingCloudShipments(
  publish?: (state: AppState) => void,
): Promise<AppState | undefined> {
  if (SCRIPT_BUILD_TRACK !== "formal") return undefined;
  const generation = gatewayCredentialGeneration();
  if (generation === null) return undefined;
  const baseState = loadState();
  const targetRows = baseState.shipments.filter(
    (row) =>
      row.identity.manuallyAdded &&
      row.timeline.provider === "pending" &&
      !row.forcedCompletedAtMs &&
      !enrichingPendingCloudShipmentIds.has(row.identity.id),
  );
  if (!targetRows.length) return undefined;
  const targetIds = new Set(targetRows.map((row) => row.identity.id));
  for (const id of targetIds) enrichingPendingCloudShipmentIds.add(id);
  const controller = new AbortController();
  const isCurrent = () =>
    !controller.signal.aborted && gatewayCredentialGeneration() === generation;
  const stopCredential = onGatewayCredentialChanged(() => {
    if (gatewayCredentialGeneration() !== generation) controller.abort();
  });
  try {
    const hasPddPending = targetRows.some((row) => Boolean(row.pddCloudOrigin || row.pddImport));
    const pddObservePromise = hasPddPending && projectionSceneActive()
      ? (async () => {
          try {
            const { platformSession } = await import("./platform-accounts");
            if (!platformSession("pinduoduo")) return;
            const { refreshPlatformParcels } = await import("./platform-parcel-sync");
            await refreshPlatformParcels((next) => publish?.(next), "observe");
          } catch {
            /* Best-effort PDD H5 trace supplement; non-WebView manual chain still runs below. */
          }
        })()
      : Promise.resolve();
    const flowId = createDiagnosticFlowId("cloud_pdd_enrich");
    const leaseAdapter: FullRefreshLease = {
      generation,
      signal: controller.signal,
      isCurrent,
      assertCurrent: () => {
        if (!isCurrent()) throw new Error("Cloud pending enrichment superseded");
      },
    };
    const notificationContext = {
      previousById: new Map(baseState.shipments.map((row) => [row.identity.id, row])),
      batchId: flowId,
      orderMerges: new Map<string, string[]>(),
    };
    const { checkpoint } = fullRefreshCheckpoints(
      runtimeState,
      SCRIPT_BINDING_SOURCE,
      flowId,
      leaseAdapter,
      baseState,
      notificationContext,
    );
    const skipRefreshIds = new Set(
      baseState.shipments
        .filter((row) => !targetIds.has(row.identity.id))
        .map((row) => row.identity.id),
    );
    const [enriched] = await Promise.all([
      refreshShipmentEnrichment(
        runtimeState,
        baseState,
        SCRIPT_BINDING_SOURCE,
        flowId,
        checkpoint,
        deadlineAfter(15_000),
        skipRefreshIds,
        false,
        false,
        controller.signal,
        {},
        false,
        new Set(),
        new CarrierRecognitionBudget(undefined, { syncRound: true, flowId }),
        false,
      ),
      pddObservePromise,
    ]);
    if (!isCurrent()) return undefined;
    const latest = loadState();
    const finalState = latest.revision >= enriched.state.revision ? latest : enriched.state;
    if (finalState.revision > baseState.revision) {
      publish?.(finalState);
      if (statePresentationFingerprint(finalState) !== statePresentationFingerprint(baseState)) {
        requestWidgetReload();
      }
      return finalState;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    stopCredential();
    for (const id of targetIds) enrichingPendingCloudShipmentIds.delete(id);
  }
}
