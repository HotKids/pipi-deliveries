import { AppIntentManager, AppIntentProtocol } from "scripting";
import { refreshAllShipments } from "./services/sync";
import { refreshDueWatchShipments } from "./services/storage";
import { backgroundHostBootstrap, backgroundRefreshOptions } from "./services/background-refresh";
import { diagnosticErrorDetails, flushDiagnostics, writeDiagnostic, writeRuntimeCapabilities } from "./services/logger";
import { completeParcelActivity, type ParcelActivityCompletion } from "./services/parcel-activity-action";
import { retireCompletedParcelActivities } from "./services/parcel-live-activity";
import { synchronizeParcelCloudRecords } from "./services/parcel-cloud-sync";
import { ensureMealRules } from "./services/carrier-authority";
import { synchronizeMeals } from "./services/meal/cloud";

const REGISTERED_INTENTS_KEY = "__pipiDeliveriesRegisteredAppIntents__";

function registerAppIntentOnce<T>(name: string, register: () => T): T {
  const host = globalThis as Record<string, unknown>;
  const map = (host[REGISTERED_INTENTS_KEY] as Record<string, T> | undefined) ?? {};
  host[REGISTERED_INTENTS_KEY] = map;
  if (name in map) return map[name]!;
  const created = register();
  map[name] = created;
  return created;
}

/**
 * D103: an App Intent names its runtime on its lines, reports what an earlier runtime left unfinished (D4) and writes
 * one host line per run with its result and duration.
 */
function beginIntentRun(stage: "refresh" | "complete_activity") {
  writeRuntimeCapabilities("app_intent");
  const startedAt = Date.now();
  return (result: string, error?: unknown) => writeDiagnostic("intent.run.completed", {
    runtimeHost: "app_intent", stage, result, durationMs: Date.now() - startedAt,
    ...(error === undefined ? {} : diagnosticErrorDetails(error)),
  }, error === undefined ? "info" : "warning");
}

export const RefreshPipiDeliveriesIntent = registerAppIntentOnce("RefreshPipiDeliveriesIntent", () =>
  AppIntentManager.register({
    name: "RefreshPipiDeliveriesIntent",
    protocol: AppIntentProtocol.AppIntent,
    perform: async () => {
      const end = beginIntentRun("refresh");
      try {
        backgroundHostBootstrap();
        const summary = await refreshAllShipments(undefined, backgroundRefreshOptions());
        // The international Watch rows follow the domestic pass, as on the widget (G-HIGH-10).
        let latest = summary && !summary.skipReason ? summary.state : undefined;
        if (latest && typeof refreshDueWatchShipments === "function") {
          const watch = await refreshDueWatchShipments(latest);
          if (watch) latest = watch;
        }
        await Promise.all([
          typeof synchronizeParcelCloudRecords === "function"
            ? synchronizeParcelCloudRecords(5_000).catch(() => undefined)
            : Promise.resolve(),
          typeof synchronizeMeals === "function"
            ? (async () => {
                if (typeof ensureMealRules === "function") {
                  const ready = await ensureMealRules("meal_sync").catch(() => null);
                  if (!ready) return;
                }
                await synchronizeMeals(5_000).catch(() => undefined);
              })()
            : Promise.resolve(),
        ]);
        if (typeof retireCompletedParcelActivities === "function" && latest) {
          await retireCompletedParcelActivities(latest);
        }
        end(summary?.skipReason ? "skipped" : "completed");
      } catch (error) {
        end("failed", error);
        throw new Error("快递更新失败，请稍后重试。");
      } finally {
        flushDiagnostics();
      }
    },
  }),
);

export const CompleteParcelActivityIntent = registerAppIntentOnce("CompleteParcelActivityIntent", () =>
  AppIntentManager.register({
    name: "CompleteParcelActivityIntent",
    protocol: AppIntentProtocol.LiveActivityIntent,
    perform: async (params: ParcelActivityCompletion) => {
      const end = beginIntentRun("complete_activity");
      try {
        await completeParcelActivity(params);
        if (typeof synchronizeParcelCloudRecords === "function") {
          await synchronizeParcelCloudRecords(4_000).catch(() => undefined);
        }
        end("completed");
      } catch (error) {
        end("failed", error);
        throw error;
      } finally {
        flushDiagnostics();
      }
    },
  }),
);
