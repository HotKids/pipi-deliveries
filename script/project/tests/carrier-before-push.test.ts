import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";

import type { AppState, Shipment } from "../models";
import { parseAccountSyncResponse, type AccountParcelDto } from "../services/account-parser";
import { accountOrderTextIdentity } from "../services/account-order-text-identity";
import {
  normalizeAccountParcelCarrierBestEffort,
  parcelToShipment,
  withAccountOrderTextWaybill,
} from "../services/account-sync";
import { normalizeAccountParcelCarrier } from "../services/account-carrier-normalization";
import {
  cachedCarrierRecognition,
  recognizeNonSyncCarrier,
  type CarrierRecognitionEntry,
  type CarrierRecognitionStore,
} from "../services/carrier-recognition";
import { carrierAwaitingRecognition } from "../services/carrier-gate";
import { detectManualCarrier } from "../services/manual-query";
import { saveGatewayToken } from "../services/credentials";
import { OperationTimeoutError } from "../services/deadline";
import { replayPendingShipmentNotifications } from "../services/notifications";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { saveOrderProjectionReferences } from "../services/routes";
import { applyAccountShipment } from "../services/shipment-policy";
import { shipmentPresentationStatus } from "../services/status";
import { commitRefreshState, emptyState, loadState, saveState } from "../services/storage";
import {
  projectStoredAccountOrders,
  refreshAllShipments,
  runShipmentEnrichmentForTesting,
  runShipmentRefreshForTesting,
} from "../services/sync";
import { seedRecognizedCarriers } from "./carrier-recognition-seed";

// 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28、29）：一票件一有运单号，同一轮先把承运商识别跑完（内置表 →
// 快递100 免费识别 → 付费快递鸟）再落库、上列表、推送；识别不出来时这一票保持原样（订单行仍是「京东购物 · 已下单」），
// 不推承运商空白的状态或通知，识别出来的那一轮再推这条变化。表外承运商显示快递100 给的名字，只作显示。
// 用户原话：「不应该是有运单号之后就立即查询承运商吗 不应该推空白承运商的状态」「出现运单号之后需要匹配上承运商才推送
// 而不是推空白承运商的通知或状态」。

const PHONE = "13800002323";
const DAY = 86400000;
const MINUTE = 60000;
let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
const scheduled: Array<{ title: string; body: string }> = [];
let captures = 0;
let page: Record<string, unknown> = {};
Object.assign(globalThis, {
  Notification: { schedule: async (request: { title: string; body: string }) => { scheduled.push(request); } },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    constructor() { captures++; }
    async loadURL() { return true; }
    async evaluateJavaScript() { return { extractionSource: "probe", ...page, traceList: [] }; }
    dispose() {}
  },
});
registerProjectionViewportHost({ mount: async () => false, unmount: () => {} });

/**
 * Kuaidi100's free recognizer: `null` answers 503 (a network failure), "timeout" never answers in time, otherwise
 * these candidates.
 */
let autoComNum: null | "timeout" | Array<{ comCode: string; name: string }> = null;
let listRecords: unknown[] = [];
const requests: string[] = [];
globalThis.fetch = (async (url: string) => {
  const { hostname, pathname } = new URL(url);
  if (hostname === "www.kuaidi100.com" && pathname === "/autonumber/autoComNum") {
    requests.push("autoComNum");
    if (autoComNum === "timeout") throw Object.assign(new Error("Synthetic timeout"), { name: "TimeoutError" });
    return autoComNum
      ? { ok: true, status: 200, text: async () => JSON.stringify({ auto: autoComNum }) }
      : { ok: false, status: 503, text: async () => "Synthetic offline" };
  }
  if (pathname === "/api/express/accounts/sync") {
    requests.push("account_list");
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: listRecords } }) };
  }
  if (pathname === "/api/express/classify") requests.push("worker_classify");
  return { ok: false, status: 503, text: async () => "Synthetic offline" };
}) as typeof fetch;

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

function seed(rows: Shipment[]): void {
  clock = NOW;
  memory.clear();
  scheduled.length = 0;
  requests.length = 0;
  captures = 0;
  autoComNum = null;
  saveState({
    ...emptyState(),
    shipments: rows,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - DAY }],
    feedSlotRebuiltAtMs: NOW - DAY,
  }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
}

