import assert from "node:assert/strict";
import {
  CarrierRecognitionBudget,
  CarrierRecognitionBudgetSpentError,
  recognizeNonSyncCarrier,
  type CarrierRecognitionEntry,
  type CarrierRecognitionStore,
} from "../services/carrier-recognition";
import { OperationTimeoutError } from "../services/deadline";

// 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒（「Lite、iOS 也对齐到每轮 30 秒」）。一轮里所有等承运商识别的
// 时间共用一份 30 秒，只计等识别的时间；调用方原有的截止时间照旧，取更早的那个。用光后剩下的运单不再发请求；到点时在途
// 的请求被取消，不写失败次数、不写终态。与 Pipi ExpressAutomaticCarrierRecognizer.ROUND_BUDGET_MILLIS 同一语义。

const realNow = Date.now;
let fakeClock: number | null = null;
Date.now = () => fakeClock ?? realNow();
process.on("exit", () => { Date.now = realNow; });

function memoryStore() {
  let entries: readonly CarrierRecognitionEntry[] = [];
  const store: CarrierRecognitionStore = {
    load: () => entries,
    save: value => { entries = value; },
  };
  return { store, entries: () => entries };
}

const jt = [{ courierCode: "jtexpress", companyName: "极兔速递" }];
const timeout = (error: unknown) => error instanceof OperationTimeoutError;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** Never answers; rejects as a cancelled request once its signal is aborted. */
function hangingDetector() {
  const state = { calls: 0, signals: [] as AbortSignal[] };
  const detect = async (_waybill: string, request?: { signal?: AbortSignal }) => {
    state.calls++;
    if (request?.signal) state.signals.push(request.signal);
    return new Promise<typeof jt>((_, reject) => {
      request?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("Synthetic abort"), { name: "AbortError" }));
      }, { once: true });
    });
  };
  return { state, detect };
}

// 1. 到点：在途请求被取消，什么都不记（不计失败、不进终态），预算用光；之后同一份预算的运单不再发请求。
{
  fakeClock = null;
  const cache = memoryStore();
  const budget = new CarrierRecognitionBudget(60);
  const slow = hangingDetector();
  let classifies = 0;
  const options = {
    store: cache.store,
    budget,
    detect: slow.detect,
    classify: async () => { classifies++; return null; },
  };
  const startedAt = realNow();
  await assert.rejects(recognizeNonSyncCarrier("JT4006839580001", {
    ...options, deadlineAtMs: Date.now() + 2_000,
  }), (error: unknown) => error instanceof CarrierRecognitionBudgetSpentError);
  assert.ok(realNow() - startedAt < 1_000, "the budget ends the wait, well before the caller's own deadline");
  assert.equal(slow.state.signals[0]?.aborted, true, "the request in flight is cancelled");
  await settle();
  assert.deepEqual(cache.entries(), [], "an abandoned request records no failure and no terminal verdict");
  assert.equal(classifies, 0);
  assert.equal(budget.spent(), true, "the round's budget is used up");

  await assert.rejects(recognizeNonSyncCarrier("JT4006839580002", {
    ...options, deadlineAtMs: Date.now() + 2_000,
  }), (error: unknown) => error instanceof CarrierRecognitionBudgetSpentError);
  assert.equal(slow.state.calls, 1, "a spent budget sends no further request");
  assert.deepEqual(cache.entries(), []);

  // A waybill the cache already answers costs no wait and is still answered.
  const known = memoryStore();
  await recognizeNonSyncCarrier("JT4006839580003", { store: known.store, detect: async () => jt });
  const cached = await recognizeNonSyncCarrier("JT4006839580003", {
    store: known.store, budget, detect: slow.detect,
  });
  assert.equal(cached.normalization?.standardCode, "JTSD");
  assert.equal(slow.state.calls, 1);
}

