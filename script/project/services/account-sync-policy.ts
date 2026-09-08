import { deadlineAfter } from "./deadline";
import type { AccountStatusSemantic } from "./account-parser";

export const ACCOUNT_LIST_BUDGET_MS = 25_000;
// 用户定 2026-09-05：三端统一——按件详情 10s、手动每级 15s、列表 12s、网关上游 10s。
// 原 5s：同一票 EMS 0246 的按件详情每次都在 5s 处超时，Lite 同一票 1 秒拿到。
export const ACCOUNT_DETAIL_BUDGET_MS = 10_000;
export const ACCOUNT_FOLLOWUP_RESERVE_MS = 10_000;
export const ACCOUNT_FOLLOWUP_CONCURRENCY = 4;
export const ACCOUNT_ORDER_PROJECTION_BUDGET_MS = 20_000;
export const ACCOUNT_H5_BUDGET_MS = 8_000;
export const ACCOUNT_H5_CONCURRENCY = 2;
export const ENRICHMENT_ROTATION_MS = 30 * 60 * 1000;
/**
 * AGENTS §9 (2026-09-03, same on Pipi): the JD union page is reopened per order at most every
 * 10 minutes after any capture attempt, and not for an hour after a risk-control answer
 * (HTTP 403 / "刷新几遍还不行"). JD blocks the page after roughly eight loads in half an hour.
 */
export const ACCOUNT_ORDER_PROJECTION_RETRY_MS = 10 * 60 * 1000;
export const ACCOUNT_ORDER_PROJECTION_RISK_CONTROL_MS = 60 * 60 * 1000;

/** True when the union request statuses recorded by the projection probe include a 403. */
export function projectionRiskControlled(unionResponseStatuses: string | null | undefined): boolean {
  return String(unionResponseStatuses || "")
    .split(",")
    .some((status) => status.trim() === "403");
}

export type JingDongH5SkipReason =
  | "order_projection_pending"
  | "background_host_webview_disabled"
  | "route_pointer_missing";

export function jingDongH5SkipReason(
  projectedWaybill: string,
  routeUrl: string,
  allowWebViewEnrichment: boolean,
): JingDongH5SkipReason | null {
  if (!String(projectedWaybill || "").trim()) return "order_projection_pending";
  if (!allowWebViewEnrichment) return "background_host_webview_disabled";
  if (!String(routeUrl || "").trim()) return "route_pointer_missing";
  return null;
}

export type AccountOrderProjectionRetry = Readonly<{
  routeHash: string;
  failedAtMs?: number;
  /** Set when the failed attempt saw JD risk control; extends the rest to an hour. */
  riskControlAtMs?: number;
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

/**
 * AGENTS §9: every attempt rests the order for ten minutes, and a risk-control answer rests it
 * for an hour. A user-initiated refresh does not lift either rest — Pipi throws its
 * `CooldownException` on the detail path too, and a JD order that reopens the union page on
 * every detail visit is exactly what gets the account risk-controlled.
 */
export function shouldRetryAccountOrderProjection(
  retry: AccountOrderProjectionRetry | null | undefined,
  routeHash: string,
  now = Date.now(),
): boolean {
  if (activeAccountOrderProjectionAttempt(retry, routeHash, now)) return false;
  const normalizedRouteHash = String(routeHash || "").trim().toLowerCase();
  const storedRouteHash = String(retry?.routeHash || "").trim().toLowerCase();
  const sameRoute = /^[a-f0-9]{64}$/.test(normalizedRouteHash) &&
    storedRouteHash === normalizedRouteHash;
  // JD risk control rests the order for an hour even when the user pulls to refresh.
  const riskControlAtMs = Number(retry?.riskControlAtMs);
  if (
    sameRoute &&
    Number.isFinite(riskControlAtMs) &&
    riskControlAtMs > 0 &&
    now >= riskControlAtMs &&
    now - riskControlAtMs < ACCOUNT_ORDER_PROJECTION_RISK_CONTROL_MS
  ) {
    return false;
  }
  const failedAtMs = Number(retry?.failedAtMs);
  if (
    !sameRoute ||
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

export function oldestBatchIndices(
  attemptTimes: readonly number[],
  limit: number,
  cursor = 0,
): number[] {
  const rotated = boundedCursorIndices(
    attemptTimes.length,
    attemptTimes.length,
    cursor,
  );
  const tieOrder = new Map(rotated.map((index, position) => [index, position]));
  return rotated
    .sort((left, right) => {
      const leftAttempt = Number(attemptTimes[left]);
      const rightAttempt = Number(attemptTimes[right]);
      const normalizedLeft = Number.isFinite(leftAttempt) && leftAttempt > 0
        ? leftAttempt
        : 0;
      const normalizedRight = Number.isFinite(rightAttempt) && rightAttempt > 0
        ? rightAttempt
        : 0;
      return normalizedLeft - normalizedRight ||
        Number(tieOrder.get(left)) - Number(tieOrder.get(right));
    })
    .slice(0, Math.max(0, Math.floor(limit)));
}

export async function runAccountFollowupCandidates<T, R>(
  candidates: readonly T[],
  run: (candidate: T, index: number) => Promise<R>,
  concurrency = ACCOUNT_FOLLOWUP_CONCURRENCY,
): Promise<R[]> {
  if (!candidates.length) return [];
  const workerCount = Math.min(
    candidates.length,
    Math.max(1, Math.floor(concurrency)),
  );
  const results = new Array<R>(candidates.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      results[index] = await run(candidates[index], index);
    }
  }));
  return results;
}

export function shouldProjectAccountOrder(
  accountOrderProjection: boolean,
  accountOrder: boolean,
  selected: boolean,
  deadlineExpired: boolean,
): boolean {
  return accountOrderProjection && accountOrder && selected && !deadlineExpired;
}

/** An order route becomes a shipment identity source only after carrier pickup. */
export function accountOrderReadyForProjection(
  semantic: AccountStatusSemantic,
): boolean {
  return [
    "PICKED",
    "TRANSIT",
    "DELIVERY",
    "WAITING_PICKUP",
    "COMPLETED",
  ].includes(semantic);
}
