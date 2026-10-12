import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CARRIER_NETWORK_FAILURE_LIMIT,
  CARRIER_RETRY_DELAY_MS,
  CARRIER_TERMINAL_TTL_MS,
  buildCarrierClassificationRequest,
  classifyWithWorker,
  recognizeNonSyncCarrier,
  type CarrierRecognitionEntry,
  type CarrierRecognitionStore,
} from "../services/carrier-recognition";
import { GatewayError } from "../services/gateway";
import { detectKuaidi100CarrierCandidates } from "../services/kuaidi100-carrier-detection";
import { resolveCarrierQuery } from "../services/carrier-query";

// Audits C1, C3, C4 (adopted 2026-09-25) read through the Worker-generated shared fixtures
// (C12): the Worker's real classify answers, the free autoComNum answers and the per-waybill
// recognition memory. Expected values come from the fixtures, never from this client's code.

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`./fixtures/express/${name}`, import.meta.url), "utf8"));

function memoryStore(): { store: CarrierRecognitionStore; entry: () => CarrierRecognitionEntry | undefined } {
  let values: CarrierRecognitionEntry[] = [];
  return {
    store: { load: () => values, save: (entries) => { values = [...entries]; } },
    entry: () => values[0],
  };
}

/** What postGateway yields for a Worker answer: the object for a 2xx, a GatewayError otherwise. */
function gatewayAnswer(status: number, body: unknown) {
  return async () => {
    if (status >= 200 && status < 300) {
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new GatewayError("服务响应异常", status);
      }
      return body as Record<string, unknown>;
    }
    const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : "";
    const retryAt = body && typeof body === "object" ? (body as Record<string, unknown>).retryAt : 0;
    throw new GatewayError("synthetic", status, typeof error === "string" ? error : "", "",
      status === 502 && error === "recognition_pending" && Number.isSafeInteger(retryAt) && Number(retryAt) > 0
        ? Number(retryAt) : 0);
  };
}

type Observed = { kind: string; standardCode?: string; retryAt?: number };

function observed(entry: CarrierRecognitionEntry | undefined): Observed {
  if (!entry) return { kind: "none" };
  if (entry.state === "resolved") return { kind: "success", standardCode: entry.normalization?.standardCode };
  if (entry.state === "terminal") return { kind: "terminal" };
  return { kind: "retry" };
}

// ---- C1 + C4: the Worker's classify answers ----------------------------------------------------
{
  const shared = fixture("carrier-classify-responses.v1.json");
  const cases = [...shared.cases, ...shared.routeLayer];
  assert.ok(cases.length > 20);
  for (const item of cases) {
    const { status, body } = item.response;
    const { store, entry } = memoryStore();
    let detected = 0;
    await recognizeNonSyncCarrier("75627185960079", {
      store,
      now: shared.readingNowMs,
      detect: async () => { detected++; return []; },
      classify: (input, options) =>
        classifyWithWorker(input, options, gatewayAnswer(status, body) as never),
    });
    assert.equal(detected, 1, `${item.name}: the free stage runs first`);
    const reading = item.reading;
    const actual = entry();
    if (reading.kind === "success") {
      assert.deepEqual(observed(actual), { kind: "success", standardCode: reading.standardCode }, item.name);
    } else if (reading.kind === "terminal") {
      assert.deepEqual(observed(actual), { kind: "terminal" }, item.name);
      assert.equal(actual!.networkFailures, 0, `${item.name}: a paid answer is not a failure`);
    } else if (reading.kind === "pending") {
      assert.equal(actual!.state, "retry", item.name);
      assert.equal(actual!.networkFailures, 0, `${item.name}: pending is not counted`);
      assert.equal(actual!.retryAfterMs,
        Math.min(reading.retryAt, shared.readingNowMs + CARRIER_RETRY_DELAY_MS), item.name);
    } else {
      assert.equal(reading.kind, "failure");
      assert.equal(actual!.state, "retry", item.name);
      assert.equal(actual!.networkFailures, 1, `${item.name}: a counted failure (4xx included)`);
      assert.equal(actual!.retryAfterMs, shared.readingNowMs + CARRIER_RETRY_DELAY_MS, item.name);
    }
  }
}

