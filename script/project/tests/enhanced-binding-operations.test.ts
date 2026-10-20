import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { ENHANCEMENT_ROUTE } from "../services/enhanced-account";
import { acquireDurableRefreshLease } from "../services/refresh-runtime-state";
import { emptyState, loadState, privateHash, saveState } from "../services/storage";
import { bindPhone, unbindPhone } from "../services/sync";

const PHONE = "13800000000";
const BOUND_AT = NOW - 1_000;
const realNow = Date.now;
let clock = NOW;
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, {
  UUID: { string: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic" },
});

type Request = { operation: "bind" | "unbind"; phone: string; code?: string };
const requests: Request[] = [];
let responseStatus = 200;
let gate: Promise<void> | null = null;
let releaseGate: (() => void) | null = null;
globalThis.fetch = (async (url: string, options: { body: string }) => {
  assert.equal(new URL(url).pathname, ENHANCEMENT_ROUTE, "all network access stays inside the synthetic enhancement route");
  const body = JSON.parse(options.body);
  assert.ok(body.operation === "bind" || body.operation === "unbind");
  assert.equal(body.phone, PHONE);
  assert.deepEqual(body.identity, {
    accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", androidId: "0123456789abcdef",
  });
  requests.push(body);
  if (gate) await gate;
  return { ok: responseStatus === 200, status: responseStatus,
    text: async () => JSON.stringify(responseStatus === 200 ? { ok: true } : { error: "synthetic_unavailable" }) };
}) as typeof fetch;

function seed(base = true, enhanced = false) {
  clock = NOW;
  memory.clear();
  requests.length = 0;
  responseStatus = 200;
  gate = null;
  releaseGate = null;
  saveState({ ...emptyState(), bindings: base ? [{ source: "interface5", phone: PHONE,
    boundAtMs: BOUND_AT, ...(enhanced ? { enhancedMode: true as const, enhancedAtMs: NOW - 500 } : {}) }] : [] }, clock);
  saveGatewayToken("AbCdEfGh_123-456");
}

function assertReleased() {
  const lease = acquireDurableRefreshLease(`binding:${privateHash(PHONE)}`, 1_000);
  assert.ok(lease, "every completed or failed operation must release the phone lease");
  lease.release();
}

async function waitForRequest(count: number) {
  const deadline = realNow() + 1_000;
  while (requests.length < count) {
    if (realNow() >= deadline) throw new Error("synthetic request did not start");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function holdResponse() {
  gate = new Promise<void>((resolve) => { releaseGate = resolve; });
}

seed(false);
await assert.rejects(bindPhone("interface5", PHONE, "12345678", "synthetic-missing", true), /基础绑定/);
assert.equal(requests.length, 0, "enhancement cannot verify an unbound phone remotely");
assert.equal(loadState().bindings.length, 0);
assertReleased();

seed();
responseStatus = 503;
await assert.rejects(bindPhone("interface5", PHONE, "12345678", "synthetic-failed", true));
assert.equal(loadState().bindings[0].enhancedMode, undefined);
assert.equal(loadState().bindings[0].boundAtMs, BOUND_AT);
assertReleased();

responseStatus = 200;
const enhanced = await bindPhone("interface5", PHONE, "12345678", "synthetic-success", true);
assert.equal(enhanced.bindings.length, 1, "enhancement does not create a second binding");
assert.equal(enhanced.bindings[0].enhancedMode, true);
assert.equal(enhanced.bindings[0].enhancedAtMs, clock);
assert.equal(enhanced.bindings[0].boundAtMs, BOUND_AT);
assert.deepEqual(loadState().bindings, enhanced.bindings, "the successful enhancement is durable");
assert.equal(requests[1].operation, "bind");
assert.equal(requests[1].code, "12345678");
assertReleased();

responseStatus = 503;
await assert.rejects(unbindPhone("interface5", PHONE));
assert.deepEqual(loadState().bindings, enhanced.bindings, "remote unbind failure preserves both binding modes locally");
assert.equal(requests[2].operation, "unbind");
assertReleased();
responseStatus = 200;
const removed = await unbindPhone("interface5", PHONE);
assert.equal(removed.bindings.length, 0);
assert.equal(loadState().bindings.length, 0, "remote success removes the basic binding and enhancement together");
assertReleased();

// The same phone lease covers enhanced binding, ordinary binding, and unbinding in both directions.
for (const operation of ["bind", "unbind"] as const) {
  seed(true, operation === "unbind");
  holdResponse();
  const pending = operation === "bind"
    ? bindPhone("interface5", PHONE, "12345678", "synthetic-held", true)
    : unbindPhone("interface5", PHONE);
  try {
    await waitForRequest(1);
    await assert.rejects(bindPhone("interface5", PHONE, "12345678", "synthetic-competing", true), /正在验证或解绑/);
    await assert.rejects(bindPhone("interface5", PHONE, "123456", "synthetic-basic", false), /正在验证或解绑/);
    await assert.rejects(unbindPhone("interface5", PHONE), /正在验证或解绑/);
    assert.equal(requests.length, 1, "competing operations cannot start another upstream request");
  } finally {
    releaseGate?.();
    await pending;
  }
  assert.equal(loadState().bindings.length, operation === "bind" ? 1 : 0);
  assertReleased();
}

// A different persisted base generation cannot receive the previous generation's successful response.
seed();
holdResponse();
const stale = bindPhone("interface5", PHONE, "12345678", "synthetic-stale", true);
try {
  await waitForRequest(1);
  const current = loadState();
  saveState({ ...current, bindings: current.bindings.map(binding => ({ ...binding, boundAtMs: BOUND_AT + 1 })) }, clock);
} finally {
  releaseGate?.();
}
await assert.rejects(stale, /绑定已变更/);
assert.equal(loadState().bindings[0].enhancedMode, undefined);
assert.equal(loadState().bindings[0].boundAtMs, BOUND_AT + 1);
assertReleased();

Date.now = realNow;
console.log("Production enhanced binding, unbinding, generation, mutual exclusion and lease-release tests passed");
