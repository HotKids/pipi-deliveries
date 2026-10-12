import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";

import type { Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { saveGatewayToken } from "../services/credentials";
import { setDiagnosticsEnabled } from "../services/logger";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { saveOrderProjectionReferences } from "../services/routes";
import { applyAccountShipment } from "../services/shipment-policy";
import { shipmentPresentationStatus } from "../services/status";
import { commitRefreshState, emptyState, loadState, saveState, visibleShipments } from "../services/storage";
import { projectStoredAccountOrders, refreshAllShipments } from "../services/sync";

// 用户 2026-09-25，两条合起来：订单行投影后与同一运单的已有行合并的那一轮，通知判断改用被并入的运单行当「上一次
// 状态」（该行在这一轮开始时的快照里存在时），并且只有展示状态变了才推；快照里没有被并入的行时，照样只认状态变化，
// 比的是留下来的那一行。之后各轮照旧。
// Lite 上 0579 投影成 YT3763429197051 后并进那张早已签收的菜鸟来源运单行，推了一条六天前的「圆通速递 7051 ·
// 已签收」；iOS 上订单级「已完成」不是结构化状态时，投影后的订单行显示暂无状态，并进已签收的运单行时同样会推。
// 同日晚用户采纳归属方案（T1–T7，归属-3/4）：订单只写它自己的行，运单行先占号时订单挂靠、隐藏、不通知，不再有
// 「并进来的那一轮」；合并轮的规则留在代码里作兜底（最后一段仍单独测它）。下面的设备形态改为验证采纳后的行为：
// 可见的始终是运单行自己的记录，挂靠订单从不通知，运单行自己的轮次走普通规则（以前被合并轮压住的同状态新节点照常推）。

const PHONE = "13800001818";
const ORDER = "3622448007480579";
const WAYBILL = "YT3763429197051";
const REFERENCE = "https://u.jd.com/forward?synthetic=merge-notification";
const ORDER_ID = `interface5:account:${ORDER}`;
const DAY = 86400000;

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
let page = { waybillCode: WAYBILL, companyName: "圆通速递" };
const scheduled: Array<{ title: string; body: string }> = [];
Object.assign(globalThis, {
  Notification: { schedule: async (request: { title: string; body: string }) => { scheduled.push(request); } },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    async loadURL() { return true; }
    async evaluateJavaScript() { return { extractionSource: "probe", ...page, traceList: [] }; }
    dispose() {}
  },
});
registerProjectionViewportHost({ mount: async () => false, unmount: () => {} });

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const orderBase = { mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
  jumpList: [{ type: "h5", link: REFERENCE }] };
const REVIEW = `您的订单${ORDER}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。`;
/** Order-level 已完成 (raw 107), completed after the carrier's signing. */
const completedOrder = (structured: boolean) => ({
  ...orderBase, stateNum: 107,
  normalizedStatus: { version: 1, scope: "ORDER", semantic: "COMPLETED", code: "SERVER_ENUM", text: "已完成",
    priority: 0, eventAtMs: NOW - 4 * DAY, structured },
  details: [{ time: providerTime(NOW - 4 * DAY), desc: REVIEW }],
});
const transitOrder = { ...orderBase, stateNum: 104,
  details: [{ time: providerTime(NOW - DAY), desc: "您的订单已到达【杭州转运中心】" }] };
/** The existing row for the same parcel: a CaiNiao-source (non-JD) automatic record. */
const waybillRecord = (stateNum: number, details: readonly { at: number; desc: string }[]) => ({
  mailNo: WAYBILL, provider: "CaiNiao", cpCode: "YTO", name: "圆通速递", phone: PHONE, stateNum,
  details: details.map(({ at, desc }) => ({ time: providerTime(at), desc })),
});
const signedSixDaysAgo = waybillRecord(107, [
  { at: NOW - 6 * DAY, desc: "您的快件已签收，签收人：本人" },
  { at: NOW - 7 * DAY, desc: "快件已揽收" },
]);
const inTransit = waybillRecord(104, [
  { at: NOW - DAY, desc: "快件已到达【杭州转运中心】" },
  { at: NOW - 2 * DAY, desc: "快件已揽收" },
]);
const inTransitLater = waybillRecord(104, [
  { at: NOW - 3600000, desc: "快件已到达【上海转运中心】" },
  { at: NOW - DAY, desc: "快件已到达【杭州转运中心】" },
  { at: NOW - 2 * DAY, desc: "快件已揽收" },
]);
const inTransitLatest = waybillRecord(104, [
  { at: NOW - 1800000, desc: "快件已到达【上海浦东营业部】" },
  { at: NOW - 3600000, desc: "快件已到达【上海转运中心】" },
  { at: NOW - DAY, desc: "快件已到达【杭州转运中心】" },
  { at: NOW - 2 * DAY, desc: "快件已揽收" },
]);
const delivering = waybillRecord(105, [
  { at: NOW - 3 * DAY, desc: "【上海市】快件正在派送中，派送员：张三" },
  { at: NOW - 5 * DAY, desc: "快件已揽收" },
]);
const signedToday = waybillRecord(107, [
  { at: NOW - 1800000, desc: "您的快件已签收，签收人：本人" },
  { at: NOW - 3 * DAY, desc: "【上海市】快件正在派送中，派送员：张三" },
  { at: NOW - 5 * DAY, desc: "快件已揽收" },
]);

