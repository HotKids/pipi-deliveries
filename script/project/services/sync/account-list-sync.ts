/** Account list synchronization, parcel owner merging, and phone binding operations. */
import type { AccountBinding, AppState, BindingSource, Shipment } from "../../models";
import { accountParcelWithExistingProjection, fetchAccountParcels, parcelToShipment, applyEnhancementMetadata, withListStructuredSemantic, verifyAccountBinding } from "../account-sync";
import type { AccountParcelDto } from "../account-parser";
import { EnhancementUnbindUnavailable } from "../enhancement-unsubscribe";
import { absorbHistoricalShipment, absorbManualShipment, accountShipmentIsSupersededRecord, accountShipmentReusesWaybill, applyAccountShipment, automaticBindingIdentityOf, automaticSourceOf, displayWaybill, isHistoricalAccountDuplicate, manualShipmentReusedBy, reusedWaybillShipment, recordAutomaticOwnerRefresh, sameCanonicalWaybill } from "../shipment-policy";
import { addBinding, enableBindingEnhancement, bindingsForSource, loadState, privateHash, pruneRoutesForState as safelyPruneRoutes, removeBinding } from "../storage";
import { normalizeWaybill, normalizedProjectedWaybill, sortShipments, timelineLatestEventAt, parseProviderTime } from "../status";
import { acquireRenewingDurableRefreshLease } from "../refresh-runtime-state";
import { requestWidgetReload } from "../widgets";
import { deadlineAfter } from "../deadline";
import { ACCOUNT_FOLLOWUP_RESERVE_MS, ACCOUNT_LIST_BUDGET_MS, accountChildDeadline } from "../account-sync-policy";
import { enhancementOperation, requireEnhancementBinding } from "../enhanced-account";
import { createDiagnosticFlowId, diagnosticErrorDetails, diagnosticState, diagnosticsEnabled, openStageCancellationEnd, writeDiagnostic, writeDiagnosticBatch, changedSinceLastLogged, type DiagnosticDetails } from "../logger";
import { SCRIPT_BINDING_SOURCE, requireScriptSource } from "../script-source";
import { CarrierRecognitionBudget, forgetCarrierRecognition, truncatedCarrierRecognitionLast } from "../carrier-recognition";
import { GatewayError } from "../gateway";
import {
  assertRefreshSignal,
  MANUAL_QUERY_BUDGET_MS,
  projectionOwnerFingerprint,
  recognizeAwaitingCarrier,
  replaceById,
  rethrowRefreshCancellation,
  shipmentDiagnosticDetails,
  stageBudgetMs,
  type DeferredRouteMutations,
} from "./shared";
import { deferIncomingRoute, deferPersistedRoute } from "./route-publications";

