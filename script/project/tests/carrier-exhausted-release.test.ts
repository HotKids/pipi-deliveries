import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";

import type { AppState, Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import {
  normalizeAccountParcelCarrierBestEffort,
  parcelToShipment,
  prepareAccountParcelCarrier,
  withAccountOrderTextWaybill,
} from "../services/account-sync";
import { directAccountCarrierPresentation } from "../services/account-carrier-normalization";
import { OperationTimeoutError } from "../services/deadline";
import {
  carrierRecognitionExhausted,
  recognizeNonSyncCarrier,
  CARRIER_TERMINAL_TTL_MS,
  type CarrierRecognitionEntry,
  type CarrierRecognitionStore,
} from "../services/carrier-recognition";
import { carrierAwaitingRecognition, carrierUnmatched } from "../services/carrier-gate";
import { saveGatewayToken } from "../services/credentials";
import { replayPendingShipmentNotifications } from "../services/notifications";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { saveOrderProjectionReferences } from "../services/routes";
import { applyAccountShipment } from "../services/shipment-policy";
import { commitRefreshState, emptyState, loadState, saveState } from "../services/storage";
import {
  projectStoredAccountOrders,
  refreshAllShipments,
  runShipmentRefreshForTesting,
} from "../services/sync";
import {
  seedCoolingRecognition,
  seedExhaustedRecognition,
  seedRecognizedCarriers,
} from "./carrier-recognition-seed";

// 其余裁决 32（用户 2026-09-26，T23 细则）：承运商始终认不出（识别进入终态：连续 3 次失败，或付费级明确认不出，且快递100
// 没给名字）的件不再无限期挂着——挂起的通知与停在订单阶段的投影照常放行，承运商位置显示原始承运商码（JDKD、ZTKY 这类
// 原样的码，而不是平台名「京东快递」）。连原始码都没有时不自造占位文案。

const PHONE = "13800003232";
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

/** Kuaidi100's free recognizer: `null` answers 503 (a network failure), otherwise these candidates. */
let autoComNum: null | Array<{ comCode: string; name: string }> = null;
let listRecords: unknown[] = [];
const requests: string[] = [];
globalThis.fetch = (async (url: string) => {
  const { hostname, pathname } = new URL(url);
  if (hostname === "www.kuaidi100.com" && pathname === "/autonumber/autoComNum") {
    requests.push("autoComNum");
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
  page = {};
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
function commitRound(next: Shipment, batchId: string): AppState {
  const base = loadState();
  const context = {
    previousById: new Map(base.shipments.map((shipment) => [shipment.identity.id, shipment])),
    batchId,
  };
  return commitRefreshState(base, { ...base, shipments: [next] }, "interface5", clock, undefined, context).state;
}

// 1. 识别器：什么算终态、终态到期后重新识别又失败时仍算、真的识别出来就不算。
{
  let entries: CarrierRecognitionEntry[] = [];
  const store: CarrierRecognitionStore = { load: () => entries, save: (next) => { entries = [...next]; } };
  const failing = async () => { throw new Error("synthetic offline"); };
  const noMatch = async () => null;
  // Three consecutive failures of the free stage.
  const outcomes = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    outcomes.push(await recognizeNonSyncCarrier("EXH000000000011", {
      store, now: NOW + attempt * 16 * MINUTE, detect: failing, classify: noMatch,
    }));
  }
  assert.deepEqual(outcomes.map((outcome) => Boolean(outcome.exhausted)), [false, false, true]);
  assert.equal(carrierRecognitionExhausted("EXH000000000011", store), true);
  // The paid stage's clear no-match without a Kuaidi100 name.
  const paid = await recognizeNonSyncCarrier("EXH000000000012", {
    store, now: NOW, detect: async () => [], classify: noMatch,
  });
  assert.equal(paid.exhausted, true);
  // Kuaidi100 named it: an off-table carrier, not exhausted.
  const named = await recognizeNonSyncCarrier("EXH000000000013", {
    store, now: NOW, detect: async () => [{ courierCode: "synthetic_offtable", companyName: "合成物流" }],
    classify: noMatch,
  });
  assert.equal(named.exhausted, undefined);
  assert.equal(carrierRecognitionExhausted("EXH000000000013", store), false);
  // A single failure is not exhausted.
  await recognizeNonSyncCarrier("EXH000000000014", { store, now: NOW, detect: failing, classify: noMatch });
  assert.equal(carrierRecognitionExhausted("EXH000000000014", store), false);
  // After the 24-hour verdict runs out, a new failure keeps it exhausted: no flip back to holding.
  const later = NOW + 2 * 16 * MINUTE + CARRIER_TERMINAL_TTL_MS + MINUTE;
  const retried = await recognizeNonSyncCarrier("EXH000000000011", {
    store, now: later, detect: failing, classify: noMatch,
  });
  assert.equal(retried.terminal, false, "the expired verdict restarts its failure count");
  assert.equal(retried.exhausted, true);
  assert.equal(carrierRecognitionExhausted("EXH000000000011", store), true);
  // Until a carrier is really recognised.
  const resolved = await recognizeNonSyncCarrier("EXH000000000011", {
    store, now: later + 16 * MINUTE, detect: async () => [{ courierCode: "zhongtong", companyName: "中通快递" }],
    classify: noMatch,
  });
  assert.equal(resolved.normalization?.standardCode, "ZTO");
  assert.equal(resolved.exhausted, undefined);
  assert.equal(carrierRecognitionExhausted("EXH000000000011", store), false);
}

// 2. E1 京东平台行：识别进入终态后承运商位置显示原始码 JDKD（不是京东快递），挂起的通知放行、标题带 JDKD。
{
  const waybill = "JT4006839560201";
  const record = (stateNum: number, at: number, desc: string) => ({
    mailNo: waybill, provider: "JingDong", cpCode: "JDKD", name: "京东快递", phone: PHONE, stateNum,
    details: [{ time: providerTime(at), desc }],
  });
  const id = `interface5:account:${waybill}`;
  const transit = rowFrom(record(104, NOW - DAY, "快件已到达【杭州转运中心】"));
  seed([{ ...transit, identity: { ...transit.identity, courierCode: "", companyName: "" } }]);
  seedCoolingRecognition(waybill, NOW);
  // Still being recognised: the change is held.
  listRecords = [record(105, NOW - 3600000, "【上海市】快件正在派送中")];
  await refreshAllShipments();
  assert.equal(stored(id).identity.companyName, "");
  assert.equal(loadState().pendingNotifications?.[0]?.awaitingCarrier, true);
  assert.deepEqual(titles(), []);
  // Recognition exhausted: shown with its raw code, and the held change goes out with it.
  clock = NOW + 16 * MINUTE;
  seedExhaustedRecognition(waybill, "network", clock);
  await refreshAllShipments();
  const row = stored(id);
  assert.equal(row.identity.companyName, "JDKD", "the raw code, never the platform name 京东快递");
  assert.equal(row.identity.courierCode, "", "the raw code is shown, not used as a carrier code");
  assert.equal(carrierAwaitingRecognition(row), false);
  assert.equal(carrierUnmatched(row), true, "still recognised again once the recognizer may answer");
  assert.deepEqual(titles(), ["JDKD 0201 · 派送中"]);
  assert.deepEqual(loadState().pendingNotifications || [], []);
  // Later rounds keep the raw code without holding again.
  clock = NOW + 32 * MINUTE;
  listRecords = [record(107, NOW + 30 * MINUTE, "您的快件已签收")];
  await refreshAllShipments();
  assert.equal(stored(id).identity.companyName, "JDKD");
  assert.deepEqual(titles(), ["JDKD 0201 · 派送中", "JDKD 0201 · 已签收"]);
}

// 3. E1 表内认不出的原始码（ZTKY）：本来就显示原始码；识别终态前挂起、终态后放行。
{
  const waybill = "ZK0000000000301";
  const record = (stateNum: number, at: number, desc: string) => ({
    mailNo: waybill, provider: "CaiNiao", cpCode: "ZTKY", name: "", phone: PHONE, stateNum,
    details: [{ time: providerTime(at), desc }],
  });
  const id = `interface5:account:${waybill}`;
  seed([rowFrom(record(104, NOW - DAY, "快件已到达【杭州转运中心】"))]);
  assert.equal(stored(id).identity.companyName, "ZTKY");
  const delivering = rowFrom(record(105, NOW - 3600000, "【上海市】快件正在派送中"), NOW);
  let state = commitRound(delivering, "round-1");
  assert.equal(state.pendingNotifications?.[0]?.awaitingCarrier, true, "a raw code is no carrier until exhausted");
  seedExhaustedRecognition(waybill, "paid", NOW);
  clock = NOW + MINUTE;
  state = commitRound({ ...delivering, updatedAtMs: clock }, "round-2");
  assert.deepEqual(state.pendingNotifications?.map((event) => [event.title, event.awaitingCarrier]),
    [["ZTKY 0301 · 派送中", undefined]]);
}

// 4. E2 文案取号：识别终态时订单不再停在订单阶段，照常投影，承运商位置显示订单原样的 JDKD；之后的列表轮也不会变成京东快递。
{
  const order = "3610000000000401", waybill = "75600000000401";
  const base = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE };
  const ordered = { ...base, stateNum: 102, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已下单" }] };
  const picked = { ...base, stateNum: 103, details: [
    { time: providerTime(NOW - 3600000), desc: `您的订单由第三方卖家拣货完成，待出库交付中通快递，运单号为 ${waybill}` },
    { time: providerTime(NOW - DAY), desc: "您的订单已下单" },
  ] };
  const id = `interface5:account:${order}`;
  seed([rowFrom(ordered)]);
  seedCoolingRecognition(waybill, NOW);
  listRecords = [picked];
  await refreshAllShipments();
  assert.equal(stored(id).identity.projectedWaybill, "", "still being recognised: the order is kept");
  assert.deepEqual(titles(), []);
  clock = NOW + 16 * MINUTE;
  seedExhaustedRecognition(waybill, "paid", clock);
  await refreshAllShipments();
  let row = stored(id);
  assert.equal(row.identity.projectedWaybill, waybill);
  assert.equal(row.identity.companyName, "JDKD");
  assert.deepEqual(titles(), ["JDKD 0401 · 已揽件"]);
  clock = NOW + 32 * MINUTE;
  await refreshAllShipments();
  row = stored(id);
  assert.equal(row.identity.companyName, "JDKD", "the next list round does not turn it into 京东快递");
  assert.equal(row.identity.courierCode, "");

  // Self-healing: once the recognizer may answer again and names the carrier, the raw code gives way.
  clock = NOW + 32 * MINUTE + CARRIER_TERMINAL_TTL_MS;
  autoComNum = [{ comCode: "zhongtong", name: "中通快递" }];
  await refreshAllShipments();
  row = stored(id);
  assert.equal(row.identity.companyName, "中通快递");
  assert.equal(row.identity.courierCode, "ZTO");
}

// 5. E3 京粉页挂起的运单号：识别终态后照常投影（不再开页），显示订单原样的 JDKD，并推送；之后的列表轮保持 JDKD。
{
  const order = "3610000000000501", waybill = "YT7000000000501";
  const reference = "https://u.jd.com/forward?synthetic=t23b-page";
  const pickedOrder = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 103, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已出库" }],
    jumpList: [{ type: "h5", link: reference }] };
  const id = `interface5:account:${order}`;
  seed([rowFrom(pickedOrder)]);
  saveOrderProjectionReferences([{ ownerId: id, source: "interface5", url: reference }], NOW);
  page = { waybillCode: waybill };
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(captures, 1);
  assert.equal(stored(id).identity.pendingProjection?.waybill, waybill);
  page = {};
  clock = NOW + MINUTE;
  seedExhaustedRecognition(waybill, "network", clock);
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "attempted",
    "an exhausted held waybill is due for its release");
  assert.equal(captures, 1, "no page is reopened");
  let row = stored(id);
  assert.equal(row.identity.projectedWaybill, waybill);
  assert.equal(row.identity.companyName, "JDKD");
  assert.equal(row.identity.pendingProjection, undefined);
  clock = NOW + 2 * MINUTE;
  listRecords = [pickedOrder];
  await refreshAllShipments();
  row = stored(id);
  assert.equal(row.identity.companyName, "JDKD");
  assert.deepEqual(titles(), ["JDKD 0501 · 已揽件"]);
  assert.equal(captures, 1);
}

// 6. E5 详情：挂起的京粉页运单号识别终态时，打开详情就放行（不开页），显示 JDKD。
{
  const order = "3610000000000601", waybill = "YT7000000000601";
  const reference = "https://u.jd.com/forward?synthetic=t23b-detail";
  const pickedOrder = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 103, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已出库" }],
    jumpList: [{ type: "h5", link: reference }] };
  const id = `interface5:account:${order}`;
  const row = rowFrom(pickedOrder);
  seed([{ ...row, identity: { ...row.identity,
    pendingProjection: { waybill, timeline: null, capturedAtMs: NOW - MINUTE } } }]);
  saveOrderProjectionReferences([{ ownerId: id, source: "interface5", url: reference }], NOW);
  seedExhaustedRecognition(waybill, "paid", NOW);
  let loads = 0;
  const result = await runShipmentRefreshForTesting(id, { isCurrent: () => true }, { trigger: "detail_open" }, {
    refreshAccountParcel: async () => null,
    projectAccountOrderWithCarrier: async (input) => { loads++; return input; },
  });
  assert.equal(loads, 0);
  assert.equal(result.shipment.identity.projectedWaybill, waybill);
  assert.equal(stored(id).identity.companyName, "JDKD");
}

