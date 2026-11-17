import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, privateDecrypt, randomBytes, constants } from "node:crypto";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { Shipment } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { code128Widths } from "../services/code128";
import { encryptFengchaoChallenge } from "../services/fengchao-rsa";
import {
  accountStatus, clearPlatformLogin, currentPlatformSession, notePlatformSync, platformAccountSubtitle, platformSession, savePlatformLogin,
  trustedPlatformPage,
} from "../services/platform-accounts";
import { identityCodeFromResponse, fetchStationIdentity } from "../services/platform-wire";
import { cainiaoHandoffs, cainiaoRecipientParcels, displayDeliveryEstimate, pddPickupParcels } from "../services/platform-parcel-data";
import { cabinetParcels, type CabinetParcel } from "../services/fengchao-account";
import { displayedPlatformFields, enrichPlatformParcel, matchPlatformParcel } from "../services/platform-parcel-merge";
import { activePickupCards, parcelActivityContent, shipmentForPickupTarget } from "../services/parcel-pickup";
import { registerProjectionViewportHost } from "../services/projection-viewport";

const {
  completeCurrentParcelCard, emptyState, loadState, savePlatformParcelData, saveRecognizedParcelCode, saveState,
  setPickupCardNote, visibleShipments,
} = await import("../services/storage");
const { canOpenParcelCabinet, performPickupAction, platformRefreshMessage, refreshPlatformParcels } =
  await import("../services/platform-parcel-sync");

const waybill = "YT000000008123";
const order = "88000008123";
const key = "synthetic-cainiao-account";
const pickupInput = { source: "cainiao", waybill, code: "1-5-0012", name: "测试菜鸟驿站", address: "测试路 1 号" } as const;
const rediscovered = cainiaoRecipientParcels({ packages: [{
  status: "WAIT_PICKUP", mailNo: waybill, tbOrderId: order,
  packageItem: [{ itemTitle: "示例商品" }],
  packageStation: { authCode: "NEED_SMS", showPickupCode: "１-５-００１２", pointName: "测试菜鸟驿站", address: "测试路 1 号" },
  packageDyn: { arriveTime: "预计明天送达" },
}] }, NOW);

function shipment(overrides: Partial<Shipment> = {}): Shipment {
  return {
    identity: { id: "parcel-fixture", bindingSource: null, sourceOwner: "manual", sourceId: waybill, phoneTail: "",
      courierCode: "YTO", companyName: "圆通速递", manuallyAdded: true, createdAtMs: NOW - 20_000 },
    timeline: {
      provider: "picker", waybill, courierCode: "YTO", companyName: "圆通速递", semantic: "WAITING_PICKUP",
      statusEventAtMs: NOW - 10_000, latestTimeText: "2026-09-08 13:59", latestDetail: "快递已到驿站",
      tracks: [{
        timeMs: NOW - 10_000, timeText: "2026-09-08 13:59", detail: "快递已到驿站", statusCode: "", raw: {},
      }], successAtMs: NOW - 10_000,
    },
    updatedAtMs: NOW - 10_000, ...overrides,
  };
}

let generation = 0;
Object.assign(globalThis, { UUID: { string: () => "generation-" + ++generation } });
const sessionCookie = {
  name: "PDDAccessToken", value: "synthetic-pdd-session", domain: ".pinduoduo.com",
  path: "/", isSecure: true, isHTTPOnly: true, isSessionOnly: true,
};

