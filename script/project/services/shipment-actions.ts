import type { AppState } from "../models";
import {
  forceCompleteShipment,
  pruneRoutesForState as prunePersistedRoutes,
  removeShipmentWithCleanup,
} from "./storage";
import { requestWidgetReload } from "./widgets";
import { diagnosticErrorDetails, writeDiagnostic } from "./logger";

type ShipmentMutationDependencies = {
  mutate: (id: string) => AppState | { state: AppState; routesPruned: boolean };
  pruneRoutes: (state: AppState) => void;
  reloadWidgets: () => void;
};

export type ShipmentMutationResult =
  | { ok: true; state: AppState }
  | { ok: false; message: string };

type ShipmentMutationAction = "complete" | "delete";

/**
 * 2026-11-12 诊断日志补齐（Pipi「我已取件」结果行的 iOS 对应）：右滑签收与删除的结果以前只进 toast。
 * Only the action, outcome, duration and error classification are recorded; never the row id or waybill.
 */
function logShipmentMutation(
  action: ShipmentMutationAction,
  outcome: "succeeded" | "failed",
  startedAtMs: number,
  error?: unknown,
): void {
  try {
    writeDiagnostic(`shipment.${action}.${outcome}`, {
      stage: "ui_handler",
      result: outcome,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      ...(error === undefined ? {} : diagnosticErrorDetails(error)),
    }, outcome === "failed" ? "error" : "info");
  } catch {
    /* diagnostics never change the action's result */
  }
}

function performShipmentMutation(
  id: string,
  failureMessage: string,
  dependencies: ShipmentMutationDependencies,
  action: ShipmentMutationAction,
): ShipmentMutationResult {
  const startedAtMs = Date.now();
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
  } catch (error) {
    logShipmentMutation(action, "failed", startedAtMs, error);
    return { ok: false, message: failureMessage };
  }
  logShipmentMutation(action, "succeeded", startedAtMs);

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
    "delete",
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
    "complete",
  );
}