// 7. 连原始码都没有（其余裁决 33，用户 2026-09-26：「传回啥 cpcode 就填啥」）：识别到终态照常放行，承运商位置空着，
//    不自造占位文案。旧期望（其余裁决 32 时）：这样的件照旧挂着、订单停在订单阶段。
{
  // A manual row whose Picker named no carrier: held while recognition may still answer, released at its end.
  const waybill = "MANUAL000000701";
  const id = `interface5:manual:${waybill}`;
  const manual = (semantic: "TRANSIT" | "DELIVERY", at: number, detail: string): Shipment => {
    const timeline = { provider: "v6_query", waybill, courierCode: "", companyName: "", semantic,
      structuredStatus: true, statusEventAtMs: at, latestTimeText: providerTime(at), latestDetail: detail,
      successAtMs: at, tracks: [{ timeMs: at, timeText: providerTime(at), detail, statusCode: "", raw: {} }] };
    return {
      identity: { id, bindingSource: "interface5", sourceOwner: "manual",
        sourceId: waybill, phoneTail: "3232", courierCode: "", rawCourierCode: "", companyName: "",
        manuallyAdded: true, createdAtMs: NOW - DAY },
      timeline, sourceTimeline: null, manualTimelines: [timeline], updatedAtMs: at,
    };
  };
  seed([manual("TRANSIT", NOW - DAY, "快件已到达【杭州转运中心】")]);
  seedCoolingRecognition(waybill, NOW);
  const delivering = manual("DELIVERY", NOW - 3600000, "【上海市】快件正在派送中");
  let state = commitRound(delivering, "round-1");
  assert.equal(state.pendingNotifications?.[0]?.awaitingCarrier, true, "still being recognised: held");
  seedExhaustedRecognition(waybill, "paid", NOW);
  clock = NOW + MINUTE;
  state = commitRound({ ...delivering, updatedAtMs: clock }, "round-2");
  // 其余裁决 35（用户 2026-09-27）：标题里空承运商写「快递」，只在展示层（旧期望「0701 · 派送中」）。
  assert.deepEqual(state.pendingNotifications?.map((event) => [event.title, event.awaitingCarrier]),
    [["快递 0701 · 派送中", undefined]], "released with an empty carrier, shown as 快递");
  assert.equal(stored(id).identity.companyName, "");

  // A list row whose source sent no cpCode (E1): its carrier stays empty and it is released at the end of recognition.
  // (Such a row never becomes an established automatic owner — the existing owner rule wants a raw carrier field — so
  // later list packets do not update it; only the gate is checked here.)
  const listWaybill = "NOCODE000000703";
  const listRow = rowFrom({ mailNo: listWaybill, provider: "CaiNiao", cpCode: "", name: "", phone: PHONE,
    stateNum: 104, details: [{ time: providerTime(NOW - DAY), desc: "快件已到达【杭州转运中心】" }] });
  seed([listRow]);
  assert.equal(listRow.identity.companyName, "");
  seedCoolingRecognition(listWaybill, NOW);
  assert.equal(carrierAwaitingRecognition(listRow), true);
  seedExhaustedRecognition(listWaybill, "network", NOW);
  assert.equal(carrierAwaitingRecognition(listRow), false);

  // An order whose feed sent no cpCode: at the end of recognition it is projected with an empty carrier and pushed.
  const order = "3610000000000702", orderWaybill = "75600000000702";
  const base = { mailNo: order, provider: "JingDong", cpCode: "", name: "", phone: PHONE };
  const ordered = { ...base, stateNum: 102, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已下单" }] };
  const picked = { ...base, stateNum: 103, details: [
    { time: providerTime(NOW - 3600000), desc: `您的订单由第三方卖家拣货完成，待出库交付中通快递，运单号为 ${orderWaybill}` },
    { time: providerTime(NOW - DAY), desc: "您的订单已下单" },
  ] };
  const orderId = `interface5:account:${order}`;
  seed([rowFrom(ordered)]);
  seedCoolingRecognition(orderWaybill, NOW);
  listRecords = [picked];
  await refreshAllShipments();
  assert.equal(stored(orderId).identity.projectedWaybill, "", "still being recognised: the order is kept");
  assert.deepEqual(titles(), []);
  clock = NOW + 16 * MINUTE;
  seedExhaustedRecognition(orderWaybill, "paid", clock);
  await refreshAllShipments();
  let orderRow = stored(orderId);
  assert.equal(orderRow.identity.projectedWaybill, orderWaybill);
  assert.equal(orderRow.identity.companyName, "");
  // 其余裁决 35: shown as 快递 (old expectation 「0702 · 已揽件」); the stored carrier stays empty.
  assert.deepEqual(titles(), ["快递 0702 · 已揽件"]);
  clock = NOW + 32 * MINUTE;
  await refreshAllShipments();
  orderRow = stored(orderId);
  assert.equal(orderRow.identity.projectedWaybill, orderWaybill);
  assert.equal(orderRow.identity.companyName, "", "later rounds keep it empty, no placeholder");

  // A union-page waybill held for an order without a cpCode is released the same way, without reopening the page.
  const pageOrder = "3610000000000704", pageWaybill = "YT7000000000704";
  const reference = "https://u.jd.com/forward?synthetic=t23c-page";
  const pageRecord = { mailNo: pageOrder, provider: "JingDong", cpCode: "", name: "", phone: PHONE,
    stateNum: 103, details: [{ time: providerTime(NOW - DAY), desc: "您的订单已出库" }],
    jumpList: [{ type: "h5", link: reference }] };
  const pageId = `interface5:account:${pageOrder}`;
  const pageRow = rowFrom(pageRecord);
  seed([{ ...pageRow, identity: { ...pageRow.identity,
    pendingProjection: { waybill: pageWaybill, timeline: null, capturedAtMs: NOW - MINUTE } } }]);
  saveOrderProjectionReferences([{ ownerId: pageId, source: "interface5", url: reference }], NOW);
  seedExhaustedRecognition(pageWaybill, "network", NOW);
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "attempted");
  assert.equal(captures, 0);
  assert.equal(stored(pageId).identity.projectedWaybill, pageWaybill);
  assert.equal(stored(pageId).identity.companyName, "");
  assert.equal(stored(pageId).identity.pendingProjection, undefined);
}

