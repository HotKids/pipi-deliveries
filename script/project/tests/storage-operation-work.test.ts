import assert from "node:assert/strict";
import { memory, NOW } from "./state-storage-mock.ts";
import { emptyState, loadState, saveState, refreshValueFingerprint } from "../services/storage.ts";

Date.now = () => NOW;
let state = saveState(emptyState(), NOW);
state = saveState(state, NOW);
loadState(NOW);
const originalHash = Crypto.sha256;
const payloadHashes = new Map<string, number>();
Crypto.sha256 = ((value: string) => {
  payloadHashes.set(value, (payloadHashes.get(value) || 0) + 1);
  return originalHash(value);
}) as typeof Crypto.sha256;
const payload = JSON.parse(String(memory.get("pipi_deliveries_state_v1"))).payload;
const read = loadState(NOW);
assert.equal(read.revision, state.revision);
assert.equal(payloadHashes.get(payload), 1,
  "unchanged normalized bytes reuse this load's validated envelope without a second native hash");

payloadHashes.clear();
const a = refreshValueFingerprint({ semantic: "TRANSIT", updatedAtMs: 1 });
const b = refreshValueFingerprint({ updatedAtMs: 2, semantic: "TRANSIT" });
assert.equal(a, b);
assert.notEqual(a, refreshValueFingerprint({ semantic: "DELIVERY" }));
assert.equal(payloadHashes.size, 0, "in-process value equality must not cross the native crypto bridge");
Crypto.sha256 = originalHash;

// A later call must read new bytes even when the advisory revision marker is unchanged.
const updated = saveState(read, NOW + 1);
memory.set("pipi_deliveries_state_revision_v1", read.revision);
assert.equal(loadState(NOW + 1).revision, updated.revision);
const forged = JSON.parse(String(memory.get("pipi_deliveries_state_v1")));
forged.payload = forged.payload.replace(`"revision":${updated.revision}`, '"revision":9999');
memory.set("pipi_deliveries_state_v1", JSON.stringify(forged));
assert.equal(loadState(NOW + 1).revision, updated.revision,
  "different bytes with the old checksum still fail integrity validation");
const repairedPayload = JSON.parse(String(memory.get("pipi_deliveries_state_v1"))).payload;
let failedHash = false;
Crypto.sha256 = ((value: string) => {
  if (value === repairedPayload && !failedHash) {
    failedHash = true;
    throw new Error("synthetic transient native hash failure");
  }
  return originalHash(value);
}) as typeof Crypto.sha256;
assert.equal(loadState(NOW + 1).revision, updated.revision,
  "a failed validation may retry another copy; only successful decodes are reusable");
Crypto.sha256 = originalHash;
console.log("storage operation-local validation and equality tests passed");

const writes = new Map<string, number>();
Crypto.sha256 = ((value: string) => {
  writes.set(value, (writes.get(value) || 0) + 1);
  return originalHash(value);
}) as typeof Crypto.sha256;
saveState(loadState(NOW + 1), NOW + 2);
const writtenPayload = JSON.parse(String(memory.get("pipi_deliveries_state_v1"))).payload;
assert.equal(writes.get(writtenPayload), 1,
  "save readback compares every physical copy to the exact encoded bytes without hashing those bytes again");
Crypto.sha256 = originalHash;
