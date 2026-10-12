import { deadlineAfter } from "./deadline";
import { utf8Data } from "./scripting-data";
import type { AccountStatusSemantic } from "./account-parser";
import type { AccountOrderProjectionDiagnostics } from "./account-order-projection";

/** The capture strategy the per-order record is bound to: a new strategy starts every order over. */
export const ACCOUNT_ORDER_PROJECTION_STRATEGY = "jd-h5-v2";

/**
 * The order-hashed key of an order's projection record (`routeHash`): the strategy and the owner
 * row id, hashed, so the order number itself is never stored. `ownerId` is the account owner row id
 * (`interface5:account:<order>`).
 */
export function accountOrderProjectionRouteHash(ownerId: string): string {
  return Crypto.sha256(utf8Data(`${ACCOUNT_ORDER_PROJECTION_STRATEGY}\0${ownerId}`))
    .toHexString()
    .toLowerCase();
}

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

/** Both a 403 and the exact JD page message establish the same cooldown. */
export function projectionRiskControlled(unionResponseStatuses: string | null | undefined, riskControlSeen = false): boolean {
  return riskControlSeen || String(unionResponseStatuses || "")
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
  /** The latest empty-shell result not yet confirmed (completed orders only, 方案 A 2026-09-25). */
  emptyShellAtMs?: number;
  /** A second empty-shell result at least one rest later: the union page is not opened again. */
  emptyShellConfirmedAtMs?: number;
}>;

function positiveTime(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function sameRouteHash(
  retry: AccountOrderProjectionRetry | null | undefined,
  routeHash: string,
): boolean {
  const normalizedRouteHash = String(routeHash || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalizedRouteHash) &&
    String(retry?.routeHash || "").trim().toLowerCase() === normalizedRouteHash;
}

/**
 * 用户 2026-09-25 同意（方案 A）：已完成订单的京粉页一旦确认是空壳（完全没有物流接口响应），就记住这一单，
 * 不再重试。One result is not proof (Lite saw an empty page succeed 13 minutes later), so the mark
 * needs two empty-shell results of the same order at least one rest apart; see
 * `nextEmptyShellStrikes`. Bound to the order hash of the record, so a new capture strategy starts over.
 */
export function accountOrderPageConfirmedEmpty(
  retry: AccountOrderProjectionRetry | null | undefined,
  routeHash: string,
): boolean {
  return sameRouteHash(retry, routeHash) && positiveTime(retry?.emptyShellConfirmedAtMs) > 0;
}

/**
 * What one union-page result says about the page (方案 A, 2026-09-25; one definition with Lite):
 * - `logistics`: something logistics-bearing was captured — a waybill came back, the response probe
 *   queued a package, the modal / DOM / inline script produced one, a replay produced one, or a track
 *   was read. It clears the strikes.
 * - `empty_shell`: none of that, from a page that loaded completely in a visible, hosted, non-zero
 *   viewport without risk control, whose union requests either never answered or only answered
 *   2xx: iOS saw `unionResponseStatuses=200` with nothing captured, Lite saw no union response at
 *   all, and both are empty shells.
 * - `uninformative`: anything else — risk control, a union request that failed (a non-2xx status,
 *   or 0 for a network failure; two JD outages 10 minutes apart must not mark a real order), a
 *   union request the page sent that had not answered by the timeout (user decision 2026-09-26,
 *   其余裁决 4: as neutral as a failed answer; a page that never sent one is still an empty shell),
 *   a hidden, unhosted or zero-sized page, an incomplete load. It neither counts nor clears.
 */
export type UnionPageOutcome = "logistics" | "empty_shell" | "uninformative";

/** Whether any recorded union answer failed: a status outside 200–299, or 0 for a network failure. */
export function unionRequestFailed(unionResponseStatuses: string | null | undefined): boolean {
  return String(unionResponseStatuses || "")
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean)
    .some((status) => {
      const code = Number(status);
      return !(code >= 200 && code <= 299);
    });
}

