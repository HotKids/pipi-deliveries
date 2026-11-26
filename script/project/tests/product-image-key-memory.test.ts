import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NOW } from "./state-storage-mock";
import type { Shipment, ShipmentIdentity } from "../models";
import { cainiaoImageCacheKey, cloudProductImageCacheKey, pddImageCacheKey, productImageCacheKey } from "../services/product-image-cache";
import { pddParcelProductImage } from "../services/platform-parcel-merge";
import { shipmentLifecycleKey } from "../services/shipment-lifecycle";

// A product image key is the SHA-256 of its serialized inputs. Repeated renders reuse the key of equal
// inputs; any changed input must produce exactly the key a fresh computation produces.
const fresh = (identity: ShipmentIdentity, scope: readonly unknown[] = []) => createHash("sha256").update(JSON.stringify([
  identity.bindingSource, identity.id, identity.sourceId, identity.phone || "", identity.orderId || "", ...scope,
])).digest("hex");
const hash = Crypto.sha256;
const hashed = new Map<string, number>();
Crypto.sha256 = ((value: string) => {
  hashed.set(value, (hashed.get(value) ?? 0) + 1);
  return hash(value);
}) as typeof Crypto.sha256;
const hashesOf = (identity: ShipmentIdentity, scope: readonly unknown[] = []) => hashed.get(JSON.stringify([
  identity.bindingSource, identity.id, identity.sourceId, identity.phone || "", identity.orderId || "", ...scope,
])) ?? 0;

const waybill = "YT000000009101";
const identity: ShipmentIdentity = {
  id: "key-memory-row", bindingSource: "interface5", sourceOwner: "account", sourceId: "key-memory-source",
  phone: "13800000000", phoneTail: "0000", orderId: "key-memory-order", courierCode: "YTO", companyName: "圆通速递",
  manuallyAdded: false, createdAtMs: NOW - 20_000,
};
function shipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    identity,
    timeline: { provider: "picker", waybill, courierCode: "YTO", companyName: "圆通速递", semantic: "TRANSIT",
      statusEventAtMs: NOW - 10_000, latestTimeText: "2026-09-08 13:59", latestDetail: "运输中",
      tracks: [{ timeMs: NOW - 10_000, timeText: "2026-09-08 13:59", detail: "运输中", statusCode: "", raw: {} }],
      successAtMs: NOW - 10_000 },
    updatedAtMs: NOW - 10_000,
    ...overrides,
  };
}

