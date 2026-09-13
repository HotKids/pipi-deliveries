import { installSharedFileMock } from "./shared-file-mock";
import assert from "node:assert/strict";
import {
  acquireDurableRefreshLease,
  lastNetworkRefreshSuccessAtMs,
  recordNetworkRefreshSuccess,
  recordRefreshProviderResult,
  refreshProviderDue,
} from "../services/refresh-runtime-state";

const memory = new Map<string, unknown>();
let afterRead: (() => void) | undefined;
Object.assign(globalThis, {
  Storage: {
    get(key: string) {
      const snapshot = structuredClone(memory.get(key));
      const callback = afterRead;
      afterRead = undefined;
      callback?.();
      return snapshot;
    },
    set(key: string, value: unknown) {
      memory.set(key, structuredClone(value));
      return true;
    },
  },
});
installSharedFileMock(memory);

const now = Date.now();
const provider = {
  key: "synthetic-shipment", provider: "picker" as const,
  identityFingerprint: "synthetic-identity", result: "success" as const, now,
};

// A metadata writer resumes with a snapshot predating another runtime's lease.
for (const record of [
  () => recordNetworkRefreshSuccess("account", now),
  () => recordRefreshProviderResult(provider),
]) {
  memory.clear();
  const holders: NonNullable<ReturnType<typeof acquireDurableRefreshLease>>[] = [];
  afterRead = () => {
    const holder = acquireDurableRefreshLease("full:interface5", 125_000);
    assert.ok(holder);
    assert.equal(holder.isCurrent(), true);
    holders.push(holder);
  };
  record();
  assert.equal(holders[0]?.isCurrent(), true, "metadata must not erase a newly acquired lease");
  holders[0]!.release();
}

// A lease release resumes after newer metadata was recorded in another runtime.
memory.clear();
const holder = acquireDurableRefreshLease("full:interface5", 125_000)!;
afterRead = () => {
  recordRefreshProviderResult(provider);
  recordNetworkRefreshSuccess("background", now);
};
holder.release();
assert.equal(refreshProviderDue(provider.key, provider.provider, provider.identityFingerprint, now + 1), false);
assert.equal(lastNetworkRefreshSuccessAtMs(), now);
assert.equal(holder.isCurrent(), false);

// Previously persisted metadata and active leases survive the storage split.
memory.clear();
memory.set("pipi_deliveries_refresh_runtime_v1", {
  version: 1, revision: 7,
  lastAccountSyncSuccessAtMs: now - 1_000, lastBackgroundPollSuccessAtMs: 0,
  providers: [{ ...provider, lastAttemptAtMs: now, lastSuccessAtMs: now,
    consecutiveFailures: 0, nextDueAtMs: now + 60_000, lastResult: "success" }],
  leases: [{ key: "full:interface5", token: "synthetic-legacy-holder", expiresAtMs: now + 125_000 }],
});
assert.equal(lastNetworkRefreshSuccessAtMs(), now - 1_000);
assert.equal(refreshProviderDue(provider.key, provider.provider, provider.identityFingerprint, now), false);
assert.equal(acquireDurableRefreshLease("full:interface5", 125_000), null);
recordNetworkRefreshSuccess("background", now);
assert.equal(refreshProviderDue(provider.key, provider.provider, provider.identityFingerprint, now), false);
assert.equal(acquireDurableRefreshLease("full:interface5", 125_000), null);
assert.equal(lastNetworkRefreshSuccessAtMs(), now);

// A widget loaded before the update may publish newer scheduling metadata later.
const legacy = memory.get("pipi_deliveries_refresh_runtime_v1") as {
  lastBackgroundPollSuccessAtMs: number; providers: { lastAttemptAtMs: number; nextDueAtMs: number }[];
};
memory.set("pipi_deliveries_refresh_runtime_v1", {
  ...legacy, lastBackgroundPollSuccessAtMs: now + 1_000,
  providers: legacy.providers.map(item => ({ ...item, lastAttemptAtMs: now + 1_000, nextDueAtMs: now + 120_000 })),
});
assert.equal(lastNetworkRefreshSuccessAtMs(), now + 1_000);
assert.equal(refreshProviderDue(provider.key, provider.provider, provider.identityFingerprint, now + 90_000), false);
console.log("refresh runtime metadata and lease isolation tests passed");
