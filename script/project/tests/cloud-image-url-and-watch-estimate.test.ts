import assert from "node:assert/strict";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment } from "../models";
import { saveGatewayToken, gatewayCredentialForLocalCache } from "../services/credentials";
import { cachedProductImage, cloudProductImageCacheKey, productImageCacheFiles, productImageCachePath,
  pruneProductImages, rememberProductImage } from "../services/product-image-cache";
import { displayedPlatformFields, keepPlatformFields } from "../services/platform-parcel-merge";
import { internationalShipment } from "../services/international-records";

// R5-NEW-09 (fifth review, 2026-11-25). Identities and URLs are synthetic.

// ① A cloud thumbnail's cache key names its image URL: a replaced cloud image is a new memory entry and file, and the
//    record's owner key still removes every image the record held.
memory.clear();
saveGatewayToken("SyntheticKey_909");
const scope = gatewayCredentialForLocalCache()!.scope;
const parcel: Shipment = {
  identity: { id: "cloud-image-row", bindingSource: null, sourceOwner: "manual", sourceId: "YT000000009091",
    phoneTail: "", courierCode: "YTO", companyName: "圆通速递", manuallyAdded: true, createdAtMs: NOW - 20_000 },
  timeline: { provider: "picker", waybill: "YT000000009091", courierCode: "YTO", companyName: "圆通速递",
    semantic: "TRANSIT", statusEventAtMs: NOW - 10_000, latestTimeText: "2026-09-08 13:59", latestDetail: "运输中",
    tracks: [{ timeMs: NOW - 10_000, timeText: "2026-09-08 13:59", detail: "运输中", statusCode: "", raw: {} }],
    successAtMs: NOW - 10_000 },
  updatedAtMs: NOW - 10_000,
};
const placeholder = "https://img.alicdn.com/synthetic-placeholder.jpg";
const product = "https://img.alicdn.com/synthetic-product.jpg";
const firstKey = cloudProductImageCacheKey(parcel, scope, placeholder);
const secondKey = cloudProductImageCacheKey(parcel, scope, product);
const owner = cloudProductImageCacheKey(parcel, scope);
assert.ok(firstKey && secondKey && owner);
assert.notEqual(firstKey, secondKey, "a changed cloud image URL has its own cache key");
assert.equal(cloudProductImageCacheKey(parcel, scope, placeholder), firstKey, "the same URL keeps its key");
assert.ok(firstKey.startsWith(`${owner}.`) && secondKey.startsWith(`${owner}.`), "both belong to the record's owner key");
assert.equal(cloudProductImageCacheKey(parcel, "", placeholder), "", "no Access Key scope, no cloud key");

const firstPath = productImageCachePath(firstKey);
memory.set(`file:${firstPath}`, "synthetic encoded placeholder");
const firstImage = { syntheticImage: "placeholder" } as unknown as UIImage;
rememberProductImage(firstKey, firstImage);
assert.deepEqual(productImageCacheFiles(firstKey), [firstPath]);
assert.deepEqual(productImageCacheFiles(secondKey), [], "the replaced image does not read the earlier file");
assert.equal(cachedProductImage(secondKey), null, "nor the earlier memory entry");
assert.deepEqual(productImageCacheFiles(owner), [], "the owner key alone names no variant's file as its own");

pruneProductImages([parcel], [parcel], NOW);
assert.ok(memory.has(`file:${firstPath}`), "a retained record keeps its cloud image file");
assert.equal(cachedProductImage(firstKey), firstImage, "and its memory entry");
pruneProductImages([parcel], [], NOW);
assert.equal(memory.has(`file:${firstPath}`), false, "a removed record's cloud image file is cleaned by its owner key");
assert.equal(cachedProductImage(firstKey), null, "and its memory entry");

// ② A Watch snapshot that withdrew its estimate does not keep the earlier one; the cloud parcel metadata's estimate
//    shows again. The user's title edit is still carried, and other rows keep their saved fields.
const watchWaybill = "1Z00000000000009092";
const watchRow = (estimate?: string): Shipment => ({
  identity: { id: "watch:00000000-0000-0000-0000-000000009092", sourceId: watchWaybill, sourceOwner: "lastscanned",
    sourceProvider: "lastscanned", bindingSource: null, phoneTail: "", courierCode: "watch-ups", companyName: "UPS",
    manuallyAdded: false, createdAtMs: NOW - 60_000 },
  timeline: { provider: "lastscanned", waybill: watchWaybill, courierCode: "watch-ups", companyName: "UPS",
    semantic: "TRANSIT", structuredStatus: true, statusEventAtMs: NOW - 10_000, latestTimeText: "", latestDetail: "",
    tracks: [{ timeText: "", timeMs: NOW - 50_000, detail: "Departed", statusCode: "", raw: {} }], successAtMs: NOW - 10_000 },
  ...(estimate ? { platformFields: { waybill: watchWaybill, waybillGeneration: 0,
    estimate: { text: estimate, source: "lastscanned" as const, capturedAtMs: NOW - 30_000 } } } : {}),
  updatedAtMs: NOW - 10_000,
});
const withEstimate = watchRow("预计9月10日送达");
assert.equal(internationalShipment(withEstimate), true);
const withdrawn = keepPlatformFields(withEstimate, watchRow());
assert.equal(withdrawn.platformFields?.estimate, undefined, "a withdrawn Watch estimate is not revived");
const cloud = { waybill: watchWaybill, anchorAt: NOW - 60_000, terminalAt: 0, deliveryEstimate: "预计9月12日送达",
  deliveryEstimateObservedAt: NOW - 5_000 };
assert.equal(displayedPlatformFields(withEstimate, NOW, cloud as never).estimate, "预计9月10日送达",
  "the Watch's own estimate goes first while it has one");
assert.equal(displayedPlatformFields(withdrawn, NOW, cloud as never).estimate, "预计9月12日送达",
  "the cloud estimate shows once the Watch estimate is withdrawn");

const titled: Shipment = { ...withEstimate, platformFields: { ...withEstimate.platformFields!,
  manualTitle: "Synthetic title", manualTitleEditedAtMs: NOW - 40_000 } };
const keptTitle = keepPlatformFields(titled, watchRow());
assert.equal(keptTitle.platformFields?.manualTitle, "Synthetic title", "the user's title edit is carried");
assert.equal(keptTitle.platformFields?.manualTitleEditedAtMs, NOW - 40_000);
assert.equal(keptTitle.platformFields?.estimate, undefined);
assert.equal(keepPlatformFields(withEstimate, watchRow("预计9月11日送达")).platformFields?.estimate?.text, "预计9月11日送达",
  "a Watch snapshot with its own estimate keeps it");

const domestic: Shipment = { ...parcel, platformFields: { waybill: "YT000000009091", waybillGeneration: 0,
  estimate: { text: "2026-09-10", source: "cainiao", capturedAtMs: NOW - 30_000 } } };
assert.equal(keepPlatformFields(domestic, parcel).platformFields?.estimate?.text, "2026-09-10",
  "a domestic row keeps its saved estimate through a rebuild without platform fields");

console.log("cloud image URL keys and withdrawn Watch estimates pass");
