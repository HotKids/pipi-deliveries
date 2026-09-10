import assert from "node:assert/strict";
import { memory, NOW, sha256 } from "./state-storage-mock.ts";
import {
  commitRefreshState, emptyState, loadState, removeShipment, saveState, stateLoadFailure,
} from "../services/storage.ts";

const keys = [
  "pipi_deliveries_state_v1", "pipi_deliveries_state_backup_v1",
  ...["a", "b"].flatMap(slot => ["", ".backup"].map(suffix =>
    `file:/group/pipi-deliveries/state-v3-${slot}.json${suffix}`)),
];
const damaged = JSON.stringify({
  schema: 3, checksum: "0".repeat(64),
  payload: JSON.stringify({
    ...emptyState(), revision: 22,
    pendingQueries: [{
      id: "interface5:AUDIT1234567890", source: "interface5", waybill: "AUDIT1234567890",
      phoneTail: "", courierCode: "ZTO", companyName: "synthetic",
      createdAtMs: NOW, lastAttemptAtMs: NOW, attempts: 1,
    }],
  }),
});
for (const key of keys) memory.set(key, damaged);
const before = keys.map(key => memory.get(key));
assert.throws(() => loadState(NOW), /本地快递数据读取失败/);
assert.equal(stateLoadFailure(), "read_failed");
assert.throws(() => saveState(emptyState(), NOW + 1), /本地快递数据读取失败/);
assert.throws(() => saveState(emptyState(), NOW + 2), /本地快递数据读取失败/);
assert.throws(() => removeShipment("synthetic", NOW + 3), /本地快递数据读取失败/);
assert.throws(() => commitRefreshState(emptyState(), emptyState(), "interface5", NOW + 4),
  /本地快递数据读取失败/);
assert.deepEqual(keys.map(key => memory.get(key)), before,
  "read and write failures must preserve every existing invalid copy");

// A valid older mirror remains usable when all durable slots are invalid.
memory.set("pipi_deliveries_state_backup_v1", {
  schema: 2, checksum: sha256(JSON.stringify(emptyState())), state: emptyState(),
});
assert.equal(loadState(NOW).shipments.length, 0);
assert.equal(stateLoadFailure(), null);
assert.doesNotThrow(() => saveState(emptyState(), NOW + 1));

memory.clear();
memory.set(keys[0], "{");
assert.throws(() => loadState(NOW), /本地快递数据读取失败/,
  "a malformed existing mirror is not an absent first-launch store");
memory.clear();
const originalGet = Storage.get;
Storage.get = () => { throw new Error("synthetic Storage read failure"); };
try {
  assert.throws(() => loadState(NOW), /本地快递数据读取失败/,
    "a failed legacy read must not be treated as an absent store");
} finally { Storage.get = originalGet; }
assert.equal(loadState(NOW).revision, 0, "an absent store remains a normal first launch");
assert.equal(stateLoadFailure(), null);
assert.equal(saveState(emptyState(), NOW + 1).revision, 1);
console.log("invalid existing state fails closed; recoverable and absent stores remain usable");
