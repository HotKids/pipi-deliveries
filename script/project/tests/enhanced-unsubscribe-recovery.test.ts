import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { memory, NOW } from "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { ENHANCEMENT_ROUTE, existingEnhancementIdentity, loadEnhancementIdentity } from "../services/enhanced-account";
import { EnhancementUnbindUnavailable, replayEnhancementUnsubscribes } from "../services/enhancement-unsubscribe";
import { loadBindingBackup } from "../services/binding-backup";
import { addBinding, emptyState, enableBindingEnhancement, loadState, privateHash, saveState } from "../services/storage";
import { bindPhone, unbindPhone } from "../services/sync";

const PHONE = "13800000000", BOUND_AT = NOW - 1_000;
const UUID_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const UUID_B = "11111111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SHARED_IDENTITY = "pipi_deliveries_account_enhancement_identity_shared_v1";
const KEYCHAIN_IDENTITY = "pipi_deliveries_account_enhancement_identity_v1";
const originalNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = originalNow; });
let nextUUID = UUID_A;
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({ toHexString: () => createHmac("sha256", key).update(value).digest("hex") }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, {
  UUID: { string: () => nextUUID }, Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic" },
});

const requests: Array<{ operation: "bind" | "unbind"; identityFingerprint: string }> = [];
let beforeResponse: (() => void) | undefined;
globalThis.fetch = (async (url: string, options: { body: string }) => {
  assert.equal(new URL(url).pathname, ENHANCEMENT_ROUTE, "this regression permits only the synthetic enhancement route");
  const body = JSON.parse(options.body);
  assert.ok(body.operation === "bind" || body.operation === "unbind");
  assert.equal(body.phone, PHONE);
  requests.push({ operation: body.operation, identityFingerprint: privateHash(JSON.stringify(body.identity)) });
  beforeResponse?.();
  return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
}) as typeof fetch;

function identityKey(key: string): boolean {
  return key.includes("account-enhancement-identity-v1.json") ||
    key === SHARED_IDENTITY || key === `keychain:${KEYCHAIN_IDENTITY}`;
}

function identityCopies(): Map<string, unknown> {
  return new Map([...memory].filter(([key]) => identityKey(key)));
}

function clearIdentity() {
  for (const key of memory.keys()) if (identityKey(key)) memory.delete(key);
}

function rotateIdentity(uuid: string) {
  clearIdentity();
  nextUUID = uuid;
  return loadEnhancementIdentity();
}

function restoreIdentity(copies: Map<string, unknown>) {
  clearIdentity();
  for (const [key, value] of copies) memory.set(key, value);
}

function seed() {
  memory.clear(); requests.length = 0; beforeResponse = undefined; nextUUID = UUID_A;
  saveState({ ...emptyState(), bindings: [{ source: "interface5", phone: PHONE, boundAtMs: BOUND_AT }] }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  const identity = loadEnhancementIdentity();
  return { fingerprint: privateHash(JSON.stringify(identity)), copies: identityCopies() };
}

async function verifiedBinding() {
  await bindPhone("interface5", PHONE, "12345678", undefined, true);
  return loadState().bindings[0];
}

test("a verified binding persists the actual request identity even if the current identity rotates before its reply", async () => {
  const original = seed();
  beforeResponse = () => { rotateIdentity(UUID_B); };
  const binding = await verifiedBinding();
  beforeResponse = undefined;
  assert.equal(requests[0].identityFingerprint, original.fingerprint);
  assert.notEqual(privateHash(JSON.stringify(existingEnhancementIdentity())), original.fingerprint);
  assert.equal(binding.enhancedIdentityFingerprint, original.fingerprint,
    "the bind receipt must identify the request that actually succeeded");
  assert.equal(loadBindingBackup()!.bindings[0].enhancedIdentityFingerprint, original.fingerprint,
    "the binding backup must retain the verified subscription provenance");
});

test("local removal keeps verified provenance while every identity copy is temporarily unreadable, then replays after recovery", async () => {
  const original = seed(), binding = await verifiedBinding();
  const readFile = FileManager.readAsStringSync, readStorage = Storage.get, readKeychain = Keychain.get;
  FileManager.readAsStringSync = path => {
    if (path.includes("account-enhancement-identity-v1.json")) throw new Error("synthetic identity file unavailable");
    return readFile(path);
  };
  Storage.get = ((key: string, options?: unknown) => {
    if (key === SHARED_IDENTITY) throw new Error("synthetic identity mirror unavailable");
    return readStorage(key, options as never);
  }) as typeof Storage.get;
  Keychain.get = key => {
    if (key === KEYCHAIN_IDENTITY) throw new Error("synthetic identity Keychain unavailable");
    return readKeychain(key);
  };
  let removed;
  try {
    assert.throws(() => existingEnhancementIdentity(), /身份读取失败/);
    removed = await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: binding });
  } finally {
    FileManager.readAsStringSync = readFile; Storage.get = readStorage; Keychain.get = readKeychain;
  }
  assert.equal(removed.bindings.length, 0, "identity read failure must not block explicit local removal");
  assert.equal(removed.pendingEnhancementUnsubscribes![0].identityFingerprint, original.fingerprint);
  assert.equal(requests.length, 1, "local removal makes no second network request");
  await replayEnhancementUnsubscribes({ deadlineAtMs: NOW + 1_000 });
  assert.equal(requests.length, 2, "the restored original identity permits the retained unsubscribe");
  assert.equal(requests[1].operation, "unbind");
  assert.equal(requests[1].identityFingerprint, original.fingerprint);
  assert.equal(loadState().pendingEnhancementUnsubscribes?.length || 0, 0);
});

