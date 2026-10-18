import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const memory = new Map<string, string>();
const shared = new Map<string, unknown>();
const files = new Map<string, string>();
const root = "/group/pipi-deliveries";
const KEY = "pipi_deliveries_scripting_token_v1";
const SHARED_KEY = "pipi_deliveries_scripting_token_shared_v1";
const FILE = `${root}/gateway-credential-v1.json`;
let rejectKeyReads = false;
let rejectKeyWrites = false;
let loseNextWriteReadback = false;
let rejectCleanup = false;
let rejectLegacyReads = false;
let sharedReads = 0;
let keyWrites = 0;
let plaintextReads = 0;
let plaintextWrites = 0;
const calls: Array<{ key: string; options: unknown }> = [];
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function encoded(token: string, generation: number, unavailable = false): string {
  return JSON.stringify({ schema: 4, token, generation,
    availability: unavailable ? "unavailable" : "available",
    checksum: hash(`credential\n${generation}\n${unavailable ? "unavailable" : "available"}\n${token}`) });
}
Object.assign(globalThis, {
  Data: { fromRawString: (v: string) => v, fromIntArray: (v: number[]) => String.fromCharCode(...v) },
  Crypto: { sha256: (v: string) => ({ toHexString: () => hash(v) }) },
  Path: { join: (...v: string[]) => v.join("/").replace(/\/{2,}/g, "/") },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    existsSync: (path: string) => path === root || files.has(path),
    isFileSync: (path: string) => files.has(path),
    readDirectorySync: () => [...files.keys()].map((path) => path.slice(root.length + 1)),
    readAsStringSync: (path: string) => {
      if (rejectLegacyReads) throw new Error("synthetic legacy read failure");
      plaintextReads++; return files.get(path);
    },
    writeAsStringSync: (path: string, value: string) => { plaintextWrites++; files.set(path, value); },
    createDirectorySync() {},
    renameSync: (path: string, next: string) => { files.set(next, files.get(path)!); files.delete(path); },
    removeSync: (path: string) => { if (rejectCleanup) throw new Error("synthetic cleanup failure"); files.delete(path); },
  },
  Keychain: {
    get(key: string, options?: unknown): string | null {
      calls.push({ key, options });
      if (rejectKeyReads) throw new Error("synthetic Keychain read failure");
      return memory.get(key) ?? null;
    },
    set(key: string, value: string, options?: unknown): boolean {
      calls.push({ key, options }); keyWrites++;
      if (rejectKeyWrites) return false;
      memory.set(key, value);
      if (loseNextWriteReadback) { loseNextWriteReadback = false; rejectKeyReads = true; }
      return true;
    },
    remove: (key: string) => { if (rejectKeyWrites) return false; memory.delete(key); return true; },
  },
  Storage: {
    get: (key: string) => { if (key === SHARED_KEY) { plaintextReads++; sharedReads++; } return shared.get(key); },
    set: (key: string, value: unknown) => { plaintextWrites++; shared.set(key, value); },
    remove: (key: string) => { if (rejectCleanup) throw new Error("synthetic cleanup failure"); shared.delete(key); },
  },
});
const { gatewayCredentialStatus, gatewayConfigured, loadGatewayCredentials, removeGatewayToken, saveGatewayToken }
  = await import("../services/credentials");
const token = "AbCdEf12_GhIjK34";
const replacement = "BcDeFg23_HiJkL45";
// Re-import without a token still cleans both replica types without touching activation Keychain.
const activationKey = "pipi_deliveries_scripting_activation_v1";
const activationFile = `${root}/scripting-activation-v1.json`;
const activationShared = "pipi_deliveries_scripting_activation_shared_v1";
memory.set(activationKey, "SYNTHETIC_PROTECTED_ACTIVATION");
files.set(FILE, "SYNTHETIC_TOKEN_COPY"); files.set(activationFile, "SYNTHETIC_ACTIVATION_COPY");
shared.set(SHARED_KEY, "SYNTHETIC_TOKEN_COPY"); shared.set(activationShared, "SYNTHETIC_ACTIVATION_COPY");
assert.equal(loadGatewayCredentials(), null);
assert.equal(files.size, 0); assert.equal(shared.size, 0);
assert.equal(memory.get(activationKey), "SYNTHETIC_PROTECTED_ACTIVATION");
assert.equal(calls.some((call) => call.key === activationKey), false);
assert.equal(plaintextReads, 0); assert.equal(plaintextWrites, 0);

