/**
 * Widget timeline telemetry (方案 A 验证, 2026-09-04).
 *
 * The widget is our only background refresh path, but WidgetKit documents neither a cadence nor
 * an execution budget for a timeline provider, and our run awaits up to 122 s of network work.
 * Two facts decide whether that assumption holds, and neither is observable from inside a single
 * run: how long WidgetKit actually waits between runs, and whether the extension survives to
 * `Widget.present`.
 *
 * So each run stamps its start time in shared storage and reports the gap since the previous
 * stamp. A run that is killed mid-refresh simply never writes its own completion record, which
 * is exactly the signal we need. The stamp is a single number; it holds no shipment data.
 */

const WIDGET_RUN_KEY = "pipi_deliveries_widget_run_at_v1";

/** Milliseconds since the epoch of the previous widget run, or 0 when unknown. */
export function readWidgetRunAtMs(): number {
  try {
    const stored = Number(Storage.get<number>(WIDGET_RUN_KEY, { shared: true }));
    return Number.isFinite(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
}

export function recordWidgetRunAtMs(now: number): void {
  try {
    if (!Number.isFinite(now) || now <= 0) return;
    Storage.set(WIDGET_RUN_KEY, Math.round(now), { shared: true });
  } catch {
    /* telemetry must never change what the widget renders */
  }
}

/**
 * The observed gap between two widget runs. Returns null when there is no previous run or when
 * the clock moved backwards, so the diagnostic simply omits the field instead of reporting 0.
 */
export function widgetRunGapMs(
  previousRunAtMs: number,
  now: number,
): number | null {
  if (!Number.isFinite(previousRunAtMs) || previousRunAtMs <= 0) return null;
  if (!Number.isFinite(now) || now < previousRunAtMs) return null;
  return Math.round(now - previousRunAtMs);
}
