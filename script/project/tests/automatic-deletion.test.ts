import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { memory, NOW, sha256 } from "./state-storage-mock";
import type { Shipment, TrackNode } from "../models";
import { emptyState, loadState, saveState, removeShipment, upsertShipment, commitRefreshState } from "../services/storage";
import { AutomaticDeletionStateError, automaticDeletionAllows } from "../services/automatic-deletion";
import { parseAccountSyncResponse } from "../services/account-parser";
import { fetchAccountParcels, parcelToShipment } from "../services/account-sync";
import { refreshAllShipments } from "../services/sync";
import { saveGatewayToken } from "../services/credentials";
import { seedRecognizedCarriers } from "./carrier-recognition-seed";
import { loadEnhancementIdentity } from "../services/enhanced-account";
import { publishSharedData, sharedStateText, withSharedFileTransaction } from "../services/shared-file-transaction";

const actualNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = actualNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({ toHexString: () => createHmac("sha256", key).update(value).digest("hex") }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, { UUID: { string: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } });

const PHONE = "13800001234";
const initialAt = NOW - 600_000;
function node(at: number | null, detail = "Synthetic accepted event"): TrackNode {
  return { timeMs: at, timeText: at == null ? "" : new Date(at + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
    detail, statusCode: "", raw: {} };
}
function row(waybill = "YT123456789001", tracks = [node(initialAt)]): Shipment {
  const timeline = { provider: "interface5", waybill, courierCode: "YTO", companyName: "Carrier",
    semantic: "TRANSIT" as const, structuredStatus: true, statusEventAtMs: initialAt,
    latestDetail: tracks[0]?.detail || "", latestTimeText: tracks[0]?.timeText || "", successAtMs: NOW, tracks };
  return { identity: { id: `interface5:account:${waybill}`, sourceId: waybill,
    bindingSource: "interface5", sourceProvider: "CaiNiao", sourceOwner: "interface5:parcel",
    manuallyAdded: false, courierCode: "YTO", rawCourierCode: "YTO", companyName: "Carrier",
    phone: PHONE, phoneTail: "1234", createdAtMs: NOW - 86_400_000 },
    timeline, sourceTimeline: timeline, manualTimelines: [], updatedAtMs: NOW,
    accountRecord: { waybill, provider: "CaiNiao", companyCode: "YTO", phone: PHONE } };
}
function seed(items = [row()]) {
  memory.clear();
  return saveState({ ...emptyState(), shipments: items,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000 }] }, NOW);
}
function deleted(tracks?: TrackNode[]) {
  const before = seed([row(undefined, tracks)]);
  removeShipment(before.shipments[0].identity.id, NOW + 1);
  return before;
}

test("deleted automatic parcel stays absent across reload and the unchanged account feed", () => {
  deleted();
  assert.equal(loadState(NOW + 2).shipments.length, 0);
  upsertShipment({ ...row(), updatedAtMs: NOW + 2 }, NOW + 2);
  assert.equal(loadState(NOW + 2).shipments.length, 0);
});

test("new accepted timed trajectory restores and consumes the automatic deletion", () => {
  deleted();
  upsertShipment(row(undefined, [node(NOW - 60_000, "Synthetic newer progress")]), NOW + 2);
  const restored = loadState(NOW + 2);
  assert.equal(restored.shipments.length, 1);
  assert.equal(restored.automaticDeletionFences?.length || 0, 0);
});

test("untimed text, old history and duplicate clock shifts do not restore a deleted parcel", () => {
  for (const tracks of [[node(null, "Different untimed prose")],
    [node(initialAt - 1_000, "Older historical node")],
    [node(initialAt + 60_000, "Synthetic accepted event。")],
    [node(NOW + 60_000, "Future clock is not progress")],
    [node(initialAt), node(initialAt - 60_000, "Earlier history fill")]]) {
    deleted();
    upsertShipment(row(undefined, tracks), NOW + 2);
    assert.equal(loadState(NOW + 2).shipments.length, 0);
  }
});

test("borrowed manual history cannot release an unchanged automatic owner", () => {
  deleted();
  const incoming = row();
  incoming.manualTimelines = [{ ...incoming.timeline, provider: "v6_query",
    tracks: [node(NOW - 60_000, "New manual provider event")] }];
  upsertShipment(incoming, NOW + 2);
  assert.equal(loadState(NOW + 2).shipments.length, 0);
});

