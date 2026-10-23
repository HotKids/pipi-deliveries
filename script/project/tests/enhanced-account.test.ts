import assert from "node:assert/strict";
import type { AccountParcelDto } from "../services/account-parser";
import type { AccountBinding } from "../models";
import { enhanceAccountParcels, enhancementPhone, requireEnhancementBinding } from "../services/enhanced-account";
import { accountOrderTextWaybill, withAccountOrderTextWaybill, parcelToShipment,
  accountParcelWithExistingProjection, prepareAccountParcelCarrier, applyEnhancementMetadata, cachedEnhancementParcels } from "../services/account-sync";
import { accountParcelWithProjectionReference } from "../services/account-order-reference";
import { selectShipmentDetailTimeline } from "../services/shipment-policy";
import { clearDiagnostics, diagnosticText, readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { SCRIPT_CLIENT_BUILD } from "../services/build-track";
import { OperationTimeoutError } from "../services/deadline";

const diagnosticStorage = new Map<string, unknown>();
Object.assign(globalThis, { Storage: {
  get: (key: string) => diagnosticStorage.get(key) ?? null,
  set: (key: string, value: unknown) => { diagnosticStorage.set(key, structuredClone(value)); return true; },
  remove: (key: string) => { diagnosticStorage.delete(key); },
} });
setDiagnosticsEnabled(true);

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
assert.equal(enriched.productImageURL, undefined, "list waybill requests do not acquire images");
assert.strictEqual(enriched.tracks, parcel.tracks);
assert.equal(enriched.ownerId, ORDER);
assert.equal(enriched.semantic, parcel.semantic);

const [unattributed] = await enhanceAccountParcels([parcel], [binding], { identity, purpose: "image",
  request: async () => ({ records: [{ phone: "", orderId: ORDER,
    realWaybill: "JD0000000000001", imageUrl: "https://img10.360buyimg.com/unattributed.jpg" }], ambiguousOrderIds: [] }) });
assert.equal(unattributed.productImageURL, "https://img10.360buyimg.com/unattributed.jpg");
assert.equal(unattributed.enhancedWaybill, undefined, "image metadata never projects the accompanying number");
assert.equal(unattributed.receiverPhone, parcel.receiverPhone);
assert.strictEqual(unattributed.tracks, parcel.tracks);
assert.equal(unattributed.semantic, parcel.semantic);
const [unattributedWaybill] = await enhanceAccountParcels([parcel], [binding], { identity,
  request: async () => ({ records: [{ phone: "", orderId: ORDER,
    realWaybill: "JD0000000000001", imageUrl: "https://img10.360buyimg.com/unattributed.jpg" }], ambiguousOrderIds: [] }) });
assert.equal(unattributedWaybill.enhancedWaybill, "JD0000000000001");
assert.equal(unattributedWaybill.productImageURL, undefined);
const sharedOrderParcels = [parcel, { ...parcel, receiverPhone: OTHER }];
const sharedOrderBindings = [binding, { ...binding, phone: OTHER }];
const sharedUnattributed = await enhanceAccountParcels(sharedOrderParcels, sharedOrderBindings, { identity, purpose: "image",
  request: async () => ({ records: [{ phone: "", orderId: ORDER,
    imageUrl: "https://img10.360buyimg.com/shared.jpg" }], ambiguousOrderIds: [] }) });
assert.ok(sharedUnattributed.every(value => !value.productImageURL), "unattributed metadata cannot choose between two requested phones");
for (const phone of [undefined, null, "8000", OTHER]) {
  const [rejected] = await enhanceAccountParcels([parcel], [binding], { identity, purpose: "image",
    request: async () => ({ records: [{ phone, orderId: ORDER,
      imageUrl: "https://img10.360buyimg.com/rejected.jpg" }], ambiguousOrderIds: [] }) });
  assert.equal(rejected.productImageURL, undefined, "only the Worker's explicit empty-phone marker permits order matching");
}
const [duplicateMetadata] = await enhanceAccountParcels([parcel], [binding], { identity, purpose: "image",
  request: async () => ({ records: [PHONE, ""].map(phone => ({ phone, orderId: ORDER,
    imageUrl: "https://img10.360buyimg.com/duplicate.jpg" })), ambiguousOrderIds: [] }) });
assert.equal(duplicateMetadata.productImageURL, undefined, "duplicate metadata cannot choose a first result");
const [duplicateWaybill] = await enhanceAccountParcels([parcel], [binding], { identity,
  request: async () => ({ records: [PHONE, ""].map(phone => ({ phone, orderId: ORDER,
    realWaybill: "JD0000000000001" })), ambiguousOrderIds: [] }) });
assert.equal(duplicateWaybill.enhancedWaybill, undefined, "duplicate number metadata cannot choose a first result");
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
  assert.equal(unchanged.enhancedWaybill, undefined);
  assert.equal(unchanged.enhancedMode, true);
  assert.equal(accountOrderTextWaybill(unchanged), "");
}
const [ambiguous] = await enhanceAccountParcels([parcel], [binding], { identity,
  request: async () => ({ records: [{ phone: PHONE, orderId: ORDER, realWaybill: "JD0000000000001" }], ambiguousOrderIds: [ORDER] }) });
