/** Concurrent background enrichment scheduler for account detail supplements, SF alignment, and Online tasks. */
import { AbortController, type AbortSignal } from "scripting";
import type { AppState, BindingSource, RefreshSummary } from "../../models";
import { refreshAccountParcel } from "../account-sync";
import { queryManualForSource } from "../manual-query";
import { displayWaybill } from "../shipment-policy";
import { loadState } from "../storage";
import { deadlineAfter, deadlineExpired } from "../deadline";
import { writeDiagnostic } from "../logger";
import { CarrierRecognitionBudget, truncatedCarrierRecognitionLast } from "../carrier-recognition";
import {
  assertRefreshSignal,
  MANUAL_QUERY_BUDGET_MS,
  MANUAL_REFRESH_CONCURRENCY,
  shipmentDiagnosticDetails,
  type DeferredRouteMutations,
  type EnrichmentRuntime,
  type ManualRefreshTask,
  type RefreshCheckpoint,
  type RefreshCheckpointFn,
  type SyncRuntimeState,
} from "./shared";
import {
  manualRefreshTasks,
  refreshBackgroundSfAlignment,
  refreshOnlineShipment,
} from "./manual-chain-runner";
import { refreshHomeAccountShipment } from "./cainiao-v5-supplement";

export async function refreshShipmentEnrichment(
  runtimeState: SyncRuntimeState,
  state: AppState,
  source: BindingSource,
  flowId: string,
  checkpoint: RefreshCheckpoint,
  deadlineAtMs?: number,
  skipRefreshIds: ReadonlySet<string> = new Set(),
  forceManualRefresh = false,
  webViewEnrichment = true,
  signal?: AbortSignal,
  runtimeOverrides: Partial<EnrichmentRuntime> = {},
  accountSourceFollowup = false,
  cainiaoFollowupIds: ReadonlySet<string> = new Set(),
  /** The sync round's recognition wait (用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒). */
  recognitionBudget: CarrierRecognitionBudget = new CarrierRecognitionBudget(),
  backgroundHostSafe = false,
  /**
   * E1/PF5: called when the first job actually queries (the per-shipment phase has work). C1: a job only
   * calls it after its own cooldown and lease gates, so a round whose every job is skipped (cooldown,
   * 30-second floor, another owner) never reports 「列表已更新」.
   */
  onWorkStarted: () => void = () => {},
  cainiaoListUpdatedIds: ReadonlySet<string> = cainiaoFollowupIds,
): Promise<RefreshSummary> {
  let currentState = state;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const promotedPendingShipmentIds: string[] = [];
  const now = Date.now();
  // 用户 2026-09-27 第二轮清单：截断排后。A manual row is recognised at the start of its own task, so a manual row whose
  // waybill was cut off in an earlier round has its task queued after the others. 整个任务排后（这一行本轮的 provider
  // 查询也随之排后）属截断排后细则里的「整行（整个任务）排后」，用户 2026-09-27 提交前核对答「这样做」。
  const queued = truncatedCarrierRecognitionLast(
    manualRefreshTasks(currentState, source, now, skipRefreshIds, forceManualRefresh,
      accountSourceFollowup, cainiaoFollowupIds, (frozen) => writeDiagnostic("refresh.stage.skipped", {
        flowId, source, stage: "account_detail", ...shipmentDiagnosticDetails(frozen, "v5_query"),
        result: "signed_frozen", skipReason: "signed_frozen" }), backgroundHostSafe, cainiaoListUpdatedIds),
    (task) => {
      const row = currentState.shipments.find((shipment) => shipment.identity.id === task.id);
      return row?.identity.manuallyAdded && !task.accountDetail ? [displayWaybill(row)] : [];
    },
  );
  type Job = ManualRefreshTask;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort);
  type JobResult = {job: Job; summary: RefreshSummary} | {job: Job; error: unknown};
  const active = new Map<Job, Promise<JobResult>>();
  let firstFailure: {error: unknown} | undefined;
  const run = async (job: Job): Promise<JobResult> => {
    let jobBase = currentState;
    const commitFn: RefreshCheckpointFn = (candidate, mutations, stage, base = jobBase) => {
      assertRefreshSignal(controller.signal);
      // Each task rebases from what it read, not another task's newer checkpoint.
      try {
        currentState = checkpoint(candidate, mutations, stage, base);
      } catch (error) {
        if (stage !== "account_detail") {
          firstFailure ??= {error};
          controller.abort();
        }
        throw error;
      }
      jobBase = currentState;
      return currentState;
    };
    const commit: RefreshCheckpoint = Object.assign(commitFn, {
      ...(checkpoint.transientManualLease ? { transientManualLease: true } : {}),
      ...(checkpoint.batched
        ? {
            batched: async (
              candidate: AppState,
              mutations: DeferredRouteMutations,
              stage: string,
              base = jobBase,
            ): Promise<AppState> => {
              assertRefreshSignal(controller.signal);
              try {
                currentState = await checkpoint.batched!(candidate, mutations, stage, base);
              } catch (error) {
                if (stage !== "account_detail") {
                  firstFailure ??= {error};
                  controller.abort();
                }
                throw error;
              }
              jobBase = currentState;
              return currentState;
            },
          }
        : {}),
    });
    try {
      assertRefreshSignal(controller.signal);
      // Queued work must observe deletions, sign-offs, and binding changes made while waiting.
      currentState = loadState(Date.now());
      jobBase = currentState;
      const target = currentState.shipments.find(shipment => shipment.identity.id === job.id);
      if (target && !target.identity.manuallyAdded) {
        const phone = String(target.identity.phone || "").replace(/\D/g, "");
        const originalBinding = state.bindings.find(binding => binding.source === source && binding.phone === phone);
        const currentBinding = currentState.bindings.find(binding => binding.source === source && binding.phone === phone);
        if (!originalBinding || !currentBinding || originalBinding.boundAtMs !== currentBinding.boundAtMs) {
          return {job, summary: {state: currentState, attempted: 0, succeeded: 0, failed: 0,
            promotedPendingShipmentIds: []}};
        }
      }
      const result = job.backgroundAlignment ? await refreshBackgroundSfAlignment(
        runtimeState, currentState, source, flowId, commit, job, deadlineAtMs, controller.signal,
        runtimeOverrides.queryManualForSource || queryManualForSource, onWorkStarted,
      ) : job.accountDetail ? await refreshHomeAccountShipment(
        runtimeState, currentState, source, flowId, commit, job, deadlineAtMs, controller.signal,
        runtimeOverrides.refreshAccountParcel || refreshAccountParcel, onWorkStarted, forceManualRefresh,
      ) : await refreshOnlineShipment(
        currentState, source, flowId, commit, job, deadlineAtMs, forceManualRefresh,
        controller.signal, runtimeOverrides.queryManualForSource || queryManualForSource,
        recognitionBudget, backgroundHostSafe, onWorkStarted,
      );
      if (job.backgroundAlignment) currentState = loadState(Date.now());
      return {job, summary: result};
    } catch (error) {
      firstFailure ??= {error};
      controller.abort();
      return {job, error};
    }
  };
  try {
    while (queued.length || active.size) {
      assertRefreshSignal(controller.signal);
      while (active.size < MANUAL_REFRESH_CONCURRENCY && queued.length && !deadlineExpired(deadlineAtMs)) {
        if (!queued[0].accountDetail) {
          await runtimeState.refreshCoordinator.waitForForeground(source, deadlineAtMs ?? deadlineAfter(MANUAL_QUERY_BUDGET_MS), controller.signal);
        }
        assertRefreshSignal(controller.signal);
        if (deadlineExpired(deadlineAtMs)) break;
        const job = queued.shift()!;
        active.set(job, run(job));
      }
      if (!active.size) break;
      const result = await Promise.race(active.values());
      active.delete(result.job);
      if ("error" in result) throw result.error;
      attempted += result.summary.attempted;
      succeeded += result.summary.succeeded;
      failed += result.summary.failed;
      for (const id of result.summary.promotedPendingShipmentIds) {
        if (!promotedPendingShipmentIds.includes(id)) promotedPendingShipmentIds.push(id);
      }
    }
    assertRefreshSignal(controller.signal);
    return {state: currentState, attempted, succeeded, failed, promotedPendingShipmentIds};
  } catch (error) {
    controller.abort();
    await Promise.all(active.values());
    throw firstFailure ? firstFailure.error : error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