function row(record: unknown): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], NOW - 3600000)!, NOW - 3600000);
}

function seed(rows: Shipment[]) {
  clock = NOW;
  memory.clear();
  scheduled.length = 0;
  setDiagnosticsEnabled(true);
  saveState({
    ...emptyState(),
    shipments: rows,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - DAY }],
    feedSlotRebuiltAtMs: NOW - DAY,
  }, NOW);
  saveOrderProjectionReferences([{ ownerId: ORDER_ID, source: "interface5", url: REFERENCE }], NOW);
  saveGatewayToken("AbCdEfGh_123-456");
}

async function listRound(records: readonly unknown[], at: number) {
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path !== "/api/express/accounts/sync") {
      return { ok: false, status: 503, text: async () => "Synthetic offline" };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: records } }) };
  }) as typeof fetch;
  clock = at;
  await refreshAllShipments();
}

const titles = () => scheduled.map((request) => request.title);
const orderRow = () => loadState().shipments.find((shipment) => shipment.identity.id === ORDER_ID)!;
/** 归属-4（旧期望：两行合成订单号的一行）：两条记录各留各的行，先占号的运单行是唯一显示的一行。 */
const shownWaybillRow = () => {
  const state = loadState();
  assert.equal(state.shipments.length, 2, "each record keeps its own row");
  const visible = visibleShipments(state);
  assert.equal(visible.length, 1, "one parcel, one listed row");
  assert.equal(visible[0]!.identity.id, `interface5:account:${WAYBILL}`, "the waybill row that came first is shown");
  assert.equal(orderRow().identity.projectedWaybill, WAYBILL, "the attached order keeps its projection");
  return visible[0]!;
};

// The Lite device shape: a signed CaiNiao-source waybill row, and the completed order the on-screen
// pass projects to the same waybill. The order attaches to the waybill row, which stays as it was: no notification.
// (Old expectation: the rows merged into the order's row and the absorbed row was the baseline.)
{
  seed([row(completedOrder(true)), row(signedSixDaysAgo)]);
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "attempted");
  assert.equal(loadState().shipments.length, 2, "the projection itself leaves the waybill row in place");
  await listRound([completedOrder(true), signedSixDaysAgo], NOW + 60_000);
  assert.equal(shownWaybillRow().timeline.semantic, "COMPLETED");
  assert.deepEqual(titles(), [], "the old signing is not notified again");
  assert.deepEqual(loadState().pendingNotifications || [], []);
}

// The iOS shape: an unstructured order-level 已完成 leaves the projected order row at 暂无状态. That row is attached
// behind the signed CaiNiao-source row, so its 暂无状态 is never listed or compared: no event.
// (Old expectation: the merged order row was compared with the absorbed waybill row.)
{
  seed([row(completedOrder(false)), row(signedSixDaysAgo)]);
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(orderRow().identity.projectedWaybill, WAYBILL);
  assert.equal(shipmentPresentationStatus(orderRow()).semantic, "UNKNOWN", "the order row shows 暂无状态");
  await listRound([completedOrder(false), signedSixDaysAgo], NOW + 60_000);
  assert.equal(shownWaybillRow().timeline.semantic, "COMPLETED");
  assert.deepEqual(titles(), [], "the attached order's 暂无状态 never reaches the listed row or a notification");
  assert.deepEqual(loadState().pendingNotifications || [], []);
}

