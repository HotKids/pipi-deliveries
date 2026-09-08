import assert from "node:assert/strict";
import {
  OperationTimeoutError,
  assertWithinDeadline,
  deadlineAfter,
  deadlineExpired,
  remainingTimeoutMs,
} from "../services/deadline";

assert.equal(deadlineAfter(10_000, 100), 10_100);
assert.equal(remainingTimeoutMs(undefined, 30_000, 100), 30_000);
assert.equal(remainingTimeoutMs(10_100, 30_000, 100), 10_000);
assert.equal(remainingTimeoutMs(40_100, 30_000, 100), 30_000);
assert.equal(deadlineExpired(100, 100), true);
assert.equal(deadlineExpired(101, 100), false);
assert.throws(
  () => assertWithinDeadline(100, 100),
  OperationTimeoutError,
);
assert.throws(
  () => remainingTimeoutMs(100, 30_000, 100),
  OperationTimeoutError,
);

console.log("operation deadline tests passed");
