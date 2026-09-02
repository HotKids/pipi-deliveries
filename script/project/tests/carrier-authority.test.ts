import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const syncSource = readFileSync(join(projectRoot, "services/sync.ts"), "utf8");
const widgetSource = readFileSync(join(projectRoot, "widget.tsx"), "utf8");
const appIntentsSource = readFileSync(
  join(projectRoot, "app_intents.tsx"),
  "utf8",
);

const files = new Map<string, string>();
Object.assign(globalThis, {
  Path: {
    join: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    existsSync: (path: string) => files.has(path),
    isFileSync: (path: string) => files.has(path),
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
});

const {
  loadCarrierAuthorityCache,
  parseCarrierAuthorityPayload,
  refreshCarrierAuthorityIfNeeded,
  resetCarrierAuthorityRuntimeForTesting,
} = await import("../services/carrier-authority");
const {
  BOOTSTRAP_TABLE_SOURCE,
  activeCarrierQueryRecords,
  activeCarrierTableSource,
  activeCarrierTableVersion,
  resetCarrierQueryRecordsForTesting,
  resolveCarrierQuery,
} = await import("../services/carrier-query");

function wireEntries(displayName = "顺丰速运") {
  return activeCarrierQueryRecords().map((record) => ({
    standardCode: record.standardCode,
    displayName: record.standardCode === "SF" ? displayName : record.displayName,
    kuaidi100Code: record.kuaidi100Code,
    kuaidi100CodeAliases: record.kuaidi100CodeAliases,
    hotline: record.hotline,
    iconKey: record.iconKey,
    requiresPhoneTail: record.requiresPhoneTail,
    codeAliases: record.aliases,
    codePrefixAliases: record.codePrefixAliases,
    nameAliases: record.nameAliases,
  }));
}

function payload(displayName = "顺丰速运") {
  return {
    schemaVersion: 2,
    version: "carrier-test-20260901",
    source: "built-in-cache; authority-sync-not-connected",
    entries: wireEntries(displayName),
  };
}

assert.equal(parseCarrierAuthorityPayload(payload())?.entries.length, 17);
assert.equal(parseCarrierAuthorityPayload({ ...payload(), schemaVersion: 1 }), null);
assert.equal(parseCarrierAuthorityPayload({
  ...payload(),
  entries: [...wireEntries(), { ...wireEntries()[0] }],
}), null, "the entire table must be rejected when a canonical code conflicts");
const overlappingPrefixes = wireEntries().map((record) =>
  record.standardCode === "JDKY"
    ? { ...record, codePrefixAliases: ["JDK"] }
    : record
);
assert.equal(parseCarrierAuthorityPayload({
  ...payload(),
  entries: overlappingPrefixes,
}), null, "the entire table must be rejected when carrier prefixes overlap");

const primary = "/group/pipi-deliveries/carrier-authority-v2.json";
const backup = `${primary}.backup`;
const stored = JSON.stringify({
  storageSchema: 1,
  fetchedAtMs: 1_000,
  payload: payload("顺丰缓存展示"),
});
files.set(primary, "corrupt");
files.set(backup, stored);
assert.equal(loadCarrierAuthorityCache(2_000), true);
assert.equal(activeCarrierTableVersion(), "carrier-test-20260901");
assert.equal(
  activeCarrierTableSource(),
  "built-in-cache; authority-sync-not-connected",
);
assert.equal(resolveCarrierQuery("SF")?.displayName, "顺丰缓存展示");

files.set(primary, JSON.stringify({
  storageSchema: 1,
  fetchedAtMs: 3_000,
  payload: { ...payload("无效展示"), entries: [] },
}));
assert.equal(loadCarrierAuthorityCache(4_000), true);
assert.equal(
  resolveCarrierQuery("SF")?.displayName,
  "顺丰缓存展示",
  "an invalid newer primary must not replace the valid backup snapshot",
);

files.clear();
resetCarrierAuthorityRuntimeForTesting();
resetCarrierQueryRecordsForTesting();
assert.equal(
  activeCarrierTableVersion(),
  "6e4ec3e45a460dbea446093a9b7ccb81b2da80f716f57369bc32572d640dda0e",
);
assert.equal(BOOTSTRAP_TABLE_SOURCE, "embedded-transition");
assert.equal(activeCarrierTableSource(), "embedded-transition");
assert.equal(resolveCarrierQuery("SF")?.displayName, "顺丰速运");

// A failed request is still a durable attempt. Restarting inside the 24-hour
// interval must not retry it, and the last-good carrier table remains active.
files.set(primary, stored);
resetCarrierAuthorityRuntimeForTesting();
assert.equal(loadCarrierAuthorityCache(100_000_000), true);
let failedRequestCalls = 0;
assert.equal(await refreshCarrierAuthorityIfNeeded(100_000_000, {
  post: async () => {
    failedRequestCalls++;
    throw new Error("offline");
  },
}), false);
assert.equal(failedRequestCalls, 1);
const attemptFile = "/group/pipi-deliveries/carrier-authority-attempt-v1.json";
assert.equal(
  JSON.parse(files.get(attemptFile) || "{}").lastAttemptAtMs,
  100_000_000,
  "the attempt timestamp must be durable before the network request starts",
);
assert.equal(resolveCarrierQuery("SF")?.displayName, "顺丰缓存展示");

resetCarrierAuthorityRuntimeForTesting();
assert.equal(loadCarrierAuthorityCache(100_001_000), true);
let restartedRequestCalls = 0;
assert.equal(await refreshCarrierAuthorityIfNeeded(100_001_000, {
  post: async () => {
    restartedRequestCalls++;
    throw new Error("must remain throttled");
  },
}), false);
assert.equal(restartedRequestCalls, 0);

assert.match(
  syncSource,
  /if \(!backgroundHostSafe\) \{\s*await refreshCarrierAuthorityIfNeeded\(\)/,
  "a normal foreground sync must refresh carrier authority before reading shipment data",
);
for (const [host, source] of [
  ["Widget", widgetSource],
  ["App Intent", appIntentsSource],
] as const) {
  assert.ok(
    source.includes("loadCarrierAuthorityCache()"),
    `${host} must load the last-good carrier cache`,
  );
  assert.equal(
    source.includes("refreshCarrierAuthorityIfNeeded"),
    false,
    `${host} must never fetch carrier authority directly`,
  );
  assert.match(
    source,
    /backgroundHostSafe:\s*true/,
    `${host} sync must remain cache-only for carrier authority`,
  );
}

console.log("carrier authority cache tests passed");
