import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import { gatewayCredentialForLocalCache, saveGatewayToken } from "../services/credentials";
import { writeDurableText, readDurableTextCandidates } from "../services/durable-files";
import { activeWatchScope, internationalShipmentSnapshot, legacyWatchSnapshot } from "../services/international-records";
import { commitWatchSnapshot, loadWidgetSnapshot, visibleShipments, watchRefreshDue } from "../services/storage";

// One synchronous turn shares the Keychain read behind the Watch scope; the next turn resolves again.
saveGatewayToken("SyntheticKey_101");
await Promise.resolve();
const keychain = (globalThis as unknown as { Keychain: { get(key: string): string | null } }).Keychain;
const read = keychain.get.bind(keychain);
let reads = 0;
keychain.get = (key: string) => { reads += 1; return read(key); };
const first = gatewayCredentialForLocalCache();
const afterFirst = reads;
assert.ok(afterFirst > 0, "the first lookup in a turn reads Keychain");
for (let index = 0; index < 5; index += 1) {
  assert.deepEqual(gatewayCredentialForLocalCache(), first);
  activeWatchScope();
}
assert.equal(reads, afterFirst, "repeated lookups in one turn reuse the first read");
await Promise.resolve();
gatewayCredentialForLocalCache();
assert.ok(reads > afterFirst, "a later turn observes Keychain again");
const before = activeWatchScope();
saveGatewayToken("SyntheticKey_102");
assert.notEqual(activeWatchScope(), before, "saving a key invalidates the scope in the same turn");
keychain.get = read;

// A legacy cache from another key is removed instead of being read on every load.
const CACHE = "international-shipments-v1.json";
writeDurableText(CACHE, JSON.stringify({ scope: "another-key", parcels: [] }));
assert.equal(legacyWatchSnapshot(), undefined);
assert.equal(readDurableTextCandidates(CACHE).length, 0, "a mismatched legacy cache is retired");

// A matching legacy cache is imported once and then retired.
const now = Date.now();
const raw = {
  id: "00000000-0000-0000-0000-000000000101",
  waybill: "WATCHCOST101", carrierName: "UPS", icon: "ups", status: "TRANSIT", statusText: "运输中",
  updatedAt: now - 5_000,
  tracks: [{ at: now - 5_000, time: new Date(now - 5_000).toISOString(), detail: "Synthetic scan" }],
};
writeDurableText(CACHE, JSON.stringify({ scope: activeWatchScope(), parcels: [raw] }));
assert.equal(loadWidgetSnapshot().rows[0]?.shipmentId, `watch:${raw.id}`);
assert.equal(readDurableTextCandidates(CACHE).length, 0, "an imported legacy cache is retired");

// The Watch page refresh cadence for background runtimes.
const committed = commitWatchSnapshot({ scope: activeWatchScope(), snapshot: "page-a",
  observedAtMs: Date.now(), shipments: [internationalShipmentSnapshot(raw, now)] });
assert.equal(watchRefreshDue(committed, Date.now()), false, "a page read within two minutes is not due");
assert.equal(watchRefreshDue(committed, Date.now() + 120_000), true);
assert.equal(watchRefreshDue({ ...committed, watchSource: undefined }), true);
assert.equal(visibleShipments(committed).length, 1);

// An unchanged page commit performs no state write; it records only its read time, outside the state
// (review item 8 (1), covered in international-watch-unchanged-read.test.ts).
const WATCH_READ_MARKER = "pipi_deliveries_watch_read_v1";
const stateKeys = () => [...memory.keys()].filter(key => key !== WATCH_READ_MARKER).length;
const writes = stateKeys();
const unchanged = commitWatchSnapshot({ scope: activeWatchScope(), snapshot: "page-a",
  observedAtMs: Date.now(), shipments: [internationalShipmentSnapshot(raw, now)] });
assert.equal(unchanged.revision, committed.revision, "an unchanged Watch page keeps the stored revision");
assert.equal(stateKeys(), writes);
assert.ok(memory.has(WATCH_READ_MARKER), "the unchanged read records its read-time marker");
console.log("Watch scope, legacy cache and unchanged pages avoid repeated Keychain, file and state work");
