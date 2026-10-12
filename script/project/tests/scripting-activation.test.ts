import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

// iOS Access Key activation (user decisions 2026-09-26/27; CONTRACT ACCESS-KEY-BETA-20260927 §2,
// §3 and the §6.2 test vectors; PLAN-ADDENDUM §2.1). Expected values come from the contract and the
// decisions, never from this client's output.

type FakeData = { value: string };
type FakeFetchInit = { headers?: Record<string, string>; body?: string; signal?: AbortSignal };
type KeychainOptions = { synchronizable?: boolean } | undefined;

const keychain = new Map<string, string>();
const keychainCalls: Array<{ op: string; key: string; synchronizable: boolean }> = [];
const files = new Map<string, string>();
const shared = new Map<string, unknown>();
let keychainWritable = true;
let fileWritable = true;
let queuedKeys: string[] = [];
let generatedKeyCalls = 0;

function keychainSlot(key: string, options: KeychainOptions): string {
  return `${options?.synchronizable === true ? "synced" : "local"}:${key}`;
}

Object.assign(globalThis, {
  Data: {
    fromIntArray: () => ({ value: "" }),
    fromRawString: (value: string) => ({ value }),
  },
  Crypto: {
    sha256: (data: FakeData) => ({
      toHexString: () => createHash("sha256").update(data.value).digest("hex"),
    }),
    hmacSHA256: (data: FakeData, key: FakeData) => ({
      toHexString: () => createHmac("sha256", key.value).update(data.value).digest("hex"),
    }),
    generateSymmetricKey: (size?: number) => {
      generatedKeyCalls += 1;
      assert.equal(size, 128);
      return { toHexString: () => queuedKeys.shift() ?? "0123456789abcdef0123456789abcdef" };
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
    existsSync: (path: string) => files.has(path),
    isFileSync: (path: string) => files.has(path),
    readAsStringSync(path: string) {
      const value = files.get(path);
      if (value == null) throw new Error("missing synthetic file");
      return value;
    },
    removeSync: (path: string) => { files.delete(path); },
    renameSync(path: string, newPath: string) {
      const value = files.get(path);
      if (value == null || files.has(newPath)) throw new Error("synthetic rename rejected");
      files.set(newPath, value);
      files.delete(path);
    },
    writeAsStringSync(path: string, value: string) {
      if (!fileWritable && path.includes("scripting-activation")) {
        throw new Error("synthetic App Group write rejected");
      }
      files.set(path, value);
    },
  },
  Keychain: {
    get(key: string, options?: KeychainOptions): string | null {
      keychainCalls.push({ op: "get", key, synchronizable: options?.synchronizable === true });
      return keychain.get(keychainSlot(key, options)) ?? null;
    },
    set(key: string, value: string, options?: KeychainOptions): boolean {
      keychainCalls.push({ op: "set", key, synchronizable: options?.synchronizable === true });
      if (!keychainWritable && key.includes("activation")) return false;
      keychain.set(keychainSlot(key, options), value);
      return true;
    },
    remove(key: string, options?: KeychainOptions): boolean {
      keychain.delete(keychainSlot(key, options));
      return true;
    },
  },
  Storage: {
    get<T>(key: string): T | null {
      return (shared.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean {
      shared.set(key, structuredClone(value));
      return true;
    },
    remove(key: string): void {
      shared.delete(key);
    },
  },
});

let fetchCalls: Array<{ url: string; init: FakeFetchInit }> = [];
let fetchHandler: (init: FakeFetchInit) => Promise<unknown> = async () => ok({ ok: true });
Object.assign(globalThis, {
  fetch: (url: string, init: FakeFetchInit) => {
    fetchCalls.push({ url, init });
    return fetchHandler(init);
  },
});

function ok(body: unknown) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, expectedContentLength: text.length, text: async () => text };
}

function refused(status: number, error: string) {
  const text = JSON.stringify({ error });
  return { ok: false, status, expectedContentLength: text.length, text: async () => text };
}

const {
  ACCESS_KEY_ACTIVATED_ELSEWHERE_MESSAGE,
  ACCESS_KEY_INVALID_MESSAGE,
  ACTIVATION_SAVE_FAILED_MESSAGE,
  GatewayError,
  gatewayErrorCode,
  postGateway,
} = await import("../services/gateway");
const { saveGatewayToken } = await import("../services/credentials");
const {
  resetScriptingActivationProcessState,
  savedKeyActivatedElsewhere,
  SCRIPTING_ACTIVATION_HEADER,
} = await import("../services/scripting-activation");
const {
  clearDiagnostics,
  diagnosticErrorDetails,
  readDiagnostics,
  setDiagnosticsEnabled,
} = await import("../services/logger");

const SYNCED_KEY = "synced:pipi_deliveries_scripting_activation_v1";
const LOCAL_KEY = "local:pipi_deliveries_scripting_activation_v1";
const FILE = "/group/pipi-deliveries/scripting-activation-v1.json";
const SHARED_KEY = "pipi_deliveries_scripting_activation_shared_v1";

function backup(activation: string): string {
  return JSON.stringify({
    schema: 1,
    activation,
    checksum: createHash("sha256")
      .update(`pipi-scripting-activation-backup-v1\n${activation}`)
      .digest("hex"),
  });
}

function backedUp(raw: unknown): string {
  return typeof raw === "string" ? String(JSON.parse(raw).activation) : "";
}

/** A fresh process on a device whose activation stores hold exactly what is given. */
function device(stores: { synced?: string; file?: string; shared?: string } = {}) {
  keychain.delete(SYNCED_KEY);
  keychain.delete(LOCAL_KEY);
  for (const path of [...files.keys()]) if (path.includes("scripting-activation")) files.delete(path);
  shared.delete(SHARED_KEY);
  if (stores.synced) keychain.set(SYNCED_KEY, stores.synced);
  if (stores.file) files.set(FILE, backup(stores.file));
  if (stores.shared) shared.set(SHARED_KEY, backup(stores.shared));
  keychainWritable = true;
  fileWritable = true;
  resetScriptingActivationProcessState();
  clearDiagnostics();
  keychainCalls.length = 0;
  fetchCalls = [];
  generatedKeyCalls = 0;
}

function sentActivation(index = fetchCalls.length - 1): string {
  return String(fetchCalls[index].init.headers?.[SCRIPTING_ACTIVATION_HEADER] ?? "");
}

function activationEvents() {
  return readDiagnostics().filter((entry) => entry.event.startsWith("gateway.activation."));
}

setDiagnosticsEnabled(true);

// ---- CONTRACT §6.2 vector: the exact request headers ------------------------------------------
{
  const key = "AbCdEfGhIjKlMnOp";
  const activation = "1".repeat(64);
  saveGatewayToken(key);
  device({ synced: activation });
  const realNow = Date.now;
  Date.now = () => 1_790_000_000_000 + 400;
  queuedKeys = ["00112233445566778899aabbccddeeff"];
  // The clock stays pinned until the diagnostics are read: the log keeps seven days against the same clock
  // that stamped the entry, so reading on the real clock would make the result depend on today's date.
  try {
    await postGateway("/api/express/carriers", {});
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].init.body, "{}");
    assert.deepEqual(fetchCalls[0].init.headers, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Scripting-Version": "1",
      "X-Scripting-Token": key,
      "X-Scripting-Timestamp": "1790000000",
      "X-Scripting-Nonce": "00112233445566778899aabbccddeeff",
      // The activation identity is not signed: this is the contract's signature for the same request.
      "X-Scripting-Signature": "9a160c2c3c827241637ba4854f972d59f87f1011d030a461a6818dee9f2be670",
      "X-Scripting-Activation": activation,
    });
    // What the Worker stores for this header (CONTRACT §2), so the formats agree end to end.
    assert.equal(
      createHash("sha256").update(`pipi-scripting-activation-v1\n${sentActivation()}`, "utf8").digest("hex"),
      "46d68be5a4f182490c48057987ab097731de28f8f456463d00ae254200a47b4a",
    );
    // The identity is read from the iCloud-synchronized Keychain, never the local-only one.
    const activationReads = keychainCalls.filter((call) => call.key.includes("activation"));
    assert.ok(activationReads.length > 0);
    assert.ok(activationReads.every((call) => call.synchronizable), "activation Keychain calls must be synchronizable");
    // The two local backups now hold the synchronized value.
    assert.equal(backedUp(files.get(FILE)), activation);
    assert.equal(backedUp(shared.get(SHARED_KEY)), activation);
    const events = activationEvents();
    assert.deepEqual(events.map((entry) => [entry.event, entry.details.result, entry.details.persisted]),
      [["gateway.activation.resolved", "synced_keychain", true]]);
    assert.equal(JSON.stringify(readDiagnostics()).includes(activation), false, "the identity is never logged");
  } finally {
    Date.now = realNow;
  }
}

