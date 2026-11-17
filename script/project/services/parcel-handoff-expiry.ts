import type { PickupCodeRecord } from "../models";

const HANDOFF_GRACE_MS = 60 * 60 * 1000;

export function parcelHandoffDeadline(record: PickupCodeRecord | null | undefined): number | undefined {
  if (record?.kind !== "handoff" || record.completedAtMs || record.expiredAtMs) return undefined;
  const end = record.windowEndAtMs || 0;
  const start = record.windowStartAtMs ?? 0;
  return Number.isSafeInteger(end) && end > 0 && Number.isFinite(new Date(end).getTime()) &&
    Number.isSafeInteger(start) && start >= 0 && start <= end
    ? end + HANDOFF_GRACE_MS
    : undefined;
}

export function nextParcelHandoffDeadline(records: readonly PickupCodeRecord[] = []): number | undefined {
  let earliest: number | undefined;
  for (const record of records) {
    const deadline = parcelHandoffDeadline(record);
    if (deadline !== undefined && (earliest === undefined || deadline < earliest)) earliest = deadline;
  }
  return earliest;
}
