import assert from "node:assert/strict";
import type { AccountParcelDto } from "../services/account-parser";
import type { AccountBinding } from "../models";
import { enhanceAccountParcels, enhancementPhone, requireEnhancementBinding } from "../services/enhanced-account";
import { accountOrderTextWaybill, withAccountOrderTextWaybill, parcelToShipment,
  accountParcelWithExistingProjection, prepareAccountParcelCarrier, applyEnhancementMetadata, cachedEnhancementParcels } from "../services/account-sync";
import { accountParcelWithProjectionReference } from "../services/account-order-reference";
import { selectShipmentDetailTimeline } from "../services/shipment-policy";

const PHONE = "13800138000", OTHER = "13900139000", ORDER = "3650000000000001";
const identity = { accountId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", androidId: "0123456789abcdef" };
const binding: AccountBinding = { source: "interface5", phone: PHONE, boundAtMs: 100, enhancedMode: true, enhancedAtMs: 200 };
const parcel: AccountParcelDto = { source: "interface5", ownerId: ORDER, orderId: ORDER, waybill: ORDER,
  accountOrder: true, courierCode: "JDKD", companyName: "京东商品快递", carrierNormalization: null,
  sourceProvider: "JingDong", sourceStateCode: "104", sourceStateText: "运输中", semantic: "TRANSIT",
  receiverPhone: PHONE, senderPhone: "", latestTimeText: "2026-10-20 10:00:00", latestDetail: "运输中",
  tracks: [{ timeText: "2026-10-20 10:00:00", detail: "您的订单正在运输途中", statusCode: "104" }],
  routeUrl: "", projectionUrl: "https://u.jd.com/synthetic", textIdentity: { waybill: "JD0000000000099" } as never };
assert.equal(accountOrderTextWaybill(parcel), "JD0000000000099", "unenhanced orders retain their approved number extraction");
assert.equal(enhancementPhone(parcel, [binding]), PHONE);
assert.equal(enhancementPhone({ ...parcel, receiverPhone: OTHER }, [binding]), "");
assert.equal(enhancementPhone({ ...parcel, sourceProvider: "CaiNiao" }, [binding]), "");
assert.throws(() => requireEnhancementBinding([], PHONE), /基础绑定/);
assert.equal(requireEnhancementBinding([binding], PHONE), binding);

const [enriched] = await enhanceAccountParcels([parcel], [binding], { identity, request: async payload => {
  assert.deepEqual(payload, { operation: "sync", identity, orders: [{ phone: PHONE, orderId: ORDER }] });
  return { records: [{ phone: PHONE, orderId: ORDER, realWaybill: "JD0000000000001", imageUrl: "https://img10.360buyimg.com/synthetic.jpg" }], ambiguousOrderIds: [] };
} });
assert.equal(enriched.enhancedWaybill, "JD0000000000001");
assert.equal(enriched.waybill, ORDER);
assert.equal(enriched.enhancedMode, true);
assert.equal(enriched.productImageURL, "https://img10.360buyimg.com/synthetic.jpg");
assert.strictEqual(enriched.tracks, parcel.tracks);
assert.equal(enriched.ownerId, ORDER);
assert.equal(enriched.semantic, parcel.semantic);
const carrierPending = await prepareAccountParcelCarrier(enriched, {
  recognize: async () => ({ normalization: null, exhausted: false }),
});
assert.equal(carrierPending.waybill, ORDER, "an enhanced number waits for the established carrier gate");
assert.equal(accountOrderTextWaybill(enriched), "");
assert.equal(accountOrderTextWaybill(carrierPending), "");

for (const record of [
  { phone: OTHER, orderId: ORDER, realWaybill: "JD0000000000001" },
  { phone: PHONE, orderId: "3650000000000002", realWaybill: "JD0000000000001" },
  { phone: PHONE, orderId: ORDER, realWaybill: ORDER },
]) {
  const [unchanged] = await enhanceAccountParcels([parcel], [binding], { identity,
    request: async () => ({ records: [record], ambiguousOrderIds: [] }) });
  assert.equal(unchanged.waybill, ORDER);
  assert.equal(unchanged.enhancedMode, true);
  assert.equal(accountOrderTextWaybill(unchanged), "");
}
const [ambiguous] = await enhanceAccountParcels([parcel], [binding], { identity,
  request: async () => ({ records: [{ phone: PHONE, orderId: ORDER, realWaybill: "JD0000000000001" }], ambiguousOrderIds: [ORDER] }) });
assert.equal(ambiguous.waybill, ORDER);
const [imageOnly] = await enhanceAccountParcels([parcel], [binding], { identity,
  request: async () => ({ records: [{ phone: PHONE, orderId: ORDER, realWaybill: "", imageUrl: "https://img10.360buyimg.com/product.jpg" }], ambiguousOrderIds: [] }) });
assert.equal(imageOnly.waybill, ORDER);
assert.ok(imageOnly.productImageURL);
for (const url of ["https://evil.invalid/p.jpg", "http://img10.360buyimg.com/p.jpg", "https://user@jd.com/p.jpg"]) {
  const [invalidImage] = await enhanceAccountParcels([parcel], [binding], { identity,
    request: async () => ({ records: [{ phone: PHONE, orderId: ORDER, imageUrl: url }], ambiguousOrderIds: [] }) });
  assert.equal(invalidImage.productImageURL, undefined);
}
const accepted = await prepareAccountParcelCarrier(enriched, { recognize: async () => ({ normalization: {
  standardCode: "JD", displayName: "京东快递", kuaidi100Code: "jd", isBuiltIn: true,
} }) });
assert.equal(accepted.waybill, "JD0000000000001");
const saved = parcelToShipment(accepted, [PHONE], Date.now())!;
assert.equal(saved.identity.productImageURL, enriched.productImageURL);
assert.equal(saved.identity.enhancedMode, true);
const oldOrder = parcelToShipment({ ...parcel, textIdentity: null }, [PHONE], Date.now())!;
oldOrder.identity.enhancedMode = true;
oldOrder.automaticOwnership = { ownerSource: "interface5", ownerBindingIdentity: `phone:${PHONE}`,
  claimedAtMs: 100, lastTakeoverAtMs: 0, ownerMisses: 2, takeoverPending: false,
  observations: [{ source: "interface5", bindingIdentity: `phone:${PHONE}`, observedAtMs: 200,
    identity: oldOrder.identity, sourceTimeline: oldOrder.timeline }] };
const projected = applyEnhancementMetadata(oldOrder, accepted, Date.now());
assert.equal(projected.identity.projectedWaybill, accepted.waybill);
assert.equal(projected.identity.productImageURL, accepted.productImageURL);
assert.strictEqual(projected.timeline, oldOrder.timeline);
assert.strictEqual(projected.sourceTimeline, oldOrder.sourceTimeline);
assert.strictEqual(projected.automaticOwnership?.observations[0].sourceTimeline,
  oldOrder.automaticOwnership.observations[0].sourceTimeline);
assert.equal(projected.automaticOwnership?.observations[0].observedAtMs, 200);
assert.equal(projected.automaticOwnership?.ownerMisses, 2);
assert.deepEqual(selectShipmentDetailTimeline(projected).tracks, selectShipmentDetailTimeline(oldOrder).tracks);
const reference = accountParcelWithProjectionReference(projected, null, "");
assert.ok(reference?.enhancedMode, "already-associated cached orders remain eligible for image metadata");
assert.equal(cachedEnhancementParcels([projected], [], new Set()).length, 0);
assert.equal(cachedEnhancementParcels([projected], [binding], new Set([ORDER])).length, 0);
assert.equal(cachedEnhancementParcels([projected], [binding], new Set()).length, 1);
const withOldInvalidObservation = { ...projected, automaticOwnership: { ...projected.automaticOwnership!, observations: [
  { ...projected.automaticOwnership!.observations[0], bindingValid: false,
    bindingIdentity: `phone:${OTHER}`, identity: { ...projected.identity, phone: OTHER } },
  ...projected.automaticOwnership!.observations,
] } };
assert.equal(cachedEnhancementParcels([withOldInvalidObservation], [binding], new Set()).length, 1);
const [updatedImage] = await enhanceAccountParcels([reference!], [binding], { identity,
  request: async () => ({ records: [{ phone: PHONE, orderId: ORDER, realWaybill: "JD0000000000001",
    imageUrl: "https://img10.360buyimg.com/new.jpg" }], ambiguousOrderIds: [] }) });
const imageRefresh = applyEnhancementMetadata(projected, updatedImage, Date.now());
assert.equal(imageRefresh.identity.productImageURL, "https://img10.360buyimg.com/new.jpg");
assert.strictEqual(imageRefresh.timeline, projected.timeline);
assert.equal(imageRefresh.automaticOwnership?.observations[0].observedAtMs, 200);
const changed = accountParcelWithExistingProjection({ ...enriched, waybill: "JD0000000000002" }, [saved]);
assert.equal(changed.waybill, "JD0000000000001", "an existing association is retained under the October 20 user choice");
let requests = 0;
const unchanged = await enhanceAccountParcels([parcel], [{ ...binding, enhancedMode: undefined }], {
  request: async () => { requests++; throw new Error("unexpected request"); },
});
assert.equal(requests, 0);
assert.strictEqual(unchanged[0], parcel);
console.log("Enhanced account identity, pair matching, isolation and projection tests passed");
