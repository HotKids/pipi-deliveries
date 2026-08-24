import assert from "node:assert/strict";

const memory = new Map<string, string>();
const shared = new Map<string, unknown>();
const files = new Map<string, string>();
let keyRemoveCalls = 0;
let sharedRemoveCalls = 0;
let keySetCalls = 0;
let sharedSetCalls = 0;
let fileWriteCalls = 0;
let rejectDurableReads = false;
let rejectDurableWrites = false;
let rejectKeyWrites = false;
let rejectDurableReadsAfterNextPrimaryVerification = false;
let durablePrimaryAwaitingVerification = false;
const rejectedKeySetCalls = new Set<number>();
const rejectedKeyRemoveCalls = new Set<number>();

const KEY = "pipi_deliveries_scripting_token_v1";
const SHARED_KEY = "pipi_deliveries_scripting_token_shared_v1";
const FILE = "/group/pipi-deliveries/gateway-credential-v1.json";
const BACKUP = `${FILE}.backup`;

function fakeChecksum(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(8);
}

function encoded(token: string, generation: number): string {
  return JSON.stringify({
    schema: 2,
    token,
    generation,
    checksum: fakeChecksum(`${generation}\n${token}`),
  });
}

Object.assign(globalThis, {
  Data: {
    fromIntArray(value: number[]) {
      return String.fromCharCode(...value);
    },
    fromRawString(value: string) {
      return value;
    },
  },
  Crypto: {
    sha256(value: string) {
      return { toHexString: () => fakeChecksum(value) };
    },
  },
  Path: {
    join(...parts: string[]) {
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync(path: string) {
      if (rejectDurableReads) throw new Error("durable read rejected");
      return files.has(path);
    },
    isFileSync(path: string) {
      if (rejectDurableReads) throw new Error("durable read rejected");
      return files.has(path);
    },
    readAsStringSync(path: string) {
      if (rejectDurableReads) throw new Error("durable read rejected");
      const value = files.get(path);
      if (value == null) throw new Error("missing file");
      if (path === FILE && durablePrimaryAwaitingVerification) {
        durablePrimaryAwaitingVerification = false;
        rejectDurableReadsAfterNextPrimaryVerification = false;
        rejectDurableReads = true;
      }
      return value;
    },
    removeSync(path: string) {
      files.delete(path);
    },
    renameSync(path: string, newPath: string) {
      const value = files.get(path);
      if (value == null || files.has(newPath)) throw new Error("rename rejected");
      files.set(newPath, value);
      files.delete(path);
      if (
        newPath === FILE &&
        path.startsWith(`${FILE}.pending-`) &&
        rejectDurableReadsAfterNextPrimaryVerification
      ) {
        durablePrimaryAwaitingVerification = true;
      }
    },
    writeAsStringSync(path: string, value: string) {
      if (rejectDurableWrites) throw new Error("durable write rejected");
      fileWriteCalls += 1;
      files.set(path, value);
    },
  },
  Keychain: {
    get(key: string): string | null {
      return memory.get(key) ?? null;
    },
    set(key: string, value: string): boolean {
      keySetCalls += 1;
      if (rejectKeyWrites || rejectedKeySetCalls.delete(keySetCalls)) {
        return false;
      }
      memory.set(key, value);
      return true;
    },
    remove(key: string): boolean {
      keyRemoveCalls += 1;
      if (rejectedKeyRemoveCalls.delete(keyRemoveCalls)) return false;
      memory.delete(key);
      return true;
    },
  },
  Storage: {
    get<T>(key: string): T | null {
      return (shared.get(key) as T | undefined) ?? null;
    },
    set<T>(key: string, value: T): boolean {
      sharedSetCalls += 1;
      shared.set(key, value);
      return true;
    },
    remove(key: string): void {
      sharedRemoveCalls += 1;
      shared.delete(key);
    },
  },
});

const {
  gatewayCredentialStatus,
  gatewayConfigured,
  loadGatewayCredentials,
  markGatewayTokenUnavailable,
  removeGatewayToken,
  saveGatewayToken,
} = await import("../services/credentials");

assert.equal(gatewayCredentialStatus(), "missing");
assert.equal(gatewayConfigured(), false);
assert.equal(loadGatewayCredentials(), null);

const token = "AbCdEf12_GhIjK34";
saveGatewayToken(token);
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(gatewayConfigured(), true);
assert.equal(sharedSetCalls, 0, "new credentials must never enter shared Storage");
assert.equal(shared.has(SHARED_KEY), false);
assert.equal(memory.has(KEY), true);
assert.equal(files.has(FILE), true);
assert.equal(files.has(BACKUP), true);

// A server rejection changes only the availability metadata. The credential remains
// recoverable, the state survives a fresh Keychain namespace, and an explicit save
// clears the marker without requiring the old credential to be deleted first.
assert.equal(markGatewayTokenUnavailable(token), true);
assert.equal(gatewayCredentialStatus(), "unavailable");
assert.equal(gatewayConfigured(), false);
assert.equal(loadGatewayCredentials(), null);
const unavailableKey = JSON.parse(memory.get(KEY)!);
const unavailablePrimary = JSON.parse(files.get(FILE)!);
const unavailableBackup = JSON.parse(files.get(BACKUP)!);
for (const stored of [
  unavailableKey,
  unavailablePrimary,
  unavailableBackup,
]) {
  assert.equal(stored.schema, 4);
  assert.equal(stored.token, token);
  assert.equal(stored.availability, "unavailable");
}
const writesBeforeIdempotentMark = fileWriteCalls;
assert.equal(markGatewayTokenUnavailable(token), true);
assert.equal(fileWriteCalls, writesBeforeIdempotentMark);
memory.clear();
assert.equal(gatewayCredentialStatus(), "unavailable");
assert.equal(JSON.parse(memory.get(KEY)!).availability, "unavailable");
saveGatewayToken(token);
assert.equal(gatewayCredentialStatus(), "configured");
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(JSON.parse(memory.get(KEY)!).availability, "available");

// Keychain is the normal runtime authority. Stale recovery and legacy copies cannot
// disable or replace the configured credential.
const recoveryWritesBeforeRead = fileWriteCalls;
const keyWritesBeforeRead = keySetCalls;
files.set(FILE, encoded("ZyXwVu98_TsRqP76", Date.now() + 10_000));
files.set(BACKUP, files.get(FILE)!);
shared.set(SHARED_KEY, encoded("MnOpQr12_StUvW34", Date.now() + 20_000));
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(gatewayCredentialStatus(), "configured");
assert.equal(fileWriteCalls, recoveryWritesBeforeRead);
assert.equal(keySetCalls, keyWritesBeforeRead);
assert.equal(shared.has(SHARED_KEY), false);

// A temporarily unavailable App Group does not block the valid Keychain value.
rejectDurableReads = true;
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(gatewayConfigured(), true);
rejectDurableReads = false;

// Restore a matching recovery copy, then simulate re-import replacing only the
// per-script Keychain namespace. The App Group copy restores Keychain on first use.
saveGatewayToken(token);
const keyWritesBeforeReimport = keySetCalls;
memory.clear();
assert.deepEqual(loadGatewayCredentials(), { token });
assert.equal(keySetCalls, keyWritesBeforeReimport + 1);
assert.equal(memory.has(KEY), true);
assert.equal(shared.has(SHARED_KEY), false);

// A legacy shared credential is consumed once, migrated to Keychain plus the App Group
// recovery file, and then removed. No new shared credential write is introduced.
memory.clear();
files.clear();
const legacyToken = "QrStUv12_WxYzA34";
shared.set(SHARED_KEY, encoded(legacyToken, 77));
const sharedWritesBeforeMigration = sharedSetCalls;
assert.deepEqual(loadGatewayCredentials(), { token: legacyToken });
assert.equal(shared.has(SHARED_KEY), false);
assert.equal(sharedSetCalls, sharedWritesBeforeMigration);
assert.equal(memory.has(KEY), true);
assert.equal(files.has(FILE), true);

// Once writeDurableText has verified and installed its primary, that return is the
// commit point. A later App Group read failure must not report a rollback while the
// new generation remains available to a re-imported script.
const replacement = "BcDeFg23_HiJkL45";
rejectDurableReadsAfterNextPrimaryVerification = true;
saveGatewayToken(replacement);
assert.equal(rejectDurableReads, true);
assert.deepEqual(loadGatewayCredentials(), { token: replacement });
memory.clear();
rejectDurableReads = false;
assert.deepEqual(loadGatewayCredentials(), { token: replacement });

// A failed App Group write rolls the Keychain update back to the previous working token.
const failedReplacement = "CdEfGh34_IjKlM56";
rejectDurableWrites = true;
assert.throws(() => saveGatewayToken(failedReplacement), /Access Key 保存失败/);
rejectDurableWrites = false;
assert.deepEqual(loadGatewayCredentials(), { token: replacement });

// If that Keychain rollback is itself rejected, the staged generation remains a
// non-authorizing transaction. It reports conflict until compensation succeeds and
// can never replace the last committed recovery copy after re-import.
const rollbackFailureToken = "DeFgHi45_JkLmN67";
rejectedKeySetCalls.add(keySetCalls + 2);
rejectedKeySetCalls.add(keySetCalls + 3);
rejectDurableWrites = true;
assert.throws(
  () => saveGatewayToken(rollbackFailureToken),
  /Access Key 保存失败/,
);
rejectDurableWrites = false;
assert.equal(JSON.parse(memory.get(KEY)!).schema, 5);
assert.equal(gatewayCredentialStatus(), "conflict");
assert.equal(JSON.parse(memory.get(KEY)!).schema, 5);
assert.deepEqual(loadGatewayCredentials(), { token: replacement });
memory.clear();
assert.deepEqual(loadGatewayCredentials(), { token: replacement });

// A failed Keychain write cannot publish a new recovery credential.
memory.clear();
files.clear();
rejectKeyWrites = true;
assert.throws(() => saveGatewayToken(failedReplacement), /Access Key 保存失败/);
rejectKeyWrites = false;
assert.equal(files.has(FILE), false);
assert.equal(loadGatewayCredentials(), null);

// A rejected Keychain migration neither consumes nor authorizes the shared legacy
// credential. A later call can retry the complete two-store migration.
const keyMigrationToken = "EfGhIj56_KlMnO78";
shared.set(SHARED_KEY, encoded(keyMigrationToken, 91));
rejectedKeySetCalls.add(keySetCalls + 1);
assert.equal(gatewayCredentialStatus(), "conflict");
assert.equal(shared.has(SHARED_KEY), true);
assert.equal(memory.has(KEY), false);
assert.equal(files.has(FILE), false);
assert.deepEqual(loadGatewayCredentials(), { token: keyMigrationToken });
assert.equal(shared.has(SHARED_KEY), false);

// An App Group migration failure has the same retry-only outcome: the legacy value
// stays available for migration but is not returned as configured authorization.
memory.clear();
files.clear();
shared.clear();
const durableMigrationToken = "FgHiJk67_LmNoP89";
shared.set(SHARED_KEY, encoded(durableMigrationToken, 92));
rejectDurableWrites = true;
assert.equal(gatewayCredentialStatus(), "conflict");
assert.equal(shared.has(SHARED_KEY), true);
assert.equal(memory.has(KEY), false);
assert.equal(files.has(FILE), false);
rejectDurableWrites = false;
assert.deepEqual(loadGatewayCredentials(), { token: durableMigrationToken });
assert.equal(shared.has(SHARED_KEY), false);

// A failed migration rollback leaves the pending Keychain record unavailable rather
// than falling back to the shared token. Once rollback and App Group writes recover,
// a later call retries the migration from the preserved legacy copy.
memory.clear();
files.clear();
shared.clear();
const retryMigrationToken = "GhIjKl78_MnOpQ90";
shared.set(SHARED_KEY, encoded(retryMigrationToken, 93));
rejectedKeyRemoveCalls.add(keyRemoveCalls + 1);
rejectedKeyRemoveCalls.add(keyRemoveCalls + 2);
rejectDurableWrites = true;
assert.equal(gatewayCredentialStatus(), "conflict");
rejectDurableWrites = false;
assert.equal(JSON.parse(memory.get(KEY)!).schema, 5);
assert.equal(gatewayCredentialStatus(), "conflict");
assert.equal(loadGatewayCredentials(), null);
assert.equal(shared.has(SHARED_KEY), true);
assert.deepEqual(loadGatewayCredentials(), { token: retryMigrationToken });
assert.equal(shared.has(SHARED_KEY), false);

// A verified durable tombstone is also a commit point. Losing App Group reads after
// that verification must not turn the completed deletion into a reported failure.
rejectDurableReadsAfterNextPrimaryVerification = true;
removeGatewayToken();
assert.equal(rejectDurableReads, true);
assert.equal(memory.has(KEY), false);
assert.equal(shared.has(SHARED_KEY), false);
rejectDurableReads = false;
assert.equal(loadGatewayCredentials(), null);

// Deletion is committed as a durable tombstone before the runtime key is removed.
// Re-import or a stale legacy shared value must not resurrect the deleted credential.
saveGatewayToken(token);
const staleKey = memory.get(KEY);
if (!staleKey) throw new Error("missing synthetic Keychain credential");
removeGatewayToken();
assert.equal(loadGatewayCredentials(), null);
memory.set(KEY, staleKey);
shared.set(SHARED_KEY, staleKey);
assert.equal(loadGatewayCredentials(), null);
assert.equal(memory.has(KEY), false);
assert.equal(shared.has(SHARED_KEY), false);

// A later explicit save advances beyond the tombstone and configures a new credential.
saveGatewayToken(replacement);
assert.deepEqual(loadGatewayCredentials(), { token: replacement });
assert.equal(gatewayConfigured(), true);
assert.equal(sharedSetCalls, 0);
assert.ok(keyRemoveCalls > 0);
assert.ok(sharedRemoveCalls > 0);

console.log("gateway token authority and recovery tests passed");
