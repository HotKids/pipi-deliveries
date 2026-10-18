import { withSharedFileTransaction } from "./shared-file-transaction";
import { normalizeTimelineSlot, TIMELINE_SLOT } from "./timeline-slot";
import type {
  AppState,
  BindingSource,
  PendingManualQuery,
  RefreshSummary,
  Shipment,
  StatusSemantic,
  TimelinePackage,
} from "../models";
import {
  accountOrderTextWaybill,
  accountParcelStructuredSemantic,
  accountParcelWithExistingProjection,
  fetchAccountParcels,
  normalizeAccountParcelCarrierBestEffort,
  parcelToShipment,
  prepareAccountParcelCarrier,
  refreshAccountParcel,
  withRecognizedAccountOrderTextWaybill,
  storedAccountListStructuredSemantic,
  withListStructuredSemantic,
  verifyAccountBinding,
} from "./account-sync";
import type { AccountParcelDto } from "./account-parser";
import {
  manualProviderSchedule,
  queryManualForSource,
  type ManualCarrierDetection,
  type ManualQueryOutcome,
  type ManualSourceDependencies,
} from "./manual-query";
import { replayPendingShipmentNotifications } from "./notifications";
import { committedPendingPromotionShipmentId } from "./pending-promotion";
import {
  commitShipmentRouteMutations,
  loadOrderProjectionReference,
  loadShipmentRoute,
  moveShipmentRoute,
  removeOrderProjectionReferences,
  removeShipmentRoutes,
  saveOrderProjectionReferences,
  saveAccountAppRoutes,
  saveShipmentRoute,
  type ShipmentRouteMutation,
  type ShipmentRoutePublication,
} from "./routes";
import {
  absorbHistoricalShipment,
  absorbManualShipment,
  activateCainiaoManualFallback,
  accountShipmentIsSupersededRecord,
  accountShipmentReusesWaybill,
  applyAccountShipment,
  applyManualShipment,
  applySameSourceTimeline,
  applyTargetedAccountShipment,
  asAccountDetailObservation,
  automaticBindingIdentityOf,
  automaticSourceOf,
  beginManualRefreshAttempt,
  cainiaoAutomaticNeedsH5Supplement,
  clearCainiaoManualFallback,
  displayWaybill,
  FORCED_COMPLETION_REFRESH_WINDOW_MS,
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  forcedCompletedAt,
  hasCachedKdniaoTimeline,
  hasCachedTimelineBeforeKdniao,
  hasEligibleShunFengManualTimeline,
  hasPickerTimelineStart,
  hasSettledTimelineHistory,
  hasUsableShipmentDynamics,
  hasTimelineStartBeforeKdniao,
  isForeignManualPackage,
  isHistoricalAccountDuplicate,
  isJingDongSourceShipment,
  isShunFengSourceShipment,
  manualShipmentReusedBy,
  reusedWaybillShipment,
  shipmentDetailCandidateEvidence,
  jingDongFeedReachedPickup,
  jingDongOrderPastPickup,
  jingDongSignedGapCompletionAt,
  jingDongSignedHistoryGap,
  manualTimelineOwnsShipment,
  needsAutomaticManualFallback,
  needsDetailFallback,
  detailEntryQueryReason,
  isHomeAccountQuerySource,
  ownsManualRefreshLease,
  recordAutomaticOwnerRefresh,
  releaseManualRefreshLease,
  sameCanonicalWaybill,
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
  shipmentSelectionEvidence,
  shipmentHeadlineMatchesStatus,
  shipmentDetailComplete,
  shipmentDetailIncompleteReason,
  shouldRefreshShipmentRow,
  shouldScheduleManualRefresh,
  refreshGateView,
  signedRefreshFrozen,
  statusAlignmentOutOfStep,
  statusAlignmentTimes,
  type StatusAlignmentTimes,
  supportsOrdinaryAutomaticDetailSupplement,
  unprojectedAccountOrder,
  usesManualSourceQuery,
  withDetailSelection,
  withoutForcedCompletion,
} from "./shipment-policy";
import {
  addBinding,
  bindingsForSource,
  commitRefreshState,
  commitRoutePointers,
  commitTargetShipmentRefresh,
  loadState,
  privateHash,
  pruneRoutesForState as safelyPruneRoutes,
  refreshValueFingerprint as shipmentEffectiveFingerprint,
  peekStateRevision,
  removeBinding,
  saveState,
  visibleShipments,
  type RefreshNotificationContext,
} from "./storage";
import {
  normalizeWaybill,
  normalizedProjectedWaybill,
  containsTimelinePickupTrack,
  shipmentPresentationStatus,
  sortShipments,
  timelineCapability,
  timedTracks,
  timelineLatestEventAt,
  timelineLatestTrackAt,
  parseProviderTime,
} from "./status";
import {
  acquireRenewingDurableRefreshLease,
  durableRefreshLeaseDiagnostics,
  durableRefreshLeaseMaxRemainingMs,
  durableRefreshLeaseRemainingMs,
  type DurableRefreshLease,
  recordNetworkRefreshSuccess,
  recordRefreshProviderResult,
  refreshProviderDue,
  type RefreshProviderResult,
} from "./refresh-runtime-state";
import { requestWidgetReload } from "./widgets";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey, type AlignmentAttempt } from "./row-ledger";
import {
  alignmentAttemptDue, alignmentOwnerCurrent, alignmentTimesKey, reserveAlignmentAttempt,
  finishAlignmentAttempt, newerAlignmentEvidence, publishAlignmentPresentation,
} from "./status-alignment-state";
import { refreshCarrierAuthorityIfNeeded } from "./carrier-authority";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import {
  assertWithinDeadline,
  deadlineAfter,
  deadlineExpired,
  OperationTimeoutError,
  waitForRefresh,
} from "./deadline";
import {
  ACCOUNT_DETAIL_BUDGET_MS,
  ACCOUNT_FOLLOWUP_RESERVE_MS,
  ACCOUNT_H5_BUDGET_MS,
  ACCOUNT_LIST_BUDGET_MS,
  ACCOUNT_ORDER_PROJECTION_BUDGET_MS,
  accountOrderReadyForProjection,
  accountOrderPageConfirmedEmpty,
  accountOrderProjectionAttemptRemainingMs,
  accountOrderProjectionRouteHash,
  rotatingBatchIndices,
  activeAccountOrderProjectionAttempt,
  accountChildDeadline,
  nextEmptyShellStrikes,
  oldestBatchIndices,
  projectionRiskControlled,
  retainedEmptyShellStrikes,
  shouldRetryAccountOrderProjection,
  shouldRetryAccountOrderProjectionUnprompted,
  unionPageOutcome,
} from "./account-sync-policy";
import type { ExpressToastKey } from "./express-toast-copy";
import { accountParcelWithProjectionReference } from "./account-order-reference";
import { prepareManualPreview } from "./manual-preview";
import {
  createDiagnosticFlowId,
  diagnosticErrorDetails,
  diagnosticState,
  diagnosticsEnabled,
  openStageCancellationEnd,
  writeDiagnostic,
  writeDiagnosticBatch,
  type DiagnosticDetails,
  type StageCancellationEnd,
} from "./logger";
import {
  SCRIPT_BINDING_SOURCE,
  requireScriptSource,
} from "./script-source";
import {
  SCRIPT_CLIENT_BUILD,
  SCRIPT_VERSION,
} from "./build-track";
import {
  projectAccountOrder,
  type AccountOrderProjectionDiagnostics,
} from "./account-order-projection";
import {
  CarrierRecognitionBudget,
  carrierRecognitionDue,
  carrierRecognitionExhausted,
  forgetCarrierRecognition,
  recognizeNonSyncCarrier,
  truncatedCarrierRecognitionLast,
  type CarrierRecognitionResult,
} from "./carrier-recognition";
import {
  needsProjectedCarrierRepair,
  repairProjectedShipmentCarrier,
} from "./account-carrier-normalization";
import { carrierUnmatched } from "./carrier-gate";
import { projectedCarrierPresentation } from "./carrier-presentation";
import { activeCarrierTableVersion } from "./carrier-query";
import { GatewayError } from "./gateway";
import {
  RefreshCoordinator,
  type FullRefreshLease,
} from "./refresh-coordination";
import {
  scrapeCainiaoH5Timeline,
  trustedCainiaoH5Route,
  type CainiaoH5Diagnostics,
} from "./cainiao-h5";
import {
  scrapeWebTimeline,
  type WebTimelineDiagnostics,
} from "./web-timeline";
import { needsManualPhoneTail, primaryH5Provider } from "./jt-h5";
import { runManualDetailSourceContest } from "./manual-detail-refresh";
import {
  FULL_REFRESH_FINALIZATION_RESERVE_MS,
  fullRefreshHostPolicy,
} from "./refresh-mode";
import {
  projectionSceneActive,
  projectionViewportHostAvailable,
} from "./projection-viewport";
import { recordSignedRelease } from "./row-ledger";
import { firstClassifyAnchor } from "./row-ledger";
import { shipmentReuseAnchorAtMs } from "./waybill-reuse";

const DETAIL_MANUAL_REFRESH_BUDGET_MS = 15_000;
const MANUAL_QUERY_BUDGET_MS = 30_000;
const MANUAL_REFRESH_TASK_BUDGET_MS = 15_000;
const MANUAL_REFRESH_CONCURRENCY = 2;
const FULL_REFRESH_COORDINATION_WAIT_MS = 2_000;
const ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS = 22_000;
const FORCED_PROJECTION_WAIT_SLICE_MS = 100;

const refreshStateListeners = new Set<(state: AppState) => void>();
export function subscribeRefreshState(listener: (state: AppState) => void): () => void {
  refreshStateListeners.add(listener);
  return () => { refreshStateListeners.delete(listener); };
}

