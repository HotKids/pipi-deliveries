import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installSharedFileMock } from "./shared-file-mock";

// Meal rules after a failed first fetch (owner decision, 2026-11-21: 取餐规则包失败后及时重试). Only an
// accepted rule pack settles a key's rules: a later meal pull asks again, while the carrier table's own
// refresh keeps its 24-hour throttle and concurrent pulls share one request. After a request that brought no
// pack, automatic pulls (launch, foreground return, list pull, a Shortcut) wait 30 seconds; 立即同步 and a key
// change ask at once (N3, 2026-11-21).

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });

const files = new Map<string, string>();
const memory = new Map<string, unknown>();
const keychain = new Map<string, string>();
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
    renameSync: (from: string, to: string) => {
      const value = files.get(from);
      if (value == null) throw new Error("missing source");
      files.delete(from);
      files.set(to, value);
    },
    removeSync: (path: string) => files.delete(path),
  },
  Keychain: {
    get: (name: string) => keychain.get(name),
    set: (name: string, value: string) => { keychain.set(name, value); return true; },
    remove: (name: string) => keychain.delete(name),
  },
});
installSharedFileMock(memory);

const {
  MEAL_RULES_RETRY_BACKOFF_MS, cachedMealRules, ensureMealRules, loadCarrierAuthorityCache, refreshCarrierAuthorityIfNeeded,
  resetCarrierAuthorityRuntimeForTesting,
} = await import("../services/carrier-authority");
const { activeCarrierQueryRecords } = await import("../services/carrier-query");
const { saveGatewayToken } = await import("../services/credentials");
const { sha256Hex } = await import("../services/scripting-data");

const table = {
  schemaVersion: 2,
  version: "carrier-test-meal-retry",
  source: "meal-rule-retry-test",
  entries: activeCarrierQueryRecords().map((record) => ({
    standardCode: record.standardCode,
    displayName: record.displayName,
    kuaidi100Code: record.kuaidi100Code,
    kuaidi100CodeAliases: record.kuaidi100CodeAliases,
    hotline: record.hotline,
    iconKey: record.iconKey,
    requiresPhoneTail: record.requiresPhoneTail,
    codeAliases: record.aliases,
    codePrefixAliases: record.codePrefixAliases,
    nameAliases: record.nameAliases,
  })),
};
const pack = readFileSync(new URL("../../../pickup-rules.json", import.meta.url), "utf8");
const withRules = { ...table, mealRules: { pack, sha256: sha256Hex(pack) } };
const requests: string[] = [];
function post(answer: () => Promise<unknown>) {
  return {
    post: async (route: string, body: { includeMealRules?: true }) => {
      assert.equal(route, "/api/express/carriers");
      requests.push(body.includeMealRules ? "with_rules" : "table_only");
      return answer();
    },
  };
}
const failing = post(async () => { throw new Error("synthetic network failure"); });

resetCarrierAuthorityRuntimeForTesting();
saveGatewayToken("AAAAAAAAAAAAAAAA");

// The launch refresh asks for the saved key's first pack and fails. The launch meal pull right after it does not
// ask again within the backoff; a later automatic pull, for example on a foreground return or a list pull, asks
// again instead of waiting for the daily carrier refresh.
assert.equal(MEAL_RULES_RETRY_BACKOFF_MS, 30_000);
assert.equal(await refreshCarrierAuthorityIfNeeded(Date.now(), failing), false);
assert.deepEqual(requests, ["with_rules"]);
assert.equal(await ensureMealRules("meal_sync", failing), null);
assert.equal(await ensureMealRules(undefined, failing), null, "a Shortcut capture is automatic too");
assert.deepEqual(requests, ["with_rules"], "automatic pulls wait 30 seconds after a failed rules request");
clock += MEAL_RULES_RETRY_BACKOFF_MS - 1;
assert.equal(await ensureMealRules("meal_sync", failing), null);
assert.deepEqual(requests, ["with_rules"]);
clock += 1;
assert.equal(await ensureMealRules("meal_sync", failing), null);
assert.deepEqual(requests, ["with_rules", "with_rules"], "a failed answer does not hold the key's rules for 24 hours");
// The backoff counts from the end of the latest failed request.
assert.equal(await ensureMealRules("meal_sync", failing), null);
assert.deepEqual(requests, ["with_rules", "with_rules"]);
// 立即同步 and a key change ask at once.
assert.equal(await ensureMealRules("meal_sync", { ...failing, explicit: true }), null);
assert.deepEqual(requests, ["with_rules", "with_rules", "with_rules"]);
clock += MEAL_RULES_RETRY_BACKOFF_MS;
assert.equal(await ensureMealRules(undefined, failing), null);
assert.deepEqual(requests.slice(3), ["with_rules"]);

// An answer that parses but carries no pack also leaves the rules unsettled, and holds automatic pulls the same way.
clock += MEAL_RULES_RETRY_BACKOFF_MS;
assert.equal(await ensureMealRules(undefined, post(async () => table)), null);
assert.deepEqual(requests.slice(4), ["with_rules"]);
assert.equal(await ensureMealRules("meal_sync", post(async () => assert.fail("backoff after a rules-less answer"))), null);
assert.deepEqual(requests.slice(4), ["with_rules"]);
clock += MEAL_RULES_RETRY_BACKOFF_MS;

// The carrier table's own refresh keeps its daily throttle after these attempts.
requests.length = 0;
assert.equal(await refreshCarrierAuthorityIfNeeded(Date.now() + 60_000, post(async () => assert.fail("table cooldown"))), false);
assert.deepEqual(requests, []);

// A restarted app keeps the recorded attempt and still retries the rules (the backoff is per process).
resetCarrierAuthorityRuntimeForTesting();
assert.equal(loadCarrierAuthorityCache(), true);
assert.equal(await ensureMealRules(undefined, failing), null);
assert.deepEqual(requests, ["with_rules"], "the retry survives a new process");

// Concurrent meal pulls share one request, and the accepted pack settles the key. A pull made during the backoff
// while a request for the same key runs still waits for that request.
requests.length = 0;
let release: ((value: unknown) => void) | undefined;
const gated = post(() => new Promise(resolve => { release = resolve; }));
const first = ensureMealRules(undefined, { ...gated, explicit: true });
const second = ensureMealRules(undefined, gated);
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(requests, ["with_rules"], "requests for the same key coalesce");
release!(withRules);
assert.equal((await first)?.parsed.ttlSeconds, 7200);
assert.equal((await second)?.parsed.ttlSeconds, 7200);
assert.ok(cachedMealRules());
assert.equal((await ensureMealRules(undefined, post(async () => assert.fail("accepted rules are cached"))))?.parsed.ttlSeconds,
  7200);
assert.deepEqual(requests, ["with_rules"]);
assert.equal(await refreshCarrierAuthorityIfNeeded(Date.now() + 60_000, post(async () => assert.fail("table cooldown"))), false);
console.log("meal rule retry after a failed first fetch checks passed");
