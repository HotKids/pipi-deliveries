/** JingDong union-page order projection, per-order cooldowns, held-carrier release, and Home stored-row pass. */
import type { AbortSignal } from "scripting";
import type { AccountBinding, AppState, BindingSource, Shipment, StatusSemantic, TimelinePackage } from "../../models";
import { accountParcelStructuredSemantic, accountParcelWithExistingProjection, normalizeAccountParcelCarrierBestEffort, parcelToShipment, storedAccountListStructuredSemantic } from "../account-sync";
import type { AccountParcelDto } from "../account-parser";
import { replayPendingShipmentNotifications } from "../notifications";
import { loadOrderProjectionReference, saveOrderProjectionReferences } from "../routes";
import { absorbManualShipment, applyTargetedAccountShipment, jingDongOrderPastPickup, sameCanonicalWaybill, selectShipmentDetailTimeline, unprojectedAccountOrder } from "../shipment-policy";
import { withAbsorbedParcelFields } from "../platform-parcel-merge";
import { bindingsForSource, commitTargetShipmentRefresh, loadState, peekStateRevision, readAppStateSnapshot, storedShipmentsForProcessing } from "../storage";
import { normalizeWaybill, normalizedProjectedWaybill, shipmentPresentationStatus, sortShipments, timedTracks } from "../status";
import { acquireRenewingDurableRefreshLease, durableRefreshLeaseMaxRemainingMs, durableRefreshLeaseRemainingMs, type DurableRefreshLease } from "../refresh-runtime-state";
import { requestWidgetReload } from "../widgets";
import { deadlineAfter, deadlineExpired } from "../deadline";
import { ACCOUNT_ORDER_PROJECTION_BUDGET_MS, accountOrderPageConfirmedEmpty, accountOrderProjectionAttemptRemainingMs, accountOrderProjectionRouteHash, rotatingBatchIndices, activeAccountOrderProjectionAttempt, accountChildDeadline, nextEmptyShellStrikes, projectionRiskControlled, retainedEmptyShellStrikes, shouldRetryAccountOrderProjectionUnprompted, accountOrderProjectionRiskRemainingMs, unionPageOutcome } from "../account-sync-policy";
import { accountParcelWithProjectionReference } from "../account-order-reference";
import { enhancementPhone, withCurrentAccountEnhancement } from "../enhanced-account";
import { beginDiagnosticFlow, changedSinceLastLogged, createDiagnosticFlowId, diagnosticErrorDetails, openStageCancellationEnd, writeDiagnostic } from "../logger";
import { SCRIPT_BINDING_SOURCE, requireScriptSource } from "../script-source";
import { projectAccountOrder, type AccountOrderProjectionDiagnostics } from "../account-order-projection";
import { CarrierRecognitionBudget, carrierRecognitionDue, carrierRecognitionExhausted, truncatedCarrierRecognitionLast } from "../carrier-recognition";
import { projectedCarrierPresentation } from "../carrier-presentation";
import { projectionSceneActive, projectionViewportHostAvailable } from "../projection-viewport";
import {
  ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS,
  assertRefreshSignal,
  CALLER_ENDS_CANCELLED_STAGE,
  createSyncRuntimeState,
  FORCED_PROJECTION_WAIT_SLICE_MS,
  FULL_REFRESH_COORDINATION_WAIT_MS,
  MANUAL_QUERY_BUDGET_MS,
  ownsProjectionAttempt,
  projectionOwnerFingerprint,
  projectionOwnerId,
  replaceById,
  rethrowStageCancellation,
  statePresentationFingerprint,
  type DeferredRouteMutations,
  type ProjectionAttemptField,
  type ProjectionCheckpoint,
  type RefreshCheckpoint,
  type ShipmentRefreshResult,
  type SyncRuntimeState,
} from "./shared";
import { deferIncomingRoute, fullRefreshCheckpoints } from "./route-publications";
import { withH5Controller } from "./h5-capture";

/**
 * 用户 2026-09-25 同意：刷新流程只在 App 在前台（场景 active）时开京粉页，否则这一单跳过、留给前台那一遍
 * 存盘行投影；不在屏幕上的页面只会超时（visibilityState=hidden）。
 */
export class UnionPageSkipped extends Error {
  constructor(readonly reason: "not_foreground" | "enhancement_active") {
    super("union page left to the on-screen pass");
    this.name = "UnionPageSkipped";
  }
}

/**
 * 用户 2026-10-03「所有开京粉页的路都检查」（代码 4）：the detail flow's own check, asked right before its union page
 * loads (the list path's gate also checks its lease).
 */
export function unionPageSceneGate(): void {
  if (!projectionSceneActive()) throw new UnionPageSkipped("not_foreground");
}

export function legacyOrderNumberGate(parcel: AccountParcelDto): void {
  if (enhancementPhone(parcel, loadState().bindings)) throw new UnionPageSkipped("enhancement_active");
}

/**
 * 用户 2026-10-03「这轮就统一」（优化 1，口径「拿到回答就算用掉」）：whether one union page load answered. A package —
 * partial or not — or a fully loaded page without logistics is an answer; risk control, and a load that failed, timed out
 * or never reached the union request (方案 A's uninformative page), are not.
 */
export function unionPageGaveAnswer(
  diagnostics: AccountOrderProjectionDiagnostics | null,
  captured: TimelinePackage | null | undefined,
): boolean {
  if (diagnostics && projectionRiskControlled(diagnostics.unionResponseStatuses, diagnostics.riskControlSeen === true)) {
    return false;
  }
  return timedTracks(captured?.tracks || []).length > 0 || unionPageOutcome(diagnostics) !== "uninformative";
}

/** Puts back one attempt record as it was before a reservation (undefined removes it). */
export function withProjectionAttemptRecord(
  shipment: Shipment,
  field: ProjectionAttemptField,
  retry: Shipment["identity"]["orderProjectionRetry"],
): Shipment {
  const { [field]: _reserved, ...identity } = shipment.identity;
  return { ...shipment, identity: retry ? { ...identity, [field]: retry } : identity };
}

export function projectionCooldownKey(parcel: AccountParcelDto): string {
  // 用户定 2026-09-04：冷却按**订单**记，与 Pipi 的 ExpressJdH5Cooldown（订单号 SHA-256）对齐。
  // 原来按 projectionUrl 哈希——京东 H5 链接带 token 与时间戳，feed 下一轮换个链接哈希就变了，
  // sameRoute 不成立，10 分钟与风控 60 分钟的记录当场作废：403 本该歇一小时，实际下一轮又开页。
  // 捕获策略变更仍然使冷却失效（策略串还在哈希里），这是它原本就该有的作用。
  // 持久化字段名仍是 `routeHash`，改名要迁移旧数据，不值得。
  // The same hash as before (sha256 of strategy \0 owner id); it moved to the policy module so the
  // list's visibility check can read an order's empty-page mark too (2026-09-25).
  return accountOrderProjectionRouteHash(projectionOwnerId(parcel));
}

const defaultProjectionRuntimeState = createSyncRuntimeState();