function publishRefreshState(state: AppState): void {
  for (const listener of refreshStateListeners) {
    try { listener(state); }
    catch (error) { writeDiagnostic("refresh.presentation.failed", diagnosticErrorDetails(error), "warning"); }
  }
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

const fullRefreshOutcomeListeners = new Set<(outcome: FullRefreshOutcome) => void>();
export function subscribeFullRefreshOutcome(
  listener: (outcome: FullRefreshOutcome) => void,
): () => void {
  fullRefreshOutcomeListeners.add(listener);
  return () => { fullRefreshOutcomeListeners.delete(listener); };
}

function publishFullRefreshOutcome(outcome: FullRefreshOutcome): void {
  for (const listener of fullRefreshOutcomeListeners) {
    try { listener(outcome); } catch { /* a listener cannot change how the refresh ended */ }
  }
}

function statePresentationFingerprint(state: AppState): string {
  return JSON.stringify(
    state.shipments.map((shipment) => shipmentEffectiveFingerprint(shipment)),
  );
}

function refreshProviderResultForError(error: unknown): RefreshProviderResult {
  const details = diagnosticErrorDetails(error);
  const failure = String(details.failureCode || details.errorCategory || "");
  if (failure === "invalid_query" || failure === "phone_tail" || failure === "phone_verification_required") {
    return "invalid_query";
  }
  if (failure === "upstream_rejected" || failure === "upstream_business_error" || failure === "upstream") {
    return "upstream_rejected";
  }
  if (failure === "timeout") return "timeout";
  if (failure === "network") return "network";
  return "failed";
}
type ShipmentRefreshResult = {
  shipment: Shipment;
  state: AppState;
  refreshed: boolean;
  completedSourceQuery?: boolean;
  querySucceeded?: boolean;
  skipReason?: "signed_frozen";
  detailEntry?: DetailEntryObservation;
  /** Unified express toast (AGENTS §11) chosen by the refresh, rendered from the shared copy table. */
  expressToast?: ExpressToastKey;
};
export type DetailEntryObservation = Readonly<{
  fingerprint: string;
  gaveTimeline: boolean;
}>;
type ShipmentRefreshOptions = {
  forceAccountOrderProjection?: boolean;
  forceManualRefresh?: boolean;
  includeKdniaoFallback?: boolean;
  trigger?:
    | "detail_open"
    | "detail_pull"
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
type TargetRefreshLease = Readonly<{
  deadlineAtMs?: number;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  expectedFingerprint?: string;
}>;
/**
 * 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒。A detail refresh (open or pull) is one user operation outside
 * the sync round: every carrier recognition it waits for — its nested identity projection included, which runs under
 * the same lease — shares one 30-second budget.
 */
const operationRecognitionBudgets = new WeakMap<TargetRefreshLease, CarrierRecognitionBudget>();
function operationRecognitionBudget(lease: TargetRefreshLease): CarrierRecognitionBudget {
  let budget = operationRecognitionBudgets.get(lease);
  if (!budget) {
    budget = new CarrierRecognitionBudget();
    operationRecognitionBudgets.set(lease, budget);
  }
  return budget;
}
const refreshCoordinator = new RefreshCoordinator<
  BindingSource,
  string,
  ShipmentRefreshResult,
  RefreshSummary
>();

type DeferredRouteOwner = "shipment" | "pending";
type DeferredRouteMutation = ShipmentRouteMutation & {
  owner: DeferredRouteOwner;
  expectedVersion: string;
};
type DeferredRouteMutationInput =
  | {
      owner: DeferredRouteOwner;
      expectedVersion: string;
      kind: "save";
      targetId: string;
      source: BindingSource;
      url: string;
    }
  | {
      owner: DeferredRouteOwner;
      expectedVersion: string;
      kind: "move";
      fromId: string;
      targetId: string;
      source: BindingSource;
    };
type DeferredRouteMutations = Map<string, DeferredRouteMutation>;
type RefreshCheckpoint = (
  candidate: AppState,
  mutations: DeferredRouteMutations,
  stage: string,
  base?: AppState,
) => AppState;
type ProjectionAttemptGuard = Readonly<{
  ownerId: string;
  routeHash: string;
  attemptId: string;
}>;
type ProjectionCheckpoint = (
  candidate: AppState,
  mutations: DeferredRouteMutations,
  stage: string,
  guard: ProjectionAttemptGuard,
) => Readonly<{ state: AppState; applied: boolean }>;

function replaceById(
  shipments: readonly Shipment[],
  incoming: Shipment,
): Shipment[] {
  return [
    ...shipments.filter((item) => item.identity.id !== incoming.identity.id),
    incoming,
  ];
}

function safelyRemoveRoutes(ids: readonly string[]): void {
  try {
    removeShipmentRoutes(ids);
  } catch {
    /* stale routes remain encrypted and expire automatically */
  }
  try {
    removeOrderProjectionReferences(ids);
  } catch {
    /* projection references remain encrypted and expire automatically */
  }
}

function routeMutationKey(owner: DeferredRouteOwner, targetId: string): string {
  return `${owner}:${targetId}`;
}

function shipmentRouteVersion(shipment: Shipment): string {
  return `${shipment.identity.id}:${shipment.updatedAtMs}`;
}

function pendingRouteVersion(pending: PendingManualQuery): string {
  return `${pending.id}:${pending.lastAttemptAtMs}:${pending.attempts}:${pending.createdAtMs}:${pending.rawCourierCode || ""}:${Boolean(pending.awaitingRoundCompletion)}`;
}

function pendingGenerationVersion(pending: PendingManualQuery): string {
  return JSON.stringify({
    id: pending.id,
    source: pending.source,
    waybill: normalizeWaybill(pending.waybill),
    phoneTail: pending.phoneTail,
    courierCode: pending.courierCode,
    rawCourierCode: pending.rawCourierCode || "",
    companyName: pending.companyName,
    createdAtMs: pending.createdAtMs,
    lastAttemptAtMs: pending.lastAttemptAtMs,
    attempts: pending.attempts,
    awaitingRoundCompletion: Boolean(pending.awaitingRoundCompletion),
  });
}

function queueRouteMutation(
  mutations: DeferredRouteMutations,
  mutation: DeferredRouteMutationInput,
): void {
  const key = routeMutationKey(mutation.owner, mutation.targetId);
  mutations.set(key, { ...mutation, key } as DeferredRouteMutation);
}

function deferIncomingRoute(
  merged: Shipment,
  incoming: Shipment,
  routeUrl: string,
  now: number,
  mutations: DeferredRouteMutations,
): Shipment {
  const pointer = incoming.route || null;
  if (!pointer || !routeUrl) return merged;
  if (
    merged.route &&
    (merged.route.kind !== pointer.kind || merged.route.source !== pointer.source)
  ) {
    return merged;
  }
  const hadStoredRoute = Boolean(
    merged.route &&
    loadShipmentRoute(merged.identity.id, merged.route.source, now, merged.route.kind),
  );
  queueRouteMutation(mutations, {
    owner: "shipment",
    expectedVersion: shipmentRouteVersion(merged),
    kind: "save",
    targetId: merged.identity.id,
    source: pointer.source,
    routeKind: pointer.kind,
    url: routeUrl,
  });
  return hadStoredRoute ? merged : { ...merged, route: null };
}

function deferPersistedRoute(
  merged: Shipment,
  incoming: Shipment,
  now: number,
  mutations: DeferredRouteMutations,
): Shipment {
  const pointer = incoming.route || null;
  const key = routeMutationKey("shipment", merged.identity.id);
  if (mutations.has(key)) return merged;
  const usableCurrent = Boolean(merged.route) && Boolean(
    loadShipmentRoute(merged.identity.id, merged.route!.source, now, merged.route!.kind),
  );
  if (usableCurrent || !pointer) return merged;
  if (merged.route) merged = { ...merged, route: null };
  if (loadShipmentRoute(incoming.identity.id, pointer.source, now, pointer.kind)) {
    queueRouteMutation(mutations, {
      owner: "shipment",
      expectedVersion: shipmentRouteVersion(merged),
      kind: "move",
      fromId: incoming.identity.id,
      targetId: merged.identity.id,
      source: pointer.source,
      routeKind: pointer.kind,
    });
  }
  return merged;
}

function deferPendingRoute(
  merged: Shipment,
  pending: PendingManualQuery,
  now: number,
  mutations: DeferredRouteMutations,
): Shipment {
  const pointer = pending.route || null;
  const key = routeMutationKey("shipment", merged.identity.id);
  if (mutations.has(key)) return merged;
  const usableCurrent = Boolean(merged.route) && Boolean(
    loadShipmentRoute(merged.identity.id, merged.route!.source, now, merged.route!.kind),
  );
  if (usableCurrent || !pointer) return merged;
  if (merged.route) merged = { ...merged, route: null };
  if (loadShipmentRoute(pending.id, pointer.source, now, pointer.kind)) {
    queueRouteMutation(mutations, {
      owner: "shipment",
      expectedVersion: shipmentRouteVersion(merged),
      kind: "move",
      fromId: pending.id,
      targetId: merged.identity.id,
      source: pointer.source,
      routeKind: pointer.kind,
    });
  }
  return merged;
}

function deferPendingRouteUpdate(
  current: PendingManualQuery,
  incoming: PendingManualQuery,
  routeUrl: string,
  now: number,
  mutations: DeferredRouteMutations,
): PendingManualQuery {
  const pointer = incoming.route || null;
  const existingRoute = current.route && Boolean(
    loadShipmentRoute(current.id, current.route.source, now, current.route.kind),
  ) ? current.route : null;
  if (!pointer || !routeUrl) {
    return { ...incoming, route: existingRoute };
  }
  queueRouteMutation(mutations, {
    owner: "pending",
    expectedVersion: pendingRouteVersion(incoming),
    kind: "save",
    targetId: incoming.id,
    source: pointer.source,
    routeKind: pointer.kind,
    url: routeUrl,
  });
  return { ...incoming, route: existingRoute };
}

function stateWithRoutePublications(
  state: AppState,
  publications: readonly ShipmentRoutePublication[],
  mutations: DeferredRouteMutations,
): AppState {
  const shipmentRoutes = new Map<string, Shipment["route"]>();
  const pendingRoutes = new Map<string, PendingManualQuery["route"]>();
  for (const publication of publications) {
    const mutation = mutations.get(publication.key);
    if (!mutation) continue;
    if (mutation.owner === "shipment") {
      shipmentRoutes.set(publication.targetId, {
        kind: publication.routeKind,
        source: publication.source,
      });
    } else {
      pendingRoutes.set(publication.targetId, {
        kind: publication.routeKind,
        source: publication.source,
      });
    }
  }
  return {
    ...state,
    shipments: state.shipments.map((shipment) => {
      const route = shipmentRoutes.get(shipment.identity.id);
      return route
        ? { ...shipment, route }
        : shipment;
    }),
    pendingQueries: state.pendingQueries.map((pending) => {
      const route = pendingRoutes.get(pending.id);
      return route
        ? { ...pending, route }
        : pending;
    }),
  };
}

function publishDeferredRoutes(
  state: AppState,
  mutations: DeferredRouteMutations,
  now: number,
  commit?: { state: AppState; routesPruned?: boolean },
): AppState {
  const eligible = [...mutations.values()].filter((mutation) =>
    mutation.owner === "shipment"
      ? state.shipments.some(
          (shipment) =>
            shipment.identity.id === mutation.targetId &&
            shipmentRouteVersion(shipment) === mutation.expectedVersion,
        )
      : state.pendingQueries.some(
          (pending) =>
            pending.id === mutation.targetId &&
            pendingRouteVersion(pending) === mutation.expectedVersion,
        )
  );
  if (!eligible.length) {
    // Only this immediate, unchanged publication can reuse the successful commit cleanup.
    if (commit?.state !== state || !commit.routesPruned) safelyPruneRoutes(state);
    return state;
  }
  try {
    const published = commitShipmentRouteMutations(
      eligible,
      (publications) => {
        const candidate = stateWithRoutePublications(
          state,
          publications,
          mutations,
        );
        return commitRoutePointers(
          state,
          candidate,
          publications.flatMap((publication) => {
            const mutation = mutations.get(publication.key);
            return mutation
              ? [{ owner: mutation.owner, targetId: publication.targetId }]
              : [];
          }),
          now,
        );
      },
      now,
    ) || state;
    safelyPruneRoutes(published);
    return published;
  } catch (error) {
    safelyPruneRoutes(state);
    throw error;
  }
}

function adoptPendingRoute(
  merged: Shipment,
  pending: PendingManualQuery,
  now: number,
): Shipment {
  const pointer = pending.route || null;
  const usableCurrent = Boolean(merged.route) && Boolean(
    loadShipmentRoute(
      merged.identity.id,
      merged.route!.source,
      now,
      merged.route!.kind,
    ),
  );
  if (usableCurrent || !pointer) return merged;
  if (merged.route) merged = { ...merged, route: null };
  try {
    if (moveShipmentRoute(
      pending.id,
      merged.identity.id,
      pointer.source,
      now,
      pointer.kind,
    )) {
      return { ...merged, route: pointer };
    }
  } catch {
    /* the promoted shipment remains usable through its local timeline */
  }
  return merged;
}

function isCainiaoAutomaticShipment(shipment: Shipment): boolean {
  return Boolean(
    !shipment.identity.manuallyAdded &&
      String(shipment.identity.sourceProvider || "").trim().toLowerCase() ===
        "cainiao",
  );
}

function cainiaoListHasUpdate(previous: Shipment | undefined, current: Shipment): boolean {
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

function canQueryHomeAccount(shipment: Shipment, cainiaoListUpdated: boolean, now = Date.now()): boolean {
  return homeAccountQueryEligible(shipment, cainiaoListUpdated) && !signedRefreshFrozen(shipment, now);
}

/**
 * The Home follow-up's own conditions. A newly reported completion still gets its final detail unless the row has
 * reached the signed freeze: status, headline and local detail all at the signing (用户 2026-10-02「头条 状态 详情页 都
 * 推进到了签收状态…就冻结快递 后续不再进行任何刷新」). An explicit sign-off stops it only once hard-frozen (用户 2026-10-02
 * 「我已取件这种硬冻结 也要等三态都是签收才冻结」，弹窗「iOS 右滑签收一起改」); both are canQueryHomeAccount's freeze check.
 */
function homeAccountQueryEligible(shipment: Shipment, cainiaoListUpdated: boolean): boolean {
  if (!isCainiaoAutomaticShipment(shipment)) return false;
  return cainiaoListUpdated && isHomeAccountQuerySource(shipment) && Boolean(shipment.accountRecord) &&
    shipment.timeline.provider !== "demo" &&
    selectShipmentTimeline(shipment).semantic !== "CANCELLED";
}

function safeWaybillTail(shipment: Shipment): string {
  const waybill = normalizeWaybill(displayWaybill(shipment));
  return waybill.length > 4 ? waybill.slice(-4) : "";
}

/** 日志里的包名统一用槽名：feed 是 v5_list，其余按槽名（用户定 2026-09-05）。 */
function diagnosticTimelineProvider(provider: string): string {
  const raw = String(provider || "").trim().toLowerCase();
  if (raw === "interface5" || raw === "account") return "v5_list";
  return normalizeTimelineSlot(raw) || timelineCapability(raw);
}

function shipmentDiagnosticDetails(
  shipment: Shipment, requestProvider?: string, response?: TimelinePackage,
) {
  const presented = selectShipmentTimeline(shipment);
  const displayed = requestProvider ? selectShipmentDetailTimeline(shipment) : presented;
  const displayedTrackCount = timedTracks(displayed.tracks).length;
  const observed = response || displayed;
  const status = response || presented;
  return {
    ...(!response ? shipmentSelectionEvidence(shipment) : {}),
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

/** Trace the same list observation before projection, after merge and after the durable commit. */
function logJingDongListRecords(
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
  writeDiagnosticBatch("account.list.record", records);
}

function cainiaoRouteDiagnosticDetails(
  shipment: Shipment,
  routeUrl: string,
) {
  return {
    ...shipmentDiagnosticDetails(shipment),
    routePresent: Boolean(String(routeUrl || "").trim()),
    routeTrusted: trustedCainiaoH5Route(routeUrl),
  };
}

function cainiaoH5DiagnosticDetails(
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

function storedCainiaoRoute(shipment: Shipment, now = Date.now()): string {
  if (
    !isCainiaoAutomaticShipment(shipment) ||
    shipment.route?.kind !== "cainiao"
  ) return "";
  return loadShipmentRoute(
    shipment.identity.id,
    shipment.route.source,
    now,
  );
}

let h5Queue: Promise<void> = Promise.resolve();
async function withH5Controller<T>(
  capture: () => Promise<T>,
  deadlineAtMs = deadlineAfter(ACCOUNT_H5_BUDGET_MS),
  signal?: AbortSignal,
): Promise<T> {
  const previous = h5Queue;
  let release!: () => void;
  const turn = new Promise<void>(resolve => { release = resolve; });
  h5Queue = previous.then(() => turn);
  let durable: DurableRefreshLease | null = null;
  try {
    await waitForRefresh(previous, deadlineAtMs, signal);
    while (!durable) {
      assertRefreshSignal(signal);
      assertWithinDeadline(deadlineAtMs);
      durable = acquireRenewingDurableRefreshLease("detail:h5", deadlineAtMs - Date.now() + 1000);
      if (!durable) await waitForRefresh(new Promise<void>(resolve => setTimeout(resolve, 100)), deadlineAtMs, signal);
    }
    return await capture();
  } finally {
    durable?.release();
    release();
  }
}

async function refreshWebTimeline(
  shipment: Shipment,
  deadlineAtMs?: number,
  observe?: (diagnostics: WebTimelineDiagnostics) => void,
  signal?: AbortSignal,
  onQueryAttempted?: (authorized: boolean) => void,
  boundPhoneTails: readonly string[] = [],
  beforeQuery?: () => void,
): Promise<Shipment | null> {
  // Stage eligibility belongs to callers; an order number is never a K100 waybill.
  if (unprojectedAccountOrder(shipment)) return null;
  const now = Date.now();
  const timeline = await withH5Controller(() => scrapeWebTimeline({
    waybill: displayWaybill(shipment),
    courierCode: shipment.identity.courierCode,
    companyName: shipment.identity.companyName,
    phoneTail: shipment.identity.phoneTail,
    phoneTails: boundPhoneTails,
    deadlineAtMs,
    signal,
    onQueryAttempted,
    beforeQuery,
  }, observe), deadlineAtMs, signal);
  if (!timeline) return null;
  const enriched = applySameSourceTimeline(shipment, timeline, now);
  const captured = enriched.manualTimelines?.find(candidate =>
    normalizeTimelineSlot(candidate.provider) === normalizeTimelineSlot(timeline.provider));
  // Provider results carry their own accumulated package, not a presentation with borrowed owner status.
  return captured ? { ...enriched, timeline: captured, sourceTimeline: null,
    manualTimelines: [captured] } : null;
}

function isJingDongAutomaticShipment(shipment: Shipment): boolean {
  return Boolean(
    !shipment.identity.manuallyAdded &&
      shipment.identity.accountOrder &&
      isJingDongSourceShipment(shipment),
  );
}

function storedJingDongProjectionRoute(
  shipment: Shipment,
  now = Date.now(),
): string {
  const source = shipment.identity.bindingSource;
  if (!isJingDongAutomaticShipment(shipment) || !source) return "";
  return loadOrderProjectionReference(shipment.identity.id, source, now);
}

async function refreshCainiaoH5(
  shipment: Shipment,
  routeUrl: string,
  deadlineAtMs?: number,
  observe?: (diagnostics: CainiaoH5Diagnostics) => void,
  signal?: AbortSignal,
  onQueryAttempted?: (authorized: boolean) => void,
  beforeQuery?: () => void,
): Promise<Shipment | null> {
  assertRefreshSignal(signal);
  if (!isCainiaoAutomaticShipment(shipment) || !routeUrl) return null;
  const now = Date.now();
  const timeline = await withH5Controller(() => scrapeCainiaoH5Timeline({
    routeUrl,
    waybill: displayWaybill(shipment),
    courierCode: shipment.identity.courierCode,
    companyName: shipment.identity.companyName,
    deadlineAtMs,
    successAtMs: now,
    signal,
    onQueryAttempted,
    beforeQuery,
  }, observe), deadlineAtMs, signal);
  assertRefreshSignal(signal);
  return timeline && timedTracks(timeline.tracks).length
    ? applySameSourceTimeline(shipment, timeline, now)
    : null;
}

function stageBudgetMs(
  deadlineAtMs: number | undefined,
  now = Date.now(),
  fallbackBudgetMs = 0,
): number {
  return deadlineAtMs == null
    ? Math.max(0, fallbackBudgetMs)
    : Math.max(0, deadlineAtMs - now);
}

function assertRefreshSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationTimeoutError();
}

function rethrowRefreshCancellation(
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
function rethrowStageCancellation(signal: AbortSignal | undefined, endStage: () => void): void {
  if (!signal?.aborted) return;
  endStage();
  assertRefreshSignal(signal);
}

/** A stage whose caller writes its cancelled end itself (see projectAccountOrders). */
const CALLER_ENDS_CANCELLED_STAGE: StageCancellationEnd = { end: () => {}, close: () => {} };

function projectionOwnerId(parcel: AccountParcelDto): string {
  return `${parcel.source}:account:${normalizeWaybill(parcel.ownerId)}`;
}

/**
 * 用户 2026-09-25 同意：刷新流程只在 App 在前台（场景 active）时开京粉页，否则这一单跳过、留给前台那一遍
 * 存盘行投影；不在屏幕上的页面只会超时（visibilityState=hidden）。
 */
class UnionPageSkipped extends Error {
  constructor(readonly reason: "not_foreground") {
    super("union page left to the on-screen pass");
    this.name = "UnionPageSkipped";
  }
}

/**
 * 用户 2026-10-03「所有开京粉页的路都检查」（代码 4）：the detail flow's own check, asked right before its union page
 * loads (the list path's gate also checks its lease).
 */
function unionPageSceneGate(): void {
  if (!projectionSceneActive()) throw new UnionPageSkipped("not_foreground");
}

/**
 * 用户 2026-10-03「这轮就统一」（优化 1，口径「拿到回答就算用掉」）：whether one union page load answered. A package —
 * partial or not — or a fully loaded page without logistics is an answer; risk control, and a load that failed, timed out
 * or never reached the union request (方案 A's uninformative page), are not.
 */
function unionPageGaveAnswer(
  diagnostics: AccountOrderProjectionDiagnostics | null,
  captured: TimelinePackage | null | undefined,
): boolean {
  if (diagnostics && projectionRiskControlled(diagnostics.unionResponseStatuses, diagnostics.riskControlSeen === true)) {
    return false;
  }
  return timedTracks(captured?.tracks || []).length > 0 || unionPageOutcome(diagnostics) !== "uninformative";
}

/**
 * 优化 5 续（用户 2026-10-03「第一次识别时记下锚点，之后不变」）：the anchor a stored row sends with the paid carrier stage —
 * the one recorded the first time it sent one, else its reuse anchor as it is now (then recorded).
 */
function rowClassifyAnchor(shipment: Shipment): () => number | undefined {
  return () => firstClassifyAnchor(shipment.identity.id, () => shipmentReuseAnchorAtMs(shipment));
}

/** Puts back one attempt record as it was before a reservation (undefined removes it). */
function withProjectionAttemptRecord(
  shipment: Shipment,
  field: ProjectionAttemptField,
  retry: Shipment["identity"]["orderProjectionRetry"],
): Shipment {
  const { [field]: _reserved, ...identity } = shipment.identity;
  return { ...shipment, identity: retry ? { ...identity, [field]: retry } : identity };
}

function projectionCooldownKey(parcel: AccountParcelDto): string {
  // 用户定 2026-09-04：冷却按**订单**记，与 Pipi 的 ExpressJdH5Cooldown（订单号 SHA-256）对齐。
  // 原来按 projectionUrl 哈希——京东 H5 链接带 token 与时间戳，feed 下一轮换个链接哈希就变了，
  // sameRoute 不成立，10 分钟与风控 60 分钟的记录当场作废：403 本该歇一小时，实际下一轮又开页。
  // 捕获策略变更仍然使冷却失效（策略串还在哈希里），这是它原本就该有的作用。
  // 持久化字段名仍是 `routeHash`，改名要迁移旧数据，不值得。
  // The same hash as before (sha256 of strategy \0 owner id); it moved to the policy module so the
  // list's visibility check can read an order's empty-page mark too (2026-09-25).
  return accountOrderProjectionRouteHash(projectionOwnerId(parcel));
}

function projectionOwnerFingerprint(ownerId: string): string {
  return privateHash(ownerId).slice(0, 12);
}

async function projectAccountOrderWithCarrier(
  parcel: AccountParcelDto,
  projectionDeadlineAtMs: number | undefined,
  recognitionDeadlineAtMs: number | undefined,
  observe?: (diagnostics: AccountOrderProjectionDiagnostics) => void,
  signal?: AbortSignal,
  beforeLoad?: () => void,
  /** The round's or operation's recognition wait (用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒). */
  recognitionBudget?: CarrierRecognitionBudget,
): Promise<AccountParcelDto> {
  const projected = await withH5Controller(() => projectAccountOrder(
    parcel,
    projectionDeadlineAtMs,
    observe,
    signal,
    beforeLoad,
  ), projectionDeadlineAtMs, signal);
  // Best effort (T23, 2026-09-26): a recognition failure must not drop the waybill the page named; an unmatched
  // carrier holds the projection instead.
  return normalizeAccountParcelCarrierBestEffort(projected, {
    deadlineAtMs: recognitionDeadlineAtMs,
    signal,
    budget: recognitionBudget,
  });
}

/** An order projection whose carrier neither the recognizer nor the page named. */
function projectionWithoutCarrier(parcel: AccountParcelDto): boolean {
  if (!parcel.accountOrder ||
      normalizeWaybill(parcel.waybill) === normalizeWaybill(parcel.ownerId)) return false;
  return !projectedCarrierPresentation(parcel.waybill, parcel.courierCode, parcel.companyName).companyName;
}

/**
 * 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28）：订单已经拿到真实运单号，承运商却没对上（识别链与页面都
 * 没给名字）。这样的投影不落地，订单行保持原样——直到识别进入终态（其余裁决 32、33），那时照常落地。
 */
function projectionAwaitingCarrier(parcel: AccountParcelDto): boolean {
  return projectionWithoutCarrier(parcel) && !carrierRecognitionExhausted(parcel.waybill);
}

/**
 * 其余裁决 32、33（用户 2026-09-26）：识别已进入终态（连续 3 次失败，或付费级明确认不出，且快递100 没给名字）的投影不再
 * 停在订单阶段：照常落地，承运商位置填这张订单来源传回的承运商码原样（JDKD 这类，不是平台名）；没传回就空着
 * （「传回啥 cpcode 就填啥」）。
 */
function releaseExhaustedProjection(projected: AccountParcelDto, orderRawCode: string | undefined): AccountParcelDto {
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

/** Whether a held or text waybill can be settled now: recognition may answer, or it is exhausted (其余裁决 32、33). */
function heldCarrierSettleable(waybill: string, now: number): boolean {
  return carrierRecognitionDue(waybill, now) || carrierRecognitionExhausted(waybill);
}

type HeldProjection = NonNullable<Shipment["identity"]["pendingProjection"]>;

/** The parcel a held union-page projection stands for, its carrier still to be recognised. */
function heldProjectionParcel(parcel: AccountParcelDto, held: HeldProjection): AccountParcelDto {
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
function withHeldProjection(
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
function withProjectionRetry(
  shipment: Shipment,
  retry: Shipment["identity"]["orderProjectionRetry"],
): Shipment {
  const { orderProjectionRetry: _reserved, ...identity } = shipment.identity;
  return { ...shipment, identity: retry ? { ...identity, orderProjectionRetry: retry } : identity };
}

/**
 * T23: a recognised carrier on a row that shows a real waybill without one. A projected order is repaired like the
 * detail repair always did; any other row takes the carrier on its identity. A JD result on a non-JD waybill of a
 * JD business row stays refused (R-20). Returns the row unchanged when nothing matched.
 */
function withRecognizedCarrier(
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
 * an exhausted recognition (其余裁决 32), once the recognizer may answer again. Best effort.
 */
async function recognizeAwaitingCarrier(
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
type ProjectionAttemptField = "orderProjectionRetry" | "jingDongH5Retry";

function projectionAttempt(
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
function completedUnprojectedOrder(shipment: Shipment | undefined): boolean {
  return Boolean(
    shipment &&
    unprojectedAccountOrder(shipment) &&
    shipmentPresentationStatus(shipment).semantic === "COMPLETED",
  );
}

function ownsProjectionAttempt(
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

const activeProjectionAttempts = new Map<string, { promise: Promise<void>; settle: () => void }>();

function trackProjectionAttempt(shipmentId: string): void {
  settleProjectionAttempt(shipmentId);
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  activeProjectionAttempts.set(shipmentId, { promise, settle });
}

function settleProjectionAttempt(shipmentId: string): void {
  const entry = activeProjectionAttempts.get(shipmentId);
  if (!entry) return;
  activeProjectionAttempts.delete(shipmentId);
  entry.settle();
}

const PROJECTION_WAIT_MAX_SLICE_MS = 1_000;

async function waitForProjectionAttemptRelease(
  shipmentId: string,
  signal?: AbortSignal,
): Promise<ShipmentRefreshResult | null> {
  const waitDeadlineAtMs = Date.now() +
    ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS + FORCED_PROJECTION_WAIT_SLICE_MS;
  let sliceMs = FORCED_PROJECTION_WAIT_SLICE_MS;
  let seenRevision = peekStateRevision();
  let state = loadState();
  while (true) {
    assertRefreshSignal(signal);
    const shipment = state.shipments.find(
      (item) => item.identity.id === shipmentId,
    );
    if (!shipment) throw new Error("该快递已从列表中移除");
    if (!unprojectedAccountOrder(shipment)) {
      return { shipment, state, refreshed: true };
    }
    const remainingAttemptMs = accountOrderProjectionAttemptRemainingMs(
      shipment.identity.orderProjectionRetry,
    );
    if (remainingAttemptMs <= 0) return null;
    const remainingWaitMs = waitDeadlineAtMs - Date.now();
    if (remainingWaitMs <= 0) return null;
    const inProcess = activeProjectionAttempts.get(shipmentId)?.promise || null;
    let inProcessSettled = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(
        resolve,
        Math.max(1, Math.min(sliceMs, remainingAttemptMs, remainingWaitMs)),
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
function projectionFailureRetry(
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
function orderProjectionFailureRetry(
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

function retainObservedProjectionRisk(
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

/**
 * R-29 (AGENTS §9, 2026-09-03): a Picker / K100 H5 / KDNiao result whose nodes predate the
 * account order's first feed node by more than a day belongs to another parcel. It is logged as
 * `foreign_package`, not applied, and therefore never cached.
 */
function rejectForeignManualResult(
  base: Shipment,
  result: Shipment | null,
  details: Readonly<{
    flowId: string;
    source: string;
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

function recordProjectionFailure(
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

function persistAccountOrderProjectionReferences(
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
  return replaceById(shipmentsInput, projected);
}

async function synchronizeAccountList(
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
      attempted,
      succeeded: 0,
      failed,
      canContinue,
    };
  }
  const parcels = fetched.parcels;
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
    attempted,
    succeeded,
    failed,
    canContinue: true,
  };
}

/** The list row's structured status before parcelToShipment clamps an unprojected 已揽收 to 已下单. */
type ProjectionListSemantic = (
  parcel: AccountParcelDto,
  owner: Shipment,
) => StatusSemantic | null;

const listParcelStructuredSemantic: ProjectionListSemantic = (parcel) =>
  accountParcelStructuredSemantic(parcel);

/** A stored row no longer has that list parcel; its raw list state code answers instead. */
const storedRowStructuredSemantic: ProjectionListSemantic = (_parcel, owner) =>
  storedAccountListStructuredSemantic(owner);

type AccountOrderProjectionDecision = Readonly<{
  due: boolean;
  skipped?: "before_pickup" | "carrier_pending" | ProjectionRestReason;
}>;

type ProjectionRestReason = "active_attempt" | "confirmed_empty" | "cooldown";

/** Why the union page stays closed for an order `shouldRetryAccountOrderProjectionUnprompted` refused. */
function projectionRestReason(
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
function accountOrderProjectionDecision(
  parcel: AccountParcelDto,
  shipments: readonly Shipment[],
  now: number,
  skipRefreshIds: ReadonlySet<string>,
  textBackfillOnly: boolean,
  listStructuredSemantic: ProjectionListSemantic,
  includeCompleted = false,
): AccountOrderProjectionDecision {
  if (!parcel.accountOrder) return { due: false };
  const expectedId = projectionOwnerId(parcel);
  const existingOwner = shipments.find(
    (item) => item.identity.id === expectedId,
  );
  const heldWaybill = existingOwner?.identity.pendingProjection?.waybill || "";
  if (!parcel.projectionUrl && !parcel.textIdentity?.waybill && !heldWaybill) return { due: false };
  if (skipRefreshIds.has(expectedId)) return { due: false };
  if (normalizedProjectedWaybill(existingOwner?.identity)) return { due: false };
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

async function projectAccountOrders(
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
  const candidates = parcels.filter((parcel) => {
    const decision = accountOrderProjectionDecision(
      parcel, shipments, now, skipRefreshIds, textBackfillOnly, listStructuredSemantic, includeCompleted,
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
      !parcel.textIdentity?.waybill &&
      !heldProjection &&
      !shouldRetryAccountOrderProjectionUnprompted(
        freshOwner?.identity.orderProjectionRetry,
        routeHash,
        Date.now(),
      )
    ) {
      if (freshOwner) shipments = replaceById(shipments, freshOwner);
      writeDiagnostic("order.projection.skipped", {
        flowId,
        source,
        stage: "webview",
        ownerFingerprint,
        result: projectionRestReason(freshOwner?.identity.orderProjectionRetry, routeHash, Date.now()),
      });
      continue;
    }
    if (freshOwner) shipments = replaceById(shipments, freshOwner);
    if (!freshOwner) continue;
    // A feed-text waybill loads no page, so only a page load is gated.
    const pageGate = parcel.textIdentity?.waybill || heldProjection ? undefined : unionPageGate;
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
    trackProjectionAttempt(expectedId);
    let projectionDiagnostics: AccountOrderProjectionDiagnostics | null = null;
    writeDiagnostic("order.projection.started", {
      flowId,
      source,
      stage: "webview",
      ownerFingerprint,
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
      settleProjectionAttempt(expectedId);
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
    // 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28）：运单号拿到了、承运商没对上，这张订单保持原样、不推。
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
    settleProjectionAttempt(expectedId);
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
function recordAccountOrderProjectionCommits(
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

type ManualRefreshTask = { id: string; lastAttemptAtMs: number; accountDetail?: boolean;
  cainiaoListUpdated?: boolean; backgroundAlignment?: boolean };

/** The signed background exception is Online-only; the foreground retains its complete source chain. */
function backgroundSfAlignmentTimes(shipment: Shipment, now: number): StatusAlignmentTimes | null {
  if (shipment.identity.manuallyAdded || !isShunFengSourceShipment(shipment) ||
      shipment.timeline.provider === "demo" || forcedCompletedAt(shipment) || signedRefreshFrozen(shipment, now) ||
      shipmentHeadlineMatchesStatus(shipment)) return null;
  const times = statusAlignmentTimes(shipment, now);
  if (!times || times.statusSemantic !== "COMPLETED" || !statusAlignmentOutOfStep(times)) return null;
  const record = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(shipment.identity.id)]);
  return alignmentAttemptDue(record, times, now, MANUAL_REFRESH_MIN_INTERVAL_MS) ? times : null;
}

function manualRefreshTasks(
  state: AppState, source: BindingSource, now: number,
  skipRefreshIds: ReadonlySet<string>, forceManualRefresh: boolean,
  accountSourceFollowup = false,
  updatedCainiaoIds: ReadonlySet<string> = new Set(),
  /** A Home follow-up the signed freeze stopped (its list did update), for the round's skip line. */
  onSignedFrozen?: (shipment: Shipment) => void,
  backgroundStatusAlignment = false,
): ManualRefreshTask[] {
  const homeFollowup = (current: Shipment): boolean => {
    const updated = updatedCainiaoIds.has(current.identity.id);
    if (!homeAccountQueryEligible(current, updated)) return false;
    if (!signedRefreshFrozen(current, now)) return true;
    onSignedFrozen?.(current);
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
          shouldScheduleManualRefresh(current, now, forceManualRefresh))
    )
  ).map(current => ({ id: current.identity.id, lastAttemptAtMs: Number(current.manualRefreshAttemptAtMs) || 0,
    accountDetail: accountSourceFollowup && isHomeAccountQuerySource(current),
    backgroundAlignment: backgroundStatusAlignment && Boolean(backgroundSfAlignmentTimes(current, now)),
    cainiaoListUpdated: updatedCainiaoIds.has(current.identity.id) }));
  return oldestBatchIndices(tasks.map(task => task.lastAttemptAtMs), tasks.length, state.revision)
    .map(position => tasks[position]);
}

async function refreshBackgroundSfAlignment(
  state: AppState, source: BindingSource, flowId: string, checkpoint: RefreshCheckpoint,
  task: ManualRefreshTask, deadlineAtMs: number | undefined, signal: AbortSignal,
  query: typeof queryManualForSource,
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
  let attempt: AlignmentAttempt | undefined, reservationError: unknown;
  const isCurrent = () => !signal.aborted && lease.isCurrent();
  const beforeQuery = () => {
    if (reservationError) throw reservationError;
    if (attempt) return;
    try {
      assertRefreshSignal(signal);
      assertWithinDeadline(deadlineAtMs);
      const latest = loadState(), target = latest.shipments.find(item => item.identity.id === task.id);
      if (!lease.isCurrent() || !alignmentOwnerCurrent(state, original, latest) || !target) throw new Error("Alignment owner changed");
      const fresh = backgroundSfAlignmentTimes(target, Date.now());
      if (!fresh || alignmentTimesKey(fresh) !== alignmentTimesKey(times)) throw new Error("Alignment group changed");
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
    if (reservationError) throw reservationError;
    assertRefreshSignal(signal);
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
      current = checkpoint({ ...current, shipments: sortShipments(replaceById(current.shipments, merged)) },
        mutations, "status_alignment");
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
        publishRefreshState(current);
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

/**
 * 手动件后台刷新（manual_refresh）问哪一级（用户定 2026-09-24，与 Pipi 对齐）：列表正显示的历史来自免费、
 * 非网页的手动源 v4_query 时，只再问这一级；网页/H5（k100_h5、jt_h5、cn_h5）、付费（kdniao）、v6_query 或
 * 没有/认不出时，照旧问 Online（v6_query）。v2_query 在 iOS 没有对应的查询，也照旧问 Online。失败、冷却都
 * 不换级；排程、终态与冷却的门不变。自动件不在此列，照旧问 Online。
 */
function manualBackgroundProvider(
  shipment: Shipment,
): typeof TIMELINE_SLOT.V4_QUERY | typeof TIMELINE_SLOT.V6_QUERY {
  if (!shipment.identity.manuallyAdded) return TIMELINE_SLOT.V6_QUERY;
  const listed = normalizeTimelineSlot(shipmentSelectionEvidence(shipment).historyProvider);
  return listed === TIMELINE_SLOT.V4_QUERY ? TIMELINE_SLOT.V4_QUERY : TIMELINE_SLOT.V6_QUERY;
}

async function refreshOnlineShipment(
  state: AppState, source: BindingSource, flowId: string, checkpoint: RefreshCheckpoint,
  task: ManualRefreshTask, deadlineAtMs: number | undefined, forceManualRefresh: boolean,
  signal: AbortSignal, query: typeof queryManualForSource,
  recognitionBudget?: CarrierRecognitionBudget,
): Promise<RefreshSummary> {
  let currentState = state;
  let attempted = 0, succeeded = 0, failed = 0;
  const summary = () => ({ state: currentState, attempted, succeeded, failed, promotedPendingShipmentIds: [] });
  let current = currentState.shipments.find(item => item.identity.id === task.id);
  if (!current || !manualRefreshTasks(currentState, source, Date.now(), new Set(), forceManualRefresh)
    .some(item => item.id === task.id) || deadlineExpired(deadlineAtMs)) return summary();
  // T23 (user 2026-09-26): a manual row whose carrier never matched is recognised again in every round it is
  // refreshed in, whatever the provider cooldown below decides.
  if (current.identity.manuallyAdded) {
    const recognized = await recognizeAwaitingCarrier(current,
      accountChildDeadline(deadlineAtMs, MANUAL_REFRESH_TASK_BUDGET_MS), signal, recognitionBudget);
    assertRefreshSignal(signal);
    if (recognized !== current) {
      currentState = checkpoint({ ...currentState,
        shipments: sortShipments(replaceById(currentState.shipments, recognized)) }, new Map(), "manual_carrier");
      current = currentState.shipments.find(item => item.identity.id === task.id);
      if (!current) return summary();
    }
  }
  const schedule = manualProviderSchedule({ source, waybill: displayWaybill(current),
    rawCourierCode: current.identity.rawCourierCode, phoneTail: current.identity.phoneTail,
    sourceProvider: current.identity.sourceProvider });
  const provider = manualBackgroundProvider(current);
  const moto = provider === TIMELINE_SLOT.V4_QUERY;
  // 冷却键沿用这一级自己的（Moto 是 "moto"，Online 是 "picker"），与手动链里同一级共用。
  if (!forceManualRefresh &&
      !refreshProviderDue(schedule.key, moto ? "moto" : "picker", schedule.identityFingerprint)) {
    writeDiagnostic("refresh.stage.skipped", { flowId, source, stage: "manual_refresh",
      ...shipmentDiagnosticDetails(current, provider), result: "cooldown", skipReason: "cooldown" });
    return summary();
  }
  const startedAt = Date.now();
  const taskDeadline = accountChildDeadline(deadlineAtMs, MANUAL_REFRESH_TASK_BUDGET_MS, 0, startedAt);
  const attemptId = createDiagnosticFlowId("manual");
  const commit = (shipment: Shipment, mutations: DeferredRouteMutations, stage: string) => {
    assertRefreshSignal(signal);
    currentState = checkpoint({ ...currentState, shipments: sortShipments(replaceById(currentState.shipments, shipment)) },
      mutations, stage);
  };
  commit(beginManualRefreshAttempt(current, attemptId, startedAt, taskDeadline), new Map(), "manual_refresh_attempt");
  let reserved = currentState.shipments.find(item => item.identity.id === task.id);
  if (!reserved || !ownsManualRefreshLease(reserved, attemptId)) return summary();
  const release = () => {
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
      currentShipment: reserved, ...(moto ? { motoOnly: true } : { pickerFirst: true, pickerOnly: true }),
      includeKdniaoFallback: false, scheduled: !forceManualRefresh, hostSafe: true });
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
    writeDiagnostic("refresh.stage.skipped", { flowId, source, stage: "manual_refresh", ...shipmentDiagnosticDetails(reserved || current, provider), result: "cooldown", skipReason: "cooldown" });
    return summary();
  }
  attempted++;
  const mutations: DeferredRouteMutations = new Map();
  if (outcome?.shipment && timedTracks(outcome.shipment.timeline.tracks).length) {
    const merged = deferIncomingRoute(applyManualShipment(reserved, outcome.shipment, Date.now()),
      outcome.shipment, outcome.routeUrl, Date.now(), mutations);
    commit(releaseManualRefreshLease(merged, attemptId), mutations, "manual_refresh");
    release();
    succeeded++;
    writeDiagnostic("refresh.stage.succeeded", { flowId, source, stage: "manual_refresh", ...shipmentDiagnosticDetails(reserved || merged, provider, outcome.shipment.timeline), durationMs: Date.now() - startedAt });
  } else {
    if (outcome?.shipment && outcome.routeUrl && isShunFengSourceShipment(reserved)) {
      commit(releaseManualRefreshLease(deferIncomingRoute(reserved, outcome.shipment, outcome.routeUrl,
        Date.now(), mutations), attemptId), mutations, "manual_refresh_route");
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

function pendingManualPreviewShipment(
  pending: PendingManualQuery,
): Shipment {
  const timeline: Shipment["timeline"] = {
    provider: "pending",
    complete: false,
    structuredStatus: false,
    waybill: pending.waybill,
    courierCode: pending.courierCode,
    companyName: pending.companyName,
    semantic: "UNKNOWN",
    statusEventAtMs: null,
    latestTimeText: "",
    latestDetail: "",
    tracks: [],
    successAtMs: pending.lastAttemptAtMs,
  };
  return {
    identity: {
      id: `${pending.source}:manual:${pending.waybill}`,
      bindingSource: pending.source,
      sourceOwner: "manual",
      sourceId: pending.waybill,
      phoneTail: pending.phoneTail,
      courierCode: pending.courierCode,
      rawCourierCode: pending.rawCourierCode,
      companyName: pending.companyName,
      manuallyAdded: true,
      createdAtMs: pending.createdAtMs,
    },
    timeline,
    sourceTimeline: null,
    manualTimelines: [],
    updatedAtMs: pending.lastAttemptAtMs,
  };
}

export async function queryManualShipmentPreview(input: {
  waybill: string;
  phoneTail?: string;
  presentation?: ManualCarrierDetection | null;
}, dependencies?: ManualSourceDependencies): Promise<ManualShipmentPreview> {
  const deadlineAtMs = deadlineAfter(MANUAL_QUERY_BUDGET_MS);
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
    const merged = applyManualShipment(current, preview.shipment, now);
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
        pending.source === preview.shipment.identity.bindingSource &&
        normalizeWaybill(pending.waybill) === canonical,
    );
    let next = saveState(
      {
        ...state,
        pendingQueries: state.pendingQueries.filter(
          (pending) =>
            pending.source !== preview.shipment.identity.bindingSource ||
            normalizeWaybill(pending.waybill) !== displayWaybill(shipment),
        ),
        shipments: replaceById(
          state.shipments.filter(
            (item) =>
              item.identity.id === shipment.identity.id ||
              item.identity.bindingSource !==
                preview.shipment.identity.bindingSource ||
              displayWaybill(item) !== canonical,
          ),
          shipment,
        ),
      },
      now,
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
  preview: ManualShipmentPreview,
  options: Readonly<{
    signal?: AbortSignal;
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
  const deadlineAtMs = deadlineAfter(MANUAL_QUERY_BUDGET_MS, startedAtMs);
  assertRefreshSignal(options.signal);
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
  const queryKuaidi100 = dependencies.queryKuaidi100 || ((shipment) =>
    refreshWebTimeline(
      shipment,
      deadlineAtMs,
      undefined,
      options.signal,
      undefined,
      bindings.map(binding => binding.phone.slice(-4)),
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
  let shipment = deferPendingRoute(
    { ...accumulated, updatedAtMs: settledAtMs },
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

export async function bindPhone(
  source: BindingSource,
  phone: string,
  code: string,
  diagnosticFlowId?: string,
): Promise<AppState> {
  requireScriptSource(source);
  const flowId = diagnosticFlowId || createDiagnosticFlowId("bind");
  const startedAt = Date.now();
  writeDiagnostic("binding.verify.started", { flowId, source });
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
}

export function unbindPhone(
  source: BindingSource,
  phone: string,
): AppState {
  requireScriptSource(source);
  const next = removeBinding(source, phone);
  safelyPruneRoutes(next);
  requestWidgetReload();
  return next;
}

function releaseTargetManualRefreshLease(
  shipmentId: string,
  attemptId: string,
  now = Date.now(),
): AppState {
  let latest = loadState(now);
  for (let retry = 0; retry < 2; retry++) {
    const current = latest.shipments.find(
      (shipment) => shipment.identity.id === shipmentId,
    );
    if (!current || !ownsManualRefreshLease(current, attemptId)) return latest;
    const commit = commitTargetShipmentRefresh(
      latest,
      releaseManualRefreshLease(current, attemptId),
      now,
      {
        isCurrent: () => true,
        acceptsState: (state) => ownsManualRefreshLease(
          state.shipments.find(
            (shipment) => shipment.identity.id === shipmentId,
          ),
          attemptId,
        ),
      },
    );
    latest = commit.state;
    if (commit.applied) return latest;
  }
  return latest;
}

function detailRequestFingerprint(shipment: Shipment, state: AppState): string {
  return privateHash(JSON.stringify({
    identity: [shipment.identity.id, shipment.identity.createdAtMs, shipment.identity.sourceOwner,
      shipment.identity.sourceProvider, displayWaybill(shipment), shipment.identity.courierCode,
      shipment.identity.rawCourierCode, shipment.identity.phoneTail, shipment.identity.manuallyAdded],
    record: shipment.accountRecord,
    binding: state.bindings.filter(binding => binding.source === shipment.identity.bindingSource &&
      binding.phone === shipment.identity.phone),
  }));
}

const accountDetailRequests = new RefreshCoordinator<BindingSource, string, AccountParcelDto | null, never>();
const accountSourceFullRequests = new WeakSet<Promise<RefreshSummary>>();
const forcedManualFullRequests = new WeakSet<Promise<RefreshSummary>>();
const interactiveFullRequests = new Map<BindingSource, Promise<RefreshSummary>>();

function requestAccountDetail(
  shipment: Shipment, state: AppState, query: typeof refreshAccountParcel,
  deadlineAtMs: number | undefined, signal?: AbortSignal,
  beforeQuery?: () => void,
): Promise<AccountParcelDto | null> {
  const source = requireScriptSource(shipment.identity.bindingSource);
  const deadline = accountChildDeadline(deadlineAtMs, ACCOUNT_DETAIL_BUDGET_MS);
  // Share only the live transport observation; each consumer retains its own commit fence.
  return accountDetailRequests.runIndependentDetail(detailRequestFingerprint(shipment, state), source,
    sharedSignal => query(shipment, deadlineAfter(ACCOUNT_DETAIL_BUDGET_MS), sharedSignal, undefined,
      { recognizeCarrier: false, beforeQuery }), deadline, signal);
}

async function refreshHomeAccountShipment(
  state: AppState, source: BindingSource, flowId: string, checkpoint: RefreshCheckpoint,
  task: ManualRefreshTask, deadlineAtMs: number | undefined, signal: AbortSignal,
  query: typeof refreshAccountParcel,
): Promise<RefreshSummary> {
  const original = state.shipments.find(item => item.identity.id === task.id);
  const summary = (next: AppState, attempted = 0, succeeded = 0, failed = 0) =>
    ({ state: next, attempted, succeeded, failed, promotedPendingShipmentIds: [] });
  if (!original || !canQueryHomeAccount(original, Boolean(task.cainiaoListUpdated)) ||
      deadlineExpired(deadlineAtMs)) return summary(state);
  const startedAt = Date.now();
  writeDiagnostic("refresh.stage.started", { flowId, source, stage: "account_detail",
    budgetMs: ACCOUNT_DETAIL_BUDGET_MS, ...shipmentDiagnosticDetails(original, "v5_query") });
  const stageCancelled = openStageCancellationEnd(flowId, signal, () => writeDiagnostic("refresh.stage.failed", {
    flowId, source, stage: "account_detail", ...shipmentDiagnosticDetails(original, "v5_query"),
    durationMs: Date.now() - startedAt, errorCategory: "cancelled" }, "warning"));
  let parcel: AccountParcelDto | null;
  try {
    parcel = await requestAccountDetail(original, state, query, deadlineAtMs, signal);
    assertRefreshSignal(signal);
    stageCancelled.close();
  } catch (error) {
    rethrowStageCancellation(signal, stageCancelled.end);
    stageCancelled.close();
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "account_detail", ...shipmentDiagnosticDetails(original, "v5_query"),
      durationMs: Date.now() - startedAt, ...diagnosticErrorDetails(error) }, "warning");
    return summary(loadState(), 1, 0, 1);
  }
  const incoming = parcel ? parcelToShipment(parcel, bindingsForSource(state, source).map(b => b.phone), Date.now()) : null;
  if (!incoming || !parcel) {
    writeDiagnostic("refresh.stage.failed", { flowId, source, stage: "account_detail", ...shipmentDiagnosticDetails(original, "v5_query"),
      result: "empty", durationMs: Date.now() - startedAt }, "warning");
    return summary(loadState(), 1, 0, 1);
  }
  const routes: DeferredRouteMutations = new Map();
  let merged = applyTargetedAccountShipment(original, asAccountDetailObservation(original, incoming), Date.now(),
    { existingCainiaoRouteAvailable: Boolean(storedCainiaoRoute(original)) });
  merged = deferIncomingRoute(merged, incoming, parcel.routeUrl, Date.now(), routes);
  const next = checkpoint({ ...state, shipments: sortShipments(replaceById(state.shipments,
    withDetailSelection(merged, Date.now()))) }, routes, "account_detail");
  writeDiagnostic("refresh.stage.succeeded", { flowId, source, stage: "account_detail", ...shipmentDiagnosticDetails(
    next.shipments.find(item => item.identity.id === original.identity.id) || merged, "v5_query", incoming.timeline),
    durationMs: Date.now() - startedAt });
  return summary(next, 1, 1);
}

/**
 * The rows whose detail page opens with their own per-waybill account query (detailEntryQueryReason), without
 * its freeze and complete-cache gates: the status alignment run asks that query first (用户 2026-10-02).
 */
function statusAlignmentEntryQuerySupported(shipment: Shipment): boolean {
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

async function runDetailEntryQuery(
  base: AppState,
  original: Shipment,
  lease: TargetRefreshLease,
  query: typeof refreshAccountParcel,
  flowId: string,
  /**
   * 用户 2026-10-02 弹窗「同取件码强刷」：状态对齐强刷先问这一行自己的按件详情（v5_query），签收冻结与完整缓存
   * 不挡这一次；资格（自动件、有账号记录、京东 / 菜鸟来源）照旧由调用方判。
   */
  statusAlignment = false,
  beforeQuery?: () => void,
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
    const parcel = await requestAccountDetail(original, base, query, detailDeadline, lease.signal, reserveBeforeQuery);
    assertRefreshSignal(lease.signal);
    if (!lease.isCurrent()) throw new OperationTimeoutError();
    const incoming = parcel ? parcelToShipment(parcel, bindingsForSource(base, source).map(b => b.phone), Date.now()) : null;
    recordRefreshProviderResult({ key, provider: "account_detail", identityFingerprint: providerFingerprint,
      result: incoming ? "success" : "no_result" });
    if (!incoming || !parcel) {
      const state = loadState();
      const shipment = state.shipments.find(item => item.identity.id === original.identity.id);
      if (!shipment) throw new Error("该快递已从列表中移除");
      return { state, shipment, refreshed: false, querySucceeded: false, detailEntry: observation };
    }
    let merged = applyTargetedAccountShipment(original, asAccountDetailObservation(original, incoming), Date.now(),
      { existingCainiaoRouteAvailable: Boolean(storedCainiaoRoute(original)) });
    merged = deferIncomingRoute(merged, incoming, parcel.routeUrl, Date.now(), routes);
    const commit = commitTargetShipmentRefresh(base, withDetailSelection(merged, Date.now()), Date.now(), lease);
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

type ShipmentRefreshRuntimeOverrides = Partial<{
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
async function runShipmentRefreshById(
  shipmentId: string,
  lease: TargetRefreshLease,
  options: ShipmentRefreshOptions = {},
  runtimeOverrides: ShipmentRefreshRuntimeOverrides = {},
): Promise<ShipmentRefreshResult> {
  const interrupted: { end?: () => void } = {};
  try {
    return await runShipmentRefreshFlow(shipmentId, lease, options, runtimeOverrides, interrupted);
  } catch (error) {
    if (lease.signal?.aborted) interrupted.end?.();
    throw error;
  }
}

async function runShipmentRefreshFlow(
  shipmentId: string,
  lease: TargetRefreshLease,
  options: ShipmentRefreshOptions,
  runtimeOverrides: ShipmentRefreshRuntimeOverrides,
  interrupted: { end?: () => void },
): Promise<ShipmentRefreshResult> {
  const runtime = { refreshAccountParcel, queryManualForSource, refreshWebTimeline,
    refreshCainiaoH5, projectAccountOrderWithCarrier, ...runtimeOverrides };
  const startedAt = Date.now();
  const flowId = createDiagnosticFlowId("detail");
  let base = loadState(startedAt);
  let original = base.shipments.find(
    (item) => item.identity.id === shipmentId,
  );
  if (!original) throw new Error("该快递已从列表中移除");
  // The frozen-join repair must keep its identity fence through the scheduled flow startup.
  if (lease.expectedFingerprint != null && detailRequestFingerprint(original, base) !== lease.expectedFingerprint) {
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
  // Old cached feed text can resolve identity without waiting for another provider response.
  // T23 (user 2026-09-26, 其余裁决 28): its waybill — or a union-page waybill held for its carrier — is recognised
  // first and projected only with a matched carrier; otherwise the order stays as it is and no page is opened here.
  if (unprojectedAccountOrder(original)) {
    const reference = accountParcelWithProjectionReference(original, null, "");
    const held = original.identity.pendingProjection;
    const recognitionDeadlineAtMs = accountChildDeadline(deadlineAtMs, ACCOUNT_DETAIL_BUDGET_MS);
    let parcel = reference;
    if (reference && accountOrderTextWaybill(reference)) {
      parcel = await withRecognizedAccountOrderTextWaybill(reference,
        { deadlineAtMs: recognitionDeadlineAtMs, signal, budget: operationRecognitionBudget(lease) });
    } else if (reference && held?.waybill && heldCarrierSettleable(held.waybill, Date.now())) {
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
    if (incoming && normalizedProjectedWaybill(incoming.identity)) {
      const local = applyTargetedAccountShipment(original, incoming, Date.now());
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
  // 才冻结」，弹窗「iOS 右滑签收一起改」）在来源三态到签收或点击满 72 小时后硬冻结，之前与普通行一样刷新。
  // 承运商识别不在冻结之列（协调方规格「身份不是刷新」）：普通行照旧先识别承运商。用户 2026-10-03「硬冻结也照常识别承运商」
  // （优化 4）：右滑签收硬冻结的行与三态冻结的行一样先识别承运商（只认身份，不刷轨迹、不发通知），再在下面停下。
  // 还没投影出运单号的京东订单从不冻结（用户 2026-10-02 弹窗「不冻结，取到号再判」，signedTripleReached）。
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
    original = base.shipments.find(s => s.identity.id === shipmentId);
    if (!original) throw new Error("该快递已从列表中移除");
  };
  if (original.identity.manuallyAdded && carrierUnmatched(original)) await commitRecognizedCarrier();
  if (trigger === "detail_open") {
    if (signedFrozen) return skipSignedFrozen(original, base);
    const entry = await runDetailEntryQuery(base, original, lease, runtime.refreshAccountParcel, flowId);
    // Entry query text may resolve the identity. Otherwise the original projection path runs
    // independently of history completeness, under the same lease and page cooldown.
    if (unprojectedAccountOrder(entry.shipment)) {
      const projection = await runShipmentRefreshById(shipmentId, lease, {
        ...options, trigger: "identity_projection", forceAccountOrderProjection: true,
        forceManualRefresh: false, includeKdniaoFallback: false,
      }, runtimeOverrides);
      return { ...projection, refreshed: identityApplied || entry.refreshed || projection.refreshed,
        detailEntry: entry.detailEntry };
    }
    return { ...entry, refreshed: identityApplied || entry.refreshed };
  }
  if (aligning && !signedFrozen && statusAlignmentEntryQuerySupported(original)) {
    // An explicit pull follows the detail page's own entry query; the alignment run asks it first, past the freeze.
    const entry = await runDetailEntryQuery(base, original, lease, runtime.refreshAccountParcel, flowId, true, beforeQuery);
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
    statusSemantic: selectShipmentTimeline(original).semantic,
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
        ? shouldScheduleManualRefresh(original, Date.now())
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
            field: ProjectionAttemptField;
            retry: Shipment["identity"]["orderProjectionRetry"];
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
              (reopenForTimeline || !parcel.textIdentity?.waybill) &&
              !(
                // 方案 A (2026-09-25): detail entry leaves a confirmed empty page closed; an explicit
                // pull is the user's own request and only keeps the ordinary rest.
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
                    )
              )
            ) {
              const gatingRetry = reopenForTimeline
                ? freshOwner?.identity.jingDongH5Retry
                : freshOwner?.identity.orderProjectionRetry;
              writeDiagnostic("order.projection.skipped", {
                flowId,
                source,
                stage: "detail_webview",
                ownerFingerprint,
                result: activeAccountOrderProjectionAttempt(
                    gatingRetry,
                    routeHash,
                    Date.now(),
                  )
                  ? "active_attempt"
                  : trigger === "identity_projection" && !reopenForTimeline &&
                      accountOrderPageConfirmedEmpty(gatingRetry, routeHash)
                    ? "confirmed_empty"
                  : gatingRetry?.riskControlAtMs
                    ? "risk_control_cooldown"
                    : "cooldown",
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
                    () => { unionPageSceneGate(); beforeQuery?.(); },
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
                    // 其余裁决 32: an exhausted recognition no longer holds the order at its order stage.
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
                    // T23（用户 2026-09-26，其余裁决 28）：运单号拿到了、承运商没对上——订单保持原样、不推。页面给的运单号
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
                    pageSkippedRestore = { field: attemptField, retry: freshOwner.identity[attemptField] };
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
      // A pull does not ask Online here (EXPRESS_THREE_CLIENT_PARITY ShunFeng row). 用户 2026-10-02 弹窗「四端都先问
      // Picker（推荐）」：状态对齐强刷里顺丰来源件先问 Online（Picker，v6_query refresh）——顺丰的列表头条归 Picker；
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
      if (refreshed.identity.manuallyAdded && explicitTimelineRefresh &&
          !pickerSupplementSucceeded && !motoResult && !h5Result && !kdniaoResult &&
          !shipmentDetailComplete(refreshed) &&
          [h5Error, kdniaoError].some(needsManualPhoneTail)) {
        expressToast = "manualPhoneTailRequired";
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
            refreshed = applyManualShipment(
              refreshed,
              outcome.shipment,
              Date.now(),
            );
            changed = true;
          }
        } catch (error) {
          rethrowRefreshCancellation(error, signal);
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
  };
}

/**
 * The status-alignment forced refreshes of this runtime, by row, while they hold the row's `detail:<id>` lease
 * (services/status-alignment.ts). 用户 2026-10-02 弹窗「下拉等那次强刷跑完再显示」: a pull on that row's detail page
 * meeting one does not start a second refresh and does not return at once (which read as a failed pull when nothing
 * was cached); it waits for the forced refresh, within the pull's own deadline, and shows its outcome as its own.
 */
const statusAlignmentRefreshes = new Map<string, Promise<ShipmentRefreshResult>>();

async function pullAfterStatusAlignment(
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
    return runTargetedShipmentRefresh(shipmentId, { ...options, deadlineAtMs }, runtimeOverrides, expectedFingerprint);
  }
  return outcome
    ? { ...outcome, state, shipment, detailEntry: options.detailEntry }
    : { state, shipment, refreshed: false, querySucceeded: false };
}

function runTargetedShipmentRefresh(
  shipmentId: string,
  options: ShipmentRefreshOptions,
  runtimeOverrides: ShipmentRefreshRuntimeOverrides = {},
  expectedFingerprint?: string,
): Promise<ShipmentRefreshResult> {
  const durableLease = acquireRenewingDurableRefreshLease(
    `detail:${shipmentId}`,
    35_000,
  );
  if (!durableLease) {
    const forced = options.trigger === "detail_pull" ? statusAlignmentRefreshes.get(shipmentId) : undefined;
    if (forced) return pullAfterStatusAlignment(shipmentId, forced, options, runtimeOverrides);
    const state = loadState();
    const shipment = state.shipments.find(
      (item) => item.identity.id === shipmentId,
    );
    return shipment
      ? Promise.resolve({ shipment, state, refreshed: false, querySucceeded: false })
      : Promise.reject(new Error("该快递已从列表中移除"));
  }
  let active = true;
  const lease: TargetRefreshLease = {
    deadlineAtMs: options.deadlineAtMs,
    expectedFingerprint,
    isCurrent: () =>
      active && durableLease.isCurrent() && !options.signal?.aborted,
    signal: options.signal,
  };
  const run = Promise.resolve().then(() =>
    runShipmentRefreshById(shipmentId, lease, options, runtimeOverrides)
  ).finally(() => {
    active = false;
    durableLease.release();
  });
  if (options.trigger === "status_alignment") {
    statusAlignmentRefreshes.set(shipmentId, run);
    const settle = () => {
      if (statusAlignmentRefreshes.get(shipmentId) === run) statusAlignmentRefreshes.delete(shipmentId);
    };
    run.then(settle, settle);
  }
  return run;
}

async function runTargetedShipmentRefreshWithProjectionWait(
  shipmentId: string,
  options: ShipmentRefreshOptions,
): Promise<ShipmentRefreshResult> {
  if (options.forceAccountOrderProjection) {
    const completed = await waitForProjectionAttemptRelease(
      shipmentId,
      options.signal,
    );
    if (completed && !options.includeKdniaoFallback) return completed;
  }
  return runTargetedShipmentRefresh(shipmentId, options);
}

export function refreshShipmentById(
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
    Boolean(options.includeKdniaoFallback), Boolean(options.forceManualRefresh),
    Boolean(options.forceAccountOrderProjection), options.detailEntry]);
  return refreshCoordinator.runIndependentDetail(key, source, signal =>
    runTargetedShipmentRefreshWithProjectionWait(shipmentId, { ...options, deadlineAtMs, signal }),
    deadlineAtMs, options.signal);
}

/**
 * The commit functions of one `full:<source>` generation: every checkpoint rebases onto the latest
 * durable state and publishes deferred routes; projection commits additionally require the attempt
 * reservation to still be theirs. Shared by the list refresh and the Home stored-row pass.
 */
function fullRefreshCheckpoints(
  source: BindingSource,
  flowId: string,
  lease: FullRefreshLease,
  initial: AppState,
  notificationContext: RefreshNotificationContext,
): Readonly<{ checkpoint: RefreshCheckpoint; projectionCheckpoint: ProjectionCheckpoint }> {
  let checkpointBase = initial;

  const checkpoint: RefreshCheckpoint = (candidate, mutations, stage, base = checkpointBase) => {
    lease.assertCurrent();
    const commit = commitRefreshState(
      base,
      candidate,
      source,
      Date.now(),
      lease,
      notificationContext,
    );
    if (!commit.applied) {
      writeDiagnostic("refresh.commit.skipped", {
        flowId,
        source,
        stage,
        ...diagnosticState(commit.state),
        result: "late_ignored",
      }, "warning");
      lease.assertCurrent();
      throw new Error("刷新结果已过期");
    }
    let next = commit.state;
    lease.assertCurrent();
    try {
      next = publishDeferredRoutes(next, mutations, Date.now(), commit);
    } catch (error) {
      writeDiagnostic("refresh.route_publish_failed", {
        flowId,
        source,
        stage,
        ...diagnosticState(next),
        ...diagnosticErrorDetails(error),
      }, "warning");
    }
    lease.assertCurrent();
    checkpointBase = next;
    if (!stage.endsWith("_attempt") && !stage.endsWith("_release")) publishRefreshState(next);
    return next;
  };

  const projectionCheckpoint: ProjectionCheckpoint = (
    candidate,
    mutations,
    stage,
    guard,
  ) => {
    lease.assertCurrent();
    const commit = commitRefreshState(
      checkpointBase,
      candidate,
      source,
      Date.now(),
      {
        isCurrent: lease.isCurrent,
        acceptsState: (latest) => ownsProjectionAttempt(
          latest.shipments.find(
            (shipment) => shipment.identity.id === guard.ownerId,
          ),
          guard.routeHash,
          guard.attemptId,
          Date.now(),
        ),
      },
      notificationContext,
    );
    checkpointBase = commit.state;
    if (!commit.applied) return commit;
    let next = commit.state;
    lease.assertCurrent();
    try {
      next = publishDeferredRoutes(next, mutations, Date.now(), commit);
    } catch (error) {
      writeDiagnostic("refresh.route_publish_failed", {
        flowId,
        source,
        stage,
        ...diagnosticState(next),
        ...diagnosticErrorDetails(error),
      }, "warning");
    }
    lease.assertCurrent();
    checkpointBase = next;
    return { state: next, applied: true };
  };

  return { checkpoint, projectionCheckpoint };
}

type EnrichmentRuntime = Readonly<{
  refreshAccountParcel?: typeof refreshAccountParcel;
  queryManualForSource: typeof queryManualForSource;
}>;

async function refreshShipmentEnrichment(
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
  updatedCainiaoIds: ReadonlySet<string> = new Set(),
  /** The sync round's recognition wait (用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒). */
  recognitionBudget: CarrierRecognitionBudget = new CarrierRecognitionBudget(),
  backgroundStatusAlignment = false,
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
      accountSourceFollowup, updatedCainiaoIds, (frozen) => writeDiagnostic("refresh.stage.skipped", {
        flowId, source, stage: "account_detail", ...shipmentDiagnosticDetails(frozen, "v5_query"),
        result: "signed_frozen", skipReason: "signed_frozen" }), backgroundStatusAlignment),
    (task) => {
      const row = currentState.shipments.find((shipment) => shipment.identity.id === task.id);
      return row?.identity.manuallyAdded && !task.accountDetail ? [displayWaybill(row)] : [];
    },
  );
  type Job = ManualRefreshTask;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, {once: true});
  type JobResult = {job: Job; summary: RefreshSummary} | {job: Job; error: unknown};
  const active = new Map<Job, Promise<JobResult>>();
  let firstFailure: {error: unknown} | undefined;
  const run = async (job: Job): Promise<JobResult> => {
    let jobBase = currentState;
    const commit: RefreshCheckpoint = (candidate, mutations, stage) => {
      assertRefreshSignal(controller.signal);
      // Each task rebases from what it read, not another task's newer checkpoint.
      try {
        currentState = checkpoint(candidate, mutations, stage, jobBase);
      } catch (error) {
        firstFailure ??= {error};
        controller.abort();
        throw error;
      }
      jobBase = currentState;
      return currentState;
    };
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
        currentState, source, flowId, commit, job, deadlineAtMs, controller.signal,
        runtimeOverrides.queryManualForSource || queryManualForSource,
      ) : job.accountDetail ? await refreshHomeAccountShipment(
        currentState, source, flowId, commit, job, deadlineAtMs, controller.signal,
        runtimeOverrides.refreshAccountParcel || refreshAccountParcel,
      ) : await refreshOnlineShipment(
        currentState, source, flowId, commit, job, deadlineAtMs, forceManualRefresh,
        controller.signal, runtimeOverrides.queryManualForSource || queryManualForSource,
        recognitionBudget,
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
          await refreshCoordinator.waitForForeground(source, deadlineAtMs ?? deadlineAfter(MANUAL_QUERY_BUDGET_MS), controller.signal);
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
  const updatedCainiaoIds = new Set<string>();
  let summary: RefreshSummary | undefined;
  const promotedPendingShipmentIds: string[] = [];

  const { checkpoint, projectionCheckpoint } = fullRefreshCheckpoints(
    source, flowId, lease, initial, notificationContext,
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
          updatedCainiaoIds.add(shipment.identity.id);
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

    const enrichmentDeadlineAtMs = deadlineAtMs == null
      ? undefined
      : deadlineAtMs - FULL_REFRESH_FINALIZATION_RESERVE_MS;
    if (!accountListOnly && !deadlineExpired(enrichmentDeadlineAtMs)) {
      // 用户 2026-09-25 同意：刷新流程只在前台开京粉页；已过期限或租约的流程一页都不开，照旧失败收尾。
      const unionPageGate = () => {
        lease.assertCurrent();
        if (!projectionSceneActive()) throw new UnionPageSkipped("not_foreground");
      };
      const projection = await projectAccountOrders(
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
      currentState, source, flowId, checkpoint, enrichmentDeadlineAtMs,
      skipRefreshIds, forceManualRefresh, hostPolicy.accountOrderProjection, lease.signal,
      {}, accountSourceFollowup, updatedCainiaoIds, recognitionBudget, backgroundHostSafe,
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
  const pending = interactiveFullRequests.get(source);
  if (options.forceManualRefresh && pending) return pending;
  const request = startFullRefresh(source, options);
  if (!options.forceManualRefresh) return request;
  const tracked = request.finally(() => {
    if (interactiveFullRequests.get(source) === tracked) interactiveFullRequests.delete(source);
  });
  interactiveFullRequests.set(source, tracked);
  return tracked;
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
  } = {},
): Promise<RefreshSummary> {
  const source = requireScriptSource(
    sourceOverride || SCRIPT_BINDING_SOURCE,
  );
  // Every full-list entry shares account supplementation; host safety controls WebView and budgets.
  const accountSourceFollowup = !options.accountListOnly;
  const existing = refreshCoordinator.full(source);
  if (existing) return options.accountListOnly ||
    (accountSourceFollowup && !accountSourceFullRequests.has(existing)) ||
    (options.forceManualRefresh && !forcedManualFullRequests.has(existing))
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
    publishFullRefreshOutcome({ source, trigger, skipReason: "active_cross_runtime_refresh" });
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
  const coordinated = refreshCoordinator.runFull(
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
  if (accountSourceFollowup) accountSourceFullRequests.add(coordinated);
  if (options.forceManualRefresh) forcedManualFullRequests.add(coordinated);
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
    publishFullRefreshOutcome({ source, trigger });
  });
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
function fullRefreshPendingInProcess(source: BindingSource): boolean {
  return Boolean(refreshCoordinator.full(source) || interactiveFullRequests.has(source));
}

/**
 * The list is still being written: a full refresh or stored-row pass of this runtime, or another runtime holding
 * `full:<source>`. The status alignment check (services/status-alignment.ts, 用户 2026-10-02) waits for the list
 * data to settle before it compares a row's times.
 */
export function listRefreshInProgress(source: BindingSource = SCRIPT_BINDING_SOURCE): boolean {
  return fullRefreshPendingInProcess(source) || durableRefreshLeaseRemainingMs(`full:${source}`) > 0;
}

type StoredProjectionCandidate = Readonly<{ ownerId: string; parcel: AccountParcelDto }>;

/**
 * Stored unprojected JD orders the union page may open for now, in Home order. No network, no
 * lease, no log: an empty answer is the pass's whole cost.
 */
function storedAccountOrderProjectionCandidates(
  state: AppState,
  source: BindingSource,
  now: number,
  excludeOwnerIds: ReadonlySet<string>,
  includeCompleted: boolean,
): StoredProjectionCandidate[] {
  const boundPhones = bindingsForSource(state, source).map((binding) => binding.phone);
  if (!boundPhones.length) return [];
  const noDetailRefreshes = new Set<string>();
  return visibleShipments(state, now).flatMap((shipment) => {
    const ownerId = shipment.identity.id;
    if (
      shipment.identity.bindingSource !== source ||
      !unprojectedAccountOrder(shipment) ||
      excludeOwnerIds.has(ownerId)
    ) return [];
    // The same rebuild as the detail page's cached_order_projection: saved reference or feed text.
    const parcel = accountParcelWithProjectionReference(
      shipment,
      null,
      loadOrderProjectionReference(ownerId, source, now),
    );
    if (
      !parcel ||
      projectionOwnerId(parcel) !== ownerId ||
      !parcelToShipment(parcel, boundPhones, now)
    ) return [];
    const decision = accountOrderProjectionDecision(
      parcel, state.shipments, now, noDetailRefreshes, false, storedRowStructuredSemantic, includeCompleted,
    );
    return decision.due ? [{ ownerId, parcel }] : [];
  });
}

async function runStoredOrderProjection(
  source: BindingSource,
  flowId: string,
  durableLease: DurableRefreshLease,
  before: AppState,
  candidate: StoredProjectionCandidate,
  moreDue: boolean,
  includeCompleted: boolean,
): Promise<StoredOrderProjectionResult> {
  try {
    const summary = await refreshCoordinator.runFull(
      source,
      async (skipRefreshIds, lease) => {
        const notificationContext = {
          previousById: new Map(before.shipments.map((shipment) => [shipment.identity.id, shipment])),
          batchId: flowId,
        };
        const { checkpoint, projectionCheckpoint } = fullRefreshCheckpoints(
          source, flowId, lease, before, notificationContext,
        );
        const projection = await projectAccountOrders(
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
          new CarrierRecognitionBudget(),
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
    if (statePresentationFingerprint(summary.state) !== statePresentationFingerprint(before)) {
      requestWidgetReload();
    }
    return { result: "attempted", ownerId: candidate.ownerId, moreDue, state: summary.state };
  } catch (error) {
    writeDiagnostic("order.projection.failed", {
      flowId,
      source,
      stage: "webview",
      ownerFingerprint: projectionOwnerFingerprint(candidate.ownerId),
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
export async function projectStoredAccountOrders(
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
    if (fullRefreshPendingInProcess(source)) return { result: "busy", moreDue: false };
    const holderRemainingMs = durableRefreshLeaseRemainingMs(leaseKey);
    if (holderRemainingMs <= 0) {
      const now = Date.now();
      const before = loadState(now);
      const includeCompleted = options.onScreen?.() === true;
      const due = storedAccountOrderProjectionCandidates(
        before, source, now, excludeOwnerIds, includeCompleted);
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
          source, flowId, durableLease, before, due[0], due.length > 1, includeCompleted,
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

export { runShipmentRefreshById as runShipmentRefreshForTesting };
/** The lease-holding detail refresh (refreshShipmentById without its in-process coordinator), for tests. */
export { runTargetedShipmentRefresh as runTargetedShipmentRefreshForTesting };
export { withH5Controller as runH5CaptureForTesting };

export { refreshShipmentEnrichment as runShipmentEnrichmentForTesting };

export { synchronizeAccountList as synchronizeAccountListForTesting };

export { publishDeferredRoutes as publishDeferredRoutesForTesting };
