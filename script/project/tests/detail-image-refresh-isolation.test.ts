import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { acquireRenewingDurableRefreshLease } from "../services/refresh-runtime-state";
import { runShipmentRefreshForTesting, runTargetedShipmentRefreshForTesting } from "../services/sync";
import { parcelToShipment } from "../services/account-sync";
import type { AccountParcelDto } from "../services/account-parser";
import type { Shipment } from "../models";
import { ENHANCEMENT_ROUTE, loadEnhancementIdentity } from "../services/enhanced-account";
import { saveGatewayToken } from "../services/credentials";

const PHONE = "13800001234", ORDER = "3650000000000001";
const IMAGE = "https://img10.360buyimg.com/product.jpg";
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, {
  UUID: { string: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
  Widget: { reloadAll() {} }, Script: { directory: "/synthetic", name: "Synthetic" },
});
let metadataCalls = 0, events: string[] = [];
globalThis.fetch = (async (url: string) => {
  assert.equal(new URL(url).pathname, ENHANCEMENT_ROUTE);
  metadataCalls++;
  events.push("image");
  return { ok: true, status: 200, text: async () => JSON.stringify({
    records: [{ phone: PHONE, orderId: ORDER, realWaybill: "JD0000000000001", imageUrl: IMAGE }],
    ambiguousOrderIds: [],
  }) };
}) as typeof fetch;

function seed(kind: "manual" | "other-source" | "basic-jd" | "enhanced-jd" | "known-image"): Shipment {
  memory.clear(); metadataCalls = 0; events = [];
  const now = Date.now();
  const parcel: AccountParcelDto = {
    source: "interface5", ownerId: ORDER, orderId: ORDER, waybill: ORDER, accountOrder: true,
    enhancedMode: true, courierCode: "JDKD", rawCourierCode: "JDKD", companyName: "JD Shopping",
    carrierNormalization: null, sourceProvider: "JingDong", sourceStateCode: "101", sourceStateText: "Ordered",
    semantic: "ORDERED", normalizedStatusScope: "ORDER", normalizedStatusSemantic: "ORDERED",
    normalizedStatusText: "Ordered", receiverPhone: PHONE, senderPhone: "",
    latestTimeText: "2026-10-20 17:59:00", latestDetail: "Waiting for dispatch",
    tracks: [{ timeText: "2026-10-20 17:59:00", detail: "Waiting for dispatch", statusCode: "101" }],
    routeUrl: "", projectionUrl: "", textIdentity: null,
  };
  let row = parcelToShipment(parcel, [PHONE], now)!;
  if (kind === "manual" || kind === "other-source") {
    const waybill = "SF123456789012";
    const timeline = { ...row.timeline, provider: "v6_query", waybill, courierCode: "SF", companyName: "SF",
      semantic: "TRANSIT" as const, latestTimeText: String(now - 60_000), latestDetail: "Parcel in transit",
      tracks: [{ timeText: String(now - 60_000), timeMs: now - 60_000, detail: "Parcel in transit", statusCode: "TRANSIT", raw: {} }] };
    row = { ...row, identity: { ...row.identity, id: `interface5:${kind}:${waybill}`, sourceId: waybill,
      accountOrder: false, manuallyAdded: kind === "manual", sourceProvider: kind === "manual" ? "" : "ShunFeng",
      courierCode: "SF", rawCourierCode: "SF", companyName: "SF" }, timeline,
      sourceTimeline: kind === "manual" ? null : timeline, manualTimelines: [timeline],
      accountRecord: kind === "manual" ? null : { waybill, provider: "ShunFeng", companyCode: "SF", phone: PHONE } };
  }
  if (kind === "known-image") row = { ...row, identity: { ...row.identity, productImageURL: IMAGE } };
  const state = saveState({ ...emptyState(), shipments: [row], bindings: [{ source: "interface5", phone: PHONE,
    boundAtMs: now - 86_400_000, ...(kind === "basic-jd" ? {} : { enhancedMode: true as const, enhancedAtMs: now - 1_000 }) }] }, now);
  saveGatewayToken("AbCdEfGh_123-456");
  loadEnhancementIdentity();
  return state.shipments[0];
}

for (const trigger of ["detail_pull", "manual_submit", "detail_open"] as const) {
  for (const kind of ["manual", "other-source", "basic-jd", "enhanced-jd", "known-image"] as const) {
    const row = seed(kind);
    const holder = acquireRenewingDurableRefreshLease(`detail:${row.identity.id}`, 35_000)!;
    assert.ok(holder);
    let settled = false;
    const pending = runTargetedShipmentRefreshForTesting(row.identity.id, {
      trigger, requestProductImage: true, forceManualRefresh: trigger === "detail_pull", deadlineAtMs: Date.now() + 1_000,
    }).then(result => { settled = true; return result; });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(settled, true, `${kind} ${trigger} must retain the immediate busy result without image polling`);
    } finally { holder.release(); }
    const result = await pending;
    assert.equal(result.refreshed, false);
    assert.equal(result.querySucceeded, false, "a busy trajectory request cannot be reported as a successful image-only refresh");
    assert.equal(metadataCalls, 0);
  }
}