export async function projectAccountOrderWithCarrier(
  parcel: AccountParcelDto,
  projectionDeadlineAtMs: number | undefined,
  recognitionDeadlineAtMs: number | undefined,
  observe?: (diagnostics: AccountOrderProjectionDiagnostics) => void,
  signal?: AbortSignal,
  beforeLoad?: () => void,
  /** The round's or operation's recognition wait (用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒). */
  recognitionBudget?: CarrierRecognitionBudget,
  runtimeState: SyncRuntimeState = defaultProjectionRuntimeState,
  priority: "interactive" | "background" = "interactive",
): Promise<AccountParcelDto> {
  const projected = await withH5Controller(runtimeState, () => projectAccountOrder(
    parcel,
    projectionDeadlineAtMs,
    observe,
    signal,
    beforeLoad,
  ), projectionDeadlineAtMs, signal, priority);
  // Best effort (T23, 2026-09-26): a recognition failure must not drop the waybill the page named; an unmatched
  // carrier holds the projection instead.
  return normalizeAccountParcelCarrierBestEffort(projected, {
    deadlineAtMs: recognitionDeadlineAtMs,
    signal,
    budget: recognitionBudget,
  });
}

/** An order projection whose carrier neither the recognizer nor the page named. */
export function projectionWithoutCarrier(parcel: AccountParcelDto): boolean {
  if (!parcel.accountOrder ||
      normalizeWaybill(parcel.waybill) === normalizeWaybill(parcel.ownerId)) return false;
  return !projectedCarrierPresentation(parcel.waybill, parcel.courierCode, parcel.companyName).companyName;
}

/**
 * 承运商先对上再推送（T23，用户 2026-09-26，跨端对齐裁决 #28）：订单已经拿到真实运单号，承运商却没对上（识别链与页面都
 * 没给名字）。这样的投影不落地，订单行保持原样——直到识别进入终态（跨端对齐裁决 #32、33），那时照常落地。
 */
export function projectionAwaitingCarrier(parcel: AccountParcelDto): boolean {
  return projectionWithoutCarrier(parcel) && !carrierRecognitionExhausted(parcel.waybill);
}

/**
 * 跨端对齐裁决 #32、33（用户 2026-09-26）：识别已进入终态（连续 3 次失败，或付费级明确认不出，且快递100 没给名字）的投影不再
 * 停在订单阶段：照常落地，承运商位置填这张订单来源传回的承运商码原样（JDKD 这类，不是平台名）；没传回就空着
 * （「传回啥 cpcode 就填啥」）。
 */
export function releaseExhaustedProjection(projected: AccountParcelDto, orderRawCode: string | undefined): AccountParcelDto {
  if (!projectionWithoutCarrier(projected) || !carrierRecognitionExhausted(projected.waybill)) return projected;
  const rawCode = String(orderRawCode || "").trim();
  return {
    ...projected,
    courierCode: "",
    companyName: rawCode,
    rawCourierCode: rawCode,
    carrierNormalization: null,
  };
}

/** Whether a held or text waybill can be settled now: recognition may answer, or it is exhausted (跨端对齐裁决 #32、33). */
export function heldCarrierSettleable(waybill: string, now: number): boolean {
  return carrierRecognitionDue(waybill, now) || carrierRecognitionExhausted(waybill);
}

export type HeldProjection = NonNullable<Shipment["identity"]["pendingProjection"]>;

/** The parcel a held union-page projection stands for, its carrier still to be recognised. */
export function heldProjectionParcel(parcel: AccountParcelDto, held: HeldProjection): AccountParcelDto {
  return {
    ...parcel,
    waybill: held.waybill,
    courierCode: "",
    companyName: "",
    rawCourierCode: "",
    rawCompanyName: "",
    carrierNormalization: null,
    projectionTimeline: held.timeline || null,
    textIdentity: null,
  };
}

/** Keeps a union-page waybill whose carrier did not match, so later rounds only recognise it (T23). */
export function withHeldProjection(
  shipments: readonly Shipment[],
  ownerId: string,
  projected: AccountParcelDto,
  now: number,
): Shipment[] {
  const owner = shipments.find((shipment) => shipment.identity.id === ownerId);
  if (!owner || normalizedProjectedWaybill(owner.identity)) return [...shipments];
  return replaceById(shipments, {
    ...owner,
    identity: {
      ...owner.identity,
      pendingProjection: {
        waybill: normalizeWaybill(projected.waybill),
        timeline: projected.projectionTimeline || null,
        capturedAtMs: now,
      },
    },
  });
}

/** Puts back the owner's projection record from before a reservation that loaded no page (T23). */
export function withProjectionRetry(
  shipment: Shipment,
  retry: Shipment["identity"]["orderProjectionRetry"],
): Shipment {
  const { orderProjectionRetry: _reserved, ...identity } = shipment.identity;
  return { ...shipment, identity: retry ? { ...identity, orderProjectionRetry: retry } : identity };
}

export function projectionAttempt(
  shipment: Shipment,
  routeHash: string,
  attemptId: string,
  now: number,
  deadlineAtMs?: number,
  field: ProjectionAttemptField = "orderProjectionRetry",
): Shipment {
  const previous = shipment.identity[field];
  const previousRouteHash = String(previous?.routeHash || "").trim().toLowerCase();
  const previousRiskControlAtMs = Number(previous?.riskControlAtMs);
  return {
    ...shipment,
    identity: {
      ...shipment.identity,
      [field]: {
        routeHash,
        // Reserve the cooldown before loading so interrupted attempts also rest the order.
        failedAtMs: now,
        ...(previousRouteHash === routeHash &&
            Number.isFinite(previousRiskControlAtMs) &&
            previousRiskControlAtMs > 0
          ? { riskControlAtMs: previousRiskControlAtMs }
          : {}),
        // The reservation must not forget an earlier empty page of this order (方案 A, 2026-09-25).
        ...(field === "orderProjectionRetry" ? retainedEmptyShellStrikes(previous, routeHash) : {}),
        attemptId,
        attemptExpiresAtMs: Math.min(
          deadlineAtMs || now + ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS,
          now + ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS,
        ),
      },
    },
  };
}

/**
 * The completed orders 方案 A (user 2026-09-25) marks: an unprojected account order the list shows
 * as 已完成. Every other order keeps retrying under the ordinary rest.
 */
export function completedUnprojectedOrder(shipment: Shipment | undefined): boolean {
  return Boolean(
    shipment &&
    unprojectedAccountOrder(shipment) &&
    shipmentPresentationStatus(shipment).semantic === "COMPLETED",
  );
}

export function trackProjectionAttempt(runtimeState: SyncRuntimeState, shipmentId: string): () => void {
  if (runtimeState.activeProjectionAttempts.has(shipmentId)) throw new Error("JD capture is already running");
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const entry = { promise, settle };
  runtimeState.activeProjectionAttempts.set(shipmentId, entry);
  return () => {
    if (runtimeState.activeProjectionAttempts.get(shipmentId) !== entry) return;
    runtimeState.activeProjectionAttempts.delete(shipmentId);
    settle();
  };
}

export function hasActiveAccountOrderProjection(runtimeState: SyncRuntimeState, shipmentId: string): boolean {
  return runtimeState.activeProjectionAttempts.has(shipmentId);
}

const PROJECTION_WAIT_MAX_SLICE_MS = 1_000;