assert.equal(gatewayCredentialStatus(), "missing");
assert.equal(gatewayConfigured(), false);
assert.equal(loadGatewayCredentials(), null);
saveGatewayToken(token);
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(plaintextWrites, 0, "Access Key must be written only to Keychain");
assert.equal(files.size, 0);
assert.equal(shared.has(SHARED_KEY), false);
assert.ok(calls.every((call) => call.options === undefined), "keep the existing local Keychain namespace");

// A legacy deletion committed its file before best-effort Keychain removal failed.
memory.set(KEY, encoded(token, 10));
files.set(FILE, encoded("", 11));
files.set(`${FILE}.backup`, encoded(token, 9));
assert.equal(loadGatewayCredentials(), null, "an old committed deletion must survive migration");
assert.equal(JSON.parse(memory.get(KEY)!).schema, 6);
assert.equal(JSON.parse(memory.get(KEY)!).token, "");
assert.equal(files.has(FILE), false);
saveGatewayToken(token);

// Existing raw keys and all committed legacy envelopes remain usable in the same scope.
for (const raw of [token, JSON.stringify({ schema: 1, token, checksum: hash(token) }),
  JSON.stringify({ schema: 2, token, generation: 2, checksum: hash(`2\n${token}`) }),
  encoded(token, 3, true)]) {
  memory.set(KEY, raw);
  assert.deepEqual(loadGatewayCredentials(), { token });
  assert.equal(gatewayCredentialStatus(), "configured");
}

// Shared plaintext never overrides Keychain and is deleted without reading its contents.
for (const suffix of ["", ".backup", ".pending-123-abc", ".rollback-123-abc",
  ".backup.pending-123-abc", ".backup.rollback-123-abc"]) files.set(FILE + suffix, "SYNTHETIC_OLD_SECRET");
shared.set(SHARED_KEY, "SYNTHETIC_OLD_SECRET");
files.set(`${root}/state-v1.json`, "SYNTHETIC_BUSINESS_STATE");
const readsBeforeCleanup = plaintextReads;
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(plaintextReads, readsBeforeCleanup, "cleanup must not read any legacy plaintext");
assert.deepEqual([...files.keys()], [`${root}/state-v1.json`]);
assert.equal(shared.has(SHARED_KEY), false);

// A replaced Keychain namespace no longer restores credentials from another script's shared data.
memory.clear();
files.set(FILE, encoded(token, 100)); shared.set(SHARED_KEY, encoded(token, 100));
const writesBeforeReimport = keyWrites;
assert.equal(loadGatewayCredentials(), null);
assert.equal(gatewayCredentialStatus(), "missing");
assert.equal(keyWrites, writesBeforeReimport, "re-import requires an explicit replacement key");
assert.equal(files.has(FILE), false); assert.equal(shared.has(SHARED_KEY), false);
saveGatewayToken(replacement);
assert.deepEqual(loadGatewayCredentials(), { token: replacement });

// A legacy pending commit uses only the secret already in protected Keychain.
for (const schema of [3, 5]) {
  const generation = 17;
  const previousKey = encoded(token, 10);
  const checksum = hash(schema === 3 ? `pending\n${generation}\n${replacement}\n${JSON.stringify(previousKey)}`
    : `pending\n${generation}\navailable\n${replacement}\n${JSON.stringify(previousKey)}`);
  memory.set(KEY, JSON.stringify({ schema, token: replacement, generation, previousKey, availability: "available", checksum }));
  files.set(FILE, encoded(replacement, generation));
  assert.equal(gatewayCredentialStatus(), "configured");
  assert.deepEqual(loadGatewayCredentials(), { token: replacement });
  assert.equal(JSON.parse(memory.get(KEY)!).schema, 6);
  saveGatewayToken(token);
  assert.deepEqual(loadGatewayCredentials(), { token });
}

