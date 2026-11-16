/** Deferred route mutation staging, atomic route pointer publication, and full-refresh checkpoints. */
import type { AppState, BindingSource, PendingManualQuery, Shipment } from "../../models";
import { commitShipmentRouteMutations, loadShipmentRoute, moveShipmentRoute, removeOrderProjectionReferences, removeShipmentRoutes, type ShipmentRoutePublication } from "../routes";
import { commitRefreshState, commitRoutePointers, pruneRoutesForState as safelyPruneRoutes, type RefreshNotificationContext } from "../storage";
import { normalizeWaybill, sortShipments } from "../status";
import { diagnosticErrorDetails, diagnosticState, writeDiagnostic } from "../logger";
import type { FullRefreshLease } from "../refresh-coordination";
import {
  ownsProjectionAttempt,
  type DeferredRouteMutationInput,
  type DeferredRouteMutations,
  type DeferredRouteOwner,
  type ProjectionCheckpoint,
  type RefreshCheckpoint,
  type RefreshCheckpointFn,
  type SyncRuntimeState,
} from "./shared";

export function safelyRemoveRoutes(ids: readonly string[]): void {
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

export function routeMutationKey(owner: DeferredRouteOwner, targetId: string): string {
  return `${owner}:${targetId}`;
}

export function shipmentRouteVersion(shipment: Shipment): string {
  return `${shipment.identity.id}:${shipment.updatedAtMs}`;
}

export function pendingRouteVersion(pending: PendingManualQuery): string {
  return `${pending.id}:${pending.lastAttemptAtMs}:${pending.attempts}:${pending.createdAtMs}:${pending.rawCourierCode || ""}:${Boolean(pending.awaitingRoundCompletion)}`;
}

export function pendingGenerationVersion(pending: PendingManualQuery): string {
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

export function queueRouteMutation(
  mutations: DeferredRouteMutations,
  mutation: DeferredRouteMutationInput,
): void {
  const key = routeMutationKey(mutation.owner, mutation.targetId);
  mutations.set(key, { ...mutation, key });
}

export function deferIncomingRoute(
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

export function deferPersistedRoute(
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

export function deferPendingRoute(
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

export function stateWithRoutePublications(
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

export function publishDeferredRoutes(
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

export function adoptPendingRoute(
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

/**
 * The commit functions of one `full:<source>` generation: every checkpoint rebases onto the latest
 * durable state and publishes deferred routes; projection commits additionally require the attempt
 * reservation to still be theirs. Shared by the list refresh and the Home stored-row pass.
 */
export function fullRefreshCheckpoints(
  runtimeState: SyncRuntimeState,
  source: BindingSource,
  flowId: string,
  lease: FullRefreshLease,
  initial: AppState,
  notificationContext: RefreshNotificationContext,
): Readonly<{ checkpoint: RefreshCheckpoint; projectionCheckpoint: ProjectionCheckpoint }> {
  let checkpointBase = initial;

  const checkpointFn: RefreshCheckpointFn = (candidate, mutations, stage, base = checkpointBase) => {
    lease.assertCurrent();
    if ((stage === "manual_refresh_attempt" || stage === "manual_refresh_release") && mutations.size === 0) {
      checkpointBase = candidate;
      return checkpointBase;
    }
    if (candidate === base && mutations.size === 0) {
      return checkpointBase;
    }
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
    if (!stage.endsWith("_attempt") && !stage.endsWith("_release")) runtimeState.publishRefreshState(next);
    return next;
  };

  type QueuedEnrichmentCommit = {
    candidate: AppState;
    mutations: DeferredRouteMutations;
    stage: string;
    base: AppState;
    resolve: (state: AppState) => void;
    reject: (error: unknown) => void;
  };
  let pendingBatch: QueuedEnrichmentCommit[] = [];
  let flushScheduled = false;

  const flushBatch = () => {
    flushScheduled = false;
    const batch = pendingBatch;
    pendingBatch = [];
    if (!batch.length) return;
    if (batch.length === 1) {
      const entry = batch[0]!;
      try {
        entry.resolve(checkpointFn(entry.candidate, entry.mutations, entry.stage, entry.base));
      } catch (error) {
        entry.reject(error);
      }
      return;
    }

    const baseById = new Map(checkpointBase.shipments.map((item) => [item.identity.id, item]));
    const mergedById = new Map(baseById);
    const touchedIds = new Set<string>();
    const combinedMutations: DeferredRouteMutations = new Map();
    let canCoalesce = true;

    for (const entry of batch) {
      if (entry.candidate.pendingQueries !== entry.base.pendingQueries ||
          entry.candidate.bindings !== entry.base.bindings) {
        canCoalesce = false;
        break;
      }
      const entryBaseMap = new Map(entry.base.shipments.map((item) => [item.identity.id, item]));
      const entryCandMap = new Map(entry.candidate.shipments.map((item) => [item.identity.id, item]));
      if (entryBaseMap.size !== entryCandMap.size) {
        canCoalesce = false;
        break;
      }
      for (const [id, nextRow] of entryCandMap) {
        const prevRow = entryBaseMap.get(id);
        if (!prevRow) {
          canCoalesce = false;
          break;
        }
        if (prevRow === nextRow) continue;
        if (touchedIds.has(id)) {
          canCoalesce = false;
          break;
        }
        const currentBaseRow = baseById.get(id);
        if (!currentBaseRow || JSON.stringify(currentBaseRow) !== JSON.stringify(prevRow)) {
          canCoalesce = false;
          break;
        }
        touchedIds.add(id);
        mergedById.set(id, nextRow);
      }
      if (!canCoalesce) break;
      for (const [key, mutation] of entry.mutations) {
        if (combinedMutations.has(key)) {
          canCoalesce = false;
          break;
        }
        combinedMutations.set(key, mutation);
      }
      if (!canCoalesce) break;
    }

    if (canCoalesce && touchedIds.size > 0) {
      const combinedCandidate: AppState = {
        ...checkpointBase,
        shipments: sortShipments([...mergedById.values()]),
      };
      try {
        const committed = checkpointFn(
          combinedCandidate,
          combinedMutations,
          batch[0]!.stage,
          checkpointBase,
        );
        for (const entry of batch) entry.resolve(committed);
        return;
      } catch (error) {
        for (const entry of batch) entry.reject(error);
        return;
      }
    }

    for (const entry of batch) {
      try {
        entry.resolve(checkpointFn(entry.candidate, entry.mutations, entry.stage, entry.base));
      } catch (error) {
        entry.reject(error);
      }
    }
  };

  const checkpoint: RefreshCheckpoint = Object.assign(checkpointFn, {
    transientManualLease: true,
    batched: (
      candidate: AppState,
      mutations: DeferredRouteMutations,
      stage: string,
      base = checkpointBase,
    ): Promise<AppState> =>
      new Promise<AppState>((resolve, reject) => {
        pendingBatch.push({ candidate, mutations, stage, base, resolve, reject });
        if (!flushScheduled) {
          flushScheduled = true;
          void Promise.resolve().then(flushBatch);
        }
      }),
  });

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
