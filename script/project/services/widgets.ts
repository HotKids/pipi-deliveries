import { Widget } from "scripting";
import { sharedData } from "./shared-file-transaction";

export const WIDGET_RELOAD_COALESCE_MS = 1_500;

let lastReloadStateRef = "";
let lastReloadAtMs = 0;

export function resetWidgetReloadCoalescingForTests(): void {
  lastReloadStateRef = "";
  lastReloadAtMs = 0;
}

export function requestWidgetReload(now = Date.now()): boolean {
  try {
    let stateRef = "";
    try {
      stateRef = String(sharedData().stateRef || "");
    } catch {
      stateRef = "";
    }
    if (
      stateRef &&
      stateRef === lastReloadStateRef &&
      now >= lastReloadAtMs &&
      now - lastReloadAtMs < WIDGET_RELOAD_COALESCE_MS
    ) {
      return false;
    }
    Widget.reloadAll();
    lastReloadStateRef = stateRef;
    lastReloadAtMs = now;
    return true;
  } catch {
    /* widget refresh remains best-effort after the snapshot is persisted */
    return false;
  }
}
