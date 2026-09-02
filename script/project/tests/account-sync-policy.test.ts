import assert from "node:assert/strict";
import {
  ACCOUNT_DETAIL_BUDGET_MS,
  ACCOUNT_FOLLOWUP_RESERVE_MS,
  ACCOUNT_H5_CONCURRENCY,
  ACCOUNT_LIST_BUDGET_MS,
  ACCOUNT_ORDER_PROJECTION_BUDGET_MS,
  ACCOUNT_ORDER_PROJECTION_RETRY_MS,
  ENRICHMENT_ROTATION_MS,
  accountOrderReadyForProjection,
  accountOrderProjectionAttemptRemainingMs,
  activeAccountOrderProjectionAttempt,
  accountChildDeadline,
  boundedCursorIndices,
  jingDongH5SkipReason,
  oldestBatchIndices,
  rotatingBatchIndices,
  rotatingIndices,
  runAccountFollowupCandidates,
  shouldProjectAccountOrder,
  shouldRetryAccountOrderProjection,
} from "../services/account-sync-policy";

const NOW = 1_000_000;

assert.equal(
  accountChildDeadline(undefined, ACCOUNT_LIST_BUDGET_MS, 0, NOW),
  NOW + ACCOUNT_LIST_BUDGET_MS,
);
assert.equal(
  accountChildDeadline(
    NOW + 30_000,
    ACCOUNT_LIST_BUDGET_MS,
    ACCOUNT_FOLLOWUP_RESERVE_MS,
    NOW,
  ),
  NOW + ACCOUNT_LIST_BUDGET_MS,
);
assert.equal(
  accountChildDeadline(
    NOW + 15_000,
    ACCOUNT_DETAIL_BUDGET_MS,
    ACCOUNT_FOLLOWUP_RESERVE_MS,
    NOW,
  ),
  NOW + 5_000,
);
assert.ok(
  accountChildDeadline(
    NOW + 5_000,
    ACCOUNT_DETAIL_BUDGET_MS,
    ACCOUNT_FOLLOWUP_RESERVE_MS,
    NOW,
  ) <= NOW,
);

assert.deepEqual(rotatingIndices(4, 0), [0, 1, 2, 3]);
assert.deepEqual(
  rotatingIndices(4, ENRICHMENT_ROTATION_MS),
  [1, 2, 3, 0],
);
assert.deepEqual(rotatingIndices(0, NOW), []);
for (const length of [2, 4, 6]) {
  const visited = new Set<number>();
  for (let turn = 0; turn < length; turn++) {
    for (const index of rotatingBatchIndices(
      length,
      2,
      turn * ENRICHMENT_ROTATION_MS,
    )) {
      visited.add(index);
    }
  }
  assert.equal(visited.size, length);
}
assert.deepEqual(boundedCursorIndices(13, 1, 39), [0]);
assert.deepEqual(boundedCursorIndices(13, 1, 40), [1]);
assert.deepEqual(boundedCursorIndices(4, 2, 3), [3, 0]);
assert.deepEqual(boundedCursorIndices(4, 10, -1), [3, 0, 1, 2]);
assert.deepEqual(boundedCursorIndices(0, 1, NOW), []);
assert.equal(ACCOUNT_ORDER_PROJECTION_BUDGET_MS, 20_000);
for (const semantic of [
  "PICKED",
  "TRANSIT",
  "DELIVERY",
  "WAITING_PICKUP",
  "COMPLETED",
] as const) {
  assert.equal(accountOrderReadyForProjection(semantic), true, semantic);
}
for (const semantic of [
  "ORDERED",
  "SHIPPED",
  "UNKNOWN",
  "DANGER",
  "CANCELLED",
] as const) {
  assert.equal(accountOrderReadyForProjection(semantic), false, semantic);
}
assert.deepEqual(
  oldestBatchIndices([100, 0, 50, 0], 2, 0),
  [1, 3],
  "never-attempted manual work must run before recently attempted rows",
);
assert.deepEqual(
  oldestBatchIndices([100, 0, 50, 0], 2, 3),
  [3, 1],
  "the durable cursor must break equal-age ties fairly",
);
assert.deepEqual(
  oldestBatchIndices([100, 200, 50], 10, 0),
  [2, 0, 1],
);

assert.equal(
  jingDongH5SkipReason("", "https://u.jd.com/order", true),
  "order_projection_pending",
  "an order route alone must not schedule JD shipment H5",
);
assert.equal(
  jingDongH5SkipReason("JD0256747737308", "https://u.jd.com/order", false),
  "background_host_webview_disabled",
);
assert.equal(
  jingDongH5SkipReason("JD0256747737308", "", true),
  "route_pointer_missing",
);
assert.equal(
  jingDongH5SkipReason(
    "JD0256747737308",
    "https://u.jd.com/order",
    true,
  ),
  null,
);

const refreshedInOneRound: string[] = [];
let releaseSlowCandidate = () => {};
const slowCandidate = new Promise<void>((resolve) => {
  releaseSlowCandidate = resolve;
});
const allDueRefreshes = runAccountFollowupCandidates(
  ["unresolved", "delivery", "transit"],
  async (candidate) => {
    refreshedInOneRound.push(candidate);
    if (candidate === "unresolved") await slowCandidate;
    return candidate;
  },
  2,
);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(
  refreshedInOneRound,
  ["unresolved", "delivery", "transit"],
  "a slow first request must not stop later due shipments from being called",
);
releaseSlowCandidate();
assert.deepEqual(
  await allDueRefreshes,
  ["unresolved", "delivery", "transit"],
);

