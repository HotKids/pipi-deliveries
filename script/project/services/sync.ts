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
import { notifyShipmentChanges } from "./notifications";
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
  saveShipmentRoute,
  type ShipmentRouteMutation,
  type ShipmentRoutePublication,
} from "./routes";
import {
  absorbAutomaticShipment,
  absorbHistoricalShipment,
  absorbManualShipment,
  activateCainiaoManualFallback,
  beginManualRefreshAttempt,
  applyAccountShipment,
  applyManualShipment,
  applySameSourceTimeline,
  applyTargetedAccountShipment,
  automaticBindingIdentityOf,
  automaticSourceOf,
  cainiaoAutomaticNeedsH5Supplement,
  clearCainiaoManualFallback,
  displayWaybill,
  hasCachedKdniaoTimeline,
  hasCachedTimelineBeforeKdniao,
  hasTimelineStartBeforeKdniao,
  hasSettledTimelineHistory,
  isHistoricalAccountDuplicate,
  jingDongAutomaticH5TimelineAvailable,
  isJingDongSourceShipment,
  isShunFengSourceShipment,
  manualTimelineOwnsShipment,
  ownsManualRefreshLease,
  releaseManualRefreshLease,
  recordAutomaticOwnerRefresh,
  sameCanonicalWaybill,
  sameDisplayedWaybill,
  selectShipmentDetailTimeline,
  sourceTimelineHasStart,
  shouldScheduleManualRefresh,
  needsAutomaticManualFallback,
  needsDetailFallback,
  unprojectedAccountOrder,
  usesManualSourceQuery,
} from "./shipment-policy";
import {
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
  containsTimelineStartTrack,
  shipmentPresentationStatus,
  shouldRefreshShipment,
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
  shouldRetryAccountOrderProjection,
} from "./account-sync-policy";
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
import { normalizeAccountParcelCarrier } from "./account-carrier-normalization";
import { GatewayError } from "./gateway";
import {
  kuaidi100ToastMessage,
  queryKuaidi100JdTimeline,
  type Kuaidi100H5Diagnostics,
} from "./kuaidi100-h5";
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
const DETAIL_MANUAL_REFRESH_BUDGET_MS = 10_000;
const MANUAL_QUERY_BUDGET_MS = 30_000;
const MANUAL_REFRESH_TASK_BUDGET_MS = 10_000;
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
  feedback?: string;
};
type ShipmentRefreshOptions = {
  forceAccountOrderProjection?: boolean;
  forceManualRefresh?: boolean;
  includeKdniaoFallback?: boolean;
  trigger?:
    | "detail_open"
    | "detail_pull"
    | "manual_submit"
    | "identity_projection";
  signal?: AbortSignal;
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
    timelineProvider: timelineCapability(shipment.timeline.provider),
    effectiveTrackCount: timedTracks(shipment.timeline.tracks).length,
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

function storedWebRoute(shipment: Shipment, now = Date.now()): string {
  if (
    (!shipment.identity.manuallyAdded && !isShunFengSourceShipment(shipment)) ||
    shipment.route?.kind !== "web"
  ) return "";
  return loadShipmentRoute(
    shipment.identity.id,
    shipment.route.source,
    now,
    "web",
  );
}

async function refreshWebTimeline(
  shipment: Shipment,
  routeUrl: string,
  deadlineAtMs?: number,
  observe?: (diagnostics: WebTimelineDiagnostics) => void,
  signal?: AbortSignal,
): Promise<Shipment | null> {
  if (
    (!shipment.identity.manuallyAdded && !isShunFengSourceShipment(shipment)) ||
    !routeUrl
  ) return null;
  const now = Date.now();
  const timeline = await scrapeWebTimeline({
    routeUrl,
    waybill: displayWaybill(shipment),
    courierCode: shipment.identity.courierCode,
    companyName: shipment.identity.companyName,
    deadlineAtMs,
    signal,
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

async function refreshKuaidi100H5(
  shipment: Shipment,
  deadlineAtMs?: number,
  signal?: AbortSignal,
  observe?: (diagnostics: Kuaidi100H5Diagnostics) => void,
): Promise<Shipment | null> {
  assertRefreshSignal(signal);
  if (
    !shipment.identity.manuallyAdded &&
    !isShunFengSourceShipment(shipment) &&
    !needsAutomaticManualFallback(shipment) &&
    !cainiaoAutomaticNeedsH5Supplement(shipment) &&
    (
      !isJingDongAutomaticShipment(shipment) ||
      !normalizedProjectedWaybill(shipment.identity)
    )
  ) return null;
  const now = Date.now();
  const timeline = await queryKuaidi100JdTimeline({
    waybill: displayWaybill(shipment),
    phoneTail: shipment.identity.phoneTail,
    courierCode: shipment.identity.courierCode,
    companyName: shipment.identity.companyName,
    deadlineAtMs,
    signal,
    observe,
  });
  assertRefreshSignal(signal);
  return timeline ? applySameSourceTimeline(shipment, timeline, now) : null;
}

async function refreshCainiaoH5(
  shipment: Shipment,
  routeUrl: string,
  deadlineAtMs?: number,
  observe?: (diagnostics: CainiaoH5Diagnostics) => void,
  signal?: AbortSignal,
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

function projectionRouteHash(parcel: AccountParcelDto): string {
  // A capture-strategy change must invalidate failures recorded by an older
  // extractor so installing the fix retries immediately instead of inheriting cooldown.
  return privateHash(
    `${ACCOUNT_ORDER_PROJECTION_STRATEGY}\0${String(parcel.projectionUrl || "")}`,
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

function projectionAttempt(
  shipment: Shipment,
  routeHash: string,
  attemptId: string,
  now: number,
  deadlineAtMs?: number,
): Shipment {
  const previous = shipment.identity.orderProjectionRetry;
  const previousRouteHash = String(previous?.routeHash || "").trim().toLowerCase();
  const previousFailedAtMs = Number(previous?.failedAtMs);
  return {
    ...shipment,
    identity: {
      ...shipment.identity,
      orderProjectionRetry: {
        routeHash,
        ...(previousRouteHash === routeHash &&
            Number.isFinite(previousFailedAtMs) &&
            previousFailedAtMs > 0
          ? { failedAtMs: previousFailedAtMs }
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
): boolean {
  const retry = shipment?.identity.orderProjectionRetry;
  return retry?.attemptId === attemptId &&
    activeAccountOrderProjectionAttempt(retry, routeHash, now);
}

async function waitForProjectionAttemptRelease(
  shipmentId: string,
  signal?: AbortSignal,
): Promise<ShipmentRefreshResult | null> {
  const waitDeadlineAtMs = Date.now() +
    ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS + FORCED_PROJECTION_WAIT_SLICE_MS;
  while (true) {
    assertRefreshSignal(signal);
    const state = loadState();
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
    await new Promise<void>((resolve) => {
      setTimeout(
        resolve,
        Math.max(
          1,
          Math.min(
            FORCED_PROJECTION_WAIT_SLICE_MS,
            remainingAttemptMs,
            remainingWaitMs,
          ),
        ),
      );
    });
  }
}

function recordProjectionFailure(
  shipments: readonly Shipment[],
  ownerId: string,
  routeHash: string,
  failedAtMs: number,
): Shipment[] {
  const owner = shipments.find((shipment) => shipment.identity.id === ownerId);
  if (!owner || normalizedProjectedWaybill(owner.identity)) return [...shipments];
  return replaceById(shipments, {
    ...owner,
    identity: {
      ...owner.identity,
      orderProjectionRetry: { routeHash, failedAtMs },
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
    if (!parcel.accountOrder || !parcel.projectionUrl) return false;
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
    const routeHash = projectionRouteHash(parcel);
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
    const routeHash = projectionRouteHash(parcel);
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
  const accountFollowupCandidates = shipments
    .filter((shipment) =>
      shipment.identity.bindingSource === source &&
      !shipment.identity.manuallyAdded &&
      !isJingDongSourceShipment(shipment) &&
      Boolean(shipment.accountRecord) &&
      !skipRefreshIds.has(shipment.identity.id) &&
      !hasSettledTimelineHistory(shipment) &&
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
          budgetMs: stageBudgetMs(
            accountFollowupDeadlineAtMs,
            startedAtMs,
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
            incoming,
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
    queryKuaidi100: () => refreshKuaidi100H5(seed, deadlineAtMs, signal),
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
  type ManualRefreshTask =
    | { kind: "shipment"; id: string; lastAttemptAtMs: number }
    | { kind: "pending"; id: string; lastAttemptAtMs: number };
  const tasks: ManualRefreshTask[] = [
    ...shipments
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
    ...pendingQueries
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

  const orderedTasks = oldestBatchIndices(
    tasks.map((task) => task.lastAttemptAtMs),
    tasks.length,
    currentState.revision,
  )
    .map((position) => tasks[position]);
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
            const result = await queryManualForSource({
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
              pickerFirst: current.identity.manuallyAdded ||
                isShunFengSourceShipment(current),
              includeKdniaoFallback: true,
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
      attempted++;
      const releaseAttempt = () =>
        releaseShipmentAttempt(task.id, attemptId, stage);
      const outcome = taskAttempt.outcome === "result"
        ? taskAttempt.result || null
        : null;
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
          shipments[index] = deferIncomingRoute(
            current,
            outcome.shipment,
            outcome.routeUrl,
            now,
            routeMutations,
          );
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
    refreshKuaidi100H5(shipment, deadlineAtMs, options.signal));
  const queryKdniao = dependencies.queryKdniao || (async () => {
    const outcome = await queryManualForSource({
      ...manualQueryInput,
      fallbackOnly: true,
      includeKdniaoFallback: true,
      diagnosticStage: "kdniao_fallback",
    });
    return outcome.shipment;
  });

  const contest = await runManualDetailSourceContest({
    queryMoto: () => queryMoto(seed, deadlineAtMs, options.signal),
    queryKuaidi100: () =>
      queryKuaidi100(seed, deadlineAtMs, options.signal),
    queryKdniao: () => queryKdniao(seed, deadlineAtMs, options.signal),
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

export async function addManualShipment(input: {
  waybill: string;
  phoneTail?: string;
}): Promise<{ shipment: Shipment; state: AppState }> {
  const preview = await queryManualShipmentPreview(input);
  const state = commitManualShipmentPreview(preview);
  const previewShipment = preview.shipment;
  if (!previewShipment) throw new Error("暂无轨迹");
  const shipment = state.shipments.find(
    (item) => item.identity.id === previewShipment.identity.id,
  );
  if (!shipment) throw new Error("暂无轨迹");
  return { shipment, state };
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

export async function bindPhoneAndSync(
  source: BindingSource,
  phone: string,
  code: string,
): Promise<AppState> {
  const bound = await bindPhone(source, phone, code);
  try {
    return (await refreshAllShipments(source)).state;
  } catch {
    return bound;
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
): Promise<ShipmentRefreshResult> {
  const startedAt = Date.now();
  const flowId = createDiagnosticFlowId("detail");
  let base = loadState(startedAt);
  let original = base.shipments.find(
    (item) => item.identity.id === shipmentId,
  );
  if (!original) throw new Error("该快递已从列表中移除");
  const notificationPrevious = original;
  const source = requireScriptSource(
    original.identity.bindingSource || SCRIPT_BINDING_SOURCE,
  );
  const deadlineAtMs = lease.deadlineAtMs;
  const signal = lease.signal;
  const trigger = options.trigger || "detail_open";
  const needsAutomaticFallback = needsAutomaticManualFallback(original);
  const requestedJingDongDetailSupplement =
    isJingDongAutomaticShipment(original) && (
      trigger === "identity_projection" ||
      trigger === "detail_open" ||
      trigger === "detail_pull"
    );
  const explicitTimelineRefresh = trigger === "detail_pull" ||
    trigger === "manual_submit" ||
    (trigger === "detail_open" && needsAutomaticFallback) ||
    requestedJingDongDetailSupplement;
  assertRefreshSignal(signal);
  assertWithinDeadline(deadlineAtMs);
  writeDiagnostic("detail.refresh.started", {
    flowId,
    source,
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
  const manualWebRoute = storedWebRoute(original, startedAt);
  const settledHistory = hasSettledTimelineHistory(original);
  const requestedWebTimeline = explicitTimelineRefresh && Boolean(manualWebRoute);
  const requestedDirectKuaidi100Timeline = explicitTimelineRefresh && (
    requestedJingDongDetailSupplement ||
    (!manualWebRoute && (
      original.identity.manuallyAdded ||
      isShunFengSourceShipment(original)
    ))
  );
  const requestedFinalFallback = Boolean(
    options.includeKdniaoFallback === true &&
    explicitTimelineRefresh &&
    !unprojectedAccountOrder(original) &&
    needsDetailFallback(original) &&
    !hasCachedKdniaoTimeline(original),
  );
  const refreshDue = forceAccountOrderProjection ||
    Boolean(options.forceManualRefresh) ||
    requestedJingDongDetailSupplement ||
    requestedDirectKuaidi100Timeline ||
    requestedWebTimeline ||
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
  let refreshed = original;
  let cainiaoRouteUrl = storedCainiaoRoute(original, startedAt);
  let webRouteUrl = manualWebRoute;
  let changed = false;
  let feedback = "";
  let stage = "dispatch";
  try {
      let accountError: unknown = null;
      if (original.accountRecord) {
        stage = "cached_order_projection";
        try {
          let projectionRetry:
            Shipment["identity"]["orderProjectionRetry"] = undefined;
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
          if (
            parcel?.accountOrder &&
            parcel.projectionUrl &&
            accountOrderReadyForProjection(
              parcel.normalizedStatusSemantic || parcel.semantic,
            ) &&
            !normalizedProjectedWaybill(original.identity) &&
            !deadlineExpired(deadlineAtMs)
          ) {
            const ownerId = projectionOwnerId(parcel);
            const ownerFingerprint = projectionOwnerFingerprint(ownerId);
            const routeHash = projectionRouteHash(parcel);
            const freshBase = loadState();
            const freshOwner = freshBase.shipments.find(
              (shipment) => shipment.identity.id === ownerId,
            );
            if (freshOwner && normalizedProjectedWaybill(freshOwner.identity)) {
              parcel = accountParcelWithExistingProjection(parcel, [freshOwner]);
              writeDiagnostic("order.projection.skipped", {
                flowId,
                source,
                stage: "detail_webview",
                ownerFingerprint,
                result: "already_projected",
              });
            } else if (
              !shouldRetryAccountOrderProjection(
                freshOwner?.identity.orderProjectionRetry,
                routeHash,
                Date.now(),
                forceAccountOrderProjection,
              )
            ) {
              writeDiagnostic("order.projection.skipped", {
                flowId,
                source,
                stage: "detail_webview",
                ownerFingerprint,
                result: activeAccountOrderProjectionAttempt(
                    freshOwner?.identity.orderProjectionRetry,
                    routeHash,
                    Date.now(),
                  )
                  ? "active_attempt"
                  : "cooldown",
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
              const reserved = projectionAttempt(
                freshOwner,
                routeHash,
                attemptId,
                Date.now(),
                attemptDeadlineAtMs,
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
                  result: forceAccountOrderProjection ? "forced" : "scheduled",
                });
                try {
                  const unresolvedOwner = parcel.ownerId;
                  parcel = await projectAccountOrderWithCarrier(
                    parcel,
                    projectionDeadlineAtMs,
                    deadlineAtMs,
                    (diagnostics) => {
                      projectionDiagnostics = diagnostics;
                    },
                    signal,
                  );
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
                    projectionRetry = {
                      routeHash,
                      failedAtMs: Date.now(),
                    };
                  } else {
                    projectionRetry = undefined;
                  }
                } catch (error) {
                  rethrowRefreshCancellation(error, signal);
                  projectionRetry = {
                    routeHash,
                    failedAtMs: Date.now(),
                  };
                  writeDiagnostic("order.projection.failed", {
                    flowId,
                    source,
                    stage: "detail_webview",
                    ownerFingerprint,
                    ...diagnosticErrorDetails(error),
                    ...(projectionDiagnostics || {}),
                  }, "warning");
                }
                const ownershipState = loadState();
                const ownershipOwner = ownershipState.shipments.find(
                  (shipment) => shipment.identity.id === ownerId,
                );
                if (!ownsProjectionAttempt(
                  ownershipOwner,
                  routeHash,
                  attemptId,
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
        } catch (error) {
          rethrowRefreshCancellation(error, signal);
          accountError = error;
        }
      }

      let enrichmentBase = refreshed;
      const enrichmentStartedAt = Date.now();
      let cainiaoDiagnostics: CainiaoH5Diagnostics | null = null;
      let webDiagnostics: WebTimelineDiagnostics | null = null;
      let kuaidi100Diagnostics: Kuaidi100H5Diagnostics | null = null;
      const jingDongAutomaticH5Available =
        jingDongAutomaticH5TimelineAvailable(enrichmentBase);
      if (requestedJingDongDetailSupplement) {
        const sourceTimeline = enrichmentBase.sourceTimeline ||
          enrichmentBase.timeline;
        writeDiagnostic(
          jingDongAutomaticH5Available
            ? "detail.refresh.stage_succeeded"
            : "detail.refresh.stage_failed",
          {
            flowId,
            source,
            stage: "jingdong_h5",
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
      const jingDongManualFallbackRequested =
        requestedJingDongDetailSupplement &&
        Boolean(normalizedProjectedWaybill(enrichmentBase.identity)) &&
        !jingDongAutomaticH5Available;
      let cainiaoH5Succeeded = false;
      const cainiaoH5Requested = explicitTimelineRefresh &&
        cainiaoAutomaticNeedsH5Supplement(enrichmentBase);
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
          timelineProvider: "cainiao_h5",
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
          );
          assertRefreshSignal(signal);
          if (cainiaoH5) {
            cainiaoH5Succeeded = true;
            refreshed = clearCainiaoManualFallback(cainiaoH5);
            enrichmentBase = refreshed;
            changed = true;
            feedback = "轨迹加载成功";
            const detailTimeline = selectShipmentDetailTimeline(cainiaoH5);
            writeDiagnostic("detail.refresh.stage_succeeded", {
              flowId,
              source,
              stage,
              timelineProvider: "cainiao_h5",
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
              timelineProvider: "cainiao_h5",
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
            timelineProvider: "cainiao_h5",
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
      const pickerSupplementRequested = ordinaryAutomaticSupplementRequested ||
        jingDongManualFallbackRequested ||
        cainiaoManualFallbackRequested;
      if (pickerSupplementRequested) {
        stage = "picker_query";
        const pickerOutcome = await queryManualForSource({
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
        if (
          pickerOutcome.shipment &&
          timedTracks(pickerOutcome.shipment.timeline.tracks).length
        ) {
          refreshed = applyManualShipment(
            refreshed,
            pickerOutcome.shipment,
            Date.now(),
          );
          enrichmentBase = refreshed;
          changed = true;
          feedback = "轨迹加载成功";
        }
      }
      const ordinaryAutomaticPrimaryRequested = explicitTimelineRefresh &&
        (
          needsAutomaticManualFallback(enrichmentBase) ||
          cainiaoManualFallbackRequested
        ) &&
        !hasTimelineStartBeforeKdniao(enrichmentBase);
      const jingDongPrimaryRequested = jingDongManualFallbackRequested &&
        !hasTimelineStartBeforeKdniao(enrichmentBase);
      const directKuaidi100PrimaryRequested = requestedDirectKuaidi100Timeline &&
        (!requestedJingDongDetailSupplement || jingDongPrimaryRequested);
      const h5Kind = (directKuaidi100PrimaryRequested ||
          ordinaryAutomaticPrimaryRequested) && (
          enrichmentBase.identity.manuallyAdded ||
          isShunFengSourceShipment(enrichmentBase) ||
          ordinaryAutomaticPrimaryRequested ||
          (
            isJingDongAutomaticShipment(enrichmentBase) &&
            normalizedProjectedWaybill(enrichmentBase.identity)
          )
        )
        ? "kuaidi100"
        : explicitTimelineRefresh && webRouteUrl
        ? "web"
        : "none";
      const primaryContestRequested = explicitTimelineRefresh && (
        enrichmentBase.identity.manuallyAdded ||
        isShunFengSourceShipment(enrichmentBase) ||
        ordinaryAutomaticPrimaryRequested ||
        h5Kind === "kuaidi100"
      );
      const motoSupported = primaryContestRequested &&
        !isJingDongSourceShipment(enrichmentBase) &&
        !isShunFengSourceShipment(enrichmentBase);
      const h5Stage = h5Kind === "kuaidi100"
        ? "kuaidi100_query"
        : "web_timeline";
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
          timelineProvider: h5Kind === "kuaidi100"
            ? "kuaidi100_h5"
            : h5Kind,
          budgetMs: stageBudgetMs(h5DeadlineAtMs, h5StartedAt),
        });
      }
      const queryH5 = () => deadlineExpired(deadlineAtMs)
        ? Promise.resolve(null as Shipment | null)
        : h5Kind === "web"
          ? refreshWebTimeline(
              enrichmentBase,
              webRouteUrl,
              h5DeadlineAtMs,
              (diagnostics) => { webDiagnostics = diagnostics; },
              signal,
            )
          : h5Kind === "kuaidi100"
          ? refreshKuaidi100H5(
              enrichmentBase,
              h5DeadlineAtMs,
              signal,
              (diagnostics) => {
                kuaidi100Diagnostics = diagnostics;
              },
            )
          : Promise.resolve(null);

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
            const outcome = await queryManualForSource({
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
            return outcome.shipment &&
                timedTracks(outcome.shipment.timeline.tracks).length
              ? outcome.shipment
              : null;
          },
          queryKuaidi100: queryH5,
          ...(options.includeKdniaoFallback === true
            ? {
                queryKdniao: async () => {
                  stage = "kdniao_fallback";
                  const outcome = await queryManualForSource({
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
                  return outcome.shipment &&
                      timedTracks(outcome.shipment.timeline.tracks).length
                    ? outcome.shipment
                    : null;
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
            return hasTimelineStartBeforeKdniao(accumulated);
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
      if (h5Kind === "kuaidi100") {
        feedback = kuaidi100ToastMessage(h5Error, kuaidi100Diagnostics);
      }
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
          timelineProvider: h5Kind === "kuaidi100"
            ? "kuaidi100_h5"
            : h5Kind,
          carrierCode: detailTimeline.courierCode,
          effectiveTrackCount: timedTracks(detailTimeline.tracks).length,
          ...(kuaidi100Diagnostics || {}),
          durationMs: Date.now() - h5StartedAt,
          result: "timed_tracks",
        });
      } else if (h5Kind !== "none") {
        writeDiagnostic("detail.refresh.stage_failed", {
          flowId,
          source,
          stage: h5Stage,
          timelineProvider: h5Kind === "kuaidi100"
            ? "kuaidi100_h5"
            : h5Kind,
          durationMs: Date.now() - h5StartedAt,
          ...(h5Error
            ? diagnosticErrorDetails(h5Error)
            : {
                ...(kuaidi100Diagnostics || {}),
                ...(webDiagnostics || {}),
                result: "no_timed_tracks",
              }),
        }, "warning");
      }

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
        feedback = kdniaoResult
          ? "轨迹加载成功"
          : primarySuccessCount > 0
            ? "轨迹加载成功"
            : feedback || "轨迹更新失败，已显示本地缓存";
        writeDiagnostic("detail.refresh.primary_contest.completed", {
          flowId,
          source,
          stage: "primary_contest",
          motoSupported,
          motoSucceeded: Boolean(motoResult),
          kuaidi100Succeeded: Boolean(h5Result),
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
        !jingDongAutomaticH5Available &&
        !cainiaoH5Succeeded &&
        !unprojectedAccountOrder(refreshed) &&
        needsDetailFallback(refreshed) &&
        !hasCachedKdniaoTimeline(refreshed) &&
        options.includeKdniaoFallback === true &&
        explicitTimelineRefresh &&
        !deadlineExpired(deadlineAtMs)
      ) {
        stage = "kdniao_fallback";
        try {
          const outcome = await queryManualForSource({
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
          if (
            outcome.shipment &&
            timedTracks(outcome.shipment.timeline.tracks).length
          ) {
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
      if (!changed && accountError) throw accountError;
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

  if (
    changed &&
    shipmentEffectiveFingerprint(refreshed) ===
      shipmentEffectiveFingerprint(original)
  ) {
    changed = false;
    feedback = "";
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
      ...(feedback ? { feedback } : {}),
    };
  }
  if (deadlineExpired(deadlineAtMs) || !lease.isCurrent()) {
    throw new OperationTimeoutError();
  }
  const commit = commitTargetShipmentRefresh(
    base,
    refreshed,
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
      ...(feedback ? { feedback } : {}),
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
  await notifyShipmentChanges(
    new Map([[notificationPrevious.identity.id, notificationPrevious]]),
    [persisted],
  );
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
    ...(feedback ? { feedback } : {}),
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
      refreshOptions.trigger === "manual_submit"
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
  const hostPolicy = fullRefreshHostPolicy({
    accountOrderProjection,
    backgroundHostSafe,
  });
  const startedAt = Date.now();
  const initial = loadState(startedAt);
  let checkpointBase = initial;
  let currentState = initial;
  let notificationState = initial;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const promotedPendingShipmentIds: string[] = [];
  const previousById = new Map(
    initial.shipments.map((shipment) => [shipment.identity.id, shipment]),
  );

  const checkpoint: RefreshCheckpoint = (candidate, mutations, stage) => {
    lease.assertCurrent();
    const commit = commitRefreshState(
      checkpointBase,
      candidate,
      source,
      Date.now(),
      lease,
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
    notificationState = next;
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
    notificationState = next;
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
    if (
      hostPolicy.accountOrderProjection &&
      !deadlineExpired(enrichmentDeadlineAtMs)
    ) {
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
      hostPolicy.accountOrderProjection,
      lease.signal,
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

    if (
      hostPolicy.accountFollowups &&
      !deadlineExpired(enrichmentDeadlineAtMs)
    ) {
      const accountFollowups = await refreshAccountFollowups(
        currentState,
        source,
        Date.now(),
        flowId,
        checkpoint,
        enrichmentDeadlineAtMs,
        skipRefreshIds,
        lease.signal,
      );
      currentState = accountFollowups.state;
      attempted += accountFollowups.attempted;
      succeeded += accountFollowups.succeeded;
      failed += accountFollowups.failed;
    }

    if (
      hostPolicy.manualAndPending &&
      !deadlineExpired(enrichmentDeadlineAtMs)
    ) {
      const local = await refreshManualAndPending(
        currentState,
        source,
        Date.now(),
        flowId,
        checkpoint,
        enrichmentDeadlineAtMs,
        skipRefreshIds,
        forceManualRefresh,
        hostPolicy.webViewEnrichment,
        lease.signal,
      );
      currentState = local.state;
      attempted += local.attempted;
      succeeded += local.succeeded;
      failed += local.failed;
      promotedPendingShipmentIds.push(
        ...local.promotedPendingShipmentIds.filter(
          (shipmentId) => !promotedPendingShipmentIds.includes(shipmentId),
        ),
      );
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
    if (lease.isCurrent()) {
      await notifyShipmentChanges(
        previousById,
        notificationState.shipments.filter(
          (shipment) => shipment.identity.bindingSource === source,
        ),
        lease.isCurrent,
      );
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
      return runFullRefresh(
        source,
        deadlineAtMs,
        flowId,
        skipRefreshIds,
        options.accountOrderProjection !== false,
        Boolean(options.backgroundHostSafe),
        Boolean(options.forceManualRefresh),
        lease,
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
