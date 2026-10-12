import assert from "node:assert/strict";
import {
  CARRIER_RETRY_DELAY_MS,
  classifyWithWorker,
  recognizeNonSyncCarrier,
  type CarrierRecognitionEntry,
  type CarrierRecognitionStore,
} from "../services/carrier-recognition";
import { GatewayError } from "../services/gateway";

// iOS only (user decision 2026-09-26, with the per-holder Access Key; CONTRACT §3.3): a Worker 401 or
// 403 on /api/express/classify refuses this device's key and is not a recognition failure — no
// count, no terminal verdict, no exhaustion. The waybill keeps the existing 15-minute cooldown and
// asks again, so an invalid, revoked or elsewhere-activated key never pushes a waybill into terminal.

function memoryStore(initial: readonly CarrierRecognitionEntry[] = []) {
  let values = [...initial];
  const store: CarrierRecognitionStore = {
    load: () => values,
    save: (entries) => { values = [...entries]; },
  };
  return { store, entry: () => values[0] };
}

/** What postGateway throws for a refused Worker answer. */
function refused(status: number, code: string) {
  return (async () => {
    throw new GatewayError("synthetic refusal", status, code);
  }) as never;
}

const base = Date.UTC(2026, 8, 27, 0, 0, 0);

for (const [status, code] of [
  [401, "unauthorized"],
  [401, "expired_request"],
  [403, "key_activated_elsewhere"],
  [403, "forbidden"],
] as const) {
  const label = `${status} ${code}`;
  const { store, entry } = memoryStore();
  let classified = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = base + attempt * CARRIER_RETRY_DELAY_MS;
    const outcome = await recognizeNonSyncCarrier("75627185960079", {
      store,
      now,
      detect: async () => [],
      classify: (input, options) => {
        classified++;
        return classifyWithWorker(input, options, refused(status, code));
      },
    });
    assert.equal(outcome.terminal, false, `${label}: never terminal`);
    assert.equal(outcome.exhausted, undefined, `${label}: never exhausted`);
    const current = entry()!;
    assert.equal(current.state, "retry", label);
    assert.equal(current.retryStage, "worker_classify", label);
    assert.equal(current.networkFailures, 0, `${label}: not counted`);
    assert.equal(current.retryAfterMs, now + CARRIER_RETRY_DELAY_MS, `${label}: the usual cooldown`);
    assert.equal(current.exhaustedAtMs, undefined, label);
    // Inside the cooldown nothing is asked again.
    await recognizeNonSyncCarrier("75627185960079", {
      store,
      now: now + 1,
      detect: async () => { throw new Error("must remain in cooldown"); },
      classify: async () => { throw new Error("must remain in cooldown"); },
    });
    assert.equal(classified, attempt + 1, label);
  }
}

// A refusal leaves earlier real failures as they were: it neither adds one nor clears them.
{
  const { store, entry } = memoryStore([{
    waybill: "75627185960080", state: "retry", retryStage: "worker_classify",
    networkFailures: 2, retryAfterMs: base, updatedAtMs: base - CARRIER_RETRY_DELAY_MS,
  }]);
  await recognizeNonSyncCarrier("75627185960080", {
    store,
    now: base,
    detect: async () => [],
    classify: (input, options) => classifyWithWorker(input, options, refused(401, "unauthorized")),
  });
  assert.equal(entry()!.state, "retry");
  assert.equal(entry()!.networkFailures, 2, "the third real failure would terminate; a refusal is not one");
}

// An exhaustion already on record is carried, not created (其余裁决 32).
{
  const exhaustedAtMs = base - 2 * 24 * 60 * 60 * 1_000;
  const { store, entry } = memoryStore([{
    waybill: "75627185960081", state: "retry", retryStage: "worker_classify",
    networkFailures: 0, retryAfterMs: base, updatedAtMs: base - CARRIER_RETRY_DELAY_MS, exhaustedAtMs,
  }]);
  const outcome = await recognizeNonSyncCarrier("75627185960081", {
    store,
    now: base,
    detect: async () => [],
    classify: (input, options) => classifyWithWorker(input, options, refused(403, "key_activated_elsewhere")),
  });
  assert.equal(entry()!.exhaustedAtMs, exhaustedAtMs);
  assert.equal(outcome.exhausted, true);
}

// Every other 4xx is still a counted failure (audit C4 unchanged).
for (const [status, code] of [[400, "invalid_waybill"], [404, "not_found"], [429, "rate_limited"]] as const) {
  const { store, entry } = memoryStore();
  await recognizeNonSyncCarrier("75627185960082", {
    store,
    now: base,
    detect: async () => [],
    classify: (input, options) => classifyWithWorker(input, options, refused(status, code)),
  });
  assert.equal(entry()!.networkFailures, 1, `${status} ${code} is counted`);
}

console.log("carrier recognition authorization-refusal tests passed");