export async function waitForProjectionAttemptRelease(
  runtimeState: SyncRuntimeState,
  shipmentId: string,
  signal?: AbortSignal,
  deadlineAtMs?: number,
  explicitPull = false,
): Promise<ShipmentRefreshResult | null> {
  const waitDeadlineAtMs = explicitPull
    ? deadlineAtMs ?? deadlineAfter(MANUAL_QUERY_BUDGET_MS)
    : Math.min(deadlineAtMs ?? Infinity, Date.now() +
      ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS + FORCED_PROJECTION_WAIT_SLICE_MS);
  let sliceMs = FORCED_PROJECTION_WAIT_SLICE_MS;
  let seenRevision = peekStateRevision();
  let state = loadState();
  const initial = state.shipments.find(item => item.identity.id === shipmentId);
  let joined = false;
  while (true) {
    assertRefreshSignal(signal);
    const shipment = state.shipments.find(
      (item) => item.identity.id === shipmentId,
    );
    if (!shipment) throw new Error("该快递已从列表中移除");
    if (!explicitPull && !unprojectedAccountOrder(shipment)) return { shipment, state, refreshed: true };
    const inProcess = runtimeState.activeProjectionAttempts.get(shipmentId)?.promise || null;
    const remainingAttemptMs = Math.max(
      accountOrderProjectionAttemptRemainingMs(shipment.identity.orderProjectionRetry),
      accountOrderProjectionAttemptRemainingMs(shipment.identity.jingDongH5Retry),
    );
    // A persisted reservation fences another page load, but has no result for a pull to join.
    joined ||= Boolean(inProcess || (!explicitPull && remainingAttemptMs > 0));
    const remainingWaitMs = waitDeadlineAtMs - Date.now();
    if ((!inProcess && (explicitPull || remainingAttemptMs <= 0)) || remainingWaitMs <= 0) {
      if (!joined || !explicitPull) return null;
      const refreshed = Boolean(initial && (
        normalizedProjectedWaybill(initial.identity) !== normalizedProjectedWaybill(shipment.identity) ||
        JSON.stringify(selectShipmentDetailTimeline(initial)) !== JSON.stringify(selectShipmentDetailTimeline(shipment))
      ));
      const riskRemainingMs = Math.max(...[
        shipment.identity.orderProjectionRetry, shipment.identity.jingDongH5Retry,
      ].map(retry => accountOrderProjectionRiskRemainingMs(retry, retry?.routeHash || "")));
      return { shipment, state, refreshed, querySucceeded: refreshed,
        ...(riskRemainingMs > 0 ? { expressToast: "jdRiskControl", expressToastRemainingMs: riskRemainingMs } : {}) };
    }
    let inProcessSettled = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        resolve,
        Math.max(1, Math.min(sliceMs, remainingAttemptMs || sliceMs, remainingWaitMs)),
      );
      if (inProcess) {
        void inProcess.then(() => {
          inProcessSettled = true;
          clearTimeout(timer);
          resolve();
        });
      }
    });
    const revision = peekStateRevision();
    // 本运行时的尝试结束了、或别的运行时落过盘（revision 变了或读不到标记）才重读全量状态。
    if (inProcessSettled || revision !== seenRevision || revision === 0) {
      seenRevision = revision;
      state = loadState();
      sliceMs = FORCED_PROJECTION_WAIT_SLICE_MS;
    } else {
      sliceMs = Math.min(sliceMs * 2, PROJECTION_WAIT_MAX_SLICE_MS);
    }
  }
}

/**
 * §9 cooldown record for a failed projection: 10 minutes after any attempt, an hour when the
 * probe saw JD risk control (a 403 among the union request statuses).
 */
export function projectionFailureRetry(
  routeHash: string,
  diagnostics: AccountOrderProjectionDiagnostics | null | undefined,
  failedAtMs: number,
): NonNullable<Shipment["identity"]["orderProjectionRetry"]> {
  return {
    routeHash,
    failedAtMs,
    ...(projectionRiskControlled(diagnostics?.unionResponseStatuses, diagnostics?.riskControlSeen)
      ? { riskControlAtMs: failedAtMs }
      : {}),
  };
}

/**
 * The first-projection record after a load of `owner`'s union page that established no waybill:
 * the §9 rest above plus the empty-page strikes of 方案 A (user 2026-09-25), counted in the same
 * order-hashed record and only for a completed order. `waybillFound` is a page that named a
 * waybill the owner could not keep; like any capture it clears the strikes.
 */
export function orderProjectionFailureRetry(
  owner: Shipment | undefined,
  routeHash: string,
  diagnostics: AccountOrderProjectionDiagnostics | null | undefined,
  failedAtMs: number,
  waybillFound = false,
): NonNullable<Shipment["identity"]["orderProjectionRetry"]> {
  return {
    ...projectionFailureRetry(routeHash, diagnostics, failedAtMs),
    ...nextEmptyShellStrikes(
      owner?.identity.orderProjectionRetry,
      routeHash,
      unionPageOutcome(diagnostics, waybillFound),
      completedUnprojectedOrder(owner),
      failedAtMs,
    ),
  };
}

export function retainObservedProjectionRisk(
  ownerId: string,
  routeHash: string,
  attemptId: string,
  field: ProjectionAttemptField,
  diagnostics: AccountOrderProjectionDiagnostics | null,
  now = Date.now(),
): void {
  if (!projectionRiskControlled(diagnostics?.unionResponseStatuses, diagnostics?.riskControlSeen)) return;
  const state = loadState(now);
  const matchesAttempt = (owner: Shipment | undefined) =>
    owner?.identity[field]?.attemptId === attemptId && owner.identity[field]?.routeHash === routeHash;
  const owner = state.shipments.find(shipment => shipment.identity.id === ownerId);
  if (!owner || !matchesAttempt(owner)) return;
  // Cancellation invalidates business results, not risk already observed by this exact attempt.
  // An expired but unreplaced attempt may retain cooldown; a different attempt may not be changed.
  const retry = owner.identity[field]!;
  commitTargetShipmentRefresh(state, {
    ...owner,
    identity: { ...owner.identity, [field]: { ...retry,
      riskControlAtMs: Math.max(Number(retry.riskControlAtMs) || 0, now) } },
  }, now, {
    isCurrent: () => true,
    acceptsState: latest => matchesAttempt(latest.shipments.find(shipment => shipment.identity.id === ownerId)),
  });
}

export function restoreEnhancementBlockedProjection(
  ownerId: string,
  routeHash: string,
  attemptId: string,
  field: ProjectionAttemptField,
  retry: Shipment["identity"]["orderProjectionRetry"],
): AppState {
  const state = loadState();
  const matchesAttempt = (owner: Shipment | undefined) =>
    owner?.identity[field]?.attemptId === attemptId && owner.identity[field]?.routeHash === routeHash;
  const owner = state.shipments.find(shipment => shipment.identity.id === ownerId);
  if (!owner || !matchesAttempt(owner)) return state;
  // A binding change rejects old business results, but this exact unloaded page still owns its reservation cleanup.
  return commitTargetShipmentRefresh(state, withProjectionAttemptRecord(owner, field, retry), Date.now(), {
    isCurrent: () => true,
    acceptsState: latest => matchesAttempt(latest.shipments.find(shipment => shipment.identity.id === ownerId)),
  }).state;
}

export function recordProjectionFailure(
  shipments: readonly Shipment[],
  ownerId: string,
  routeHash: string,
  failedAtMs: number,
  diagnostics: AccountOrderProjectionDiagnostics | null | undefined = null,
  waybillFound = false,
): Shipment[] {
  const owner = shipments.find((shipment) => shipment.identity.id === ownerId);
  if (!owner || normalizedProjectedWaybill(owner.identity)) return [...shipments];
  return replaceById(shipments, {
    ...owner,
    identity: {
      ...owner.identity,
      orderProjectionRetry: orderProjectionFailureRetry(
        owner, routeHash, diagnostics, failedAtMs, waybillFound,
      ),
    },
  });
}

