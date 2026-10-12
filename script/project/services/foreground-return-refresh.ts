import type { AppState, RefreshSummary } from "../models";
import { refreshAllShipments, subscribeFullRefreshOutcome, type FullRefreshOutcome } from "./sync";

/**
 * Returning to the foreground refreshes the list (audit R4, user default #11, 2026-09-25: all three
 * clients refresh on return to the foreground with a shared debounce, 2 minutes since the user's
 * 2026-10-02「改成 2 分钟（三端一起）」, 30 seconds before; IOS_REFRESH_PLAN asks
 * for 「启动 / 回前台」). `Script.onResume` does not fire on an ordinary return, so the app root drives
 * this from the scene phase. Only a return from the background counts; an inactive moment (Control
 * Center, a system sheet) is not a return. Any foreground full refresh of this runtime — the launch
 * refresh, a resume or a pull — restarts the debounce.
 */
export const FOREGROUND_REFRESH_DEBOUNCE_MS = 120_000;

export type ForegroundRefreshDependencies = Readonly<{
  refresh: () => Promise<RefreshSummary>;
  applyState: (state: AppState) => void;
  subscribeRefreshOutcome: (listener: (outcome: FullRefreshOutcome) => void) => () => void;
  now?: () => number;
  debounceMs?: number;
}>;

export type ForegroundRefresh = Readonly<{
  scenePhaseChanged: (phase: "active" | "inactive" | "background") => void;
  stop: () => void;
}>;

export function createForegroundRefresh(dependencies: ForegroundRefreshDependencies): ForegroundRefresh {
  const now = dependencies.now ?? Date.now;
  const debounceMs = dependencies.debounceMs ?? FOREGROUND_REFRESH_DEBOUNCE_MS;
  // The app root mounts on screen together with its launch refresh.
  let lastRefreshAtMs = now();
  let wasBackground = false;
  let running = false;
  let stopped = false;
  const unsubscribe = dependencies.subscribeRefreshOutcome((outcome) => {
    // A widget or background host's round is not this app's foreground refresh.
    if (outcome.trigger !== "background") lastRefreshAtMs = now();
  });
  return {
    scenePhaseChanged(phase) {
      if (stopped) return;
      if (phase === "background") {
        wasBackground = true;
        return;
      }
      if (phase !== "active" || !wasBackground) return;
      wasBackground = false;
      if (running || now() - lastRefreshAtMs < debounceMs) return;
      running = true;
      lastRefreshAtMs = now();
      void dependencies.refresh()
        .then((summary) => { if (!stopped) dependencies.applyState(summary.state); })
        .catch(() => { /* the persisted state stays on screen; the refresh records its own failure */ })
        .finally(() => { running = false; });
    },
    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}

/** The app root's wiring; widget and App Intent entry points never import this module. */
export function startForegroundRefresh(
  host: Readonly<{ applyState: (state: AppState) => void }>,
): ForegroundRefresh {
  return createForegroundRefresh({
    refresh: () => refreshAllShipments(),
    applyState: host.applyState,
    subscribeRefreshOutcome: subscribeFullRefreshOutcome,
  });
}