// A proven uncommitted pending save rolls back only to its protected previousKey.
function pendingRecord(previousKey: string | null): string {
  const generation = 22;
  return JSON.stringify({ schema: 5, token: replacement, generation, previousKey,
    availability: "available",
    checksum: hash(`pending\n${generation}\navailable\n${replacement}\n${JSON.stringify(previousKey)}`) });
}
memory.set(KEY, pendingRecord(encoded(token, 20)));
files.set(FILE, encoded(token, 20));
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(JSON.parse(memory.get(KEY)!).schema, 6);
assert.equal(files.has(FILE), false);

// No prior protected credential stays missing, even if an unrelated shared token exists.
memory.set(KEY, pendingRecord(null)); shared.set(SHARED_KEY, encoded(replacement, 1));
assert.equal(loadGatewayCredentials(), null);
assert.equal(JSON.parse(memory.get(KEY)!).schema, 6);
assert.equal(shared.has(SHARED_KEY), false);

// Unknown commit state or a rejected protected write keeps pending plus durable evidence intact.
for (const failure of ["unreadable", "invalid", "write_rejected"]) {
  const pending = pendingRecord(encoded(token, 20));
  memory.set(KEY, pending);
  const evidence = failure === "invalid" ? "SYNTHETIC_INVALID_RECORD" : encoded(replacement, 22);
  files.set(FILE, evidence);
  rejectLegacyReads = failure === "unreadable";
  rejectKeyWrites = failure === "write_rejected";
  assert.equal(gatewayCredentialStatus(), "conflict", failure);
  assert.equal(loadGatewayCredentials(), null, failure);
  assert.equal(memory.get(KEY), pending);
  assert.equal(files.get(FILE), evidence);
  rejectLegacyReads = false; rejectKeyWrites = false;
  if (failure === "invalid") files.set(FILE, encoded(replacement, 22));
  assert.deepEqual(loadGatewayCredentials(), { token: replacement });
  assert.equal(JSON.parse(memory.get(KEY)!).schema, 6);
}

// Failed rollback retains the old protected pending record until the native store recovers.
{
  const pending = pendingRecord(encoded(token, 20));
  memory.set(KEY, pending); files.set(FILE, encoded(token, 20)); rejectKeyWrites = true;
  assert.equal(gatewayCredentialStatus(), "conflict");
  assert.equal(memory.get(KEY), pending); assert.equal(files.has(FILE), true);
  rejectKeyWrites = false;
  assert.deepEqual(loadGatewayCredentials(), { token });
}
// Malformed protected rollback state remains conflicted until an explicit replacement.
memory.set(KEY, pendingRecord("SYNTHETIC_INVALID_PROTECTED_RECORD"));
assert.equal(gatewayCredentialStatus(), "conflict");
saveGatewayToken(token);
assert.deepEqual(loadGatewayCredentials(), { token });

// An uncommitted pending rollback cannot resurrect a previous key deleted by a newer commit.
memory.set(KEY, pendingRecord(encoded(token, 20))); files.set(FILE, encoded("", 23));
assert.equal(loadGatewayCredentials(), null);
assert.equal(JSON.parse(memory.get(KEY)!).token, "");
// The same holds when a matching pending commit survived only as the stale backup.
memory.set(KEY, pendingRecord(encoded(token, 20)));
files.set(FILE, encoded("", 23)); files.set(`${FILE}.backup`, encoded(replacement, 22));
assert.equal(loadGatewayCredentials(), null);
assert.equal(JSON.parse(memory.get(KEY)!).token, "");

