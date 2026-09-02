import assert from "node:assert/strict";

const memory = new Map<string, unknown>();
Object.assign(globalThis, {
  Storage: {
    get<T>(key: string): T | null {
      return (memory.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean {
      memory.set(key, structuredClone(value));
      return true;
    },
    remove(key: string): void {
      memory.delete(key);
    },
  },
});

const {
  acquireDurableRefreshLease,
  lastNetworkRefreshSuccessAtMs,
  providerNextDueAt,
  recordNetworkRefreshSuccess,
  recordRefreshProviderResult,
  refreshProviderDue,
} = await import("../services/refresh-runtime-state");

const now = Date.now();
const successDue = providerNextDueAt({
  key: "shipment-a",
  provider: "picker",
  result: "success",
  consecutiveFailures: 0,
  now,
});
assert.ok(successDue >= now + 108_000 && successDue <= now + 132_000);

const timeoutOne = providerNextDueAt({
  key: "shipment-a",
  provider: "picker",
  result: "timeout",
  consecutiveFailures: 1,
  now,
});
const timeoutFour = providerNextDueAt({
  key: "shipment-a",
  provider: "picker",
  result: "timeout",
  consecutiveFailures: 4,
  now,
});
assert.ok(timeoutFour > timeoutOne);

recordRefreshProviderResult({
  key: "shipment-a",
  provider: "picker",
  identityFingerprint: "SF:1234",
  result: "success",
  now,
});
assert.equal(
  refreshProviderDue("shipment-a", "picker", "SF:1234", now + 1),
  false,
);
assert.equal(
  refreshProviderDue("shipment-a", "picker", "SF:5678", now + 1),
  true,
  "a changed carrier identity must invalidate the old provider cooldown",
);
assert.equal(
  refreshProviderDue("shipment-a", "picker", "SF:1234", successDue),
  true,
);

recordNetworkRefreshSuccess("account", now - 1_000);
recordNetworkRefreshSuccess("background", now);
assert.equal(lastNetworkRefreshSuccessAtMs(), now);

const firstLease = acquireDurableRefreshLease("full:interface5", 30_000);
assert.ok(firstLease);
assert.equal(acquireDurableRefreshLease("full:interface5", 30_000), null);
assert.equal(firstLease?.isCurrent(), true);
firstLease?.release();
assert.equal(firstLease?.isCurrent(), false);
const secondLease = acquireDurableRefreshLease("full:interface5", 30_000);
assert.ok(secondLease);
secondLease?.release();

console.log("refresh runtime scheduling tests passed");