test("provider-tagged manual nodes grafted into the account feed cannot release a deletion", () => {
  for (const provider of ["kdniao", "jd_h5", "v6_query"]) {
    deleted();
    const graft = { ...node(NOW - 60_000, "Synthetic newer external provider event"), raw: { _pipiStatusSource: provider } };
    upsertShipment(row(undefined, [node(initialAt), graft]), NOW + 2);
    assert.equal(loadState(NOW + 2).shipments.length, 0, provider);
    assert.equal(loadState(NOW + 2).automaticDeletionFences?.length, 1);
  }
});

test("an original order-only deletion follows only its own later projection", () => {
  const order = row("SYNTHETICORDER001");
  order.identity.accountOrder = true;
  const before = seed([order]);
  removeShipment(order.identity.id, NOW + 1);
  const projected = row(undefined, [node(NOW - 60_000, "Projected new event")]);
  projected.identity = { ...projected.identity, id: order.identity.id, accountOrder: true,
    sourceId: order.identity.sourceId, projectedWaybill: projected.identity.sourceId };
  const state = loadState(NOW + 2);
  const committed = commitRefreshState(state, { ...state, shipments: [projected] }, "interface5", NOW + 2);
  assert.equal(committed.state.shipments.length, 1);
  assert.equal(committed.state.automaticDeletionFences?.length || 0, 0);
  assert.notEqual(before.shipments[0].identity.id, row().identity.id);
});

test("a rebound account response cannot restore or consume the deletion", () => {
  deleted();
  const before = loadState(NOW + 2);
  saveState({ ...before, bindings: [{ ...before.bindings[0], boundAtMs: NOW + 2 }] }, NOW + 2);
  const incoming = row(undefined, [node(NOW - 60_000, "Progress from the replaced binding")]);
  const result = commitRefreshState(before, { ...before, shipments: [incoming] }, "interface5", NOW + 3);
  assert.equal(result.state.shipments.length, 0);
  assert.equal(result.state.automaticDeletionFences?.length, 1);
  assert.equal(automaticDeletionAllows(loadState(NOW + 3), incoming, NOW + 3, false, before.bindings), false);
});

test("deletion and its fence fail atomically when the shared journal cannot be written", () => {
  const before = seed();
  const originalWrite = FileManager.writeAsStringSync;
  FileManager.writeAsStringSync = () => { throw new Error("Synthetic required write failure"); };
  try { assert.throws(() => removeShipment(before.shipments[0].identity.id, NOW + 1)); }
  finally { FileManager.writeAsStringSync = originalWrite; }
  const after = loadState(NOW + 2);
  assert.deepEqual(after.shipments.map(item => item.identity.id), before.shipments.map(item => item.identity.id));
  assert.equal(after.automaticDeletionFences?.length || 0, 0);
});

test("damaged required fences cannot fall back to an older state or be silently discarded", () => {
  for (const damage of ["collection", "key", "nodes"] as const) {
    deleted();
    const current = loadState(NOW + 2);
    const [fence] = current.automaticDeletionFences!;
    const invalid = damage === "collection" ? {} : [damage === "key" ? { ...fence, key: "invalid" }
      : { ...fence, nodes: [{ ...fence.nodes[0], atMs: "invalid" }] }];
    const payload = JSON.stringify({ ...current, revision: current.revision + 1, automaticDeletionFences: invalid });
    const encoded = JSON.stringify({ schema: 3, checksum: sha256(payload), payload });
    withSharedFileTransaction(() => publishSharedData({}, encoded));
    assert.throws(() => loadState(NOW + 3), AutomaticDeletionStateError);
    assert.throws(() => saveState(emptyState(), NOW + 3), AutomaticDeletionStateError);
    assert.equal(sharedStateText(), encoded, "failed recovery must preserve the authoritative required decision bytes");
  }
});

test("a stale snapshot cannot resurrect a consumed fence or weaken a later deletion", () => {
  deleted();
  const stale = loadState(NOW + 2);
  const progressed = row(undefined, [node(NOW - 60_000, "First new progression")]);
  upsertShipment(progressed, NOW + 3);
  const restored = loadState(NOW + 3);
  saveState({ ...stale, shipments: restored.shipments }, NOW + 4);
  assert.equal(loadState(NOW + 4).automaticDeletionFences?.length || 0, 0);
  removeShipment(progressed.identity.id, NOW + 5);
  const latestFence = loadState(NOW + 5).automaticDeletionFences;
  saveState({ ...stale, shipments: [row()] }, NOW + 6);
  assert.equal(loadState(NOW + 6).shipments.length, 0);
  assert.deepEqual(loadState(NOW + 6).automaticDeletionFences, latestFence);
});

