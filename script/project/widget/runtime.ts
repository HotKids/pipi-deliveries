export type WidgetPresentationKind = "small" | "medium" | "unsupported";

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
