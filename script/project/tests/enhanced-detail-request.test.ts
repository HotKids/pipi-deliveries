import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { ENHANCEMENT_ROUTE, loadEnhancementIdentity } from "../services/enhanced-account";
import { saveGatewayToken } from "../services/credentials";
import { emptyState, enableBindingEnhancement, loadState, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import { saveOrderProjectionReferences } from "../services/routes";

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
Object.assign(globalThis, {
  UUID: { string: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic" },
});
const parcel: AccountParcelDto = {
  source: "interface5", ownerId: ORDER, orderId: ORDER, waybill: ORDER, accountOrder: true,
  courierCode: "JDKD", rawCourierCode: "JDKD", companyName: "京东购物", carrierNormalization: null,
  sourceProvider: "JingDong", sourceStateCode: "101", sourceStateText: "已下单", semantic: "ORDERED",
  normalizedStatusScope: "ORDER", normalizedStatusSemantic: "ORDERED", normalizedStatusText: "已下单",
  receiverPhone: PHONE, senderPhone: "", latestTimeText: "2026-10-20 17:59:00", latestDetail: "等待出库",
  tracks: [{ timeText: "2026-10-20 17:59:00", detail: "等待出库", statusCode: "101" }],
  routeUrl: "", projectionUrl: "https://u.jd.com/synthetic", textIdentity: null,
};
let requests = 0, timelineCalls = 0, h5Calls = 0;
let responseGate: Promise<void> | null = null;
let requestStarted: (() => void) | null = null;
globalThis.fetch = (async (url: string, options: { body: string }) => {
  assert.equal(new URL(url).pathname, ENHANCEMENT_ROUTE, "this integration uses only its synthetic enhancement response");
  const body = JSON.parse(options.body);
  assert.equal(body.operation, "sync");
  assert.deepEqual(body.orders, [{ phone: PHONE, orderId: ORDER }]);
  requests++;
  requestStarted?.();
  if (responseGate) await responseGate;
  return { ok: true, status: 200, text: async () => JSON.stringify({ records: [
    { phone: PHONE, orderId: ORDER, realWaybill: WAYBILL, imageUrl: IMAGE },
  ], ambiguousOrderIds: [] }) };
}) as typeof fetch;

function seed(options: { marked?: boolean; image?: string; enhanced?: boolean; bound?: boolean } = {}) {
  memory.clear();
  requests = timelineCalls = h5Calls = 0;
  responseGate = null;
  requestStarted = null;
  const row = parcelToShipment({ ...parcel, ...(options.marked === false ? {} : { enhancedMode: true as const }),
    ...(options.image ? { productImageURL: options.image } : {}) }, [PHONE], NOW)!;
  const state = saveState({ ...emptyState(), shipments: [row], bindings: options.bound === false ? [] : [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86_400_000,
      ...(options.enhanced === false ? {} : { enhancedMode: true as const, enhancedAtMs: NOW - 1_000 }) },
  ] }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  loadEnhancementIdentity();
  saveOrderProjectionReferences([{ ownerId: row.identity.id, source: "interface5", url: parcel.projectionUrl }], NOW);
  return state.shipments[0];
}
const runtime = {
  refreshAccountParcel: async () => { timelineCalls++; return { ...parcel, enhancedMode: true as const }; },
  projectAccountOrderWithCarrier: async (input: AccountParcelDto) => { h5Calls++; return input; },
  refreshWebTimeline: async () => { timelineCalls++; return null; },
  refreshCainiaoH5: async () => { timelineCalls++; return null; },
  queryManualForSource: async () => { timelineCalls++; return { shipment: null, pending: null, routeUrl: "" }; },
};
const lease = { isCurrent: () => true, deadlineAtMs: NOW + 30_000 };

for (const trigger of ["identity_projection", "status_alignment"] as const) {
  const row = seed();
  await runShipmentRefreshForTesting(row.identity.id, lease,
    { trigger, forceAccountOrderProjection: true }, runtime);
  assert.equal(requests, 0, `${trigger} cannot fetch product images in the background`);
  assert.equal(h5Calls, 0, "an enabled same-phone enhancement binding blocks H5 number acquisition");
}

for (const marked of [true, false]) {
  const row = seed({ marked });
  const result = await runShipmentRefreshForTesting(row.identity.id, lease,
    { trigger: "product_image", requestProductImage: true }, runtime);
  assert.equal(requests, 1, "a visible detail page may acquire image metadata using the current enabled phone binding");
  assert.equal(timelineCalls, 0, "metadata-only detail entry does not query tracking");
  assert.equal(h5Calls, 0);
  assert.equal(result.shipment.identity.productImageURL, IMAGE);
  assert.equal(result.shipment.identity.projectedWaybill, "", "an image response cannot acquire its accompanying waybill");
  assert.equal(loadState().shipments[0].identity.productImageURL, IMAGE);
}

const cached = seed({ image: IMAGE });
await runShipmentRefreshForTesting(cached.identity.id, lease,
  { trigger: "product_image", requestProductImage: true }, runtime);
assert.equal(requests, 0, "retained image metadata does not trigger another Samsung request");
assert.equal(timelineCalls, 0);
assert.equal(h5Calls, 0);

for (const options of [{ bound: false }, { enhanced: false }] as const) {
  const row = seed(options);
  const result = await runShipmentRefreshForTesting(row.identity.id, lease,
    { trigger: "product_image", requestProductImage: true }, runtime);
  assert.equal(requests, 0, "a sticky row flag does not authorize requests after its phone binding is removed or unenhanced");
  assert.equal(result.shipment.identity.productImageURL, undefined);
  assert.equal(timelineCalls, 0);
  assert.equal(h5Calls, 0);
}

const raced = seed();
let releaseResponse!: () => void;
responseGate = new Promise(resolve => { releaseResponse = resolve; });
const started = new Promise<void>(resolve => { requestStarted = resolve; });
const pending = runShipmentRefreshForTesting(raced.identity.id, lease,
  { trigger: "product_image", requestProductImage: true }, runtime);
await started;
saveState({ ...loadState(), bindings: [] }, NOW);
releaseResponse();
const late = await pending;
assert.equal(requests, 1);
assert.equal(late.shipment.identity.productImageURL, undefined, "unbinding during a request fences the late image metadata commit");
assert.equal(loadState().shipments[0].identity.productImageURL, undefined);
assert.equal(timelineCalls, 0);
assert.equal(h5Calls, 0);

const waiting = seed({ marked: false, enhanced: false });
let pageLoads = 0, pageReservations = 0;
const skipped = await runShipmentRefreshForTesting(waiting.identity.id, lease,
  { trigger: "identity_projection", forceAccountOrderProjection: true }, {
    ...runtime,
    projectAccountOrderWithCarrier: async (input, _projectionDeadline, _recognitionDeadline, _observe, _signal, beforeLoad) => {
      pageReservations++;
      enableBindingEnhancement(PHONE, NOW - 86_400_000, NOW);
      beforeLoad?.();
      pageLoads++;
      return input;
    },
  });
assert.equal(pageReservations, 1, "the synthetic capture starts while the phone still uses ordinary binding");
assert.equal(pageLoads, 0, "enabling enhancement during the viewport wait prevents a new H5 number load");
assert.equal(skipped.shipment.identity.projectedWaybill, "");
assert.equal(loadState().shipments[0].identity.orderProjectionRetry, undefined,
  "a newly blocked page does not consume the order's H5 cooldown");
assert.equal(requests, 0);

const old = seed();
const projectedParcel: AccountParcelDto = { ...parcel, waybill: WAYBILL, courierCode: "JD", rawCourierCode: "JD",
  companyName: "京东快递", enhancedMode: true, sourceStateCode: "104", sourceStateText: "运输中", semantic: "TRANSIT",
  normalizedStatusScope: "SHIPMENT", normalizedStatusSemantic: "TRANSIT", normalizedStatusText: "运输中",
  carrierNormalization: { standardCode: "JD", displayName: "京东快递", kuaidi100Code: "jd", isBuiltIn: true } };
const projected = parcelToShipment(projectedParcel, [PHONE], NOW)!;
saveState({ ...loadState(), shipments: [projected] }, NOW);
const repaired = await runShipmentRefreshForTesting(old.identity.id, lease,
  { trigger: "detail_pull", forceManualRefresh: true }, {
    ...runtime,
    projectAccountOrderWithCarrier: async (input: AccountParcelDto) => {
      h5Calls++;
      return { ...input, waybill: WAYBILL, projectionTimeline: {
        provider: "jd_h5", waybill: WAYBILL, courierCode: "JD", companyName: "京东快递", semantic: "UNKNOWN",
        structuredStatus: false, complete: true, successAtMs: NOW,
        latestTimeText: "2026-10-20 18:00:00", latestDetail: "运输途中",
        tracks: [
          { timeText: "2026-10-20 18:00:00", timeMs: NOW, detail: "运输途中", statusCode: "", raw: { _pipiStatusSource: "jingdong_h5" } },
          { timeText: "2026-10-20 17:50:00", timeMs: NOW - 600_000, detail: "京东快递 已揽收", statusCode: "", raw: { _pipiStatusSource: "jingdong_h5" } },
        ],
      } };
    },
  });
assert.equal(requests, 0, "an existing waybill does not query Samsung during a history pull");
assert.equal(h5Calls, 1, "an enhanced order with a retained real waybill keeps its permitted H5 history supplement");
assert.equal(repaired.shipment.identity.projectedWaybill, WAYBILL);
assert.ok(repaired.shipment.manualTimelines?.some(pack => pack.provider === "jd_h5"));

console.log("Enhanced visible-detail metadata and background request isolation tests passed");
