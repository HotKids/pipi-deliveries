import { Intent, Script } from "scripting";
import { refreshIntentMessage } from "./services/refresh-result";
import { refreshAllShipments } from "./services/sync";

async function run() {
  try {
    const summary = await refreshAllShipments(undefined, {
      budgetMs: 20_000,
      accountOrderProjection: false,
    });
    Script.exit(Intent.text(refreshIntentMessage(summary)));
  } catch {
    Script.exit(Intent.text("快递更新失败，请稍后重试。"));
  }
}

void run();
