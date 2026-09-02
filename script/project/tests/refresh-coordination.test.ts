import assert from "node:assert/strict";
import { RefreshCoordinator } from "../services/refresh-coordination";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 500) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("test promise did not settle")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

{
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const detailGate = deferred<string>();
  let detailCalls = 0;
  let fullCalls = 0;
  const detail = coordinator.runDetail(
    "shipment-a",
    "interface5",
    () => {
      detailCalls++;
      return detailGate.promise;
    },
    (value) => `reused:${value}`,
  );
  const full = coordinator.runFull("interface5", async (skipped) => {
    fullCalls++;
    assert.deepEqual([...skipped], ["shipment-a"]);
    return "full-result";
  });
  await Promise.resolve();
  assert.equal(fullCalls, 0);
  detailGate.resolve("detail-result");
  assert.equal(await detail, "detail-result");
  assert.equal(await full, "full-result");
  assert.equal(detailCalls, 1);
  assert.equal(fullCalls, 1);
}

{
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const fullGate = deferred<string>();
  let detailCalls = 0;
  const full = coordinator.runFull("interface5", async () => fullGate.promise);
  const first = coordinator.runDetail(
    "shipment-a",
    "interface5",
    async () => {
      detailCalls++;
      return "network-detail";
    },
    (value) => `reused:${value}`,
  );
  const second = coordinator.runDetail(
    "shipment-a",
    "interface5",
    async () => {
      detailCalls++;
      return "duplicate-detail";
    },
    (value) => `duplicate:${value}`,
  );
  assert.equal(first, second);
  fullGate.resolve("full-result");
  assert.equal(await full, "full-result");
  assert.equal(await first, "reused:full-result");
  assert.equal(detailCalls, 0);
}

{
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const automaticGate = deferred<string>();
  let automaticCalls = 0;
  let forcedCalls = 0;
  const automatic = coordinator.runDetail(
    "shipment-forced",
    "interface5",
    () => {
      automaticCalls++;
      return automaticGate.promise;
    },
    (value) => value,
  );
  const forced = coordinator.runDetailFresh(
    "shipment-forced",
    "interface5",
    async () => {
      forcedCalls++;
      return "forced-network";
    },
    (value) => value,
  );
  assert.notEqual(forced, automatic);
  assert.equal(automaticCalls, 1);
  assert.equal(forcedCalls, 0);
  automaticGate.resolve("automatic-network");
  assert.equal(await automatic, "automatic-network");
  assert.equal(await forced, "forced-network");
  assert.equal(forcedCalls, 1);
}

{
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const cancelledGate = deferred<string>();
  const cancelled = coordinator.runDetail(
    "shipment-retry",
    "interface5",
    () => cancelledGate.promise,
    (value) => value,
  );
  let retryCalls = 0;
  const retry = coordinator.runDetailFresh(
    "shipment-retry",
    "interface5",
    async () => {
      retryCalls++;
      return "fallback-enabled-retry";
    },
    (value) => value,
  );
  cancelledGate.reject(new Error("cancelled previous detail"));
  await assert.rejects(cancelled, /cancelled previous detail/);
  assert.equal(await retry, "fallback-enabled-retry");
  assert.equal(retryCalls, 1);
}

{
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const fullGate = deferred<string>();
  const full = coordinator.runFull("interface5", async () => fullGate.promise);
  let detailCalls = 0;
  const detail = coordinator.runDetail(
    "shipment-after-failed-full",
    "interface5",
    async () => {
      detailCalls++;
      return "targeted-after-full-failure";
    },
    (value) => `reused:${value}`,
  );
  fullGate.reject(new Error("expected full failure"));
  await assert.rejects(full, /expected full failure/);
  assert.equal(await detail, "targeted-after-full-failure");
  assert.equal(detailCalls, 1);
}

{
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const failed = deferred<string>();
  const detail = coordinator.runDetail(
    "shipment-a",
    "interface5",
    () => failed.promise,
    (value) => value,
  );
  const full = coordinator.runFull("interface5", async (skipped) => {
    assert.deepEqual([...skipped], []);
    return "after-failure";
  });
  failed.reject(new Error("expected"));
  await assert.rejects(detail);
  assert.equal(await full, "after-failure");
  assert.equal(
    await coordinator.runDetail(
      "shipment-a",
      "interface5",
      async () => "retry",
      (value) => value,
    ),
    "retry",
  );
}

{
  const coordinator = new RefreshCoordinator<
    string,
    string,
    { refreshed: boolean },
    string
  >();
  const detail = coordinator.runDetail(
    "shipment-a",
    "interface5",
    async () => ({ refreshed: false }),
    () => ({ refreshed: false }),
  );
  const full = coordinator.runFull(
    "interface5",
    async (skipped) => {
      assert.deepEqual([...skipped], []);
      return "retry-no-result";
    },
    (result) => result.refreshed,
  );
  assert.deepEqual(await detail, { refreshed: false });
  assert.equal(await full, "retry-no-result");
}

