/** Shared runtime state, types, and pure helpers for express sync orchestration. */
import { normalizeTimelineSlot } from "../timeline-slot";
import type { AppState, BindingSource, RefreshSummary, Shipment, TimelinePackage } from "../../models";
import { refreshAccountParcel } from "../account-sync";
import type { AccountParcelDto } from "../account-parser";
import { queryManualForSource } from "../manual-query";
import type { ShipmentRouteMutation } from "../routes";
import { displayWaybill, isForeignManualPackage, isJingDongSourceShipment, isHomeAccountQuerySource, selectShipmentDetailTimeline, selectShipmentTimeline, shipmentSelectionEvidence, signedRefreshFrozen } from "../shipment-policy";
import { privateHash, refreshValueFingerprint as shipmentEffectiveFingerprint } from "../storage";
import { normalizeWaybill, normalizedProjectedWaybill, timelineCapability, timedTracks, timelineLatestEventAt, timelineLatestTrackAt } from "../status";
import { type RefreshProviderResult, runtimeManualRefreshAttempt } from "../refresh-runtime-state";
import { OperationTimeoutError } from "../deadline";
import { activeAccountOrderProjectionAttempt } from "../account-sync-policy";
import type { ExpressToastKey } from "../express-toast-copy";
import { diagnosticErrorDetails, writeDiagnostic, type StageCancellationEnd } from "../logger";
import { CarrierRecognitionBudget, carrierRecognitionDue, recognizeNonSyncCarrier, type CarrierRecognitionResult } from "../carrier-recognition";
import { repairProjectedShipmentCarrier } from "../account-carrier-normalization";
import { carrierUnmatched } from "../carrier-gate";
import { activeCarrierTableVersion } from "../carrier-query";
import { RefreshCoordinator } from "../refresh-coordination";
import type { CainiaoH5Diagnostics } from "../cainiao-h5";
import { firstClassifyAnchor } from "../row-ledger";
import { shipmentReuseAnchorAtMs } from "../waybill-reuse";

export const DETAIL_MANUAL_REFRESH_BUDGET_MS = 15_000;
export const MANUAL_QUERY_BUDGET_MS = 30_000;
export const MANUAL_REFRESH_TASK_BUDGET_MS = 15_000;
export const MANUAL_REFRESH_CONCURRENCY = 2;
export const FULL_REFRESH_COORDINATION_WAIT_MS = 2_000;
export const ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS = 22_000;
export const FORCED_PROJECTION_WAIT_SLICE_MS = 100;

export type SyncRuntimeState = {
  readonly refreshStateListeners: Set<(state: AppState) => void>;
  readonly fullRefreshOutcomeListeners: Set<(outcome: FullRefreshOutcome) => void>;
  readonly refreshCoordinator: RefreshCoordinator<
    BindingSource,
    string,
    ShipmentRefreshResult,
    RefreshSummary
  >;
  h5Queue: Promise<void>;
  readonly activeProjectionAttempts: Map<string, { promise: Promise<void>; settle: () => void }>;
  readonly accountDetailRequests: RefreshCoordinator<BindingSource, string, AccountParcelDto | null, never>;
  readonly accountSourceFullRequests: WeakSet<Promise<RefreshSummary>>;
  readonly forcedManualFullRequests: WeakSet<Promise<RefreshSummary>>;
  readonly interactiveFullRequests: Map<BindingSource, Promise<RefreshSummary>>;
  readonly statusAlignmentRefreshes: Map<string, Promise<ShipmentRefreshResult>>;
  readonly interactiveAccountPhases: Map<BindingSource, {
    completion: Promise<RefreshSummary>;
    accountPhase: Promise<RefreshSummary>;
  }>;
  readonly publishRefreshState: (state: AppState) => void;
  readonly publishFullRefreshOutcome: (outcome: FullRefreshOutcome) => void;
};