// ---- Every request carries it; the steady state reuses it -------------------------------------
{
  const activation = "2".repeat(64);
  device({ synced: activation, file: activation, shared: activation });
  for (const route of ["/api/express/classify", "/api/express/timeline/preferred", "/api/express/accounts/sync"]) {
    await postGateway(route, { waybill: "SYNTHETIC123" });
  }
  assert.deepEqual(fetchCalls.map((_, index) => sentActivation(index)), [activation, activation, activation]);
  assert.equal(generatedKeyCalls, 3, "one nonce per request and no new identity");
  assert.deepEqual(activationEvents(), [], "a settled identity adds no log lines");
}

// ---- First use: a dedicated identity is generated and saved in all three places first ---------
{
  // The interface-5 installation identity exists on this device and must not be reused.
  const interface5 = JSON.stringify({ userId: "0123456789", oaid: "0a0b0c0d0e0f1011", vaid: "1213141516171819" });
  keychain.set("local:pipi_deliveries_account_v5_identity_v1", interface5);
  device();
  queuedKeys = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
  await postGateway("/api/express/classify", { waybill: "SYNTHETIC123" });
  const generated = "a".repeat(32) + "b".repeat(32);
  assert.equal(sentActivation(), generated, "32 fresh random bytes, not a derived value");
  assert.equal(fetchCalls[0].init.headers?.["X-Scripting-Nonce"], "c".repeat(32));
  assert.equal(keychain.get(SYNCED_KEY), generated);
  assert.equal(keychain.has(LOCAL_KEY), false);
  assert.ok(keychainCalls.some((call) => call.op === "set" && call.key.includes("activation") && call.synchronizable));
  assert.equal(backedUp(files.get(FILE)), generated);
  assert.equal(backedUp(shared.get(SHARED_KEY)), generated);
  assert.equal(keychain.get("local:pipi_deliveries_account_v5_identity_v1"), interface5);
  assert.deepEqual(activationEvents().map((entry) => [entry.details.result, entry.details.persisted]),
    [["generated", true]]);
  // A second request in the same process carries the same identity and generates nothing new.
  queuedKeys = ["d".repeat(32)];
  await postGateway("/api/express/classify", { waybill: "SYNTHETIC123" });
  assert.equal(sentActivation(), generated);
  assert.equal(generatedKeyCalls, 4, "three for the first request, one nonce for the second");
}

