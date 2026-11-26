import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { refreshCloudPddParcels } from "../services/sync";
import { saveGatewayToken, removeGatewayToken } from "../services/credentials";
import { clearDiagnostics, readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { setProjectionSceneActive } from "../services/projection-viewport";
import type { AppState } from "../models";

// 立即同步 and an Access Key change read the cloud PDD parcel list once outside a full refresh (owner 2026-11-21:
// 加上（推荐）). The read and its commit are the full refresh's own owner: the same route, merge and record; no
// account list, detail or other request is made, and calls for the same key share one read.

const NOW = Date.UTC(2026, 10, 21, 6);
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({ toHexString: () => createHmac("sha256", key).update(value).digest("hex") }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined }, Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
});

const WAYBILL = "YT9990000000099";
const paths: string[] = [];
let hold: Promise<void> | undefined;
globalThis.fetch = (async (url: string) => {
  const path = new URL(url).pathname;
  paths.push(path);
  if (path === "/api/cloud-records/pdd-shipments") {
    if (hold) await hold;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, nextAfter: null,
      parcels: [{ waybill: WAYBILL, anchorAt: NOW - 3_600_000, carrierCode: "YTO", phone4: "0000" }] }) };
  }
  if (path === "/api/express/timeline/source") {
    return { ok: true, status: 200, text: async () => JSON.stringify({
      code: 200,
      value: {
        nu: WAYBILL,
        com: "YTO",
        state: "0",
        data: [{ time: "2026-11-21 13:30:00", context: "包裹正在运输中" }],
      },
    }) };
  }
  assert.fail(`unexpected request path: ${path}`);
}) as typeof fetch;

memory.clear();
setDiagnosticsEnabled(true);
const observed = saveState({ ...emptyState() }, NOW);
const published: AppState[] = [];
const publish = (state: AppState) => published.push(state);

// Without a saved key nothing is read.
await refreshCloudPddParcels(observed, publish);
assert.deepEqual(paths, []);

saveGatewayToken("AbCdEfGh_123-456");
// Out of the foreground nothing is read either, as in the refresh's own pass.
setProjectionSceneActive(false);
await refreshCloudPddParcels(observed, publish);
assert.deepEqual(paths, []);
setProjectionSceneActive(true);

// Two calls for the same key share one read; the parcel is merged once and published.
clearDiagnostics();
let open!: () => void;
hold = new Promise<void>(resolve => { open = resolve; });
const first = refreshCloudPddParcels(observed, publish);
const second = refreshCloudPddParcels(observed, publish);
assert.equal(first, second, "a running read is shared");
for (let tick = 0; tick < 50 && !paths.length; tick++) await new Promise(resolve => setTimeout(resolve, 1));
assert.deepEqual(paths, ["/api/cloud-records/pdd-shipments"], "one request is under way");
open();
await first;
hold = undefined;
assert.deepEqual(paths, ["/api/cloud-records/pdd-shipments", "/api/express/timeline/source"]);
const merged = loadState(NOW).shipments.find(row => row.pddCloudOrigin?.waybill === WAYBILL);
assert.ok(merged, "the cloud PDD parcel is in the list");
assert.equal(merged.timeline.provider, "v6_query", "newly pulled pending cloud PDD parcel is enriched immediately");
assert.equal(published.length, 2);
assert.equal(published[1].revision, loadState(NOW).revision);
// D188: the cloud PDD read is a cloud.sync line of the pdd domain.
const pddLines = () => readDiagnostics().filter(entry => entry.event.startsWith("cloud.sync.") && entry.details.domain === "pdd");
const record = pddLines().find(entry => entry.event === "cloud.sync.completed");
assert.equal(record?.details.result, "committed");
assert.equal(record?.details.records, 1);
assert.equal(record?.details.sourceProvider, "pinduoduo");

// A later call reads again; an unchanged list commits and records nothing.
clearDiagnostics();
await refreshCloudPddParcels(loadState(NOW), publish);
assert.equal(paths.length, 3);
assert.equal(published.length, 2);
assert.deepEqual(pddLines(), []);

// A failed read is recorded as unavailable and never rejects.
globalThis.fetch = (async () => { throw new Error("synthetic network failure"); }) as typeof fetch;
await refreshCloudPddParcels(loadState(NOW), publish);
assert.equal(pddLines().find(entry => entry.event === "cloud.sync.completed")?.details.result, "unavailable");

// After the key is removed nothing is read.
removeGatewayToken();
globalThis.fetch = (async () => assert.fail("no request without a key")) as typeof fetch;
await refreshCloudPddParcels(loadState(NOW), publish);
console.log("cloud PDD pull for 立即同步 checks passed");
