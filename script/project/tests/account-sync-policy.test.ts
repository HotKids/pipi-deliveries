import assert from "node:assert/strict";
import {
  ACCOUNT_DETAIL_BUDGET_MS,
  ACCOUNT_FOLLOWUP_RESERVE_MS,
  ACCOUNT_LIST_BUDGET_MS,
  ACCOUNT_ORDER_PROJECTION_RETRY_MS,
  ENRICHMENT_ROTATION_MS,
  accountOrderProjectionAttemptRemainingMs,
  activeAccountOrderProjectionAttempt,
  accountChildDeadline,
  boundedCursorIndices,
  rotatingBatchIndices,
  rotatingIndices,
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
