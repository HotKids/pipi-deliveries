import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installSharedFileMock } from "./shared-file-mock";

// Access Key and meal-skip diagnostics (owner decision, 2026-11-21: 诊断日志事件). Fixed events with
// whitelisted results only, written once per state change, never the key, a digest or a generation. A first run
// that never had a key records nothing (N3), and a failed save is recorded (owner 2026-11-21: 记录保存失败（推荐）).

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

const KEY = "pipi_deliveries_scripting_token_v1";
const REPORT_KEY = "pipi_deliveries_credential_report_v1";
const files = new Map<string, string>();
const memory = new Map<string, unknown>();
const keychain = new Map<string, string>();
let keychainReadFails = false;
let keychainWriteFails = false;
let keychainWriteDrops = false;
let keychainRemoveFails = false;
Object.assign(globalThis, {
  Storage: {
    get: (key: string) => memory.get(key) ?? null,
    set: (key: string, value: unknown) => { memory.set(key, structuredClone(value)); return true; },
    remove: (key: string) => { memory.delete(key); },
  },
  Path: { join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/") },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    existsSync: (path: string) => files.has(path),
    isFileSync: (path: string) => files.has(path),
    readDirectorySync: () => [],
    readAsStringSync: (path: string) => files.get(path) || "",
    createDirectorySync: () => {},
    writeAsStringSync: (path: string, value: string) => files.set(path, value),
    renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
    removeSync: (path: string) => files.delete(path),
  },
  Keychain: {
    get: (name: string) => {
      if (keychainReadFails && name === KEY) throw new Error("synthetic Keychain read failure");
      return keychain.get(name);
    },
    set: (name: string, value: string) => {
      if (keychainWriteFails && name === KEY) return false;
      // A write the read-back does not see: Keychain reports success but keeps another value.
      if (keychainWriteDrops && name === KEY) { keychain.set(name, "dropped write"); return true; }
      keychain.set(name, value);
      return true;
    },
    remove: (name: string) => {
      if (keychainRemoveFails && name === KEY) return false;
      keychain.delete(name);
      return true;
    },
  },
});
installSharedFileMock(memory);

const { clearDiagnostics, readDiagnostics, setDiagnosticsEnabled, REPEAT_RELOG_MS } = await import("../services/logger");
const credentials = await import("../services/credentials");
const { ensureMealRules, resetCarrierAuthorityRuntimeForTesting } = await import("../services/carrier-authority");
const { activeCarrierQueryRecords } = await import("../services/carrier-query");
const { sha256Hex } = await import("../services/scripting-data");
const { scriptingInstallationDigest, scriptingInstallationRecorded } = await import("../services/scripting-activation");
setDiagnosticsEnabled(true);

const ACCESS_KEY = "AAAAAAAAAAAAAAAA";
const OTHER_KEY = "BBBBBBBBBBBBBBBB";
const events = () => readDiagnostics().slice().reverse()
  .filter(entry => /^(?:gateway\.credential|cloud\.sync\.skipped)/.test(entry.event))
  .map(entry => `${entry.level} ${entry.event} ${String(entry.details.result ?? "")}`.trim());
function assertPrivate(): void {
  const text = JSON.stringify(readDiagnostics());
  for (const secret of [ACCESS_KEY, OTHER_KEY, sha256Hex(ACCESS_KEY)]) assert.ok(!text.includes(secret));
  for (const entry of readDiagnostics().filter(item => item.event.startsWith("gateway.credential"))) {
    // The logger adds the client build to every entry.
    assert.deepEqual(Object.keys(entry.details).filter(key => key !== "result" && key !== "clientBuild").sort(),
      ["stage"], "credential events carry only their stage and result");
    assert.equal(entry.details.stage, "credential_storage");
  }
}

// A first run that never had a key records nothing, like the Home reminder.
clearDiagnostics();
assert.equal(scriptingInstallationRecorded(), false);
assert.equal(credentials.gatewayCredentialStatus(), "missing");
credentials.gatewayCredentialStatus();
credentials.loadGatewayCredentials();
assert.deepEqual(events(), [], "a fresh install without a key records no missing-key warning");
assert.equal(memory.has(REPORT_KEY), false);