// 8. T23 的表外名（快递100 给的名字）在投影订单上也经得起下一轮列表：不会被订单自己的平台码改成京东快递。
{
  const order = "3610000000000801", waybill = "75600000000801";
  const record = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 103, details: [{ time: providerTime(NOW - 3600000),
      desc: `您的订单由第三方卖家拣货完成，待出库交付合成物流，运单号为 ${waybill}` }] };
  const id = `interface5:account:${order}`;
  seed([]);
  autoComNum = [{ comCode: "synthetic_offtable", name: "合成物流" }];
  listRecords = [record];
  await refreshAllShipments();
  assert.equal(stored(id).identity.companyName, "合成物流");
  clock = NOW + MINUTE;
  await refreshAllShipments();
  assert.equal(stored(id).identity.companyName, "合成物流");
  // And a built-in carrier recognised for it is not changed either.
  seed([]);
  seedRecognizedCarriers({ [waybill]: "ZTO" }, NOW);
  await refreshAllShipments();
  clock = NOW + MINUTE;
  await refreshAllShipments();
  assert.equal(stored(id).identity.companyName, "中通快递");
}

// 9. 放行后仍会补识别：手动件只显示 Picker 给的原始码（ZTKY），识别终态后放行；终态到期、识别器又能回答时，后台刷新轮照样再问，
//    认出来就换成真名。
{
  const waybill = "MANUAL000000901";
  const timeline = { provider: "v6_query", waybill, courierCode: "ZTKY", rawCourierCode: "ZTKY", companyName: "ZTKY",
    semantic: "TRANSIT" as const, structuredStatus: true, statusEventAtMs: NOW - DAY,
    latestTimeText: providerTime(NOW - DAY), latestDetail: "快件已到达【杭州转运中心】", successAtMs: NOW - DAY,
    tracks: [{ timeMs: NOW - DAY, timeText: providerTime(NOW - DAY), detail: "快件已到达【杭州转运中心】",
      statusCode: "", raw: {} }] };
  const id = `interface5:manual:${waybill}`;
  const manual: Shipment = {
    identity: { id, bindingSource: "interface5", sourceOwner: "manual", sourceId: waybill, phoneTail: "3232",
      courierCode: "ZTKY", rawCourierCode: "ZTKY", companyName: "ZTKY", manuallyAdded: true, createdAtMs: NOW - DAY },
    timeline, sourceTimeline: null, manualTimelines: [timeline], updatedAtMs: NOW - DAY,
  };
  seed([manual]);
  seedExhaustedRecognition(waybill, "network", NOW);
  assert.equal(carrierAwaitingRecognition(stored(id)), false, "exhausted: the raw code is released");
  clock = NOW + CARRIER_TERMINAL_TTL_MS + MINUTE;
  autoComNum = [{ comCode: "zhongtong", name: "中通快递" }];
  const base = loadState();
  const { runShipmentEnrichmentForTesting } = await import("../services/sync");
  await runShipmentEnrichmentForTesting(base, "interface5", "t23b-manual",
    (candidate, _routes, _stage, jobBase) => commitRefreshState(jobBase || base, candidate, "interface5", clock).state,
    clock + 30000, new Set(), true, false, undefined, {
      queryManualForSource: async () => ({ shipment: null, pending: null, routeUrl: "", result: "empty_response" }),
    });
  assert.equal(stored(id).identity.companyName, "中通快递");
  assert.equal(stored(id).identity.courierCode, "ZTO");
}

