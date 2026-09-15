import assert from "node:assert/strict";
import {
  recognizeNonSyncCarrier,
  type CarrierRecognitionEntry,
  type CarrierRecognitionStore,
} from "../services/carrier-recognition";
import { OperationTimeoutError } from "../services/deadline";

function memoryStore() {
  let entries: readonly CarrierRecognitionEntry[] = [];
  const store: CarrierRecognitionStore = {
    load: () => entries,
    save: value => { entries = value; },
  };
  return { store, entries: () => entries };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const sfCandidate = [{ courierCode: "shunfeng", companyName: "顺丰速运" }];
const timeout = (error: unknown) => error instanceof OperationTimeoutError;

{
  const cache = memoryStore();
  const detection = deferred<[]>();
  let detects = 0;
  let classifies = 0;
  const options = {
    store: cache.store,
    detect: async () => { detects++; return detection.promise; },
    classify: async () => { classifies++; return null; },
  };
  const first = recognizeNonSyncCarrier("sf-concurrent-001", options);
  const second = recognizeNonSyncCarrier(" SF-CONCURRENT-001 ", options);
  detection.resolve([]);
  const results = await Promise.all([first, second]);
  assert.equal(detects, 1, "same normalized waybill must share free recognition");
  assert.equal(classifies, 1, "same normalized waybill must share classification");
  assert.deepEqual(results[0], results[1]);
  assert.equal(cache.entries().length, 1);
}

{
  const cache = memoryStore();
  const otherCache = memoryStore();
  const detection = deferred<typeof sfCandidate>();
  let detects = 0;
  const detect = async () => { detects++; return detection.promise; };
  const calls = [
    recognizeNonSyncCarrier("SF-ISOLATED-001", { store: cache.store, detect }),
    recognizeNonSyncCarrier("SF-ISOLATED-002", { store: cache.store, detect }),
    recognizeNonSyncCarrier("SF-ISOLATED-001", { store: otherCache.store, detect }),
  ];
  detection.resolve(sfCandidate);
  await Promise.all(calls);
  assert.equal(detects, 3, "different waybills and stores must have independent work");
  assert.equal(cache.entries().length, 2);
  assert.equal(otherCache.entries().length, 1);
}

{
  const cache = memoryStore();
  const cancelled = new AbortController();
  cancelled.abort();
  let detects = 0;
  const detect = async () => { detects++; return sfCandidate; };
  await assert.rejects(recognizeNonSyncCarrier("SF-NOT-STARTED-001", {
    store: cache.store, detect, signal: cancelled.signal,
  }), timeout);
  await assert.rejects(recognizeNonSyncCarrier("SF-NOT-STARTED-001", {
    store: cache.store, detect, deadlineAtMs: Date.now() - 1,
  }), timeout);
  assert.equal(detects, 0, "expired callers must not start or join work");
}

{
  const cache = memoryStore();
  const started = deferred<void>();
  const classification = deferred<null>();
  const owner = new AbortController();
  const abandoned = recognizeNonSyncCarrier("SF-CLASSIFY-ABANDONED-001", {
    store: cache.store, signal: owner.signal, detect: async () => [],
    classify: async () => { started.resolve(); return classification.promise; },
  });
  const rejected = assert.rejects(abandoned, timeout);
  await started.promise;
  owner.abort();
  await rejected;
  classification.resolve(null);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(cache.entries(), [], "a late abandoned classifier cannot terminalize the waybill");
}

{
  const cache = memoryStore();
  let attempts = 0;
  const detect = async () => { attempts++; throw new OperationTimeoutError(); };
  const first = recognizeNonSyncCarrier("SF-FAILED-001", { store: cache.store, detect });
  const second = recognizeNonSyncCarrier("SF-FAILED-001", { store: cache.store, detect });
  await Promise.all([assert.rejects(first, timeout), assert.rejects(second, timeout)]);
  assert.equal(attempts, 1);
  assert.deepEqual(cache.entries(), []);
  await assert.rejects(recognizeNonSyncCarrier("SF-FAILED-001", { store: cache.store, detect }), timeout);
  assert.equal(attempts, 2, "failed work must release its shared slot");
}

{
  const cache = memoryStore();
  const started = deferred<void>();
  const detection = deferred<typeof sfCandidate>();
  const firstOwner = new AbortController();
  let workSignal: AbortSignal | undefined;
  let detects = 0;
  const options = {
    store: cache.store,
    detect: async (_waybill: string, request?: { signal?: AbortSignal }) => {
      detects++;
      workSignal = request?.signal;
      started.resolve();
      return detection.promise;
    },
  };
  const cancelled = recognizeNonSyncCarrier("SF-CANCEL-001", { ...options, signal: firstOwner.signal });
  const rejected = assert.rejects(cancelled, timeout);
  const remaining = recognizeNonSyncCarrier("SF-CANCEL-001", options);
  await started.promise;
  firstOwner.abort();
  await rejected;
  assert.equal(workSignal?.aborted, false, "one consumer cannot cancel another consumer's work");
  detection.resolve(sfCandidate);
  assert.equal((await remaining).normalization?.standardCode, "SF");
  assert.equal(detects, 1);
}

{
  const cache = memoryStore();
  const started = deferred<void>();
  const detection = deferred<typeof sfCandidate>();
  const options = {
    store: cache.store,
    detect: async () => { started.resolve(); return detection.promise; },
  };
  const short = recognizeNonSyncCarrier("SF-DEADLINE-001", { ...options, deadlineAtMs: Date.now() + 20 });
  const expired = assert.rejects(short, timeout);
  const long = recognizeNonSyncCarrier("SF-DEADLINE-001", { ...options, deadlineAtMs: Date.now() + 5_000 });
  await started.promise;
  await expired;
  detection.resolve(sfCandidate);
  assert.equal((await long).normalization?.standardCode, "SF");
}

{
  const cache = memoryStore();
  const started = deferred<void>();
  const detection = deferred<[]>();
  const owner = new AbortController();
  let workSignal: AbortSignal | undefined;
  let classifies = 0;
  const abandoned = recognizeNonSyncCarrier("SF-ABANDONED-001", {
    store: cache.store,
    signal: owner.signal,
    detect: async (_waybill, request) => {
      workSignal = request?.signal;
      started.resolve();
      return detection.promise;
    },
    classify: async () => { classifies++; return null; },
  });
  const rejected = assert.rejects(abandoned, timeout);
  await started.promise;
  owner.abort();
  await rejected;
  assert.equal(workSignal?.aborted, true);
  detection.resolve([]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(classifies, 0, "a cancelled detector must not advance to classification");
  assert.deepEqual(cache.entries(), [], "late cancelled work cannot publish a cache entry");
  const retry = await recognizeNonSyncCarrier("SF-ABANDONED-001", {
    store: cache.store, detect: async () => sfCandidate,
  });
  assert.equal(retry.normalization?.standardCode, "SF", "the abandoned slot must be released");
}

console.log("carrier recognition concurrency tests passed");
