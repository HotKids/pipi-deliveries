import assert from "node:assert/strict";
import {
  OperationTimeoutError,
  assertWithinDeadline,
  deadlineAfter,
  deadlineExpired,
  remainingTimeoutMs,
  waitForRefresh,
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

// A delayed event loop may deliver a resolved Promise before the expired timer.
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
try {
  const deadline = clock + 100;
  const waiting = waitForRefresh(Promise.resolve("late result"), deadline);
  clock += 600;
  await assert.rejects(waiting, (error: unknown) => {
    assert.ok(error instanceof OperationTimeoutError);
    assert.deepEqual(error.waitDetails, {
      waitTimeoutOrigin: "deadline", waitBudgetMs: 100,
      waitElapsedMs: 600, deadlineLagMs: 500,
    });
    return true;
  });
  const controller = new AbortController();
  const cancelled = waitForRefresh(new Promise(() => {}), clock + 100, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => {
    assert.ok(error instanceof OperationTimeoutError);
    assert.equal(error.waitDetails?.waitTimeoutOrigin, "cancelled");
    return true;
  });
  assert.equal(await waitForRefresh(Promise.resolve("ready"), clock + 100), "ready");
  const requestError = new OperationTimeoutError(undefined, {
    timeoutOrigin: "native_timeout", requestPhase: "response_body",
    requestBudgetMs: 100, requestElapsedMs: 600, deadlineLagMs: 500,
  });
  const rejected = waitForRefresh(Promise.reject(requestError), clock + 100);
  clock += 600;
  await assert.rejects(rejected, (error) => error === requestError,
    "an existing transport error retains its request-phase evidence");
  let completeShared!: (value: string) => void;
  const shared = new Promise<string>(resolve => { completeShared = resolve; });
  const consumer = new AbortController();
  const left = waitForRefresh(shared, clock + 100, consumer.signal);
  const retained = waitForRefresh(shared, clock + 100);
  consumer.abort();
  await assert.rejects(left, OperationTimeoutError);
  completeShared("shared result");
  assert.equal(await retained, "shared result",
    "one cancelled waiter cannot cancel work owned by another consumer");
} finally {
  Date.now = realNow;
}
