import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { activeWatchScope, internationalShipmentSnapshot } from "../services/international-records";
import { commitWatchSnapshot, refreshDueWatchShipments, visibleShipments } from "../services/storage";

// G-HIGH-10 (2026-11-20 review): the widget, App Intent and Shortcut refreshes share one Watch follow-up. It reads the
// page only when due and with more than two seconds left, returns the newer state, and turns a failure into nothing.
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
saveGatewayToken("SyntheticKey_701");
const scope = activeWatchScope();
assert.ok(scope);
const now = Date.now();
const raw = {
  id: "00000000-0000-4000-8000-000000000701", waybill: "WATCHBG701", carrierName: "UPS", icon: "ups",
  status: "TRANSIT", statusText: "运输中", updatedAt: now - 60_000,
  tracks: [{ at: now - 60_000, time: new Date(now - 60_000).toISOString(), detail: "Synthetic scan" }],
};
const stored = commitWatchSnapshot({ scope, snapshot: "a".repeat(64), observedAtMs: now - 10 * 60_000,
  shipments: [internationalShipmentSnapshot(raw, now)] });
let reads = 0;
let answer: () => unknown = () => ({ ok: true, snapshot: "b".repeat(64), nextAfter: null,
  parcels: [{ ...raw, status: "DELIVERY", statusText: "派送中", updatedAt: now }] });
globalThis.fetch = (async (url: string) => {
  assert.equal(new URL(url).pathname, "/api/cloud-records/international-shipments");
  reads++;
  const body = answer();
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}) as typeof fetch;

assert.equal(await refreshDueWatchShipments(stored, 2_000), undefined, "no read with two seconds or less left");
assert.equal(reads, 0);
const next = await refreshDueWatchShipments(stored, 10_000);
assert.equal(reads, 1);
assert.ok(next && next.revision > stored.revision);
assert.equal(visibleShipments(next).find(row => row.identity.id === `watch:${raw.id}`)?.timeline.semantic, "DELIVERY");
assert.equal(await refreshDueWatchShipments(next, 10_000), undefined, "a page read within two minutes is not due");
assert.equal(reads, 1);

const later = { ...next, watchSource: { ...next.watchSource!, observedAtMs: now - 10 * 60_000 } };
answer = () => { throw new Error("Synthetic transport failure"); };
assert.equal(await refreshDueWatchShipments(later, 10_000), undefined, "a failed read leaves the domestic result");
console.log("background runtimes share one Watch follow-up");
