import { AppIntentManager, AppIntentProtocol } from "scripting";
import { refreshAllShipments } from "./services/sync";
import { refreshDueWatchShipments } from "./services/storage";
import { backgroundHostBootstrap, backgroundRefreshOptions } from "./services/background-refresh";
import { diagnosticErrorDetails, flushDiagnostics, writeDiagnostic, writeRuntimeCapabilities } from "./services/logger";
import { completeParcelActivity, type ParcelActivityCompletion } from "./services/parcel-activity-action";
import { retireCompletedParcelActivities } from "./services/parcel-live-activity";
import { synchronizeParcelCloudRecords } from "./services/parcel-cloud-sync";

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

export const RefreshPipiDeliveriesIntent = AppIntentManager.register({
  name: "RefreshPipiDeliveriesIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    const end = beginIntentRun("refresh");
    try {
      backgroundHostBootstrap();
      const summary = await refreshAllShipments(undefined, backgroundRefreshOptions());
      // The international Watch rows follow the domestic pass, as on the widget (G-HIGH-10).
      let latest = summary && !summary.skipReason ? summary.state : undefined;
      if (latest) {
        const watch = await refreshDueWatchShipments(latest);
        if (watch) latest = watch;
      }
      if (typeof retireCompletedParcelActivities === "function" && latest) {
        await retireCompletedParcelActivities(latest);
      }
      if (typeof synchronizeParcelCloudRecords === "function") {
        await synchronizeParcelCloudRecords(5_000).catch(() => undefined);
      }
      end(summary?.skipReason ? "skipped" : "completed");
    } catch (error) {
      end("failed", error);
      throw new Error("快递更新失败，请稍后重试。");
    } finally {
      flushDiagnostics();
    }
  },
});

export const CompleteParcelActivityIntent = AppIntentManager.register({
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
});
