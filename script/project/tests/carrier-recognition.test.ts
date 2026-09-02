import assert from "node:assert/strict";
import {
  CARRIER_NETWORK_FAILURE_LIMIT,
  CARRIER_RETRY_DELAY_MS,
  buildCarrierClassificationRequest,
  parseCarrierRecognitionEntries,
  parseCarrierClassificationResponse,
  recognizeNonSyncCarrier,
  retainCarrierRecognitionEntries,
  type CarrierRecognitionEntry,
  type CarrierRecognitionStore,
} from "../services/carrier-recognition";
import { OperationTimeoutError } from "../services/deadline";

assert.deepEqual(buildCarrierClassificationRequest(" raw123456789 "), {
  route: "/api/express/classify",
  payload: { waybill: "RAW123456789", firstStageCompleted: true },
});
assert.deepEqual(parseCarrierClassificationResponse({
  auto: [{ comCode: "kuayue", name: "旧跨越文案" }],
}), {
  standardCode: "KYSY",
  displayName: "跨越速运",
  kuaidi100Code: "kuayue",
  isBuiltIn: true,
  tableVersion: "6e4ec3e45a460dbea446093a9b7ccb81b2da80f716f57369bc32572d640dda0e",
});
assert.equal(parseCarrierClassificationResponse({ auto: [] }), null);
assert.throws(() => parseCarrierClassificationResponse({}), /RetryableClassificationError/);

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
  tableVersion: "6e4ec3e45a460dbea446093a9b7ccb81b2da80f716f57369bc32572d640dda0e",
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
assert.equal(firstLevelCalls, 1, "second-level retry must not repeat autoComNum");
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
