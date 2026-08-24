import type {
  AppState,
  BindingSource,
  PendingManualQuery,
  RefreshSummary,
  Shipment,
} from "../models";
import {
  fetchAccountParcels,
  parcelToShipment,
  refreshAccountParcel,
  verifyAccountBinding,
} from "./account-sync";
import type { AccountParcelDto } from "./account-parser";
import {
  queryKuaidi100Shipment,
  queryManualForSource,
} from "./manual-query";
import { notifyShipmentChanges } from "./notifications";
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
  absorbHistoricalShipment,
  absorbManualShipment,
  beginManualRefreshAttempt,
  applyAccountShipment,
  applyManualShipment,
  applyTargetedAccountShipment,
  displayWaybill,
  isHistoricalAccountDuplicate,
  manualTimelineOwnsShipment,
  ownsManualRefreshLease,
  prefersKuaidi100First,
  releaseManualRefreshLease,
  sameCanonicalWaybill,
  shouldScheduleManualRefresh,
  sourceTimelineOwnsShipment,
  unprojectedAccountOrder,
} from "./shipment-policy";
import {
  addBinding,
  bindingsForSource,
  commitRefreshState,
  commitRoutePointers,
  commitTargetShipmentRefresh,
  isImportSuppressed,
  isWaybillTombstoned,
  loadState,
  privateHash,
  removeBinding,
  saveState,
} from "./storage";
import {
  normalizeWaybill,
  normalizedProjectedWaybill,
  shouldRefreshShipment,
  sortShipments,
  timedTracks,
} from "./status";
import { requestWidgetReload } from "./widgets";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import {
  assertWithinDeadline,
  deadlineAfter,
  deadlineExpired,
  OperationTimeoutError,
} from "./deadline";
import {
  ACCOUNT_DETAIL_BUDGET_MS,
  accountOrderProjectionAttemptRemainingMs,
  activeAccountOrderProjectionAttempt,
  accountChildDeadline,
  rotatingBatchIndices,
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
  projectAccountOrder,
  type AccountOrderProjectionDiagnostics,
} from "./account-order-projection";
import { GatewayError } from "./gateway";
import {
  RefreshCoordinator,
  type FullRefreshLease,
} from "./refresh-coordination";