let activeRefreshes = 0;
let maximumActiveRefreshes = 0;
await runAccountFollowupCandidates(
  ["a", "b", "c", "d", "e"],
  async (candidate) => {
    activeRefreshes++;
    maximumActiveRefreshes = Math.max(maximumActiveRefreshes, activeRefreshes);
    await Promise.resolve();
    activeRefreshes--;
    return candidate;
  },
  ACCOUNT_H5_CONCURRENCY,
);
assert.equal(
  maximumActiveRefreshes,
  ACCOUNT_H5_CONCURRENCY,
  "WebView followups must use a finite concurrency bound",
);

const startedH5Candidates: string[] = [];
let releaseFirstH5 = () => {};
const firstH5Gate = new Promise<void>((resolve) => {
  releaseFirstH5 = resolve;
});
const h5Round = runAccountFollowupCandidates(
  ["slow-h5", "fast-h5", "5900-h5"],
  async (candidate) => {
    startedH5Candidates.push(candidate);
    if (candidate === "slow-h5") await firstH5Gate;
    return candidate;
  },
  ACCOUNT_H5_CONCURRENCY,
);
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(
  startedH5Candidates,
  ["slow-h5", "fast-h5", "5900-h5"],
  "a slow first WebView must not stop a later shipment from starting this round",
);
releaseFirstH5();
await h5Round;

assert.equal(shouldProjectAccountOrder(true, true, true, false), true);
assert.equal(shouldProjectAccountOrder(false, true, true, false), false);
assert.equal(shouldProjectAccountOrder(true, false, true, false), false);
assert.equal(shouldProjectAccountOrder(true, true, false, false), false);
assert.equal(shouldProjectAccountOrder(true, true, true, true), false);

const PROJECTION_NOW = ACCOUNT_ORDER_PROJECTION_RETRY_MS * 2;
const ROUTE_HASH = "a".repeat(64);
const CHANGED_ROUTE_HASH = "b".repeat(64);
const projectionRetry = {
  routeHash: ROUTE_HASH,
  failedAtMs: PROJECTION_NOW,
};
assert.equal(
  shouldRetryAccountOrderProjection(
    projectionRetry,
    ROUTE_HASH,
    PROJECTION_NOW + ACCOUNT_ORDER_PROJECTION_RETRY_MS - 1,
  ),
  false,
);
assert.equal(
  shouldRetryAccountOrderProjection(
    projectionRetry,
    ROUTE_HASH,
    PROJECTION_NOW + ACCOUNT_ORDER_PROJECTION_RETRY_MS,
  ),
  true,
);
assert.equal(
  shouldRetryAccountOrderProjection(
    projectionRetry,
    CHANGED_ROUTE_HASH,
    PROJECTION_NOW + 1,
  ),
  true,
);
assert.equal(
  shouldRetryAccountOrderProjection(
    projectionRetry,
    ROUTE_HASH,
    PROJECTION_NOW + 1,
    true,
  ),
  true,
);

const activeProjectionAttempt = {
  routeHash: ROUTE_HASH,
  failedAtMs: PROJECTION_NOW,
  attemptId: "projection-active-1",
  attemptExpiresAtMs: PROJECTION_NOW + 12_000,
};
assert.equal(
  activeAccountOrderProjectionAttempt(
    activeProjectionAttempt,
    ROUTE_HASH,
    PROJECTION_NOW + 1,
  ),
  true,
);
assert.equal(
  accountOrderProjectionAttemptRemainingMs(
    activeProjectionAttempt,
    PROJECTION_NOW + 1,
  ),
  11_999,
);
assert.equal(
  shouldRetryAccountOrderProjection(
    activeProjectionAttempt,
    ROUTE_HASH,
    PROJECTION_NOW + 1,
  ),
  false,
);
assert.equal(
  shouldRetryAccountOrderProjection(
    activeProjectionAttempt,
    ROUTE_HASH,
    PROJECTION_NOW + 1,
    true,
  ),
  false,
);
assert.equal(
  shouldRetryAccountOrderProjection(
    activeProjectionAttempt,
    ROUTE_HASH,
    PROJECTION_NOW + 12_000,
    true,
  ),
  true,
);
assert.equal(
  accountOrderProjectionAttemptRemainingMs(
    activeProjectionAttempt,
    PROJECTION_NOW + 12_000,
  ),
  0,
);

const reservationWithoutFailure = {
  routeHash: ROUTE_HASH,
  attemptId: "projection-active-2",
  attemptExpiresAtMs: PROJECTION_NOW + 12_000,
};
assert.equal(
  shouldRetryAccountOrderProjection(
    reservationWithoutFailure,
    ROUTE_HASH,
    PROJECTION_NOW + 1,
  ),
  false,
);
assert.equal(
  shouldRetryAccountOrderProjection(
    reservationWithoutFailure,
    ROUTE_HASH,
    PROJECTION_NOW + 12_000,
  ),
  true,
);

assert.equal(ACCOUNT_ORDER_PROJECTION_RETRY_MS, 60 * 60 * 1000);

console.log("account sync budget and rotation tests passed");