test("the account subtitle keeps a nickname or masked label and the local sync date and time", () => {
  memory.clear();
  const syncedAt = new Date(2026, 10, 17, 9, 7).getTime();
  const credentials = { kind: "web", cookies: [sessionCookie] } as const;
  savePlatformLogin("pinduoduo", "", credentials, "synthetic-account-0123", "示例昵称");
  const pdd = accountStatus("pinduoduo");
  assert.equal(platformAccountSubtitle(pdd), "示例昵称 · 尚未同步");
  notePlatformSync("pinduoduo", pdd.generation, syncedAt);
  assert.equal(platformAccountSubtitle(accountStatus("pinduoduo")), "示例昵称 · 11-17 09:07");
  clearPlatformLogin("pinduoduo", pdd.generation, true);
  assert.equal(platformAccountSubtitle(accountStatus("pinduoduo")), "示例昵称 · 请重新登录");
  savePlatformLogin("cainiao", "", credentials, "synthetic-account-4321");
  const cainiao = accountStatus("cainiao");
  notePlatformSync("cainiao", cainiao.generation, syncedAt);
  assert.equal(platformAccountSubtitle(accountStatus("cainiao")), "账号 ****4321 · 11-17 09:07");
});

test("recipient field aliases, placeholder rejection and station address", () => {
  assert.equal(rediscovered.length, 1);
  assert.deepEqual(rediscovered[0], {
    ...pickupInput, orderIds: [order], title: "示例商品", estimate: "预计明天送达", unnumbered: false,
    carrierCode: "", carrierName: "",
  });
  assert.equal(cainiaoRecipientParcels({ packages: [{
    status: "SIGNED", mailNo: waybill, packageStation: { authCode: "12345" },
  }] }, NOW).length, 0);
  const pdd = pddPickupParcels({ result: { station_name: "页面标题", only_wx_scan: true, combine_list: [{
    company_name: "包裹所属多多驿站", address: "测试路 12 号", combine_track_list: [{ tracking_number: waybill }],
  }] } });
  assert.equal(pdd[0].name, "包裹所属多多驿站");
  assert.equal(pdd[0].code, "");
  const existing = enrichPlatformParcel(shipment(), pickupInput, NOW);
  assert.deepEqual(enrichPlatformParcel(existing, pdd[0], NOW + 5), existing);
});

test("ETA keeps the first observation and disappears after the expected day or pickup", () => {
  const moving = shipment({ timeline: { ...shipment().timeline, semantic: "TRANSIT" } });
  const first = enrichPlatformParcel(moving, rediscovered[0], NOW);
  const repeated = enrichPlatformParcel(first, rediscovered[0], NOW + 86_400_000);
  assert.equal(first.platformFields?.estimate?.capturedAtMs, NOW);
  assert.equal(repeated.platformFields?.estimate?.capturedAtMs, NOW);
  assert.deepEqual(displayedPlatformFields(repeated, NOW + 86_400_000), {
    title: "示例商品", estimate: "预计9月9日送达",
  });
  assert.equal(displayDeliveryEstimate("预计明天送达", NOW, NOW + 2 * 86_400_000), "");
  assert.equal(displayedPlatformFields({ ...repeated, timeline: shipment().timeline }, NOW).estimate, "");
});

test("cloud metadata fills same-parcel gaps with its original observation and preserves manual titles", () => {
  const moving = shipment({ timeline: { ...shipment().timeline, semantic: "TRANSIT" } });
  const metadata = { waybill, productName: "示例云商品", anchorAt: NOW - 3_600_000,
    deliveryEstimate: "预计明天送达", deliveryEstimateObservedAt: NOW - 86_400_000 };
  assert.deepEqual(displayedPlatformFields(moving, NOW, metadata), {
    title: "示例云商品", estimate: "预计9月8日送达",
  });
  const manual = { ...moving, platformFields: {
    waybill, waybillGeneration: 0, manualTitle: "示例手动名称",
  } };
  assert.equal(displayedPlatformFields(manual, NOW, metadata).title, "示例手动名称");
  assert.equal(displayedPlatformFields(moving, NOW, { ...metadata, waybill: "MISMATCH123" }).title ?? "", "");
  assert.equal(displayedPlatformFields(moving, NOW, { ...metadata, anchorAt: NOW - 4 * 86_400_000,
    terminalAt: NOW - 3 * 86_400_000 }).title ?? "", "");
  assert.equal(displayedPlatformFields(shipment(), NOW, metadata).estimate, "");
});

