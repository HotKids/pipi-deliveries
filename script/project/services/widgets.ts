import { Widget } from "scripting";

export function requestWidgetReload(): void {
  try {
    Widget.reloadAll();
  } catch {
    /* widget refresh remains best-effort after the snapshot is persisted */
  }
}
