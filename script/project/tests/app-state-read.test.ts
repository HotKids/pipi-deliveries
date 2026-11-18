import assert from "node:assert/strict";
import "./state-storage-mock";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import { SCRIPT_BINDING_SOURCE } from "../services/script-source";
import { loadAppState, loadStateSnapshot, upsertPendingQuery, upsertShipment } from "../services/storage";

const now = Date.now();
const eventAtMs = now - 60_000;
const timeText = new Date(eventAtMs).toISOString();
upsertShipment({
  identity: {
    id: "test-owner", bindingSource: SCRIPT_BINDING_SOURCE, sourceOwner: "account", sourceId: "test-owner",
    phoneTail: "", courierCode: "ZTO", companyName: "Test Carrier", manuallyAdded: false, createdAtMs: eventAtMs,
  },
  timeline: {
    provider: "test", waybill: "TEST000000", courierCode: "ZTO", companyName: "Test Carrier", semantic: "TRANSIT",
    latestTimeText: timeText, latestDetail: "In transit", successAtMs: now,
    tracks: [{ timeText, timeMs: eventAtMs, detail: "In transit", statusCode: "", raw: {} }],
  },
  updatedAtMs: now,
}, now);
const pending = (waybill: string, createdAtMs: number) => ({
  id: `${SCRIPT_BINDING_SOURCE}:${waybill}`, source: SCRIPT_BINDING_SOURCE, waybill,
  phoneTail: "", courierCode: "", rawCourierCode: "", companyName: "",
  createdAtMs, lastAttemptAtMs: createdAtMs, attempts: 1, route: null,
});
const first = pending("TEST123456", now - 1_000);
upsertPendingQuery(first, now);
const baseline = loadStateSnapshot(now);
assert.equal(loadStateSnapshot(now, baseline), baseline, "reuse a verified snapshot within the same operation");

const previousRead = FileManager.readAsStringSync;
let signalReading!: () => void;
let finishRead!: () => void;
const reading = new Promise<void>(resolve => { signalReading = resolve; });
const release = new Promise<void>(resolve => { finishRead = resolve; });
let asyncStateReads = 0;
let syncStateReads = 0;
FileManager.readAsString = async (path) => {
  const value = previousRead(path);
  if (path.endsWith("/state.json")) {
    asyncStateReads++;
    signalReading();
    await release;
  }
  return value;
};
FileManager.readAsStringSync = (path) => {
  if (path.endsWith("/state.json")) syncStateReads++;
  return previousRead(path);
};

const appRead = loadAppState();
assert.equal(loadAppState(), appRead, "overlapping app reads share one prefetch");
await reading;
const second = pending("TEST654321", now);
upsertPendingQuery(second, now + 1);
finishRead();
assert.equal((await appRead).pendingQueries.length, 2, "a commit during prefetch must beat the prefetched generation");
const current = loadStateSnapshot(now + 1, baseline);
assert.notEqual(current, baseline, "changed durable bytes invalidate the earlier operation snapshot");
assert.equal(current.state.pendingQueries.length, 2);

const previousAsync = asyncStateReads;
const previousSync = syncStateReads;
assert.equal((await loadAppState()).pendingQueries.length, 2);
assert.ok(asyncStateReads > previousAsync);
assert.equal(syncStateReads, previousSync, "an unchanged app bootstrap reads state blobs only with async native I/O");

const expired = loadStateSnapshot(first.createdAtMs + EXPRESS_POLICY.pendingQueries.ttlMs, current);
assert.deepEqual(expired.state.pendingQueries.map(({ id }) => id), [second.id], "an expiring row invalidates an exact-byte snapshot");
console.log("app state read tests passed");