function rowFrom(record: unknown, at = NOW - 3600000): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], at)!, at);
}

const titles = () => scheduled.map((request) => request.title);
const stored = (id: string) => loadState().shipments.find((shipment) => shipment.identity.id === id)!;

// 1. 通知挂起（已排队的通知不得带空白承运商）：承运商未对上的状态变化不排可投递事件，也不投递；承运商对上的那次存盘按当时
//    的行重新生成标题再放行。
{
  const waybill = "JT4006839560001";
  const record = (stateNum: number, at: number, desc: string) => ({
    mailNo: waybill, provider: "JingDong", cpCode: "JDKD", name: "京东快递", phone: PHONE, stateNum,
    details: [{ time: providerTime(at), desc }],
  });
  // R-20: the JD platform label on a non-JD waybill is no carrier — the row shows none until recognition matches.
  const blank = (shipment: Shipment): Shipment => ({
    ...shipment,
    identity: { ...shipment.identity, courierCode: "", companyName: "" },
  });
  const transit = blank(rowFrom(record(104, NOW - DAY, "快件已到达【杭州转运中心】")));
  const delivering = blank(rowFrom(record(105, NOW - 3600000, "【上海市】快件正在派送中"), NOW));
  assert.equal(carrierAwaitingRecognition(delivering), true);
  seed([transit]);
  const commit = (next: Shipment, batchId: string) => {
    const base = loadState();
    const context = {
      previousById: new Map(base.shipments.map((shipment) => [shipment.identity.id, shipment])),
      batchId,
    };
    return commitRefreshState(base, { ...base, shipments: [next] }, "interface5", clock, undefined, context).state;
  };
  let state: AppState = commit(delivering, "round-1");
  assert.equal(state.pendingNotifications?.length, 1);
  assert.equal(state.pendingNotifications?.[0]?.awaitingCarrier, true, "a blank-carrier change waits for its carrier");
  await replayPendingShipmentNotifications();
  assert.deepEqual(titles(), [], "a held event is never delivered with a blank carrier");
  assert.equal(loadState().pendingNotifications?.length, 1, "nor acknowledged away");

  // The next round matches the carrier and changes nothing else: the held change goes out, with the carrier.
  clock = NOW + 16 * MINUTE;
  const recognized: Shipment = {
    ...delivering,
    identity: { ...delivering.identity, courierCode: "JTSD", companyName: "极兔速递" },
  };
  state = commit(recognized, "round-2");
  assert.equal(state.pendingNotifications?.length, 1);
  assert.equal(state.pendingNotifications?.[0]?.awaitingCarrier, undefined);
  assert.equal(state.pendingNotifications?.[0]?.title, "极兔速递 0001 · 派送中");
  await replayPendingShipmentNotifications();
  assert.deepEqual(titles(), ["极兔速递 0001 · 派送中"]);
  assert.deepEqual(loadState().pendingNotifications || [], []);

  // Still unmatched in a later round: one held obligation per row, whatever else changes meanwhile.
  seed([transit]);
  commit(delivering, "round-1");
  clock = NOW + 16 * MINUTE;
  const signed = blank(rowFrom(record(107, NOW + 15 * MINUTE, "您的快件已签收"), clock));
  state = commit(signed, "round-2");
  assert.equal(state.pendingNotifications?.length, 1);
  assert.equal(state.pendingNotifications?.[0]?.awaitingCarrier, true);

  // Matched together with a newer change: the round's own event carries the carrier, the held one is dropped.
  seed([transit]);
  commit(delivering, "round-1");
  clock = NOW + 16 * MINUTE;
  state = commit({ ...signed, identity: { ...signed.identity, courierCode: "JTSD", companyName: "极兔速递" } },
    "round-2");
  assert.deepEqual(state.pendingNotifications?.map((event) => [event.title, event.awaitingCarrier]),
    [["极兔速递 0001 · 已签收", undefined]]);
}