export function createSyncRuntimeState(): SyncRuntimeState {
  const refreshStateListeners = new Set<(state: AppState) => void>();
  const fullRefreshOutcomeListeners = new Set<(outcome: FullRefreshOutcome) => void>();
  return {
    refreshStateListeners,
    fullRefreshOutcomeListeners,
    refreshCoordinator: new RefreshCoordinator<
      BindingSource,
      string,
      ShipmentRefreshResult,
      RefreshSummary
    >(),
    h5Queue: Promise.resolve(),
    activeProjectionAttempts: new Map(),
    accountDetailRequests: new RefreshCoordinator<BindingSource, string, AccountParcelDto | null, never>(),
    accountSourceFullRequests: new WeakSet(),
    forcedManualFullRequests: new WeakSet(),
    interactiveFullRequests: new Map(),
    statusAlignmentRefreshes: new Map(),
    interactiveAccountPhases: new Map(),
    publishRefreshState(state: AppState): void {
      for (const listener of refreshStateListeners) {
        try { listener(state); }
        catch (error) { writeDiagnostic("refresh.presentation.failed", diagnosticErrorDetails(error), "warning"); }
      }
    },
    publishFullRefreshOutcome(outcome: FullRefreshOutcome): void {
      for (const listener of fullRefreshOutcomeListeners) {
        try { listener(outcome); } catch { /* a listener cannot change how the refresh ended */ }
      }
    },
  };
}

/**
 * How a full refresh requested in this runtime ended: it ran and released `full:<source>`, or it
 * never ran because another runtime (the widget) held that lease. Only the app root listens (the
 * foreground order projection); widget and App Intent runtimes never subscribe.
 */
export type FullRefreshOutcome = Readonly<{
  source: BindingSource;
  trigger: "background" | "list_pull" | "account_list_only" | "foreground";
  skipReason?: "active_cross_runtime_refresh";
}>;


export function statePresentationFingerprint(state: AppState): string {
  return JSON.stringify(
    state.shipments.map((shipment) => shipmentEffectiveFingerprint(shipment)),
  );
}

export function refreshProviderResultForError(error: unknown): RefreshProviderResult {
  const details = diagnosticErrorDetails(error);
  const failure = String(details.failureCode || details.errorCategory || "");
  if (failure === "invalid_query" || failure === "phone_tail" || failure === "phone_verification_required") {
    return "invalid_query";
  }
  if (failure === "upstream_rejected" || failure === "upstream_business_error" || failure === "upstream" ||
      failure === "rate_limited") {
    return "upstream_rejected";
  }
  if (failure === "timeout") return "timeout";
  if (failure === "network") return "network";
  return "failed";
}
export type ShipmentRefreshResult = {
  shipment: Shipment;
  state: AppState;
  refreshed: boolean;
  completedSourceQuery?: boolean;
  querySucceeded?: boolean;
  skipReason?: "signed_frozen";
  detailEntry?: DetailEntryObservation;
  /** Unified express toast (AGENTS §11) chosen by the refresh, rendered from the shared copy table. */
  expressToast?: ExpressToastKey;
  expressToastRemainingMs?: number;
};
export type DetailEntryObservation = Readonly<{
  fingerprint: string;
  gaveTimeline: boolean;
}>;
export type ShipmentRefreshOptions = {
  /** Only the visible detail page may request product-image metadata. */
  requestProductImage?: boolean;
  forceAccountOrderProjection?: boolean;
  forceManualRefresh?: boolean;
  includeKdniaoFallback?: boolean;
  trigger?:
    | "detail_open"
    | "detail_pull"
    | "product_image"
    | "manual_submit"
    | "identity_projection"
    | "missing_history"
    /** 用户 2026-10-02 状态对齐强刷（services/status-alignment.ts）：显式下拉的链，越过下拉也挡的那几道闸。 */
    | "status_alignment";
  signal?: AbortSignal;
  deadlineAtMs?: number;
  detailEntry?: DetailEntryObservation;
  /** Alignment reserves once at the first actual transport request, after source/ownership gates. */
  beforeQuery?: () => void;
};
export type TargetRefreshLease = Readonly<{
  deadlineAtMs?: number;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  expectedFingerprint?: string;
  expectedImageOwner?: string;
}>;
/**
 * 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒。A detail refresh (open or pull) is one user operation outside
 * the sync round: every carrier recognition it waits for — its nested identity projection included, which runs under
 * the same lease — shares one 30-second budget.
 */