test("only same-order uniquely verified waybill reaches a waiting Cainiao order", () => {
  const base = shipment();
  const orderOwner = shipment({
    identity: { ...base.identity, sourceId: order, orderId: order, sourceProvider: "cainiao", accountOrder: true },
    timeline: { ...base.timeline, waybill: order },
  });
  const observed = { ...rediscovered[0], carrierCode: "YTO", carrierName: "圆通速递" };
  assert.equal(matchPlatformParcel([orderOwner], observed, key), orderOwner);
  assert.equal(matchPlatformParcel([orderOwner, { ...orderOwner, identity: { ...orderOwner.identity, id: "split" }}],
    observed, key), undefined);
  const projected = enrichPlatformParcel(orderOwner, observed, NOW);
  assert.equal(projected.identity.projectedWaybill, waybill);
  assert.equal(parcelActivityContent(projected)?.code, pickupInput.code);
});

test("signed, removed and reused waybills cannot acquire a late recipient code", () => {
  for (const replacement of ["completed", "removed", "reused"]) {
    memory.clear();
    const original = saveState({ ...emptyState(), shipments: [shipment()] }, NOW);
    const saved = original.shipments[0];
    const next = replacement === "removed" ? [] : [{
      ...saved,
      ...(replacement === "completed" ? { forcedCompletedAtMs: NOW + 5 } : { waybillReuseAtMs: NOW + 5 }),
    }];
    saveState({ ...original, shipments: next }, NOW + 5);
    const result = savePlatformParcelData({ observed: original, owner: key, current: () => true, parcels: rediscovered }, NOW + 10);
    assert.equal(activePickupCards(visibleShipments(result.state), result.state.pickupCodeRecords).length, 0);
    assert.equal(result.state.shipments[0]?.pickup, undefined);
  }
});

test("genuinely unnumbered Cainiao pickup is separate and never revived after completion", () => {
  memory.clear();
  const original = saveState({ ...emptyState(), shipments: [shipment()] }, NOW);
  const rows = cainiaoRecipientParcels({ packages: [
    { packageStation: { authCode: "A1234", pointName: "示例驿站" } },
    { mailNo: "YT000000008985", packageStation: { authCode: "B1234", pointName: "示例驿站" } },
  ] }, NOW);
  const input = { observed: original, owner: key, current: () => true, parcels: rows };
  const result = savePlatformParcelData(input, NOW + 1000).state;
  assert.equal(result.shipments.length, 1);
  assert.equal(result.pickupCodeRecords?.length, 1);
  const [card] = activePickupCards(visibleShipments(result), result.pickupCodeRecords);
  assert.equal(card.title, "菜鸟驿站");
  assert.equal(card.code, "A1234");
  completeCurrentParcelCard(card, NOW + 2000);
  const repeated = savePlatformParcelData(input, NOW + 3000).state;
  assert.equal(repeated.pickupCodeRecords?.[0].completedAtMs, NOW + 2000);
  assert.equal(activePickupCards(visibleShipments(repeated), repeated.pickupCodeRecords).length, 0);
});

test("active doorstep appointments carry absolute windows and terminal statuses are excluded", () => {
  const input = { appointmentId: "return-order-synthetic", sendCode: "8001", appointTimeStr: "09-08 16:00–18:00 上门" };
  const result = cainiaoHandoffs({ sendPackages: [
    { status: "WAIT_GOT", appointment: { ...input, appointStatus: "APPOINTED" } },
    { status: "已揽收", appointment: { ...input, appointStatus: "APPOINTED" } },
    { status: "WAIT_GOT", appointment: { ...input, appointTimeStr: "" } },
  ] }, key, NOW);
  assert.equal(result.length, 1);
  assert.equal(result[0].code, "8001");
  assert.equal(result[0].windowStartAtMs, Date.UTC(2026, 8, 8, 8));
  assert.equal(result[0].windowEndAtMs, Date.UTC(2026, 8, 8, 10));
});

