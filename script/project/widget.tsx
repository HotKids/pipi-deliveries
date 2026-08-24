import { Script, Widget } from "scripting";
import { loadWidgetSnapshot } from "./services/storage";
import { FallbackWidget } from "./widget/FallbackWidget";
import { MediumWidget } from "./widget/MediumWidget";
import { SmallWidget } from "./widget/SmallWidget";
import {
  safelyLoadWidgetSnapshot,
  widgetPresentationKind,
} from "./widget/runtime";

const reloadPolicy = {
  policy: "after" as const,
  date: new Date(Date.now() + 30 * 60 * 1000),
};

const content = (() => {
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
})();

Widget.present(content, { reloadPolicy });