const operationRecognitionBudgets = new WeakMap<TargetRefreshLease, CarrierRecognitionBudget>();
export function operationRecognitionBudget(lease: TargetRefreshLease): CarrierRecognitionBudget {
  let budget = operationRecognitionBudgets.get(lease);
  if (!budget) {
    budget = new CarrierRecognitionBudget();
    operationRecognitionBudgets.set(lease, budget);
  }
  return budget;
}

export type DeferredRouteOwner = "shipment" | "pending";
export type DeferredRouteMutation = ShipmentRouteMutation & {
  owner: DeferredRouteOwner;
  expectedVersion: string;
};
export type DeferredRouteMutationInput = {
  owner: DeferredRouteOwner;
  expectedVersion: string;
} & (
  | Omit<Extract<ShipmentRouteMutation, { kind: "save" }>, "key">
  | Omit<Extract<ShipmentRouteMutation, { kind: "move" }>, "key">
);
export type DeferredRouteMutations = Map<string, DeferredRouteMutation>;
export type RefreshCheckpointFn = (
  candidate: AppState,
  mutations: DeferredRouteMutations,
  stage: string,
  base?: AppState,
) => AppState;
export type RefreshCheckpoint = RefreshCheckpointFn & {
  transientManualLease?: boolean;
  batched?: (
    candidate: AppState,
    mutations: DeferredRouteMutations,
    stage: string,
    base?: AppState,
  ) => Promise<AppState>;
};
export function commitCheckpoint(
  checkpoint: RefreshCheckpoint,
  candidate: AppState,
  mutations: DeferredRouteMutations,
  stage: string,
  base?: AppState,
): Promise<AppState> | AppState {
  return checkpoint.batched
    ? checkpoint.batched(candidate, mutations, stage, base)
    : checkpoint(candidate, mutations, stage, base);
}
export function withRuntimeManualRefreshAttempt(shipment: Shipment, now: number): Shipment {
  const runtimeAttempt = runtimeManualRefreshAttempt(shipment.identity.id, now);
  if (!runtimeAttempt || runtimeAttempt.activeUntilMs <= now) return shipment;
  return {
    ...shipment,
    manualRefreshAttemptAtMs: Math.max(
      Number(shipment.manualRefreshAttemptAtMs) || 0,
      runtimeAttempt.lastAttemptAtMs,
    ),
    manualRefreshLease: {
      attemptId: runtimeAttempt.attemptId,
      startedAtMs: runtimeAttempt.lastAttemptAtMs,
      expiresAtMs: runtimeAttempt.activeUntilMs,
    },
  };
}
export type ProjectionAttemptGuard = Readonly<{
  ownerId: string;
  routeHash: string;
  attemptId: string;
}>;
export type ProjectionCheckpoint = (
  candidate: AppState,
  mutations: DeferredRouteMutations,
  stage: string,
  guard: ProjectionAttemptGuard,
) => Readonly<{ state: AppState; applied: boolean }>;

export function replaceById(
  shipments: readonly Shipment[],
  incoming: Shipment,
): Shipment[] {
  return [
    ...shipments.filter((item) => item.identity.id !== incoming.identity.id),
    incoming,
  ];
}

export type ManualRefreshTask = { id: string; lastAttemptAtMs: number; accountDetail?: boolean;
  cainiaoFollowup?: boolean; cainiaoListUpdated?: boolean; backgroundAlignment?: boolean };

export type EnrichmentRuntime = Readonly<{
  refreshAccountParcel?: typeof refreshAccountParcel;
  queryManualForSource: typeof queryManualForSource;
}>;

export function isCainiaoAutomaticShipment(shipment: Shipment): boolean {
  return Boolean(
    !shipment.identity.manuallyAdded &&
      String(shipment.identity.sourceProvider || "").trim().toLowerCase() ===
        "cainiao",
  );
}

