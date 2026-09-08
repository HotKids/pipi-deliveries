export type WidgetPresentationKind = "small" | "medium" | "unsupported";

export const WIDGET_REFRESH_BUDGET_MS = 120_000;
export const WIDGET_REFRESH_WAIT_MS = 122_000;
export const WIDGET_RELOAD_AFTER_MS = 15 * 60 * 1_000;
export const WIDGET_RECENT_STATE_MS = 60_000;

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
  refresh: () => Promise<unknown>,
  waitMs = WIDGET_REFRESH_WAIT_MS,
): Promise<"completed" | "failed" | "timed_out"> {
  let timer: number | null = null;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), Math.max(1, waitMs));
  });
  try {
    return await Promise.race([
      refresh().then(
        () => "completed" as const,
        () => "failed" as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

export function shouldRunWidgetNetworkRefresh(
  stateUpdatedAtMs: number,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(stateUpdatedAtMs) || stateUpdatedAtMs <= 0) return true;
  return now - stateUpdatedAtMs >= WIDGET_RECENT_STATE_MS;
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
