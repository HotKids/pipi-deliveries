import { AppIntentManager, AppIntentProtocol } from "scripting";
import { refreshAllShipments } from "./services/sync";

export const RefreshPipiDeliveriesIntent = AppIntentManager.register({
  name: "RefreshPipiDeliveriesIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    await refreshAllShipments(undefined, {
      budgetMs: 20_000,
      accountOrderProjection: false,
    });
  },
});
