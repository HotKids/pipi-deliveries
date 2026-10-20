import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { seedRecognizedCarriers } from "./carrier-recognition-seed";
import { parseAccountSyncResponse } from "../services/account-parser";
import { fetchAccountParcels, parcelToShipment } from "../services/account-sync";
import { ENHANCEMENT_ROUTE } from "../services/enhanced-account";
import { saveGatewayToken } from "../services/credentials";
import { emptyState, loadState, saveState } from "../services/storage";

const NOW = Date.UTC(2026, 9, 20, 10), PHONE = "13800001234", ORDER = "3650000000000001";
const WAYBILL = "JD0000000000001", IMAGE = "https://img10.360buyimg.com/product.jpg";
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(globalThis, { UUID: { string: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } });

let stateNumber = 104, enhancementRequests = 0, accountRequests = 0;
const response = () => ({ code: 0, data: { expressList: [{ mailNo: ORDER, cpCode: "JDKD",
  name: "京东商品快递", provider: "JingDong", stateNum: stateNumber, phone: PHONE,
  details: [{ time: "2026-10-20 17:59:00", desc: "Synthetic order event" }] }] } });
globalThis.fetch = (async (url: string, options: { body: string }) => {
  const path = new URL(url).pathname;
  let payload: unknown;
  if (path === "/api/express/accounts/sync") {
    accountRequests++;
    payload = response();
  } else {
    assert.equal(path, ENHANCEMENT_ROUTE, "the list test must not invoke unrelated providers");
    assert.deepEqual(JSON.parse(options.body).orders, [{ phone: PHONE, orderId: ORDER }]);
    enhancementRequests++;
    payload = { records: [{ phone: PHONE, orderId: ORDER, realWaybill: WAYBILL, imageUrl: IMAGE }], ambiguousOrderIds: [] };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
}) as typeof fetch;

function seed(projected = false) {
  memory.clear();
  enhancementRequests = accountRequests = 0;
  seedRecognizedCarriers({ [WAYBILL]: "JD" }, NOW);
  const parcel = parseAccountSyncResponse("interface5", response())[0];
  const stored = projected ? [parcelToShipment({ ...parcel, waybill: WAYBILL, enhancedMode: true,
    productImageURL: IMAGE, courierCode: "JD", companyName: "京东快递",
    carrierNormalization: { standardCode: "JD", displayName: "京东快递", kuaidi100Code: "jd", isBuiltIn: true } }, [PHONE], NOW)!] : [];
  saveState({ ...emptyState(), shipments: stored, bindings: [{ source: "interface5", phone: PHONE,
    boundAtMs: NOW - 86_400_000, enhancedMode: true, enhancedAtMs: NOW - 1_000 }] }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
}
async function fetchList() {
  const state = loadState();
  return fetchAccountParcels("interface5", state.bindings, NOW + 30_000, undefined, undefined, state.shipments);
}

for (const excluded of [101, 111]) {
  stateNumber = excluded;
  seed();
  const result = await fetchList();
  assert.equal(accountRequests, 1);
  assert.equal(enhancementRequests, 0, `the actual list path excludes raw stateNum ${excluded}`);
  assert.equal(result.parcels[0].enhancedMode, true);
  assert.equal(result.parcels[0].waybill, ORDER);
  assert.equal(result.parcels[0].productImageURL, undefined);
}

stateNumber = 103;
seed();
const missing = await fetchList();
assert.equal(enhancementRequests, 1, "the list requests a missing number for upstream 103 even though the UI may show ORDERED");
assert.equal(missing.parcels[0].waybill, WAYBILL);
assert.equal(missing.parcels[0].productImageURL, undefined, "a list number response does not acquire its accompanying product image");

stateNumber = 104;
seed(true);
const existing = await fetchList();
assert.equal(enhancementRequests, 0, "the caller restores a retained real waybill before deciding whether Samsung is needed");
assert.equal(existing.parcels[0].waybill, WAYBILL);
assert.equal(existing.parcels[0].productImageURL, IMAGE, "list refresh retains detail-acquired image metadata");

console.log("Enhanced list scheduling and retained-waybill restoration integration tests passed");