/** Trace the same list observation before projection, after merge and after the durable commit. */
export function logJingDongListRecords(
  parcels: readonly AccountParcelDto[],
  before: AppState,
  merged: AppState,
  stored: AppState,
  flowId: string,
  now: number,
): void {
  if (!diagnosticsEnabled()) return;
  const receivedOwners = new Set<string>();
  const records: DiagnosticDetails[] = [];
  for (const parcel of parcels) {
    if (parcel.sourceProvider.toLowerCase() !== "jingdong") continue;
    const ownerId = normalizeWaybill(parcel.ownerId);
    receivedOwners.add(ownerId);
    const findOwner = (state: AppState) => state.shipments.find(shipment =>
      !shipment.identity.manuallyAdded &&
      shipment.identity.bindingSource === parcel.source &&
      ((shipment.identity.sourceProvider?.toLowerCase() === "jingdong" && normalizeWaybill(shipment.identity.sourceId) === ownerId) ||
        shipment.automaticOwnership?.observations.some(observation =>
          observation.source === parcel.source && observation.identity.sourceProvider?.toLowerCase() === "jingdong" &&
          normalizeWaybill(observation.identity.sourceId) === ownerId)));
    const previous = findOwner(before);
    const prepared = parcelToShipment(accountParcelWithExistingProjection(parcel, before.shipments),
      before.bindings.filter(binding => binding.source === parcel.source).map(binding => binding.phone), now);
    const mergedOwner = findOwner(merged);
    const storedOwner = findOwner(stored);
    const displayed = storedOwner || prepared || previous;
    records.push({
      ...(displayed ? shipmentDiagnosticDetails(displayed, "v5_list") : {}),
      flowId, source: parcel.source, sourceProvider: "jingdong", stage: "account_list",
      ownerFingerprint: projectionOwnerFingerprint(ownerId), revision: stored.revision,
      result: !prepared ? "binding_unmatched" : storedOwner ? "stored" : "not_retained",
      bindingMatched: Boolean(prepared),
      listStateNumber: /^10[1-9]$|^11[01]$/.test(parcel.sourceStateCode) ? Number(parcel.sourceStateCode) : undefined,
      listStatusScope: parcel.normalizedStatusScope || "unknown",
      listStatusSemantic: parcel.semantic,
      preparedStatusSemantic: prepared?.sourceTimeline?.semantic || "UNKNOWN",
      previousFeedStatusSemantic: previous?.sourceTimeline?.semantic || "UNKNOWN",
      mergedFeedStatusSemantic: mergedOwner?.sourceTimeline?.semantic || "UNKNOWN",
      feedStatusSemantic: storedOwner?.sourceTimeline?.semantic || "UNKNOWN",
      listEventAtMs: parseProviderTime(parcel.latestTimeText) || 0,
      preparedEventAtMs: prepared?.sourceTimeline?.statusEventAtMs || 0,
      previousFeedEventAtMs: previous?.sourceTimeline ? timelineLatestEventAt(previous.sourceTimeline) : 0,
      mergedFeedEventAtMs: mergedOwner?.sourceTimeline ? timelineLatestEventAt(mergedOwner.sourceTimeline) : 0,
    });
  }
  for (const previous of before.shipments) {
    if (previous.identity.manuallyAdded || previous.identity.bindingSource !== SCRIPT_BINDING_SOURCE ||
        previous.identity.sourceProvider?.toLowerCase() !== "jingdong" ||
        receivedOwners.has(normalizeWaybill(previous.identity.sourceId))) continue;
    const current = stored.shipments.find(shipment => shipment.identity.id === previous.identity.id);
    records.push({
      ...shipmentDiagnosticDetails(current || previous, "v5_list"),
      flowId, source: SCRIPT_BINDING_SOURCE, stage: "account_list", result: "omitted",
      ownerFingerprint: projectionOwnerFingerprint(normalizeWaybill(previous.identity.sourceId)),
      revision: stored.revision,
      previousFeedStatusSemantic: previous.sourceTimeline?.semantic || "UNKNOWN",
      feedStatusSemantic: current?.sourceTimeline?.semantic || "UNKNOWN",
    });
  }
  // A row the list repeats unchanged is not logged again on every sync (2026-11-12 清理, Pipi parity):
  // the line is written when its content changes, otherwise at most every six hours.
  const changed = records.filter((record) => {
    const { flowId: _flowId, revision: _revision, ...content } = record;
    return changedSinceLastLogged(
      `account.list.record\u0000${String(record.source || "")}\u0000${String(record.ownerFingerprint || "")}`,
      JSON.stringify(content),
    );
  });
  if (changed.length) writeDiagnosticBatch("account.list.record", changed);
}