// ---- A replaced Keychain scope restores from the App Group file, then from shared Storage ------
{
  const fromFile = "3".repeat(64);
  device({ file: fromFile, shared: fromFile });
  await postGateway("/api/express/classify", {});
  assert.equal(sentActivation(), fromFile);
  assert.equal(keychain.get(SYNCED_KEY), fromFile, "written back to the synchronized Keychain");
  assert.equal(generatedKeyCalls, 1, "only the nonce: nothing new is generated");
  assert.deepEqual(activationEvents().map((entry) => [entry.details.result, entry.details.persisted]),
    [["local_backup", true]]);

  const fromShared = "4".repeat(64);
  device({ shared: fromShared });
  await postGateway("/api/express/classify", {});
  assert.equal(sentActivation(), fromShared);
  assert.equal(keychain.get(SYNCED_KEY), fromShared);
  assert.equal(backedUp(files.get(FILE)), fromShared);
}

// ---- The synchronized Keychain wins over a disagreeing backup, which is rewritten ---------------
{
  const synced = "5".repeat(64);
  const stale = "6".repeat(64);
  device({ synced, file: stale, shared: stale });
  await postGateway("/api/express/classify", {});
  assert.equal(sentActivation(), synced);
  assert.equal(backedUp(files.get(FILE)), synced);
  assert.equal(backedUp(shared.get(SHARED_KEY)), synced);
  assert.deepEqual(activationEvents().map((entry) => entry.details.result), ["synced_keychain_replaced_backup"]);
}

// ---- Nothing is sent when a new identity cannot be saved --------------------------------------
{
  device();
  keychainWritable = false;
  fileWritable = false;
  queuedKeys = ["e".repeat(32), "f".repeat(32)];
  const attempts: boolean[] = [];
  await assert.rejects(
    postGateway("/api/express/classify", { waybill: "SYNTHETIC123" }, {
      onQueryAttempted: (authorized) => attempts.push(authorized),
    }),
    (error: unknown) => error instanceof GatewayError && error.message === ACTIVATION_SAVE_FAILED_MESSAGE,
  );
  assert.equal(fetchCalls.length, 0, "no request leaves without a saved identity");
  assert.deepEqual(attempts, []);
  assert.equal(shared.has(SHARED_KEY), false, "an unsaved identity is not left for a later request");
  assert.deepEqual(activationEvents().map((entry) => [entry.event, entry.details.result]),
    [["gateway.activation.failed", "save_failed"]]);

  // One verified durable copy is enough: the verified App Group file alone.
  device();
  keychainWritable = false;
  queuedKeys = ["7".repeat(32), "8".repeat(32)];
  await postGateway("/api/express/classify", {});
  assert.equal(sentActivation(), "7".repeat(32) + "8".repeat(32));
  assert.deepEqual(activationEvents().map((entry) => [entry.details.result, entry.details.persisted]),
    [["generated", false]]);
}

