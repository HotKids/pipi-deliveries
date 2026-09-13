import type { AppState } from "../models";
import {
  forceCompleteShipment,
  pruneRoutesForState as prunePersistedRoutes,
  removeShipment,
} from "./storage";
import { requestWidgetReload } from "./widgets";

type ShipmentMutationDependencies = {
  mutate: (id: string) => AppState;
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
  try {
    state = dependencies.mutate(id);
  } catch {
    return { ok: false, message: failureMessage };
  }

  try {
    dependencies.pruneRoutes(state);
  } catch {
    /* stale encrypted routes expire automatically after the durable state change */
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
    mutate: removeShipment,
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