export function persistAccountOrderProjectionReferences(
  parcels: readonly AccountParcelDto[],
  state: AppState,
  source: BindingSource,
  flowId: string,
  now = Date.now(),
): void {
  const references = parcels.flatMap((parcel) => {
    if (!parcel.accountOrder || !parcel.projectionUrl) return [];
    const ownerId = projectionOwnerId(parcel);
    const owner = state.shipments.find(
      (shipment) => shipment.identity.id === ownerId,
    );
    return owner &&
        owner.identity.bindingSource === source &&
        owner.identity.accountOrder
      ? [{ ownerId, source, url: parcel.projectionUrl }]
      : [];
  });
  if (!references.length) return;
  try {
    saveOrderProjectionReferences(references, now);
  } catch (error) {
    writeDiagnostic("order.projection.reference_failed", {
      flowId,
      source,
      stage: "keychain",
      records: references.length,
      ...diagnosticErrorDetails(error),
    }, "warning");
  }
}

export function applyAccountOrderProjectionToOwner(
  shipmentsInput: readonly Shipment[],
  parcel: AccountParcelDto,
  boundPhones: readonly string[],
  now: number,
  routeMutations: DeferredRouteMutations,
): Shipment[] {
  const ownerId = projectionOwnerId(parcel);
  const owner = shipmentsInput.find(
    (shipment) => shipment.identity.id === ownerId,
  );
  const incoming = parcelToShipment(parcel, boundPhones, now);
  if (!owner || !incoming) return [...shipmentsInput];
  let projected = applyTargetedAccountShipment(owner, incoming, now);
  projected = deferIncomingRoute(
    projected,
    incoming,
    parcel.routeUrl,
    now,
    routeMutations,
  );
  if (!unprojectedAccountOrder(projected)) {
    const manualDuplicates = shipmentsInput.filter(
      (item) =>
        item.identity.id !== projected.identity.id &&
        item.identity.manuallyAdded &&
        sameCanonicalWaybill(item, projected),
    );
    for (const duplicate of manualDuplicates) {
      projected = absorbManualShipment(projected, duplicate, now);
      projected = withAbsorbedParcelFields(projected, duplicate, owner, { skipPddSource: true });
    }
  }
  return replaceById(shipmentsInput, projected);
}

/** The list row's structured status before parcelToShipment clamps an unprojected 已揽收 to 已下单. */
export type ProjectionListSemantic = (
  parcel: AccountParcelDto,
  owner: Shipment,
) => StatusSemantic | null;

export const listParcelStructuredSemantic: ProjectionListSemantic = (parcel) =>
  accountParcelStructuredSemantic(parcel);

/** A stored row no longer has that list parcel; its raw list state code answers instead. */
export const storedRowStructuredSemantic: ProjectionListSemantic = (_parcel, owner) =>
  storedAccountListStructuredSemantic(owner);

type AccountOrderProjectionDecision = Readonly<{
  due: boolean;
  skipped?: "before_pickup" | "carrier_pending" | ProjectionRestReason;
}>;

type ProjectionRestReason = "active_attempt" | "confirmed_empty" | "cooldown";

/** Why the union page stays closed for an order `shouldRetryAccountOrderProjectionUnprompted` refused. */
export function projectionRestReason(
  retry: Shipment["identity"]["orderProjectionRetry"],
  routeHash: string,
  now: number,
): ProjectionRestReason {
  return activeAccountOrderProjectionAttempt(retry, routeHash, now)
    ? "active_attempt"
    : accountOrderPageConfirmedEmpty(retry, routeHash) ? "confirmed_empty" : "cooldown";
}

/**
 * The one candidate filter for the union page: the list refresh and the Home stored-row pass
 * both ask it, so the pickup gate and the per-order cooldown (AGENTS §9) cannot drift apart.
 * Pure: `skipped` names the reasons the list path logs; the stored-row pre-check stays silent.
 */
export function accountOrderProjectionDecision(
  runtimeState: SyncRuntimeState,
  parcel: AccountParcelDto,
  shipments: readonly Shipment[],
  now: number,
  skipRefreshIds: ReadonlySet<string>,
  textBackfillOnly: boolean,
  listStructuredSemantic: ProjectionListSemantic,
  includeCompleted = false,
  bindings: readonly AccountBinding[] = [],
): AccountOrderProjectionDecision {
  if (!parcel.accountOrder || enhancementPhone(parcel, bindings)) return { due: false };
  const expectedId = projectionOwnerId(parcel);
  const existingOwner = shipments.find(
    (item) => item.identity.id === expectedId,
  );
  const heldWaybill = existingOwner?.identity.pendingProjection?.waybill || "";
  if (!parcel.projectionUrl && !parcel.textIdentity?.waybill && !heldWaybill) return { due: false };
  if (skipRefreshIds.has(expectedId)) return { due: false };
  if (normalizedProjectedWaybill(existingOwner?.identity)) return { due: false };
  if (runtimeState.activeProjectionAttempts.has(expectedId)) return { due: false, skipped: "active_attempt" };
  // A waybill named by the feed text needs no WebView attempt, so no cooldown applies. T23 (2026-09-26): it is shown
  // only with a matched carrier, so it is asked again only while the recognizer can still answer.
  if (parcel.textIdentity?.waybill) {
    return heldCarrierSettleable(parcel.textIdentity.waybill, now)
      ? { due: true }
      : { due: false, skipped: "carrier_pending" };
  }
  // T23: a union-page waybill held for its carrier is only recognised again; the page is not reopened for it.
  if (heldWaybill) {
    return heldCarrierSettleable(heldWaybill, now)
      ? { due: true }
      : { due: false, skipped: "carrier_pending" };
  }
  // 只做文案回填的那一轮到此为止：后面每条路都要开 WebView。
  if (textBackfillOnly) return { due: false };
  // 未投影订单行上的「已揽收」存盘时被压成了「已下单」，门要看列表这一行压之前的结构化状态。
  if (!existingOwner ||
      !jingDongOrderPastPickup(existingOwner, listStructuredSemantic(parcel, existingOwner), includeCompleted)) {
    return { due: false, skipped: "before_pickup" };
  }
  const routeHash = projectionCooldownKey(parcel);
  // Automatic path: a confirmed empty page stays closed (方案 A, 2026-09-25).
  if (
    shouldRetryAccountOrderProjectionUnprompted(
      existingOwner.identity.orderProjectionRetry,
      routeHash,
      now,
    )
  ) {
    return { due: true };
  }
  return {
    due: false,
    skipped: projectionRestReason(existingOwner.identity.orderProjectionRetry, routeHash, now),
  };
}

