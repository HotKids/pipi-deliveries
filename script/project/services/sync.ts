import { normalizeTimelineSlot, TIMELINE_SLOT } from "./timeline-slot";
import type {
  AppState,
  BindingSource,
  PendingManualQuery,
  RefreshSummary,
  Shipment,
} from "../models";
import {
  accountParcelWithExistingProjection,
  fetchAccountParcels,
  parcelToShipment,
  refreshAccountParcel,
  verifyAccountBinding,
} from "./account-sync";
import type { AccountParcelDto } from "./account-parser";
import {
  queryManualForSource,
  refreshPendingCarrierPresentation,
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
  pruneOrderProjectionReferences,
  pruneShipmentRoutes,
  removeOrderProjectionReferences,
  removeShipmentRoutes,
  saveOrderProjectionReferences,
  saveAccountAppRoutes,
  saveShipmentRoute,
  type ShipmentRouteMutation,
  type ShipmentRoutePublication,
} from "./routes";
import {
  absorbAutomaticShipment,
  absorbHistoricalShipment,
  absorbManualShipment,
  activateCainiaoManualFallback,
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
  hasCachedKdniaoTimeline,
  hasCachedTimelineBeforeKdniao,
  hasPickerTimelineStart,
  hasSettledTimelineHistory,
  hasUsableShipmentDynamics,
  hasTimelineStartBeforeKdniao,
  isForeignManualPackage,
  isHistoricalAccountDuplicate,
  isJingDongSourceShipment,
  isShunFengSourceShipment,
  jingDongAutomaticH5TimelineAvailable,
  jingDongFeedReachedPickup,
  jingDongH5CaptureSufficient,
  jingDongTimelineSettled,
  manualTimelineOwnsShipment,
  needsAutomaticManualFallback,
  needsAutomaticListSupplement,
  needsDetailFallback,
  ownsManualRefreshLease,
  recordAutomaticOwnerRefresh,
  releaseManualRefreshLease,
  sameCanonicalWaybill,
  sameDisplayedWaybill,
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
  shipmentDetailComplete,
  shouldScheduleManualRefresh,
  unprojectedAccountOrder,
  usesManualSourceQuery,
  withDetailSelection,
} from "./shipment-policy";
import {
  peekStateRevision,
  addBinding,
  bindingsForSource,
  commitRefreshState,
  commitRoutePointers,
  commitTargetShipmentRefresh,
  loadState,
  privateHash,
  removeBinding,
  saveState,
} from "./storage";
import {
  normalizeWaybill,
  normalizedProjectedWaybill,
  containsTimelinePickupTrack,
  containsTimelineStartTrack,
  shipmentPresentationStatus,
  shouldRefreshShipment,
  isHiddenSignedShipment,
  sortShipments,
  timelineCapability,
  timedTracks,
} from "./status";
import {
  acquireDurableRefreshLease,
  recordNetworkRefreshSuccess,
  recordRefreshProviderResult,
  refreshProviderDue,
  type RefreshProviderResult,
} from "./refresh-runtime-state";
import { requestWidgetReload } from "./widgets";
import { refreshCarrierAuthorityIfNeeded } from "./carrier-authority";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import {
  assertWithinDeadline,
  deadlineAfter,
  deadlineExpired,
  OperationTimeoutError,
} from "./deadline";
import {
  ACCOUNT_DETAIL_BUDGET_MS,
  ACCOUNT_FOLLOWUP_CONCURRENCY,
  ACCOUNT_FOLLOWUP_RESERVE_MS,
  ACCOUNT_H5_BUDGET_MS,
  ACCOUNT_LIST_BUDGET_MS,
  ACCOUNT_ORDER_PROJECTION_BUDGET_MS,
  accountOrderReadyForProjection,
  accountOrderProjectionAttemptRemainingMs,
  activeAccountOrderProjectionAttempt,
  accountChildDeadline,
  oldestBatchIndices,
  rotatingBatchIndices,
  runAccountFollowupCandidates,
  projectionRiskControlled,
  shouldRetryAccountOrderProjection,
} from "./account-sync-policy";
import type { ExpressToastKey } from "./express-toast-copy";
import { accountParcelWithProjectionReference } from "./account-order-reference";
import { prepareManualPreview } from "./manual-preview";
import {
  createDiagnosticFlowId,
  diagnosticErrorDetails,
  diagnosticState,
  writeDiagnostic,
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
import { recognizeNonSyncCarrier } from "./carrier-recognition";
import {
  needsProjectedCarrierRepair,
  normalizeAccountParcelCarrier,
  repairProjectedShipmentCarrier,
} from "./account-carrier-normalization";
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
import { runManualDetailSourceContest } from "./manual-detail-refresh";
import {
  FULL_REFRESH_FINALIZATION_RESERVE_MS,
  fullRefreshHostPolicy,
} from "./refresh-mode";

const PENDING_RETRY_MS = EXPRESS_POLICY.pendingQueries.retryMs;
const DETAIL_MANUAL_REFRESH_BUDGET_MS = 15_000;
const MANUAL_QUERY_BUDGET_MS = 30_000;
const MANUAL_REFRESH_TASK_BUDGET_MS = 15_000;
const MANUAL_REFRESH_CONCURRENCY = 2;
const FULL_REFRESH_COORDINATION_WAIT_MS = 2_000;
const LOCAL_REFRESH_RESERVE_MS = 5_000;
const ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS = 22_000;
const ACCOUNT_ORDER_PROJECTION_STRATEGY = "jd-h5-v2";
const FORCED_PROJECTION_WAIT_SLICE_MS = 100;

function shipmentEffectiveFingerprint(shipment: Shipment): string {
  return JSON.stringify(shipment, (key, value) => {
    if (key === "updatedAtMs" || key === "successAtMs" || key === "observedAtMs") {
      return undefined;
    }
    return value;
  });
}

function statePresentationFingerprint(state: AppState): string {
  return JSON.stringify(
    state.shipments.map((shipment) => shipmentEffectiveFingerprint(shipment)),
  );
}

function refreshProviderResultForError(error: unknown): RefreshProviderResult {
  const details = diagnosticErrorDetails(error);
  const failure = String(details.failureCode || details.errorCategory || "");
  if (failure === "invalid_query" || failure === "phone_tail") {
    return "invalid_query";
  }
  if (failure === "upstream_rejected" || failure === "upstream") {
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
  /** Unified express toast (AGENTS §11) chosen by the refresh, rendered from the shared copy table. */
  expressToast?: ExpressToastKey;
};
type ShipmentRefreshOptions = {
  forceAccountOrderProjection?: boolean;
  forceManualRefresh?: boolean;
  includeKdniaoFallback?: boolean;
  trigger?:
    | "detail_open"
    | "detail_pull"
    | "manual_submit"
    | "identity_projection"
    | "missing_history";
  signal?: AbortSignal;
  deadlineAtMs?: number;
};
type TargetRefreshLease = Readonly<{
  deadlineAtMs?: number;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}>;
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
export type AccountFollowupRuntimeOverrides = Readonly<{
  refreshAccountParcel: typeof refreshAccountParcel;
}>;

function replaceById(
  shipments: readonly Shipment[],
  incoming: Shipment,
): Shipment[] {
  return [
    ...shipments.filter((item) => item.identity.id !== incoming.identity.id),
    incoming,
  ];
}

function retainedRouteIds(state: AppState): string[] {
  return [
    ...state.shipments
      .filter((shipment) => Boolean(shipment.route))
      .map((shipment) => shipment.identity.id),
    ...state.pendingQueries
      .filter((pending) => Boolean(pending.route))
      .map((pending) => pending.id),
  ];
}

function safelyPruneRoutes(state: AppState): void {
  try {
    pruneShipmentRoutes(retainedRouteIds(state));
  } catch {
    /* route cleanup is best-effort after the durable state transition */
  }
  try {
    pruneOrderProjectionReferences(
      state.shipments.flatMap((shipment) => {
        const source = shipment.identity.bindingSource;
        return shipment.identity.accountOrder &&
            source === SCRIPT_BINDING_SOURCE
          ? [{ ownerId: shipment.identity.id, source }]
          : [];
      }),
    );
  } catch {
    /* projection references remain encrypted and expire automatically */
  }
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
    safelyPruneRoutes(state);
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

function shipmentDiagnosticDetails(shipment: Shipment) {
  return {
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
    timelineProvider: diagnosticTimelineProvider(shipment.timeline.provider),
    effectiveTrackCount: timedTracks(shipment.timeline.tracks).length,
    statusSemantic: selectShipmentTimeline(shipment).semantic,
    structuredStatus: selectShipmentTimeline(shipment).structuredStatus === true,
  };
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

async function refreshWebTimeline(
  shipment: Shipment,
  deadlineAtMs?: number,
  observe?: (diagnostics: WebTimelineDiagnostics) => void,
  signal?: AbortSignal,
  onQueryAttempted?: (authorized: boolean) => void,
): Promise<Shipment | null> {
  // Stage eligibility belongs to callers; an order number is never a K100 waybill.
  if (unprojectedAccountOrder(shipment)) return null;
  const now = Date.now();
  const timeline = await scrapeWebTimeline({
    waybill: displayWaybill(shipment),
    courierCode: shipment.identity.courierCode,
    companyName: shipment.identity.companyName,
    phoneTail: shipment.identity.phoneTail,
    deadlineAtMs,
    signal,
    onQueryAttempted,
  }, observe);
  return timeline ? applySameSourceTimeline(shipment, timeline, now) : null;
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
): Promise<Shipment | null> {
  assertRefreshSignal(signal);
  if (!isCainiaoAutomaticShipment(shipment) || !routeUrl) return null;
  const now = Date.now();
  const timeline = await scrapeCainiaoH5Timeline({
    routeUrl,
    waybill: displayWaybill(shipment),
    courierCode: shipment.identity.courierCode,
    companyName: shipment.identity.companyName,
    deadlineAtMs,
    successAtMs: now,
    signal,
    onQueryAttempted,
  }, observe);
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

function projectionOwnerId(parcel: AccountParcelDto): string {
  return `${parcel.source}:account:${normalizeWaybill(parcel.ownerId)}`;
}

function projectionCooldownKey(parcel: AccountParcelDto): string {
  // 用户定 2026-09-04：冷却按**订单**记，与 Pipi 的 ExpressJdH5Cooldown（订单号 SHA-256）对齐。
  // 原来按 projectionUrl 哈希——京东 H5 链接带 token 与时间戳，feed 下一轮换个链接哈希就变了，
  // sameRoute 不成立，10 分钟与风控 60 分钟的记录当场作废：403 本该歇一小时，实际下一轮又开页。
  // 捕获策略变更仍然使冷却失效（策略串还在哈希里），这是它原本就该有的作用。
  // 持久化字段名仍是 `routeHash`，改名要迁移旧数据，不值得。
  return privateHash(
    `${ACCOUNT_ORDER_PROJECTION_STRATEGY}\0${projectionOwnerId(parcel)}`,
  );
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
): Promise<AccountParcelDto> {
  const projected = await projectAccountOrder(
    parcel,
    projectionDeadlineAtMs,
    observe,
    signal,
  );
  return normalizeAccountParcelCarrier(projected, {
    deadlineAtMs: recognitionDeadlineAtMs,
    signal,
  });
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
  const previousFailedAtMs = Number(previous?.failedAtMs);
  const previousRiskControlAtMs = Number(previous?.riskControlAtMs);
  return {
    ...shipment,
    identity: {
      ...shipment.identity,
      [field]: {
        routeHash,
        ...(previousRouteHash === routeHash &&
            Number.isFinite(previousFailedAtMs) &&
            previousFailedAtMs > 0
          ? { failedAtMs: previousFailedAtMs }
          : {}),
        ...(previousRouteHash === routeHash &&
            Number.isFinite(previousRiskControlAtMs) &&
            previousRiskControlAtMs > 0
          ? { riskControlAtMs: previousRiskControlAtMs }
          : {}),
        attemptId,
        attemptExpiresAtMs: Math.min(
          deadlineAtMs || now + ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS,
          now + ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS,
        ),
      },
    },
  };
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

/**
 * 本运行时里正在跑的投影尝试（按行 id）：等待方直接等这个 Promise，不用轮询。跨运行时（小组件 /
 * App 各自一个 JS 上下文）只能轮询，但轮询的是落盘 revision 这一个数字，变了才全量 loadState。
 * 原来每 100ms 全量 loadState（多副本读取 + 解析 + 迁移），最长 22 s ≈ 200 次（2026-09-06 静态审查）。
 */
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
    ...(projectionRiskControlled(diagnostics?.unionResponseStatuses)
      ? { riskControlAtMs: failedAtMs }
      : {}),
  };
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
    ...shipmentDiagnosticDetails(base),
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
): Shipment[] {
  const owner = shipments.find((shipment) => shipment.identity.id === ownerId);
  if (!owner || normalizedProjectedWaybill(owner.identity)) return [...shipments];
  return replaceById(shipments, {
    ...owner,
    identity: {
      ...owner.identity,
      orderProjectionRetry: projectionFailureRetry(routeHash, diagnostics, failedAtMs),
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
): Shipment[] {
  let shipments = [...shipmentsInput];
  const resolvedParcel = accountParcelWithExistingProjection(parcel, shipments);
  const incoming = parcelToShipment(resolvedParcel, boundPhones, now);
  if (!incoming) return shipments;
  const exactCurrent = shipments.find(
    (item) => item.identity.id === incoming.identity.id,
  );
  const projectionChangedCanonical = Boolean(
    exactCurrent &&
    normalizedProjectedWaybill(incoming.identity) &&
    displayWaybill(exactCurrent) !== displayWaybill(incoming),
  );
  const canonicalPeer = shipments.find(
    (item) =>
      !item.identity.manuallyAdded &&
      item.identity.id !== incoming.identity.id &&
      sameDisplayedWaybill(item, incoming),
  );
  const current = projectionChangedCanonical && canonicalPeer
    ? canonicalPeer
    : exactCurrent || canonicalPeer;
  let merged = applyAccountShipment(current, incoming, now);
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
  const duplicates = shipments.filter(
    (item) =>
      item.identity.id !== merged.identity.id &&
      (
        (item.identity.manuallyAdded && sameCanonicalWaybill(item, merged)) ||
        isHistoricalAccountDuplicate(item, merged) ||
        (
          projectionChangedCanonical &&
          item.identity.id === exactCurrent?.identity.id
        ) ||
        (
          !item.identity.manuallyAdded &&
          item.identity.bindingSource != null &&
          sameDisplayedWaybill(item, merged)
        )
      ),
  );
  for (const duplicate of duplicates) {
    if (duplicate.identity.manuallyAdded) {
      merged = absorbManualShipment(merged, duplicate, now);
    } else if (duplicate.identity.bindingSource != null) {
      merged = absorbAutomaticShipment(merged, duplicate, now);
    } else {
      merged = absorbHistoricalShipment(merged, duplicate, now);
      merged = deferPersistedRoute(merged, duplicate, now, routeMutations);
    }
    shipments = shipments.filter(
      (item) => item.identity.id !== duplicate.identity.id,
    );
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
    fetched = await fetchAccountParcels(
      source,
      state.bindings,
      listDeadlineAtMs,
      signal,
    );
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
        error.message.includes("Access Key 格式不正确")
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
    );
  }
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
        if (!parcel.accountOrder) return false;
    if (!parcel.projectionUrl && !parcel.textIdentity?.waybill) return false;
    const expectedId = projectionOwnerId(parcel);
    if (!accountOrderReadyForProjection(
      parcel.normalizedStatusSemantic || parcel.semantic,
    )) {
      writeDiagnostic("order.projection.skipped", {
        flowId,
        source,
        stage: "webview",
        ownerFingerprint: projectionOwnerFingerprint(expectedId),
        result: "before_pickup",
      });
      return false;
    }
    if (skipRefreshIds.has(expectedId)) return false;
    const existingOwner = shipments.find(
      (item) => item.identity.id === expectedId,
    );
    const selected = !normalizedProjectedWaybill(existingOwner?.identity);
    if (!selected) return false;
        const routeHash = projectionCooldownKey(parcel);
    // A waybill named by the feed text needs no WebView attempt, so no cooldown applies.
    if (parcel.textIdentity?.waybill) return true;
    // 只做文案回填的那一轮到此为止：后面每条路都要开 WebView。
    if (textBackfillOnly) return false;
    if (
      shouldRetryAccountOrderProjection(
        existingOwner?.identity.orderProjectionRetry,
        routeHash,
        now,
      )
    ) {
      return true;
    }
    writeDiagnostic("order.projection.skipped", {
      flowId,
      source,
      stage: "webview",
      ownerFingerprint: projectionOwnerFingerprint(expectedId),
      result: activeAccountOrderProjectionAttempt(
          existingOwner?.identity.orderProjectionRetry,
          routeHash,
          now,
        )
        ? "active_attempt"
        : "cooldown",
    });
    return false;
  });
  const candidatePositions = rotatingBatchIndices(
    candidates.length,
    candidates.length,
    now,
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
        if (
      !parcel.textIdentity?.waybill &&
      !shouldRetryAccountOrderProjection(
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
        result: activeAccountOrderProjectionAttempt(
            freshOwner?.identity.orderProjectionRetry,
            routeHash,
            Date.now(),
          )
          ? "active_attempt"
          : "cooldown",
      });
      continue;
    }
    if (freshOwner) shipments = replaceById(shipments, freshOwner);
    if (!freshOwner) continue;
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
    try {
      resolvedParcel = await projectAccountOrderWithCarrier(
        parcel,
        projectionDeadlineAtMs,
        deadlineAtMs,
        (diagnostics) => {
          projectionDiagnostics = diagnostics;
        },
        signal,
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
      rethrowRefreshCancellation(error, signal);
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

    assertRefreshSignal(signal);
    const ownershipState = loadState();
    const ownershipOwner = ownershipState.shipments.find(
      (shipment) => shipment.identity.id === expectedId,
    );
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
    if (extracted) {
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
    if (projectionRetained) {
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

function accountFollowupShipments(
  state: AppState, source: BindingSource, now: number,
  skipRefreshIds: ReadonlySet<string>, accountFollowupDeadlineAtMs?: number,
): Shipment[] {
  return state.shipments
    .filter((shipment) =>
      shipment.identity.bindingSource === source &&
      !shipment.identity.manuallyAdded &&
      // 用户定 2026-09-04：京东也要走按件 feed 详情——「详情页先拉一遍对应接口」对京东同样成立。
      // 原来这里把京东整个排除，于是京东行永远拿不到 feed 的按件详情，只能靠联合页。
      Boolean(shipment.accountRecord) &&
      !skipRefreshIds.has(shipment.identity.id) &&
      !hasSettledTimelineHistory(shipment, now) &&
      shouldRefreshShipment(shipment, now) &&
      (
        deadlineExpired(accountFollowupDeadlineAtMs) ||
        refreshProviderDue(
          `${source}:${shipment.identity.id}`,
          "account_detail",
          [
            displayWaybill(shipment),
            shipment.identity.courierCode,
            shipment.identity.phoneTail,
          ].join(":"),
          now,
        )
      )
    );
}

async function refreshAccountFollowups(
  state: AppState,
  source: BindingSource,
  now: number,
  flowId: string,
  checkpoint: RefreshCheckpoint,
  deadlineAtMs?: number,
  skipRefreshIds: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
  runtimeOverrides: Partial<AccountFollowupRuntimeOverrides> = {},
  shipmentId?: string,
): Promise<{
  state: AppState;
  attempted: number;
  succeeded: number;
  failed: number;
}> {
  assertRefreshSignal(signal);
  const followupRuntime: AccountFollowupRuntimeOverrides = {
    refreshAccountParcel,
    ...runtimeOverrides,
  };
  let currentState = state;
  const sourceBindings = bindingsForSource(currentState, source);
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let shipments = [...currentState.shipments];

  const accountFollowupDeadlineAtMs = deadlineAtMs == null
    ? undefined
    : deadlineAtMs - LOCAL_REFRESH_RESERVE_MS;
  const accountFollowupCandidates = accountFollowupShipments(
    currentState, source, now, skipRefreshIds, accountFollowupDeadlineAtMs,
  ).filter(shipment => shipmentId == null || shipment.identity.id === shipmentId);
  type AccountDetailAttempt =
    | Readonly<{
        scheduled: Shipment;
        startedAtMs: number;
        completedAtMs: number;
        outcome: "result";
        parcel: AccountParcelDto | null;
      }>
    | Readonly<{
        scheduled: Shipment;
        startedAtMs: number;
        completedAtMs: number;
        outcome: "failed";
        error: unknown;
      }>
    | Readonly<{
        scheduled: Shipment;
        startedAtMs: number;
        completedAtMs: number;
        outcome: "deadline_exhausted";
      }>;
  for (
    let waveStart = 0;
    waveStart < accountFollowupCandidates.length;
    waveStart += ACCOUNT_FOLLOWUP_CONCURRENCY
  ) {
    const wave = accountFollowupCandidates.slice(
      waveStart,
      waveStart + ACCOUNT_FOLLOWUP_CONCURRENCY,
    );
    const detailAttempts = await runAccountFollowupCandidates(
      wave,
      async (scheduled): Promise<AccountDetailAttempt> => {
        const startedAtMs = Date.now();
        if (deadlineExpired(accountFollowupDeadlineAtMs)) {
          return {
            scheduled,
            startedAtMs,
            completedAtMs: Date.now(),
            outcome: "deadline_exhausted",
          };
        }
        writeDiagnostic("refresh.stage.started", {
          flowId,
          source,
          stage: "account_detail",
          // 打真正给这一级的额度（accountChildDeadline 取的是两者的较小值），不是父窗口的
          // 剩余时间——原来打 103901 这种数，看日志的人会以为一票占了整个 widget 预算。
          budgetMs: Math.min(
            stageBudgetMs(
              accountFollowupDeadlineAtMs,
              startedAtMs,
              ACCOUNT_DETAIL_BUDGET_MS,
            ),
            ACCOUNT_DETAIL_BUDGET_MS,
          ),
          selected: true,
          ...cainiaoRouteDiagnosticDetails(
            scheduled,
            storedCainiaoRoute(scheduled, now),
          ),
        });
        try {
          assertRefreshSignal(signal);
          const parcel = await followupRuntime.refreshAccountParcel(
            scheduled,
            accountChildDeadline(
              accountFollowupDeadlineAtMs,
              ACCOUNT_DETAIL_BUDGET_MS,
            ),
            signal,
          );
          assertRefreshSignal(signal);
          return {
            scheduled,
            startedAtMs,
            completedAtMs: Date.now(),
            outcome: "result",
            parcel,
          };
        } catch (error) {
          rethrowRefreshCancellation(error, signal);
          return {
            scheduled,
            startedAtMs,
            completedAtMs: Date.now(),
            outcome: "failed",
            error,
          };
        }
      },
      ACCOUNT_FOLLOWUP_CONCURRENCY,
    );
    const waveMutations: DeferredRouteMutations = new Map();
    let waveChanged = false;
    for (const detailAttempt of detailAttempts) {
      assertRefreshSignal(signal);
      const scheduled = detailAttempt.scheduled;
      const shipmentId = scheduled.identity.id;
      const scheduleKey = `${source}:${shipmentId}`;
      const identityFingerprint = [
        displayWaybill(scheduled),
        scheduled.identity.courierCode,
        scheduled.identity.phoneTail,
      ].join(":");
      const index = shipments.findIndex(
        (shipment) => shipment.identity.id === shipmentId,
      );
      if (index < 0) continue;
      let current = shipments[index];
      let cainiaoRouteUrl = storedCainiaoRoute(current, now);
      if (detailAttempt.outcome === "deadline_exhausted") {
        writeDiagnostic("refresh.stage.skipped", {
          flowId,
          source,
          stage: "account_detail",
          selected: true,
          skipReason: "deadline_exhausted",
          ...shipmentDiagnosticDetails(current),
        });
        continue;
      }
      attempted++;
      const detailDurationMs = Math.max(
        0,
        detailAttempt.completedAtMs - detailAttempt.startedAtMs,
      );
      let detailIncoming: Shipment | null = null;
      const refreshedParcel = detailAttempt.outcome === "result"
        ? detailAttempt.parcel
        : null;
      const detailMutations: DeferredRouteMutations = new Map();
      if (detailAttempt.outcome === "failed") {
        failed++;
        recordRefreshProviderResult({
          key: scheduleKey,
          provider: "account_detail",
          identityFingerprint,
          result: refreshProviderResultForError(detailAttempt.error),
        });
        writeDiagnostic("refresh.stage.failed", {
          flowId,
          source,
          stage: "account_detail",
          durationMs: detailDurationMs,
          ...shipmentDiagnosticDetails(current),
          ...diagnosticErrorDetails(detailAttempt.error),
        }, "warning");
        continue;
      }
      if (refreshedParcel) {
        const incoming = parcelToShipment(
          refreshedParcel,
          sourceBindings.map((binding) => binding.phone),
          now,
        );
        if (incoming) {
          detailIncoming = applyTargetedAccountShipment(
            current,
            asAccountDetailObservation(current, incoming),
            now,
            { existingCainiaoRouteAvailable: Boolean(cainiaoRouteUrl) },
          );
          if (incoming.route?.kind === "cainiao" && refreshedParcel.routeUrl) {
            cainiaoRouteUrl = refreshedParcel.routeUrl;
          }
          detailIncoming = deferIncomingRoute(
            detailIncoming,
            incoming,
            refreshedParcel.routeUrl,
            now,
            detailMutations,
          );
        }
      }
      recordRefreshProviderResult({
        key: scheduleKey,
        provider: "account_detail",
        identityFingerprint,
        result: detailIncoming ? "success" : "no_result",
      });
      if (detailIncoming) {
        shipments[index] = detailIncoming;
        for (const [key, mutation] of detailMutations) {
          waveMutations.set(key, mutation);
        }
        waveChanged = true;
        current = detailIncoming;
        succeeded++;
        writeDiagnostic("refresh.stage.succeeded", {
          flowId,
          source,
          stage: "account_detail",
          durationMs: detailDurationMs,
          ...shipmentDiagnosticDetails(current),
        });
      } else {
        failed++;
        writeDiagnostic("refresh.stage.failed", {
          flowId,
          source,
          stage: "account_detail",
          durationMs: detailDurationMs,
          result: "no_result",
          ...shipmentDiagnosticDetails(current),
        }, "warning");
      }
    }
    if (waveChanged) {
      currentState = checkpoint(
        { ...currentState, shipments: sortShipments(shipments) },
        waveMutations,
        "account_detail",
      );
      shipments = [...currentState.shipments];
    }
  }

  assertRefreshSignal(signal);
  return {
    state: currentState,
    attempted,
    succeeded,
    failed,
  };
}

async function queryPendingManualRound(
  pending: PendingManualQuery,
  source: BindingSource,
  bindings: readonly AppState["bindings"][number][],
  deadlineAtMs: number,
  signal: AbortSignal | undefined,
  flowId: string,
): Promise<ManualQueryOutcome> {
  const picker = await queryManualForSource({
    source,
    bindings,
    waybill: pending.waybill,
    phoneTail: pending.phoneTail,
    rawCourierCode: pending.rawCourierCode,
    courierCode: pending.courierCode,
    companyName: pending.companyName,
    deadlineAtMs,
    signal,
    pickerOnly: true,
    includeKdniaoFallback: false,
    diagnosticFlowId: flowId,
    diagnosticStage: "pending_picker",
  });
  assertRefreshSignal(signal);
  const refreshedPending: PendingManualQuery = {
    ...pending,
    courierCode:
      picker.shipment?.identity.courierCode ||
      picker.pending?.courierCode ||
      pending.courierCode,
    rawCourierCode:
      picker.shipment?.identity.rawCourierCode ||
      picker.pending?.rawCourierCode ||
      pending.rawCourierCode,
    companyName:
      picker.shipment?.identity.companyName ||
      picker.pending?.companyName ||
      pending.companyName,
    route: picker.shipment?.route || picker.pending?.route || pending.route || null,
  };
  const seed = picker.shipment
    ? applyManualShipment(undefined, picker.shipment, Date.now())
    : pendingManualPreviewShipment(refreshedPending);
  if (hasTimelineStartBeforeKdniao(seed)) {
    return { shipment: seed, pending: null, routeUrl: picker.routeUrl };
  }
  const manualQueryInput = {
    source,
    bindings,
    waybill: refreshedPending.waybill,
    phoneTail: refreshedPending.phoneTail,
    rawCourierCode: refreshedPending.rawCourierCode,
    courierCode: refreshedPending.courierCode,
    companyName: refreshedPending.companyName,
    deadlineAtMs,
    signal,
    currentShipment: seed,
    includeKdniaoFallback: false,
    diagnosticFlowId: flowId,
  } as const;
  const contest = await runManualDetailSourceContest({
    queryMoto: async () => {
      const outcome = await queryManualForSource({
        ...manualQueryInput,
        motoOnly: true,
        diagnosticStage: "pending_moto",
      });
      return outcome.shipment;
    },
    queryKuaidi100: () => refreshWebTimeline(
      seed, deadlineAtMs, undefined, signal),
    queryKdniao: async () => {
      const outcome = await queryManualForSource({
        ...manualQueryInput,
        fallbackOnly: true,
        includeKdniaoFallback: true,
        diagnosticStage: "pending_kdniao",
      });
      return outcome.shipment;
    },
    hasAccumulatedTimelineStart: (primary) =>
      hasTimelineStartBeforeKdniao(
        applyManualRoundPackages(seed, primary, Date.now()),
      ),
  });
  assertRefreshSignal(signal);
  const accumulated = applyManualRoundPackages(seed, [
    contest.moto.shipment,
    contest.kuaidi100.shipment,
    contest.kdniao.shipment,
  ], Date.now());
  const hasTimedResult = (accumulated.manualTimelines || []).some(
    (timeline) => timedTracks(timeline.tracks).length > 0,
  );
  return hasTimedResult
    ? { shipment: accumulated, pending: null, routeUrl: picker.routeUrl }
    : {
        shipment: null,
        pending: refreshedPending,
        routeUrl: picker.routeUrl,
      };
}

type ManualRefreshTask =
    | { kind: "shipment"; id: string; lastAttemptAtMs: number }
    | { kind: "pending"; id: string; lastAttemptAtMs: number };
function manualRefreshTasks(
  state: AppState, source: BindingSource, now: number,
  skipRefreshIds: ReadonlySet<string>, forceManualRefresh: boolean, webViewEnrichment: boolean,
): ManualRefreshTask[] {
  const tasks: ManualRefreshTask[] = [
    ...state.shipments
      .filter((current) => {
        const semantic = shipmentPresentationStatus(current).semantic;
        return current.identity.bindingSource === source &&
          !skipRefreshIds.has(current.identity.id) &&
          semantic !== "COMPLETED" && semantic !== "CANCELLED" &&
          !unprojectedAccountOrder(current) &&
          current.timeline.provider !== "demo" &&
          shouldScheduleManualRefresh(current, now, forceManualRefresh);
      })
      .map((current) => ({
        kind: "shipment" as const,
        id: current.identity.id,
        lastAttemptAtMs: Number(current.manualRefreshAttemptAtMs) || 0,
      })),
    ...state.pendingQueries
      .filter((pending) =>
        webViewEnrichment &&
        pending.source === source &&
        (
          pending.awaitingRoundCompletion === true ||
          now - pending.lastAttemptAtMs >= PENDING_RETRY_MS
        )
      )
      .map((pending) => ({
        kind: "pending" as const,
        id: pending.id,
        lastAttemptAtMs: Number(pending.lastAttemptAtMs) || 0,
      })),
  ];

  return oldestBatchIndices(
    tasks.map((task) => task.lastAttemptAtMs),
    tasks.length,
    state.revision,
  )
    .map((position) => tasks[position]);
}

async function refreshManualAndPending(
  state: AppState,
  source: BindingSource,
  now: number,
  flowId: string,
  checkpoint: RefreshCheckpoint,
  deadlineAtMs?: number,
  skipRefreshIds: ReadonlySet<string> = new Set(),
  forceManualRefresh = false,
  webViewEnrichment = true,
  signal?: AbortSignal,
  runtimeOverrides: Partial<EnrichmentRuntime> = {},
  selectedTask?: ManualRefreshTask,
): Promise<{
  state: AppState;
  attempted: number;
  succeeded: number;
  failed: number;
  promotedPendingShipmentIds: readonly string[];
}> {
  let currentState = state;
  let shipments = [...currentState.shipments];
  let pendingQueries = [...currentState.pendingQueries];
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const promotedPendingShipmentIds: string[] = [];
  const bindings = bindingsForSource(state, source);
  const orderedTasks = manualRefreshTasks(
    currentState, source, now, skipRefreshIds, forceManualRefresh, webViewEnrichment,
  ).filter(task => selectedTask == null ||
    (task.kind === selectedTask.kind && task.id === selectedTask.id));
  const manualAttemptIds = new Map<string, string>();

  type ManualTaskAttempt = Readonly<{
    task: (typeof orderedTasks)[number];
    startedAtMs: number;
    deadlineAtMs: number;
    outcome: "result" | "failed" | "deadline_exhausted";
    result?: Awaited<ReturnType<typeof queryManualForSource>> | null;
    pending?: PendingManualQuery;
    error?: unknown;
  }>;
  const releaseShipmentAttempt = (
    taskId: string,
    attemptId: string,
    stage: string,
  ) => {
    for (let retry = 0; retry < 2; retry++) {
      const index = shipments.findIndex(
        (shipment) => shipment.identity.id === taskId,
      );
      if (index < 0 || !ownsManualRefreshLease(shipments[index], attemptId)) {
        return;
      }
      shipments[index] = releaseManualRefreshLease(
        shipments[index],
        attemptId,
      );
      currentState = checkpoint(
        { ...currentState, shipments: sortShipments(shipments) },
        new Map(),
        `${stage}_release`,
      );
      shipments = [...currentState.shipments];
      pendingQueries = [...currentState.pendingQueries];
    }
  };

  for (
    let waveStart = 0;
    waveStart < orderedTasks.length;
    waveStart += MANUAL_REFRESH_CONCURRENCY
  ) {
    assertRefreshSignal(signal);
    const waveTasks = orderedTasks.slice(
      waveStart,
      waveStart + MANUAL_REFRESH_CONCURRENCY,
    );
    if (deadlineExpired(deadlineAtMs)) {
      for (const task of orderedTasks.slice(waveStart)) {
        writeDiagnostic("refresh.stage.skipped", {
          flowId,
          source,
          stage: task.kind === "shipment" ? "manual_refresh" : "pending_query",
          skipReason: "deadline_exhausted",
        });
      }
      break;
    }

    let reservedShipment = false;
    for (const task of waveTasks) {
      if (task.kind !== "shipment") continue;
      const index = shipments.findIndex(
        (shipment) => shipment.identity.id === task.id,
      );
      if (index < 0) continue;
      const attemptAtMs = Date.now();
      const attemptId = createDiagnosticFlowId("manual");
      shipments[index] = beginManualRefreshAttempt(
        shipments[index],
        attemptId,
        attemptAtMs,
        accountChildDeadline(
          deadlineAtMs,
          MANUAL_REFRESH_TASK_BUDGET_MS,
          0,
          attemptAtMs,
        ),
      );
      manualAttemptIds.set(task.id, attemptId);
      reservedShipment = true;
    }
    if (reservedShipment) {
      currentState = checkpoint(
        { ...currentState, shipments: sortShipments(shipments) },
        new Map(),
        "manual_refresh_attempt",
      );
      shipments = [...currentState.shipments];
      pendingQueries = [...currentState.pendingQueries];
      for (const task of waveTasks) {
        if (task.kind !== "shipment") continue;
        const reserved = shipments.find(
          (shipment) => shipment.identity.id === task.id,
        );
        const attemptId = manualAttemptIds.get(task.id) || "";
        if (!ownsManualRefreshLease(reserved, attemptId)) {
          manualAttemptIds.delete(task.id);
        }
      }
    }

    const taskAttempts = await runAccountFollowupCandidates(
      waveTasks,
      async (task): Promise<ManualTaskAttempt> => {
        const startedAtMs = Date.now();
        const taskDeadlineAtMs = accountChildDeadline(
          deadlineAtMs,
          MANUAL_REFRESH_TASK_BUDGET_MS,
          0,
          startedAtMs,
        );
        if (deadlineExpired(deadlineAtMs)) {
          return {
            task,
            startedAtMs,
            deadlineAtMs: taskDeadlineAtMs,
            outcome: "deadline_exhausted",
          };
        }
        try {
          assertRefreshSignal(signal);
          if (task.kind === "shipment") {
            const current = shipments.find(
              (shipment) => shipment.identity.id === task.id,
            );
            const attemptId = manualAttemptIds.get(task.id) || "";
            if (!current || !ownsManualRefreshLease(current, attemptId)) {
              return {
                task,
                startedAtMs,
                deadlineAtMs: taskDeadlineAtMs,
                outcome: "failed",
                error: new Error("manual refresh lease unavailable"),
              };
            }
            const result = await (runtimeOverrides.queryManualForSource || queryManualForSource)({
              source,
              bindings,
              waybill: displayWaybill(current),
              phoneTail: current.identity.phoneTail,
              rawCourierCode: current.identity.rawCourierCode,
              courierCode: current.identity.courierCode,
              companyName: current.identity.companyName,
              sourceProvider: current.identity.sourceProvider,
              deadlineAtMs: taskDeadlineAtMs,
              signal,
              diagnosticFlowId: flowId,
              diagnosticStage: "manual_refresh",
              currentShipment: current,
              pickerFirst: true,
              pickerOnly: !current.identity.manuallyAdded,
              // Automatic list supplementation is Online-only; manual rows keep their existing chain.
              includeKdniaoFallback: current.identity.manuallyAdded,
              scheduled: !forceManualRefresh,
              hostSafe: true,
            });
            assertRefreshSignal(signal);
            return {
              task,
              startedAtMs,
              deadlineAtMs: taskDeadlineAtMs,
              outcome: "result",
              result,
            };
          }
          const originalPending = pendingQueries.find(
            (pending) => pending.id === task.id,
          );
          if (!originalPending) {
            return {
              task,
              startedAtMs,
              deadlineAtMs: taskDeadlineAtMs,
              outcome: "failed",
              error: new Error("pending query unavailable"),
            };
          }
          const pending = await refreshPendingCarrierPresentation(
            originalPending,
            { deadlineAtMs: taskDeadlineAtMs, signal },
          );
          const result = await queryPendingManualRound(
            pending,
            source,
            bindings,
            taskDeadlineAtMs,
            signal,
            flowId,
          );
          assertRefreshSignal(signal);
          return {
            task,
            startedAtMs,
            deadlineAtMs: taskDeadlineAtMs,
            outcome: "result",
            result,
            pending,
          };
        } catch (error) {
          rethrowRefreshCancellation(error, signal);
          return {
            task,
            startedAtMs,
            deadlineAtMs: taskDeadlineAtMs,
            outcome: "failed",
            error,
          };
        }
      },
      MANUAL_REFRESH_CONCURRENCY,
    );

  for (const taskAttempt of taskAttempts) {
    const task = taskAttempt.task;
    const stage = task.kind === "shipment" ? "manual_refresh" : "pending_query";
    const taskStartedAt = taskAttempt.startedAtMs;
    if (taskAttempt.outcome === "deadline_exhausted") {
      const attemptId = task.kind === "shipment"
        ? manualAttemptIds.get(task.id) || ""
        : "";
      if (attemptId) releaseShipmentAttempt(task.id, attemptId, stage);
      writeDiagnostic("refresh.stage.skipped", {
        flowId,
        source,
        stage,
        skipReason: "deadline_exhausted",
      });
      continue;
    }
    writeDiagnostic("refresh.stage.started", {
      flowId,
      source,
      stage,
      budgetMs: stageBudgetMs(taskAttempt.deadlineAtMs, taskStartedAt),
    });
    if (task.kind === "shipment") {
      let index = shipments.findIndex(
        (current) => current.identity.id === task.id,
      );
      if (index < 0) continue;
      let current = shipments[index];
      const attemptId = manualAttemptIds.get(task.id) || "";
      if (!ownsManualRefreshLease(current, attemptId)) continue;
      const releaseAttempt = () =>
        releaseShipmentAttempt(task.id, attemptId, stage);
      const outcome = taskAttempt.outcome === "result"
        ? taskAttempt.result || null
        : null;
      if (outcome?.skipReason === "cooldown") {
        // 全链都在冷却里、一个请求都没发：不是失败（失败路径裁决），既不计 attempted 也不计
        // failed。原来这种 2 毫秒返回的空轮被记成 stage failed，再把整轮抬成 ERROR。
        releaseAttempt();
        writeDiagnostic("refresh.stage.skipped", {
          flowId,
          source,
          stage,
          skipReason: "cooldown",
          result: "cooldown",
          ...shipmentDiagnosticDetails(current),
        });
        continue;
      }
      attempted++;
      if (taskAttempt.outcome === "failed") {
        releaseAttempt();
        failed++;
        writeDiagnostic("refresh.stage.failed", {
          flowId,
          source,
          stage,
          durationMs: Date.now() - taskStartedAt,
          ...diagnosticErrorDetails(taskAttempt.error),
        }, "warning");
        continue;
      }
      if (
        outcome?.shipment &&
        timedTracks(outcome.shipment.timeline.tracks).length
      ) {
        const taskMutations: DeferredRouteMutations = new Map();
        let merged = applyManualShipment(current, outcome.shipment, now);
        merged = deferIncomingRoute(
          merged,
          outcome.shipment,
          outcome.routeUrl,
          now,
          taskMutations,
        );
        shipments[index] = releaseManualRefreshLease(merged, attemptId);
        currentState = checkpoint(
          { ...currentState, shipments: sortShipments(shipments) },
          taskMutations,
          stage,
        );
        shipments = [...currentState.shipments];
        pendingQueries = [...currentState.pendingQueries];
        releaseAttempt();
        succeeded++;
        writeDiagnostic("refresh.stage.succeeded", {
          flowId,
          source,
          stage,
          durationMs: Date.now() - taskStartedAt,
        });
      } else {
        if (
          outcome?.shipment &&
          outcome.routeUrl &&
          isShunFengSourceShipment(current)
        ) {
          const routeMutations: DeferredRouteMutations = new Map();
          shipments[index] = releaseManualRefreshLease(deferIncomingRoute(
            current,
            outcome.shipment,
            outcome.routeUrl,
            now,
            routeMutations,
          ), attemptId);
          currentState = checkpoint(
            { ...currentState, shipments: sortShipments(shipments) },
            routeMutations,
            `${stage}_route`,
          );
          shipments = [...currentState.shipments];
          pendingQueries = [...currentState.pendingQueries];
        }
        releaseAttempt();
        failed++;
        writeDiagnostic("refresh.stage.failed", {
          flowId,
          source,
          stage,
          durationMs: Date.now() - taskStartedAt,
          result: "no_result",
          routeCaptured: Boolean(
            outcome?.routeUrl && isShunFengSourceShipment(current)
          ),
        }, "warning");
      }
      continue;
    }

    let pending = pendingQueries.find((value) => value.id === task.id);
    if (!pending) continue;
    attempted++;
    if (taskAttempt.pending) {
      pending = {
        ...pending,
        courierCode: taskAttempt.pending.courierCode,
        rawCourierCode: taskAttempt.pending.rawCourierCode,
        companyName: taskAttempt.pending.companyName,
      };
    }
    const outcome = taskAttempt.outcome === "result"
      ? taskAttempt.result || null
      : null;
    const queryError = taskAttempt.outcome === "failed"
      ? taskAttempt.error
      : null;
    const taskMutations: DeferredRouteMutations = new Map();
    if (queryError) {
      pendingQueries = pendingQueries.map((item) =>
        item.id === pending.id
          ? {
              ...pending,
              lastAttemptAtMs: now,
              attempts: item.attempts + 1,
            }
          : item,
      );
      currentState = checkpoint(
        { ...currentState, shipments, pendingQueries },
        taskMutations,
        stage,
      );
      shipments = [...currentState.shipments];
      pendingQueries = [...currentState.pendingQueries];
      failed++;
      writeDiagnostic("refresh.stage.failed", {
        flowId,
        source,
        stage,
        durationMs: Date.now() - taskStartedAt,
        ...diagnosticErrorDetails(queryError),
      }, "warning");
      continue;
    }
    if (
      outcome?.shipment &&
      timedTracks(outcome.shipment.timeline.tracks).length
    ) {
      const current = shipments
        .filter(
          (item) =>
            item.identity.bindingSource === source ||
            item.identity.bindingSource == null,
        )
        .sort((left, right) =>
          Number(left.identity.bindingSource == null) -
            Number(right.identity.bindingSource == null) ||
          Number(left.identity.manuallyAdded) - Number(right.identity.manuallyAdded)
        )
        .find((item) => displayWaybill(item) === pending.waybill);
      let merged = applyManualShipment(current, outcome.shipment, now);
      merged = deferIncomingRoute(
        merged,
        outcome.shipment,
        outcome.routeUrl,
        now,
        taskMutations,
      );
      merged = deferPendingRoute(merged, pending, now, taskMutations);
      shipments = replaceById(shipments, merged);
      shipments = shipments.filter(
        (item) =>
          item.identity.id === merged.identity.id ||
          item.identity.bindingSource !== source ||
          displayWaybill(item) !== pending.waybill,
      );
      pendingQueries = pendingQueries.filter((item) => item.id !== pending.id);
      currentState = checkpoint(
        { ...currentState, shipments, pendingQueries },
        taskMutations,
        stage,
      );
      shipments = [...currentState.shipments];
      pendingQueries = [...currentState.pendingQueries];
      const promotedShipmentId = committedPendingPromotionShipmentId(
        currentState,
        pending.id,
        merged.identity.id,
      );
      if (
        promotedShipmentId &&
        !promotedPendingShipmentIds.includes(promotedShipmentId)
      ) {
        promotedPendingShipmentIds.push(promotedShipmentId);
      }
      succeeded++;
      writeDiagnostic("refresh.stage.succeeded", {
        flowId,
        source,
        stage,
        durationMs: Date.now() - taskStartedAt,
      });
    } else {
      const refreshedPending = deferPendingRouteUpdate(pending, {
        ...pending,
        lastAttemptAtMs: now,
        attempts: pending.attempts + 1,
        awaitingRoundCompletion: false,
        courierCode:
          outcome?.pending?.courierCode || pending.courierCode,
        companyName:
          outcome?.pending?.companyName || pending.companyName,
        route: outcome?.pending?.route || pending.route || null,
      }, outcome?.routeUrl || "", now, taskMutations);
      pendingQueries = pendingQueries.map((item) =>
        item.id === pending.id ? refreshedPending : item,
      );
      currentState = checkpoint(
        { ...currentState, shipments, pendingQueries },
        taskMutations,
        stage,
      );
      shipments = [...currentState.shipments];
      pendingQueries = [...currentState.pendingQueries];
      failed++;
      writeDiagnostic("refresh.stage.failed", {
        flowId,
        source,
        stage,
        durationMs: Date.now() - taskStartedAt,
        result: "no_result",
      }, "warning");
    }
    }
  }

  return {
    state: currentState,
    attempted,
    succeeded,
    failed,
    promotedPendingShipmentIds,
  };
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
  const pickerReachedStart = Boolean(
    shipment && [
      ...(shipment.manualTimelines || []),
      shipment.timeline,
    ].some(
      (timeline) =>
        timelineCapability(timeline.provider) === "route" &&
        containsTimelineStartTrack(timeline.tracks),
    ),
  );
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
    const pointer = preview.pending.route || null;
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
          next = saveState(
            {
              ...next,
              pendingQueries: next.pendingQueries.map((item) =>
                item.id === pending.id ? pending : item,
              ),
            },
            now,
          );
        }
      } catch {
        if (!existingRoute) safelyRemoveRoutes([pending.id]);
      }
    }
    safelyPruneRoutes(next);
    return next;
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
  const pointer = preview.shipment.route || null;
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
      next = saveState(
        { ...next, shipments: replaceById(next.shipments, shipment) },
        now,
      );
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

async function runShipmentRefreshById(
  shipmentId: string,
  lease: TargetRefreshLease,
  options: ShipmentRefreshOptions = {},
  runtimeOverrides: Partial<{
    refreshAccountParcel: typeof refreshAccountParcel;
    queryManualForSource: typeof queryManualForSource;
  }> = {},
): Promise<ShipmentRefreshResult> {
  const runtime = { refreshAccountParcel, queryManualForSource, ...runtimeOverrides };
  const startedAt = Date.now();
  const flowId = createDiagnosticFlowId("detail");
  let base = loadState(startedAt);
  let original = base.shipments.find(
    (item) => item.identity.id === shipmentId,
  );
  if (!original) throw new Error("该快递已从列表中移除");
  const source = requireScriptSource(
    original.identity.bindingSource || SCRIPT_BINDING_SOURCE,
  );
  const deadlineAtMs = lease.deadlineAtMs;
  const signal = lease.signal;
  const trigger = options.trigger || "detail_open";
  const missingHistoryRefresh = trigger === "missing_history" &&
    !hasUsableShipmentDynamics(original) && !original.emptyTimelineHiddenAtMs;
  if (original.emptyTimelineHiddenAtMs) {
    return { shipment: original, state: base, refreshed: false };
  }
  // The shared Home resolver already borrows eligible cached structured status.
  // A detail package's legacy or prose-derived semantic cannot satisfy that gap.
  const lacksStatus = (shipment: Shipment) =>
    selectShipmentTimeline(shipment).semantic === "UNKNOWN";
  const missingStatusRefresh = (trigger === "detail_open" || trigger === "detail_pull" ||
      trigger === "identity_projection") &&
    !unprojectedAccountOrder(original) && lacksStatus(original);
  const usableManualSupplement = (shipment: Shipment | null | undefined): shipment is Shipment =>
    !!shipment && (timedTracks(shipment.timeline.tracks).length > 0 ||
      (missingStatusRefresh && shipment.timeline.structuredStatus === true &&
        shipment.timeline.semantic !== "UNKNOWN"));
  let completedSourceQuery = false;
  let sourceAccessRejected = false;
  const onQueryAttempted = (authorized: boolean) => {
    if (authorized) completedSourceQuery = true;
    else sourceAccessRejected = true;
  };
  const needsAutomaticFallback = needsAutomaticManualFallback(original);
  // Complete history suppresses timeline supplementation; explicit missing-status
  // repair still needs structured evidence from an allowed provider.
  const detailComplete = shipmentDetailComplete(original);
  const requestedJingDongDetailSupplement = !detailComplete &&
    isJingDongAutomaticShipment(original) && (
      trigger === "identity_projection" ||
      trigger === "detail_open" ||
      trigger === "detail_pull" ||
      missingHistoryRefresh
    );
  const explicitTimelineRefresh = !detailComplete && (
    missingHistoryRefresh ||
    trigger === "detail_pull" ||
    trigger === "manual_submit" ||
    (trigger === "detail_open" && needsAutomaticFallback) ||
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
    scriptVersion: SCRIPT_VERSION,
    clientBuild: SCRIPT_CLIENT_BUILD,
    baseActiveSource: base.activeSource,
    baseRevision: base.revision,
    ...shipmentDiagnosticDetails(original),
  });
  const forceAccountOrderProjection = Boolean(
    options.forceAccountOrderProjection &&
    unprojectedAccountOrder(original) &&
    accountOrderReadyForProjection(
      original.statusPresentation?.scope === "ORDER"
        ? original.statusPresentation.semantic
        : original.timeline.semantic,
    ),
  );
  const usesManualQuery = usesManualSourceQuery(original);
  const jingDongProjectionRoute = storedJingDongProjectionRoute(
    original,
    startedAt,
  );
  const settledHistory = hasSettledTimelineHistory(original);
  // K100 H5 对京东来源彻底不开（用户定 2026-09-05）：京东链 = 接口 5 按件详情（订单号）→ 联合页兜底。
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
        : shouldRefreshShipment(original, Date.now()))
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
  let carrierRepair: Awaited<ReturnType<typeof recognizeNonSyncCarrier>>["normalization"] | null =
    null;
  /**
   * 这一轮开始前**存储里**那一行，让提交栅栏始终拿它跟存储比。承运商修复和下面那次接口 5 按件
   * 详情都会替换 `original`，两者都必须先在这里留下存储版本。
   */
  let storedRowBaseline: Shipment | null = null;
  if (needsProjectedCarrierRepair(original.identity)) {
    // The carrier waybill is not a JD number but the identity still wears the JD order label:
    // recognise the real carrier from the waybill and repair the projected identity. `base`
    // stays the stored state: the commit fence compares its copy of the shipment with storage,
    // so the repair travels in `refreshed` only.
    try {
      const recognition = await recognizeNonSyncCarrier(
        normalizedProjectedWaybill(original.identity),
        { deadlineAtMs, signal },
      );
      const repaired = repairProjectedShipmentCarrier(original, recognition.normalization);
      if (repaired !== original) {
        carrierRepair = recognition.normalization;
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
  // 用户定 2026-09-05：小米（接口 5）京东来源那一行，用**订单号**问 `/cpa/express/v2/query`
  // （provider=JingDong / cpCode=JDKD / name=京东商品快递）就能直接拿回全量轨迹。
  //
  // 表格里「详情页下拉先拉一遍对应接口」这一步在京东链上原来是空的：`original.accountRecord`
  // 一存在就直接开京东联合页 WebView，白吃 403 风控和 10 分钟冷却，而接口 5 自己那条更便宜、
  // 更稳的路径从来没被走过。按件详情的 5 分钟节流仍由 refreshProviderDue 把住。
  let accountDetailGaveTimeline = false;
  if (
    original.accountRecord &&
    !original.identity.manuallyAdded &&
    isJingDongSourceShipment(original) &&
    // 用户定 2026-09-05：拉到的轨迹按来源缓存，**不是每次都重拉**——缓存里的详情已完整（有揽收）
    // 就不再打；不完整才按订单号打一次。下拉只绕过 5 分钟节流，不绕过这道完整判据。
    needsDetailFallback(original)
  ) {
    const accountDetailKey = `${source}:${original.identity.id}`;
    const accountDetailFingerprint = [
      displayWaybill(original),
      original.identity.courierCode,
      original.identity.phoneTail,
    ].join(":");
    if (explicitTimelineRefresh || refreshProviderDue(
      accountDetailKey,
      "account_detail",
      accountDetailFingerprint,
      Date.now(),
    )) {
      const accountDetailStartedAt = Date.now();
      writeDiagnostic("detail.refresh.stage_started", {
        flowId,
        source,
        stage: "account_detail",
        budgetMs: ACCOUNT_DETAIL_BUDGET_MS,
        ...shipmentDiagnosticDetails(original),
      });
      try {
        const parcel = await runtime.refreshAccountParcel(
          original,
          accountChildDeadline(deadlineAtMs, ACCOUNT_DETAIL_BUDGET_MS),
          signal,
          onQueryAttempted,
        );
        const incoming = parcel
          ? parcelToShipment(
              parcel,
              sourceBindings.map((binding) => binding.phone),
              startedAt,
            )
          : null;
        const merged = incoming
          ? applyTargetedAccountShipment(
              original,
              asAccountDetailObservation(original, incoming),
              startedAt,
              { existingCainiaoRouteAvailable: Boolean(cainiaoRouteUrl) },
            )
          : null;
        recordRefreshProviderResult({
          key: accountDetailKey,
          provider: "account_detail",
          identityFingerprint: accountDetailFingerprint,
          result: merged ? "success" : "no_result",
        });
        if (merged && merged !== original) {
          if (!storedRowBaseline) storedRowBaseline = original;
          original = merged;
          refreshed = merged;
        }
        accountDetailGaveTimeline = Boolean(
          merged && timedTracks(selectShipmentDetailTimeline(merged).tracks).length,
        );
        writeDiagnostic(
          merged ? "detail.refresh.stage_succeeded" : "detail.refresh.stage_failed",
          {
            flowId,
            source,
            stage: "account_detail",
            durationMs: Date.now() - accountDetailStartedAt,
            result: merged ? "timed_tracks" : "no_result",
            ...shipmentDiagnosticDetails(original),
          },
          merged ? "info" : "warning",
        );
      } catch (error) {
        rethrowRefreshCancellation(error, signal);
        recordRefreshProviderResult({
          key: accountDetailKey,
          provider: "account_detail",
          identityFingerprint: accountDetailFingerprint,
          result: refreshProviderResultForError(error),
        });
        writeDiagnostic("detail.refresh.stage_failed", {
          flowId,
          source,
          stage: "account_detail",
          durationMs: Date.now() - accountDetailStartedAt,
          ...diagnosticErrorDetails(error),
        }, "warning");
      }
    }
  }
  try {
      let accountError: unknown = null;
      // 用户定 2026-09-05：京东联合页只在接口 5 按件详情什么都没给、**且**行上还没投影出运单号时
      // 才开；拉到了轨迹、或已经有真实运单号的行，不再开页（也不再 D-13 重开）。
      const unionPageAllowed = !isJingDongSourceShipment(original) ||
        (!accountDetailGaveTimeline &&
          !normalizedProjectedWaybill(original.identity));
      if (original.accountRecord && unionPageAllowed) {
        stage = "cached_order_projection";
        try {
          let projectionRetry:
            Shipment["identity"]["orderProjectionRetry"] = undefined;
          let reopenRetry: Shipment["identity"]["jingDongH5Retry"] = undefined;
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
          // AGENTS §9 (D-13 ruling, 2026-09-04): a projected JD order whose H5 timeline is not
          // causally complete reopens the union page on a detail refresh, like Pipi, under the
          // same 10-minute / risk-control cooldown recorded in identity.jingDongH5Retry.
          const reopenForTimeline = Boolean(
            normalizedProjectedWaybill(original.identity) &&
              isJingDongSourceShipment(original) &&
              // 用户定 2026-09-04：签收即冻结，**但详情仍不完整时照样可以刷**——与 Pipi 的
              // shouldRefreshNativeDetail 同义。未签收一律可重开；已签收只在这一票的 H5 还没抓够
              // （<2 条、且那一条不是揽收）时才继续开页。
              // 不能拿包上的 complete 当闸门：它只证明「这次抓取展开了列表」，不代表轨迹到此为止，
              // 那样会把一个还在运输中的包永久冻住。
              (!jingDongTimelineSettled(original) ||
                !jingDongH5CaptureSufficient(original)) &&
              // The feed owns every field it provides, the timeline included: the H5 page is
              // captured ONLY while the feed's own incremental cache is still incomplete (user
              // rule, 2026-09-04). This holds for an explicit pull too — a pull on a parcel whose
              // feed already reaches 揽收 has nothing to add, and the load would take that order's
              // ten-minute cooldown slot away from a capture that is actually needed. 判据是**揽收**
              // （用户定 2026-09-04）：只有「已下单」不算，与 Pipi 的 hasPickupEvidence 同义。
              !jingDongFeedReachedPickup(original) &&
              parcel?.projectionUrl,
          );
          if (
                        parcel?.accountOrder &&
            (parcel.projectionUrl || parcel.textIdentity?.waybill) &&
            accountOrderReadyForProjection(
              parcel.normalizedStatusSemantic || parcel.semantic,
            ) &&
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
              (reopenForTimeline || !parcel.textIdentity?.waybill) &&
              !shouldRetryAccountOrderProjection(
                reopenForTimeline
                  ? freshOwner?.identity.jingDongH5Retry
                  : freshOwner?.identity.orderProjectionRetry,
                routeHash,
                Date.now(),
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
                  : gatingRetry?.riskControlAtMs
                    ? "risk_control_cooldown"
                    : "cooldown",
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
                  const projectedBefore = normalizedProjectedWaybill(original.identity);
                  parcel = await projectAccountOrderWithCarrier(
                    // A reopen must load the page: the feed text identity would short-circuit it.
                    reopenForTimeline ? { ...parcel, textIdentity: undefined } : parcel,
                    projectionDeadlineAtMs,
                    deadlineAtMs,
                    (diagnostics) => {
                      projectionDiagnostics = diagnostics;
                    },
                    signal,
                  );
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
                    projectionRetry = projectionFailureRetry(
                      routeHash,
                      projectionDiagnostics,
                      Date.now(),
                    );
                  } else {
                    projectionRetry = undefined;
                  }
                } catch (error) {
                  rethrowRefreshCancellation(error, signal);
                  projectionRetry = projectionFailureRetry(
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
          if (parcel) {
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
      const jingDongAutomaticH5Available =
        jingDongAutomaticH5TimelineAvailable(enrichmentBase);
      if (requestedJingDongDetailSupplement) {
        const sourceTimeline = enrichmentBase.sourceTimeline ||
          enrichmentBase.timeline;
        // 这是「联合页要不要开」的判定，不是一次抓取：接口 5 的包够用就记 skipped/timed_tracks，
        // 不够才记 skipped/no_timed_tracks；真正开页的那一级自己打 started/succeeded。
        writeDiagnostic(
          "detail.refresh.stage_skipped",
          {
            flowId,
            source,
            stage: "jingdong_h5",
            skipReason: jingDongAutomaticH5Available
              ? "timed_tracks"
              : "no_timed_tracks",
            timelineProvider: "interface5",
            effectiveTrackCount: jingDongAutomaticH5Available
              ? timedTracks(sourceTimeline.tracks).length
              : 0,
            result: jingDongAutomaticH5Available
              ? "timed_tracks"
              : "no_timed_tracks",
          },
          jingDongAutomaticH5Available ? "info" : "warning",
        );
      }
      // Automatic feed pickup and a complete same-waybill H5 package stop the manual chain
      // before Picker. A cached manual origin is evaluated only after refreshing Picker.
      const jingDongManualFallbackRequested =
        requestedJingDongDetailSupplement &&
        Boolean(normalizedProjectedWaybill(enrichmentBase.identity)) &&
        !jingDongFeedReachedPickup(enrichmentBase) &&
        !jingDongAutomaticH5Available;
      let cainiaoH5Succeeded = false;
      // 用户定 2026-09-05：缓存里的详情已完整（有揽收）就不再重拉，下拉只绕节流。这道门看的是
      // **选中的详情包**（任一槽），不只是 feed：feed 没揽收但 k100_h5 缓存已完整时同样不跑。
      const cainiaoH5Requested = explicitTimelineRefresh &&
        cainiaoAutomaticNeedsH5Supplement(enrichmentBase) &&
        !shipmentDetailComplete(enrichmentBase);
      if (cainiaoH5Requested) {
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
          timelineProvider: TIMELINE_SLOT.CN_H5,
          routePresent: Boolean(cainiaoRouteUrl),
          routeTrusted: trustedCainiaoH5Route(cainiaoRouteUrl),
          budgetMs: stageBudgetMs(cainiaoH5DeadlineAtMs, cainiaoH5StartedAt),
        });
        try {
          const cainiaoH5 = await refreshCainiaoH5(
            enrichmentBase,
            cainiaoRouteUrl,
            cainiaoH5DeadlineAtMs,
            (diagnostics) => { cainiaoDiagnostics = diagnostics; },
            signal,
            onQueryAttempted,
          );
          assertRefreshSignal(signal);
          if (cainiaoH5) {
            // 用户定 2026-09-04：抓到节点 ≠ 抓够了。终止判据与全局一致——**揽收（PICKED）**。
            // 原来只要 H5 回了 ≥1 条带时间的节点就判成功并终止整条链，于是只抓到一条「已下单」
            // 时 picker / moto / 快递100 / kdniao 全都不跑，用户反复下拉也看不到揽收之后的轨迹。
            // 抓到的包照常保留（来源返回什么就存什么），只是不再拿它当链子的终点。
            const capturedCainiaoH5 = (cainiaoH5.manualTimelines || []).find(
              (timeline) =>
                normalizeTimelineSlot(timeline.provider) === TIMELINE_SLOT.CN_H5,
            ) || null;
            cainiaoH5Succeeded = Boolean(
              capturedCainiaoH5 &&
                containsTimelinePickupTrack(capturedCainiaoH5.tracks),
            );
            refreshed = cainiaoH5Succeeded
              ? clearCainiaoManualFallback(cainiaoH5)
              : cainiaoH5;
            enrichmentBase = refreshed;
            changed = true;
            const detailTimeline = selectShipmentDetailTimeline(cainiaoH5);
            writeDiagnostic("detail.refresh.stage_succeeded", {
              flowId,
              source,
              stage,
              timelineProvider: TIMELINE_SLOT.CN_H5,
              effectiveTrackCount: timedTracks(detailTimeline.tracks).length,
              durationMs: Date.now() - cainiaoH5StartedAt,
              result: "timed_tracks",
              ...cainiaoH5DiagnosticDetails(cainiaoDiagnostics),
            });
          } else {
            writeDiagnostic("detail.refresh.stage_failed", {
              flowId,
              source,
              stage,
              timelineProvider: TIMELINE_SLOT.CN_H5,
              durationMs: Date.now() - cainiaoH5StartedAt,
              result: "no_timed_tracks",
              ...cainiaoH5DiagnosticDetails(cainiaoDiagnostics),
            }, "warning");
          }
        } catch (error) {
          rethrowRefreshCancellation(error, signal);
          writeDiagnostic("detail.refresh.stage_failed", {
            flowId,
            source,
            stage,
            timelineProvider: TIMELINE_SLOT.CN_H5,
            durationMs: Date.now() - cainiaoH5StartedAt,
            ...diagnosticErrorDetails(error),
            ...cainiaoH5DiagnosticDetails(cainiaoDiagnostics),
          }, "warning");
        }
      }
      const cainiaoManualFallbackRequested = cainiaoH5Requested &&
        !cainiaoH5Succeeded;
      if (cainiaoManualFallbackRequested) {
        const activated = activateCainiaoManualFallback(refreshed);
        changed ||= activated !== refreshed;
        refreshed = activated;
        enrichmentBase = activated;
      }
      const ordinaryAutomaticSupplementRequested = explicitTimelineRefresh &&
        needsAutomaticManualFallback(enrichmentBase);
      const pickerSupplementRequested = missingStatusRefresh
        ? lacksStatus(enrichmentBase)
        : ordinaryAutomaticSupplementRequested || requestedKuaidi100Timeline ||
          jingDongManualFallbackRequested || cainiaoManualFallbackRequested;
      if (pickerSupplementRequested) {
        stage = "picker_query";
        const pickerOutcome = await runtime.queryManualForSource({
          onQueryAttempted,
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
        });

        assertRefreshSignal(signal);
        const pickerShipment = rejectForeignManualResult(
          refreshed,
          pickerOutcome.shipment,
          { flowId, source, stage, timelineProvider: TIMELINE_SLOT.V6_QUERY },
        );
        if (usableManualSupplement(pickerShipment)) {
          refreshed = applyManualShipment(
            refreshed,
            pickerShipment,
            Date.now(),
          );
          enrichmentBase = refreshed;
          changed = true;
        }
      }
      const ordinaryAutomaticPrimaryRequested = missingStatusRefresh
        ? lacksStatus(enrichmentBase) && !isJingDongSourceShipment(enrichmentBase)
        : explicitTimelineRefresh && (
            needsAutomaticManualFallback(enrichmentBase) || cainiaoManualFallbackRequested
          ) && !hasPickerTimelineStart(enrichmentBase);
      const kuaidi100PrimaryRequested = !missingStatusRefresh && requestedKuaidi100Timeline &&
        !hasPickerTimelineStart(enrichmentBase);
      const kuaidi100LevelRequested = (kuaidi100PrimaryRequested ||
          ordinaryAutomaticPrimaryRequested) && (
          enrichmentBase.identity.manuallyAdded ||
          isShunFengSourceShipment(enrichmentBase) ||
          ordinaryAutomaticPrimaryRequested
        ) && !isJingDongSourceShipment(enrichmentBase);
      const h5Kind = kuaidi100LevelRequested ? "web" : "none";
      // 列表轮的手动件也跑 v4_query（用户定 2026-09-05 傍晚，对齐 Lite/Pipi 的后台手动链
      // picker ∥ v4_query）：此前列表轮只跑 picker，EMS 那票 picker 被上游拒绝就整轮 no_result，
      // 而 Lite/Pipi 同一轮从 v4_query 拿到 22 条。K100 页仍只在详情/加件那一级抓。
      const listRoundManualContest = !explicitTimelineRefresh && !detailComplete &&
        enrichmentBase.identity.manuallyAdded &&
        !isShunFengSourceShipment(enrichmentBase) &&
        !isJingDongSourceShipment(enrichmentBase);
      const primaryContestRequested = (
        missingStatusRefresh ? lacksStatus(enrichmentBase)
          : (explicitTimelineRefresh || listRoundManualContest) && !hasPickerTimelineStart(enrichmentBase)
      ) && (
        kuaidi100PrimaryRequested ||
        listRoundManualContest ||
        ordinaryAutomaticPrimaryRequested ||
        kuaidi100LevelRequested
      );
      const motoSupported = primaryContestRequested &&
        !isJingDongSourceShipment(enrichmentBase) &&
        !isShunFengSourceShipment(enrichmentBase);
      const h5Stage = "kuaidi100_query";
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
          timelineProvider: TIMELINE_SLOT.K100_H5,
          budgetMs: stageBudgetMs(h5DeadlineAtMs, h5StartedAt),
        });
      }
      const queryH5 = async () => {
        if (deadlineExpired(deadlineAtMs) || h5Kind !== "web") return null;
        const result = await refreshWebTimeline(
            enrichmentBase,
            h5DeadlineAtMs,
            (diagnostics) => { webDiagnostics = diagnostics; },
            signal,
            onQueryAttempted,
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
      if (primaryContestRequested) {
        const contest = await runManualDetailSourceContest({
          queryMoto: async () => {
            if (!motoSupported) return null;
            const outcome = await runtime.queryManualForSource({
              onQueryAttempted,
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
            });
            return usableManualSupplement(outcome.shipment) ? outcome.shipment : null;
          },
          queryKuaidi100: queryH5,
          ...(options.includeKdniaoFallback === true
            ? {
                queryKdniao: async () => {
                  stage = "kdniao_fallback";
                  const outcome = await runtime.queryManualForSource({
                    onQueryAttempted,
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
                  });
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
        assertRefreshSignal(signal);
        motoResult = contest.moto.shipment;
        h5Result = contest.kuaidi100.shipment;
        h5Error = contest.kuaidi100.error;
        kdniaoResult = contest.kdniao.shipment;
        kdniaoError = contest.kdniao.error;
        primarySuccessCount = contest.primarySuccessCount;
        primaryReachedTimelineStart = contest.primaryReachedTimelineStart;
        kdniaoAttempted = contest.kdniaoAttempted;
        if (motoResult) {
          refreshed = applyManualShipment(refreshed, motoResult, Date.now());
          changed = true;
        }
      } else {
        try {
          h5Result = await queryH5();
          assertRefreshSignal(signal);
        } catch (error) {
          rethrowRefreshCancellation(error, signal);
          h5Error = error;
        }
      }
      h5Result = rejectForeignManualResult(refreshed, h5Result, {
        flowId,
        source,
        stage: h5Stage,
        timelineProvider: TIMELINE_SLOT.K100_H5,
      });
      if (h5Result) {
        refreshed = primaryContestRequested
          ? applyManualShipment(refreshed, h5Result, Date.now())
          : h5Result;
        changed = true;
        const detailTimeline = selectShipmentDetailTimeline(h5Result);
        writeDiagnostic("detail.refresh.stage_succeeded", {
          flowId,
          source,
          stage: h5Stage,
          ...shipmentDiagnosticDetails(h5Result),
          timelineProvider: TIMELINE_SLOT.K100_H5,
          carrierCode: detailTimeline.courierCode,
          effectiveTrackCount: timedTracks(detailTimeline.tracks).length,
          durationMs: Date.now() - h5StartedAt,
          ...(webDiagnostics || {}),
          result: "timed_tracks",
        });
      } else if (h5Kind !== "none") {
        writeDiagnostic("detail.refresh.stage_failed", {
          flowId,
          source,
          stage: h5Stage,
          timelineProvider: TIMELINE_SLOT.K100_H5,
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
        refreshed = applyManualShipment(refreshed, kdniaoResult, Date.now());
        changed = true;
      } else if (kdniaoError) {
        rethrowRefreshCancellation(kdniaoError, signal);
        writeDiagnostic("detail.refresh.fallback_failed", {
          flowId,
          source,
          stage: "kdniao_fallback",
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
          v4QuerySupported: motoSupported,
          v4QuerySucceeded: Boolean(motoResult),
          k100H5Succeeded: Boolean(h5Result),
          primarySuccessCount,
          primaryReachedTimelineStart,
          kdniaoAttempted,
          kdniaoSucceeded: Boolean(kdniaoResult),
          detailTimelineProvider: selected.provider,
          detailEffectiveTrackCount: selectedTrackCount,
          durationMs: Date.now() - enrichmentStartedAt,
        });
      }

      if (
        !primaryContestRequested &&
        !unprojectedAccountOrder(refreshed) &&
        options.includeKdniaoFallback === true &&
        !deadlineExpired(deadlineAtMs) && (
          missingStatusRefresh ? lacksStatus(refreshed)
            : !jingDongAutomaticH5Available && !cainiaoH5Succeeded &&
              needsDetailFallback(refreshed) && !hasCachedKdniaoTimeline(refreshed) &&
              explicitTimelineRefresh
        )
      ) {
        stage = "kdniao_fallback";
        try {
          const outcome = await runtime.queryManualForSource({
            onQueryAttempted,
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
          });
          assertRefreshSignal(signal);
          if (usableManualSupplement(outcome.shipment)) {
            refreshed = applyManualShipment(
              refreshed,
              outcome.shipment,
              Date.now(),
            );
            changed = true;
          }
        } catch (error) {
          rethrowRefreshCancellation(error, signal);
          writeDiagnostic("detail.refresh.fallback_failed", {
            flowId,
            source,
            stage,
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
    const repairedFinal = repairProjectedShipmentCarrier(refreshed, carrierRepair);
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

  if (
    changed &&
    shipmentEffectiveFingerprint(refreshed) ===
      shipmentEffectiveFingerprint(storedRowBaseline || original)
  ) {
    changed = false;
  }

  if (!changed) {
    safelyPruneRoutes(base);
    writeDiagnostic("detail.refresh.skipped", {
      flowId,
      source,
      ...diagnosticState(base),
      durationMs: Date.now() - startedAt,
      ...shipmentDiagnosticDetails(original),
      persisted: false,
      finalTimelineProvider: String(original.timeline.provider || "")
        .trim()
        .toLowerCase(),
      skipReason: "no_result",
      result: "no_result",
    });
    return {
      shipment: original,
      state: base,
      refreshed: false,
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
  const persisted = next.shipments.find(
    (item) => item.identity.id === refreshed.identity.id,
  ) || refreshed;
  const persistedDetailTimeline = selectShipmentDetailTimeline(persisted);
  safelyPruneRoutes(next);
  requestWidgetReload();
  await replayPendingShipmentNotifications(lease.isCurrent);
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
    completedSourceQuery: completedSourceQuery && !sourceAccessRejected,
    ...(expressToast ? { expressToast } : {}),
  };
}

function runTargetedShipmentRefresh(
  shipmentId: string,
  options: ShipmentRefreshOptions,
): Promise<ShipmentRefreshResult> {
  const durableLease = acquireDurableRefreshLease(
    `detail:${shipmentId}`,
    35_000,
  );
  if (!durableLease) {
    const state = loadState();
    const shipment = state.shipments.find(
      (item) => item.identity.id === shipmentId,
    );
    return shipment
      ? Promise.resolve({ shipment, state, refreshed: false })
      : Promise.reject(new Error("该快递已从列表中移除"));
  }
  let active = true;
  const lease: TargetRefreshLease = {
    deadlineAtMs: options.deadlineAtMs,
    isCurrent: () =>
      active && durableLease.isCurrent() && !options.signal?.aborted,
    signal: options.signal,
  };
  return Promise.resolve().then(() =>
    runShipmentRefreshById(shipmentId, lease, options)
  ).finally(() => {
    active = false;
    durableLease.release();
  });
}

async function refreshMissingShipmentHistories(
  state: AppState,
  source: BindingSource,
  checkpoint: RefreshCheckpoint,
  deadlineAtMs?: number,
  signal?: AbortSignal,
  refresh = runTargetedShipmentRefresh,
): Promise<{ state: AppState; attempted: number; succeeded: number; failed: number }> {
  let current = state;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const candidates = state.shipments.filter((shipment) =>
    shipment.identity.bindingSource === source && !shipment.emptyTimelineHiddenAtMs &&
    // V5 automatic list gaps use the API-only pipeline; incomplete detail is repaired on the detail page.
    (source !== "interface5" || shipment.identity.manuallyAdded) &&
    !isHiddenSignedShipment(shipment) &&
    shipment.timeline.semantic !== "CANCELLED" &&
    !hasUsableShipmentDynamics(shipment));
  for (const candidate of candidates) {
    assertRefreshSignal(signal);
    if (deadlineExpired(deadlineAtMs)) break;
    try {
      const result = await refresh(candidate.identity.id, {
        trigger: "missing_history",
        includeKdniaoFallback: true,
        deadlineAtMs: accountChildDeadline(deadlineAtMs, MANUAL_QUERY_BUDGET_MS, 0),
        signal,
      });
      assertRefreshSignal(signal);
      current = checkpoint(result.state, new Map(), "missing_history");
      if (!result.completedSourceQuery) continue;
      attempted++;
      if (hasUsableShipmentDynamics(result.shipment)) succeeded++;
      else failed++;
    } catch (error) {
      rethrowRefreshCancellation(error, signal);
      writeDiagnostic("refresh.stage.failed", {
        source, stage: "missing_history", ...shipmentDiagnosticDetails(candidate),
        ...diagnosticErrorDetails(error),
      }, "warning");
    }
  }
  return { state: current, attempted, succeeded, failed };
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
  const existing = refreshCoordinator.detail(shipmentId);
  const trigger = options.trigger || "detail_open";
  const requiresFreshDetailRun = Boolean(
    options.forceManualRefresh ||
    options.forceAccountOrderProjection ||
    trigger === "manual_submit" ||
    trigger === "detail_pull",
  );
  if (existing && !requiresFreshDetailRun) return existing;
  const before = loadState();
  const shipment = before.shipments.find(
    (item) => item.identity.id === shipmentId,
  );
  if (!shipment) return Promise.reject(new Error("该快递已从列表中移除"));
  const refreshOptions = options;
  const source = requireScriptSource(
    shipment.identity.bindingSource || SCRIPT_BINDING_SOURCE,
  );
  const activeFull = refreshCoordinator.full(source);
  if (activeFull) {
    writeDiagnostic("detail.refresh.waiting", {
      source,
      baseActiveSource: before.activeSource,
      baseRevision: before.revision,
      stage: "full_refresh",
    });
  }
  if (existing && requiresFreshDetailRun) {
    writeDiagnostic("detail.refresh.waiting", {
      source,
      baseActiveSource: before.activeSource,
      baseRevision: before.revision,
      stage: "previous_detail_refresh",
    });
  }
  const runDetailTask = () => runTargetedShipmentRefreshWithProjectionWait(
    shipmentId,
    refreshOptions,
  );
  const reuseFullRefresh = async (summary: RefreshSummary) => {
    assertRefreshSignal(refreshOptions.signal);
    const current = summary.state.shipments.find(
      (item) => item.identity.id === shipmentId,
    );
    if (!current) throw new Error("该快递已从列表中移除");
    if (
      refreshOptions.forceManualRefresh ||
      refreshOptions.forceAccountOrderProjection ||
      refreshOptions.trigger === "manual_submit" || (
        (trigger === "detail_open" || trigger === "detail_pull") &&
        !unprojectedAccountOrder(current) &&
        selectShipmentTimeline(current).semantic === "UNKNOWN"
      )
    ) {
      writeDiagnostic("detail.refresh.waiting", {
        source,
        ...diagnosticState(summary.state),
        stage: "forced_projection_after_full_refresh",
      });
      return runTargetedShipmentRefreshWithProjectionWait(
        shipmentId,
        refreshOptions,
      );
    }
    writeDiagnostic("detail.refresh.skipped", {
      source,
      ...diagnosticState(summary.state),
      result: "coalesced_full_refresh",
    });
    return {
      shipment: current,
      state: summary.state,
      refreshed: current.updatedAtMs > shipment.updatedAtMs,
    };
  };
  if (requiresFreshDetailRun) {
    return refreshCoordinator.runDetailFresh(
      shipmentId,
      source,
      runDetailTask,
      reuseFullRefresh,
    );
  }
  return refreshCoordinator.runDetail(
    shipmentId,
    source,
    runDetailTask,
    reuseFullRefresh,
  );
}

type EnrichmentRuntime = AccountFollowupRuntimeOverrides & Readonly<{
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
): Promise<RefreshSummary> {
  let currentState = state;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const promotedPendingShipmentIds: string[] = [];
  const now = Date.now();
  const accounts = accountFollowupShipments(state, source, now, skipRefreshIds,
    deadlineAtMs == null ? undefined : deadlineAtMs - LOCAL_REFRESH_RESERVE_MS);
  const accountIds = new Set(accounts.map(shipment => shipment.identity.id));
  type Job = {kind: "account"; id: string} | ManualRefreshTask;
  const manuals = manualRefreshTasks(state, source, now, skipRefreshIds, forceManualRefresh, webViewEnrichment);
  const scheduledManuals = new Set(manuals.map(task => `${task.kind}:${task.id}`));
  const queued: Job[] = [
    ...manuals,
    ...accounts.map(shipment => ({kind: "account" as const, id: shipment.identity.id})),
  ];
  const completedAccounts = new Set<string>();
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
      const target = job.kind === "pending" ? undefined
        : currentState.shipments.find(shipment => shipment.identity.id === job.id);
      if (job.kind === "account" || (job.kind === "shipment" &&
          target && needsAutomaticListSupplement(target) && !isShunFengSourceShipment(target))) {
        const phone = String(target?.identity.phone || "").replace(/\D/g, "");
        const originalBinding = state.bindings.find(binding => binding.source === source && binding.phone === phone);
        const currentBinding = currentState.bindings.find(binding => binding.source === source && binding.phone === phone);
        if (phone && (!originalBinding || !currentBinding || originalBinding.boundAtMs !== currentBinding.boundAtMs)) {
          return {job, summary: {state: currentState, attempted: 0, succeeded: 0, failed: 0,
            promotedPendingShipmentIds: []}};
        }
      }
      if (job.kind === "account") {
        const result = await refreshAccountFollowups(
          currentState, source, Date.now(), flowId, commit, deadlineAtMs,
          skipRefreshIds, controller.signal, runtimeOverrides, job.id,
        );
        return {job, summary: {...result, promotedPendingShipmentIds: []}};
      }
      const result = await refreshManualAndPending(
        currentState, source, Date.now(), flowId, commit, deadlineAtMs,
        skipRefreshIds, forceManualRefresh, webViewEnrichment, controller.signal,
        runtimeOverrides, job,
      );
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
      while (active.size < ACCOUNT_FOLLOWUP_CONCURRENCY && !deadlineExpired(deadlineAtMs)) {
        const manualActive = [...active.keys()].filter(job => job.kind !== "account").length;
        const index = queued.findIndex(job => job.kind === "account" ||
          (manualActive < MANUAL_REFRESH_CONCURRENCY &&
            (job.kind === "pending" || !accountIds.has(job.id) || completedAccounts.has(job.id))));
        if (index < 0) break;
        const [job] = queued.splice(index, 1);
        active.set(job, run(job));
      }
      if (!active.size) break;
      const result = await Promise.race(active.values());
      active.delete(result.job);
      if ("error" in result) throw result.error;
      if (result.job.kind === "account") {
        completedAccounts.add(result.job.id);
        // A lease or cooldown can expire during the account request. Discover that
        // parcel's newly eligible supplementation without rerunning completed tasks.
        currentState = loadState(Date.now());
        const followup = manualRefreshTasks(currentState, source, Date.now(), skipRefreshIds,
          forceManualRefresh, webViewEnrichment).find(task =>
          task.kind === "shipment" && task.id === result.job.id);
        if (followup && !scheduledManuals.has(`shipment:${followup.id}`)) {
          scheduledManuals.add(`shipment:${followup.id}`);
          queued.unshift(followup);
        }
      }
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
  lease: FullRefreshLease,
): Promise<RefreshSummary> {
  requireScriptSource(source);
  lease.assertCurrent();
  if (!backgroundHostSafe) {
    await refreshCarrierAuthorityIfNeeded();
    lease.assertCurrent();
  }
  await replayPendingShipmentNotifications(lease.isCurrent);
  lease.assertCurrent();
  const hostPolicy = fullRefreshHostPolicy({
    accountOrderProjection,
    backgroundHostSafe,
  });
  const startedAt = Date.now();
  const initial = loadState(startedAt);
  const notificationContext = {
    previousById: new Map(initial.shipments.map((shipment) => [shipment.identity.id, shipment])),
    batchId: flowId,
  };
  let checkpointBase = initial;
  let currentState = initial;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const promotedPendingShipmentIds: string[] = [];

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
      next = publishDeferredRoutes(next, mutations, Date.now());
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
      next = publishDeferredRoutes(next, mutations, Date.now());
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

  try {
    const accountMutations: DeferredRouteMutations = new Map();
    const accountDeadlineAtMs = deadlineAtMs == null
      ? undefined
      : Math.max(
          startedAt + 1,
          deadlineAtMs - FULL_REFRESH_FINALIZATION_RESERVE_MS,
        );
    const account = await synchronizeAccountList(
      initial,
      source,
      startedAt,
      accountMutations,
      flowId,
      accountDeadlineAtMs,
      hostPolicy.accountFollowupReserveMs,
      lease.signal,
    );
    attempted += account.attempted;
    succeeded += account.succeeded;
    failed += account.failed;
    if (!account.canContinue) {
      return {
        attempted,
        succeeded,
        failed,
        state: initial,
        promotedPendingShipmentIds,
      };
    }
    if (account.succeeded > 0) {
      currentState = checkpoint(account.state, accountMutations, "account_list");
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
    if (!deadlineExpired(enrichmentDeadlineAtMs)) {
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
    );
      attempted += projection.attempted;
      succeeded += projection.succeeded;
      failed += projection.failed;
      currentState = projection.state;
      if (projection.stateChanged) {
        for (const ownerId of projection.projectedOwnerIds) {
          const persisted = currentState.shipments.find(
            (shipment) => shipment.identity.id === ownerId,
          );
          const ownerParcel = account.parcels.find(
            (parcel) => projectionOwnerId(parcel) === ownerId,
          );
          const retainedParcel = ownerParcel
            ? accountParcelWithExistingProjection(
                ownerParcel,
                currentState.shipments,
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
    }

    const enrichment = await refreshShipmentEnrichment(
      currentState, source, flowId, checkpoint, enrichmentDeadlineAtMs,
      skipRefreshIds, forceManualRefresh, hostPolicy.webViewEnrichment, lease.signal,
    );
    currentState = enrichment.state;
    attempted += enrichment.attempted;
    succeeded += enrichment.succeeded;
    failed += enrichment.failed;
    promotedPendingShipmentIds.push(...enrichment.promotedPendingShipmentIds);

    if (hostPolicy.webViewEnrichment && !deadlineExpired(enrichmentDeadlineAtMs)) {
      const missing = await refreshMissingShipmentHistories(
        currentState, source, checkpoint, enrichmentDeadlineAtMs, lease.signal,
      );
      currentState = missing.state;
      attempted += missing.attempted;
      succeeded += missing.succeeded;
      failed += missing.failed;
    }
    lease.assertCurrent();
    if (backgroundHostSafe && succeeded > 0) {
      recordNetworkRefreshSuccess("background");
    }
    return {
      attempted,
      succeeded,
      failed,
      state: currentState,
      promotedPendingShipmentIds,
    };
  } finally {
    // 租约的判定在上面 return 之前就做过了。这里再抛一次会把已经跑完并落盘的那次刷新替换成
    // OperationTimeoutError（出错时还会盖掉真实错误），而重放本身最多又占 15 秒租约。
    if (lease.isCurrent()) {
      await replayPendingShipmentNotifications(lease.isCurrent);
    }
  }
}

export function refreshAllShipments(
  sourceOverride?: BindingSource,
  options: {
    budgetMs?: number;
    accountOrderProjection?: boolean;
    backgroundHostSafe?: boolean;
    forceManualRefresh?: boolean;
  } = {},
): Promise<RefreshSummary> {
  const source = requireScriptSource(
    sourceOverride || SCRIPT_BINDING_SOURCE,
  );
  const existing = refreshCoordinator.full(source);
  if (existing) return existing;
  const flowId = createDiagnosticFlowId("refresh");
  const startedAt = Date.now();
  const requestedBudgetMs = Number(options.budgetMs);
  const budgetMs = Number.isFinite(requestedBudgetMs) && requestedBudgetMs > 0
    ? Math.max(1_000, Math.floor(requestedBudgetMs))
    : undefined;
  const deadlineAtMs = budgetMs == null
    ? undefined
    : deadlineAfter(budgetMs, startedAt);
  const durableLease = acquireDurableRefreshLease(
    `full:${source}`,
    Math.max(30_000, (budgetMs || 120_000) + 5_000),
    startedAt,
  );
  if (!durableLease) {
    const state = loadState(startedAt);
    writeDiagnostic("refresh.skipped", {
      source,
      ...diagnosticState(state),
      result: "active_cross_runtime_refresh",
    });
    return Promise.resolve({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      state,
      promotedPendingShipmentIds: [],
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
      const ownedLease: FullRefreshLease = {
        ...lease,
        isCurrent: () => lease.isCurrent() && durableLease.isCurrent(),
        assertCurrent: () => {
          lease.assertCurrent();
          if (!durableLease.isCurrent()) throw new OperationTimeoutError();
        },
      };
      return runFullRefresh(
        source,
        deadlineAtMs,
        flowId,
        skipRefreshIds,
        options.accountOrderProjection !== false,
        Boolean(options.backgroundHostSafe),
        Boolean(options.forceManualRefresh),
        ownedLease,
      );
    },
    (detail) => detail.refreshed,
    {
      blockerDeadlineAtMs,
      ...(deadlineAtMs == null ? {} : { operationDeadlineAtMs: deadlineAtMs }),
    },
  );
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
  ).finally(() => durableLease.release());
}

export { refreshAccountFollowups as runAccountFollowupsForTesting };
export { refreshMissingShipmentHistories as runMissingShipmentHistoriesForTesting };
export { runShipmentRefreshById as runShipmentRefreshForTesting };

export { refreshShipmentEnrichment as runShipmentEnrichmentForTesting };