try {
  // Equal inputs: the memoized key equals the fresh key, and only the first call crosses the hash bridge.
  const key = productImageCacheKey(identity);
  assert.equal(key, fresh(identity), "the first key is the SHA-256 of the exact serialized inputs");
  for (let render = 0; render < 20; render += 1) {
    assert.equal(productImageCacheKey({ ...identity }), key, "an equal identity object reuses the same key");
  }
  assert.equal(hashesOf(identity), 1, "repeated renders of the same inputs hash once");

  // Fields outside the key do not change it.
  const presentation = { ...identity, companyName: "Other", courierCode: "ZTO", createdAtMs: NOW, productImageURL: "https://img.jd.com/x.jpg",
    projectedWaybill: "YT000000009999" };
  assert.equal(productImageCacheKey(presentation), key, "presentation and lifecycle fields are not identity key inputs");
  assert.equal(hashesOf(identity), 1);

  // Every identity input yields a fresh key when it changes.
  for (const changed of [
    { ...identity, bindingSource: null },
    { ...identity, id: "key-memory-row-2" },
    { ...identity, sourceId: "key-memory-source-2" },
    { ...identity, phone: "13900000000" },
    { ...identity, orderId: "key-memory-order-2" },
  ] satisfies ShipmentIdentity[]) {
    const next = productImageCacheKey(changed);
    assert.equal(next, fresh(changed), "a changed input produces the freshly computed key");
    assert.notEqual(next, key, "a changed input never reuses the previous key");
  }
  // Inputs that serialize identically keep the identical key, exactly as before.
  assert.equal(productImageCacheKey({ ...identity, phone: undefined }), productImageCacheKey({ ...identity, phone: "" }));
  assert.equal(productImageCacheKey({ ...identity, phone: undefined }), fresh({ ...identity, phone: "" }));

  // Cainiao keys follow the exact waybill and image fields.
  const fields = { waybill, waybillGeneration: 0, cainiaoImage: { url: "https://img.alicdn.com/key-memory.jpg", generation: "gen-a" } };
  const cainiao = shipment({ platformFields: fields });
  const cainiaoScope = (row: Shipment) => ["cainiao", row.platformFields!.waybill, row.platformFields!.waybillGeneration,
    row.platformFields!.cainiaoImage!.generation, row.platformFields!.cainiaoImage!.url];
  const cainiaoKey = cainiaoImageCacheKey(cainiao);
  assert.equal(cainiaoKey, fresh(identity, cainiaoScope(cainiao)));
  assert.equal(cainiaoImageCacheKey(shipment({ platformFields: { ...fields } })), cainiaoKey);
  assert.equal(hashesOf(identity, cainiaoScope(cainiao)), 1, "an unchanged Cainiao image is hashed once");
  for (const changed of [
    { ...fields, cainiaoImage: { ...fields.cainiaoImage, generation: "gen-b" } },
    { ...fields, cainiaoImage: { ...fields.cainiaoImage, url: "https://img.alicdn.com/key-memory-2.jpg" } },
    { ...fields, waybill: "YT000000009102" },
    { ...fields, waybillGeneration: 1 },
  ]) {
    const row = shipment({ platformFields: changed });
    assert.equal(cainiaoImageCacheKey(row), fresh(identity, cainiaoScope(row)));
    assert.notEqual(cainiaoImageCacheKey(row), cainiaoKey);
  }
  // Exact serialized inputs: a number and its string form stay different keys.
  const stringGeneration = shipment({ platformFields: { ...fields, waybillGeneration: "0" as unknown as number } });
  assert.equal(cainiaoImageCacheKey(stringGeneration), fresh(identity, cainiaoScope(stringGeneration)));
  assert.notEqual(cainiaoImageCacheKey(stringGeneration), cainiaoKey);

  // Cloud keys follow the lifecycle and the local cache scope.
  const cloudKey = cloudProductImageCacheKey(cainiao, "scope-a");
  assert.equal(cloudKey, fresh(identity, ["cloud", shipmentLifecycleKey(cainiao), "scope-a"]));
  assert.equal(cloudProductImageCacheKey(shipment(), "scope-a"), cloudKey, "the lifecycle, not the image fields, scopes a cloud key");
  for (const [row, scope] of [
    [shipment(), "scope-b"],
    [shipment({ identity: { ...identity, createdAtMs: NOW - 19_000 } }), "scope-a"],
    [shipment({ waybillReuseAtMs: NOW - 5_000 }), "scope-a"],
  ] as const) {
    const next = cloudProductImageCacheKey(row, scope);
    assert.equal(next, fresh(row.identity, ["cloud", shipmentLifecycleKey(row), scope]));
    assert.notEqual(next, cloudKey, "a new lifecycle or cache scope yields a new cloud key");
  }
  assert.equal(cloudProductImageCacheKey(shipment(), ""), "", "an empty cache scope still has no cloud key");

  // PDD keys follow the lifecycle, the order association and the image address.
  const association = JSON.stringify(["key-memory-owner", "key-memory-pdd-order", "73000001"]);
  const pdd = shipment({ pddImport: { ownerKey: "key-memory-owner", orderId: "key-memory-pdd-order", shippingId: "73000001" },
    platformFields: { waybill, waybillGeneration: 0, pddImage: { url: "https://img.pddpic.com/key-memory.jpeg", association } } });
  const url = pddParcelProductImage(pdd);
  assert.ok(url, "the PDD fixture carries a displayable product image");
  const pddKey = pddImageCacheKey(pdd);
  assert.equal(pddKey, fresh(identity, ["pdd", shipmentLifecycleKey(pdd), association, url]));
  const otherAddress = shipment({ ...pdd, platformFields: { ...pdd.platformFields!,
    pddImage: { url: "https://img.pddpic.com/key-memory-2.jpeg", association } } });
  assert.equal(pddImageCacheKey(otherAddress), fresh(identity, ["pdd", shipmentLifecycleKey(otherAddress), association,
    pddParcelProductImage(otherAddress)]));
  assert.notEqual(pddImageCacheKey(otherAddress), pddKey);
  const otherOrder = shipment({ ...pdd, pddImport: { ...pdd.pddImport!, shippingId: "73000002" } });
  assert.equal(pddImageCacheKey(otherOrder), "", "an association that no longer matches still has no PDD key");

  // A bounded memory recomputes an evicted key to the same value.
  for (let index = 0; index < 400; index += 1) productImageCacheKey({ ...identity, id: `key-memory-fill-${index}` });
  assert.equal(productImageCacheKey(identity), key, "an evicted key is recomputed to the identical value");
  assert.equal(hashesOf(identity), 2, "only an evicted key is hashed again");

  // A failed hash is not remembered.
  const failing = { ...identity, id: "key-memory-unavailable" };
  Crypto.sha256 = (() => { throw new Error("synthetic hash unavailable"); }) as typeof Crypto.sha256;
  assert.equal(productImageCacheKey(failing), "", "an unavailable hash still yields no key");
  Crypto.sha256 = ((value: string) => {
    hashed.set(value, (hashed.get(value) ?? 0) + 1);
    return hash(value);
  }) as typeof Crypto.sha256;
  assert.equal(productImageCacheKey(failing), fresh(failing), "a later call computes the key instead of reusing the failure");
} finally {
  Crypto.sha256 = hash;
}
console.log("product image keys are reused for equal inputs and recomputed for every changed input");