export function mergeAccountParcel(
  state: AppState,
  shipmentsInput: readonly Shipment[],
  parcel: AccountParcelDto,
  boundPhones: readonly string[],
  source: BindingSource,
  now: number,
  routeMutations: DeferredRouteMutations,
  /**
   * Collects every merge of a projected order row with another row of its waybill: surviving row id →
   * the absorbed automatic waybill row ids (see the end of this function).
   */
  orderMerges?: Map<string, string[]>,
): Shipment[] {
  let shipments = [...shipmentsInput];
  const resolvedParcel = accountParcelWithExistingProjection(parcel, shipments);
  const incoming = parcelToShipment(resolvedParcel, boundPhones, now);
  if (!incoming) return shipments;
  // 归属方案 T1（用户 2026-09-25 采纳）：一条上游记录只写它自己的行（同一 id）。同一运单号上的另一条自动记录（订单号的
  // 行、运单号的行、另一张订单）不再被收走，也不再是写入目标；谁先占号谁显示，其余挂靠，由落库时的归属判断决定。
  const current = shipments.find(
    (item) => item.identity.id === incoming.identity.id,
  );
  // 承运商复用旧运单号（用户 2026-10-01/02「C 新件优先（含 A）」「至少晚 24 小时」，四端；services/waybill-reuse.ts）。
  // 京东业务来源排除：有京东订单投影到这个号码上时（那是一票京东购物的运单）照旧。
  const jingDongOrderOnNumber = shipments.some((item) =>
    item.identity.accountOrder && normalizedProjectedWaybill(item.identity) === displayWaybill(incoming));
  // 号码已被至少晚 24 小时的新件拿走（这一行自己，或同号的手动行）时，再来的旧记录一律不写，不再来回翻（细节 5）。
  if (!jingDongOrderOnNumber && shipments.some((item) =>
    (item.identity.id === incoming.identity.id ||
      (item.identity.manuallyAdded && sameCanonicalWaybill(item, incoming))) &&
    accountShipmentIsSupersededRecord(item, incoming, now))) {
    return shipments;
  }
  // 新件拿走这一行：当作初次出现（不通知），旧件的轨迹、签收闩锁与用户字段一概不留（shipment-policy reusedWaybillShipment）。
  let reusedWaybill = !jingDongOrderOnNumber && accountShipmentReusesWaybill(current, incoming, now);
  let merged = withListStructuredSemantic(reusedWaybill
    ? reusedWaybillShipment(incoming, now)
    : applyAccountShipment(current, incoming, now), resolvedParcel);
  const incomingSource = automaticSourceOf(incoming);
  const incomingBindingIdentity = automaticBindingIdentityOf(incoming);
  const ownership = merged.automaticOwnership;
  const establishedRouteOwnerMatches =
    ownership?.ownerSource === incomingSource &&
    ownership.ownerBindingIdentity === incomingBindingIdentity;
  // Timeline ownership needs timed tracks, but a new row's own trusted route must still publish
  // atomically so the provisional pointer can never outlive its sidecar.
  const unclaimedPresentedIdentityMatches =
    !ownership?.ownerSource &&
    merged.identity.id === incoming.identity.id &&
    automaticSourceOf(merged) === incomingSource &&
    automaticBindingIdentityOf(merged) === incomingBindingIdentity;
  if (
    establishedRouteOwnerMatches || unclaimedPresentedIdentityMatches
  ) {
    merged = deferIncomingRoute(
      merged,
      incoming,
      resolvedParcel.routeUrl,
      now,
      routeMutations,
    );
  }
  // 自动来源照 §5.2 接管同号的手动行（归属-1：投影订单也一样，iOS 照现状并入手动轨迹，手动行随之退出列表）；
  // 旧版本留下的无来源历史行照旧并入。
  const duplicates = shipments.filter(
    (item) =>
      item.identity.id !== merged.identity.id &&
      (
        (item.identity.manuallyAdded && sameCanonicalWaybill(item, merged)) ||
        isHistoricalAccountDuplicate(item, merged)
      ),
  );
  for (const duplicate of duplicates) {
    if (duplicate.identity.manuallyAdded && !jingDongOrderOnNumber &&
        manualShipmentReusedBy(duplicate, incoming, now)) {
      // 细节 4：已签收的旧手动行同样由新件接管，不并入它的手动轨迹，备注也不带过来。
      reusedWaybill = true;
    } else if (reusedWaybill && !duplicate.identity.manuallyAdded) {
      // 旧版本留下的同号历史行是旧件的：新件接管时一起退出，不把它的轨迹并给新件。
    } else if (duplicate.identity.manuallyAdded) {
      merged = absorbManualShipment(merged, duplicate, now);
      // 归属-6（用户 2026-09-25）：退出列表的那一行的备注，在接管它的行还没有备注时带过去，从不覆盖已有的备注。
      const note = String(duplicate.note || "").trim();
      if (note && !String(merged.note || "").trim()) merged = { ...merged, note };
    } else {
      merged = absorbHistoricalShipment(merged, duplicate, now);
      merged = deferPersistedRoute(merged, duplicate, now, routeMutations);
    }
    shipments = shipments.filter(
      (item) => item.identity.id !== duplicate.identity.id,
    );
  }
  if (reusedWaybill) {
    // Pipi 同一事件：不带运单号、行 id 或手机号。
    writeDiagnostic("account.owner.superseded", {
      takeoverReason: "waybill_reuse",
      fromProvider: !current || current.identity.manuallyAdded ? "manual" : source === "interface6" ? "v6" : "v5",
      toProvider: source === "interface6" ? "v6" : "v5",
    });
    // 细节 2：号码可能换了承运商，这台设备上这个号码的识别记录清掉，下一轮从头识别。
    try {
      forgetCarrierRecognition(displayWaybill(merged));
    } catch (error) {
      writeDiagnostic("account.owner.superseded", {
        takeoverReason: "waybill_reuse", result: "recognition_reset_failed", ...diagnosticErrorDetails(error),
      }, "warning");
    }
  }
  // 用户 2026-09-25（两条合起来）：订单行投影后与同一运单的已有行合并的那一轮，通知判断改用被并入的运单行当
  // 「上一次状态」，并且只有展示状态变了才推；之后各轮照旧。Either side may survive the merge. When the
  // projected order row survives, the absorbed automatic waybill rows (not orders, not manual) are
  // recorded as its baseline candidates; when the waybill row survives, it is itself that baseline.
  // 归属方案之后自动行之间不再合并，这条规则只在投影订单接管手动行或旧历史行的那一轮还会生效，留作兜底（归属-3）。
  const absorbedRows = [current, ...duplicates].filter((row): row is Shipment =>
    Boolean(row && row.identity.id !== merged.identity.id));
  if (
    orderMerges &&
    absorbedRows.length &&
    [merged, ...absorbedRows].some((row) =>
      row.identity.accountOrder && normalizedProjectedWaybill(row.identity))
  ) {
    const waybillRowIds = merged.identity.accountOrder && normalizedProjectedWaybill(merged.identity)
      ? absorbedRows
          .filter((row) => !row.identity.manuallyAdded && !row.identity.accountOrder)
          .map((row) => row.identity.id)
      : [];
    const recorded = orderMerges.get(merged.identity.id) || [];
    orderMerges.set(merged.identity.id, [
      ...recorded,
      ...waybillRowIds.filter((id) => !recorded.includes(id)),
    ]);
  }
  return [
    ...shipments.filter(
      (item) =>
        item.identity.id !== merged.identity.id &&
        item.identity.id !== current?.identity.id,
    ),
    merged,
  ];
}