export async function projectAccountOrders(
  runtimeState: SyncRuntimeState,
  state: AppState,
  parcels: readonly AccountParcelDto[],
  source: BindingSource,
  now: number,
  flowId: string,
  checkpoint: RefreshCheckpoint,
  projectionCheckpoint: ProjectionCheckpoint,
  deadlineAtMs?: number,
  skipRefreshIds: ReadonlySet<string> = new Set(),
  enabled = true,
  signal?: AbortSignal,
  // 用户定 2026-09-04：小组件/快捷指令那一轮该跳过的只有**开 WebView 抓 JD H5**，feed 文案里
  // 已经给了运单号的照常回填。原来 hostPolicy.accountOrderProjection 为假时整段都不调用，
  // 把这条零成本的回填一起跳掉了。
  textBackfillOnly = false,
  listStructuredSemantic: ProjectionListSemantic = listParcelStructuredSemantic,
  includeCompleted = false,
  /**
   * A refresh flow's gate (user 2026-09-25), asked before an order is reserved and again right
   * before its page loads: it throws the flow's own cancellation when the flow is past its deadline
   * or ownership, and `UnionPageSkipped` while the app is not in the foreground.
   */
  unionPageGate?: () => void,
  /**
   * The sync round's recognition wait, or the Home pass's own (用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒).
   */
  recognitionBudget: CarrierRecognitionBudget = new CarrierRecognitionBudget(),
  /**
   * 用户 2026-09-28 (log authorization): the Home pass writes a cancelled attempt's one end itself, with the pass's
   * reason, so the page stage writes none of its own.
   */
  callerEndsCancelledAttempt = false,
): Promise<{
  state: AppState;
  attempted: number;
  succeeded: number;
  failed: number;
  stateChanged: boolean;
  projectedOwnerIds: readonly string[];
}> {
  assertRefreshSignal(signal);
  if (!enabled || deadlineExpired(deadlineAtMs)) {
    return {
      state,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      stateChanged: false,
      projectedOwnerIds: [],
    };
  }
  let workingState = state;
  let shipments = [...state.shipments];
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let stateChanged = false;
  const projectedOwnerIds: string[] = [];
  const boundPhones = bindingsForSource(state, source).map(
    (binding) => binding.phone,
  );
  const candidates = parcels.map(parcel => withCurrentAccountEnhancement(parcel, state.bindings)).filter((parcel) => {
    const decision = accountOrderProjectionDecision(
      runtimeState, parcel, shipments, now, skipRefreshIds, textBackfillOnly, listStructuredSemantic, includeCompleted, state.bindings,
    );
    if (decision.skipped) {
      writeDiagnostic("order.projection.skipped", {
        flowId,
        source,
        stage: "webview",
        ownerFingerprint: projectionOwnerFingerprint(projectionOwnerId(parcel)),
        result: decision.skipped,
      });
    }
    return decision.due;
  });
  // 用户 2026-09-27 第二轮清单：截断排后。An order whose feed-text or held waybill was cut off in an earlier round
  // comes after the rest; the rotation keeps its order otherwise. 整个候选排后（这一单本轮开京粉页取号也随之排后）属截断
  // 排后细则里的「整行（整个任务）排后」，用户 2026-09-27 提交前核对答「这样做」。
  const candidatePositions = truncatedCarrierRecognitionLast(
    rotatingBatchIndices(candidates.length, candidates.length, now),
    (position) => [
      candidates[position].textIdentity?.waybill,
      shipments.find((shipment) => shipment.identity.id === projectionOwnerId(candidates[position]))
        ?.identity.pendingProjection?.waybill,
    ],
  );
  for (let candidateOffset = 0;
    candidateOffset < candidatePositions.length;
    candidateOffset++
  ) {
    assertRefreshSignal(signal);
    if (deadlineExpired(deadlineAtMs)) {
      for (const deferredPosition of candidatePositions.slice(candidateOffset)) {
        writeDiagnostic("order.projection.skipped", {
          flowId,
          source,
          stage: "webview",
          ownerFingerprint: projectionOwnerFingerprint(
            projectionOwnerId(candidates[deferredPosition]),
          ),
          result: "deadline_exhausted",
        });
      }
      break;
    }
    const parcel = candidates[candidatePositions[candidateOffset]];
    const expectedId = projectionOwnerId(parcel);
    const ownerFingerprint = projectionOwnerFingerprint(expectedId);
    const routeHash = projectionCooldownKey(parcel);
    const freshState = loadState();
    const freshOwner = freshState.shipments.find(
      (shipment) => shipment.identity.id === expectedId,
    );
    if (freshOwner && normalizedProjectedWaybill(freshOwner.identity)) {
      shipments = replaceById(shipments, freshOwner);
      writeDiagnostic("order.projection.skipped", {
        flowId,
        source,
        stage: "webview",
        ownerFingerprint,
        result: "already_projected",
      });
      continue;
    }
    // T23: a union-page waybill held for its carrier needs no page, only recognition.
    const heldProjection = !parcel.textIdentity?.waybill && freshOwner?.identity.pendingProjection?.waybill
      ? freshOwner.identity.pendingProjection
      : null;
    if (
      runtimeState.activeProjectionAttempts.has(expectedId) ||
      (!parcel.textIdentity?.waybill && !heldProjection && !shouldRetryAccountOrderProjectionUnprompted(
        freshOwner?.identity.orderProjectionRetry,
        routeHash,
        Date.now(),
      ))
    ) {
      if (freshOwner) shipments = replaceById(shipments, freshOwner);
      writeDiagnostic("order.projection.skipped", {
        flowId,
        source,
        stage: "webview",
        ownerFingerprint,
        result: runtimeState.activeProjectionAttempts.has(expectedId) ? "active_attempt"
          : projectionRestReason(freshOwner?.identity.orderProjectionRetry, routeHash, Date.now()),
      });
      continue;
    }
    if (freshOwner) shipments = replaceById(shipments, freshOwner);
    if (!freshOwner) continue;
    if (enhancementPhone(parcel, freshState.bindings)) continue;
    // A feed-text waybill loads no page, so only a page load is gated.
    const pageGate = parcel.textIdentity?.waybill || heldProjection ? undefined : () => {
      legacyOrderNumberGate(parcel);
      unionPageGate?.();
    };
    if (pageGate) {
      try {
        pageGate();
      } catch (error) {
        if (!(error instanceof UnionPageSkipped)) throw error;
        // Not reserved: the on-screen pass takes this order as soon as the app is back.
        writeDiagnostic("order.projection.skipped", {
          flowId,
          source,
          stage: "webview",
          ownerFingerprint,
          result: error.reason,
        });
        continue;
      }
    }
    const attemptId = createDiagnosticFlowId("projection");
    const projectionDeadlineAtMs = accountChildDeadline(
      deadlineAtMs,
      ACCOUNT_ORDER_PROJECTION_BUDGET_MS,
    );
    const attemptDeadlineAtMs = accountChildDeadline(
      deadlineAtMs,
      ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS,
    );
    const reservation = projectionAttempt(
      freshOwner,
      routeHash,
      attemptId,
      Date.now(),
      attemptDeadlineAtMs,
    );
    const reservationCandidate = {
      ...workingState,
      shipments: sortShipments(replaceById(shipments, reservation)),
    };
    const reservationState = checkpoint(
      reservationCandidate,
      new Map(),
      "projection_reservation",
    );
    workingState = reservationState;
    shipments = [...reservationState.shipments];
    const reservedOwner = shipments.find(
      (shipment) => shipment.identity.id === expectedId,
    );
    if (!ownsProjectionAttempt(reservedOwner, routeHash, attemptId)) {
      writeDiagnostic("order.projection.skipped", {
        flowId,
        source,
        stage: "webview",
        ownerFingerprint,
        result: "reserved_elsewhere",
      });
      continue;
    }
    attempted++;
    const releaseProjectionAttempt = trackProjectionAttempt(runtimeState, expectedId);
    let projectionDiagnostics: AccountOrderProjectionDiagnostics | null = null;
    beginDiagnosticFlow("order.projection.started", {
      flowId,
      source,
      stage: "webview",
      ownerFingerprint,
      projectionReason: "scheduled",
    });
    let resolvedParcel: AccountParcelDto | null = null;
    let projectionFailed = false;
    let pageSkipped: UnionPageSkipped | null = null;
    // A page left to the on-screen pass ends without the page's diagnostics, as before.
    const pageCancelled = callerEndsCancelledAttempt ? CALLER_ENDS_CANCELLED_STAGE
      : openStageCancellationEnd(flowId, signal, () => writeDiagnostic("order.projection.failed", {
        flowId, source, stage: "webview", ownerFingerprint,
        ...(pageSkipped ? {} : projectionDiagnostics || {}), errorCategory: "cancelled",
      }, "warning"));
    try {
      resolvedParcel = heldProjection
        ? await normalizeAccountParcelCarrierBestEffort(
            heldProjectionParcel(parcel, heldProjection),
            { deadlineAtMs, signal, budget: recognitionBudget },
          )
        : await projectAccountOrderWithCarrier(
            parcel,
            projectionDeadlineAtMs,
            deadlineAtMs,
            (diagnostics) => {
              projectionDiagnostics = diagnostics;
            },
            signal,
            pageGate,
            recognitionBudget,
            runtimeState,
            "background",
          );
      assertRefreshSignal(signal);
      const extracted = normalizeWaybill(resolvedParcel.waybill) !==
        normalizeWaybill(parcel.ownerId);
      const safeDiagnostics = projectionDiagnostics || {
        loadSettled: false,
        loadCompleted: false,
        captureSeen: false,
        replayAttempted: false,
        replaySucceeded: false,
        domMatched: false,
        evaluationAttempts: 0,
        evaluationFailures: 0,
        loadDurationMs: 0,
      };
      writeDiagnostic(
        extracted ? "order.projection.extracted" : "order.projection.empty",
        {
          flowId,
          source,
          stage: "webview",
          ownerFingerprint,
          ...safeDiagnostics,
        },
        extracted ? "info" : "warning",
      );
      projectionFailed = !extracted;
    } catch (error) {
      if (error instanceof UnionPageSkipped) {
        pageSkipped = error;
      } else {
        if (signal?.aborted) retainObservedProjectionRisk(
          expectedId, routeHash, attemptId, "orderProjectionRetry", projectionDiagnostics);
        rethrowStageCancellation(signal, pageCancelled.end);
        projectionFailed = true;
        writeDiagnostic(
          "order.projection.failed",
          {
            flowId,
            source,
            stage: "webview",
            ownerFingerprint,
            ...diagnosticErrorDetails(error),
            ...(projectionDiagnostics || {}),
          },
          "warning",
        );
      }
    } finally {
      releaseProjectionAttempt();
    }

    // A page left to the on-screen pass ends as skipped below; cancelled before that, it ends here.
    rethrowStageCancellation(signal, () => {
      if (pageSkipped) pageCancelled.end();
      else pageCancelled.close();
    });
    pageCancelled.close();
    const ownershipState = loadState();
    const ownershipOwner = ownershipState.shipments.find(
      (shipment) => shipment.identity.id === expectedId,
    );
    if (pageSkipped) {
      // The app left the foreground before the page could load. Nothing was loaded, so the order
      // gets its record back as it was before this reservation and the on-screen pass takes it.
      attempted--;
      if (ownsProjectionAttempt(ownershipOwner, routeHash, attemptId)) {
        const released = projectionCheckpoint(
          {
            ...ownershipState,
            shipments: sortShipments(replaceById(ownershipState.shipments, {
              ...ownershipOwner!,
              identity: {
                ...ownershipOwner!.identity,
                orderProjectionRetry: freshOwner.identity.orderProjectionRetry,
              },
            })),
          },
          new Map(),
          "webview",
          { ownerId: expectedId, routeHash, attemptId },
        );
        workingState = released.state;
      } else {
        workingState = ownershipState;
      }
      shipments = [...workingState.shipments];
      writeDiagnostic("order.projection.skipped", {
        flowId,
        source,
        stage: "webview",
        ownerFingerprint,
        result: pageSkipped.reason,
      });
      continue;
    }
    if (!ownsProjectionAttempt(ownershipOwner, routeHash, attemptId)) {
      workingState = ownershipState;
      shipments = [...ownershipState.shipments];
      writeDiagnostic("order.projection.skipped", {
        flowId,
        source,
        stage: "webview_commit",
        ownerFingerprint,
        result: "ownership_lost",
      }, "warning");
      continue;
    }

    const attemptMutations: DeferredRouteMutations = new Map();
    let candidateShipments = [...ownershipState.shipments];
    const extracted = resolvedParcel != null &&
      normalizeWaybill(resolvedParcel.waybill) !==
        normalizeWaybill(parcel.ownerId);
    let projectionRetained = false;
    // 承运商先对上再推送（T23，用户 2026-09-26，跨端对齐裁决 #28）：运单号拿到了、承运商没对上，这张订单保持原样、不推。
    // 京粉页给的运单号与轨迹存下来（页面冷却照 §9 记，空壳计数按「页面给过运单号」清零），之后各轮只补识别；
    // 文案或已挂起的运单号没开页，订单的投影记录恢复成预约前的样子。
    if (extracted) resolvedParcel = releaseExhaustedProjection(resolvedParcel!, parcel.rawCourierCode);
    const carrierPending = extracted && projectionAwaitingCarrier(resolvedParcel!);
    const pageLoaded = !heldProjection && !parcel.textIdentity?.waybill;
    if (carrierPending) {
      if (pageLoaded) {
        candidateShipments = withHeldProjection(
          recordProjectionFailure(
            candidateShipments,
            expectedId,
            routeHash,
            Date.now(),
            projectionDiagnostics,
            true,
          ),
          expectedId,
          resolvedParcel!,
          Date.now(),
        );
      } else {
        const owner = candidateShipments.find((shipment) => shipment.identity.id === expectedId);
        if (owner) {
          candidateShipments = replaceById(
            candidateShipments,
            withProjectionRetry(owner, freshOwner.identity.orderProjectionRetry),
          );
        }
      }
      writeDiagnostic("order.projection.rejected", {
        flowId,
        source,
        stage: "state",
        ownerFingerprint,
        result: "carrier_pending",
      });
    } else if (extracted) {
      candidateShipments = applyAccountOrderProjectionToOwner(
        candidateShipments,
        resolvedParcel!,
        boundPhones,
        Date.now(),
        attemptMutations,
      );
      const retainedParcel = accountParcelWithExistingProjection(
        parcel,
        candidateShipments,
      );
      projectionRetained = normalizeWaybill(retainedParcel.waybill) !==
        normalizeWaybill(retainedParcel.ownerId);
      if (!projectionRetained) {
        candidateShipments = recordProjectionFailure(
          candidateShipments,
          expectedId,
          routeHash,
          Date.now(),
          projectionDiagnostics,
          true,
        );
        writeDiagnostic("order.projection.rejected", {
          flowId,
          source,
          stage: "state",
          ownerFingerprint,
          result: "not_retained",
        }, "warning");
      }
    } else if (projectionFailed) {
      candidateShipments = recordProjectionFailure(
        candidateShipments,
        expectedId,
        routeHash,
        Date.now(),
        projectionDiagnostics,
      );
    }
    const committed = projectionCheckpoint(
      { ...ownershipState, shipments: sortShipments(candidateShipments) },
      attemptMutations,
      "webview",
      { ownerId: expectedId, routeHash, attemptId },
    );
    workingState = committed.state;
    shipments = [...committed.state.shipments];
    if (!committed.applied) {
      writeDiagnostic("order.projection.skipped", {
        flowId,
        source,
        stage: "webview_commit",
        ownerFingerprint,
        result: "ownership_lost",
      }, "warning");
      continue;
    }
    stateChanged = true;
    if (carrierPending) {
      // The page did name a waybill (counted as before); a retry that loaded no page is no projection attempt.
      if (pageLoaded) succeeded++;
      else attempted--;
    } else if (projectionRetained) {
      succeeded++;
      projectedOwnerIds.push(expectedId);
    } else {
      failed++;
    }
  }
  assertRefreshSignal(signal);
  return {
    state: { ...workingState, shipments: sortShipments(shipments) },
    attempted,
    succeeded,
    failed,
    stateChanged,
    projectedOwnerIds,
  };
}

