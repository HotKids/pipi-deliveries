export type JsonObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asPlainObject(value: unknown): JsonObject {
  return isPlainObject(value) ? value : {};
}

export function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function cleanScalarText(value: unknown, finiteOnly = false): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && (!finiteOnly || Number.isFinite(value))) {
    return String(value).trim();
  }
  return "";
}

export function firstCleanString(
  value: JsonObject,
  ...keys: string[]
): string {
  for (const key of keys) {
    const candidate = cleanString(value[key]);
    if (candidate) return candidate;
  }
  return "";
}

export function firstCleanScalarText(
  value: JsonObject,
  ...keys: string[]
): string {
  for (const key of keys) {
    const candidate = cleanScalarText(value[key]);
    if (candidate) return candidate;
  }
  return "";
}

export function positiveFiniteTime(value: unknown, maxAtMs?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (maxAtMs !== undefined && value > maxAtMs) {
    return 0;
  }
  return value;
}

/** The Worker's `CLOUD_EDIT_FUTURE_TOLERANCE_MS` (cloud_records.js): how far a cloud time may lead this clock. */
export const CLOUD_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

/**
 * A cloud record time on this device's clock (fourth external review R4-NEW-06, fifth review R5-NEW-11 ④): a time up
 * to the tolerance ahead of this clock reads as now, `null` names one further ahead, and 0 an invalid time.
 */
export function cloudRecordTime(value: unknown, now: number): number | null {
  const at = positiveFiniteTime(value);
  if (!at) return 0;
  return at > now + CLOUD_FUTURE_TOLERANCE_MS ? null : Math.min(at, now);
}

export function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : cloneJsonValue(item),
    ) as unknown as T;
  }
  if (isPlainObject(value)) {
    const cloned: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        cloned[key] = cloneJsonValue(entry);
      }
    }
    return cloned as unknown as T;
  }
  return value;
}

export function cloneJsonRecord(value: unknown): JsonObject | undefined {
  if (!isPlainObject(value)) return undefined;
  return cloneJsonValue(value);
}