export function cainiaoListHasUpdate(previous: Shipment | undefined, current: Shipment): boolean {
  if (!isCainiaoAutomaticShipment(current) || current.identity.bindingSource !== "interface5") return false;
  const incoming = current.sourceTimeline;
  if (!incoming) return false;
  const stored = previous?.sourceTimeline;
  if (!stored) return true;
  const incomingAt = timelineLatestEventAt(incoming);
  const storedAt = timelineLatestEventAt(stored);
  // Query can hydrate generic list text at the same event time; that is not another update.
  return incomingAt > storedAt || incomingAt >= storedAt &&
    incoming.semantic !== "UNKNOWN" && incoming.semantic !== stored.semantic;
}

export function canQueryHomeAccount(shipment: Shipment, cainiaoFollowup: boolean, now = Date.now()): boolean {
  return homeAccountQueryEligible(shipment, cainiaoFollowup) && !signedRefreshFrozen(shipment, now);
}

/**
 * The Home follow-up's own conditions. A newly reported completion still gets its final detail unless the row has
 * reached the signed freeze: status, headline and local detail all at the signing (用户 2026-10-02「头条 状态 详情页 都
 * 推进到了签收状态…就冻结快递 后续不再进行任何刷新」). An explicit sign-off stops it only once hard-frozen (用户 2026-10-02
 * 「我已取件这种硬冻结 也要等三态都是签收才冻结」，iOS 右滑签收统一适用同一硬冻结条件); both are canQueryHomeAccount's freeze check.
 */
export function homeAccountQueryEligible(shipment: Shipment, cainiaoFollowup: boolean): boolean {
  if (!isCainiaoAutomaticShipment(shipment)) return false;
  return cainiaoFollowup && isHomeAccountQuerySource(shipment) && Boolean(shipment.accountRecord) &&
    shipment.timeline.provider !== "demo" &&
    selectShipmentTimeline(shipment).semantic !== "CANCELLED";
}

export function safeWaybillTail(shipment: Shipment): string {
  const waybill = normalizeWaybill(displayWaybill(shipment));
  return waybill.length > 4 ? waybill.slice(-4) : "";
}

/** 日志里的包名统一用槽名：feed 是 v5_list，其余按槽名（用户定 2026-09-05）。 */
export function diagnosticTimelineProvider(provider: string): string {
  const raw = String(provider || "").trim().toLowerCase();
  if (raw === "interface5" || raw === "account") return "v5_list";
  return normalizeTimelineSlot(raw) || timelineCapability(raw);
}

export function shipmentDiagnosticDetails(
  shipment: Shipment, requestProvider?: string, response?: TimelinePackage,
) {
  const presented = selectShipmentTimeline(shipment);
  const displayed = requestProvider ? selectShipmentDetailTimeline(shipment) : presented;
  const displayedTrackCount = timedTracks(displayed.tracks).length;
  const observed = response || displayed;
  const status = response || presented;
  return {
    ...(!response ? shipmentSelectionEvidence(shipment) : {}),
    ...(shipment.identity.enhancedMode ? { enhancedMode: true,
      productImagePresent: Boolean(shipment.identity.productImageURL) } : {}),
    waybillTail: safeWaybillTail(shipment),
    automatic: !shipment.identity.manuallyAdded,
    sourceProvider: String(shipment.identity.sourceProvider || "")
      .trim()
      .toLowerCase(),
    carrierCode: String(shipment.identity.courierCode || "")
      .trim()
      .toUpperCase(),
    routeKind: String(shipment.route?.kind || "none"),
    routePointerPresent: Boolean(shipment.route),
    ...(requestProvider ? {
      requestProvider,
      displayTimelineProvider: diagnosticTimelineProvider(displayed.provider),
    } : { timelineProvider: diagnosticTimelineProvider(shipment.timeline.provider) }),
    ...(response ? { timelineProvider: diagnosticTimelineProvider(requestProvider || response.provider) } : {}),
    effectiveTrackCount: timedTracks(observed.tracks).length,
    selectionScope: response ? "query_response" as const : "display" as const,
    displayedTrackCount,
    latestEventAtMs: timelineLatestEventAt(observed),
    latestTrackAtMs: timelineLatestTrackAt(observed),
    ...(!response ? { feedEventAtMs: shipment.sourceTimeline ? timelineLatestEventAt(shipment.sourceTimeline) : 0 } : {}),
    statusEventAtMs: status.statusEventAtMs || 0,
    statusSemantic: status.semantic,
    structuredStatus: status.structuredStatus === true,
  };
}