// 2. R-20：京东平台标签不是承运商证据。识别不出来时承运商留空，不再显示成「京东快递」；原始元组照留。
{
  const parcel: AccountParcelDto = {
    source: "interface5", ownerId: "JT4006839560002", waybill: "JT4006839560002", orderId: "",
    accountOrder: false, courierCode: "JDKD", rawCourierCode: "JDKD", rawCompanyName: "京东快递",
    companyName: "京东快递", carrierNormalization: null, sourceProvider: "JingDong", sourceStateCode: "104",
    sourceStateText: "运输中", semantic: "TRANSIT", receiverPhone: PHONE, senderPhone: "",
    latestTimeText: providerTime(NOW), latestDetail: "运输中", tracks: [], routeUrl: "", projectionUrl: "",
  };
  const nothing = async () => ({ normalization: null, terminal: true, pendingSecondLevel: false, coolingDown: false });
  const unresolved = await normalizeAccountParcelCarrier(parcel, { recognize: nothing });
  assert.deepEqual([unresolved.courierCode, unresolved.companyName], ["", ""]);
  assert.deepEqual([unresolved.rawCourierCode, unresolved.rawCompanyName], ["JDKD", "京东快递"]);
  // A failed recognition round (timeout) ends the same way.
  const failed = await normalizeAccountParcelCarrierBestEffort(parcel, {
    recognize: async () => { throw new OperationTimeoutError(); },
  });
  assert.deepEqual([failed.courierCode, failed.companyName], ["", ""]);
  const shown = parcelToShipment(unresolved, [PHONE], NOW)!;
  assert.equal(shown.identity.companyName, "", "never 京东快递 on a non-JD waybill");
  assert.equal(carrierAwaitingRecognition(shown), true);
  // A row stored before this rule, still showing the platform label, is no matched carrier either.
  const labelled = { ...shown, identity: { ...shown.identity, courierCode: "JDKD", companyName: "京东快递" } };
  assert.equal(carrierAwaitingRecognition(labelled), true);
  // A real JD waybill does carry 京东快递.
  const jd = parcelToShipment(await normalizeAccountParcelCarrier({ ...parcel, ownerId: "JDVD0000000002",
    waybill: "JDVD0000000002" }, { recognize: nothing }), [PHONE], NOW)!;
  assert.equal(jd.identity.companyName, "京东快递");
  assert.equal(carrierAwaitingRecognition(jd), false);
}

// 3. 表外承运商（裁决 29）：快递100 认得出、内置表里没有，显示它给的名字；只作显示，不改原始元组。
{
  let entries: CarrierRecognitionEntry[] = [];
  const store: CarrierRecognitionStore = { load: () => entries, save: (next) => { entries = [...next]; } };
  const result = await recognizeNonSyncCarrier("OFF0000000000031", {
    store,
    now: NOW,
    detect: async () => [{ courierCode: "synthetic_offtable", companyName: "合成物流" }],
    classify: async () => null,
  });
  assert.equal(result.normalization, null);
  assert.equal(result.terminal, true);
  assert.equal(result.displayName, "合成物流");
  assert.deepEqual(cachedCarrierRecognition("OFF0000000000031", store),
    { normalization: null, displayName: "合成物流", kuaidi100Code: "synthetic_offtable" });

  const parcel: AccountParcelDto = {
    source: "interface5", ownerId: "OFF0000000000031", waybill: "OFF0000000000031", orderId: "",
    accountOrder: false, courierCode: "OFFX", rawCourierCode: "OFFX", rawCompanyName: "", companyName: "",
    carrierNormalization: null, sourceProvider: "CaiNiao", sourceStateCode: "104", sourceStateText: "运输中",
    semantic: "TRANSIT", receiverPhone: PHONE, senderPhone: "", latestTimeText: providerTime(NOW),
    latestDetail: "运输中", tracks: [], routeUrl: "", projectionUrl: "",
  };
  const named = await normalizeAccountParcelCarrier(parcel, { recognize: async () => result });
  assert.equal(named.companyName, "合成物流");
  assert.equal(named.courierCode, "");
  assert.equal(named.rawCourierCode, "OFFX", "the raw tuple is untouched");
  const row = parcelToShipment(named, [PHONE], NOW)!;
  assert.equal(row.identity.companyName, "合成物流");
  assert.equal(row.identity.carrierIsBuiltIn, false);
  assert.equal(carrierAwaitingRecognition(row), false, "an off-table name is a matched carrier");
  // A source's own name is not overridden by it.
  const upstream = await normalizeAccountParcelCarrier({ ...parcel, companyName: "上游物流", rawCompanyName: "上游物流" },
    { recognize: async () => result });
  assert.equal(upstream.companyName, "上游物流");
  // Kuaidi100's generic 「快递」 names no carrier.
  const generic = await recognizeNonSyncCarrier("OFF0000000000032", {
    store, now: NOW, detect: async () => [{ courierCode: "synthetic_generic", companyName: "快递" }],
    classify: async () => null,
  });
  assert.equal(generic.displayName, undefined);
  // A raw code standing in as the name is no matched carrier.
  const rawNamed = parcelToShipment(parcel, [PHONE], NOW)!;
  assert.equal(rawNamed.identity.companyName, "OFFX");
  assert.equal(carrierAwaitingRecognition(rawNamed), true);
  // Manual add shows the same name (display only: no carrier code for dispatch).
  memory.clear();
  Storage.set("pipi_deliveries_carrier_recognition_v1", JSON.stringify(entries), { shared: true });
  assert.deepEqual(await detectManualCarrier("OFF0000000000031"),
    { courierCode: "", companyName: "合成物流", requiresPhoneTail: false });
}