/** One `order.projection.committed` line per owner the page projected in this generation. */
export function recordAccountOrderProjectionCommits(
  projectedOwnerIds: readonly string[],
  parcels: readonly AccountParcelDto[],
  state: AppState,
  flowId: string,
  source: BindingSource,
): void {
  for (const ownerId of projectedOwnerIds) {
    const persisted = state.shipments.find(
      (shipment) => shipment.identity.id === ownerId,
    );
    const ownerParcel = parcels.find(
      (parcel) => projectionOwnerId(parcel) === ownerId,
    );
    const retainedParcel = ownerParcel
      ? accountParcelWithExistingProjection(
          ownerParcel,
          state.shipments,
        )
      : null;
    const projectionApplied = Boolean(
      normalizedProjectedWaybill(persisted?.identity) ||
        (
          retainedParcel &&
          normalizeWaybill(retainedParcel.waybill) !==
            normalizeWaybill(retainedParcel.ownerId)
        ),
    );
    writeDiagnostic("order.projection.committed", {
      flowId,
      source,
      stage: "state",
      ownerFingerprint: projectionOwnerFingerprint(ownerId),
      result: projectionApplied
        ? "applied"
        : "extracted_not_committed",
    }, projectionApplied ? "info" : "warning");
  }
}

// 用户 2026-09-24 采纳：App 在前台时自己把京东订单的运单号抓回来（京粉页 / 订单投影），不必等用户下拉；
// 与 Lite ExpressListActivity 首页 onStart / 每轮同步结束后跑 ExpressHomeOrderProjectionCapture 同口径：
// 用存盘的行，揽收门、按单冷却都一样。小组件、App Intents 照旧从不开网页。
const STORED_PROJECTION_TRIGGER = "home_projection";
/**
 * One order per pass: page ≤ 20 s, carrier recognition ≤ 45 s, then the notification drain. The longest
 * the pass holds full:<source> (its lease is valid for 30 seconds and renewed meanwhile), and the longest
 * it waits for another runtime's live holder.
 */