for (const kind of ["manual", "other-source", "basic-jd", "known-image"] as const) {
  const row = seed(kind);
  const holder = acquireRenewingDurableRefreshLease(`detail:${row.identity.id}`, 35_000)!;
  let settled = false;
  const pending = runTargetedShipmentRefreshForTesting(row.identity.id, {
    trigger: "product_image", requestProductImage: true, deadlineAtMs: Date.now() + 1_000,
  }).then(result => { settled = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, true, `${kind} cannot wait for image work that it is not eligible to request`);
  } finally { holder.release(); }
  await pending;
  assert.equal(metadataCalls, 0);
}

const order = seed("enhanced-jd");
const row = saveState({ ...loadState(), shipments: [{ ...order, identity: { ...order.identity,
  projectedWaybill: "JD0000000000001", hadRealWaybill: true, courierCode: "JD", rawCourierCode: "JD" } }] }).shipments[0];
let finishQuery!: () => void;
const queryGate = new Promise<void>(resolve => { finishQuery = resolve; });
const pending = runShipmentRefreshForTesting(row.identity.id,
  { isCurrent: () => true, deadlineAtMs: Date.now() + 30_000 },
  { trigger: "detail_open", requestProductImage: true }, {
    refreshAccountParcel: async () => { events.push("query-start"); await queryGate; events.push("query-end"); return null; },
    queryManualForSource: async () => { assert.fail("detail entry must retain its source-only query"); },
  });
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(events, ["query-start"], "optional image metadata cannot run ahead of the necessary trajectory request");
finishQuery();
const result = await pending;
assert.deepEqual(events, ["query-start", "query-end"], "the trajectory returns without waiting for optional image metadata");
assert.equal(metadataCalls, 0);
assert.equal(result.querySucceeded, false);
assert.equal(result.refreshed, false);
const image = await runShipmentRefreshForTesting(row.identity.id,
  { isCurrent: () => true, deadlineAtMs: Date.now() + 30_000 },
  { trigger: "product_image", requestProductImage: true });
assert.deepEqual(events, ["query-start", "query-end", "image"]);
assert.equal(image.shipment.identity.productImageURL, IMAGE);
assert.equal(image.shipment.identity.projectedWaybill, "JD0000000000001", "image metadata retains the existing waybill");

const exhausted = seed("enhanced-jd");
const projected = saveState({ ...loadState(), shipments: [{ ...exhausted, identity: { ...exhausted.identity,
  projectedWaybill: "JD0000000000001", hadRealWaybill: true, courierCode: "JD", rawCourierCode: "JD" } }] }).shipments[0];
const clock = Date.now;
let now = clock();
Date.now = () => now;
try {
  const outcome = await runShipmentRefreshForTesting(projected.identity.id,
    { isCurrent: () => true, deadlineAtMs: now + 100 },
    { trigger: "detail_open", requestProductImage: true }, {
      refreshAccountParcel: async () => { now += 100; return null; },
    });
  assert.equal(outcome.querySucceeded, false);
  assert.equal(metadataCalls, 0, "an exhausted trajectory deadline cannot start optional metadata work");
} finally { Date.now = clock; }

for (const [stateNumber, semantic] of [[107, "COMPLETED"], [111, "CANCELLED"]] as const) {
  const order = seed("enhanced-jd");
  const timeline = { ...order.timeline, semantic, structuredStatus: true };
  const terminal = saveState({ ...loadState(), shipments: [{ ...order, timeline, sourceTimeline: timeline,
    accountRecord: { ...order.accountRecord!, stateNumber } }] }).shipments[0];
  const imageOnly = await runShipmentRefreshForTesting(terminal.identity.id,
    { isCurrent: () => true, deadlineAtMs: Date.now() + 30_000 },
    { trigger: "product_image", requestProductImage: true }, {
      refreshAccountParcel: async () => { assert.fail("terminal image requests cannot start account trajectory work"); },
      queryManualForSource: async () => { assert.fail("terminal image requests cannot start manual trajectory work"); },
    });
  assert.equal(metadataCalls, 1, "signed and cancelled order details retain their image-only metadata entry");
  assert.equal(imageOnly.shipment.identity.productImageURL, IMAGE);
  assert.equal(imageOnly.shipment.identity.projectedWaybill, "", "terminal images cannot acquire a waybill");
}

console.log("Detail trajectory contention and optional image ordering tests passed");
