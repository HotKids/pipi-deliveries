import type { AppState } from "../models";
import {
  forceCompleteShipment,
  pruneRoutesForState as prunePersistedRoutes,
  removeShipmentWithCleanup,
} from "./storage";
import { requestWidgetReload } from "./widgets";

type ShipmentMutationDependencies = {
  mutate: (id: string) => AppState | { state: AppState; routesPruned: boolean };
  pruneRoutes: (state: AppState) => void;
  reloadWidgets: () => void;
};

export type ShipmentMutationResult =
  | { ok: true; state: AppState }
  | { ok: false; message: string };

function performShipmentMutation(
  id: string,
  failureMessage: string,
  dependencies: ShipmentMutationDependencies,
): ShipmentMutationResult {
  let state: AppState;
  let routesPruned = false;
  try {
    const committed = dependencies.mutate(id);
    if ("state" in committed) {
      state = committed.state;
      routesPruned = committed.routesPruned;
    } else {
      state = committed;
    }
  } catch {
    return { ok: false, message: failureMessage };
  }

  try {
    if (!routesPruned) dependencies.pruneRoutes(state);
  } catch {
    /* later durable state transitions retry route cleanup */
  }
  try {
    dependencies.reloadWidgets();
  } catch {
    /* widget refresh is best-effort after the durable state change */
  }
  return { ok: true, state };
}

export function performShipmentDeletion(
  id: string,
  dependencies: ShipmentMutationDependencies = {
    mutate: removeShipmentWithCleanup,
    pruneRoutes: prunePersistedRoutes,
    reloadWidgets: requestWidgetReload,
  },
): ShipmentMutationResult {
  return performShipmentMutation(
    id,
    "操作失败，请稍后重试",
    dependencies,
  );
}

export function performShipmentCompletion(
  id: string,
  dependencies: ShipmentMutationDependencies = {
    mutate: forceCompleteShipment,
    pruneRoutes: () => {},
    reloadWidgets: requestWidgetReload,
  },
): ShipmentMutationResult {
  return performShipmentMutation(
    id,
    "操作失败，请稍后重试",
    dependencies,
  );
}
