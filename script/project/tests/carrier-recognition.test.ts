import assert from "node:assert/strict";
import {
  CARRIER_NETWORK_FAILURE_LIMIT,
  CARRIER_RETRY_DELAY_MS,
  CARRIER_TERMINAL_TTL_MS,
  terminalStillBinding,
  buildCarrierClassificationRequest,
  parseCarrierRecognitionEntries,
  parseCarrierClassificationResponse,
  recognizeNonSyncCarrier,
  retainCarrierRecognitionEntries,
  type CarrierRecognitionEntry,
  type CarrierRecognitionStore,
} from "../services/carrier-recognition";
import { GatewayError } from "../services/gateway";
import { OperationTimeoutError } from "../services/deadline";

assert.deepEqual(buildCarrierClassificationRequest(" raw123456789 "), {
  route: "/api/express/classify",
  payload: { waybill: "RAW123456789", firstStageCompleted: true },
});
// Audit C1 (adopted 2026-09-25): the Worker's classify answer names carrier standard codes. This
// case used to be written in the Kuaidi100 format (comCode "kuayue"), which the Worker never sends.
assert.deepEqual(parseCarrierClassificationResponse({
  auto: [{ comCode: "KYSY", name: "旧跨越文案" }],
}), {
  standardCode: "KYSY",
  displayName: "跨越速运",
  kuaidi100Code: "kuayue",
  isBuiltIn: true,
  tableVersion: "b6009e8d0a72f68005d3fcc8139b19aeb7113df0751e3db45744632406d525f9",
});
// A Kuaidi100 code is not a standard code and resolves nothing.
assert.equal(parseCarrierClassificationResponse({ auto: [{ comCode: "kuayue" }] }), null);
assert.equal(parseCarrierClassificationResponse({ auto: [] }), null);
// Audit C4: a 2xx without an `auto` list is terminal like any unresolvable 2xx, not a retry.
assert.equal(parseCarrierClassificationResponse({}), null);

const durableCapacity = Array.from({ length: 300 }, (_, index) => ({
  waybill: `DURABLE${String(index).padStart(6, "0")}`,
  state: "terminal" as const,
  networkFailures: 3,
  retryAfterMs: 0,
  updatedAtMs: index,
}));
const transientCapacity = Array.from({ length: 300 }, (_, index) => ({
  waybill: `RETRY${String(index).padStart(6, "0")}`,
  state: "retry" as const,
  retryStage: "auto_com_num" as const,
  networkFailures: 1,
  retryAfterMs: index + 1,
  updatedAtMs: index,
}));
const retainedCapacity = retainCarrierRecognitionEntries([
  ...durableCapacity,
  ...transientCapacity,
]);
assert.equal(
  retainedCapacity.filter((entry) => entry.state === "terminal").length,
  300,
);
assert.equal(
  retainedCapacity.filter((entry) => entry.state === "retry").length,
  256,
);
assert.equal(
  retainedCapacity.some((entry) => entry.waybill === "DURABLE000000"),
  true,
);

function memoryStore(initial: readonly CarrierRecognitionEntry[] = []): {
  store: CarrierRecognitionStore;
  entries: () => readonly CarrierRecognitionEntry[];
} {
  let values = [...initial];
  return {
    store: {
      load: () => values,
      save: (entries) => {
        values = [...entries];
      },
    },
    entries: () => values,
  };
}

const resolvedCache = memoryStore();
let localCalls = 0;
const local = await recognizeNonSyncCarrier("KYE123456789", {
  store: resolvedCache.store,
  now: 1_000,
  detect: async () => {
    localCalls++;
    return [{ courierCode: "kuayue", companyName: "跨越" }];
  },
});
assert.equal(local.normalization?.standardCode, "KYSY");
assert.equal(local.normalization?.displayName, "跨越速运");
await recognizeNonSyncCarrier("KYE123456789", {
  store: resolvedCache.store,
  now: 2_000,
  detect: async () => {
    localCalls++;
    return [];
  },
});
assert.equal(localCalls, 1, "resolved recognition must be reused");

