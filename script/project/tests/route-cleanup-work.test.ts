import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, saveState, commitRefreshState, pruneRoutesForState } from "../services/storage";
import { pruneAccountAppRoutes } from "../services/routes";
import { publishDeferredRoutesForTesting } from "../services/sync";

Date.now = () => NOW;
const routesKey = "pipi_deliveries_routes_v1";
const appRoutesKey = "pipi_deliveries_account_app_routes_v1";
const record = { waybill: "SF1234560000", companyCode: "SF", name: "Carrier",
  provider: "ShunFeng", phone: "13800001234", channel: "account" as const };

test("an empty App-route cache does not hash every account row", () => {
  memory.clear();
  const hash = Crypto.sha256;
  let calls = 0;
  Crypto.sha256 = ((value: any) => { calls++; return hash(value); }) as typeof hash;
  try { pruneAccountAppRoutes(Array.from({length: 30}, () => record)); }
  finally { Crypto.sha256 = hash; }
  assert.equal(calls, 0);
});

test("one successful commit and empty publication prune once; a later operation reads again", () => {
  memory.clear();
  const base = saveState(emptyState(), NOW);
  const candidate = { ...base, pendingQueries: [{ id: "pending-test", source: "interface5" as const,
    waybill: "SF1234560000", courierCode: "SF", companyName: "Carrier", createdAtMs: NOW,
    lastAttemptAtMs: 0, attempts: 0 }] };
  const get = Keychain.get;
  let reads = 0;
  Keychain.get = key => { if (key === routesKey) reads++; return get(key); };
  try {
    const commit = commitRefreshState(base, candidate, "interface5", NOW);
    assert.equal(commit.applied, true);
    const afterCommit = reads;
    publishDeferredRoutesForTesting(commit.state, new Map(), NOW, commit);
    assert.equal(reads, afterCommit, "publication must not repeat successful cleanup");
    memory.set(`keychain:${routesKey}`, JSON.stringify({ deleted: {
      url: "https://page.cainiao.com/detail?synthetic=deleted", source: "interface5", updatedAtMs: NOW,
    } }));
    publishDeferredRoutesForTesting(commit.state, new Map(), NOW);
    assert.equal(reads, afterCommit + 1, "a separate operation cannot reuse an old cleanup receipt");
    assert.deepEqual(JSON.parse(String(memory.get(`keychain:${routesKey}`))), {});
  } finally { Keychain.get = get; }
});

test("failed cleanup retries at publication without failing the durable business commit", () => {
  for (const phase of ["read", "write"] as const) {
    memory.clear();
    const base = saveState(emptyState(), NOW);
    memory.set(`keychain:${routesKey}`, JSON.stringify({ deleted: {
      url: "https://page.cainiao.com/detail?synthetic=retry", source: "interface5", updatedAtMs: NOW,
    } }));
    const get = Keychain.get, set = Keychain.set;
    let failed = false;
    Keychain.get = key => {
      if (phase === "read" && key === routesKey && !failed) { failed = true; throw new Error("synthetic read failure"); }
      return get(key);
    };
    Keychain.set = (key, value) => {
      if (phase === "write" && key === routesKey && !failed) { failed = true; return false; }
      return set(key, value);
    };
    try {
      const commit = commitRefreshState(base, { ...base, pendingQueries: [{
        id: "pending-retry", source: "interface5", waybill: "SF1234560000", courierCode: "SF",
        companyName: "Carrier", createdAtMs: NOW, lastAttemptAtMs: 0, attempts: 0,
      }] }, "interface5", NOW);
      assert.equal(commit.applied, true);
      assert.ok(failed);
      publishDeferredRoutesForTesting(commit.state, new Map(), NOW, commit);
      assert.deepEqual(JSON.parse(String(memory.get(`keychain:${routesKey}`))), {});
    } finally { Keychain.get = get; Keychain.set = set; }
  }
});

test("App-route retention still follows the exact tuple and current binding", () => {
  memory.clear();
  const key = Crypto.sha256(Data.fromString(JSON.stringify([
    "interface5", "shunfeng", record.waybill, record.companyCode, record.phone,
  ]))!).toHexString().toLowerCase();
  memory.set(`keychain:${appRoutesKey}`, JSON.stringify({ [key]: { targets: [], updatedAtMs: NOW } }));
  pruneAccountAppRoutes([record]);
  assert.ok(JSON.parse(String(memory.get(`keychain:${appRoutesKey}`)))[key]);
  pruneAccountAppRoutes([{ ...record, phone: "13900001234" }]);
  assert.deepEqual(JSON.parse(String(memory.get(`keychain:${appRoutesKey}`))), {});
  memory.set(`keychain:${appRoutesKey}`, JSON.stringify({ [key]: { targets: [], updatedAtMs: NOW } }));
  pruneRoutesForState(emptyState(), NOW);
  assert.deepEqual(JSON.parse(String(memory.get(`keychain:${appRoutesKey}`))), {});
});
