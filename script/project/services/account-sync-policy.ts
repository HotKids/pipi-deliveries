import { deadlineAfter } from "./deadline";

export const ACCOUNT_LIST_BUDGET_MS = 12_000;
export const ACCOUNT_DETAIL_BUDGET_MS = 5_000;
export const ACCOUNT_FOLLOWUP_RESERVE_MS = 10_000;
export const ENRICHMENT_ROTATION_MS = 30 * 60 * 1000;
export const ACCOUNT_ORDER_PROJECTION_RETRY_MS = 60 * 60 * 1000;

export type AccountOrderProjectionRetry = Readonly<{
  routeHash: string;
  failedAtMs?: number;
  attemptId?: string;
  attemptExpiresAtMs?: number;
}>;

export function activeAccountOrderProjectionAttempt(
  retry: AccountOrderProjectionRetry | null | undefined,
  routeHash: string,
  now = Date.now(),
): boolean {
  const normalizedRouteHash = String(routeHash || "").trim().toLowerCase();
  const storedRouteHash = String(retry?.routeHash || "").trim().toLowerCase();
  const attemptId = String(retry?.attemptId || "").trim();
  const attemptExpiresAtMs = Number(retry?.attemptExpiresAtMs);
  return /^[a-f0-9]{64}$/.test(normalizedRouteHash) &&
    storedRouteHash === normalizedRouteHash &&
    /^[a-z0-9-]{8,80}$/.test(attemptId) &&
    Number.isFinite(attemptExpiresAtMs) &&
    now < attemptExpiresAtMs;
}

export function accountOrderProjectionAttemptRemainingMs(
  retry: AccountOrderProjectionRetry | null | undefined,
  now = Date.now(),
): number {
  const routeHash = String(retry?.routeHash || "").trim().toLowerCase();
  if (!activeAccountOrderProjectionAttempt(retry, routeHash, now)) return 0;
  return Math.max(0, Math.floor(Number(retry?.attemptExpiresAtMs) - now));
}

export function shouldRetryAccountOrderProjection(
  retry: AccountOrderProjectionRetry | null | undefined,
  routeHash: string,
  now = Date.now(),
  force = false,
): boolean {
  if (activeAccountOrderProjectionAttempt(retry, routeHash, now)) return false;
  if (force) return true;
  const normalizedRouteHash = String(routeHash || "").trim().toLowerCase();
  const storedRouteHash = String(retry?.routeHash || "").trim().toLowerCase();
  const failedAtMs = Number(retry?.failedAtMs);
  if (
    !/^[a-f0-9]{64}$/.test(normalizedRouteHash) ||
    !/^[a-f0-9]{64}$/.test(storedRouteHash) ||
    storedRouteHash !== normalizedRouteHash ||
    !Number.isFinite(failedAtMs) ||
    failedAtMs <= 0 ||
    now < failedAtMs
  ) {
    return true;
  }
  return now - failedAtMs >= ACCOUNT_ORDER_PROJECTION_RETRY_MS;
}

export function accountChildDeadline(
  parentDeadlineAtMs: number | undefined,
  budgetMs: number,
  reserveMs = 0,
  now = Date.now(),
): number {
  const ownDeadline = deadlineAfter(budgetMs, now);
  if (parentDeadlineAtMs == null) return ownDeadline;
  return Math.min(ownDeadline, parentDeadlineAtMs - reserveMs);
}

export function rotatingIndices(
  length: number,
  now = Date.now(),
): number[] {
  const count = Math.max(0, Math.floor(length));
  if (!count) return [];
  const start = Math.floor(now / ENRICHMENT_ROTATION_MS) % count;
  return Array.from({ length: count }, (_, offset) => (start + offset) % count);
}

export function rotatingBatchIndices(
  length: number,
  limit: number,
  now = Date.now(),
): number[] {
  return rotatingIndices(length, now).slice(
    0,
    Math.max(0, Math.floor(limit)),
  );
}

export function boundedCursorIndices(
  length: number,
  limit: number,
  cursor: number,
): number[] {
  const count = Math.max(0, Math.floor(length));
  const boundedLimit = Math.min(count, Math.max(0, Math.floor(limit)));
  if (!count || !boundedLimit) return [];
  const normalizedCursor = Math.floor(Number(cursor) || 0);
  const start = ((normalizedCursor % count) + count) % count;
  return Array.from(
    { length: boundedLimit },
    (_, offset) => (start + offset) % count,
  );
}

export function shouldProjectAccountOrder(
  accountOrderProjection: boolean,
  accountOrder: boolean,
  selected: boolean,
  deadlineExpired: boolean,
): boolean {
  return accountOrderProjection && accountOrder && selected && !deadlineExpired;
}