test("pickup detail and note writes follow the matching waybill generation", () => {
  memory.clear();
  const state = saveState({ ...emptyState(), shipments: [shipment({ pickup: {
    platform: "cainiao", waybill, waybillGeneration: 0, code: "1-2-3456", capturedAtMs: NOW - 1000,
  } })] }, NOW);
  const visible = visibleShipments(state, NOW);
  const card = activePickupCards(visible)[0];
  const linked = shipmentForPickupTarget(visible, card.target)!;
  assert.equal(linked.identity.id, "interface5:manual:" + waybill);
  assert.equal(shipmentForPickupTarget([{ ...linked, waybillReuseAtMs: NOW }], card.target), undefined);
  const saved = setPickupCardNote(card, "", "  到站后检查  ", NOW + 1);
  assert.equal(saved.shipments[0].note, "到站后检查");
  assert.throws(() => setPickupCardNote(card, "", "旧编辑器", NOW + 2));
  assert.equal(setPickupCardNote(card, "到站后检查", "", NOW + 3).shipments[0].note, undefined);
});

test("a handoff note survives provider refresh and cannot edit a completed card", async (t) => {
  memory.clear();
  t.mock.method(Date, "now", () => NOW + 100);
  const record = {
    id: "synthetic-handoff-note", kind: "handoff", platform: "cainiao", code: "4100", capturedAtMs: NOW,
    windowEndAtMs: NOW + 30_000, windowText: "09-08 14:00–15:00 上门",
  } as const;
  const state = saveRecognizedParcelCode(record, NOW);
  const card = activePickupCards([], state.pickupCodeRecords)[0];
  assert.equal(shipmentForPickupTarget([], card.target), undefined);
  const noted = setPickupCardNote(card, "", "退换货", NOW + 1);
  const refreshed = savePlatformParcelData({
    observed: noted, owner: key, parcels: [], handoffs: [{ ...record, windowEndAtMs: NOW + 60_000 }],
    current: () => true,
  }, NOW + 2).state;
  assert.equal(refreshed.pickupCodeRecords?.find(({ id }) => id === record.id)?.note, "退换货");
  assert.equal(await performPickupAction(card, false, () => {}), "已寄件");
  assert.throws(() => setPickupCardNote(card, "退换货", "迟到备注", NOW + 101));
});

test("Taobao station identity follows the H5 response and refresh cadence", () => {
  const value = "CS00000000000000001A";
  for (const field of ["result", "data"]) {
    assert.deepEqual(identityCodeFromResponse("cainiao", { [field]: { identityCode: value } }, NOW),
      { value, expiresAtMs: NOW + 180_000 });
  }
  assert.throws(() => identityCodeFromResponse("cainiao",
    { model: { identityCode: value, expireTime: 30 } }, NOW));
  assert.throws(() => identityCodeFromResponse("cainiao",
    { result: { unrelatedCode: value } }, NOW));
});

test("PDD identity uses the provider lifetime and standard Code 128 symbols", () => {
  assert.deepEqual(identityCodeFromResponse("pinduoduo", { result: { identification_code: "PD123456", expire_mills: 30_000 } }, NOW),
    { value: "PD123456", expiresAtMs: NOW + 30_000 });
  assert.throws(() => identityCodeFromResponse("pinduoduo",
    { result: { identification_code: "012345", expire_mills: true } }, NOW));
  assert.throws(() => identityCodeFromResponse("pinduoduo", { result: { identification_code: "跨", expire_mills: 10 } }, NOW));
  assert.equal(code128Widths("123456").join(""), "2112321122321311233311211321312331112");
  assert.equal(trustedPlatformPage("pinduoduo", "https://mobile.yangkeduo.com/orders.html"), true);
  assert.equal(trustedPlatformPage("pinduoduo", "https://mobile.yangkeduo.com.example.invalid/orders.html"), false);
});

