import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { activeWatchScope, internationalShipmentSnapshot } from "../services/international-records";
import { commitWatchSnapshot, removeShipment, visibleShipments } from "../services/storage";

// R5-NEW-11 ⑤ (fifth review, 2026-11-25). Identities are synthetic.

// 1. A Watch parcel's cloud metadata starts when its detail opens, beside the Watch page read, instead of after it.
//    A domestic parcel keeps its order: its page refresh first, then its fields and cloud metadata together.
const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
const start = page.indexOf("  async function finishDetailOpening(");
const end = page.indexOf("  async function copyWaybill()", start);
assert.ok(start >= 0 && end > start);
const opening = stripTypeScriptTypes(page.slice(start, end));

async function open(syncedInternational: boolean) {
  const events: string[] = [];
  let finishWatchRead!: (value: undefined) => void;
  const watchRead = new Promise<undefined>((resolve) => { finishWatchRead = resolve; });
  const shipment = { identity: { id: "watch:synthetic" }, timeline: { tracks: [] } };
  const finishDetailOpening = runInNewContext(`${opening}\nfinishDetailOpening`, {
    props: { persistedShipment: true }, shipment, syncedInternational,
    cloudLifecycle: "synthetic", shipmentLifecycleKey: () => "synthetic",
    refreshInFlightRef: { current: watchRead.then(() => { events.push("page read"); return undefined; }) },
    pullInFlightRef: { current: null }, refreshGenerationRef: { current: 1 },
    needsParcelDetailFields: () => false, readOwnerState: () => ({}),
    refreshCloudMetadata: async () => { events.push("cloud metadata"); },
    setImageDownloadScope: () => {}, imageScope: "synthetic",
    refreshProductImage: async () => { events.push("image"); },
    showShipment: () => {}, Promise,
  }) as (signal: AbortSignal) => Promise<void>;
  const opened = finishDetailOpening(new AbortController().signal);
  await new Promise(resolve => setImmediate(resolve));
  const beforeRead = [...events];
  finishWatchRead(undefined);
  await opened;
  return { beforeRead, events };
}

const watch = await open(true);
assert.deepEqual(watch.beforeRead, ["cloud metadata"], "a Watch's cloud metadata does not wait for its page read");
assert.deepEqual(watch.events, ["cloud metadata", "page read", "image"], "and is read once");
const domestic = await open(false);
assert.deepEqual(domestic.beforeRead, [], "a domestic parcel still waits for its own refresh");
assert.deepEqual(domestic.events, ["page read", "cloud metadata", "image"]);

// 2. Deleting a Watch row moves the Watch source past the deletion's own millisecond, so a page read in that same
//    millisecond cannot put the row back; a later changed page still does.
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
saveGatewayToken("SyntheticKey_811");
const scope = activeWatchScope();
assert.ok(scope);
const realNow = Date.now;
const T = realNow();
const at = (ms: number) => { Date.now = () => ms; };
const parcel = (scanAt: number, detail: string) => ({
  id: "00000000-0000-0000-0000-000000000811", waybill: "WATCHDEL811", carrierName: "UPS", icon: "ups",
  status: "TRANSIT", statusText: "运输中", updatedAt: scanAt, tracks: [{ at: scanAt, time: new Date(scanAt).toISOString(), detail }],
});
const snapshot = (name: string, observedAtMs: number, row: ReturnType<typeof parcel>) => ({
  scope, snapshot: name.repeat(64), observedAtMs, shipments: [internationalShipmentSnapshot(row, observedAtMs)],
});
const id = "watch:00000000-0000-0000-0000-000000000811";
try {
  at(T);
  assert.equal(visibleShipments(commitWatchSnapshot(snapshot("a", T, parcel(T - 60_000, "Synthetic scan")))).length, 1);
  at(T + 1_000);
  const removed = removeShipment(id, T + 1_000);
  assert.equal(visibleShipments(removed).length, 0);
  assert.equal(removed.watchSource!.observedAtMs, T, "deleting a single Watch row preserves watchSource.observedAtMs");
  const sameMs = commitWatchSnapshot(snapshot("b", T + 1_000, parcel(T + 500, "Synthetic same-ms scan")));
  assert.equal(visibleShipments(sameMs).length, 0, "a page read in the deletion's millisecond does not restore it");
  at(T + 2_000);
  const unchangedScan = commitWatchSnapshot(snapshot("c", T + 2_000, parcel(T - 60_000, "Synthetic scan")));
  assert.equal(visibleShipments(unchangedScan).length, 0, "an unchanged scan timestamp does not restore a deleted Watch");
  const later = commitWatchSnapshot(snapshot("d", T + 2_000, parcel(T + 1_500, "Synthetic later scan")));
  assert.deepEqual(visibleShipments(later).map(row => row.identity.id), [id], "a strictly newer scan brings it back");
} finally {
  Date.now = realNow;
}

console.log("Watch details read cloud metadata at once; a deletion fences its own millisecond");
