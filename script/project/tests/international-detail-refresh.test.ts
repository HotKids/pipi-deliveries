import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { activeWatchScope, internationalShipmentSnapshot } from "../services/international-records";
import { commitWatchSnapshot, visibleShipments } from "../services/storage";
import { refreshShipmentById } from "../services/sync";

// A detail pull on an international Watch parcel reads only the Bot-owned Watch projection. It never
// enters the domestic query chain (providers, account sync, paid fallback), whatever options it carries.
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
saveGatewayToken("SyntheticKey_301");
const scope = activeWatchScope();
assert.ok(scope);
const now = Date.now();
const raw = {
  id: "00000000-0000-0000-0000-000000000301", waybill: "WATCHPULL301", carrierName: "UPS", icon: "ups",
  status: "TRANSIT", statusText: "运输中", updatedAt: now - 60_000,
  tracks: [{ at: now - 60_000, time: new Date(now - 60_000).toISOString(), detail: "Synthetic scan" }],
};
const stored = commitWatchSnapshot({ scope, snapshot: "a".repeat(64), observedAtMs: now - 30_000,
  shipments: [internationalShipmentSnapshot(raw, now)] });
const id = visibleShipments(stored)[0]!.identity.id;
const updated = { ...raw, status: "DELIVERY", statusText: "派送中", updatedAt: now - 1_000,
  tracks: [{ at: now - 1_000, time: new Date(now - 1_000).toISOString(), detail: "Synthetic delivery scan" },
    ...raw.tracks] };

const requests: string[] = [];
globalThis.fetch = (async (url: string) => {
  const { pathname } = new URL(url);
  requests.push(pathname);
  if (pathname === "/api/cloud-records/international-shipments") {
    return { ok: true, status: 200, text: async () => JSON.stringify({
      ok: true, snapshot: "b".repeat(64), parcels: [updated], nextAfter: null }) };
  }
  return { ok: false, status: 503, text: async () => "Synthetic offline" };
}) as typeof fetch;

const result = await refreshShipmentById(id, {
  forceManualRefresh: true, forceAccountOrderProjection: true, includeKdniaoFallback: true, trigger: "detail_pull",
});
assert.deepEqual(requests, ["/api/cloud-records/international-shipments"],
  "the Watch detail pull reads only its own projection");
assert.equal(result.shipment.identity.id, id);
assert.equal(result.querySucceeded, true);
assert.equal(result.refreshed, true);
assert.equal(result.shipment.timeline.semantic, "DELIVERY");

// A failed Watch read keeps the stored row and reports the failure without any other request.
requests.length = 0;
globalThis.fetch = (async (url: string) => {
  requests.push(new URL(url).pathname);
  return { ok: false, status: 503, text: async () => "Synthetic offline" };
}) as typeof fetch;
const failed = await refreshShipmentById(id, { forceManualRefresh: true, trigger: "detail_pull" });
assert.deepEqual(requests, ["/api/cloud-records/international-shipments"]);
assert.equal(failed.shipment.identity.id, id);
assert.equal(failed.querySucceeded, false);
assert.equal(failed.refreshed, false);
console.log("International detail refresh reads only the Watch projection");