const PENDING_RETRY_MS = EXPRESS_POLICY.pendingQueries.retryMs;
const DETAIL_REFRESH_BUDGET_MS = 10_000;
const MANUAL_QUERY_BUDGET_MS = 30_000;
const FULL_REFRESH_BUDGET_MS = 30_000;
const FULL_REFRESH_COORDINATION_WAIT_MS = 2_000;
const LOCAL_REFRESH_RESERVE_MS = 5_000;
const FINALIZATION_RESERVE_MS = 3_000;
const ACCOUNT_ORDER_PROJECTIONS_PER_REFRESH = 1;
const ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS = 12_000;
const FORCED_PROJECTION_WAIT_SLICE_MS = 100;
const ACCOUNT_DETAILS_PER_REFRESH = 1;
const MANUAL_TASKS_PER_REFRESH = 2;
type ShipmentRefreshResult = {
  shipment: Shipment;
  state: AppState;
  refreshed: boolean;
};
type TargetRefreshLease = Readonly<{
  deadlineAtMs: number;
  isCurrent: () => boolean;
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
      .filter((shipment) => shipment.route?.kind === "cainiao")
      .map((shipment) => shipment.identity.id),
    ...state.pendingQueries
      .filter((pending) => pending.route?.kind === "cainiao")
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
            !normalizedProjectedWaybill(shipment.identity) &&
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
  return `${pending.id}:${pending.lastAttemptAtMs}:${pending.attempts}:${pending.createdAtMs}`;
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
  const pointer = incoming.route?.kind === "cainiao" ? incoming.route : null;
  if (!pointer || !routeUrl) return merged;
  if (
    merged.route &&
    (merged.route.kind !== pointer.kind || merged.route.source !== pointer.source)
  ) {
    return merged;
  }
  const hadStoredRoute = Boolean(
    merged.route &&
    loadShipmentRoute(merged.identity.id, merged.route.source, now),
  );
  queueRouteMutation(mutations, {
    owner: "shipment",
    expectedVersion: shipmentRouteVersion(merged),
    kind: "save",
    targetId: merged.identity.id,
    source: pointer.source,
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
  const pointer = incoming.route?.kind === "cainiao" ? incoming.route : null;
  const key = routeMutationKey("shipment", merged.identity.id);
  if (mutations.has(key)) return merged;
  const usableCurrent = merged.route?.kind === "cainiao" && Boolean(
    loadShipmentRoute(merged.identity.id, merged.route.source, now),
  );
  if (usableCurrent || !pointer) return merged;
  if (merged.route) merged = { ...merged, route: null };
  if (loadShipmentRoute(incoming.identity.id, pointer.source, now)) {
    queueRouteMutation(mutations, {
      owner: "shipment",
      expectedVersion: shipmentRouteVersion(merged),
      kind: "move",
      fromId: incoming.identity.id,
      targetId: merged.identity.id,
      source: pointer.source,
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
  const pointer = pending.route?.kind === "cainiao" ? pending.route : null;
  const key = routeMutationKey("shipment", merged.identity.id);
  if (mutations.has(key)) return merged;
  const usableCurrent = merged.route?.kind === "cainiao" && Boolean(
    loadShipmentRoute(merged.identity.id, merged.route.source, now),
  );
  if (usableCurrent || !pointer) return merged;
  if (merged.route) merged = { ...merged, route: null };
  if (loadShipmentRoute(pending.id, pointer.source, now)) {
    queueRouteMutation(mutations, {
      owner: "shipment",
      expectedVersion: shipmentRouteVersion(merged),
      kind: "move",
      fromId: pending.id,
      targetId: merged.identity.id,
      source: pointer.source,
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
  const pointer = incoming.route?.kind === "cainiao" ? incoming.route : null;
  const existingRoute = current.route?.kind === "cainiao" && Boolean(
    loadShipmentRoute(current.id, current.route.source, now),
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
    url: routeUrl,
  });
  return { ...incoming, route: existingRoute };
}

function stateWithRoutePublications(
  state: AppState,
  publications: readonly ShipmentRoutePublication[],
  mutations: DeferredRouteMutations,
): AppState {
  const shipmentRoutes = new Map<string, BindingSource>();
  const pendingRoutes = new Map<string, BindingSource>();
  for (const publication of publications) {
    const mutation = mutations.get(publication.key);
    if (!mutation) continue;
    if (mutation.owner === "shipment") {
      shipmentRoutes.set(publication.targetId, publication.source);
    } else {
      pendingRoutes.set(publication.targetId, publication.source);
    }
  }
  return {
    ...state,
    shipments: state.shipments.map((shipment) => {
      const routeSource = shipmentRoutes.get(shipment.identity.id);
      return routeSource
        ? { ...shipment, route: { kind: "cainiao" as const, source: routeSource } }
        : shipment;
    }),
    pendingQueries: state.pendingQueries.map((pending) => {
      const routeSource = pendingRoutes.get(pending.id);
      return routeSource
        ? { ...pending, route: { kind: "cainiao" as const, source: routeSource } }
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
  const pointer = pending.route?.kind === "cainiao" ? pending.route : null;
  const usableCurrent = merged.route?.kind === "cainiao" && Boolean(
    loadShipmentRoute(merged.identity.id, merged.route.source, now),
  );
  if (usableCurrent || !pointer) return merged;
  if (merged.route) merged = { ...merged, route: null };
  try {
    if (moveShipmentRoute(
      pending.id,
      merged.identity.id,
      pointer.source,
      now,
    )) {
      return { ...merged, route: pointer };
    }
  } catch {
    /* the promoted shipment remains usable through its local timeline */
  }
  return merged;
}

function k100FallbackNeeded(shipment: Shipment, now: number): boolean {
  if (shipment.identity.manuallyAdded) return false;
  if (manualTimelineOwnsShipment(shipment)) return false;
  if (prefersKuaidi100First(shipment)) return false;
  if (sourceTimelineOwnsShipment(shipment)) return false;
  if (unprojectedAccountOrder(shipment)) return false;
  if (!shouldRefreshShipment(shipment, now)) return false;
  return true;
}

async function refreshK100(
  shipment: Shipment,
  source: BindingSource,
  sourceBindings: ReturnType<typeof bindingsForSource>,
  now: number,
  deadlineAtMs?: number,
): Promise<Shipment> {
  const queried = await queryKuaidi100Shipment({
    waybill: displayWaybill(shipment),
    phoneTail: shipment.identity.phoneTail,
    phoneTails: sourceBindings.map((binding) => binding.phone.slice(-4)),
    courierCode: shipment.identity.courierCode,
    companyName: shipment.identity.companyName,
    bindingSource: source,
    deadlineAtMs,
  });
  return applyManualShipment(shipment, queried, now);
}

function stageBudgetMs(deadlineAtMs?: number, now = Date.now()): number {
  return deadlineAtMs == null ? FULL_REFRESH_BUDGET_MS : Math.max(0, deadlineAtMs - now);
}

function projectionOwnerId(parcel: AccountParcelDto): string {
  return `${parcel.source}:account:${normalizeWaybill(parcel.ownerId)}`;
}

function projectionRouteHash(parcel: AccountParcelDto): string {
  return privateHash(String(parcel.projectionUrl || ""));
}

function projectionOwnerFingerprint(ownerId: string): string {
  return privateHash(ownerId).slice(0, 12);
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
): Promise<ShipmentRefreshResult | null> {
  const waitDeadlineAtMs = Date.now() +
    ACCOUNT_ORDER_PROJECTION_ATTEMPT_MS + FORCED_PROJECTION_WAIT_SLICE_MS;
  while (true) {
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
        !normalizedProjectedWaybill(owner.identity)
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

function accountParcelWithExistingProjection(
  parcel: AccountParcelDto,
  shipments: readonly Shipment[],
): AccountParcelDto {
  if (!parcel.accountOrder) return parcel;
  const expectedId = `${parcel.source}:account:${normalizeWaybill(parcel.ownerId)}`;
  const existingOwner = shipments.find(
    (item) => item.identity.id === expectedId,
  );
  const existingProjection = normalizedProjectedWaybill(existingOwner?.identity);
  return existingProjection
    ? {
        ...parcel,
        waybill: existingProjection,
        courierCode: existingOwner?.identity.courierCode || parcel.courierCode,
        companyName: existingOwner?.identity.companyName || parcel.companyName,
      }
    : parcel;
}

function mergeAccountParcel(
  state: AppState,
  shipmentsInput: readonly Shipment[],
  parcel: AccountParcelDto,
  boundPhones: readonly string[],
  source: BindingSource,
  now: number,
  routeMutations: DeferredRouteMutations,
): Shipment[] {
  let shipments = [...shipmentsInput];
  const incoming = parcelToShipment(parcel, boundPhones, now);
  if (!incoming) return shipments;
  if (
    isImportSuppressed(
      state,
      source,
      incoming.identity.sourceId,
      incoming.identity.phone || "",
    ) ||
    isWaybillTombstoned(state, displayWaybill(incoming)) ||
    isWaybillTombstoned(state, incoming.identity.sourceId)
  ) {
    return shipments;
  }
  const current = shipments.find(
    (item) => item.identity.id === incoming.identity.id,
  );
  let merged = applyAccountShipment(current, incoming, now);
  merged = deferIncomingRoute(
    merged,
    incoming,
    parcel.routeUrl,
    now,
    routeMutations,
  );
  const duplicates = shipments.filter(
    (item) =>
      item.identity.id !== merged.identity.id &&
      (
        (item.identity.manuallyAdded && sameCanonicalWaybill(item, merged)) ||
        isHistoricalAccountDuplicate(item, merged)
      ),
  );
  for (const duplicate of duplicates) {
    merged = duplicate.identity.manuallyAdded
      ? absorbManualShipment(merged, duplicate, now)
      : absorbHistoricalShipment(merged, duplicate, now);
    merged = deferPersistedRoute(merged, duplicate, now, routeMutations);
    shipments = shipments.filter(
      (item) => item.identity.id !== duplicate.identity.id,
    );
  }
  return replaceById(shipments, merged);
}

async function synchronizeAccountList(
  state: AppState,
  source: BindingSource,
  now: number,
  routeMutations: DeferredRouteMutations,
  flowId: string,
  deadlineAtMs?: number,
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
  try {
    const fetched = await fetchAccountParcels(
      source,
      state.bindings,
      deadlineAtMs,
    );
    const parcels = fetched.parcels;
    succeeded++;
    writeDiagnostic("account.sync.parsed", {
      flowId,
      source,
      stage: "account_list",
      durationMs: Date.now() - startedAt,
      budgetMs: stageBudgetMs(deadlineAtMs, startedAt),
      rawRecords: fetched.rawRecords,
      records: parcels.length,
      rejectedRecords: fetched.rejectedRecords,
      orders: parcels.filter((parcel) => parcel.accountOrder).length,
      routableOrders: parcels.filter(
        (parcel) => parcel.accountOrder && Boolean(parcel.projectionUrl),
      ).length,
    });
    const boundPhones = sourceBindings.map((binding) => binding.phone);
    for (const parcel of parcels) {
      shipments = mergeAccountParcel(
        state,
        shipments,
        accountParcelWithExistingProjection(parcel, shipments),
        boundPhones,
        source,
        now,
        routeMutations,
      );
    }
    return {
      state: { ...state, shipments: sortShipments(shipments) },
      parcels,
      attempted,
      succeeded,
      failed,
      canContinue: true,
    };
  } catch (error) {
    failed++;
    writeDiagnostic(
      "account.sync.failed",
      {
        flowId,
        source,
        stage: "account_list",
        durationMs: Date.now() - startedAt,
        budgetMs: stageBudgetMs(deadlineAtMs, startedAt),
        ...diagnosticErrorDetails(error),
      },
      "error",
    );
    if (
      error instanceof GatewayError &&
      (
        error.status === 401 ||
        error.message.includes("请先配置 Access Key") ||
        error.message.includes("Access Key 格式不正确")
      )
    ) {
      throw error;
    }
    return {
      state,
      parcels: [],
      attempted,
      succeeded: 0,
      failed,
      canContinue: false,
    };
  }
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
): Promise<{
  state: AppState;
  attempted: number;
  succeeded: number;
  failed: number;
  stateChanged: boolean;
  projectedOwnerIds: readonly string[];
}> {
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
  for (const position of rotatingBatchIndices(
    candidates.length,
    ACCOUNT_ORDER_PROJECTIONS_PER_REFRESH,
    now,
  )) {
    if (deadlineExpired(deadlineAtMs)) break;
    const parcel = candidates[position];
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
    const reservation = projectionAttempt(
      freshOwner,
      routeHash,
      attemptId,
      Date.now(),
      deadlineAtMs,
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
      resolvedParcel = await projectAccountOrder(
        parcel,
        deadlineAtMs,
        (diagnostics) => {
          projectionDiagnostics = diagnostics;
        },
      );
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
    if (extracted) {
      candidateShipments = mergeAccountParcel(
        ownershipState,
        candidateShipments,
        resolvedParcel!,
        boundPhones,
        source,
        now,
        attemptMutations,
      );
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
    if (extracted) {
      succeeded++;
      projectedOwnerIds.push(expectedId);
    } else {
      failed++;
    }
  }
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
): Promise<{ state: AppState; attempted: number; succeeded: number; failed: number }> {
  let currentState = state;
  const sourceBindings = bindingsForSource(currentState, source);
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let shipments = [...currentState.shipments];

  const accountFollowupDeadlineAtMs = deadlineAtMs == null
    ? undefined
    : deadlineAtMs - LOCAL_REFRESH_RESERVE_MS;
  const accountFollowupIds = shipments
    .filter((shipment) =>
      shipment.identity.bindingSource === source &&
      !shipment.identity.manuallyAdded &&
      !prefersKuaidi100First(shipment) &&
      Boolean(shipment.accountRecord) &&
      !skipRefreshIds.has(shipment.identity.id) &&
      shouldRefreshShipment(shipment, now)
    )
    .map((shipment) => shipment.identity.id);
  for (const position of rotatingBatchIndices(
    accountFollowupIds.length,
    ACCOUNT_DETAILS_PER_REFRESH,
    now,
  )) {
    if (deadlineExpired(accountFollowupDeadlineAtMs)) break;
    const shipmentId = accountFollowupIds[position];
    let index = shipments.findIndex(
      (shipment) => shipment.identity.id === shipmentId,
    );
    if (index < 0) continue;
    let current = shipments[index];
    attempted++;
    const detailStartedAt = Date.now();
    writeDiagnostic("refresh.stage.started", {
      flowId,
      source,
      stage: "account_detail",
      budgetMs: stageBudgetMs(accountFollowupDeadlineAtMs, detailStartedAt),
    });
    let detailIncoming: Shipment | null = null;
    let detailFailed = false;
    const detailMutations: DeferredRouteMutations = new Map();
    try {
      const parcel = await refreshAccountParcel(
        current,
        accountChildDeadline(
          accountFollowupDeadlineAtMs,
          ACCOUNT_DETAIL_BUDGET_MS,
        ),
      );
      if (parcel) {
        const incoming = parcelToShipment(
          parcel,
          sourceBindings.map((binding) => binding.phone),
          now,
        );
        if (incoming) {
          detailIncoming = applyTargetedAccountShipment(current, incoming, now);
          detailIncoming = deferIncomingRoute(
            detailIncoming,
            incoming,
            parcel.routeUrl,
            now,
            detailMutations,
          );
        }
      }
    } catch (error) {
      detailFailed = true;
      failed++;
      writeDiagnostic("refresh.stage.failed", {
        flowId,
        source,
        stage: "account_detail",
        durationMs: Date.now() - detailStartedAt,
        ...diagnosticErrorDetails(error),
      }, "warning");
    }
    if (detailIncoming) {
      shipments[index] = detailIncoming;
      currentState = checkpoint(
        { ...currentState, shipments: sortShipments(shipments) },
        detailMutations,
        "account_detail",
      );
      shipments = [...currentState.shipments];
      current = shipments.find(
        (shipment) => shipment.identity.id === shipmentId,
      ) || detailIncoming;
      succeeded++;
      writeDiagnostic("refresh.stage.succeeded", {
        flowId,
        source,
        stage: "account_detail",
        durationMs: Date.now() - detailStartedAt,
      });
    } else if (!detailFailed) {
      failed++;
      writeDiagnostic("refresh.stage.failed", {
        flowId,
        source,
        stage: "account_detail",
        durationMs: Date.now() - detailStartedAt,
        result: "no_result",
      }, "warning");
    }
    if (!k100FallbackNeeded(current, now)) continue;
    attempted++;
    const k100StartedAt = Date.now();
    writeDiagnostic("refresh.stage.started", {
      flowId,
      source,
      stage: "k100_fallback",
      budgetMs: stageBudgetMs(accountFollowupDeadlineAtMs, k100StartedAt),
    });
    let k100Incoming: Shipment | null = null;
    try {
      k100Incoming = await refreshK100(
        current,
        source,
        sourceBindings,
        now,
        accountFollowupDeadlineAtMs,
      );
    } catch (error) {
      failed++;
      writeDiagnostic("refresh.stage.failed", {
        flowId,
        source,
        stage: "k100_fallback",
        durationMs: Date.now() - k100StartedAt,
        ...diagnosticErrorDetails(error),
      }, "warning");
    }
    if (k100Incoming) {
      index = shipments.findIndex(
        (shipment) => shipment.identity.id === shipmentId,
      );
      if (index >= 0) shipments[index] = k100Incoming;
      currentState = checkpoint(
        { ...currentState, shipments: sortShipments(shipments) },
        new Map(),
        "k100_fallback",
      );
      shipments = [...currentState.shipments];
      succeeded++;
      writeDiagnostic("refresh.stage.succeeded", {
        flowId,
        source,
        stage: "k100_fallback",
        durationMs: Date.now() - k100StartedAt,
      });
    }
  }

  return {
    state: currentState,
    attempted,
    succeeded,
    failed,
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
): Promise<{ state: AppState; attempted: number; succeeded: number; failed: number }> {
  let currentState = state;
  let shipments = [...currentState.shipments];
  let pendingQueries = [...currentState.pendingQueries];
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const bindings = bindingsForSource(state, source);
  const tasks: Array<
    { kind: "shipment"; id: string } | { kind: "pending"; id: string }
  > = [
    ...shipments
      .filter((current) =>
        current.identity.bindingSource === source &&
        !skipRefreshIds.has(current.identity.id) &&
        (current.identity.manuallyAdded ||
          manualTimelineOwnsShipment(current) ||
          prefersKuaidi100First(current)) &&
        current.timeline.provider !== "demo" &&
        shouldScheduleManualRefresh(current, now, forceManualRefresh)
      )
      .map((current) => ({ kind: "shipment" as const, id: current.identity.id })),
    ...pendingQueries
      .filter((pending) =>
        pending.source === source &&
        now - pending.lastAttemptAtMs >= PENDING_RETRY_MS
      )
      .map((pending) => ({ kind: "pending" as const, id: pending.id })),
  ];

  for (const position of rotatingBatchIndices(
    tasks.length,
    MANUAL_TASKS_PER_REFRESH,
    now,
  )) {
    if (deadlineExpired(deadlineAtMs)) break;
    const task = tasks[position];
    const stage = task.kind === "shipment" ? "manual_refresh" : "pending_query";
    const taskStartedAt = Date.now();
    writeDiagnostic("refresh.stage.started", {
      flowId,
      source,
      stage,
      budgetMs: stageBudgetMs(deadlineAtMs, taskStartedAt),
    });
    if (task.kind === "shipment") {
      let index = shipments.findIndex(
        (current) => current.identity.id === task.id,
      );
      if (index < 0) continue;
      let current = shipments[index];
      const attemptAtMs = Date.now();
      const attemptId = createDiagnosticFlowId("manual");
      shipments[index] = beginManualRefreshAttempt(
        current,
        attemptId,
        attemptAtMs,
        deadlineAtMs || attemptAtMs + MANUAL_QUERY_BUDGET_MS,
      );
      currentState = checkpoint(
        { ...currentState, shipments: sortShipments(shipments) },
        new Map(),
        `${stage}_attempt`,
      );
      shipments = [...currentState.shipments];
      pendingQueries = [...currentState.pendingQueries];
      index = shipments.findIndex(
        (shipment) => shipment.identity.id === task.id,
      );
      if (index < 0) continue;
      current = shipments[index];
      if (!ownsManualRefreshLease(current, attemptId)) continue;
      attempted++;
      const releaseAttempt = () => {
        for (let retry = 0; retry < 2; retry++) {
          index = shipments.findIndex(
            (shipment) => shipment.identity.id === task.id,
          );
          if (
            index < 0 || !ownsManualRefreshLease(shipments[index], attemptId)
          ) {
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
      let outcome: Awaited<ReturnType<typeof queryManualForSource>> | null = null;
      try {
        outcome = await queryManualForSource({
          source,
          bindings,
          waybill: displayWaybill(current),
          phoneTail: current.identity.phoneTail,
          courierCode: current.identity.courierCode,
          companyName: current.identity.companyName,
          preferKuaidi100: prefersKuaidi100First(current),
          deadlineAtMs,
        });
      } catch (error) {
        releaseAttempt();
        failed++;
        writeDiagnostic("refresh.stage.failed", {
          flowId,
          source,
          stage,
          durationMs: Date.now() - taskStartedAt,
          ...diagnosticErrorDetails(error),
        }, "warning");
        continue;
      }
      if (
        outcome.shipment &&
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
        releaseAttempt();
        failed++;
        writeDiagnostic("refresh.stage.failed", {
          flowId,
          source,
          stage,
          durationMs: Date.now() - taskStartedAt,
          result: "no_result",
        }, "warning");
      }
      continue;
    }

    const pending = pendingQueries.find((value) => value.id === task.id);
    if (!pending) continue;
    attempted++;
    let outcome: Awaited<ReturnType<typeof queryManualForSource>> | null = null;
    let queryError: unknown = null;
    try {
      outcome = await queryManualForSource({
        source,
        bindings,
        waybill: pending.waybill,
        phoneTail: pending.phoneTail,
        courierCode: pending.courierCode,
        companyName: pending.companyName,
        deadlineAtMs,
      });
    } catch (error) {
      queryError = error;
    }
    const taskMutations: DeferredRouteMutations = new Map();
    if (queryError) {
      pendingQueries = pendingQueries.map((item) =>
        item.id === pending.id
          ? {
              ...item,
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

  return {
    state: currentState,
    attempted,
    succeeded,
    failed,
  };
}

export type ManualShipmentPreview = {
  shipment: Shipment;
  pending: PendingManualQuery | null;
  routeUrl: string;
  hasTimedResult: boolean;
};

export async function queryManualShipmentPreview(input: {
  waybill: string;
  phoneTail?: string;
}): Promise<ManualShipmentPreview> {
  const deadlineAtMs = deadlineAfter(MANUAL_QUERY_BUDGET_MS);
  const state = loadState();
  const canonicalInput = normalizeWaybill(input.waybill);
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
    courierCode: current?.identity.courierCode,
    companyName: current?.identity.companyName,
    preferKuaidi100: prefersKuaidi100First(current),
    deadlineAtMs,
  });
  const prepared = prepareManualPreview(outcome);
  const queried = prepared.shipment;
  return {
    shipment: queried,
    pending: prepared.pending,
    routeUrl: prepared.routeUrl,
    hasTimedResult: prepared.hasTimedResult,
  };
}

export function commitManualShipmentPreview(
  preview: ManualShipmentPreview,
  now = Date.now(),
): AppState {
  const state = loadState(now);
  const canonical = displayWaybill(preview.shipment);
  const current = state.shipments
    .filter(
      (item) =>
        item.identity.bindingSource === preview.shipment.identity.bindingSource,
    )
    .sort((left, right) =>
      Number(left.identity.manuallyAdded) - Number(right.identity.manuallyAdded)
    )
    .find((item) => displayWaybill(item) === canonical);

  if (
    isWaybillTombstoned(
      state,
      canonical,
    )
  ) return state;

  if (!preview.hasTimedResult) {
    if (!preview.pending || current) return state;
    const existingPending = state.pendingQueries.find(
      (item) => item.id === preview.pending?.id,
    );
    const existingRoute = existingPending?.route?.kind === "cainiao" && Boolean(
      loadShipmentRoute(
        existingPending.id,
        existingPending.route.source,
        now,
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
    const pointer = preview.pending.route?.kind === "cainiao"
      ? preview.pending.route
      : null;
    if (pointer && preview.routeUrl) {
      try {
        if (saveShipmentRoute(pending.id, pointer.source, preview.routeUrl, now)) {
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
    requestWidgetReload();
    return next;
  }

  const merged = applyManualShipment(current, preview.shipment, now);
  const existingRoute = current?.route?.kind === "cainiao" && Boolean(
    loadShipmentRoute(current.identity.id, current.route.source, now),
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
  const pointer = preview.shipment.route?.kind === "cainiao"
    ? preview.shipment.route
    : null;
  let routeReady = false;
  if (pointer && preview.routeUrl) {
    try {
      routeReady = saveShipmentRoute(
        shipment.identity.id,
        pointer.source,
        preview.routeUrl,
        now,
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

export async function addManualShipment(input: {
  waybill: string;
  phoneTail?: string;
}): Promise<{ shipment: Shipment; state: AppState }> {
  const preview = await queryManualShipmentPreview(input);
  const state = commitManualShipmentPreview(preview);
  const shipment = state.shipments.find(
    (item) => item.identity.id === preview.shipment.identity.id,
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
    requestWidgetReload();
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
  options: {
    forceAccountOrderProjection?: boolean;
    forceManualRefresh?: boolean;
  } = {},
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
  assertWithinDeadline(deadlineAtMs);
  writeDiagnostic("detail.refresh.started", {
    flowId,
    source,
    baseActiveSource: base.activeSource,
    baseRevision: base.revision,
  });
  const forceAccountOrderProjection = Boolean(
    options.forceAccountOrderProjection && unprojectedAccountOrder(original),
  );
  const usesManualQuery = original.identity.manuallyAdded ||
    prefersKuaidi100First(original);
  const refreshDue = usesManualQuery
    ? shouldScheduleManualRefresh(
        original,
        Date.now(),
        Boolean(options.forceManualRefresh),
      )
    : forceAccountOrderProjection || shouldRefreshShipment(original, Date.now());
  if (!refreshDue) {
    writeDiagnostic("detail.refresh.skipped", {
      flowId,
      source: original.identity.bindingSource || base.activeSource,
      ...diagnosticState(base),
      result: "not_due",
    });
    return { shipment: original, state: base, refreshed: false };
  }
  const sourceBindings = bindingsForSource(base, source);
  const routeMutations: DeferredRouteMutations = new Map();
  let refreshed = original;
  let changed = false;
  let stage = "dispatch";
  let manualAttemptId = "";

  try {
    if (
      usesManualQuery
    ) {
      stage = "manual_source";
      const attemptAtMs = Date.now();
      manualAttemptId = createDiagnosticFlowId("manual");
      assertWithinDeadline(deadlineAtMs);
      const attemptCommit = commitTargetShipmentRefresh(
        base,
        beginManualRefreshAttempt(
          original,
          manualAttemptId,
          attemptAtMs,
          deadlineAtMs,
        ),
        attemptAtMs,
        lease,
      );
      if (!attemptCommit.applied) {
        const current = attemptCommit.state.shipments.find(
          (shipment) => shipment.identity.id === shipmentId,
        );
        if (!current) throw new Error("该快递已从列表中移除");
        return {
          shipment: current,
          state: attemptCommit.state,
          refreshed: false,
        };
      }
      base = attemptCommit.state;
      original = base.shipments.find(
        (shipment) => shipment.identity.id === shipmentId,
      ) || original;
      if (!ownsManualRefreshLease(original, manualAttemptId)) {
        return { shipment: original, state: base, refreshed: false };
      }
      refreshed = original;
      const outcome = await queryManualForSource({
        source,
        bindings: sourceBindings,
        waybill: displayWaybill(original),
        phoneTail: original.identity.phoneTail,
        courierCode: original.identity.courierCode,
        companyName: original.identity.companyName,
        preferKuaidi100: prefersKuaidi100First(original),
        deadlineAtMs,
      });
      if (
        outcome.shipment &&
        timedTracks(outcome.shipment.timeline.tracks).length
      ) {
        refreshed = applyManualShipment(original, outcome.shipment, Date.now());
        refreshed = deferIncomingRoute(
          refreshed,
          outcome.shipment,
          outcome.routeUrl,
          Date.now(),
          routeMutations,
        );
        refreshed = releaseManualRefreshLease(refreshed, manualAttemptId);
        changed = true;
      }
    } else {
      let accountError: unknown = null;
      if (original.accountRecord) {
        stage = "account_detail";
        try {
          let projectionRetry:
            Shipment["identity"]["orderProjectionRetry"] = undefined;
          const savedProjectionUrl = unprojectedAccountOrder(original)
            ? loadOrderProjectionReference(
                original.identity.id,
                source,
                Date.now(),
              )
            : "";
          let parcel = forceAccountOrderProjection && savedProjectionUrl
            ? accountParcelWithProjectionReference(
                original,
                null,
                savedProjectionUrl,
              )
            : await refreshAccountParcel(
                original,
                accountChildDeadline(deadlineAtMs, ACCOUNT_DETAIL_BUDGET_MS),
              );
          parcel = accountParcelWithProjectionReference(
            original,
            parcel,
            savedProjectionUrl,
          );
          if (
            parcel?.accountOrder &&
            parcel.projectionUrl &&
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
              const reserved = projectionAttempt(
                freshOwner,
                routeHash,
                attemptId,
                Date.now(),
                deadlineAtMs,
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
                  parcel = await projectAccountOrder(
                    parcel,
                    deadlineAtMs,
                    (diagnostics) => {
                      projectionDiagnostics = diagnostics;
                    },
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
            const incoming = parcelToShipment(
              parcel,
              sourceBindings.map((binding) => binding.phone),
              Date.now(),
            );
            if (incoming) {
              refreshed = applyTargetedAccountShipment(
                original,
                incoming,
                Date.now(),
              );
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
          accountError = error;
        }
      }

      if (
        !sourceTimelineOwnsShipment(refreshed) &&
        !unprojectedAccountOrder(refreshed) &&
        !deadlineExpired(deadlineAtMs)
      ) {
        stage = "k100";
        try {
          refreshed = await refreshK100(
            refreshed,
            source,
            sourceBindings,
            Date.now(),
            deadlineAtMs,
          );
          changed = true;
        } catch (error) {
          if (!changed) throw accountError || error;
          writeDiagnostic("detail.refresh.fallback_failed", {
            flowId,
            source,
            stage,
            durationMs: Date.now() - startedAt,
            ...diagnosticErrorDetails(error),
          }, "warning");
        }
      } else if (!changed && accountError) {
        throw accountError;
      }
    }
  } catch (error) {
    const failureState = manualAttemptId
      ? releaseTargetManualRefreshLease(shipmentId, manualAttemptId)
      : loadState();
    safelyPruneRoutes(failureState);
    writeDiagnostic("detail.refresh.failed", {
      flowId,
      source,
      baseActiveSource: base.activeSource,
      baseRevision: base.revision,
      durationMs: Date.now() - startedAt,
      stage,
      ...diagnosticErrorDetails(error),
    }, "warning");
    throw error;
  }

  if (!changed) {
    if (manualAttemptId) {
      base = releaseTargetManualRefreshLease(shipmentId, manualAttemptId);
      original = base.shipments.find(
        (shipment) => shipment.identity.id === shipmentId,
      ) || original;
    }
    safelyPruneRoutes(base);
    writeDiagnostic("detail.refresh.skipped", {
      flowId,
      source,
      ...diagnosticState(base),
      durationMs: Date.now() - startedAt,
      result: "no_result",
    });
    return { shipment: original, state: base, refreshed: false };
  }
  if (deadlineExpired(deadlineAtMs) || !lease.isCurrent()) {
    if (manualAttemptId) {
      releaseTargetManualRefreshLease(shipmentId, manualAttemptId);
    }
    throw new OperationTimeoutError();
  }
  const commit = commitTargetShipmentRefresh(
    base,
    refreshed,
    Date.now(),
    manualAttemptId
      ? {
          isCurrent: lease.isCurrent,
          acceptsState: (state) => ownsManualRefreshLease(
            state.shipments.find(
              (shipment) => shipment.identity.id === shipmentId,
            ),
            manualAttemptId,
          ),
        }
      : lease,
  );
  let committed = commit.state;
  if (!commit.applied) {
    if (manualAttemptId) {
      committed = releaseTargetManualRefreshLease(
        shipmentId,
        manualAttemptId,
      );
    }
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
      result: current ? "state_changed" : "removed",
    });
    if (!current) throw new Error("该快递已从列表中移除");
    return { shipment: current, state: committed, refreshed: false };
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
    result: "applied",
  });
  return { shipment: persisted, state: next, refreshed: true };
}

function runTargetedShipmentRefresh(
  shipmentId: string,
  options: {
    forceAccountOrderProjection?: boolean;
    forceManualRefresh?: boolean;
  },
): Promise<ShipmentRefreshResult> {
  const deadlineAtMs = deadlineAfter(DETAIL_REFRESH_BUDGET_MS);
  let active = true;
  const lease: TargetRefreshLease = {
    deadlineAtMs,
    isCurrent: () => active && !deadlineExpired(deadlineAtMs),
  };
  const work = Promise.resolve().then(() =>
    runShipmentRefreshById(shipmentId, lease, options)
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const guarded = Promise.race([
    work,
    new Promise<ShipmentRefreshResult>((_, reject) => {
      timeout = setTimeout(() => {
        active = false;
        reject(new OperationTimeoutError());
      }, Math.max(0, deadlineAtMs - Date.now()));
    }),
  ]);
  return guarded.finally(() => {
    active = false;
    if (timeout != null) clearTimeout(timeout);
  });
}

async function runTargetedShipmentRefreshWithProjectionWait(
  shipmentId: string,
  options: {
    forceAccountOrderProjection?: boolean;
    forceManualRefresh?: boolean;
  },
): Promise<ShipmentRefreshResult> {
  if (options.forceAccountOrderProjection) {
    const completed = await waitForProjectionAttemptRelease(shipmentId);
    if (completed) return completed;
  }
  return runTargetedShipmentRefresh(shipmentId, options);
}

export function refreshShipmentById(
  shipmentId: string,
  options: {
    forceAccountOrderProjection?: boolean;
    forceManualRefresh?: boolean;
  } = {},
): Promise<ShipmentRefreshResult> {
  const existing = refreshCoordinator.detail(shipmentId);
  if (existing) return existing;
  const before = loadState();
  const shipment = before.shipments.find(
    (item) => item.identity.id === shipmentId,
  );
  if (!shipment) return Promise.reject(new Error("该快递已从列表中移除"));
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
  return refreshCoordinator.runDetail(
    shipmentId,
    source,
    () => runTargetedShipmentRefreshWithProjectionWait(shipmentId, options),
    async (summary) => {
      const current = summary.state.shipments.find(
        (item) => item.identity.id === shipmentId,
      );
      if (!current) throw new Error("该快递已从列表中移除");
      if (
        options.forceAccountOrderProjection &&
        unprojectedAccountOrder(current)
      ) {
        writeDiagnostic("detail.refresh.waiting", {
          source,
          ...diagnosticState(summary.state),
          stage: "forced_projection_after_full_refresh",
        });
        return runTargetedShipmentRefreshWithProjectionWait(shipmentId, options);
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
    },
  );
}

async function runFullRefresh(
  source: BindingSource,
  deadlineAtMs: number,
  flowId: string,
  skipRefreshIds: ReadonlySet<string>,
  accountOrderProjection: boolean,
  forceManualRefresh: boolean,
  lease: FullRefreshLease,
): Promise<RefreshSummary> {
  requireScriptSource(source);
  lease.assertCurrent();
  const startedAt = Date.now();
  const initial = loadState(startedAt);
  let checkpointBase = initial;
  let currentState = initial;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
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
    requestWidgetReload();
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
    requestWidgetReload();
    return { state: next, applied: true };
  };

  const accountMutations: DeferredRouteMutations = new Map();
  const accountDeadlineAtMs = Math.max(
    startedAt + 1,
    deadlineAtMs - FINALIZATION_RESERVE_MS,
  );
  const account = await synchronizeAccountList(
    initial,
    source,
    startedAt,
    accountMutations,
    flowId,
    accountDeadlineAtMs,
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
    };
  }
  if (account.succeeded > 0) {
    currentState = checkpoint(account.state, accountMutations, "account_list");
    persistAccountOrderProjectionReferences(
      account.parcels,
      currentState,
      source,
      flowId,
    );
  }

  const enrichmentDeadlineAtMs = deadlineAtMs - FINALIZATION_RESERVE_MS;
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
      accountOrderProjection,
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
        writeDiagnostic("order.projection.committed", {
          flowId,
          source,
          stage: "state",
          ownerFingerprint: projectionOwnerFingerprint(ownerId),
          result: normalizedProjectedWaybill(persisted?.identity)
            ? "applied"
            : "extracted_not_committed",
        }, normalizedProjectedWaybill(persisted?.identity) ? "info" : "warning");
      }
    }
  }

  if (!deadlineExpired(enrichmentDeadlineAtMs)) {
    const accountFollowups = await refreshAccountFollowups(
      currentState,
      source,
      Date.now(),
      flowId,
      checkpoint,
      enrichmentDeadlineAtMs,
      skipRefreshIds,
    );
    currentState = accountFollowups.state;
    attempted += accountFollowups.attempted;
    succeeded += accountFollowups.succeeded;
    failed += accountFollowups.failed;
  }

  if (!deadlineExpired(enrichmentDeadlineAtMs)) {
    const local = await refreshManualAndPending(
        currentState,
        source,
        Date.now(),
        flowId,
        checkpoint,
        enrichmentDeadlineAtMs,
        skipRefreshIds,
        forceManualRefresh,
      );
    currentState = local.state;
    attempted += local.attempted;
    succeeded += local.succeeded;
    failed += local.failed;
  }

  lease.assertCurrent();
  await notifyShipmentChanges(
    previousById,
    currentState.shipments.filter(
      (shipment) => shipment.identity.bindingSource === source,
    ),
  );
  return {
    attempted,
    succeeded,
    failed,
    state: currentState,
  };
}

export function refreshAllShipments(
  sourceOverride?: BindingSource,
  options: {
    budgetMs?: number;
    accountOrderProjection?: boolean;
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
  const budgetMs = Math.max(
    1_000,
    Math.min(Number(options.budgetMs) || FULL_REFRESH_BUDGET_MS, 60_000),
  );
  const deadlineAtMs = deadlineAfter(budgetMs, startedAt);
  const blockerDeadlineAtMs = Math.min(
    deadlineAtMs,
    deadlineAfter(FULL_REFRESH_COORDINATION_WAIT_MS, startedAt),
  );
  const before = loadState(startedAt);
  writeDiagnostic("refresh.started", {
    flowId,
    source,
    baseActiveSource: before.activeSource,
    baseRevision: before.revision,
    budgetMs,
  });
  return refreshCoordinator.runFull(
    source,
    async (skipRefreshIds, lease) => {
      const blockedMs = Math.max(0, Date.now() - startedAt);
      try {
        const summary = await runFullRefresh(
          source,
          deadlineAtMs,
          flowId,
          skipRefreshIds,
          options.accountOrderProjection !== false,
          Boolean(options.forceManualRefresh),
          lease,
        );
        const failedCompletely = summary.attempted > 0 && summary.succeeded === 0;
        writeDiagnostic(failedCompletely ? "refresh.failed" : "refresh.succeeded", {
          flowId,
          source,
          ...diagnosticState(summary.state),
          attempted: summary.attempted,
          succeeded: summary.succeeded,
          failed: summary.failed,
          durationMs: Date.now() - startedAt,
          budgetMs,
          blockedMs,
          deadlineLagMs: Math.max(0, Date.now() - deadlineAtMs),
          result: failedCompletely
            ? "failed"
            : summary.failed > 0
              ? "partial"
              : "succeeded",
        }, failedCompletely ? "error" : summary.failed > 0 ? "warning" : "info");
        return summary;
      } catch (error) {
        writeDiagnostic(
          "refresh.failed",
          {
            flowId,
            source,
            baseActiveSource: before.activeSource,
            baseRevision: before.revision,
            durationMs: Date.now() - startedAt,
            budgetMs,
            blockedMs,
            deadlineLagMs: Math.max(0, Date.now() - deadlineAtMs),
            ...diagnosticErrorDetails(error),
          },
          "error",
        );
        throw error;
      }
    },
    (detail) => detail.refreshed,
    {
      blockerDeadlineAtMs,
      operationDeadlineAtMs: deadlineAtMs,
    },
  );
}