// Unreadable, invalid or unsuccessfully migrated legacy deletion evidence is retained.
for (const failure of ["unreadable", "invalid", "write_rejected"]) {
  const prior = encoded(token, 20);
  memory.set(KEY, prior);
  const evidence = failure === "invalid" ? "SYNTHETIC_INVALID_RECORD" : encoded("", 21);
  files.set(FILE, evidence);
  rejectLegacyReads = failure === "unreadable";
  rejectKeyWrites = failure === "write_rejected";
  assert.equal(gatewayCredentialStatus(), "conflict", failure);
  assert.equal(loadGatewayCredentials(), null, failure);
  assert.equal(files.get(FILE), evidence, "do not delete the only old commit evidence");
  assert.equal(memory.get(KEY), prior);
  rejectLegacyReads = false; rejectKeyWrites = false;
  if (failure === "invalid") files.set(FILE, encoded("", 21));
  assert.equal(loadGatewayCredentials(), null);
  assert.equal(JSON.parse(memory.get(KEY)!).schema, 6);
  assert.equal(JSON.parse(memory.get(KEY)!).token, "");
  assert.equal(files.has(FILE), false);
}

// Explicit replacement/deletion restores a conflicted legacy state without trusting its token.
memory.set(KEY, encoded(token, 1)); files.set(FILE, "SYNTHETIC_INVALID_RECORD");
assert.equal(gatewayCredentialStatus(), "conflict");
saveGatewayToken(replacement);
assert.deepEqual(loadGatewayCredentials(), { token: replacement });
memory.set(KEY, encoded(token, 1)); files.set(FILE, "SYNTHETIC_INVALID_RECORD");
removeGatewayToken();
assert.equal(loadGatewayCredentials(), null);

// Older tombstones cannot erase an active key; newer nonempty replicas cannot grant a different key.
memory.set(KEY, encoded(token, 30)); files.set(FILE, encoded("", 29));
files.set(`${FILE}.backup`, encoded(replacement, 100));
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(JSON.parse(memory.get(KEY)!).schema, 6);

// The same protected marker makes migration one-time, even if shared cleanup keeps failing.
rejectCleanup = true; files.set(FILE, encoded("", Number.MAX_SAFE_INTEGER));
const readsBeforeProtected = plaintextReads;
saveGatewayToken(replacement);
assert.deepEqual(loadGatewayCredentials(), { token: replacement });
assert.equal(plaintextReads, readsBeforeProtected);
rejectCleanup = false; saveGatewayToken(token);

// Native write rejection never replaces the working key; malformed input never writes.
const committed = memory.get(KEY);
rejectKeyWrites = true;
assert.throws(() => saveGatewayToken(replacement), /Access Key 保存失败/);
assert.equal(memory.get(KEY), committed);
assert.throws(() => removeGatewayToken(), /Access Key 删除失败/);
assert.equal(memory.get(KEY), committed);
rejectKeyWrites = false;
assert.throws(() => saveGatewayToken("bad key!"), /^Error: Access Key 无效或已失效$/);
assert.deepEqual(loadGatewayCredentials(), { token });

// A lost verification read reports failure and restores the previous protected record.
loseNextWriteReadback = true;
assert.throws(() => saveGatewayToken(replacement), /Access Key 保存失败/);
assert.equal(memory.get(KEY), committed);
assert.equal(gatewayCredentialStatus(), "conflict");
rejectKeyReads = false;
assert.deepEqual(loadGatewayCredentials(), { token });

// Cleanup failures do not disable a valid Keychain or make legacy values authoritative; retry later.
files.set(FILE, "SYNTHETIC_OLD_SECRET"); shared.set(SHARED_KEY, "SYNTHETIC_OLD_SECRET");
rejectCleanup = true;
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(files.has(FILE), true);
rejectCleanup = false;
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(files.has(FILE), false); assert.equal(shared.has(SHARED_KEY), false);

// Logical deletion is protected in Keychain even while the legacy shared files cannot be removed.
rejectCleanup = true;
files.set(FILE, encoded(token, 500)); shared.set(SHARED_KEY, encoded(token, 500));
removeGatewayToken();
assert.equal(loadGatewayCredentials(), null);
assert.equal(gatewayCredentialStatus(), "missing");
assert.equal(JSON.parse(memory.get(KEY)!).token, "");
rejectCleanup = false;
assert.equal(loadGatewayCredentials(), null);
assert.equal(files.has(FILE), false); assert.equal(shared.has(SHARED_KEY), false);
memory.clear();
assert.equal(loadGatewayCredentials(), null, "no shared copy can resurrect a removed key");
saveGatewayToken(replacement);
assert.deepEqual(loadGatewayCredentials(), { token: replacement });
assert.ok(plaintextReads > 0, "only legacy protected keys inspect deletion commit evidence during migration");
assert.equal(sharedReads, 0, "legacy shared tokens never grant authorization");
assert.equal(plaintextWrites, 0);
console.log("Keychain-only credential tests passed");