export async function synchronizeAccountList(
  state: AppState,
  source: BindingSource,
  now: number,
  routeMutations: DeferredRouteMutations,
  flowId: string,
  deadlineAtMs?: number,
  followupReserveMs = ACCOUNT_FOLLOWUP_RESERVE_MS,
  signal?: AbortSignal,
  orderMerges?: Map<string, string[]>,
  /** The sync round's recognition wait (用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒). */
  recognitionBudget: CarrierRecognitionBudget = new CarrierRecognitionBudget(),
): Promise<{
  state: AppState;
  parcels: readonly AccountParcelDto[];
  observedOwnerKeys: ReadonlySet<string>;
  attempted: number;
  succeeded: number;
  failed: number;
  canContinue: boolean;
}> {
  const sourceBindings = bindingsForSource(state, source);
  if (!sourceBindings.length) {
    return {
      state,
      parcels: [],
      observedOwnerKeys: new Set(),
      attempted: 0,
      succeeded: 0,
      failed: 0,
      canContinue: true,
    };
  }
  let attempted = 1;
  let succeeded = 0;
  let failed = 0;
  let shipments = [...state.shipments];
  const startedAt = Date.now();
  const listDeadlineAtMs = accountChildDeadline(
    deadlineAtMs,
    ACCOUNT_LIST_BUDGET_MS,
    followupReserveMs,
    startedAt,
  );
  let fetched: Awaited<ReturnType<typeof fetchAccountParcels>>;
  try {
    writeDiagnostic("account.sync.started", {
      flowId, source, stage: "account_list",
      budgetMs: stageBudgetMs(listDeadlineAtMs, startedAt),
    });
    // 用户 2026-09-28：cancelled by the parent refresh, the list stage still ends with its own failure
    // (errorCategory "cancelled") where the cancellation reaches it; the catch below then lets the
    // cancellation escape before any stage-failure handling, as before.
    // Written before the flow's own end even when the coordinator reports that end first (openStageCancellationEnd).
    const listCancelled = openStageCancellationEnd(flowId, signal, () => writeDiagnostic("account.sync.failed", {
      flowId, source, stage: "account_list", durationMs: Date.now() - startedAt,
      budgetMs: stageBudgetMs(listDeadlineAtMs, startedAt), result: "failed", errorCategory: "cancelled",
    }, "error"));
    const endCancelledList = () => {
      if (signal?.aborted) listCancelled.end();
      else listCancelled.close();
    };
    fetched = await fetchAccountParcels(
      source,
      state.bindings,
      listDeadlineAtMs,
      signal,
      recognitionBudget,
      state.shipments,
      { flowId },
    ).catch((error: unknown) => {
      endCancelledList();
      throw error;
    });
    endCancelledList();
    assertRefreshSignal(signal);
  } catch (error) {
    rethrowRefreshCancellation(error, signal);
    failed++;
    const cachedShipments = state.shipments.filter(
      (shipment) => shipment.identity.bindingSource === source,
    ).length;
    const cachedPendingQueries = state.pendingQueries.filter(
      (pending) => pending.source === source,
    ).length;
    const requiresCredentialRecovery = error instanceof GatewayError &&
      (
        error.status === 401 ||
        error.message.includes("请先配置 Access Key") ||
        error.message.includes("Access Key 无效或已失效")
      );
    const canContinue = !requiresCredentialRecovery &&
      (cachedShipments > 0 || cachedPendingQueries > 0);
    writeDiagnostic(
      "account.sync.failed",
      {
        flowId,
        source,
        stage: "account_list",
        durationMs: Date.now() - startedAt,
        budgetMs: stageBudgetMs(listDeadlineAtMs, startedAt),
        result: canContinue ? "cached_fallback" : "failed",
        ...diagnosticErrorDetails(error),
      },
      "error",
    );
    if (requiresCredentialRecovery) {
      throw error;
    }
    return {
      state,
      parcels: [],
      observedOwnerKeys: new Set(),
      attempted,
      succeeded: 0,
      failed,
      canContinue,
    };
  }
  const parcels = fetched.parcels;
  for (const parcel of fetched.cachedEnhancements || []) {
    shipments = shipments.map(shipment => applyEnhancementMetadata(shipment, parcel, now));
  }
  succeeded++;
  writeDiagnostic("account.sync.parsed", {
    flowId,
    source,
    stage: "account_list",
    durationMs: Date.now() - startedAt,
    budgetMs: stageBudgetMs(listDeadlineAtMs, startedAt),
    rawRecords: fetched.rawRecords,
    records: parcels.length,
    rejectedRecords: fetched.rejectedRecords,
    orders: parcels.filter((parcel) => parcel.accountOrder).length,
    routableOrders: parcels.filter(
      (parcel) => parcel.accountOrder && Boolean(parcel.projectionUrl),
    ).length,
  });
  const boundPhones = sourceBindings.map((binding) => binding.phone);
  const observedOwnerKeys = new Set<string>();
  for (const parcel of parcels) {
    const observed = parcelToShipment(parcel, boundPhones, now);
    if (observed) {
      observedOwnerKeys.add(
        `${observed.identity.id}\u0000${automaticBindingIdentityOf(observed)}`,
      );
    }
    shipments = mergeAccountParcel(
      state,
      shipments,
      parcel,
      boundPhones,
      source,
      now,
      routeMutations,
      orderMerges,
    );
  }
  // T23 (user 2026-09-26): a projected order already stored without a matched carrier is recognised again with
  // every list round, not only on its detail page.
  // 用户 2026-09-27 第二轮清单：截断排后。
  for (const shipment of truncatedCarrierRecognitionLast(shipments, (row) => [displayWaybill(row)])) {
    if (shipment.identity.bindingSource !== source || !shipment.identity.accountOrder ||
        !normalizedProjectedWaybill(shipment.identity)) continue;
    const recognized = await recognizeAwaitingCarrier(shipment, listDeadlineAtMs, signal, recognitionBudget);
    if (recognized !== shipment) shipments = replaceById(shipments, recognized);
  }
  assertRefreshSignal(signal);
  shipments = shipments.map((shipment) => {
    const ownership = shipment.automaticOwnership;
    if (!ownership || ownership.ownerSource !== source) return shipment;
    const ownerObservation = ownership.observations.find(
      (observation) =>
        observation.source === source &&
        observation.bindingIdentity === ownership.ownerBindingIdentity,
    );
    return recordAutomaticOwnerRefresh(
      shipment,
      source,
      ownerObservation && observedOwnerKeys.has(
          `${ownerObservation.identity.id}\u0000${ownerObservation.bindingIdentity}`,
        )
        ? "observed"
        : "missing",
      now,
    );
  });
  return {
    state: { ...state, shipments: sortShipments(shipments) },
    parcels,
    observedOwnerKeys,
    attempted,
    succeeded,
    failed,
    canContinue: true,
  };
}