// 4. 文案取号（E2）只在承运商对上后才亮出运单号；没对上时订单保持原样。
{
  memory.clear();
  const order = "3610000000000041", waybill = "75600000000041";
  const tracks = [{ timeText: providerTime(NOW), statusCode: "",
    detail: `您的订单由第三方卖家拣货完成，待出库交付中通快递，运单号为 ${waybill}` }];
  const parcel: AccountParcelDto = {
    source: "interface5", ownerId: order, waybill: order, orderId: order, accountOrder: true,
    courierCode: "JDKD", rawCourierCode: "JDKD", rawCompanyName: "京东商品快递", companyName: "京东购物",
    carrierNormalization: null, sourceProvider: "JingDong", sourceStateCode: "103", sourceStateText: "已揽收",
    semantic: "PICKED", receiverPhone: PHONE, senderPhone: "", latestTimeText: tracks[0].timeText,
    latestDetail: tracks[0].detail, tracks, routeUrl: "", projectionUrl: "",
    textIdentity: accountOrderTextIdentity(tracks),
  };
  assert.equal(withAccountOrderTextWaybill(parcel), parcel, "nothing recognised yet: the order stays");
  const held = parcelToShipment(parcel, [PHONE], NOW)!;
  assert.equal(held.identity.projectedWaybill, "");
  assert.equal(held.identity.companyName, "京东购物");
  seedRecognizedCarriers({ [waybill]: "YTO" }, NOW);
  const shown = parcelToShipment(parcel, [PHONE], NOW)!;
  assert.equal(shown.identity.projectedWaybill, waybill);
  assert.equal(shown.identity.companyName, "圆通速递", "the recognizer's carrier, never the text's 中通");
}

