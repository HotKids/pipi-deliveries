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
// 用户定 2026-09-04：手动链各级冷却 10 分钟（快递100 H5 是 30 分钟的上游限制），带 ±10% 抖动。
assert.ok(successDue >= now + 540_000 && successDue <= now + 660_000);

const kuaidi100Due = providerNextDueAt({
  key: "shipment-a",
  provider: "kuaidi100",
  result: "success",
  consecutiveFailures: 0,
  now,
});
assert.ok(
  kuaidi100Due >= now + 1_620_000 && kuaidi100Due <= now + 1_980_000,
  "快递100 H5 同一运单号 30 分钟——上游自己的限制",
);

const rejectedDue = providerNextDueAt({
  key: "shipment-a",
  provider: "picker",
  result: "upstream_rejected",
  consecutiveFailures: 1,
  now,
});
assert.ok(
  rejectedDue >= now + 3_240_000 && rejectedDue <= now + 3_960_000,
  "上游明确拒绝／风控歇 60 分钟，与京东 H5 一致",
);

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
