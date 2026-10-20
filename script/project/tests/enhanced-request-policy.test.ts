import assert from "node:assert/strict";
import type { AccountBinding } from "../models";
import type { AccountParcelDto } from "../services/account-parser";
import { enhanceAccountParcels, withCurrentAccountEnhancement } from "../services/enhanced-account";
import { accountParcelWithExistingProjection, parcelToShipment } from "../services/account-sync";

const PHONE = "13800138000", OTHER = "13900139000", ORDER = "3650000000000001";
const WAYBILL = "JD0000000000001", IMAGE = "https://img10.360buyimg.com/product.jpg";
const identity = { accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", androidId: "0123456789abcdef" };
const binding: AccountBinding = { source: "interface5", phone: PHONE, boundAtMs: 100,
  enhancedMode: true, enhancedAtMs: 200 };
const parcel: AccountParcelDto = { source: "interface5", ownerId: ORDER, orderId: ORDER, waybill: ORDER,
  accountOrder: true, courierCode: "JDKD", companyName: "京东商品快递", carrierNormalization: null,
  sourceProvider: "JingDong", sourceStateCode: "103", sourceStateText: "已揽件", semantic: "ORDERED",
  receiverPhone: PHONE, senderPhone: "", latestTimeText: "2026-10-20 10:00:00", latestDetail: "订单动态",
  tracks: [], routeUrl: "", projectionUrl: "https://u.jd.com/synthetic" };
let calls: Record<string, unknown>[] = [];
const request = async (payload: Record<string, unknown>) => {
  calls.push(payload);
  return { records: [{ phone: PHONE, orderId: ORDER, realWaybill: WAYBILL, imageUrl: IMAGE }], ambiguousOrderIds: [] };
};
const run = async (candidate = parcel, bindings: readonly AccountBinding[] = [binding], purpose?: "waybill" | "image") => {
  calls = [];
  return (await enhanceAccountParcels([candidate], bindings, { identity, request, ...(purpose ? { purpose } : {}) }))[0];
};

for (const state of ["101", "111", "", "0", "112", "PICKED", "103x"]) {
  const result = await run({ ...parcel, sourceStateCode: state, semantic: "TRANSIT" });
  assert.equal(calls.length, 0, `raw Xiaomi state ${JSON.stringify(state)} must not request a missing waybill`);
  assert.equal(result.enhancedMode, true, "an enabled binding blocks legacy H5 acquisition even when this state is excluded");
}
for (let state = 102; state <= 110; state++) {
  const result = await run({ ...parcel, sourceStateCode: String(state), semantic: "ORDERED" });
  assert.equal(calls.length, 1, `raw Xiaomi state ${state} requests independently of the clamped display status`);
  assert.deepEqual(calls[0], { operation: "sync", identity, orders: [{ phone: PHONE, orderId: ORDER }] });
  assert.equal(result.enhancedWaybill, WAYBILL);
  assert.equal(result.productImageURL, undefined, "list requests do not acquire image metadata");
  assert.equal(result.semantic, "ORDERED", "enhancement never changes the account status");
}
for (const [candidate, bindings] of [
  [parcel, []],
  [parcel, [{ ...binding, enhancedMode: undefined }]],
  [{ ...parcel, receiverPhone: OTHER }, [binding]],
  [{ ...parcel, sourceProvider: "CaiNiao" }, [binding]],
  [{ ...parcel, accountOrder: false }, [binding]],
  [{ ...parcel, waybill: WAYBILL }, [binding]],
] as const) {
  await run(candidate, bindings);
  assert.equal(calls.length, 0, "only an enabled same-phone JD order without a real waybill may query Samsung");
}

const existing = parcelToShipment({ ...parcel, waybill: WAYBILL, enhancedMode: true }, [PHONE], Date.now())!;
const restored = accountParcelWithExistingProjection({ ...parcel, enhancedMode: true }, [existing]);
assert.equal(restored.waybill, WAYBILL);
await run(restored);
assert.equal(calls.length, 0, "an order's list identifier cannot hide an already associated real waybill");

for (const state of ["101", "111", "103"]) {
  const result = await run({ ...parcel, sourceStateCode: state }, [binding], "image");
  assert.equal(calls.length, 1, "visible detail images are independent of the waybill state gate");
  assert.equal(result.productImageURL, IMAGE);
  assert.equal(result.enhancedWaybill, undefined, "image requests cannot project a number returned alongside the image");
  assert.equal(result.waybill, ORDER);
}
const projectedImage = await run({ ...parcel, waybill: "JD0000000000099" }, [binding], "image");
assert.equal(projectedImage.productImageURL, IMAGE);
assert.equal(projectedImage.waybill, "JD0000000000099", "an image response cannot replace a retained association");
assert.equal(projectedImage.enhancedWaybill, undefined);

const cachedEnhanced = { ...parcel, enhancedMode: true as const, enhancedWaybill: WAYBILL, productImageURL: IMAGE };
for (const bindings of [[], [{ ...binding, enhancedMode: undefined }], [{ ...binding, phone: OTHER }]]) {
  const normalized = withCurrentAccountEnhancement(cachedEnhanced, bindings);
  assert.equal(normalized.enhancedMode, undefined, "a cached row flag cannot authorize another or removed binding");
  assert.equal(normalized.enhancedWaybill, undefined, "pending enhancement metadata is not carried across disabled bindings");
  assert.equal(normalized.productImageURL, IMAGE, "a downloaded product image remains associated with the retained record");
}
assert.equal(withCurrentAccountEnhancement(parcel, [binding]).enhancedMode, true,
  "a binding enabled after this cached row was written takes effect immediately");
const retainedImage = await run({ ...parcel, productImageURL: IMAGE }, [binding], "image");
assert.equal(calls.length, 0, "known image metadata avoids repeated interface 3 calls");
assert.equal(retainedImage.productImageURL, IMAGE);

console.log("Enhanced request purpose, raw Xiaomi state and existing-waybill policy tests passed");