// 5. E2 端到端：列表轮对文案运单号先识别；识别不出来时订单行保持「京东购物 · 已下单」、不推，识别出来那一轮投影并推送。
{
  const order = "3610000000000051", waybill = "75600000000051";
  const base = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    jumpList: [{ type: "h5", link: "https://u.jd.com/forward?synthetic=t23-text" }] };
  const ordered = { ...base, stateNum: 102, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已下单" }] };
  const picked = { ...base, stateNum: 103, details: [
    { time: providerTime(NOW - 3600000), desc: `您的订单由第三方卖家拣货完成，待出库交付中通快递，运单号为 ${waybill}` },
    { time: providerTime(NOW - DAY), desc: "您的订单已下单" },
  ] };
  const id = `interface5:account:${order}`;
  seed([rowFrom(ordered)]);
  listRecords = [picked];
  await refreshAllShipments();
  assert.ok(requests.includes("autoComNum"), "the waybill is recognised in the same round");
  assert.equal(stored(id).identity.projectedWaybill, "", "no carrier matched: the order is kept as it was");
  assert.equal(stored(id).identity.companyName, "京东购物");
  assert.equal(shipmentPresentationStatus(stored(id)).semantic, "ORDERED");
  assert.equal(captures, 0, "the feed text needs no union page");
  assert.deepEqual(titles(), [], "no blank-carrier notification");
  assert.deepEqual(loadState().pendingNotifications || [], []);

  clock = NOW + 16 * MINUTE;
  autoComNum = [{ comCode: "zhongtong", name: "中通快递" }];
  await refreshAllShipments();
  assert.equal(stored(id).identity.projectedWaybill, waybill);
  assert.equal(stored(id).identity.companyName, "中通快递");
  assert.deepEqual(titles(), ["中通快递 0051 · 已揽件"], "the round that matched the carrier pushes the change");
  assert.equal(captures, 0);
}

// 6. E3：京粉页给出运单号、承运商没对上——订单保持原样、不推；运单号挂起，之后只补识别、不再开页；认出来那一轮投影并推送。
{
  const order = "3610000000000061", waybill = "YT7000000000061";
  const reference = "https://u.jd.com/forward?synthetic=t23-page";
  const pickedOrder = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 103, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已出库" }],
    jumpList: [{ type: "h5", link: reference }] };
  const id = `interface5:account:${order}`;
  seed([rowFrom(pickedOrder)]);
  saveOrderProjectionReferences([{ ownerId: id, source: "interface5", url: reference }], NOW);
  page = { waybillCode: waybill };
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "attempted");
  assert.equal(captures, 1);
  let row = stored(id);
  assert.equal(row.identity.projectedWaybill, "", "the order keeps its order presentation");
  assert.equal(row.identity.companyName, "京东购物");
  assert.equal(row.identity.pendingProjection?.waybill, waybill, "the page's waybill is kept, not lost");
  assert.ok(row.identity.orderProjectionRetry?.failedAtMs, "the page load still rests the order (§9)");

  // The list round keeps the order as it was: 京东购物 · 已下单, no blank-carrier push, no page, waybill still held.
  clock = NOW + MINUTE;
  listRecords = [pickedOrder];
  await refreshAllShipments();
  row = stored(id);
  assert.equal(row.identity.projectedWaybill, "");
  assert.equal(shipmentPresentationStatus(row).semantic, "ORDERED");
  assert.equal(row.identity.pendingProjection?.waybill, waybill);
  assert.deepEqual(titles(), []);
  assert.equal(captures, 1);

  // Past the page rest but not the recognizer's: nothing is due, and no page opens.
  clock = NOW + 11 * MINUTE;
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "nothing_due");
  assert.equal(captures, 1);

  // Recognition may answer again: the held waybill is recognised without reopening the page, then projected.
  clock = NOW + 16 * MINUTE;
  autoComNum = [{ comCode: "yuantong", name: "圆通速递" }];
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "attempted");
  assert.equal(captures, 1, "the union page is not opened again for a held waybill");
  row = stored(id);
  assert.equal(row.identity.projectedWaybill, waybill);
  assert.equal(row.identity.companyName, "圆通速递");
  assert.equal(row.identity.pendingProjection, undefined);
  // The next list round carries the order's own status to the projected row, and the change goes out with its carrier.
  clock = NOW + 17 * MINUTE;
  await refreshAllShipments();
  assert.deepEqual(titles(), ["圆通速递 0061 · 已揽件"]);
  assert.equal(captures, 1);
  page = {};
}

