import assert from "node:assert/strict";
import { memory, NOW } from "./state-storage-mock";
import { enhanceAccountParcels, enhancementOperation, existingEnhancementIdentity,
  loadEnhancementIdentity } from "../services/enhanced-account";
import type { AccountParcelDto } from "../services/account-parser";
import { addBinding, enableBindingEnhancement, loadState } from "../services/storage";

let generated = 0;
Object.assign(globalThis, { UUID: { string() {
  generated++;
  return `${String(generated).padStart(8, "0")}-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
} } });
Object.assign(Crypto, { generateSymmetricKey() {
  return { toHexString: () => "0123456789abcdef0123456789abcdef" };
} });

const PHONE = "13800138000";
addBinding("interface5", PHONE, NOW);
enableBindingEnhancement(PHONE, NOW, NOW + 1);
const original = loadEnhancementIdentity();
const SHARED_KEY = "pipi_deliveries_account_enhancement_identity_shared_v1";
const KEYCHAIN_KEY = "keychain:pipi_deliveries_account_enhancement_identity_v1";
const encoded = memory.get(KEYCHAIN_KEY);
assert.equal(typeof encoded, "string");
assert.equal(memory.get(SHARED_KEY), encoded);
for (const key of memory.keys()) if (!key.startsWith("keychain:")) memory.delete(key);
assert.equal(loadState(NOW + 2).bindings[0].enhancedMode, true);
assert.deepEqual(loadEnhancementIdentity(), original,
  "a Keychain-restored enhanced binding must recover the exact Samsung subscription identity");
assert.equal(generated, 1, "restoring a subscription must never generate another installation identity");

const identityFiles = () => [...memory.keys()].filter(key => key.includes("account-enhancement-identity-v1.json"));
assert.ok(identityFiles().length > 0, "Keychain restore heals the App Group copy");
assert.equal(memory.get(SHARED_KEY), encoded, "Keychain restore heals the shared mirror");

memory.delete(KEYCHAIN_KEY);
for (const key of identityFiles()) memory.delete(key);
assert.deepEqual(existingEnhancementIdentity(), original, "shared storage restores the exact subscription when its other copies are absent");
assert.equal(memory.get(KEYCHAIN_KEY), encoded);
assert.ok(identityFiles().length > 0);

memory.delete(KEYCHAIN_KEY);
memory.delete(SHARED_KEY);
assert.deepEqual(existingEnhancementIdentity(), original, "an existing pre-mirror identity migrates without rotation");
assert.equal(memory.get(KEYCHAIN_KEY), encoded);
assert.equal(memory.get(SHARED_KEY), encoded);

for (const key of identityFiles()) memory.set(key, "synthetic corrupt identity");
assert.deepEqual(existingEnhancementIdentity(), original, "a verified mirror recovers a corrupt durable identity");
memory.set(SHARED_KEY, "synthetic corrupt mirror");
memory.set(KEYCHAIN_KEY, "synthetic corrupt mirror");
assert.deepEqual(existingEnhancementIdentity(), original, "the verified App Group identity takes precedence over disagreeing mirrors");
assert.equal(memory.get(KEYCHAIN_KEY), encoded);
assert.equal(generated, 1);

const setShared = Storage.set, setKeychain = Keychain.set;
Storage.set = () => { throw new Error("synthetic shared mirror unavailable"); };
Keychain.set = () => { throw new Error("synthetic Keychain mirror unavailable"); };
assert.deepEqual(existingEnhancementIdentity(), original, "optional mirror failure cannot invalidate the durable original identity");
Storage.set = setShared;
Keychain.set = setKeychain;

for (const key of identityFiles()) memory.delete(key);
memory.delete(SHARED_KEY);
memory.delete(KEYCHAIN_KEY);
assert.equal(existingEnhancementIdentity(), null, "a non-creating read reports genuinely absent copies");
const restoredBinding = loadState(NOW + 3).bindings[0];
const ORDER = "3650000000000001";
const parcel: AccountParcelDto = { source: "interface5", ownerId: ORDER, orderId: ORDER, waybill: ORDER,
  accountOrder: true, courierCode: "JDKD", companyName: "京东商品快递", carrierNormalization: null,
  sourceProvider: "jingdong", sourceStateCode: "104", sourceStateText: "运输中", semantic: "TRANSIT",
  receiverPhone: PHONE, senderPhone: "", latestTimeText: "2026-10-20 10:00:00", latestDetail: "运输中",
  tracks: [], routeUrl: "", projectionUrl: "https://u.jd.com/synthetic" };
let requests = 0;
const [retained] = await enhanceAccountParcels([parcel], [restoredBinding], { request: async () => {
  requests++;
  return { records: [], ambiguousOrderIds: [] };
} });
assert.equal(requests, 0, "a restored binding with no original identity cannot query a fresh unrelated subscription");
assert.equal(retained.enhancedMode, true, "identity loss cannot silently undo the user's enhanced-mode choice");
assert.strictEqual(retained.tracks, parcel.tracks, "the base account remains usable during identity recovery");
assert.equal(retained.waybill, parcel.waybill);
await assert.rejects(() => enhancementOperation("unbind", PHONE), /重新验证绑定/);
assert.equal(generated, 1, "sync and unbind cannot create a replacement subscription identity");
assert.equal(existingEnhancementIdentity(), null);
const getKeychain = Keychain.get;
Keychain.get = () => { throw new Error("synthetic Keychain read unavailable"); };
assert.throws(() => existingEnhancementIdentity(), /身份读取失败/,
  "an unreadable mirror must not be mistaken for an absent identity");
assert.throws(() => loadEnhancementIdentity(), /身份读取失败/);
assert.equal(generated, 1, "an unavailable identity source cannot rotate the subscription identity");
Keychain.get = getKeychain;
assert.notDeepEqual(loadEnhancementIdentity(), original, "explicit verification may establish a new identity after total identity loss");
assert.equal(generated, 2);

console.log("Enhanced binding and subscription identity restore tests passed");
