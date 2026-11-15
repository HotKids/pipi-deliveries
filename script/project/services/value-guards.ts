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