test("the Cainiao action requests the Taobao identity with the current account only", async (t) => {
  memory.clear();
  const cookie = { ...sessionCookie, name: "cookie2", domain: ".taobao.com", value: "synthetic-taobao-session" };
  savePlatformLogin("cainiao", "", { kind: "web", cookies: [cookie] }, "synthetic-taobao-account");
  const session = platformSession("cainiao")!;
  t.mock.method(Date, "now", () => NOW);
  const previousCrypto = globalThis.Crypto;
  const value = "CS00000000000000001A";
  const read = (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.hostname, "h5api.m.taobao.com");
    assert.equal(url.searchParams.get("api"), "mtop.cainiao.pickup.identity.getIdentityMessage");
    assert.deepEqual(JSON.parse(url.searchParams.get("data")!), {});
    assert.equal((init.headers as Record<string, string>).Cookie, "cookie2=synthetic-taobao-session");
    return new Response(JSON.stringify({ ret: ["SUCCESS::ok"], data: { result: { identityCode: value } } }));
  };
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => read(input, init));
  try {
    Object.assign(globalThis, { Crypto: { ...previousCrypto,
      md5: (data: string) => ({ toHexString: () => createHash("md5").update(data).digest("hex") }),
    } });
    assert.deepEqual(await fetchStationIdentity("cainiao", session), { value, expiresAtMs: NOW + 180_000 });
    fetchMock.mock.mockImplementationOnce(async (input: string, init: RequestInit) => {
      const response = read(input, init);
      clearPlatformLogin("cainiao", session.generation);
      return response;
    });
    await assert.rejects(fetchStationIdentity("cainiao", session), /changed/);
  } finally {
    Object.assign(globalThis, { Crypto: previousCrypto });
  }
});

test("old PDD identity response after logout cannot create an active code or clear a newer account", async () => {
  memory.clear();
  savePlatformLogin("pinduoduo", "", { kind: "web", cookies: [sessionCookie] }, "synthetic-account-one");
  const first = platformSession("pinduoduo")!;
  let respond!: (result: Response) => void;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => { respond = resolve; });
  try {
    const request = fetchStationIdentity("pinduoduo", first);
    clearPlatformLogin("pinduoduo", first.generation);
    const loggedOut = accountStatus("pinduoduo");
    savePlatformLogin("pinduoduo", loggedOut.generation, { kind: "web", cookies: [sessionCookie] }, "synthetic-account-two");
    respond(new Response(JSON.stringify({ result: { identification_code: "A12345", expire_mills: 30_000 } })));
    await assert.rejects(request, /changed/);
    assert.notEqual(platformSession("pinduoduo")?.generation, first.generation);
    assert.equal(currentPlatformSession("pinduoduo", first.generation), null);
  } finally { globalThis.fetch = realFetch; }
});

for (const loadCompleted of [true, false]) {
  test(`JD reads authenticated orders with native load completion=${loadCompleted}`, { timeout: 2_500 }, async () => {
    memory.clear();
    const cookie = { ...sessionCookie, name: "pt_key", value: "synthetic-jd-session", domain: ".jd.com" };
    savePlatformLogin("jingdong", "", { kind: "web", cookies: [cookie] }, "synthetic-jd-account");
    let enteredOrders = false;
    const title = { textContent: "示例商品" };
    const orderData = { getAttribute: () => JSON.stringify({ orderid: order }) };
    const card = {
      querySelector: (selector: string) => selector.includes("order_item") ? title : null,
      querySelectorAll: (selector: string) => selector.includes("order_state") ? [state]
        : selector.includes("data-eparam") ? [orderData] : [title],
    };
    const state = { parentElement: card, textContent: "待收货" };
    const originalController = globalThis.WebViewController;
    Object.assign(globalThis, { WebViewController: class {
      async setCookie() { return true; }
      async loadURL(url: string) {
        assert.equal(url, "https://my.m.jd.com/index.html?sceneval=2");
        return loadCompleted;
      }
      async evaluateJavaScript(script: string) {
        const window = { top: {} };
        window.top = window;
        const document = {
          // The account page can contain a security settings link alongside the order entry.
          body: { innerText: enteredOrders ? "待收货" : "我的京东 全部订单 账号安全验证" },
          querySelectorAll: () => enteredOrders ? [state] : [],
          querySelector: (selector: string) => !enteredOrders && selector === ".my_order_entrance.type_orders"
            ? { click: () => { enteredOrders = true; } } : null,
        };
        return runInNewContext(`(() => {${script}})()`, {
          window, document, location: new URL(enteredOrders
            ? "https://trade.m.jd.com/order/orderlist_jdm.shtml" : "https://my.m.jd.com/index.html?sceneval=2"),
        });
      }
      dispose() {}
    } });
    registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
    try {
      const result = await refreshPlatformParcels(() => {}, "manual", "jingdong");
      assert.equal(result.succeeded, 1);
      assert.deepEqual(result.issues, []);
      assert.equal(enteredOrders, true);
      assert.ok(accountStatus("jingdong").syncedAtMs);
    } finally {
      globalThis.WebViewController = originalController;
      registerProjectionViewportHost(null);
    }
  });
}