// Once a keyed request committed the installation digest, a key this script copy cannot read is recorded once,
// then not again for later reads.
scriptingInstallationDigest();
assert.equal(scriptingInstallationRecorded(), true);
const appRuntime = await import("../services/credentials.ts?runtime=app");
assert.equal(appRuntime.gatewayCredentialStatus(), "missing");
appRuntime.gatewayCredentialStatus();
appRuntime.loadGatewayCredentials();
assert.deepEqual(events(), ["warning gateway.credential.missing absent"]);

// Another runtime of the same script copy (widget, Shortcut) does not repeat an unchanged state until the
// repeat window ends.
const widgetRuntime = await import("../services/credentials.ts?runtime=widget");
widgetRuntime.gatewayCredentialStatus();
assert.deepEqual(events(), ["warning gateway.credential.missing absent"]);
assert.equal(typeof memory.get(REPORT_KEY), "string");
assert.ok(!String(memory.get(REPORT_KEY)).includes(ACCESS_KEY));
clock += REPEAT_RELOG_MS + 1;
const laterRuntime = await import("../services/credentials.ts?runtime=later");
laterRuntime.gatewayCredentialStatus();
assert.deepEqual(events(), ["warning gateway.credential.missing absent", "warning gateway.credential.missing absent"],
  "a key that stays unreadable is recorded again after the repeat window");

// Saving and removing are recorded where they happen, without the key.
clearDiagnostics();
credentials.saveGatewayToken(ACCESS_KEY);
credentials.saveGatewayToken(ACCESS_KEY);
credentials.saveGatewayToken(OTHER_KEY);
credentials.removeGatewayToken();
credentials.gatewayCredentialStatus();
assert.deepEqual(events(), [
  "info gateway.credential.saved new_key",
  "info gateway.credential.saved same_key",
  "info gateway.credential.saved different_key",
  "info gateway.credential.removed",
], "an explicit removal is not also reported as a missing key");
assertPrivate();

// An unreadable Keychain record is a read failure, recorded once.
clearDiagnostics();
credentials.saveGatewayToken(ACCESS_KEY);
keychainReadFails = true;
assert.equal(credentials.gatewayCredentialStatus(), "conflict");
credentials.gatewayCredentialStatus();
keychainReadFails = false;
assert.deepEqual(events(), ["info gateway.credential.saved new_key", "warning gateway.credential.read_failed keychain_read_failed"]);
// A record that no longer decodes reads as missing.
keychain.set(KEY, "corrupted record");
credentials.gatewayCredentialStatus();
assert.deepEqual(events().slice(-1), ["warning gateway.credential.missing invalid"]);
assertPrivate();

// With recording off nothing is written, and the next state is recorded once it is on again.
clearDiagnostics();
setDiagnosticsEnabled(false);
keychain.delete(KEY);
credentials.gatewayCredentialStatus();
credentials.saveGatewayToken(ACCESS_KEY);
assert.deepEqual(readDiagnostics(), []);
assert.equal(memory.has(REPORT_KEY), false);
setDiagnosticsEnabled(true);
keychain.delete(KEY);
credentials.gatewayCredentialStatus();
assert.deepEqual(events(), ["warning gateway.credential.missing absent"]);

// A save that cannot be committed is recorded with a fixed reason; the Settings error stays the same.
clearDiagnostics();
keychain.delete(KEY);
for (const [setup, reason] of [
  [() => { keychainReadFails = true; }, "keychain_read_failed"],
  [() => { keychainWriteFails = true; }, "write_failed"],
  [() => { keychainWriteDrops = true; keychainRemoveFails = true; }, "restore_failed"],
] as const) {
  setup();
  assert.throws(() => credentials.saveGatewayToken(ACCESS_KEY), /^Error: Access Key 保存失败，请稍后重试$/);
  keychainReadFails = keychainWriteFails = keychainWriteDrops = keychainRemoveFails = false;
  assert.deepEqual(events().filter(line => line.includes("save_failed")).slice(-1),
    [`warning gateway.credential.save_failed ${reason}`]);
}
// The read-back of a first key fails: the half-written record is removed again.
keychain.delete(KEY);
keychainWriteDrops = true;
assert.throws(() => credentials.saveGatewayToken(ACCESS_KEY));
keychainWriteDrops = false;
assert.equal(keychain.has(KEY), false, "a first key whose read-back failed leaves no record");
assert.deepEqual(events().filter(line => line.includes("save_failed")).slice(-1),
  ["warning gateway.credential.save_failed write_failed"]);