test("the real account list filters deleted owners before enhancement and per-parcel carrier I/O", async () => {
  const response = { code: 0, data: { expressList: [{ mailNo: "3650000000000001", cpCode: "JDKD",
    name: "京东商品快递", provider: "JingDong", stateNum: 104, phone: PHONE,
    details: [{ time: node(initialAt).timeText, desc: "Synthetic order event" }] },
    { mailNo: "ZZ123456789001", cpCode: "SYNTHETICUNKNOWN", name: "Synthetic unknown carrier",
      provider: "CaiNiao", stateNum: 104, phone: PHONE,
      details: [{ time: node(initialAt).timeText, desc: "Synthetic waybill event" }] }] } };
  const shipments = parseAccountSyncResponse("interface5", response).map(parcel => parcelToShipment(parcel, [PHONE], NOW)!);
  const state = seed(shipments);
  saveState({ ...state, bindings: [{ ...state.bindings[0], enhancedMode: true, enhancedAtMs: NOW - 1_000 }] }, NOW);
  loadEnhancementIdentity();
  for (const shipment of shipments) removeShipment(shipment.identity.id, NOW + 1);
  saveGatewayToken("AbCdEfGh_123-456");
  const paths: string[] = [];
  const actualFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    paths.push(path);
    assert.ok(["/api/express/carriers", "/api/express/accounts/sync"].includes(path),
      "deleted packets must not reach enhancement or per-parcel carrier providers");
    return { ok: true, status: 200, text: async () => JSON.stringify(path === "/api/express/carriers" ? {} : response) };
  }) as typeof fetch;
  try {
    const refreshed = await refreshAllShipments("interface5", { accountListOnly: true });
    assert.equal(refreshed.accountListUpdated, true, "the normal account path must complete rather than hide an error");
    assert.deepEqual(paths.filter(path => path !== "/api/express/carriers"), ["/api/express/accounts/sync"]);
    assert.equal(loadState(NOW + 2).shipments.length, 0);
    assert.equal(loadState(NOW + 2).automaticDeletionFences?.length, 2);
  } finally { globalThis.fetch = actualFetch; }
});

test("filtering a fresh parcel preserves the separate retained-enhancement result partition", async () => {
  const response = { code: 0, data: { expressList: [{ mailNo: "YT123456789001", cpCode: "YTO",
    name: "Carrier", provider: "CaiNiao", stateNum: 104, phone: PHONE,
    details: [{ time: node(initialAt).timeText, desc: "Synthetic event" }] }] } };
  const cached = row("YT123456789002");
  cached.identity = { ...cached.identity, accountOrder: true, sourceProvider: "JingDong", enhancedMode: true,
    sourceId: "3650000000000002", orderId: "3650000000000002", projectedWaybill: "YT123456789002" };
  const state = seed([cached]);
  saveState({ ...state, bindings: [{ ...state.bindings[0], enhancedMode: true, enhancedAtMs: NOW - 1_000 }] }, NOW);
  seedRecognizedCarriers({ YT123456789002: "YTO" }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  const actualFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(response) })) as typeof fetch;
  try {
    const state = loadState(NOW);
    const result = await fetchAccountParcels("interface5", state.bindings, undefined,
      undefined, undefined, state.shipments, {}, parcel => parcel.ownerId === cached.identity.sourceId);
    assert.equal(result.parcels.length, 0);
    assert.deepEqual(result.cachedEnhancements?.map(parcel => parcel.ownerId), [cached.identity.sourceId]);
    assert.equal(result.rawRecords, 1);
  } finally { globalThis.fetch = actualFetch; }
});

test("a timed event arriving during the account request restores in that same accepted round", async () => {
  const response = (at: number, detail: string) => ({ code: 0, data: { expressList: [{ mailNo: "YT123456789001", cpCode: "YTO",
    name: "Carrier", provider: "CaiNiao", stateNum: 104, phone: PHONE,
    details: [{ time: node(at).timeText, desc: detail }] }] } });
  const original = parcelToShipment(parseAccountSyncResponse("interface5", response(initialAt, "Original event"))[0], [PHONE], NOW)!;
  seed([original]);
  removeShipment(original.identity.id, NOW);
  seedRecognizedCarriers({ YT123456789001: "YTO" }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  let clock = NOW;
  Date.now = () => clock;
  const actualFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    assert.ok(["/api/express/carriers", "/api/express/accounts/sync"].includes(path));
    if (path === "/api/express/accounts/sync") clock = NOW + 10_000;
    return { ok: true, status: 200, text: async () => JSON.stringify(path === "/api/express/carriers"
      ? {} : response(NOW + 5_000, "New event while the request was pending")) };
  }) as typeof fetch;
  try {
    const result = await refreshAllShipments("interface5", { accountListOnly: true });
    assert.equal(result.accountListUpdated, true);
    assert.equal(result.state.shipments.length, 1);
    assert.equal(result.state.automaticDeletionFences?.length || 0, 0);
  } finally { globalThis.fetch = actualFetch; Date.now = () => NOW; }
});