// A real change of the listed row notifies: the waybill row showed 派送中 and its own record signs it. (The attached
// order row already read 已完成; it neither notifies nor lends that status to the waybill row.)
{
  seed([row(completedOrder(true)), row(delivering)]);
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(shipmentPresentationStatus(orderRow()).semantic, "COMPLETED");
  await listRound([completedOrder(true), signedToday], NOW + 60_000);
  assert.equal(shownWaybillRow().timeline.semantic, "COMPLETED");
  assert.deepEqual(titles(), ["圆通速递 7051 · 已签收"]);
  assert.equal(scheduled[0]!.body, "您的快件已签收，签收人：本人");
}

// Same presented status (T7; old expectation: the merge round muted this update): there is no merge round any more,
// so the waybill row's own newer event with new text notifies under the existing rules, and so does the next one.
{
  seed([row(transitOrder), row(inTransit)]);
  await projectStoredAccountOrders({ onScreen: () => true });
  await listRound([transitOrder, inTransitLater], NOW + 60_000);
  assert.equal(shownWaybillRow().timeline.semantic, "TRANSIT");
  assert.equal(shownWaybillRow().timeline.latestDetail, "快件已到达【上海转运中心】");
  assert.deepEqual(titles(), ["圆通速递 7051 · 运输中"], "the listed row's own newer event notifies");
  assert.equal(scheduled[0]!.body, "快件已到达【上海转运中心】");
  await listRound([transitOrder, inTransitLatest], NOW + 120_000);
  assert.deepEqual(titles(), ["圆通速递 7051 · 运输中", "圆通速递 7051 · 运输中"], "later rounds keep the existing rules");
  assert.equal(scheduled[1]!.body, "快件已到达【上海浦东营业部】");
}

// No earlier row for the waybill: a projected order keeps the existing rules, text updates included.
{
  page = { waybillCode: "JD0256747737301", companyName: "京东快递" };
  const later = { ...orderBase, stateNum: 104, details: [
    { time: providerTime(NOW - 3600000), desc: "您的订单已到达【上海浦东站】" },
    { time: providerTime(NOW - DAY), desc: "您的订单已到达【杭州转运中心】" },
  ] };
  const signed = { ...orderBase, stateNum: 107, details: [
    { time: providerTime(NOW - 1800000), desc: "您的订单已签收，感谢您在京东购物" },
    { time: providerTime(NOW - 3600000), desc: "您的订单已到达【上海浦东站】" },
    { time: providerTime(NOW - DAY), desc: "您的订单已到达【杭州转运中心】" },
  ] };
  seed([row(transitOrder)]);
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(loadState().shipments[0]!.identity.projectedWaybill, "JD0256747737301");
  assert.deepEqual(titles(), []);
  await listRound([later], NOW + 60_000);
  assert.deepEqual(titles(), ["京东快递 7301 · 运输中"], "a newer event with new text notifies as before");
  await listRound([signed], NOW + 120_000);
  assert.deepEqual(titles(), ["京东快递 7301 · 运输中", "京东快递 7301 · 已签收"]);
}

// The commit rule on its own: a merge whose absorbed row is not in the round's snapshot keeps the
// surviving row's own baseline, still status-only; with no merge the existing rules apply.
{
  const pending = (previous: Shipment, next: Shipment, orderMerges?: ReadonlyMap<string, readonly string[]>) => {
    seed([previous]);
    const base = loadState();
    const context = {
      previousById: new Map(base.shipments.map((shipment) => [shipment.identity.id, shipment])),
      batchId: "synthetic-merge-round",
      ...(orderMerges ? { orderMerges } : {}),
    };
    return (commitRefreshState(base, { ...base, shipments: [next] }, "interface5", NOW, undefined, context)
      .state.pendingNotifications || []).map((event) => event.title);
  };
  const id = row(inTransit).identity.id;
  const absent = new Map([[id, [`interface5:account:NOT${WAYBILL}`]]]);
  assert.deepEqual(pending(row(inTransit), row(inTransitLater)), ["圆通速递 7051 · 运输中"],
    "control: without a merge a newer event with new text notifies");
  assert.deepEqual(pending(row(inTransit), row(inTransitLater), absent), [],
    "merge round without its absorbed row in the snapshot: status-only against the surviving row");
  assert.deepEqual(pending(row(inTransit), row(signedToday), absent), ["圆通速递 7051 · 已签收"]);
}

console.log("projection merge notification rule tests passed");
