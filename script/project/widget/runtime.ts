import type { AppState, RefreshSummary } from "../models";

export function createWidgetStateHolder(): { state: AppState | null } {
  return { state: null };
}

export type WidgetPresentationKind = "small" | "medium" | "unsupported";

// Reserve time for loading the local snapshot and presenting it within the widget host's run.
export const WIDGET_REFRESH_BUDGET_MS = 7_000;
export const WIDGET_REFRESH_WAIT_MS = 8_000;
export const WIDGET_RELOAD_AFTER_MS = 15 * 60 * 1_000;
export const WIDGET_RECENT_STATE_MS = 60_000;
export const WIDGET_FAILURE_BACKOFF_MS = 45_000;

export function widgetPresentationKind(family: string): WidgetPresentationKind {
  if (family === "systemSmall") return "small";
  if (family === "systemMedium") return "medium";
  return "unsupported";
}

export type WidgetSnapshotResult<T> =
  | { ok: true; value: T }
  | { ok: false };

export function safelyLoadWidgetSnapshot<T>(
  load: () => T,
): WidgetSnapshotResult<T> {
  try {
    return { ok: true, value: load() };
  } catch {
    return { ok: false };
  }
}

export async function bestEffortWidgetRefresh(
  refresh: () => Promise<Pick<RefreshSummary, "attempted" | "succeeded" | "failed" | "skipReason">>,
  waitMs = WIDGET_REFRESH_WAIT_MS,
): Promise<"completed" | "partial" | "skipped" | "failed" | "timed_out"> {
  let timer: number | null = null;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), Math.max(1, waitMs));
  });
  try {
    return await Promise.race([
      refresh().then(
        summary => {
          if (summary.skipReason) return "skipped" as const;
          if (summary.attempted > 0 && summary.succeeded === 0) return "failed" as const;
          return summary.failed > 0 ? "partial" as const : "completed" as const;
        },
        () => "failed" as const,
      ),
      timeout,
    ]);
  } catch {
    return "failed";
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export function shouldRunWidgetNetworkRefresh(
  stateUpdatedAtMs: number,
  now = Date.now(),
  recentFailure?: Readonly<{
    failedAtMs: number;
    stateRevision: number;
    currentStateRevision?: number;
  }>,
): boolean {
  if (Number.isFinite(stateUpdatedAtMs) && stateUpdatedAtMs > 0 && now - stateUpdatedAtMs < WIDGET_RECENT_STATE_MS) {
    return false;
  }
  if (
    recentFailure &&
    Number.isFinite(recentFailure.failedAtMs) &&
    recentFailure.failedAtMs > 0 &&
    now >= recentFailure.failedAtMs &&
    now - recentFailure.failedAtMs < WIDGET_FAILURE_BACKOFF_MS &&
    (recentFailure.currentStateRevision === undefined ||
      recentFailure.currentStateRevision <= recentFailure.stateRevision)
  ) {
    return false;
  }
  return true;
}

export function widgetReloadPolicy(now = Date.now()): Readonly<{
  policy: "after";
  date: Date;
}> {
  return {
    policy: "after",
    date: new Date(now + WIDGET_RELOAD_AFTER_MS),
  };
}