test("PDD waiting pickup sync survives an unavailable order-capture host", async (t) => {
  t.mock.method(Date, "now", () => NOW + 2);
  memory.clear();
  saveState({ ...emptyState(), shipments: [shipment()] }, NOW);
  savePlatformLogin("pinduoduo", "", { kind: "web", cookies: [sessionCookie] }, "synthetic-account");
  const originalFetch = globalThis.fetch;
  const originalController = globalThis.WebViewController;
  Object.assign(globalThis, { WebViewController: class {
    async setCookie() { return true; }
    dispose() {}
  } });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  let stationRequests = 0;
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, "https://api.pinduoduo.com/api/express_trackbox/station/package");
    stationRequests++;
    return new Response(JSON.stringify({ result: { combine_list: [{
      company_name: "示例多多驿站", combine_track_list: [{ tracking_number: waybill, pick_code: "5112" }],
    }] } }));
  }) as typeof fetch;
  try {
    const progress: string[] = [];
    const result = await refreshPlatformParcels(() => {}, "manual", "pinduoduo",
      (source, running) => progress.push(`${source}:${running}`));
    assert.equal(stationRequests, 1);
    assert.equal(loadState().shipments[0].pickup?.code, "5112");
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(progress, ["pinduoduo:true", "pinduoduo:false"]);
    assert.equal(platformRefreshMessage(result), "部分同步完成，拼多多同步未完成，请稍后重试");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebViewController = originalController;
    registerProjectionViewportHost(null);
  }
});

test("PDD reads station data for a parcel that becomes eligible during order capture", async (t) => {
  t.mock.method(Date, "now", () => NOW + 2_000);
  memory.clear();
  const original = saveState({ ...emptyState(), shipments: [shipment({
    timeline: { ...shipment().timeline, semantic: "TRANSIT" },
  })] }, NOW);
  savePlatformLogin("pinduoduo", "", { kind: "web", cookies: [sessionCookie] }, "synthetic-account");
  const originalFetch = globalThis.fetch;
  const originalController = globalThis.WebViewController;
  Object.assign(globalThis, { WebViewController: class {
    async setCookie() { return true; }
    async addUserScript() { return "synthetic-script"; }
    async loadURL() {
      saveState({ ...original, shipments: [shipment()] }, NOW + 1_000);
      return true;
    }
    async evaluateJavaScript() { return []; }
    dispose() {}
  } });
  registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });
  let stationRequests = 0;
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, "https://api.pinduoduo.com/api/express_trackbox/station/package");
    stationRequests++;
    return new Response(JSON.stringify({ result: { combine_list: [{
      combine_track_list: [{ tracking_number: waybill, pick_code: "5112" }],
    }] } }));
  }) as typeof fetch;
  try {
    const result = await refreshPlatformParcels(() => {}, "observe", "pinduoduo");
    assert.equal(stationRequests, 1);
    assert.equal(loadState().shipments[0].pickup?.code, "5112");
    assert.equal(result.failed, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebViewController = originalController;
    registerProjectionViewportHost(null);
  }
});