// 2. 同一轮共用一份：前一张等了 20 秒，后一张只剩 10 秒；再后面的不再发请求。
{
  fakeClock = Date.UTC(2026, 8, 27, 2, 0, 0);
  const cache = memoryStore();
  const budget = new CarrierRecognitionBudget();
  let calls = 0;
  const takes = (ms: number) => async () => {
    calls++;
    fakeClock! += ms;
    return jt;
  };
  const first = await recognizeNonSyncCarrier("JT4006839580011", {
    store: cache.store, budget, detect: takes(20_000),
  });
  assert.equal(first.normalization?.standardCode, "JTSD");
  await assert.rejects(recognizeNonSyncCarrier("JT4006839580012", {
    store: cache.store, budget, detect: takes(20_000),
  }), timeout, "only 10 of the round's 30 seconds were left for the second waybill");
  assert.equal(budget.spent(), true);
  await assert.rejects(recognizeNonSyncCarrier("JT4006839580013", {
    store: cache.store, budget, detect: takes(1_000),
  }), timeout);
  assert.equal(calls, 2, "the third waybill waits for the next round");
}

// 3. 只计等识别的时间：两次识别之间的时间（列表请求、落库）不算。
{
  fakeClock = Date.UTC(2026, 8, 27, 3, 0, 0);
  const cache = memoryStore();
  const budget = new CarrierRecognitionBudget();
  const takes = (ms: number) => async () => {
    fakeClock! += ms;
    return jt;
  };
  await recognizeNonSyncCarrier("JT4006839580021", { store: cache.store, budget, detect: takes(10_000) });
  fakeClock += 60_000;
  const later = await recognizeNonSyncCarrier("JT4006839580022", {
    store: cache.store, budget, detect: takes(15_000),
  });
  assert.equal(later.normalization?.standardCode, "JTSD", "25 seconds of waiting fit in the round's 30");
  assert.equal(budget.spent(), false);
}

// 4. 调用方更早的截止时间照样生效，预算不延长它；那次超时不算用光预算。
{
  fakeClock = null;
  const cache = memoryStore();
  const budget = new CarrierRecognitionBudget(3_000);
  const slow = hangingDetector();
  const startedAt = realNow();
  await assert.rejects(recognizeNonSyncCarrier("JT4006839580031", {
    store: cache.store, budget, detect: slow.detect, deadlineAtMs: Date.now() + 40,
  }), (error: unknown) => timeout(error) && !(error instanceof CarrierRecognitionBudgetSpentError));
  assert.ok(realNow() - startedAt < 1_000, "the caller's earlier deadline still ends the wait");
  assert.equal(slow.state.signals[0]?.aborted, true);
  assert.equal(budget.spent(), false, "the outer deadline, not the budget, ended that wait");
  await settle();
  assert.deepEqual(cache.entries(), []);
  const answered = await recognizeNonSyncCarrier("JT4006839580032", {
    store: cache.store, budget, detect: async () => jt, deadlineAtMs: Date.now() + 1_000,
  });
  assert.equal(answered.normalization?.standardCode, "JTSD", "the rest of the budget is still there");
}

// 5. 并发等待（同一轮两件手动件同时补识别）只按钟表走一次，不按两份相加。
{
  fakeClock = Date.UTC(2026, 8, 27, 4, 0, 0);
  const budget = new CarrierRecognitionBudget();
  const startedAt = fakeClock;
  const firstDeadline = budget.beginWait(startedAt);
  fakeClock += 5_000;
  const secondDeadline = budget.beginWait(fakeClock);
  assert.equal(firstDeadline, startedAt + 30_000);
  assert.equal(secondDeadline, startedAt + 30_000, "an overlapping wait ends with the round's budget");
  fakeClock += 5_000;
  budget.endWait(fakeClock);
  budget.endWait(fakeClock);
  assert.equal(budget.remainingAt(fakeClock), 20_000, "ten seconds of the clock, not fifteen");
}

fakeClock = null;
console.log("carrier recognition budget tests passed");