// 6b. 挂起的京粉页运单号在详情页也补识别（不开页）；识别失败（超时）时页面给的运单号照样挂起、不丢。
{
  const order = "3610000000000062", waybill = "YT7000000000062";
  const reference = "https://u.jd.com/forward?synthetic=t23-page-detail";
  const pickedOrder = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 103, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已出库" }],
    jumpList: [{ type: "h5", link: reference }] };
  const id = `interface5:account:${order}`;
  seed([rowFrom(pickedOrder)]);
  saveOrderProjectionReferences([{ ownerId: id, source: "interface5", url: reference }], NOW);
  page = { waybillCode: waybill };
  autoComNum = "timeout";
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "attempted");
  assert.equal(captures, 1);
  assert.equal(stored(id).identity.projectedWaybill, "");
  assert.equal(stored(id).identity.pendingProjection?.waybill, waybill, "a failed recognition keeps the page's waybill");
  page = {};

  clock = NOW + MINUTE;
  autoComNum = [{ comCode: "yuantong", name: "圆通速递" }];
  let loads = 0;
  const result = await runShipmentRefreshForTesting(id, { isCurrent: () => true }, { trigger: "detail_open" }, {
    refreshAccountParcel: async () => null,
    projectAccountOrderWithCarrier: async (input: AccountParcelDto): Promise<AccountParcelDto> => {
      loads++;
      return input;
    },
  });
  assert.equal(loads, 0, "a held waybill is recognised, the union page is not opened again");
  assert.equal(result.shipment.identity.projectedWaybill, waybill);
  assert.equal(stored(id).identity.companyName, "圆通速递");
  assert.equal(stored(id).identity.pendingProjection, undefined);
  assert.equal(captures, 1);
}

// 6c. 首页存盘行对文案运单号只识别、不开页；识别不出来时订单的投影记录恢复成预约前（没开页就不记冷却），识别器没到
//     再问的时候不排这一单。
{
  const order = "3610000000000063", waybill = "75600000000063";
  const record = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 104, details: [
      { time: providerTime(NOW - 3600000), desc: `您的订单由第三方卖家拣货完成，待出库交付中通快递，运单号为 ${waybill}` },
    ] };
  const id = `interface5:account:${order}`;
  seed([rowFrom(record)]);
  assert.equal(stored(id).identity.projectedWaybill, "");
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "attempted");
  assert.ok(requests.includes("autoComNum"));
  assert.equal(captures, 0);
  assert.equal(stored(id).identity.projectedWaybill, "");
  assert.equal(stored(id).identity.orderProjectionRetry, undefined, "no page was loaded, so no cooldown is recorded");
  clock = NOW + MINUTE;
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "nothing_due");
}

// 11. 详情页开京粉页拿到运单号、承运商没对上：订单保持原样，运单号与页面冷却挂在这一行上。
{
  const order = "3610000000000111", waybill = "YT7000000000111";
  const reference = "https://u.jd.com/forward?synthetic=t23-detail-page";
  const pickedOrder = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 103, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已出库" }],
    jumpList: [{ type: "h5", link: reference }] };
  const id = `interface5:account:${order}`;
  seed([rowFrom(pickedOrder)]);
  saveOrderProjectionReferences([{ ownerId: id, source: "interface5", url: reference }], NOW);
  let loads = 0;
  const runtime = {
    refreshAccountParcel: async () => null,
    projectAccountOrderWithCarrier: async (input: AccountParcelDto): Promise<AccountParcelDto> => {
      loads++;
      return { ...input, waybill, courierCode: "", companyName: "", rawCourierCode: "", rawCompanyName: "",
        carrierNormalization: null, textIdentity: null };
    },
  };
  await runShipmentRefreshForTesting(id, { isCurrent: () => true }, { trigger: "detail_pull" }, runtime);
  assert.equal(loads, 1);
  const row = stored(id);
  assert.equal(row.identity.projectedWaybill, "", "no blank-carrier projection is committed");
  assert.equal(row.identity.companyName, "京东购物");
  assert.equal(row.identity.pendingProjection?.waybill, waybill);
  assert.ok(row.identity.orderProjectionRetry?.failedAtMs, "the page load rests the order (§9)");
  assert.deepEqual(titles(), []);
}

