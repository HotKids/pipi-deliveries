import { AppIntentManager, AppIntentProtocol } from "scripting";
import { refreshAllShipments } from "./services/sync";
import { backgroundHostBootstrap, backgroundRefreshOptions } from "./services/background-refresh";
import { flushDiagnostics } from "./services/logger";

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