export async function bindPhone(
  source: BindingSource,
  phone: string,
  code: string,
  diagnosticFlowId?: string,
  enhanced = false,
): Promise<AppState> {
  requireScriptSource(source);
  const bindingLease = acquireRenewingDurableRefreshLease(`binding:${privateHash(phone)}`, MANUAL_QUERY_BUDGET_MS + 1_000);
  if (!bindingLease) throw new Error("该手机号正在验证或解绑，请稍后重试");
  try {
    const flowId = diagnosticFlowId || createDiagnosticFlowId("bind");
    const startedAt = Date.now();
    writeDiagnostic("binding.verify.started", { flowId, source });
    if (enhanced) {
      const binding = requireEnhancementBinding(loadState().bindings, phone);
      const identityFingerprint = await enhancementOperation("bind", phone, { code, deadlineAtMs: deadlineAfter(MANUAL_QUERY_BUDGET_MS) });
      if (!bindingLease.isCurrent()) throw new Error("手机号验证已超时，请稍后重试");
      const next = enableBindingEnhancement(phone, binding.boundAtMs, Date.now(), identityFingerprint);
      return next;
    }
    try {
      await verifyAccountBinding(
        source,
        phone,
        code,
        deadlineAfter(MANUAL_QUERY_BUDGET_MS),
      );
    } catch (error) {
      writeDiagnostic(
        "binding.verify.failed",
        {
          flowId,
          source,
          durationMs: Date.now() - startedAt,
          ...diagnosticErrorDetails(error),
        },
        "error",
      );
      throw error;
    }
    writeDiagnostic("binding.verify.succeeded", {
      flowId,
      source,
      durationMs: Date.now() - startedAt,
    });
    try {
      if (!bindingLease.isCurrent()) throw new Error("手机号验证已超时，请稍后重试");
      const bound = addBinding(source, phone);
      writeDiagnostic("binding.persisted", {
        flowId,
        source,
        ...diagnosticState(bound),
      });
      return bound;
    } catch (error) {
      writeDiagnostic(
        "binding.persist.failed",
        {
          flowId,
          source,
          durationMs: Date.now() - startedAt,
          ...diagnosticErrorDetails(error),
        },
        "error",
      );
      throw error;
    }
  } finally { bindingLease.release(); }
}