test("a different current identity cannot remotely unsubscribe the verified binding or replace its pending provenance", async () => {
  const original = seed(), binding = await verifiedBinding();
  rotateIdentity(UUID_B);
  await assert.rejects(unbindPhone("interface5", PHONE, { expectedBinding: binding }),
    error => error instanceof EnhancementUnbindUnavailable);
  assert.equal(requests.length, 1, "identity mismatch is rejected before contacting the subscription");
  assert.equal(loadState().bindings.length, 1);
  const removed = await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: binding });
  assert.equal(removed.pendingEnhancementUnsubscribes![0].identityFingerprint, original.fingerprint);
  await replayEnhancementUnsubscribes({ deadlineAtMs: NOW + 1_000 });
  assert.equal(requests.length, 1);
  assert.equal(loadState().pendingEnhancementUnsubscribes?.length, 1);
  restoreIdentity(original.copies);
  await replayEnhancementUnsubscribes({ deadlineAtMs: NOW + 1_000 });
  assert.equal(requests.length, 2);
  assert.equal(loadState().pendingEnhancementUnsubscribes?.length || 0, 0);
});

test("a legacy binding cannot mistake the current identity for its unrecorded original subscription", async () => {
  const original = seed();
  const binding = saveState({ ...loadState(), bindings: [{ source: "interface5", phone: PHONE,
    boundAtMs: BOUND_AT, enhancedMode: true, enhancedAtMs: NOW }] }, NOW).bindings[0];
  rotateIdentity(UUID_B);
  await assert.rejects(unbindPhone("interface5", PHONE, { expectedBinding: binding }),
    error => error instanceof EnhancementUnbindUnavailable);
  assert.equal(requests.length, 0, "an unknown original identity cannot be replaced for ordinary remote unbinding");
  assert.equal(loadState().bindings.length, 1);
  const removed = await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: binding });
  assert.equal(removed.bindings.length, 0, "legacy records retain explicit local removal");
  assert.equal(removed.pendingEnhancementUnsubscribes![0].identityFingerprint, "",
    "local removal must retain uncertainty instead of attributing the obligation to the current identity");
  restoreIdentity(original.copies);
  await replayEnhancementUnsubscribes({ deadlineAtMs: NOW + 1_000 });
  assert.equal(requests.length, 0);
  assert.equal(loadState().pendingEnhancementUnsubscribes?.length, 1,
    "a later readable identity does not prove which subscription owns a legacy obligation");
});

test("explicit re-verification lets a legacy binding unsubscribe its verified identity normally", async () => {
  const original = seed();
  const legacy = saveState({ ...loadState(), bindings: [{ source: "interface5", phone: PHONE,
    boundAtMs: BOUND_AT, enhancedMode: true, enhancedAtMs: NOW - 1 }] }, NOW).bindings[0];
  await assert.rejects(unbindPhone("interface5", PHONE, { expectedBinding: legacy }),
    error => error instanceof EnhancementUnbindUnavailable);
  assert.equal(requests.length, 0);
  const verified = await verifiedBinding();
  assert.equal(verified.enhancedIdentityFingerprint, original.fingerprint);
  assert.equal(verified.boundAtMs, legacy.boundAtMs, "re-verification keeps the base binding generation");
  const removed = await unbindPhone("interface5", PHONE, { expectedBinding: verified });
  assert.equal(removed.bindings.length, 0);
  assert.deepEqual(requests.map(request => request.operation), ["bind", "unbind"]);
  assert.ok(requests.every(request => request.identityFingerprint === original.fingerprint));
  assert.equal(removed.pendingEnhancementUnsubscribes?.length || 0, 0,
    "a confirmed remote unbind does not create an unresolved local-only obligation");
});

for (const active of ["same", "different", "unknown"] as const) {
  test(`an active binding with ${active} provenance acknowledges only a proven same-identity obligation`, async () => {
    const original = seed(), binding = await verifiedBinding();
    await unbindPhone("interface5", PHONE, { localOnly: true, expectedBinding: binding });
    addBinding("interface5", PHONE, NOW);
    if (active === "unknown") {
      enableBindingEnhancement(PHONE, NOW, NOW);
    } else {
      if (active === "different") rotateIdentity(UUID_B);
      await verifiedBinding();
    }
    restoreIdentity(original.copies);
    const count = requests.length;
    await replayEnhancementUnsubscribes({ deadlineAtMs: NOW + 1_000 });
    assert.equal(requests.length, count, "an active same-phone binding is never remotely unsubscribed by this replay");
    assert.equal(loadState().bindings[0].enhancedMode, true);
    assert.equal(loadState().pendingEnhancementUnsubscribes?.length || 0, active === "same" ? 0 : 1,
      "only verified matching provenance can supersede the old unsubscribe obligation");
  });
}
