import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { installSharedFileMock } from "./shared-file-mock";

// Home Access Key reminder (owner decision, 2026-11-21: 首页提醒). Expected results are the approved
// behaviour: a key this script copy cannot read is reminded when one was in use on the device before.

const KEY = "pipi_deliveries_scripting_token_v1";
const keychain = new Map<string, string>();
const storage = new Map<string, unknown>();
const files = new Map<string, string>();
const journal = new Map<string, unknown>();
let keychainReadFails = false;

Object.assign(globalThis, {
  UUID: { string: () => "00000000-0000-4000-8000-000000000001" },
  Data: { fromRawString: (value: string) => value },
  Crypto: { sha256: (value: string) => ({ toHexString: () => createHash("sha256").update(value).digest("hex") }) },
  Path: { join: (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/") },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    existsSync: (path: string) => files.has(path),
    isFileSync: (path: string) => files.has(path),
    readDirectorySync: () => [],
    readAsStringSync: (path: string) => files.get(path) ?? "",
    writeAsStringSync: (path: string, value: string) => { files.set(path, value); },
    createDirectorySync: () => {},
    renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    removeSync: (path: string) => { files.delete(path); },
  },
  Keychain: {
    get: (key: string) => {
      if (keychainReadFails && key === KEY) throw new Error("synthetic Keychain read failure");
      return keychain.get(key) ?? null;
    },
    set: (key: string, value: string) => { keychain.set(key, value); return true; },
    remove: (key: string) => { keychain.delete(key); return true; },
  },
  Storage: {
    get: (key: string) => storage.get(key) ?? null,
    set: (key: string, value: unknown) => { storage.set(key, value); return true; },
    remove: (key: string) => { storage.delete(key); },
  },
});
installSharedFileMock(journal);

const { accessKeyReminder, subscribeAccessKeyReminder } = await import("../services/access-key-reminder");
const {
  beginGatewayCredentialObservation, recordGatewayCredentialOutcome, removeGatewayToken, saveGatewayToken,
} = await import("../services/credentials");
const { resetScriptingActivationProcessState, scriptingInstallationDigest, scriptingInstallationRecorded } =
  await import("../services/scripting-activation");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// A first run without a key keeps Home unchanged, and the read never creates the installation record.
assert.equal(accessKeyReminder(), null);
assert.equal(scriptingInstallationRecorded(), false);
assert.equal(accessKeyReminder(), null, "checking for the record does not create it");

// A saved key shows nothing until the Worker rejects it; a 401 keeps the existing notice.
saveGatewayToken("AAAAAAAAAAAAAAAA");
assert.equal(accessKeyReminder(), null);
recordGatewayCredentialOutcome(beginGatewayCredentialObservation(), 401, "unauthorized");
assert.equal(accessKeyReminder(), "rejected");

// A keyed gateway request commits the shared installation digest. Then the script copy's Keychain scope is
// replaced: the shared record survives and the unreadable key is reminded.
scriptingInstallationDigest();
assert.equal(scriptingInstallationRecorded(), true);
keychain.delete(KEY);
assert.equal(accessKeyReminder(), "missing", "a key that disappeared from this script copy is reminded");

// Removing the key in Settings is deliberate and is not reminded.
saveGatewayToken("AAAAAAAAAAAAAAAA");
removeGatewayToken();
assert.equal(accessKeyReminder(), null, "an explicit removal does not show the reminder");

// A record that no longer decodes is a key this scope held, even without the shared record.
journal.clear();
assert.equal(scriptingInstallationRecorded(), false);
keychain.set(KEY, "corrupted record");
assert.equal(accessKeyReminder(), "missing");
keychain.delete(KEY);
assert.equal(accessKeyReminder(), null, "without any evidence of an earlier key the first-run Home is kept");

// An unreadable Keychain record always shows the conflict notice.
keychainReadFails = true;
assert.equal(accessKeyReminder(), "conflict");
keychainReadFails = false;

// Home follows saves and removals on a later turn, once per burst of changes.
resetScriptingActivationProcessState();
scriptingInstallationDigest();
const seen: Array<string | null> = [];
const unsubscribe = subscribeAccessKeyReminder(value => seen.push(value));
assert.deepEqual(seen, [], "the subscriber is not called inside the subscription");
await tick();
assert.deepEqual(seen, ["missing"], "the first check covers a change since the first render");
saveGatewayToken("BBBBBBBBBBBBBBBB");
recordGatewayCredentialOutcome(beginGatewayCredentialObservation(), 200, "");
assert.deepEqual(seen, ["missing"], "a save or a gateway reply does not wait for the check");
await tick();
assert.deepEqual(seen, ["missing", null], "saving the key in Settings clears the reminder once");
recordGatewayCredentialOutcome(beginGatewayCredentialObservation(), 401, "unauthorized");
await tick();
assert.deepEqual(seen, ["missing", null, "rejected"]);
keychain.delete(KEY);
saveGatewayToken("CCCCCCCCCCCCCCCC");
keychain.delete(KEY);
accessKeyReminder();
unsubscribe();
await tick();
assert.deepEqual(seen, ["missing", null, "rejected"], "an unsubscribed page receives nothing");
console.log("Home Access Key reminder state checks passed");