assert.equal(ambiguous.waybill, ORDER);
assert.equal(ambiguous.enhancedWaybill, undefined);
const [imageOnly] = await enhanceAccountParcels([parcel], [binding], { identity, purpose: "image",
  request: async () => ({ records: [{ phone: PHONE, orderId: ORDER, realWaybill: "", imageUrl: "https://img10.360buyimg.com/product.jpg" }], ambiguousOrderIds: [] }) });
assert.equal(imageOnly.waybill, ORDER);
assert.ok(imageOnly.productImageURL);
for (const url of ["https:jd.com/x", "https:/jd.com/x", " https://@jd.com/x"]) {
  const [normalizedImage] = await enhanceAccountParcels([parcel], [binding], { identity, purpose: "image",
    request: async () => ({ records: [{ phone: PHONE, orderId: ORDER, imageUrl: url }], ambiguousOrderIds: [] }) });
  assert.equal(normalizedImage.productImageURL, "https://jd.com/x",
    "metadata retains its established normalization before the downloader's separate raw-URL boundary");
}
for (const url of ["https://evil.invalid/p.jpg", "http://img10.360buyimg.com/p.jpg", "https://user@jd.com/p.jpg",
  "https://@jd.com/p.jpg", "https://jd.com?email=@", "\nhttps://img.jd.com/a"]) {
  const [invalidImage] = await enhanceAccountParcels([parcel], [binding], { identity, purpose: "image",
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
const [updatedImage] = await enhanceAccountParcels([reference!], [binding], { identity, purpose: "image",
  request: async () => ({ records: [{ phone: PHONE, orderId: ORDER, realWaybill: "JD0000000000001",
    imageUrl: "https://img10.360buyimg.com/new.jpg" }], ambiguousOrderIds: [] }) });
const imageRefresh = applyEnhancementMetadata(projected, updatedImage, Date.now());
assert.equal(imageRefresh.identity.productImageURL, "https://img10.360buyimg.com/new.jpg");
assert.strictEqual(imageRefresh.timeline, projected.timeline);
assert.equal(imageRefresh.automaticOwnership?.observations[0].observedAtMs, 200);
const [unattributedRefresh] = await enhanceAccountParcels([reference!], [binding], { identity, purpose: "image",
  request: async () => ({ records: [{ phone: "", orderId: ORDER,
    realWaybill: "JD0000000000002", imageUrl: "https://img10.360buyimg.com/unattributed-new.jpg" }], ambiguousOrderIds: [] }) });
const retainedAssociation = applyEnhancementMetadata(projected, unattributedRefresh, Date.now());
assert.equal(retainedAssociation.identity.projectedWaybill, projected.identity.projectedWaybill);
assert.equal(retainedAssociation.identity.productImageURL, "https://img10.360buyimg.com/unattributed-new.jpg");
assert.strictEqual(retainedAssociation.timeline, projected.timeline);
assert.strictEqual(retainedAssociation.sourceTimeline, projected.sourceTimeline);
assert.equal(retainedAssociation.automaticOwnership?.observations[0].observedAtMs, 200);
const changed = accountParcelWithExistingProjection({ ...enriched, waybill: "JD0000000000002" }, [saved]);
assert.equal(changed.waybill, "JD0000000000001", "an existing association is retained under the October 20 user choice");
let requests = 0;
const unchanged = await enhanceAccountParcels([parcel], [{ ...binding, enhancedMode: undefined }], {
  request: async () => { requests++; throw new Error("unexpected request"); },
});
assert.equal(requests, 0);
assert.strictEqual(unchanged[0], parcel);

clearDiagnostics();
await enhanceAccountParcels([parcel, parcel], [binding], { identity, purpose: "image",
  request: async () => ({ records: [{ phone: PHONE, orderId: ORDER,
    imageUrl: "https://img10.360buyimg.com/synthetic-private-product.jpg" }], ambiguousOrderIds: [] }) });
const completion = readDiagnostics().filter(entry => entry.event === "account.enhanced.completed");
assert.equal(completion.length, 1, "one batch produces one metadata summary");
assert.ok(Number.isInteger(completion[0].details.durationMs) && completion[0].details.durationMs! >= 0);
assert.deepEqual(completion[0].details, { durationMs: completion[0].details.durationMs, clientBuild: SCRIPT_CLIENT_BUILD, stage: "v3_list", result: "completed",
  interface: "v3", requestProvider: "v3_list", level: "v3_list", source: "v5", sourceProvider: "jingdong", purpose: "image",
  orders: 2, requestedOrderCount: 1, records: 1, matchedOrderCount: 1,
  realWaybillCount: 0, imageURLCount: 1, productImageCount: 1, ambiguousOrderCount: 0 });
for (const value of [PHONE, ORDER, identity.accountId, identity.androidId, "synthetic-private-product"]) {
  assert.equal(diagnosticText().includes(value), false, "metadata diagnostics exclude identifiers and image URLs");
}

for (const [records, ambiguousOrderIds, expected] of [
  [[], [], { matchedOrderCount: 0, productImageCount: 0, ambiguousOrderCount: 0 }],
  [[{ phone: OTHER, orderId: ORDER, imageUrl: "https://img10.360buyimg.com/p.jpg" }], [],
    { matchedOrderCount: 0, productImageCount: 0, ambiguousOrderCount: 0 }],
  [[{ phone: PHONE, orderId: ORDER, imageUrl: "http://img10.360buyimg.com/p.jpg" }], [],
    { matchedOrderCount: 1, productImageCount: 0, ambiguousOrderCount: 0 }],
  [[{ phone: PHONE, orderId: ORDER, imageUrl: "https://img10.360buyimg.com/p.jpg" }], [ORDER],
    { matchedOrderCount: 0, productImageCount: 0, ambiguousOrderCount: 1 }],
] as const) {
  clearDiagnostics();
  await enhanceAccountParcels([parcel], [binding], { identity, purpose: "image",
    request: async () => ({ records: [...records], ambiguousOrderIds: [...ambiguousOrderIds] }) });
  const details = readDiagnostics().find(entry => entry.event === "account.enhanced.completed")?.details;
  for (const [key, count] of Object.entries(expected)) {
    assert.equal((details as Record<string, unknown> | undefined)?.[key], count);
  }
}

for (const realWaybill of ["JD0000000000001", ORDER, "", "short", "JD invalid", "J".repeat(65), 123]) {
  clearDiagnostics();
  const result = await enhanceAccountParcels([parcel, parcel], [binding], { identity,
    request: async () => ({ records: [{ phone: PHONE, orderId: ORDER, realWaybill,
      imageUrl: "https://img10.360buyimg.com/synthetic.jpg" }], ambiguousOrderIds: [] }) });
  const details = readDiagnostics().find(entry => entry.event === "account.enhanced.completed")!.details;
  const accepted = realWaybill === "JD0000000000001";
  assert.equal(details.purpose, "waybill");
  assert.equal(details.matchedOrderCount, 1, "matching is distinct from accepting a real waybill");
  assert.equal(details.realWaybillCount, accepted ? 1 : 0, "count only distinct accepted real waybills");
  assert.equal(details.imageURLCount, 0, "waybill requests do not accept image addresses");
  assert.equal(result[0].enhancedWaybill, accepted ? realWaybill : undefined);
}

clearDiagnostics();
await enhanceAccountParcels([{ ...parcel, receiverPhone: "", senderPhone: "" }],
  [binding, { source: "interface5", phone: OTHER, boundAtMs: 100 }], {
    request: async () => { assert.fail("an ambiguous phone cannot make an enhancement request"); },
  });
assert.deepEqual(readDiagnostics().map(entry => [entry.event, entry.details.result, entry.details.orders]),
  [["account.enhanced.skipped", "no_eligible_orders", 1]]);
clearDiagnostics();
await enhanceAccountParcels([parcel], [{ ...binding, enhancedMode: undefined }]);
await enhanceAccountParcels([{ ...parcel, sourceProvider: "CaiNiao" }], [binding]);
assert.deepEqual(readDiagnostics(), [], "unenhanced bindings and non-JD rows add no metadata noise");

clearDiagnostics();
await enhanceAccountParcels([parcel], [binding], { identity,
  request: async () => { throw new Error("synthetic-private-error"); } });
assert.equal(readDiagnostics().filter(entry => entry.event === "account.enhanced.failed").length, 1);
assert.equal(readDiagnostics().some(entry => entry.event === "account.enhanced.completed"), false);
assert.equal(diagnosticText().includes("synthetic-private-error"), false);
assert.deepEqual(readDiagnostics()[0].details, { durationMs: readDiagnostics()[0].details.durationMs, clientBuild: SCRIPT_CLIENT_BUILD,
  interface: "v3", requestProvider: "v3_list", level: "v3_list", source: "v5", sourceProvider: "jingdong", purpose: "waybill", stage: "v3_list", result: "failed",
  orders: 1, requestedOrderCount: 1, matchedOrderCount: 0, realWaybillCount: 0,
  imageURLCount: 0, productImageCount: 0, errorCategory: "unknown" });
clearDiagnostics();
await enhanceAccountParcels([parcel], [binding], { identity, purpose: "image",
  request: async () => { throw new OperationTimeoutError(undefined, { timeoutOrigin: "timeout_signal",
    requestPhase: "request", requestBudgetMs: 14295, requestElapsedMs: 14299, deadlineLagMs: 4 }); } });
const timedOut = readDiagnostics()[0].details;
assert.equal(timedOut.interface, "v3");
assert.equal(timedOut.level, "v3_list");
assert.equal(timedOut.purpose, "image");
assert.equal(timedOut.result, "failed");
assert.equal(timedOut.requestBudgetMs, 14295);
assert.equal(timedOut.errorCategory, "timeout");
assert.equal(timedOut.realWaybillCount, 0, "failed requests applied no real-waybill result");
assert.equal(timedOut.imageURLCount, 0, "failed requests applied no image-address result");
clearDiagnostics();
const originalNow = Date.now;
let diagnosticNow = originalNow();
Date.now = () => diagnosticNow;
let timedMetadata: ReturnType<typeof readDiagnostics>[number]["details"];
try {
  await enhanceAccountParcels([parcel], [binding], { identity, purpose: "image",
    flowId: "detail-enhanced-image", trigger: "product_image",
    request: async () => {
      diagnosticNow += 37;
      return { records: [], ambiguousOrderIds: [] };
    } });
  timedMetadata = readDiagnostics()[0].details;
} finally { Date.now = originalNow; }
assert.equal(timedMetadata.durationMs, 37, "enhancement elapsed time measures its own metadata work");
assert.equal(timedMetadata.flowId, "detail-enhanced-image");
assert.equal(timedMetadata.trigger, "product_image");
assert.equal(timedMetadata.source, "v5", "the owning account stays v5 while the request uses interface v3");
assert.equal(timedMetadata.sourceProvider, "jingdong", "business source is independent of the enhancement adapter");
console.log("Enhanced account identity, pair matching, isolation and projection tests passed");