export function cainiaoH5DiagnosticDetails(
  diagnostics: CainiaoH5Diagnostics | null,
) {
  return diagnostics
    ? {
        routePresent: diagnostics.routePresent,
        routeTrusted: diagnostics.routeTrusted,
        waybillPresent: diagnostics.waybillPresent,
        loadSettled: diagnostics.loadSettled,
        loadCompleted: diagnostics.loadCompleted,
        evaluationAttempts: diagnostics.evaluationAttempts,
        evaluationFailures: diagnostics.evaluationFailures,
        extractionSource: diagnostics.extractionSource,
        rawTrackCount: diagnostics.rawTrackCount,
        validTrackCount: diagnostics.validTrackCount,
        effectiveTrackCount: diagnostics.trackCount,
        exitReason: diagnostics.exitReason,
      }
    : {};
}

export function isJingDongAutomaticShipment(shipment: Shipment): boolean {
  return Boolean(
    !shipment.identity.manuallyAdded &&
      shipment.identity.accountOrder &&
      isJingDongSourceShipment(shipment),
  );
}

export function stageBudgetMs(
  deadlineAtMs: number | undefined,
  now = Date.now(),
  fallbackBudgetMs = 0,
): number {
  return deadlineAtMs == null
    ? Math.max(0, fallbackBudgetMs)
    : Math.max(0, deadlineAtMs - now);
}

export function assertRefreshSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationTimeoutError();
}

export function rethrowRefreshCancellation(
  _error: unknown,
  signal?: AbortSignal,
): void {
  // A child-stage deadline is a recoverable provider failure: account detail may
  // time out while JD/Cainiao fallback still has budget. Only the parent lease
  // signal cancels the whole refresh generation.
  assertRefreshSignal(signal);
}

/**
 * 用户 2026-09-28：a stage whose start was logged still ends when the parent refresh is cancelled —
 * its failure event with errorCategory "cancelled" — before the cancellation propagates exactly as
 * rethrowRefreshCancellation propagates it. Without a cancelled parent nothing happens here.
 */
export function rethrowStageCancellation(signal: AbortSignal | undefined, endStage: () => void): void {
  if (!signal?.aborted) return;
  endStage();
  assertRefreshSignal(signal);
}

/** A stage whose caller writes its cancelled end itself (see projectAccountOrders). */
export const CALLER_ENDS_CANCELLED_STAGE: StageCancellationEnd = { end: () => {}, close: () => {} };

export function projectionOwnerId(parcel: AccountParcelDto): string {
  return `${parcel.source}:account:${normalizeWaybill(parcel.ownerId)}`;
}

/**
 * 优化 5 续（用户 2026-10-03「第一次识别时记下锚点，之后不变」）：the anchor a stored row sends with the paid carrier stage —
 * the one recorded the first time it sent one, else its reuse anchor as it is now (then recorded).
 */
export function rowClassifyAnchor(shipment: Shipment): () => number | undefined {
  return () => firstClassifyAnchor(shipment.identity.id, () => shipmentReuseAnchorAtMs(shipment));
}

export function projectionOwnerFingerprint(ownerId: string): string {
  return privateHash(ownerId).slice(0, 12);
}

/**
 * T23: a recognised carrier on a row that shows a real waybill without one. A projected order is repaired like the
 * detail repair always did; any other row takes the carrier on its identity. A JD result on a non-JD waybill of a
 * JD business row stays refused (R-20). Returns the row unchanged when nothing matched.
 */
