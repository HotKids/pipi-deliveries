import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { memory, NOW, sha256 } from "./state-storage-mock.ts";
import { emptyState, loadState } from "../services/storage.ts";
import { clearDiagnostics, readDiagnostics, setDiagnosticsEnabled } from "../services/logger.ts";

const PRIMARY = "pipi_deliveries_state_v1";
const BACKUP = "pipi_deliveries_state_backup_v1";
Object.assign(Storage, { remove: (key: string) => { memory.delete(key); } });

function seed() {
  const state = { ...emptyState(), revision: 1, updatedAtMs: NOW,
    bindings: [{ source: "interface5", phone: "13000012345", boundAtMs: NOW - 1000 }],
    pendingQueries: [{ id: "interface5:YT100012345", source: "interface5", waybill: "YT100012345",
      phoneTail: "", courierCode: "YTO", companyName: "Synthetic carrier", attempts: 0,
      createdAtMs: NOW - 1000, lastAttemptAtMs: NOW - 500, route: null }],
    pendingNotifications: [{ id: "synthetic-event", shipmentId: "synthetic-row", semantic: "DELIVERY",
      title: "Synthetic", body: "Original notification", iconName: null }],
  };
  const payload = JSON.stringify(state);
  memory.set(PRIMARY, JSON.stringify({ schema: 3, checksum: sha256(payload), payload }));
  loadState(NOW);
  return loadState(NOW);
}

beforeEach(() => {
  clearDiagnostics();
  memory.clear();
  Date.now = () => NOW;
});

test("an unchanged canonical load reuses its private parsed clone after byte equality", () => {
  seed();
  const payload = JSON.parse(String(memory.get(PRIMARY))).payload;
  const parse = JSON.parse;
  let payloadParses = 0;
  JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (text === payload) payloadParses++;
    return parse(text, reviver);
  }) as typeof JSON.parse;
  let loaded;
  try { loaded = loadState(NOW); }
  finally { JSON.parse = parse; }
  assert.equal(payloadParses, 1, "Integrity validation already owns a fresh parsed state in this load");
  assert.equal(JSON.stringify(loaded), payload);
});

test("returned nested values cannot alias another load or persistent canonical bytes", () => {
  const expected = seed();
  const first = loadState(NOW);
  const second = loadState(NOW);
  first.bindings[0]!.phone = "13000054321";
  first.pendingQueries[0]!.waybill = "YT999999999";
  Object.assign(first.pendingNotifications![0]!, { body: "Changed by caller" });
  assert.deepEqual(second, expected);
  assert.deepEqual(loadState(NOW), expected);
});

test("object-valued legacy input still produces a detached migrated result", () => {
  const original = seed();
  memory.clear();
  const input = structuredClone(original);
  const raw = { schema: 2, state: input, checksum: sha256(JSON.stringify(input)) };
  memory.set(PRIMARY, raw);
  const loaded = loadState(NOW);
  Object.assign(loaded.pendingNotifications![0]!, { body: "Caller mutation" });
  loaded.bindings[0]!.phone = "13000054321";
  assert.deepEqual(input, original, "Legacy objects must never become the returned encoded state");
  assert.deepEqual(loadState(NOW), original);
});

test("failed mirrors keep canonical authority and retry healing without caller aliases", () => {
  const expected = seed();
  memory.set(PRIMARY, "synthetic-corruption");
  memory.set(BACKUP, "synthetic-corruption");
  const set = Storage.set;
  Storage.set = ((key: string, value: unknown, options: any) => {
    if (key === PRIMARY || key === BACKUP) return false;
    return set(key, value, options);
  }) as typeof Storage.set;
  let returned;
  try { returned = loadState(NOW); }
  finally { Storage.set = set; }
  Object.assign(returned.pendingNotifications![0]!, { body: "Caller mutation during pending mirror recovery" });
  assert.deepEqual(loadState(NOW), expected);
  assert.equal(memory.get(PRIMARY), memory.get(BACKUP));
});

test("a stale nonauthoritative durable slot still reports invalid bytes", () => {
  seed();
  setDiagnosticsEnabled(true);
  const slot = "/group/pipi-deliveries/state-v3-a.json";
  memory.set(`file:${slot}`, "synthetic-corruption");
  memory.set(`file:${slot}.backup`, "synthetic-corruption");
  const expected = JSON.parse(JSON.parse(String(memory.get(PRIMARY))).payload);
  assert.deepEqual(loadState(NOW), expected);
  assert.ok(readDiagnostics().some(entry => entry.event === "storage.state.rejected" &&
    entry.details.result === "invalid_durable"));
});

test("a stale nonauthoritative durable slot still reports read failures", () => {
  seed();
  setDiagnosticsEnabled(true);
  memory.set("file:/group/pipi-deliveries/state-v3-a.json", String(memory.get(PRIMARY)));
  const read = FileManager.readAsStringSync;
  FileManager.readAsStringSync = ((name: string) => {
    if (/\/state-v3-a\.json(?:\.backup)?$/.test(name)) throw new Error("Synthetic read failure");
    return read(name);
  }) as typeof FileManager.readAsStringSync;
  const expected = JSON.parse(JSON.parse(String(memory.get(PRIMARY))).payload);
  try { assert.deepEqual(loadState(NOW), expected); }
  finally { FileManager.readAsStringSync = read; }
  assert.ok(readDiagnostics().some(entry => entry.event === "storage.state.rejected" &&
    entry.details.result === "read_failed_durable"));
});