const observation = await import("../services/credentials");
assert.equal(typeof observation.gatewayAccessKeyRejected, "function");
const observed: boolean[] = [];
const unsubscribe = observation.subscribeGatewayAccessKeyRejected(value => observed.push(value));
assert.equal(observation.gatewayAccessKeyRejected(), false);
const first = observation.beginGatewayCredentialObservation();
observation.recordGatewayCredentialOutcome(first, 401, "unauthorized");
assert.equal(observation.gatewayAccessKeyRejected(), true);
assert.deepEqual(observed, [false, true]);
for (const [status, code] of [[401, "expired_request"], [403, "key_activated_elsewhere"],
  [403, "forbidden"], [500, "unauthorized"], [0, ""]] as const) {
  observation.recordGatewayCredentialOutcome(observation.beginGatewayCredentialObservation(), status, code);
  assert.equal(observation.gatewayAccessKeyRejected(), true, "unrelated failures do not reclassify the key");
}
observation.recordGatewayCredentialOutcome(observation.beginGatewayCredentialObservation(), 200, "");
assert.equal(observation.gatewayAccessKeyRejected(), false);
const older = observation.beginGatewayCredentialObservation();
const newer = observation.beginGatewayCredentialObservation();
observation.recordGatewayCredentialOutcome(newer, 200, "");
observation.recordGatewayCredentialOutcome(older, 401, "unauthorized");
assert.equal(observation.gatewayAccessKeyRejected(), false, "late old rejection cannot undo newer success");
for (const [status, code] of [[403, "key_activated_elsewhere"], [503, "upstream_unavailable"]] as const) {
  const delayed = observation.beginGatewayCredentialObservation();
  observation.recordGatewayCredentialOutcome(observation.beginGatewayCredentialObservation(), status, code);
  observation.recordGatewayCredentialOutcome(delayed, 401, "unauthorized");
  assert.equal(observation.gatewayAccessKeyRejected(), false, "a newer completed HTTP response fences old rejection");
}
const olderSuccess = observation.beginGatewayCredentialObservation();
observation.recordGatewayCredentialOutcome(observation.beginGatewayCredentialObservation(), 401, "unauthorized");
observation.recordGatewayCredentialOutcome(olderSuccess, 200, "");
assert.equal(observation.gatewayAccessKeyRejected(), true, "late old success cannot hide newer rejection");
const previousGeneration = observation.beginGatewayCredentialObservation();
saveGatewayToken(replacement);
assert.equal(observation.gatewayAccessKeyRejected(), false, "saving even the same key clears the notice");
observation.recordGatewayCredentialOutcome(previousGeneration, 401, "unauthorized");
assert.equal(observation.gatewayAccessKeyRejected(), false);
const removedGeneration = observation.beginGatewayCredentialObservation();
removeGatewayToken();
observation.recordGatewayCredentialOutcome(removedGeneration, 401, "unauthorized");
assert.equal(observation.gatewayAccessKeyRejected(), false, "missing keys are not reported as expired");
saveGatewayToken(token);
const unreadableGeneration = observation.beginGatewayCredentialObservation();
rejectKeyReads = true;
observation.recordGatewayCredentialOutcome(unreadableGeneration, 401, "unauthorized");
assert.equal(observation.gatewayAccessKeyRejected(), false, "configuration conflicts are not expired keys");
rejectKeyReads = false;
const callbacksBeforeUnsubscribe = observed.length;
unsubscribe();
observation.recordGatewayCredentialOutcome(observation.beginGatewayCredentialObservation(), 401, "unauthorized");
assert.equal(observed.length, callbacksBeforeUnsubscribe);
assert.equal(plaintextWrites, 0, "notice state never creates a credential replica");
console.log("Access Key observation generation, response ordering and subscription tests passed");