const driftedResolvedEntry = {
  waybill: "DRIFTED123456789",
  state: "resolved" as const,
  normalization: {
    standardCode: "SF",
    displayName: "旧顺丰文案",
    kuaidi100Code: "old-shunfeng-code",
    isBuiltIn: true,
    tableVersion: "catalog@old",
  },
  networkFailures: 0,
  retryAfterMs: 0,
  updatedAtMs: 1_000,
};
assert.equal(
  parseCarrierRecognitionEntries([driftedResolvedEntry]).length,
  1,
  "presentation drift must not make a durable standard-code cache unreadable",
);
const driftedResolvedCache = memoryStore([driftedResolvedEntry]);
let driftedNetworkCalls = 0;
const rebuiltResolved = await recognizeNonSyncCarrier("DRIFTED123456789", {
  store: driftedResolvedCache.store,
  now: 2_000,
  detect: async () => {
    driftedNetworkCalls++;
    throw new Error("must not detect");
  },
  classify: async () => {
    driftedNetworkCalls++;
    throw new Error("must not classify");
  },
});
assert.equal(driftedNetworkCalls, 0);
assert.deepEqual(rebuiltResolved.normalization, {
  standardCode: "SF",
  displayName: "顺丰速运",
  kuaidi100Code: "shunfeng",
  isBuiltIn: true,
  tableVersion: "b6009e8d0a72f68005d3fcc8139b19aeb7113df0751e3db45744632406d525f9",
});
assert.deepEqual(
  driftedResolvedCache.entries()[0]?.normalization,
  rebuiltResolved.normalization,
  "reading a resolved cache must durably heal its presentation from the current table",
);

const removedStandardCache = memoryStore([{
  ...driftedResolvedEntry,
  waybill: "REMOVED123456789",
  normalization: {
    ...driftedResolvedEntry.normalization,
    standardCode: "REMOVED",
  },
}]);
let removedStandardDetectCalls = 0;
const reRecognizedRemovedStandard = await recognizeNonSyncCarrier(
  "REMOVED123456789",
  {
    store: removedStandardCache.store,
    now: 3_000,
    detect: async () => {
      removedStandardDetectCalls++;
      return [{ courierCode: "kuayue", companyName: "旧跨越文案" }];
    },
  },
);
assert.equal(removedStandardDetectCalls, 1);
assert.equal(reRecognizedRemovedStandard.normalization?.standardCode, "KYSY");
assert.equal(reRecognizedRemovedStandard.normalization?.displayName, "跨越速运");

const invalidResolvedCache = memoryStore([{
  waybill: "INVALIDRESOLVED123",
  state: "resolved",
  networkFailures: 0,
  retryAfterMs: 0,
  updatedAtMs: 1_000,
}]);
let invalidResolvedDetectCalls = 0;
const repairedResolved = await recognizeNonSyncCarrier("INVALIDRESOLVED123", {
  store: invalidResolvedCache.store,
  now: 2_000,
  detect: async () => {
    invalidResolvedDetectCalls++;
    return [{ courierCode: "kuayue", companyName: "跨越" }];
  },
});
assert.equal(invalidResolvedDetectCalls, 1);
assert.equal(repairedResolved.normalization?.standardCode, "KYSY");
assert.equal(
  invalidResolvedCache.entries()[0]?.normalization?.standardCode,
  "KYSY",
  "a malformed resolved cache entry must be replaced instead of returning null forever",
);

const pendingCache = memoryStore();
let firstLevelCalls = 0;
const pending = await recognizeNonSyncCarrier("RAW123456789", {
  store: pendingCache.store,
  now: 3_000,
  detect: async () => {
    firstLevelCalls++;
    return [{ courierCode: "unknownslug", companyName: "原始标签" }];
  },
  classify: async () => {
    throw new Error("offline");
  },
});
assert.equal(pending.pendingSecondLevel, true);
assert.equal(pendingCache.entries()[0].state, "retry");
assert.equal(firstLevelCalls, 1);

let classifierInput: unknown = null;
const classified = await recognizeNonSyncCarrier("RAW123456789", {
  store: pendingCache.store,
  now: 3_000 + CARRIER_RETRY_DELAY_MS,
  detect: async () => {
    firstLevelCalls++;
    return [];
  },
  classify: async (input) => {
    classifierInput = input;
    return {
      standardCode: "SF",
      displayName: "顺丰速运",
      kuaidi100Code: "shunfeng",
      isBuiltIn: true,
      tableVersion: "worker@1",
    };
  },
});
// Audit C4 (adopted 2026-09-25): every attempt starts with the free stage, the retry included.
assert.equal(firstLevelCalls, 2, "a retry after a failed paid stage runs autoComNum again");
assert.deepEqual(classifierInput, {
  waybill: "RAW123456789",
  firstStageCompleted: true,
});
assert.equal(classified.normalization?.standardCode, "SF");