const STORED_PROJECTION_LEASE_MAX_MS = 125_000;
const STORED_PROJECTION_WAIT_SLICE_MS = 500;
const STORED_PROJECTION_WAIT_MARGIN_MS = 1_000;

export type StoredOrderProjectionResult = Readonly<{
  result:
    | "not_app_host"
    | "inactive"
    | "busy"
    | "lease_held"
    | "nothing_due"
    | "attempted"
    | "failed";
  /** The order handed to projectAccountOrders by this pass. */
  ownerId?: string;
  /** Another order that was not excluded was due as well. */
  moreDue: boolean;
  /** The state after this pass's commits (attempted only). */
  state?: AppState;
}>;

/** An in-process full refresh, or a user's pull still waiting for another runtime's lease. */
export function fullRefreshPendingInProcess(runtimeState: SyncRuntimeState, source: BindingSource): boolean {
  return Boolean(runtimeState.refreshCoordinator.full(source) || runtimeState.interactiveFullRequests.has(source));
}

/**
 * The list is still being written: a full refresh or stored-row pass of this runtime, or another runtime holding
 * `full:<source>`. The status alignment check (services/status-alignment.ts, 用户 2026-10-02) waits for the list
 * data to settle before it compares a row's times.
 */
export function listRefreshInProgress(runtimeState: SyncRuntimeState, source: BindingSource = SCRIPT_BINDING_SOURCE): boolean {
  return fullRefreshPendingInProcess(runtimeState, source) || durableRefreshLeaseRemainingMs(`full:${source}`) > 0;
}

type StoredProjectionCandidate = Readonly<{ ownerId: string; parcel: AccountParcelDto }>;

/**
 * Stored unprojected JD orders the union page may open for now, in Home order. No network, no
 * lease, no log: an empty answer is the pass's whole cost.
 */
function storedAccountOrderProjectionCandidates(
  runtimeState: SyncRuntimeState,
  state: AppState,
  source: BindingSource,
  now: number,
  excludeOwnerIds: ReadonlySet<string>,
  includeCompleted: boolean,
): StoredProjectionCandidate[] {
  const boundPhones = bindingsForSource(state, source).map((binding) => binding.phone);
  if (!boundPhones.length) return [];
  const noDetailRefreshes = new Set<string>();
  return storedShipmentsForProcessing(state, now).flatMap((shipment) => {
    const ownerId = shipment.identity.id;
    if (
      shipment.identity.bindingSource !== source ||
      !unprojectedAccountOrder(shipment) ||
      excludeOwnerIds.has(ownerId)
    ) return [];
    // The same rebuild as the detail page's cached_order_projection: saved reference or feed text.
    const reference = accountParcelWithProjectionReference(
      shipment,
      null,
      loadOrderProjectionReference(ownerId, source, now),
    );
    const parcel = reference && withCurrentAccountEnhancement(reference, state.bindings);
    if (
      !parcel ||
      projectionOwnerId(parcel) !== ownerId ||
      !parcelToShipment(parcel, boundPhones, now)
    ) return [];
    const decision = accountOrderProjectionDecision(
      runtimeState, parcel, state.shipments, now, noDetailRefreshes, false, storedRowStructuredSemantic, includeCompleted, state.bindings,
    );
    return decision.due ? [{ ownerId, parcel }] : [];
  });
}