assert.ok(!events().some(line => line.includes("gateway.credential.saved")), "a failed save is not reported as saved");
assert.throws(() => credentials.saveGatewayToken("not a key"), /Access Key 无效或已失效/);
assert.equal(events().filter(line => line.includes("save_failed")).length, 4, "a malformed key is a validation error, not a save failure");
assertPrivate();

// The app's meal pull records why it was skipped, once per change of reason.
const table = {
  schemaVersion: 2, version: "carrier-test-meal-skip", source: "meal-skip-test",
  entries: activeCarrierQueryRecords().map((record) => ({
    standardCode: record.standardCode, displayName: record.displayName, kuaidi100Code: record.kuaidi100Code,
    kuaidi100CodeAliases: record.kuaidi100CodeAliases, hotline: record.hotline, iconKey: record.iconKey,
    requiresPhoneTail: record.requiresPhoneTail, codeAliases: record.aliases,
    codePrefixAliases: record.codePrefixAliases, nameAliases: record.nameAliases,
  })),
};
const pack = readFileSync(new URL("../../../pickup-rules.json", import.meta.url), "utf8");
const failing = { post: async () => { throw new Error("synthetic network failure"); } };
const accepted = { post: async () => ({ ...table, mealRules: { pack, sha256: sha256Hex(pack) } }) };
resetCarrierAuthorityRuntimeForTesting();
clearDiagnostics();
assert.equal(await ensureMealRules("meal_sync", failing), null);
assert.equal(await ensureMealRules("meal_sync", failing), null);
assert.equal(await ensureMealRules(undefined, failing), null, "only the app's meal pull records a skip");
credentials.saveGatewayToken(ACCESS_KEY);
assert.equal(await ensureMealRules("meal_sync", failing), null);
assert.equal(await ensureMealRules("meal_sync", failing), null);
// D188 (plan step 7): the meal pull skip is a cloud.sync line of the meal_pickup domain.
const skips = () => events().filter(line => line.includes("cloud.sync.skipped"));
assert.deepEqual(skips(), ["info cloud.sync.skipped no_access_key", "warning cloud.sync.skipped no_meal_rules"]);
assert.ok(await ensureMealRules("meal_sync", { ...accepted, explicit: true }));
credentials.recordGatewayCredentialOutcome(credentials.beginGatewayCredentialObservation(), 401, "unauthorized");
assert.equal(await ensureMealRules("meal_sync", accepted), null);
credentials.removeGatewayToken();
assert.equal(await ensureMealRules("meal_sync", accepted), null);
assert.deepEqual(skips(), [
  "info cloud.sync.skipped no_access_key",
  "warning cloud.sync.skipped no_meal_rules",
  "info cloud.sync.skipped access_key_rejected",
  "info cloud.sync.skipped no_access_key",
], "a pull that runs clears the reason, so the next skip is recorded again");
for (const entry of readDiagnostics().filter(item => item.event === "cloud.sync.skipped")) {
  assert.deepEqual(Object.keys(entry.details).filter(key => key !== "clientBuild").sort(),
    ["domain", "result", "skipReason", "stage"]);
  assert.equal(entry.details.domain, "meal_pickup");
  assert.equal(entry.details.skipReason, entry.details.result, "a skip names its reason (D3)");
  assert.equal(entry.details.stage, "cloud_record_sync");
}
assertPrivate();
Date.now = realNow;
console.log("Access Key and meal-skip diagnostic checks passed");