// 7. E5/E4：打开详情时文案运单号先识别，认不出就不提交投影、也不开京粉页；认出来才连同承运商一起提交。
{
  const order = "3610000000000071", waybill = "75600000000071";
  const text = `您的订单由第三方卖家拣货完成，待出库交付中通快递，运单号为 ${waybill}`;
  const record = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 103, details: [{ time: providerTime(NOW - 3600000), desc: text }] };
  const id = `interface5:account:${order}`;
  let loads = 0;
  const runtime = {
    refreshAccountParcel: async () => null,
    projectAccountOrderWithCarrier: async (input: AccountParcelDto): Promise<AccountParcelDto> => {
      loads++;
      return input;
    },
  };
  seed([rowFrom(record)]);
  let result = await runShipmentRefreshForTesting(id, { isCurrent: () => true }, { trigger: "detail_open" }, runtime);
  assert.equal(loads, 0, "an order whose text names its waybill never takes the page path");
  assert.equal(result.shipment.identity.projectedWaybill, "");
  assert.equal(stored(id).identity.projectedWaybill, "");
  assert.equal(stored(id).identity.companyName, "京东购物");
  assert.ok(requests.includes("autoComNum"));

  clock = NOW + 16 * MINUTE;
  autoComNum = [{ comCode: "zhongtong", name: "中通快递" }];
  result = await runShipmentRefreshForTesting(id, { isCurrent: () => true }, { trigger: "detail_open" }, runtime);
  assert.equal(loads, 0);
  assert.equal(result.shipment.identity.projectedWaybill, waybill);
  assert.equal(stored(id).identity.companyName, "中通快递");

  // E4: the entry query's text is projected only together with its recognised carrier.
  const entryRound = async (answer: typeof autoComNum) => {
    seed([rowFrom({ ...record, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已下单" }] })]);
    autoComNum = answer;
    const queried = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
    let queries = 0;
    const row = stored(id);
    // A real latest-node conflict makes the entry query due without relying on prose classification.
    row.sourceTimeline = { ...row.sourceTimeline!, tracks: row.sourceTimeline!.tracks.map((track) =>
      ({ ...track, statusCode: "103" })) };
    saveState({ ...loadState(), shipments: [row] }, clock);
    await runShipmentRefreshForTesting(id, { isCurrent: () => true }, { trigger: "detail_open" }, {
      ...runtime,
      refreshAccountParcel: async () => { queries++; return { ...queried, accountOrder: true }; },
    });
    assert.equal(queries, 1, "the entry query ran");
    assert.equal(loads, 0, "no page path for the entry query's text");
    return stored(id);
  };
  let entry = await entryRound(null);
  assert.equal(entry.identity.projectedWaybill, "", "the entry query never commits a blank-carrier projection");
  assert.equal(entry.identity.companyName, "京东购物");
  entry = await entryRound([{ comCode: "zhongtong", name: "中通快递" }]);
  assert.equal(entry.identity.projectedWaybill, waybill);
  assert.equal(entry.identity.companyName, "中通快递");
}

// 8. E6：手动件承运商没对上时，之后的后台刷新轮与详情页都会再识别；对上后写进这一行、放行挂起的通知。
{
  const waybill = "MANUAL000000081";
  const manual = (semantic: "TRANSIT" | "DELIVERY", at: number, detail: string): Shipment => {
    const timeline = { provider: "v6_query", waybill, courierCode: "", companyName: "", semantic,
      structuredStatus: true, statusEventAtMs: at, latestTimeText: providerTime(at), latestDetail: detail,
      successAtMs: at, tracks: [{ timeMs: at, timeText: providerTime(at), detail, statusCode: "", raw: {} }] };
    return {
      identity: { id: `interface5:manual:${waybill}`, bindingSource: "interface5", sourceOwner: "manual",
        sourceId: waybill, phoneTail: "2323", courierCode: "", companyName: "", manuallyAdded: true,
        createdAtMs: NOW - DAY },
      timeline, sourceTimeline: null, manualTimelines: [timeline], updatedAtMs: at,
    };
  };
  const id = `interface5:manual:${waybill}`;
  seed([manual("TRANSIT", NOW - DAY, "快件已到达【杭州转运中心】")]);
  let base = loadState();
  const context = {
    previousById: new Map(base.shipments.map((shipment) => [shipment.identity.id, shipment])),
    batchId: "manual-round-1",
  };
  commitRefreshState(base, { ...base, shipments: [manual("DELIVERY", NOW - 3600000, "【上海市】快件正在派送中")] },
    "interface5", NOW, undefined, context);
  assert.equal(loadState().pendingNotifications?.[0]?.awaitingCarrier, true);

  clock = NOW + 16 * MINUTE;
  autoComNum = [{ comCode: "zhongtong", name: "中通快递" }];
  base = loadState();
  const summary = await runShipmentEnrichmentForTesting(base, "interface5", "t23-manual",
    (candidate, _routes, _stage, jobBase) => commitRefreshState(jobBase || base, candidate, "interface5", clock,
      undefined, { previousById: new Map(base.shipments.map((shipment) => [shipment.identity.id, shipment])),
        batchId: "manual-round-2" }).state,
    clock + 30000, new Set(), true, false, undefined, {
      queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "", result: "empty_response" }),
    });
  assert.ok(summary);
  assert.equal(stored(id).identity.companyName, "中通快递");
  assert.equal(stored(id).identity.courierCode, "ZTO");
  await replayPendingShipmentNotifications();
  assert.deepEqual(titles(), ["中通快递 0081 · 派送中"]);

  // The detail page recognises it too.
  seed([manual("TRANSIT", NOW - DAY, "快件已到达【杭州转运中心】")]);
  autoComNum = [{ comCode: "zhongtong", name: "中通快递" }];
  const result = await runShipmentRefreshForTesting(id, { isCurrent: () => true }, { trigger: "detail_open" });
  assert.equal(result.shipment.identity.companyName, "中通快递");
  assert.equal(stored(id).identity.companyName, "中通快递");
}

// 9. 早先已投影、承运商空白的订单（旧数据）：列表轮也补识别，不只在详情页。
{
  const order = "3610000000000091", waybill = "YT7000000000091";
  const record = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 104, details: [{ time: providerTime(NOW - 3600000), desc: "您的订单已到达【杭州转运中心】" }] };
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
  const legacy = applyAccountShipment(undefined,
    parcelToShipment({ ...parcel, waybill, courierCode: "", companyName: "" }, [PHONE], NOW - 3600000)!,
    NOW - 3600000);
  assert.equal(legacy.identity.projectedWaybill, waybill);
  assert.equal(legacy.identity.companyName, "");
  const id = legacy.identity.id;
  seed([legacy]);
  autoComNum = [{ comCode: "yuantong", name: "圆通速递" }];
  listRecords = [record];
  await refreshAllShipments();
  assert.equal(stored(id).identity.companyName, "圆通速递");
  assert.equal(stored(id).identity.projectedWaybill, waybill);
}