{
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const detailGate = deferred<string>();
  const detail = coordinator.runDetail(
    "shipment-a",
    "interface5",
    () => detailGate.promise,
    (value) => `reused:${value}`,
  );
  let firstFullCalls = 0;
  const firstFull = coordinator.runFull(
    "interface5",
    async (skipped) => {
      firstFullCalls++;
      assert.deepEqual([...skipped], ["shipment-a"]);
      return "first-full";
    },
    () => true,
    {
      blockerDeadlineAtMs: Date.now() - 1,
      operationDeadlineAtMs: Date.now() + 1_000,
    },
  );
  assert.equal(await settleWithin(firstFull), "first-full");
  assert.equal(firstFullCalls, 1);
  assert.equal(coordinator.full("interface5"), undefined);
  assert.equal(coordinator.detail("shipment-a"), detail);

  const secondFullStarted = deferred<void>();
  const secondFullGate = deferred<string>();
  const secondFull = coordinator.runFull(
    "interface5",
    async (skipped) => {
      assert.deepEqual([...skipped], ["shipment-a"]);
      secondFullStarted.resolve();
      return secondFullGate.promise;
    },
    () => true,
    {
      blockerDeadlineAtMs: Date.now() - 1,
      operationDeadlineAtMs: Date.now() + 1_000,
    },
  );
  await settleWithin(secondFullStarted.promise);
  assert.equal(coordinator.full("interface5"), secondFull);

  detailGate.resolve("late-detail");
  assert.equal(await detail, "late-detail");
  assert.equal(coordinator.detail("shipment-a"), undefined);
  assert.equal(coordinator.full("interface5"), secondFull);

  let duplicateFullCalls = 0;
  const duplicateFull = coordinator.runFull(
    "interface5",
    async () => {
      duplicateFullCalls++;
      return "duplicate-full";
    },
    () => true,
    {
      blockerDeadlineAtMs: Date.now() - 1,
      operationDeadlineAtMs: Date.now() + 1_000,
    },
  );
  assert.equal(duplicateFull, secondFull);
  assert.equal(duplicateFullCalls, 0);

  secondFullGate.resolve("second-full");
  assert.equal(await settleWithin(secondFull), "second-full");
  assert.equal(coordinator.full("interface5"), undefined);

  const thirdFull = coordinator.runFull(
    "interface5",
    async (skipped) => {
      assert.deepEqual([...skipped], []);
      return "third-full";
    },
    () => true,
    {
      blockerDeadlineAtMs: Date.now() - 1,
      operationDeadlineAtMs: Date.now() + 1_000,
    },
  );
  assert.equal(await settleWithin(thirdFull), "third-full");
}

{
  const coordinator = new RefreshCoordinator<
    string,
    string,
    { refreshed: boolean },
    string
  >();
  const pendingGate = deferred<{ refreshed: boolean }>();
  const pending = coordinator.runDetail(
    "pending",
    "interface5",
    () => pendingGate.promise,
    (value) => value,
  );
  const unchanged = coordinator.runDetail(
    "unchanged",
    "interface5",
    async () => ({ refreshed: false }),
    (value) => value,
  );
  const rejected = coordinator.runDetail(
    "rejected",
    "interface5",
    async () => {
      throw new Error("expected");
    },
    (value) => value,
  );
  const full = coordinator.runFull(
    "interface5",
    async (skipped) => {
      assert.deepEqual([...skipped], ["pending"]);
      return "partial-blockers";
    },
    (result) => result.refreshed,
    {
      blockerDeadlineAtMs: Date.now() + 20,
      operationDeadlineAtMs: Date.now() + 1_000,
    },
  );
  assert.equal(await settleWithin(full), "partial-blockers");
  assert.deepEqual(await unchanged, { refreshed: false });
  await assert.rejects(rejected);
  pendingGate.resolve({ refreshed: true });
  assert.deepEqual(await pending, { refreshed: true });
}

{
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const staleGate = deferred<string>();
  const staleDeadline = Date.now() + 30;
  const staleFull = coordinator.runFull(
    "interface5",
    async () => staleGate.promise,
    () => true,
    { operationDeadlineAtMs: staleDeadline },
  );
  assert.equal(coordinator.full("interface5", staleDeadline), undefined);

  const currentGate = deferred<string>();
  const currentDeadline = Date.now() + 1_000;
  const currentFull = coordinator.runFull(
    "interface5",
    async () => currentGate.promise,
    () => true,
    { operationDeadlineAtMs: currentDeadline },
  );
  assert.equal(coordinator.full("interface5"), currentFull);

  staleGate.resolve("stale-full");
  await assert.rejects(staleFull, /请求超时/);
  assert.equal(coordinator.full("interface5"), currentFull);

  currentGate.resolve("current-full");
  assert.equal(await settleWithin(currentFull), "current-full");
  assert.equal(coordinator.full("interface5"), undefined);
}

{
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const never = deferred<string>();
  let leaseCurrentAfterTimeout = true;
  let leaseAbortedAfterTimeout = false;
  const timedOut = coordinator.runFull(
    "interface5",
    async (_skipped, lease) => {
      try {
        return await never.promise;
      } finally {
        leaseCurrentAfterTimeout = lease.isCurrent();
        leaseAbortedAfterTimeout = lease.signal.aborted;
      }
    },
    () => true,
    { operationDeadlineAtMs: Date.now() + 20 },
  );
  await assert.rejects(settleWithin(timedOut), /请求超时/);
  assert.equal(coordinator.full("interface5"), undefined);
  never.reject(new Error("release stale work"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(leaseCurrentAfterTimeout, false);
  assert.equal(leaseAbortedAfterTimeout, true);
  assert.equal(
    await coordinator.runFull("interface5", async () => "replacement"),
    "replacement",
  );
}

{
  const coordinator = new RefreshCoordinator<string, string, string, string>();
  const startedAt = Date.now();
  let lateSignal: AbortSignal | undefined;
  const lateSuccess = coordinator.runFull(
    "interface5",
    async (_skipped, lease) => {
      lateSignal = lease.signal;
      while (Date.now() - startedAt < 40) {
        // Simulate a native bridge call that returns only after the JS timer is overdue.
      }
      return "late-success";
    },
    () => true,
    { operationDeadlineAtMs: startedAt + 10 },
  );
  await assert.rejects(lateSuccess, /请求超时/);
  assert.equal(lateSignal?.aborted, true);
  assert.equal(coordinator.full("interface5"), undefined);
}

console.log("refresh coordination tests passed");