function sampleCabinet(): CabinetParcel {
  return cabinetParcels({ cabinets: [{
    cabinetCode: "TEST-01", cabinetName: "测试丰巢柜", address: "测试路 1 号",
    boxes: [{ boxId: "TEST-02", location: "右侧", packages: [{ code: "9246", expressId: waybill, postId: "TEST-03" }] }],
  }] }, "13000000000")[0];
}

test("cabinet opening requires a live association after confirmation and submits one request", async (t) => {
  t.mock.method(Date, "now", () => NOW + 2);
  memory.clear();
  const seed = saveState({ ...emptyState(), shipments: [shipment()] }, NOW);
  const parcel = sampleCabinet();
  const credentials = { kind: "cabinet", token: "fixture", flag: "", userAuth: "", mobile: "13000000000", clientIp: "" } as const;
  savePlatformLogin("fengchao", "", credentials, credentials.mobile);
  const session = platformSession("fengchao")!;
  const committed = savePlatformParcelData({ observed: seed, owner: session.ownerKey, current: () => true,
    parcels: [], cabinets: [parcel] }, NOW + 1);
  assert.equal(committed.state.shipments[0].pickup?.code, "9246");
  notePlatformSync("fengchao", session.generation, NOW + 1, { cabinetLinks: committed.cabinetLinks });
  const [card] = activePickupCards(visibleShipments(committed.state), committed.state.pickupCodeRecords);
  assert.ok(canOpenParcelCabinet(card));
  let calls = 0;
  let allow!: (selected: boolean) => void;
  Object.assign(globalThis, { Dialog: { confirm: () => new Promise((resolve) => { allow = resolve; }) } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    assert.equal(url, "https://consumer.fcbox.com/post/clientGet/openBox");
    assert.equal(options.method, "POST");
    calls++;
    return new Response('{"code":0,"success":true}');
  }) as typeof fetch;
  try {
    const first = performPickupAction(card, true, () => {});
    assert.match(await performPickupAction(card, true, () => {}), /正在请求开柜/);
    allow(false);
    assert.equal(await first, "");
    const confirmed = performPickupAction(card, true, () => {});
    allow(true);
    assert.match(await confirmed, /开柜请求已受理/);
    assert.equal(calls, 1);
    assert.equal(loadState().shipments[0].forcedCompletedAtMs, undefined);
    const stale = performPickupAction(card, true, () => {});
    clearPlatformLogin("fengchao", session.generation);
    allow(true);
    assert.match(await stale, /状态已变更/);
    assert.equal(calls, 1);
    assert.equal(canOpenParcelCabinet(card), false);
  } finally { globalThis.fetch = realFetch; }
});

test("Fengchao challenge uses a real PKCS#1 v1.5 encoded block with random nonzero padding", () => {
  const previousCrypto = globalThis.Crypto;
  const previousData = globalThis.Data;
  function makeData(buffer: Buffer) {
    return {
      toArrayBuffer: () => Uint8Array.from(buffer).buffer,
      toBase64String: () => buffer.toString("base64"),
    };
  }
  Object.assign(globalThis, {
    Data: { fromRawString: (text: string) => makeData(Buffer.from(text)),
      fromBase64String: (value: string) => makeData(Buffer.from(value, "base64")),
      fromUint8Array: (value: Uint8Array) => makeData(Buffer.from(value)),
    },
    Crypto: {
      md5: (value: string) => createHash("md5").update(value),
      generateSymmetricKey: (size: number) => makeData(randomBytes(size / 8)),
    },
  });
  try {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const plain = "synthetic challenge message";
    const encrypted = Buffer.from(encryptFengchaoChallenge(plain, spki), "base64");
    const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encrypted);
    assert.deepEqual([...block.subarray(0, 2)], [0, 2]);
    const delimiter = block.indexOf(0, 2);
    assert.ok(delimiter >= 10);
    assert.equal(block.subarray(delimiter + 1).toString(), plain);
  } finally { Object.assign(globalThis, { Crypto: previousCrypto, Data: previousData }); }
});