const failureCache = memoryStore();
let failureCalls = 0;
const fail = async (now: number) => recognizeNonSyncCarrier("FAIL123456789", {
  store: failureCache.store,
  now,
  detect: async () => {
    failureCalls++;
    throw new Error("offline");
  },
});
assert.equal((await fail(10_000)).coolingDown, false);
assert.equal((await fail(10_000 + 1)).coolingDown, true);
assert.equal(failureCalls, 1);
await fail(10_000 + CARRIER_RETRY_DELAY_MS);
const terminal = await fail(10_000 + CARRIER_RETRY_DELAY_MS * 2);
assert.equal(failureCalls, CARRIER_NETWORK_FAILURE_LIMIT);
assert.equal(terminal.terminal, true);
await fail(10_000 + CARRIER_RETRY_DELAY_MS * 3);
assert.equal(failureCalls, CARRIER_NETWORK_FAILURE_LIMIT);

const cancelledDetectionCache = memoryStore();
await assert.rejects(
  recognizeNonSyncCarrier("CANCELLED-DETECT-123", {
    store: cancelledDetectionCache.store,
    detect: async () => {
      throw new OperationTimeoutError();
    },
  }),
  (error: unknown) => error instanceof OperationTimeoutError,
);
assert.deepEqual(cancelledDetectionCache.entries(), []);

const cancelledClassifierCache = memoryStore();
await assert.rejects(
  recognizeNonSyncCarrier("CANCELLED-CLASSIFY-123", {
    store: cancelledClassifierCache.store,
    detect: async () => [{
      courierCode: "unknownslug",
      companyName: "Unknown",
    }],
    classify: async () => {
      throw new OperationTimeoutError();
    },
  }),
  (error: unknown) => error instanceof OperationTimeoutError,
);
assert.deepEqual(cancelledClassifierCache.entries(), []);

console.log("carrier recognition persistence tests passed");

{
// Pending work is durable waiting, even after earlier real network failures.
const pendingCache = memoryStore([{
  waybill: "PENDING123456", state: "retry", retryStage: "worker_classify",
  networkFailures: 2, retryAfterMs: 1_000, updatedAtMs: 0,
}]);
let pendingCalls = 0;
for (let attempt = 0; attempt < 4; attempt++) {
  const now = 1_000 + attempt * 60_000;
  const pending = await recognizeNonSyncCarrier("PENDING123456", {
    now, store: pendingCache.store,
    // Audit C4: the retry runs the free stage first; it finds no candidate, so the paid stage answers.
    detect: async () => [],
    classify: async () => {
      pendingCalls++;
      throw new GatewayError("synthetic pending", 502, "recognition_pending", "", now + 60_000);
    },
  });
  assert.equal(pending.terminal, false);
  assert.equal(pendingCache.entries()[0].networkFailures, 2);
  assert.equal(pendingCache.entries()[0].retryAfterMs, now + 60_000);
  await recognizeNonSyncCarrier("PENDING123456", {
    now: now + 1, store: pendingCache.store,
    classify: async () => { throw new Error("must remain in cooldown"); },
  });
  assert.equal(pendingCalls, attempt + 1);
}
await recognizeNonSyncCarrier("PENDING123456", {
  now: 241_000, store: pendingCache.store,
  detect: async () => [],
  classify: async () => { throw new Error("real network failure"); },
});
assert.equal(pendingCache.entries()[0].networkFailures, 3);
assert.equal(pendingCache.entries()[0].state, "terminal");
console.log("carrier recognition pending-state tests passed");

}

// A terminal verdict states what the upstream knew at one moment, not a permanent fact.
assert.equal(terminalStillBinding({ updatedAtMs: 10_000 }, 10_000), true);
assert.equal(
  terminalStillBinding({ updatedAtMs: 10_000 }, 10_000 + CARRIER_TERMINAL_TTL_MS - 1),
  true,
);
assert.equal(
  terminalStillBinding({ updatedAtMs: 10_000 }, 10_000 + CARRIER_TERMINAL_TTL_MS),
  false,
);
// A clock that moved backwards is not evidence that the verdict expired.
assert.equal(terminalStillBinding({ updatedAtMs: 10_000 }, 9_000), true);
// An entry we cannot date must not outrank one we can; Lite reads its own unreadable
// entries the same way, so all three clients release them together.
assert.equal(terminalStillBinding({ updatedAtMs: 0 }, 10_000), false);
assert.equal(terminalStillBinding({}, 10_000), false);
console.log("carrier recognition terminal expiry tests passed");