test("a changed actual node at the latest event time restores the parcel", () => {
  deleted();
  upsertShipment(row(undefined, [node(initialAt, "Corrected current event")]), NOW + 2);
  assert.equal(loadState(NOW + 2).shipments.length, 1);
});

test("the first valid timed trajectory can restore an initially untimed deletion", () => {
  deleted([node(null)]);
  upsertShipment(row(undefined, [node(initialAt, "First timed event")]), NOW + 2);
  assert.equal(loadState(NOW + 2).shipments.length, 1);
});

test("manual addition remains allowed and does not consume the automatic fence", () => {
  deleted();
  const manual = row();
  manual.identity = { ...manual.identity, id: "synthetic-manual", manuallyAdded: true,
    bindingSource: null, sourceOwner: "manual" };
  upsertShipment(manual, NOW + 2);
  const stored = loadState(NOW + 2);
  assert.equal(stored.shipments.length, 1);
  assert.equal(stored.shipments[0].identity.manuallyAdded, true);
  assert.equal(stored.automaticDeletionFences?.length, 1);
});

test("deleting one real waybill does not hide another real waybill from the same order", () => {
  const first = row(), second = row("YT123456789002");
  first.identity.orderId = second.identity.orderId = "SYNTHETIC-SHARED-ORDER";
  const before = seed([first, second]);
  removeShipment(first.identity.id, NOW + 1);
  upsertShipment(second, NOW + 2);
  assert.deepEqual(loadState(NOW + 2).shipments.map(value => value.identity.sourceId), [second.identity.sourceId]);
});

test("deleting a projected order preserves untouched order and shipment siblings on its real waybill", () => {
  const real = row();
  const order = (id: string): Shipment => ({ ...row(), identity: { ...row().identity,
    id: `interface5:account:${id}`, sourceId: id, orderId: id,
    accountOrder: true, projectedWaybill: real.identity.sourceId } });
  const removed = order("SYNTHETICORDERA"), sibling = order("SYNTHETICORDERB");
  seed([real, removed, sibling]);
  removeShipment(removed.identity.id, NOW + 1);
  upsertShipment(removed, NOW + 2);
  upsertShipment(real, NOW + 2);
  upsertShipment(sibling, NOW + 2);
  const after = loadState(NOW + 2);
  assert.deepEqual(after.shipments.map(item => item.identity.id).sort(), [real.identity.id, sibling.identity.id].sort());
  assert.equal(after.automaticDeletionFences?.length, 1);
  const progressed = { ...removed, sourceTimeline: { ...removed.timeline,
    tracks: [node(NOW - 60_000, "New order-owned trajectory")] } };
  upsertShipment(progressed, NOW + 3);
  assert.equal(loadState(NOW + 3).shipments.length, 3);
  assert.equal(loadState(NOW + 3).automaticDeletionFences?.length || 0, 0);
});

test("deleting a shipment row does not fence an untouched order identity on the same waybill", () => {
  const real = row();
  const order: Shipment = { ...row(), identity: { ...row().identity,
    id: "interface5:account:SYNTHETICORDER", sourceId: "SYNTHETICORDER", orderId: "SYNTHETICORDER",
    accountOrder: true, projectedWaybill: real.identity.sourceId } };
  seed([real, order]);
  removeShipment(real.identity.id, NOW + 1);
  upsertShipment(real, NOW + 2);
  upsertShipment(order, NOW + 2);
  const after = loadState(NOW + 2);
  assert.deepEqual(after.shipments.map(item => item.identity.id), [order.identity.id]);
  assert.equal(after.automaticDeletionFences?.length, 1);
});

test("a late refresh cannot restore a row deleted after that refresh began", () => {
  const before = seed();
  removeShipment(before.shipments[0].identity.id, NOW + 1);
  commitRefreshState(before, { ...before, shipments: [row(undefined,
    [node(NOW - 60_000, "In-flight newer event")])] }, "interface5", NOW + 2);
  assert.equal(loadState(NOW + 2).shipments.length, 0);
});

test("an inactive binding cannot consume the deletion with newer timed data", () => {
  deleted();
  const current = loadState(NOW + 2);
  saveState({ ...current, bindings: [] }, NOW + 2);
  upsertShipment(row(undefined, [node(NOW - 60_000, "New data from removed binding")]), NOW + 3);
  const after = loadState(NOW + 3);
  assert.equal(after.shipments.length, 0);
  assert.equal(after.automaticDeletionFences?.length, 1);
});
