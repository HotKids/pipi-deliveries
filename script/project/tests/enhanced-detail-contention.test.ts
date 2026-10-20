import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { ENHANCEMENT_ROUTE } from "../services/enhanced-account";
import { saveGatewayToken } from "../services/credentials";
import { acquireRenewingDurableRefreshLease } from "../services/refresh-runtime-state";
import { emptyState, loadState, removeBinding, removeShipment, saveState } from "../services/storage";
import { refreshShipmentById } from "../services/sync";

const PHONE = "13800001234", ORDER = "3650000000000001";
const WAYBILL = "JD0000000000001", IMAGE = "https://img10.360buyimg.com/product.jpg";
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, {
  UUID: { string: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic" },
});
let requests = 0, holderActive = false;
globalThis.fetch = (async (url: string, options: { body: string }) => {
  assert.equal(holderActive, false, "metadata must wait until the actual detail lease is available");
  assert.equal(new URL(url).pathname, ENHANCEMENT_ROUTE,
    "the public image-only entry cannot query a timeline after waiting for its lease");
  assert.deepEqual(JSON.parse(options.body).orders, [{ phone: PHONE, orderId: ORDER }]);
  requests++;
  return { ok: true, status: 200, text: async () => JSON.stringify({ records: [
    { phone: PHONE, orderId: ORDER, realWaybill: WAYBILL, imageUrl: IMAGE },
  ], ambiguousOrderIds: [] }) };
}) as typeof fetch;

function seed() {
  memory.clear();
  requests = 0;
  const now = Date.now();
  const timeText = new Date(now + 8 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
  const parcel: AccountParcelDto = {
    source: "interface5", ownerId: ORDER, orderId: ORDER, waybill: ORDER, accountOrder: true,
    enhancedMode: true, courierCode: "JDKD", rawCourierCode: "JDKD", companyName: "京东购物",
    carrierNormalization: null, sourceProvider: "JingDong", sourceStateCode: "101",
    sourceStateText: "已下单", semantic: "ORDERED", normalizedStatusScope: "ORDER",
    normalizedStatusSemantic: "ORDERED", normalizedStatusText: "已下单",
    receiverPhone: PHONE, senderPhone: "", latestTimeText: timeText, latestDetail: "等待出库",
    tracks: [{ timeText, detail: "等待出库", statusCode: "101" }],
    routeUrl: "", projectionUrl: "https://u.jd.com/synthetic", textIdentity: null,
  };
  const row = parcelToShipment(parcel, [PHONE], now)!;
  const state = saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: now - 86_400_000,
      enhancedMode: true, enhancedAtMs: now - 1_000 },
  ] }, now);
  saveGatewayToken("AbCdEfGh_123-456");
  return state.shipments[0];
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("public detail lease wait did not settle within two seconds")), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function contend(change?: (id: string, controller: AbortController) => void, deadlineMs = 1_500) {
  const row = seed();
  const holder = acquireRenewingDurableRefreshLease(`detail:${row.identity.id}`, 35_000);
  assert.ok(holder, "the synthetic background refresh owns the actual shared detail lease");
  holderActive = true;
  const controller = new AbortController();
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const released = new Promise<void>(resolve => {
    releaseTimer = setTimeout(() => { holder.release(); holderActive = false; resolve(); }, 100);
  });
  if (change) changeTimer = setTimeout(() => change(row.identity.id, controller), 30);
  try {
    const work = refreshShipmentById(row.identity.id, {
      trigger: "product_image", requestProductImage: true,
      deadlineAtMs: Date.now() + deadlineMs, signal: controller.signal,
    });
    const outcome = await bounded(work.then(
      value => ({ status: "fulfilled" as const, value }),
      reason => ({ status: "rejected" as const, reason }),
    ));
    await bounded(released);
    return outcome;
  } finally {
    clearTimeout(changeTimer);
    clearTimeout(releaseTimer);
    holder.release();
    holderActive = false;
  }
}

const ready = await contend();
assert.equal(ready.status, "fulfilled");
assert.equal(requests, 1, "a visible detail waits for its background holder, then requests its missing image once");
if (ready.status === "fulfilled") {
  assert.equal(ready.value.shipment.identity.productImageURL, IMAGE);
  assert.equal(ready.value.shipment.identity.projectedWaybill, "", "the image response never acquires its accompanying waybill");
}
assert.equal(loadState().shipments[0].identity.productImageURL, IMAGE, "the delayed image metadata is durable");

const updated = await contend(id => {
  const state = loadState();
  const timeText = new Date(Date.now() + 8 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
  saveState({ ...state, shipments: state.shipments.map(shipment => {
    if (shipment.identity.id !== id) return shipment;
    const timeline = { ...shipment.timeline, waybill: WAYBILL, courierCode: "JD", companyName: "京东快递",
      semantic: "TRANSIT" as const, latestDetail: "后台更新的运输轨迹" };
    return { ...shipment, identity: { ...shipment.identity, projectedWaybill: WAYBILL, hadRealWaybill: true,
      courierCode: "JD", companyName: "京东快递" }, timeline, sourceTimeline: timeline,
      accountRecord: shipment.accountRecord ? { ...shipment.accountRecord, stateNumber: 104, updateTime: timeText } : null,
      updatedAtMs: Date.now() };
  }) });
});
assert.equal(updated.status, "fulfilled");
assert.equal(requests, 1, "the same owner's normal background update does not invalidate its pending image request");
if (updated.status === "fulfilled") {
  assert.equal(updated.value.shipment.identity.productImageURL, IMAGE);
  assert.equal(updated.value.shipment.identity.projectedWaybill, WAYBILL, "the holder's newly associated waybill is retained");
  assert.equal(updated.value.shipment.timeline.latestDetail, "后台更新的运输轨迹", "metadata-only continuation retains the holder's timeline");
}

const cancelled = await contend((_id, controller) => controller.abort());
assert.equal(cancelled.status, "rejected", "dismissing the detail cancels its lease wait");
assert.equal(requests, 0, "a dismissed detail cannot request metadata after the holder releases");
assert.equal(loadState().shipments[0].identity.productImageURL, undefined);

const expired = await contend(undefined, 40);
assert.equal(expired.status, "rejected", "the caller's finite deadline bounds a live holder wait");
assert.equal(requests, 0, "an expired detail cannot request metadata after the holder releases");

await contend(id => { removeShipment(id); });
assert.equal(requests, 0, "a deleted record cannot issue a late image request after waiting");
assert.equal(loadState().shipments.length, 0);

await contend(() => { removeBinding("interface5", PHONE); });
assert.equal(requests, 0, "a removed phone binding cannot issue a late image request after waiting");
assert.equal(loadState().shipments[0].identity.productImageURL, undefined);

await contend(() => {
  const state = loadState();
  saveState({ ...state, bindings: state.bindings.map(binding => ({ ...binding, boundAtMs: binding.boundAtMs + 1 })) });
});
assert.equal(requests, 0, "the old detail request cannot act for a replacement same-phone binding generation");
assert.equal(loadState().shipments[0].identity.productImageURL, undefined);

console.log("Enhanced public detail lease contention, cancellation and identity fencing tests passed");
