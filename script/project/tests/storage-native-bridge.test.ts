import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AppState, Shipment } from "../models";

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const STATE_KEY = "pipi_deliveries_state_v1";
const STATE_BACKUP_KEY = "pipi_deliveries_state_backup_v1";
const memory = new Map<string, unknown>();
const delayed = new Map<string, unknown>();
const delayedReads = new Map<string, number>();
let delayStateWrites = false;
let rejectBackupWrites = false;
let rejectPrimaryWrites = false;
let rejectBindingBackupWrites = false;
let rejectDurableWrites = false;
let rejectDurableReads = false;
let rejectDurablePrimaryInstall = false;
let rejectDurableCurrentMove = false;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nativeRoundTrip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nativeRoundTrip);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort().reverse()) {
    result[key] = nativeRoundTrip((value as Record<string, unknown>)[key]);
  }
  return result;
}

function stateKey(key: string): boolean {
  return key === STATE_KEY || key === STATE_BACKUP_KEY;
}

Object.assign(globalThis, {
  Path: {
    join(...parts: string[]) {
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync(path: string) {
      if (rejectDurableReads && path.startsWith("/group/pipi-deliveries/")) {
        throw new Error("durable read rejected");
      }
      return memory.has(`file:${path}`);
    },
    isFileSync(path: string) {
      return memory.has(`file:${path}`);
    },
    readAsStringSync(path: string) {
      const value = memory.get(`file:${path}`);
      if (typeof value !== "string") throw new Error("missing file");
      return value;
    },
    removeSync(path: string) {
      memory.delete(`file:${path}`);
    },
    renameSync(path: string, newPath: string) {
      if (
        rejectDurableCurrentMove &&
        path === "/group/pipi-deliveries/atomic-test.json" &&
        newPath.includes(".rollback-")
      ) {
        throw new Error("durable current move rejected");
      }
      if (
        rejectDurablePrimaryInstall &&
        path.includes(".pending-") &&
        /^\/group\/pipi-deliveries\/state-v3-[ab]\.json$/.test(newPath)
      ) {
        throw new Error("durable primary install rejected");
      }
      const key = `file:${path}`;
      const destination = `file:${newPath}`;
      const value = memory.get(key);
      if (typeof value !== "string" || memory.has(destination)) {
        throw new Error("rename rejected");
      }
      memory.set(destination, value);
      memory.delete(key);
    },
    writeAsStringSync(path: string, value: string) {
      if (rejectDurableWrites) throw new Error("durable write rejected");
      memory.set(`file:${path}`, value);
    },
  },
  Data: {
    fromIntArray(value: number[]) {
      return String.fromCharCode(...value);
    },
    fromString(value: string) {
      return value;
    },
    fromRawString(value: string) {
      return value;
    },
  },
  Crypto: {
    sha256(value: string) {
      const hex = sha256(value);
      return { toHexString: () => hex };
    },
  },
  Storage: {
    get<T>(key: string): T | null {
      if (stateKey(key) && delayed.has(key)) {
        const remaining = delayedReads.get(key) || 0;
        if (remaining > 0) {
          delayedReads.set(key, remaining - 1);
        } else {
          memory.set(key, structuredClone(delayed.get(key)));
          delayed.delete(key);
          delayedReads.delete(key);
        }
      }
      return (memory.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean {
      if (key === STATE_BACKUP_KEY && rejectBackupWrites) return false;
      if (key === STATE_KEY && rejectPrimaryWrites) return false;
      if (stateKey(key) && delayStateWrites) {
        if (!delayed.has(key) || delayed.get(key) !== value) {
          delayed.set(key, structuredClone(value));
          delayedReads.set(key, 1);
        }
        return true;
      }
      memory.set(key, structuredClone(value));
      return true;
    },
    remove(key: string): void {
      memory.delete(key);
      delayed.delete(key);
      delayedReads.delete(key);
    },
  },
  Keychain: {
    get(key: string): string | null {
      return (memory.get(`keychain:${key}`) as string | undefined) ?? null;
    },
    set(key: string, value: string): boolean {
      if (rejectBindingBackupWrites) return false;
      memory.set(`keychain:${key}`, value);
      return true;
    },
    remove(key: string): void {
      memory.delete(`keychain:${key}`);
    },
  },
});

const {
  emptyState,
  loadState,
  saveState,
} = await import("../services/storage");
const { saveBindingBackup } = await import("../services/binding-backup");
const { readDiagnostics } = await import("../services/logger");
const { writeDurableText } = await import("../services/durable-files");

function timeline(provider: string, detail: string) {
  return {
    provider,
    waybill: "TRACK123456",
    courierCode: "TEST",
    companyName: "Test Express",
    semantic: "TRANSIT" as const,
    statusEventAtMs: NOW - 60_000,
    latestTimeText: "2026-08-26 19:59:00",
    latestDetail: detail,
    tracks: [
      {
        timeText: "2026-08-26 19:58:00",
        timeMs: NOW - 120_000,
        detail: "Picked up",
        statusCode: "103",
        raw: { zeta: 1, nested: { z: 3, a: 1 }, alpha: 2 },
      },
      {
        timeText: "2026-08-26 19:59:00",
        timeMs: NOW - 60_000,
        detail,
        statusCode: "104",
        raw: { second: true, first: false },
      },
    ],
    successAtMs: NOW,
  };
}

function shipment(): Shipment {
  const sourceTimeline = timeline("interface5", "In transit");
  const manualTimeline = timeline("kuaidi100", "Manual detail");
  return {
    identity: {
      id: "owner-native-bridge",
      bindingSource: "interface5",
      sourceOwner: "account",
      sourceId: "owner-native-bridge",
      phoneTail: "8000",
      phone: "13800138000",
      courierCode: "TEST",
      companyName: "Test Express",
      manuallyAdded: false,
      createdAtMs: NOW - 180_000,
    },
    timeline: manualTimeline,
    sourceTimeline,
    manualTimelines: [manualTimeline],
    route: null,
    updatedAtMs: NOW,
  };
}

function completeState(): AppState {
  return {
    ...emptyState(),
    revision: 7,
    updatedAtMs: NOW,
    bindings: [{
      source: "interface5",
      phone: "13800138000",
      boundAtMs: NOW - 1_000,
    }],
    suppressions: [{
      kind: "deleted",
      source: "interface5",
      sourceIdHash: "a".repeat(64),
      phoneHash: "b".repeat(64),
      createdAtMs: NOW - 2_000,
    }],
    tombstones: [{
      waybillHash: "c".repeat(64),
      reason: "manual_delete",
      createdAtMs: NOW - 2_000,
    }],
    pendingQueries: [{
      id: "interface5:PENDING123",
      source: "interface5",
      waybill: "PENDING123",
      phoneTail: "8000",
      courierCode: "TEST",
      companyName: "Test Express",
      createdAtMs: NOW - 5_000,
      lastAttemptAtMs: NOW - 1_000,
      attempts: 2,
    }],
    shipments: [shipment()],
  };
}

function resetStorage(): void {
  memory.clear();
  delayed.clear();
  delayedReads.clear();
  delayStateWrites = false;
  rejectBackupWrites = false;
  rejectPrimaryWrites = false;
  rejectBindingBackupWrites = false;
  rejectDurableWrites = false;
  rejectDurableReads = false;
  rejectDurablePrimaryInstall = false;
  rejectDurableCurrentMove = false;
}

function legacyEnvelope(state: AppState): unknown {
  return {
    schema: 2,
    checksum: sha256(JSON.stringify(state)),
    state,
  };
}

function assertBusinessState(state: AppState): void {
  assert.equal(state.bindings[0]?.phone, "13800138000");
  assert.equal(state.pendingQueries[0]?.waybill, "PENDING123");
  assert.equal(state.suppressions.length, 1);
  assert.equal(state.tombstones.length, 1);
  assert.equal(state.shipments.length, 1);
  assert.equal(state.shipments[0]?.sourceTimeline?.tracks.length, 2);
  assert.equal(state.shipments[0]?.manualTimelines?.[0]?.tracks.length, 2);
  assert.equal(
    state.shipments[0]?.sourceTimeline?.tracks[0]?.raw.nested.a,
    1,
  );
}

// If moving an existing primary into the rollback slot fails, the untouched primary remains the
// only authority even when no backup generation is available.
resetStorage();
writeDurableText("atomic-test.json", "previous");
memory.delete("file:/group/pipi-deliveries/atomic-test.json.backup");
rejectDurableCurrentMove = true;
assert.throws(
  () => writeDurableText("atomic-test.json", "replacement"),
  /durable current move rejected/,
);
rejectDurableCurrentMove = false;
assert.equal(
  memory.get("file:/group/pipi-deliveries/atomic-test.json"),
  "previous",
);

// The native bridge may recursively reorder JSON object keys. New writes remain valid because the
// complete state is persisted as a checked string payload rather than as a bridged object graph.
resetStorage();
const reorderedWrite = saveState(
  nativeRoundTrip(completeState()) as AppState,
  NOW + 1,
);
assertBusinessState(reorderedWrite);
assert.equal(typeof memory.get(STATE_KEY), "string");
assert.equal(typeof memory.get(STATE_BACKUP_KEY), "string");
assertBusinessState(loadState(NOW + 2));

// Existing object envelopes that only lost their original key order are recovered when both
// independently stored copies agree, then immediately rewritten in the string format.
resetStorage();
const legacy = legacyEnvelope(completeState());
saveBindingBackup("interface5", []);
memory.set(STATE_KEY, nativeRoundTrip(legacy));
memory.set(STATE_BACKUP_KEY, nativeRoundTrip(legacy));
const recovered = loadState(NOW + 3);
assertBusinessState(recovered);
assert.equal(typeof memory.get(STATE_KEY), "string");
assert.equal(typeof memory.get(STATE_BACKUP_KEY), "string");
memory.delete(STATE_KEY);
assertBusinessState(loadState(NOW + 4));

// A transient Keychain failure must not finalize the legacy migration. The matching legacy
// replicas stay available, so the next load can retry the binding backup before writing schema 3.
resetStorage();
saveBindingBackup("interface5", []);
const retryableLegacy = nativeRoundTrip(legacyEnvelope(completeState()));
memory.set(STATE_KEY, structuredClone(retryableLegacy));
memory.set(STATE_BACKUP_KEY, structuredClone(retryableLegacy));
rejectBindingBackupWrites = true;
assertBusinessState(loadState(NOW + 4));
assert.equal(typeof memory.get(STATE_KEY), "object");
assert.equal(typeof memory.get(STATE_BACKUP_KEY), "object");
rejectBindingBackupWrites = false;
assertBusinessState(loadState(NOW + 4));
assert.equal(typeof memory.get(STATE_KEY), "string");
assert.equal(typeof memory.get(STATE_BACKUP_KEY), "string");
assertBusinessState(loadState(NOW + 4));

// Two legacy copies with different business content cannot use consensus recovery.
resetStorage();
const changed = completeState();
changed.shipments[0] = {
  ...changed.shipments[0],
  timeline: timeline("kuaidi100", "Changed detail"),
};
memory.set(STATE_KEY, nativeRoundTrip(legacyEnvelope(completeState())));
memory.set(STATE_BACKUP_KEY, nativeRoundTrip(legacyEnvelope(changed)));
const divergent = loadState(NOW + 5);
assert.equal(divergent.shipments.length, 0);
assert.equal(divergent.pendingQueries.length, 0);

// A damaged new replica is healed from the independently verified copy.
resetStorage();
saveState(completeState(), NOW + 6);
const damagedPrimary = JSON.parse(String(memory.get(STATE_KEY))) as {
  schema: number;
  checksum: string;
  payload: string;
};
damagedPrimary.payload = damagedPrimary.payload.replace(
  "In transit",
  "Tampered detail",
);
memory.set(STATE_KEY, JSON.stringify(damagedPrimary));
assertBusinessState(loadState(NOW + 7));
memory.delete(STATE_BACKUP_KEY);
assertBusinessState(loadState(NOW + 8));

// If both asynchronous mirrors are modified, the independently checked App Group state wins.
resetStorage();
saveState(completeState(), NOW + 9);
const damagedBoth = JSON.parse(String(memory.get(STATE_KEY))) as {
  schema: number;
  checksum: string;
  payload: string;
};
damagedBoth.payload = damagedBoth.payload.replace(
  "Manual detail",
  "Forged detail",
);
const damagedSerialized = JSON.stringify(damagedBoth);
memory.set(STATE_KEY, damagedSerialized);
memory.set(STATE_BACKUP_KEY, damagedSerialized);
const rejected = loadState(NOW + 10);
assertBusinessState(rejected);

// A readable but corrupt durable primary recovers from its independently verified backup after
// the per-script Storage and Keychain namespaces are replaced during re-import.
resetStorage();
saveState(completeState(), NOW + 10);
const durablePrimaryKey = [...memory.keys()].find((key) =>
  /^file:\/group\/pipi-deliveries\/state-v3-[ab]\.json$/.test(key)
);
assert.equal(typeof durablePrimaryKey, "string");
memory.delete(STATE_KEY);
memory.delete(STATE_BACKUP_KEY);
memory.delete("keychain:pipi_deliveries_binding_backup_v1");
memory.set(durablePrimaryKey!, "{\"schema\":3,\"checksum\":\"broken\"}");
assertBusinessState(loadState(NOW + 11));

// A failed self-heal never replaces the only valid backup with the corrupt primary.
memory.delete(STATE_KEY);
memory.delete(STATE_BACKUP_KEY);
memory.set(durablePrimaryKey!, "{\"schema\":3,\"checksum\":\"broken-again\"}");
const durableBackupKey = `${durablePrimaryKey!}.backup`;
const durableBackupBeforeFailure = memory.get(durableBackupKey);
assert.equal(typeof durableBackupBeforeFailure, "string");
rejectDurablePrimaryInstall = true;
assertBusinessState(loadState(NOW + 12));
rejectDurablePrimaryInstall = false;
assert.equal(memory.get(durableBackupKey), durableBackupBeforeFailure);
memory.delete(STATE_KEY);
memory.delete(STATE_BACKUP_KEY);
assertBusinessState(loadState(NOW + 13));

// An empty durable primary is corruption, not an absent file, and is healed from its backup.
memory.delete(STATE_KEY);
memory.delete(STATE_BACKUP_KEY);
memory.set(durablePrimaryKey!, "");
assertBusinessState(loadState(NOW + 14));
assert.notEqual(memory.get(durablePrimaryKey!), "");

// An App Group I/O failure is not treated as an empty first run, which prevents a later save from
// replacing inaccessible user data with a blank state.
resetStorage();
rejectDurableReads = true;
assert.throws(() => loadState(NOW + 15), /本地快递数据读取失败/);
rejectDurableReads = false;
assert.equal(
  readDiagnostics().some((item) =>
    item.event === "storage.state.rejected" &&
    item.details.result === "read_failed_durable"
  ),
  true,
);

// Accepted writes may become visible one bridge turn later. The in-memory pending commit keeps
// consecutive operations on the accepted state until both durable domains catch up.
resetStorage();
delayStateWrites = true;
const delayedWrite = saveState(completeState(), NOW + 11);
assertBusinessState(delayedWrite);
assertBusinessState(loadState(NOW + 12));
delayStateWrites = false;
assertBusinessState(loadState(NOW + 13));

// Shared Storage is a repairable cache once the synchronous App Group commit succeeds.
resetStorage();
rejectBackupWrites = true;
assertBusinessState(saveState(completeState(), NOW + 14));
assertBusinessState(loadState(NOW + 14));

// The synchronous App Group commit is the required durability boundary.
resetStorage();
rejectDurableWrites = true;
assert.throws(() => saveState(completeState(), NOW + 14), /本地快递数据保存失败/);

// A rejected private mirror does not discard an accepted shared backup. Once the private domain
// becomes writable again, the next read heals it from the same checked payload.
resetStorage();
rejectPrimaryWrites = true;
assertBusinessState(saveState(completeState(), NOW + 15));
assertBusinessState(loadState(NOW + 16));
rejectPrimaryWrites = false;
assertBusinessState(loadState(NOW + 17));
assert.equal(typeof memory.get(STATE_KEY), "string");

console.log("storage native bridge persistence tests passed");