// 10. 同步路径各自放行：文案套号（列表合并、E5 本地缓存文案）与不识别的共享详情请求（E4）、识别失败兜底都读识别缓存的终态。
{
  memory.clear();
  const order = "3610000000001001", waybill = "75600000001001";
  const tracks = [{ timeText: providerTime(NOW), statusCode: "",
    detail: `您的订单由第三方卖家拣货完成，待出库交付中通快递，运单号为 ${waybill}` }];
  const orderParcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum: 103,
    details: tracks.map((track) => ({ time: track.timeText, desc: track.detail })),
  }] } })[0]!;
  assert.equal(withAccountOrderTextWaybill(orderParcel), orderParcel, "not exhausted yet: the order stays");
  seedExhaustedRecognition(waybill, "paid", NOW);
  const released = withAccountOrderTextWaybill(orderParcel);
  assert.equal(released.waybill, waybill);
  assert.deepEqual([released.courierCode, released.companyName], ["", "JDKD"]);
  // 其余裁决 33: an order whose source sent no cpCode is released too, its carrier left empty.
  const bareOrder = { ...orderParcel, courierCode: "", rawCourierCode: "", companyName: "", rawCompanyName: "" };
  const bareReleased = withAccountOrderTextWaybill(bareOrder);
  assert.equal(bareReleased.waybill, waybill);
  assert.deepEqual([bareReleased.courierCode, bareReleased.companyName], ["", ""]);
  const prepared = await prepareAccountParcelCarrier(orderParcel, {
    recognize: async () => ({ normalization: null, terminal: true, pendingSecondLevel: false, coolingDown: false,
      exhausted: true }),
  });
  assert.equal(prepared.waybill, waybill);
  assert.equal(prepared.companyName, "JDKD");

  const r20 = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: "JT4006839561002", provider: "JingDong", cpCode: "JDKD", name: "京东快递", phone: PHONE, stateNum: 104,
    details: [{ time: providerTime(NOW), desc: "运输中" }],
  }] } })[0]!;
  assert.equal(directAccountCarrierPresentation(r20).companyName, "", "not exhausted yet: no carrier shown");
  seedExhaustedRecognition("JT4006839561002", "network", NOW);
  const shown = directAccountCarrierPresentation(r20);
  assert.deepEqual([shown.courierCode, shown.companyName], ["", "JDKD"]);
  const failed = await normalizeAccountParcelCarrierBestEffort(r20, {
    recognize: async () => { throw new OperationTimeoutError(); },
  });
  assert.equal(failed.companyName, "JDKD");
}

console.log("carrier exhausted release tests passed");