// ---- C3: the free autoComNum answers -------------------------------------------------------------
{
  const shared = fixture("k100-autocomnum-responses.v1.json");
  const originalFetch = globalThis.fetch;
  try {
    for (const item of shared.cases) {
      const { status, body } = item.response;
      globalThis.fetch = (async () => new Response(
        status === 301 || status === 500 ? null : body, { status })) as typeof fetch;
      const { store, entry } = memoryStore();
      let classified = 0;
      await recognizeNonSyncCarrier("JDVB68579779751", {
        store,
        now: 1_000,
        detect: detectKuaidi100CarrierCandidates,
        classify: async () => { classified++; return null; },
      });
      if (item.expected.outcome === "recognized") {
        assert.deepEqual(observed(entry()), { kind: "success", standardCode: item.expected.standardCode }, item.name);
        assert.equal(classified, 0, `${item.name}: a recognized answer never reaches the paid stage`);
      } else if (item.expected.outcome === "unrecognized") {
        assert.equal(classified, 1, `${item.name}: no candidate, the paid stage decides`);
      } else {
        assert.equal(item.expected.outcome, "failure");
        assert.equal(classified, 0, `${item.name}: a failure never reaches the paid stage`);
        assert.equal(entry()?.state, "retry", item.name);
        assert.equal(entry()?.networkFailures, 1, item.name);
      }
    }
    // User decision 2026-09-26: the no-match answer also arrives with a numeric returnCode 201.
    globalThis.fetch = (async () => new Response('{"result":false,"returnCode":201}', { status: 200 })) as typeof fetch;
    let numericClassified = 0;
    await recognizeNonSyncCarrier("JDVB68579779752", {
      store: memoryStore().store, now: 1_000, detect: detectKuaidi100CarrierCandidates,
      classify: async () => { numericClassified++; return null; },
    });
    assert.equal(numericClassified, 1, "numeric 201 is unrecognized: the paid stage decides");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---- C4 + C10: recognition memory per normalized waybill -----------------------------------------
{
  const shared = fixture("carrier-recognition-state.v1.json");
  assert.equal(CARRIER_RETRY_DELAY_MS, shared.constants.retryDelayMs);
  assert.equal(CARRIER_NETWORK_FAILURE_LIMIT, shared.constants.maxNetworkFailures);
  assert.equal(CARRIER_TERMINAL_TTL_MS, shared.constants.terminalTtlMs);
  // The Worker keys its paid claim by the same normalized waybill this client sends. An input
  // without any ASCII letter or digit never reaches the paid route here (no waybill to recognize).
  for (const item of shared.identityCases) {
    if (!/^[A-Z0-9]+$/.test(item.key)) continue;
    assert.equal(buildCarrierClassificationRequest(item.input).payload.waybill, item.key, item.provenance);
  }
  const base = Date.UTC(2026, 8, 25, 0, 0, 0);
  for (const sequence of shared.sequences) {
    const { store, entry } = memoryStore();
    for (const step of sequence.steps) {
      const [name, value] = String(step.event).split(":");
      const offset = step.atMs - base;
      let requested = false;
      await recognizeNonSyncCarrier("JT4006839564547", {
        store,
        now: step.atMs,
        detect: async () => {
          requested = true;
          if (name === "free_failure") throw new Error("synthetic autoComNum failure");
          if (name === "free_success") {
            return [{ courierCode: resolveCarrierQuery(value)!.kuaidi100Code, companyName: "" }];
          }
          return [];
        },
        classify: (input, options) => classifyWithWorker(input, options, (async () => {
          if (name === "paid_success") return { auto: [{ comCode: value }] };
          if (name === "paid_no_match") return { auto: [] };
          if (name === "paid_pending") {
            throw new GatewayError("pending", 502, "recognition_pending", "", base + offset + Number(value));
          }
          throw new GatewayError("unavailable", 502, "upstream_unavailable");
        }) as never),
      });
      const label = `${sequence.name} @${offset}`;
      const expected = step.expected;
      assert.equal(requested, expected.request, `${label}: request`);
      const actual = entry()!;
      if (expected.state === "success") {
        assert.deepEqual(observed(actual), { kind: "success", standardCode: expected.standardCode }, label);
      } else if (expected.state === "terminal") {
        assert.equal(actual.state, "terminal", label);
        assert.equal(actual.networkFailures, expected.failures, label);
        assert.equal(actual.updatedAtMs + CARRIER_TERMINAL_TTL_MS, expected.untilMs, `${label}: terminal until`);
      } else {
        assert.equal(expected.state, "cooling");
        assert.equal(actual.state, "retry", label);
        assert.equal(actual.networkFailures, expected.failures, label);
        assert.equal(actual.retryAfterMs, expected.untilMs, `${label}: cooling until`);
      }
    }
  }
}

console.log("shared carrier recognition fixture tests passed");