export async function unbindPhone(
  source: BindingSource,
  phone: string,
  options: { localOnly?: boolean; expectedBinding?: AccountBinding } = {},
): Promise<AppState> {
  requireScriptSource(source);
  const bindingLease = acquireRenewingDurableRefreshLease(`binding:${privateHash(phone)}`, MANUAL_QUERY_BUDGET_MS + 1_000);
  if (!bindingLease) throw new Error("该手机号正在验证或解绑，请稍后重试");
  try {
    const binding = loadState().bindings.find(value => value.source === source && value.phone === phone);
    const expected = options.expectedBinding;
    if (expected && (expected.source !== source || expected.phone !== phone || !binding || binding.boundAtMs !== expected.boundAtMs ||
        binding.enhancedMode !== expected.enhancedMode || binding.enhancedAtMs !== expected.enhancedAtMs ||
        binding.enhancedIdentityFingerprint !== expected.enhancedIdentityFingerprint)) {
      throw new Error("手机号绑定已变更，请稍后重试");
    }
    let pendingUnsubscribe: { identityFingerprint: string } | undefined;
    if (binding?.enhancedMode) {
      if (options.localOnly) {
        // A currently readable identity does not establish a legacy binding's original subscription.
        pendingUnsubscribe = { identityFingerprint: binding.enhancedIdentityFingerprint || "" };
      } else {
        try { await enhancementOperation("unbind", phone, { deadlineAtMs: deadlineAfter(MANUAL_QUERY_BUDGET_MS),
          expectedIdentityFingerprint: binding.enhancedIdentityFingerprint }); }
        catch (error) {
          throw new EnhancementUnbindUnavailable(error instanceof Error ? error.message : "远端解绑未完成，请稍后重试");
        }
      }
    }
    if (!bindingLease.isCurrent()) throw new Error("手机号解绑已超时，请稍后重试");
    const next = removeBinding(source, phone, Date.now(), binding, pendingUnsubscribe);
    safelyPruneRoutes(next);
    requestWidgetReload();
    return next;
  } finally { bindingLease.release(); }
}
