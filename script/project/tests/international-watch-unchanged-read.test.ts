import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { activeWatchScope, internationalShipmentSnapshot } from "../services/international-records";
import { commitWatchSnapshot, loadState, refreshStoredWatchShipments, removeShipment, visibleShipments,
  watchRefreshDue } from "../services/storage";

// Review item 8 (1): an unchanged Watch page leaves the shared state untouched, so its read time is kept
// in a small marker outside the state. A background runtime treats the later of that marker and the
// last changed page as its last read. Without it every widget run re-read the page two minutes after
// the last *changed* page.
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
saveGatewayToken("SyntheticKey_801");
const scope = activeWatchScope();
assert.ok(scope);
const T = Date.now();
const realNow = Date.now;
const at = (ms: number) => { Date.now = () => ms; };
const parcel = (id: string, scanAt: number, detail = "Synthetic scan") => ({
  id, waybill: `WATCHREAD${id.slice(-3)}`, carrierName: "UPS", icon: "ups", status: "TRANSIT", statusText: "运输中",
  updatedAt: scanAt, tracks: [{ at: scanAt, time: new Date(scanAt).toISOString(), detail }],
});
const X = parcel("00000000-0000-0000-0000-000000000801", T - 60_000);
const Y = parcel("00000000-0000-0000-0000-000000000802", T - 60_000);
const pageA = "a".repeat(64);
const page = (snapshot: string, observedAtMs: number, parcels: ReturnType<typeof parcel>[]) => ({
  scope, snapshot, observedAtMs, shipments: parcels.map(row => internationalShipmentSnapshot(row, observedAtMs)),
});
const MARKER = "pipi_deliveries_watch_read_v1";

const committed = commitWatchSnapshot(page(pageA, T, [X, Y]));
assert.equal(visibleShipments(committed).length, 2);
assert.equal(watchRefreshDue(committed, T + 60_000), false);

at(T + 150_000);
// The first load after the initial commit mirrors the (empty) binding backup once; that one-off load
// work is not part of the Watch read, so it happens before the comparison baseline is taken.
loadState(T + 150_000);
const values = new Map([...memory].map(([key, value]) => [key, JSON.stringify(value)]));
const unchanged = commitWatchSnapshot(page(pageA, T + 150_000, [X, Y]));
assert.equal(unchanged.revision, committed.revision, "the identical page keeps the stored revision");
assert.equal(unchanged.watchSource?.observedAtMs, T, "the stored state keeps the last changed page");
assert.deepEqual([...memory].filter(([key, value]) => values.get(key) !== JSON.stringify(value)).map(([key]) => key),
  [MARKER], "the unchanged read writes only its marker, outside the state");
assert.equal(watchRefreshDue(unchanged, T + 210_000), false, "an unchanged read 60 seconds ago is not due");
assert.equal(watchRefreshDue(unchanged, T + 270_000), true, "an unchanged read two minutes ago is due");
assert.equal(watchRefreshDue(loadState(T + 210_000), T + 210_000), false,
  "another runtime reading the shared state sees the same marker");
assert.equal(watchRefreshDue({ ...unchanged, watchSource: undefined }, T + 210_000), true,
  "the marker never stands in for a missing Watch source");
assert.equal(watchRefreshDue({ ...unchanged, watchSource: { ...unchanged.watchSource!, scope: "another-scope" } },
  T + 210_000), true, "a marker from another scope does not apply");
// A stale read never moves the marker back.
commitWatchSnapshot(page(pageA, T + 100_000, [X, Y]));
assert.equal(watchRefreshDue(unchanged, T + 260_000), false);

// The same runtime's cached unchanged result is an unchanged read too.
const requests: string[] = [];
globalThis.fetch = (async (url: string) => {
  requests.push(new URL(url).pathname);
  return { ok: true, status: 200, text: async () => JSON.stringify({
    ok: true, snapshot: pageA, parcels: [X, Y], nextAfter: null }) };
}) as typeof fetch;
at(T + 400_000);
assert.equal(watchRefreshDue(loadState(T + 400_000), T + 400_000), true);
assert.equal((await refreshStoredWatchShipments())?.revision, committed.revision);
at(T + 500_000);
assert.equal((await refreshStoredWatchShipments())?.revision, committed.revision);
assert.equal(requests.length, 2);
assert.equal(watchRefreshDue(loadState(T + 560_000), T + 560_000), false,
  "the cached unchanged read at T+500s also records its time");
assert.equal(watchRefreshDue(loadState(T + 620_000), T + 620_000), true);

// Review item 8 (3), owner 2026-11-21 「云端没变就不重加」: an unchanged cloud snapshot leaves the local
// list alone, so a parcel the user swiped away stays away; a changed snapshot still brings it back,
// like an ordinary parcel's automatic reimport after deletion.
at(T + 700_000);
const removed = removeShipment(`watch:${X.id}`);
assert.deepEqual(visibleShipments(removed).map(row => row.identity.id), [`watch:${Y.id}`]);
at(T + 800_000);
const again = commitWatchSnapshot(page(pageA, T + 800_000, [X, Y]));
assert.deepEqual(visibleShipments(again).map(row => row.identity.id), [`watch:${Y.id}`],
  "the unchanged cloud snapshot does not put the deleted parcel back");
assert.equal(again.revision, removed.revision, "and does not write the state");
assert.equal(watchRefreshDue(again, T + 860_000), false, "the read still counts for the throttle");
requests.length = 0;
at(T + 900_000);
const cached = await refreshStoredWatchShipments();
assert.equal(requests.length, 1);
assert.deepEqual(visibleShipments(cached!).map(row => row.identity.id), [`watch:${Y.id}`],
  "nor does a later unchanged read in another path");
assert.deepEqual(visibleShipments(loadState()).map(row => row.identity.id), [`watch:${Y.id}`]);

const changedX = parcel(X.id, T + 850_000, "Synthetic new scan");
at(T + 1_000_000);
const changed = commitWatchSnapshot(page("b".repeat(64), T + 1_000_000, [changedX, Y]));
assert.deepEqual(visibleShipments(changed).map(row => row.identity.id).sort(), [`watch:${X.id}`, `watch:${Y.id}`],
  "a changed cloud snapshot brings the deleted parcel back");
assert.equal(visibleShipments(changed).find(row => row.identity.id === `watch:${X.id}`)?.timeline.latestDetail,
  "Synthetic new scan");
assert.equal(changed.watchSource?.observedAtMs, T + 1_000_000);
Date.now = realNow;
console.log("Unchanged Watch reads keep the throttle and the local list; changed pages still apply");