// 10. E1 的行在详情页也补识别：打开详情（按件查询之后）与下拉都会再问一次，认出来就写进这一行。
{
  const waybill = "JT4006839560101";
  const record = { mailNo: waybill, provider: "JingDong", cpCode: "JDKD", name: "京东快递", phone: PHONE,
    stateNum: 104, details: [{ time: providerTime(NOW - 3600000), desc: "快件已到达【杭州转运中心】" }] };
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
  const blank = await normalizeAccountParcelCarrierBestEffort(parcel, {
    recognize: async () => ({ normalization: null, terminal: false, pendingSecondLevel: false, coolingDown: true }),
  });
  const row = applyAccountShipment(undefined, parcelToShipment(blank, [PHONE], NOW - 3600000)!, NOW - 3600000);
  assert.equal(row.identity.companyName, "");
  const id = row.identity.id;
  const quiet = {
    refreshAccountParcel: async () => parcel,
    queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "", result: "empty_response" as const }),
    refreshWebTimeline: async () => null,
    refreshCainiaoH5: async () => null,
  };
  for (const trigger of ["detail_open", "detail_pull"] as const) {
    seed([row]);
    autoComNum = [{ comCode: "zhongtong", name: "中通快递" }];
    await runShipmentRefreshForTesting(id, { isCurrent: () => true }, { trigger }, quiet);
    assert.equal(stored(id).identity.companyName, "中通快递", `${trigger} recognises a row still without a carrier`);
    assert.equal(stored(id).identity.courierCode, "ZTO");
  }
}

console.log("carrier before push tests passed");