export function withRecognizedCarrier(
  shipment: Shipment,
  recognition: CarrierRecognitionResult,
): Shipment {
  if (!carrierUnmatched(shipment)) return shipment;
  if (shipment.identity.accountOrder && normalizedProjectedWaybill(shipment.identity)) {
    return repairProjectedShipmentCarrier(shipment, recognition.normalization, recognition.displayName);
  }
  const normalization = recognition.normalization?.isBuiltIn ? recognition.normalization : null;
  const displayName = String(recognition.displayName || "").trim();
  if (!normalization && !displayName) return shipment;
  const carrier = normalization
    ? {
        courierCode: normalization.standardCode,
        companyName: normalization.displayName,
        ...(shipment.identity.manuallyAdded ? {} : {
          carrierIsBuiltIn: true,
          carrierKuaidi100Code: normalization.kuaidi100Code,
          carrierTableVersion: normalization.tableVersion,
        }),
      }
    : {
        courierCode: "",
        companyName: displayName,
        ...(shipment.identity.manuallyAdded ? {} : {
          carrierIsBuiltIn: false,
          carrierKuaidi100Code: "",
          carrierTableVersion: activeCarrierTableVersion(),
        }),
      };
  const recognized = { ...shipment, identity: { ...shipment.identity, ...carrier } };
  return carrierUnmatched(recognized) ? shipment : recognized;
}

/**
 * T23: asks the recognizer again for a row still without a matched carrier — also one released with its raw code after
 * an exhausted recognition (跨端对齐裁决 #32), once the recognizer may answer again. Best effort.
 */
export async function recognizeAwaitingCarrier(
  shipment: Shipment,
  deadlineAtMs: number | undefined,
  signal?: AbortSignal,
  budget?: CarrierRecognitionBudget,
): Promise<Shipment> {
  if (!carrierUnmatched(shipment)) return shipment;
  const waybill = displayWaybill(shipment);
  if (!carrierRecognitionDue(waybill)) return shipment;
  try {
    return withRecognizedCarrier(shipment,
      await recognizeNonSyncCarrier(waybill, { deadlineAtMs, signal, budget,
        // 优化 5 (user 2026-10-03): the row's own waybill-reuse anchor goes with the paid stage, the one it first sent.
        parcelAnchorAtMs: rowClassifyAnchor(shipment) }));
  } catch (error) {
    rethrowRefreshCancellation(error, signal);
    return shipment;
  }
}

/**
 * Which identity field holds the attempt reservation: the first projection uses
 * `orderProjectionRetry` (cleared once the order is projected), a D-13 timeline reopen uses
 * `jingDongH5Retry`, which survives the account merge of an already projected shipment.
 */
export type ProjectionAttemptField = "orderProjectionRetry" | "jingDongH5Retry";

export function ownsProjectionAttempt(
  shipment: Shipment | undefined,
  routeHash: string,
  attemptId: string,
  now = Date.now(),
  field: ProjectionAttemptField = "orderProjectionRetry",
): boolean {
  const retry = shipment?.identity[field];
  return retry?.attemptId === attemptId &&
    activeAccountOrderProjectionAttempt(retry, routeHash, now);
}

/**
 * R-29 (AGENTS §9, 2026-09-03): a Picker / K100 H5 / KDNiao result whose nodes predate the
 * account order's first feed node by more than a day belongs to another parcel. It is logged as
 * `foreign_package`, not applied, and therefore never cached.
 */
export function rejectForeignManualResult(
  base: Shipment,
  result: Shipment | null,
  details: Readonly<{
    flowId: string;
    source: BindingSource;
    stage: string;
    timelineProvider: string;
  }>,
): Shipment | null {
  if (!result) return null;
  const packages = result.manualTimelines?.length
    ? result.manualTimelines
    : [result.timeline];
  if (!packages.some((timeline) => isForeignManualPackage(base, timeline))) {
    return result;
  }
  writeDiagnostic("manual.source.skipped", {
    ...details,
    ...shipmentDiagnosticDetails(base, details.timelineProvider),
    result: "foreign_package",
    // Same key and same value as Pipi's ExpressDiagnosticLog.foreignPackageDropped, so the two
    // clients' express logs read identically (AGENTS §11).
    gateReason: "foreign_package",
    effectiveTrackCount: 0,
  }, "warning");
  return null;
}
