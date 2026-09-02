import { Script, Widget } from "scripting";
import { loadWidgetSnapshot } from "./services/storage";
import { lastNetworkRefreshSuccessAtMs } from "./services/refresh-runtime-state";
import { FallbackWidget } from "./widget/FallbackWidget";
import { MediumWidget } from "./widget/MediumWidget";
import { SmallWidget } from "./widget/SmallWidget";
import { refreshAllShipments } from "./services/sync";
import {
  bestEffortWidgetRefresh,
  safelyLoadWidgetSnapshot,
  shouldRunWidgetNetworkRefresh,
  WIDGET_REFRESH_BUDGET_MS,
  widgetReloadPolicy,
  widgetPresentationKind,
} from "./widget/runtime";
import { loadCarrierAuthorityCache } from "./services/carrier-authority";

function widgetContent() {
  const kind = widgetPresentationKind(String(Widget.family || ""));
  if (kind === "unsupported") {
    return (
      <FallbackWidget
        title="暂不支持此尺寸"
        detail="请选择 2×2 或 4×2 小组件"
      />
    );
  }
  try {
    const snapshotResult = safelyLoadWidgetSnapshot(loadWidgetSnapshot);
    if (!snapshotResult.ok) throw new Error("widget state unavailable");
    const snapshot = snapshotResult.value;
    const displaySize = Widget.displaySize;
    const openSearchURL = Script.createRunSingleURLScheme(Script.name, {
      focus: "search",
    });
    const openHomeURL = Script.createRunSingleURLScheme(Script.name, {});
    const openShipmentURL = (shipment: string) =>
      Script.createRunSingleURLScheme(Script.name, { shipment });
    return kind === "medium" ? (
      <MediumWidget
        snapshot={snapshot}
        openHomeURL={openHomeURL}
        openSearchURL={openSearchURL}
        openShipmentURL={openShipmentURL}
        displayHeight={displaySize.height}
      />
    ) : (
      <SmallWidget
        snapshot={snapshot}
        openHomeURL={openHomeURL}
        openSearchURL={openSearchURL}
        openShipmentURL={openShipmentURL}
        displayWidth={displaySize.width}
        displayHeight={displaySize.height}
      />
    );
  } catch {
    let openURL: string | undefined;
    try {
      openURL = Script.createRunSingleURLScheme(Script.name, {});
    } catch {
      openURL = undefined;
    }
    return (
      <FallbackWidget
        title="本地数据暂不可用"
        detail="打开派派助手后重试"
        openURL={openURL}
      />
    );
  }
}

async function run() {
  loadCarrierAuthorityCache();
  let shouldRefresh = true;
  try {
    shouldRefresh = shouldRunWidgetNetworkRefresh(
      lastNetworkRefreshSuccessAtMs(),
    );
  } catch {
    shouldRefresh = true;
  }
  if (shouldRefresh) {
    await bestEffortWidgetRefresh(() =>
      refreshAllShipments(undefined, {
        budgetMs: WIDGET_REFRESH_BUDGET_MS,
        accountOrderProjection: true,
        backgroundHostSafe: true,
      })
    );
  }
  Widget.present(widgetContent(), { reloadPolicy: widgetReloadPolicy() });
}

void run();
