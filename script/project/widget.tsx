import { Script, Widget } from "scripting";
import type { AppState } from "./models";
import { loadState, loadWidgetSnapshot, refreshDueWatchShipments, visibleShipments } from "./services/storage";
import { retireCompletedParcelActivities } from "./services/parcel-live-activity";
import { buildWidgetSnapshot } from "./services/status";
import { lastNetworkRefreshSuccessAtMs } from "./services/refresh-runtime-state";
import { FallbackWidget } from "./widget/FallbackWidget";
import { MediumWidget } from "./widget/MediumWidget";
import { SmallWidget } from "./widget/SmallWidget";
import { refreshAllShipments } from "./services/sync";
import {
  bestEffortWidgetRefresh,
  createWidgetStateHolder,
  safelyLoadWidgetSnapshot,
  shouldRunWidgetNetworkRefresh,
  WIDGET_REFRESH_BUDGET_MS,
  WIDGET_REFRESH_WAIT_MS,
  WIDGET_RELOAD_AFTER_MS,
  widgetReloadPolicy,
  widgetPresentationKind,
} from "./widget/runtime";
import {
  readWidgetRunAtMs,
  recordWidgetRunAtMs,
  widgetRunGapMs,
} from "./widget/telemetry";
import {
  beginDiagnosticFlow, createDiagnosticFlowId, flushDiagnostics, writeDiagnostic, writeRuntimeCapabilities,
  type DiagnosticDetails,
} from "./services/logger";
import { backgroundHostBootstrap, backgroundRefreshOptions } from "./services/background-refresh";

function widgetContent(refreshedState?: AppState | null) {
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
    const snapshotResult = safelyLoadWidgetSnapshot(() => {
      const now = Date.now();
      return refreshedState
        ? buildWidgetSnapshot(visibleShipments(refreshedState, now), now)
        : loadWidgetSnapshot(now);
    });
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
  // 方案 A 验证 (2026-09-04): the widget timeline is our only background refresh path, and WidgetKit documents neither
  // its cadence nor an execution budget. One record answers both from the log alone (D159, plan step 5, owner
  // 2026-11-21 「删噪声，低价值类保底降到 10（推荐）」): `widget.run.completed` carries the observed cadence
  // (`sincePreviousMs`), the refresh outcome and the run's duration. A run the extension killed writes no end line;
  // its marker is reported as unfinished by the next host start (D4).
  const startedAtMs = Date.now();
  const flowId = createDiagnosticFlowId("widget");
  writeRuntimeCapabilities("widget", flowId);
  const gapMs = widgetRunGapMs(readWidgetRunAtMs(), startedAtMs);
  recordWidgetRunAtMs(startedAtMs);
  const kind = widgetPresentationKind(String(Widget.family || ""));
  beginDiagnosticFlow("widget.run.started", {
    flowId,
    stage: "widget_timeline",
    widgetSize: kind,
    budgetMs: WIDGET_REFRESH_BUDGET_MS,
    ...(gapMs == null ? {} : { sincePreviousMs: gapMs }),
  });
  const finish = (result: string, extra: DiagnosticDetails = {}, level: "info" | "warning" = "info") =>
    writeDiagnostic("widget.run.completed", {
      flowId,
      stage: "widget_timeline",
      widgetSize: kind,
      budgetMs: WIDGET_REFRESH_BUDGET_MS,
      ...(gapMs == null ? {} : { sincePreviousMs: gapMs }),
      ...extra,
      result,
      durationMs: Date.now() - startedAtMs,
      reloadAfterMs: WIDGET_RELOAD_AFTER_MS,
    }, level);
  if (kind === "unsupported") {
    // 不支持的尺寸直接兜底，不做网络刷新，也不等预算（2026-09-06 静态审查发现）。
    const content = widgetContent();
    finish("unsupported");
    flushDiagnostics();
    Widget.present(content, { reloadPolicy: widgetReloadPolicy() });
    return;
  }
  let bootstrapReady = false;
  try {
    backgroundHostBootstrap();
    bootstrapReady = true;
  } catch {
    /* Reported as the run's result below. */
  }
  let shouldRefresh = true;
  try {
    shouldRefresh = shouldRunWidgetNetworkRefresh(
      lastNetworkRefreshSuccessAtMs(),
    );
  } catch {
    shouldRefresh = true;
  }
  const refreshed = createWidgetStateHolder();
  const waitMs = WIDGET_REFRESH_WAIT_MS - (Date.now() - startedAtMs);
  let result = "bootstrap_failed";
  let extra: DiagnosticDetails = {};
  let level: "info" | "warning" = "warning";
  if (bootstrapReady && shouldRefresh && waitMs > 1_000) {
    const refreshStartedAtMs = Date.now();
    let watchState: AppState | undefined;
    const outcome = await bestEffortWidgetRefresh(async () => {
      const budget = Math.min(WIDGET_REFRESH_BUDGET_MS, waitMs - 1_000);
      let initialState: AppState | undefined;
      try { initialState = loadState(); } catch { /* Domestic refresh still runs with its own state load. */ }
      const [summary, watch] = await Promise.all([
        refreshAllShipments(undefined, backgroundRefreshOptions(budget)),
        initialState ? refreshDueWatchShipments(initialState, budget) : Promise.resolve(undefined),
      ]);
      watchState = watch;
      const domestic = !summary.skipReason && summary.state ? summary.state : null;
      refreshed.state = watch && (!domestic || watch.revision > domestic.revision) ? watch : domestic;
      if (typeof retireCompletedParcelActivities === "function" && refreshed.state) {
        await retireCompletedParcelActivities(refreshed.state);
      }
      return summary;
    }, waitMs);
    if (outcome !== "completed" && outcome !== "partial") refreshed.state = watchState ?? null;
    result = outcome;
    extra = {
      ...(outcome === "skipped" ? { skipReason: "active_cross_runtime_refresh" } : {}),
      refreshMs: Date.now() - refreshStartedAtMs,
    };
    level = outcome === "completed" || outcome === "skipped" ? "info" : "warning";
  } else if (bootstrapReady) {
    result = shouldRefresh ? "budget_exhausted" : "recent_state";
    extra = { skipReason: result };
    level = "info";
  }
  // The host destroys this context as soon as the timeline is presented, so the run must be
  // reported before that call, not after it.
  const content = widgetContent(refreshed.state);
  finish(result, extra, level);
  flushDiagnostics();
  Widget.present(content, { reloadPolicy: widgetReloadPolicy() });
}

void run();
