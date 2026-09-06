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
  WIDGET_RELOAD_AFTER_MS,
  widgetReloadPolicy,
  widgetPresentationKind,
} from "./widget/runtime";
import {
  readWidgetRunAtMs,
  recordWidgetRunAtMs,
  widgetRunGapMs,
} from "./widget/telemetry";
import { createDiagnosticFlowId, writeDiagnostic } from "./services/logger";
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
  // 方案 A 验证 (2026-09-04): the widget timeline is our only background refresh path, and
  // WidgetKit documents neither its cadence nor an execution budget. These three records answer
  // both questions from the log alone: `sincePreviousMs` is the observed cadence, and a
  // `widget.run.started` with no matching `widget.run.presenting` means the extension was killed.
  const startedAtMs = Date.now();
  const flowId = createDiagnosticFlowId("widget");
  const gapMs = widgetRunGapMs(readWidgetRunAtMs(), startedAtMs);
  recordWidgetRunAtMs(startedAtMs);
  const kind = widgetPresentationKind(String(Widget.family || ""));
  writeDiagnostic("widget.run.started", {
    flowId,
    stage: "widget_timeline",
    result: kind,
    budgetMs: WIDGET_REFRESH_BUDGET_MS,
    ...(gapMs == null ? {} : { sincePreviousMs: gapMs }),
  });
  if (kind === "unsupported") {
    // 不支持的尺寸直接兜底，不做网络刷新，也不等预算（2026-09-06 静态审查发现）。
    writeDiagnostic("widget.run.presenting", {
      flowId,
      stage: "widget_present",
      result: kind,
      durationMs: Date.now() - startedAtMs,
      reloadAfterMs: WIDGET_RELOAD_AFTER_MS,
    });
    Widget.present(widgetContent(), { reloadPolicy: widgetReloadPolicy() });
    return;
  }
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
    const refreshStartedAtMs = Date.now();
    const outcome = await bestEffortWidgetRefresh(() =>
      refreshAllShipments(undefined, {
        budgetMs: WIDGET_REFRESH_BUDGET_MS,
        accountOrderProjection: true,
        backgroundHostSafe: true,
      })
    );
    writeDiagnostic(
      "widget.refresh.completed",
      {
        flowId,
        stage: "widget_timeline",
        result: outcome,
        durationMs: Date.now() - refreshStartedAtMs,
        budgetMs: WIDGET_REFRESH_BUDGET_MS,
      },
      outcome === "completed" ? "info" : "warning",
    );
  } else {
    writeDiagnostic("widget.refresh.skipped", {
      flowId,
      stage: "widget_timeline",
      result: "recent_state",
      skipReason: "recent_state",
    });
  }
  // The host destroys this context as soon as the timeline is presented, so the run must be
  // reported before that call, not after it.
  writeDiagnostic("widget.run.presenting", {
    flowId,
    stage: "widget_present",
    result: kind,
    durationMs: Date.now() - startedAtMs,
    reloadAfterMs: WIDGET_RELOAD_AFTER_MS,
  });
  Widget.present(widgetContent(), { reloadPolicy: widgetReloadPolicy() });
}

void run();