async function runStoredOrderProjection(
  runtimeState: SyncRuntimeState,
  source: BindingSource,
  flowId: string,
  durableLease: DurableRefreshLease,
  before: AppState,
  candidate: StoredProjectionCandidate,
  moreDue: boolean,
  includeCompleted: boolean,
): Promise<StoredOrderProjectionResult> {
  const startedAt = Date.now();
  try {
    const summary = await runtimeState.refreshCoordinator.runFull(
      source,
      async (skipRefreshIds, lease) => {
        const notificationContext = {
          previousById: new Map(before.shipments.map((shipment) => [shipment.identity.id, shipment])),
          batchId: flowId,
        };
        const { checkpoint, projectionCheckpoint } = fullRefreshCheckpoints(
          runtimeState, source, flowId, lease, before, notificationContext,
        );
        const projection = await projectAccountOrders(
          runtimeState,
          before,
          [candidate.parcel],
          source,
          Date.now(),
          flowId,
          checkpoint,
          projectionCheckpoint,
          undefined,
          skipRefreshIds,
          true,
          lease.signal,
          false,
          storedRowStructuredSemantic,
          includeCompleted,
          // 用户 2026-10-03「所有开京粉页的路都检查」（代码 4）：the controller runs this pass only on screen, and the page
          // is asked again right before it loads; off screen the order is skipped (not_foreground) and left for the next pass.
          unionPageSceneGate,
          // 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒。One Home pass is one operation with its own budget.
          new CarrierRecognitionBudget(undefined, { flowId }),
          // The pass's catch below writes a cancelled attempt's end.
          true,
        );
        let state = projection.state;
        if (projection.stateChanged) {
          recordAccountOrderProjectionCommits(
            projection.projectedOwnerIds, [candidate.parcel], state, flowId, source,
          );
          // The same drain a full refresh ends with, so a projection's event is not left queued.
          if (lease.isCurrent()) {
            state = await replayPendingShipmentNotifications(lease.isCurrent, { flowId }) ?? state;
          }
        }
        return {
          attempted: projection.attempted,
          succeeded: projection.succeeded,
          failed: projection.failed,
          state,
          promotedPendingShipmentIds: [],
        };
      },
      (detail) => detail.refreshed,
      {
        blockerDeadlineAtMs: deadlineAfter(FULL_REFRESH_COORDINATION_WAIT_MS),
        ownership: durableLease,
      },
    );
    const changed = statePresentationFingerprint(summary.state) !== statePresentationFingerprint(before);
    if (changed) {
      requestWidgetReload();
    }
    // D106: the Home pass that opened the union page ends with one line for its flow.
    writeDiagnostic("order.projection.pass", {
      flowId, source, trigger: STORED_PROJECTION_TRIGGER, result: "attempted", changed,
      ownerFingerprint: projectionOwnerFingerprint(candidate.ownerId), durationMs: Date.now() - startedAt,
      attempted: summary.attempted, succeeded: summary.succeeded, failed: summary.failed,
    });
    return { result: "attempted", ownerId: candidate.ownerId, moreDue, state: summary.state };
  } catch (error) {
    writeDiagnostic("order.projection.failed", {
      flowId,
      source,
      stage: "webview",
      ownerFingerprint: projectionOwnerFingerprint(candidate.ownerId),
      durationMs: Date.now() - startedAt,
      ...diagnosticErrorDetails(error),
    }, "warning");
    return { result: "failed", ownerId: candidate.ownerId, moreDue: false };
  } finally {
    durableLease.release();
  }
}

/**
 * The Home stored-row projection pass: no account-list request. It opens the union page for at
 * most one stored order that the list path would open it for (same filter, reservation, cooldown
 * and commit), under the `full:<source>` lease. When another runtime holds that lease the pass
 * skips, or, with `waitForOtherRuntime`, waits for the release (bounded by the holder's maximum hold,
 * abandoned quietly once `isActive` turns false) because that runtime's commits are not final
 * until then. Only the app root may call it: it refuses to run where no projection viewport is
 * hosted, which is every widget and App Intent runtime.
 */
/**
 * D106: a pass that another refresh kept from running (busy, lease held) ends with one line, written once per change
 * of result so the on-screen watch does not repeat it. A pass with nothing due, or one asked off screen or outside the
 * app host, is a routine check and stays silent (the AGENTS.md section 10 routine-noise exception; the existing
 * "no log spam" regression locks it).
 */
export async function projectStoredAccountOrders(
  runtimeState: SyncRuntimeState,
  options: Parameters<typeof projectStoredAccountOrdersOnce>[1] = {},
): Promise<StoredOrderProjectionResult> {
  const startedAt = Date.now();
  const outcome = await projectStoredAccountOrdersOnce(runtimeState, options);
  if ((outcome.result === "busy" || outcome.result === "lease_held") &&
      changedSinceLastLogged("order.projection.pass", outcome.result)) {
    writeDiagnostic("order.projection.pass", {
      source: requireScriptSource(options.source || SCRIPT_BINDING_SOURCE), trigger: STORED_PROJECTION_TRIGGER,
      result: outcome.result, skipReason: outcome.result, durationMs: Date.now() - startedAt,
    });
  }
  return outcome;
}

async function projectStoredAccountOrdersOnce(
  runtimeState: SyncRuntimeState,
  options: Readonly<{
    source?: BindingSource;
    isActive?: () => boolean;
    waitForOtherRuntime?: boolean;
    excludeOwnerIds?: ReadonlySet<string>;
    /** True only while the app is on screen; completed orders are then also projected (2026-09-25). */
    onScreen?: () => boolean;
  }> = {},
): Promise<StoredOrderProjectionResult> {
  const source = requireScriptSource(options.source || SCRIPT_BINDING_SOURCE);
  const isActive = options.isActive || (() => true);
  const excludeOwnerIds = options.excludeOwnerIds || new Set<string>();
  const leaseKey = `full:${source}`;
  if (!projectionViewportHostAvailable()) return { result: "not_app_host", moreDue: false };
  const startedAt = Date.now();
  let waitUntilMs = 0;
  while (true) {
    if (!isActive()) return { result: "inactive", moreDue: false };
    if (fullRefreshPendingInProcess(runtimeState, source)) return { result: "busy", moreDue: false };
    const holderRemainingMs = durableRefreshLeaseRemainingMs(leaseKey);
    if (holderRemainingMs <= 0) {
      const now = Date.now();
      const before = readAppStateSnapshot(now).state;
      const includeCompleted = options.onScreen?.() === true;
      const due = storedAccountOrderProjectionCandidates(
        runtimeState, before, source, now, excludeOwnerIds, includeCompleted);
      if (!due.length) return { result: "nothing_due", moreDue: false };
      const flowId = createDiagnosticFlowId("home-projection");
      const durableLease = acquireRenewingDurableRefreshLease(
        leaseKey,
        STORED_PROJECTION_LEASE_MAX_MS,
        now,
        { flowId, trigger: STORED_PROJECTION_TRIGGER },
      );
      if (durableLease) {
        return runStoredOrderProjection(
          runtimeState, source, flowId, durableLease, before, due[0], due.length > 1, includeCompleted,
        );
      }
    }
    if (!options.waitForOtherRuntime) return { result: "lease_held", moreDue: false };
    // Bounded by how long the holder may still hold its lease, not by the lease's 30-second validity
    // (a live holder keeps renewing it); a holder that was just replaced cannot extend it forever.
    waitUntilMs ||= Math.min(
      Date.now() + Math.max(durableRefreshLeaseMaxRemainingMs(leaseKey), STORED_PROJECTION_WAIT_SLICE_MS) +
        STORED_PROJECTION_WAIT_MARGIN_MS,
      startedAt + STORED_PROJECTION_LEASE_MAX_MS + STORED_PROJECTION_WAIT_MARGIN_MS,
    );
    const remainingWaitMs = waitUntilMs - Date.now();
    if (remainingWaitMs <= 0) return { result: "lease_held", moreDue: false };
    await new Promise<void>((resolve) => setTimeout(
      resolve,
      Math.min(STORED_PROJECTION_WAIT_SLICE_MS, remainingWaitMs),
    ));
  }
}