// ---- Worker answers: 401 and 403 are told apart by their `error` code ---------------------------
{
  device({ synced: "9".repeat(64) });
  assert.equal(ACCESS_KEY_INVALID_MESSAGE, "Access Key 无效或已失效");
  // User decisions 2026-09-27: activated elsewhere reads 「Access Key 已使用」, and a key that is
  // malformed locally reads the same sentence as one the Worker does not know.
  assert.equal(ACCESS_KEY_ACTIVATED_ELSEWHERE_MESSAGE, "Access Key 已使用");
  assert.throws(() => saveGatewayToken("bad key!"), /^Error: Access Key 无效或已失效$/);
  assert.equal(gatewayErrorCode('{"error":"key_activated_elsewhere"}'), "key_activated_elsewhere");
  assert.equal(gatewayErrorCode('{"error":"key_store_unavailable"}'), "key_store_unavailable");
  const cases: Array<[number, string, string]> = [
    [401, "unauthorized", "Access Key 无效或已失效"],
    [401, "expired_request", "访问授权无效，请检查 Access Key 与系统时间"],
    [403, "key_activated_elsewhere", ACCESS_KEY_ACTIVATED_ELSEWHERE_MESSAGE],
    [403, "forbidden", "当前授权不可使用此功能"],
    [503, "key_store_unavailable", "服务暂时不可用，请稍后重试"],
  ];
  for (const [status, code, message] of cases) {
    fetchHandler = async () => refused(status, code);
    await assert.rejects(postGateway("/api/express/classify", {}), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, status);
      assert.equal(error.gatewayCode, code, `${status} ${code}`);
      assert.equal(error.message, message, `${status} ${code}`);
      assert.equal(diagnosticErrorDetails(error).failureCode, code, `${code} reaches the diagnostic log`);
      return true;
    });
  }
  assert.notEqual(ACCESS_KEY_ACTIVATED_ELSEWHERE_MESSAGE, "当前授权不可使用此功能");
}

// ---- The settings notice follows the Worker's answer for the saved key -------------------------
{
  const keyA = "AbCdEfGhIjKlMnOp";
  const keyB = "ZyXwVuTs_987-654";
  device({ synced: "a".repeat(64) });
  saveGatewayToken(keyA);
  fetchHandler = async () => ok({ ok: true });
  await postGateway("/api/express/classify", {});
  assert.equal(savedKeyActivatedElsewhere(), false);

  fetchHandler = async () => refused(403, "key_activated_elsewhere");
  await assert.rejects(postGateway("/api/express/classify", {}), GatewayError);
  assert.equal(savedKeyActivatedElsewhere(), true);
  // Only the refused key is marked.
  saveGatewayToken(keyB);
  assert.equal(savedKeyActivatedElsewhere(), false);
  saveGatewayToken(keyA);
  assert.equal(savedKeyActivatedElsewhere(), true);
  // A 403 forbidden, an expired request or an unavailable store says nothing new about activation.
  for (const [status, code] of [[403, "forbidden"], [401, "expired_request"], [503, "key_store_unavailable"]] as const) {
    fetchHandler = async () => refused(status, code);
    await assert.rejects(postGateway("/api/express/classify", {}), GatewayError);
    assert.equal(savedKeyActivatedElsewhere(), true, `${status} ${code} keeps the notice`);
  }
  // Success on this device clears it.
  fetchHandler = async () => ok({ ok: true });
  await postGateway("/api/express/classify", {});
  assert.equal(savedKeyActivatedElsewhere(), false);
  // So does 401 unauthorized: the key no longer exists, the shared invalid-key copy takes over.
  fetchHandler = async () => refused(403, "key_activated_elsewhere");
  await assert.rejects(postGateway("/api/express/classify", {}), GatewayError);
  assert.equal(savedKeyActivatedElsewhere(), true);
  fetchHandler = async () => refused(401, "unauthorized");
  await assert.rejects(postGateway("/api/express/classify", {}), GatewayError);
  assert.equal(savedKeyActivatedElsewhere(), false);

  // A delayed refusal of a key replaced while the request was in flight never marks the new key.
  let deliver: ((value: unknown) => void) | undefined;
  fetchHandler = () => new Promise((resolve) => { deliver = resolve; });
  const delayed = postGateway("/api/express/classify", {});
  saveGatewayToken(keyB);
  deliver!(refused(403, "key_activated_elsewhere"));
  await assert.rejects(delayed, GatewayError);
  assert.equal(savedKeyActivatedElsewhere(), false);
  fetchHandler = async () => ok({ ok: true });
}

setDiagnosticsEnabled(false);
console.log("scripting activation tests passed");
