import { Intent, Script } from "scripting";
import { refreshIntentMessage } from "./services/refresh-result";
import { refreshAllShipments } from "./services/sync";
import { backgroundHostBootstrap, backgroundRefreshOptions } from "./services/background-refresh";
import { flushDiagnostics } from "./services/logger";

async function run() {
  try {
    backgroundHostBootstrap();
    const summary = await refreshAllShipments(undefined, backgroundRefreshOptions());
    flushDiagnostics();
    Script.exit(Intent.text(refreshIntentMessage(summary)));
  } catch {
    flushDiagnostics();
    Script.exit(Intent.text("快递更新失败，请稍后重试。"));
  }
}

void run();