export function unionPageOutcome(
  diagnostics: AccountOrderProjectionDiagnostics | null | undefined,
  waybillFound = false,
): UnionPageOutcome {
  if (waybillFound) return "logistics";
  if (!diagnostics) return "uninformative";
  if (
    Number(diagnostics.probeCaptureCount) > 0 ||
    diagnostics.probeMatched === true ||
    diagnostics.domMatched === true ||
    diagnostics.replaySucceeded === true ||
    diagnostics.projectionComplete === true ||
    Number(diagnostics.projectionTrackCount) > 0
  ) return "logistics";
  return diagnostics.loadCompleted === true &&
      diagnostics.viewportHosted === true &&
      diagnostics.viewportAvailable === true &&
      diagnostics.visibilityState === "visible" &&
      !projectionRiskControlled(diagnostics.unionResponseStatuses, diagnostics.riskControlSeen === true) &&
      !unionRequestFailed(diagnostics.unionResponseStatuses) &&
      !(Number(diagnostics.unionPendingCount) > 0)
    ? "empty_shell"
    : "uninformative";
}

/**
 * The strike fields of the next record. Only a completed unprojected order collects strikes; an
 * empty shell confirms when it comes at least one rest (10 minutes) after the previous one, a
 * logistics result clears them, and an uninformative one carries them unchanged. A confirmation
 * stays for as long as the record keeps the same order hash.
 */
export function nextEmptyShellStrikes(
  previous: AccountOrderProjectionRetry | null | undefined,
  routeHash: string,
  outcome: UnionPageOutcome,
  completedOrder: boolean,
  atMs: number,
): Pick<AccountOrderProjectionRetry, "emptyShellAtMs" | "emptyShellConfirmedAtMs"> {
  if (!completedOrder || outcome === "logistics") return {};
  const { emptyShellAtMs: lastAtMs = 0, emptyShellConfirmedAtMs: confirmedAtMs = 0 } =
    retainedEmptyShellStrikes(previous, routeHash);
  if (confirmedAtMs) {
    return { ...(lastAtMs ? { emptyShellAtMs: lastAtMs } : {}), emptyShellConfirmedAtMs: confirmedAtMs };
  }
  if (outcome === "uninformative") return lastAtMs ? { emptyShellAtMs: lastAtMs } : {};
  return lastAtMs && atMs - lastAtMs >= ACCOUNT_ORDER_PROJECTION_RETRY_MS
    ? { emptyShellAtMs: lastAtMs, emptyShellConfirmedAtMs: atMs }
    : { emptyShellAtMs: atMs };
}

/** The strike fields a new attempt reservation keeps from the record it replaces. */
export function retainedEmptyShellStrikes(
  previous: AccountOrderProjectionRetry | null | undefined,
  routeHash: string,
): Pick<AccountOrderProjectionRetry, "emptyShellAtMs" | "emptyShellConfirmedAtMs"> {
  if (!sameRouteHash(previous, routeHash)) return {};
  const lastAtMs = positiveTime(previous?.emptyShellAtMs);
  const confirmedAtMs = positiveTime(previous?.emptyShellConfirmedAtMs);
  return {
    ...(lastAtMs ? { emptyShellAtMs: lastAtMs } : {}),
    ...(confirmedAtMs ? { emptyShellConfirmedAtMs: confirmedAtMs } : {}),
  };
}

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

/**
 * 方案 A's scope (user 2026-09-25): the Home pass, the list refresh and detail-entry identity
 * projection leave a confirmed empty page closed. An explicit detail pull is a deliberate user action:
 * it keeps `shouldRetryAccountOrderProjection` alone and may open the page after the ordinary rest.
 */
export function shouldRetryAccountOrderProjectionUnprompted(
  retry: AccountOrderProjectionRetry | null | undefined,
  routeHash: string,
  now = Date.now(),
): boolean {
  return !accountOrderPageConfirmedEmpty(retry, routeHash) &&
    shouldRetryAccountOrderProjection(retry, routeHash, now);
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
