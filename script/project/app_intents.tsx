import { AppIntentManager, AppIntentProtocol } from "scripting";
import { refreshAllShipments } from "./services/sync";
import { loadCarrierAuthorityCache } from "./services/carrier-authority";

export const RefreshPipiDeliveriesIntent = AppIntentManager.register({
  name: "RefreshPipiDeliveriesIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    loadCarrierAuthorityCache();
    await refreshAllShipments(undefined, {
      budgetMs: 120_000,
      accountOrderProjection: true,
      backgroundHostSafe: true,
    });
  },
});
