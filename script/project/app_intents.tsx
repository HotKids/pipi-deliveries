import { AppIntentManager, AppIntentProtocol } from "scripting";
import type { ParcelActivityCompletion } from "./services/parcel-activity-action";
import { diagnosticErrorDetails, flushDiagnostics, writeDiagnostic, writeRuntimeCapabilities } from "./services/logger";

declare const backgroundHostBootstrap:
  | (typeof import("./services/background-refresh"))["backgroundHostBootstrap"]
  | undefined;
declare const backgroundRefreshOptions:
  | (typeof import("./services/background-refresh"))["backgroundRefreshOptions"]
  | undefined;
declare const refreshAllShipments:
  | (typeof import("./services/sync"))["refreshAllShipments"]
  | undefined;
declare const refreshDueWatchShipments:
  | (typeof import("./services/storage"))["refreshDueWatchShipments"]
  | undefined;
declare const retireCompletedParcelActivities:
  | (typeof import("./services/parcel-live-activity"))["retireCompletedParcelActivities"]
  | undefined;
declare const synchronizeParcelCloudRecords:
  | (typeof import("./services/parcel-cloud-sync"))["synchronizeParcelCloudRecords"]
  | undefined;
declare const ensureMealRules:
  | (typeof import("./services/carrier-authority"))["ensureMealRules"]
  | undefined;
declare const synchronizeMeals:
  | (typeof import("./services/meal/cloud"))["synchronizeMeals"]
  | undefined;
declare const completeParcelActivity:
  | (typeof import("./services/parcel-activity-action"))["completeParcelActivity"]
  | undefined;

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
      const injectedBootstrap = typeof backgroundHostBootstrap === "function" ? backgroundHostBootstrap : undefined;
      const injectedOptions = typeof backgroundRefreshOptions === "function" ? backgroundRefreshOptions : undefined;
      const injectedRefresh = typeof refreshAllShipments === "function" ? refreshAllShipments : undefined;
      const injectedWatch = typeof refreshDueWatchShipments === "function" ? refreshDueWatchShipments : undefined;
      const injectedRetire = typeof retireCompletedParcelActivities === "function"
        ? retireCompletedParcelActivities
        : undefined;
      const injectedParcelCloud = typeof synchronizeParcelCloudRecords === "function"
        ? synchronizeParcelCloudRecords
        : undefined;
      const injectedEnsureMealRules = typeof ensureMealRules === "function" ? ensureMealRules : undefined;
      const injectedMealSync = typeof synchronizeMeals === "function" ? synchronizeMeals : undefined;
      try {
        {
          const backgroundHostBootstrap = injectedBootstrap
            ?? (await import("./services/background-refresh")).backgroundHostBootstrap;
          backgroundHostBootstrap();
        }
        const backgroundRefreshOptions = injectedOptions
          ?? (await import("./services/background-refresh")).backgroundRefreshOptions;
        const runRefresh = injectedRefresh ?? (await import("./services/sync")).refreshAllShipments;
        const summary = await runRefresh(undefined, backgroundRefreshOptions());
        // The international Watch rows follow the domestic pass, as on the widget (G-HIGH-10).
        let latest = summary && !summary.skipReason ? summary.state : undefined;
        if (latest) {
          const runWatch = injectedWatch
            ?? (!injectedRefresh ? (await import("./services/storage")).refreshDueWatchShipments : undefined);
          if (typeof runWatch === "function") {
            const watch = await runWatch(latest);
            if (watch) latest = watch;
          }
        }
        const parcelCloud = injectedParcelCloud
          ?? (!injectedRefresh ? (await import("./services/parcel-cloud-sync")).synchronizeParcelCloudRecords : undefined);
        const mealSync = injectedMealSync
          ?? (!injectedRefresh ? (await import("./services/meal/cloud")).synchronizeMeals : undefined);
        const mealRules = injectedEnsureMealRules
          ?? (!injectedRefresh ? (await import("./services/carrier-authority")).ensureMealRules : undefined);
        await Promise.all([
          typeof parcelCloud === "function" ? parcelCloud(5_000).catch(() => undefined) : Promise.resolve(),
          typeof mealSync === "function"
            ? (async () => {
                if (typeof mealRules === "function") {
                  const ready = await mealRules("meal_sync").catch(() => null);
                  if (!ready) return;
                }
                await mealSync(5_000).catch(() => undefined);
              })()
            : Promise.resolve(),
        ]);
        const retire = injectedRetire
          ?? (!injectedRefresh ? (await import("./services/parcel-live-activity")).retireCompletedParcelActivities : undefined);
        if (typeof retire === "function" && latest) {
          await retire(latest);
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
      const injectedComplete = typeof completeParcelActivity === "function" ? completeParcelActivity : undefined;
      const injectedParcelCloud = typeof synchronizeParcelCloudRecords === "function"
        ? synchronizeParcelCloudRecords
        : undefined;
      try {
        const complete = injectedComplete
          ?? (await import("./services/parcel-activity-action")).completeParcelActivity;
        await complete(params);
        const parcelCloud = injectedParcelCloud
          ?? (!injectedComplete ? (await import("./services/parcel-cloud-sync")).synchronizeParcelCloudRecords : undefined);
        if (typeof parcelCloud === "function") {
          await parcelCloud(4_000).catch(() => undefined);
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
