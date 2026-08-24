import type { StatusSemantic } from "../models";
import {
  readDurableTextCandidates,
  writeDurableText,
} from "./durable-files";

const NOTIFICATION_PREFERENCES_KEY =
  "pipi_deliveries_notification_preferences_v1";
const NOTIFICATION_PREFERENCES_FILE = "notification-preferences-v1.json";

export const NOTIFICATION_STATUS_OPTIONS = [
  "ORDERED",
  "SHIPPED",
  "PICKED",
  "TRANSIT",
  "DELIVERY",
  "WAITING_PICKUP",
  "COMPLETED",
  "DANGER",
  "CANCELLED",
] as const satisfies readonly StatusSemantic[];

export const IMPORTANT_NOTIFICATION_STATUSES = [
  "PICKED",
  "DELIVERY",
  "WAITING_PICKUP",
  "DANGER",
  "CANCELLED",
] as const satisfies readonly StatusSemantic[];

export const REGULAR_NOTIFICATION_STATUSES = [
  "ORDERED",
  "SHIPPED",
  "TRANSIT",
  "COMPLETED",
] as const satisfies readonly StatusSemantic[];

const VALID_STATUSES = new Set<StatusSemantic>(NOTIFICATION_STATUS_OPTIONS);

type StoredNotificationPreferences = {
  schema: 1;
  updatedAtMs: number;
  enabled: StatusSemantic[];
};

let cachedEnabled: StatusSemantic[] | null = null;

function normalizedStatuses(values: readonly StatusSemantic[]): StatusSemantic[] {
  const selected = new Set(
    values.filter((value) => VALID_STATUSES.has(value)),
  );
  return NOTIFICATION_STATUS_OPTIONS.filter((value) => selected.has(value));
}

export function setNotificationGroupEnabled(
  current: readonly StatusSemantic[],
  group: readonly StatusSemantic[],
  enabled: boolean,
): StatusSemantic[] {
  const selected = new Set(current);
  for (const semantic of group) {
    if (enabled) selected.add(semantic);
    else selected.delete(semantic);
  }
  return normalizedStatuses([...selected]);
}

function decode(raw: unknown): StoredNotificationPreferences | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredNotificationPreferences>;
    if (
      parsed.schema !== 1 ||
      typeof parsed.updatedAtMs !== "number" ||
      !Number.isFinite(parsed.updatedAtMs) ||
      parsed.updatedAtMs < 0 ||
      !Array.isArray(parsed.enabled) ||
      parsed.enabled.some(
        (value) => typeof value !== "string" || !VALID_STATUSES.has(value),
      )
    ) return null;
    return {
      schema: 1,
      updatedAtMs: parsed.updatedAtMs,
      enabled: normalizedStatuses(parsed.enabled as StatusSemantic[]),
    };
  } catch {
    return null;
  }
}

function storedCandidates(): StoredNotificationPreferences[] {
  const candidates: string[] = [];
  try {
    candidates.push(
      ...readDurableTextCandidates(NOTIFICATION_PREFERENCES_FILE),
    );
  } catch {
    /* the shared generation may still be available */
  }
  try {
    candidates.push(
      Storage.get<string>(NOTIFICATION_PREFERENCES_KEY, { shared: true }) || "",
    );
  } catch {
    /* a durable generation may still be available */
  }
  return candidates
    .map(decode)
    .filter((value): value is StoredNotificationPreferences => value != null)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function loadNotificationStatuses(
  refresh = false,
): StatusSemantic[] {
  if (!refresh && cachedEnabled) return [...cachedEnabled];
  cachedEnabled = storedCandidates()[0]?.enabled || [
    ...NOTIFICATION_STATUS_OPTIONS,
  ];
  return [...cachedEnabled];
}

export function saveNotificationStatuses(
  values: readonly StatusSemantic[],
  now = Date.now(),
): StatusSemantic[] {
  const stored: StoredNotificationPreferences = {
    schema: 1,
    updatedAtMs: now,
    enabled: normalizedStatuses(values),
  };
  const serialized = JSON.stringify(stored);
  let durable = false;
  let shared = false;
  try {
    writeDurableText(NOTIFICATION_PREFERENCES_FILE, serialized);
    durable = readDurableTextCandidates(NOTIFICATION_PREFERENCES_FILE)
      .includes(serialized);
  } catch {
    durable = false;
  }
  try {
    shared = Storage.set(
      NOTIFICATION_PREFERENCES_KEY,
      serialized,
      { shared: true },
    ) !== false &&
      Storage.get<string>(NOTIFICATION_PREFERENCES_KEY, { shared: true }) ===
        serialized;
  } catch {
    shared = false;
  }
  if (!durable && !shared) throw new Error("无法保存通知设置，请重试");
  cachedEnabled = stored.enabled;
  return [...cachedEnabled];
}

export function notificationEnabled(semantic: StatusSemantic): boolean {
  return VALID_STATUSES.has(semantic) &&
    loadNotificationStatuses().includes(semantic);
}

export function notificationEnabledCount(refresh = false): number {
  return loadNotificationStatuses(refresh).length;
}
