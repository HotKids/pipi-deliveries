import { AppIntentManager, AppIntentProtocol } from "scripting";
import { refreshAllShipments } from "./services/sync";
import { backgroundHostBootstrap, backgroundRefreshOptions } from "./services/background-refresh";
import { flushDiagnostics } from "./services/logger";
import { completeParcelActivity, type ParcelActivityCompletion } from "./services/parcel-activity-action";

export const RefreshPipiDeliveriesIntent = AppIntentManager.register({
  name: "RefreshPipiDeliveriesIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    try {
      backgroundHostBootstrap();
      await refreshAllShipments(undefined, backgroundRefreshOptions());
    } catch {
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
    try {
      await completeParcelActivity(params);
    } finally {
      flushDiagnostics();
    }
  },
});
