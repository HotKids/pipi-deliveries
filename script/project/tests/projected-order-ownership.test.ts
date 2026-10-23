import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW, sha256 } from "./state-storage-mock";

import type { AppState, Shipment, TimelinePackage } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { saveGatewayToken } from "../services/credentials";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { loadShipmentRoute, saveOrderProjectionReferences, saveShipmentRoute } from "../services/routes";
import { applyAccountShipment, selectShipmentDetailPresentation } from "../services/shipment-policy";
import { shipmentPresentationStatus } from "../services/status";
import {
  commitRefreshState, emptyState, loadState, loadWidgetSnapshot, saveState, setShipmentNote, visibleShipments,
} from "../services/storage";
import { replayPendingShipmentNotifications } from "../services/notifications";
import { mergeAccountParcel, projectStoredAccountOrders, refreshAllShipments } from "../services/sync";
import { attachedProjectedOrders, isAttachedShipment } from "../services/waybill-ownership";

// 投影订单的归属（用户 2026-09-25 采纳 T1–T7 与归属-1…6，2026-09-26 采纳 A；iOS）：一条上游记录只写它自己的行；同一
// 运单号上先占号的行显示，其余挂靠：行在、照常写自己的数据、不进列表、小组件、搜索与通知；手动行照 §5.2 被接管；
// 旧版本合并出来的行升级时一次性拆开；订单先占号时列表采用挂靠承运商记录报出的更新的结构化状态。
// 探针四个形态（ownership plan I5）：列表订单在前、菜鸟在前、手动行加投影订单、两单一运单。

const PHONE = "13800001818";
const ORDER = "3622448007480579";
const SECOND = "3622448007489999";
const WAYBILL = "YT3763429197051";
const REFERENCE = "https://u.jd.com/forward?synthetic=ownership";
const SECOND_REFERENCE = "https://u.jd.com/forward?synthetic=ownership-second";
const ORDER_ID = `interface5:account:${ORDER}`;
const SECOND_ID = `interface5:account:${SECOND}`;
const WAYBILL_ID = `interface5:account:${WAYBILL}`;
const MANUAL_ID = `interface5:manual:${WAYBILL}`;
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
const page = { waybillCode: WAYBILL, companyName: "圆通速递" };
const scheduled: Array<{ title: string; body: string }> = [];
let hostRejects = false;
Object.assign(globalThis, {
  Notification: { schedule: async (request: { title: string; body: string }) => {
    if (hostRejects) throw new Error("Synthetic host rejection");
    scheduled.push(request);
  } },
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
const ORDER_PICKUP = "您的订单已由圆通速递揽收";
/** The order's own list record; each round adds one newer node. */
const order = (round: number, mailNo = ORDER, link = REFERENCE) => ({
  mailNo, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum: 104,
  jumpList: [{ type: "h5", link }],
  details: [
    ...Array.from({ length: round }, (_, index) => ({
      time: providerTime(NOW - DAY + (round - index) * 600000),
      desc: `${mailNo === ORDER ? "" : "另一单："}您的订单已到达【上海转运中心${round - index}】`,
    })),
    { time: providerTime(NOW - DAY - 1000), desc: mailNo === ORDER ? ORDER_PICKUP : "另一单：您的订单已出库" },
  ],
});
/** The parcel's own record: a CaiNiao-source YTO row. */
const parcel = (stateNum: number, details: readonly { at: number; desc: string }[]) => ({
  mailNo: WAYBILL, provider: "CaiNiao", cpCode: "YTO", name: "圆通速递", phone: PHONE, stateNum,
  details: details.map(({ at, desc }) => ({ time: providerTime(at), desc })),
});
const PARCEL_TRANSIT = "快件已到达【杭州转运中心】";
const inTransit = parcel(104, [
  { at: NOW - DAY + 300000, desc: PARCEL_TRANSIT },
  { at: NOW - 2 * DAY, desc: "快件已揽收" },
]);
const inTransitNewer = parcel(104, [
  { at: NOW - 1800000, desc: "快件已到达【上海浦东营业部】" },
  { at: NOW - DAY + 300000, desc: PARCEL_TRANSIT },
  { at: NOW - 2 * DAY, desc: "快件已揽收" },
]);
const delivering = parcel(105, [
  { at: NOW - 3 * DAY, desc: "【上海市】快件正在派送中，派送员：张三" },
  { at: NOW - 5 * DAY, desc: "快件已揽收" },
]);
const signedToday = parcel(107, [
  { at: NOW - 1800000, desc: "您的快件已签收，签收人：本人" },
  { at: NOW - 3 * DAY, desc: "【上海市】快件正在派送中，派送员：张三" },
  { at: NOW - 5 * DAY, desc: "快件已揽收" },
]);
const REVIEW = `您的订单${ORDER}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。`;
const completedOrder = {
  mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum: 107,
  jumpList: [{ type: "h5", link: REFERENCE }],
  normalizedStatus: { version: 1, scope: "ORDER", semantic: "COMPLETED", code: "SERVER_ENUM", text: "已完成",
    priority: 0, eventAtMs: NOW - 2 * DAY, structured: true },
  details: [{ time: providerTime(NOW - 2 * DAY), desc: REVIEW }],
};

function row(record: unknown, at = NOW - 3600000): Shipment {
  const dto = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(dto, [PHONE], at)!, at);
}

function manualRow(note = ""): Shipment {
  const pickup: TimelinePackage = {
    provider: "v6_query", waybill: WAYBILL, courierCode: "YTO", companyName: "圆通速递", semantic: "PICKED",
    structuredStatus: true, statusEventAtMs: NOW - 2 * DAY, latestTimeText: providerTime(NOW - 2 * DAY),
    latestDetail: "【上海市】圆通速递 已揽收",
    tracks: [{ timeText: providerTime(NOW - 2 * DAY), timeMs: NOW - 2 * DAY, detail: "【上海市】圆通速递 已揽收",
      statusCode: "", raw: {} }],
    successAtMs: NOW - 2 * DAY,
  };
  return {
    identity: { id: MANUAL_ID, bindingSource: "interface5", sourceOwner: "manual", sourceId: WAYBILL,
      phoneTail: "1818", courierCode: "YTO", companyName: "圆通速递", manuallyAdded: true, createdAtMs: NOW - 2 * DAY },
    timeline: pickup, sourceTimeline: null, manualTimelines: [pickup], route: null,
    ...(note ? { note } : {}), updatedAtMs: NOW - 2 * DAY,
  };
}

function seed(rows: Shipment[], references = [{ ownerId: ORDER_ID, source: "interface5" as const, url: REFERENCE }]) {
  clock = NOW;
  memory.clear();
  scheduled.length = 0;
  setDiagnosticsEnabled(true);
  saveState({
    ...emptyState(),
    shipments: rows,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 7 * DAY }],
    feedSlotRebuiltAtMs: NOW - DAY,
  }, NOW);
  saveOrderProjectionReferences(references, NOW);
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
const byId = (id: string, state: AppState = loadState()) =>
  state.shipments.find((shipment) => shipment.identity.id === id);
const onlyVisible = () => {
  const visible = visibleShipments(loadState());
  assert.equal(visible.length, 1, "one parcel, one listed row");
  return visible[0]!;
};

// Probe shapes 1 and 2: the CaiNiao waybill row was there first; the order projects onto it afterwards. Whatever the list
// order, the waybill row stays the visible row with its own record; the order row stays, hidden, writing its own data,
// and its new nodes never notify. The waybill record's own newer event then notifies as before.
for (const orderFirst of [true, false]) {
  const label = orderFirst ? "order first" : "waybill first";
  seed([row(order(0)), { ...row(inTransit), note: "菜鸟备注" }]);
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "attempted");
  assert.equal(byId(ORDER_ID)!.identity.projectedWaybill, WAYBILL);
  assert.equal(isAttachedShipment(loadState().shipments, byId(ORDER_ID)!), true, `${label}: the later projection attaches`);
  for (let round = 1; round <= 3; round++) {
    await listRound(orderFirst ? [order(round), inTransit] : [inTransit, order(round)], NOW + round * 60_000);
    const state = loadState();
    assert.equal(state.shipments.length, 2, `${label} round ${round}: both records keep their own row`);
    const shown = onlyVisible();
    assert.equal(shown.identity.id, WAYBILL_ID);
    assert.equal(shown.identity.sourceProvider, "CaiNiao");
    assert.equal(shown.accountRecord?.waybill, WAYBILL);
    assert.equal(shown.identity.accountOrder, false);
    assert.equal(shown.timeline.latestDetail, PARCEL_TRANSIT);
    assert.ok(shown.timeline.tracks.every((track) => !track.detail.includes("您的订单")),
      "the visible row shows only its own record's nodes");
    assert.equal(shown.note, "菜鸟备注", "the waybill row keeps its remark");
    const attached = byId(ORDER_ID, state)!;
    assert.equal(attached.identity.sourceProvider, "JingDong");
    assert.equal(attached.accountRecord?.waybill, ORDER);
    assert.equal(attached.identity.projectedWaybill, WAYBILL);
    assert.equal(attached.timeline.latestDetail, `您的订单已到达【上海转运中心${round}】`,
      "the attached order keeps writing its own data");
    assert.equal(isAttachedShipment(state.shipments, attached), true);
    assert.equal(loadWidgetSnapshot().totalCount, 1, "widgets list the parcel once");
  }
  assert.deepEqual(titles(), [], `${label}: the attached order's new nodes never notify`);
  assert.deepEqual(loadState().pendingNotifications || [], []);
  await listRound(orderFirst ? [order(3), inTransitNewer] : [inTransitNewer, order(3)], NOW + 4 * 60_000);
  assert.deepEqual(titles(), ["圆通速递 7051 · 运输中"], `${label}: the waybill record's own newer event notifies`);
  assert.equal(scheduled[0]!.body, "快件已到达【上海浦东营业部】");
}

// Probe shape 3 (归属-1, 归属-6): a manual row and a projected order on one number. The projection does not touch the manual
// row; the order's next list record takes it over per §5.2 on its own row, keeping the manual history and the remark.
{
  seed([row(order(0)), manualRow("手动备注")]);
  const manualBefore = JSON.stringify(byId(MANUAL_ID));
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(JSON.stringify(byId(MANUAL_ID)), manualBefore, "the projection never rewrites the manual row");
  await listRound([order(1)], NOW + 60_000);
  const state = loadState();
  assert.equal(byId(MANUAL_ID, state), undefined, "the manual row is taken over");
  const shown = onlyVisible();
  assert.equal(shown.identity.id, ORDER_ID, "ownership goes to the order's own row");
  assert.equal(shown.identity.projectedWaybill, WAYBILL);
  assert.ok((shown.manualTimelines || []).some((timeline) => timeline.provider === "v6_query"),
    "the manual history is merged into the visible row as before");
  assert.equal(shown.note, "手动备注", "the manual row's remark moves to the row that took it over");
}
{
  seed([{ ...row(order(0)), note: "订单备注" }, manualRow("手动备注")]);
  await projectStoredAccountOrders({ onScreen: () => true });
  await listRound([order(1)], NOW + 60_000);
  assert.equal(onlyVisible().note, "订单备注", "an existing remark is never overwritten");
}

// Probe shape 4 (T6): two orders on one waybill. The first to project is shown; the second stays attached in both list
// orders, writing its own data without notifying. Only the visible order's sheet may add the other's order stage.
for (const secondFirst of [false, true]) {
  seed([row(order(0)), row(order(0, SECOND, SECOND_REFERENCE))]);
  await projectStoredAccountOrders({ onScreen: () => true });
  clock = NOW + 30_000;
  saveOrderProjectionReferences([{ ownerId: SECOND_ID, source: "interface5", url: SECOND_REFERENCE }], clock);
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(byId(SECOND_ID)!.identity.projectedWaybill, WAYBILL);
  for (let round = 1; round <= 3; round++) {
    const records = [order(0), order(round, SECOND, SECOND_REFERENCE)];
    await listRound(secondFirst ? records.reverse() : records, NOW + round * 60_000);
    const state = loadState();
    const shown = onlyVisible();
    assert.equal(shown.identity.id, ORDER_ID, "the first order to take the number is shown");
    assert.equal(shown.timeline.latestDetail, ORDER_PICKUP);
    assert.ok(shown.timeline.tracks.every((track) => !track.detail.startsWith("另一单")),
      "the shown order never displays the other order's nodes");
    const second = byId(SECOND_ID, state)!;
    assert.equal(second.timeline.latestDetail, `另一单：您的订单已到达【上海转运中心${round}】`);
    assert.deepEqual(attachedProjectedOrders(state.shipments, shown).map((item) => item.identity.id), [SECOND_ID]);
    assert.deepEqual(attachedProjectedOrders(state.shipments, second), [], "an attached row's sheet adds nothing");
  }
  assert.deepEqual(titles(), [], "the attached order never notifies");
}

// T7 at the commit itself (the replay below is a separate guard): an attached order's newer node with new text stages
// no event; the same update on a listed projected order (no waybill row) is staged as before.
for (const withWaybillRow of [true, false]) {
  seed(withWaybillRow ? [row(order(0)), row(inTransit)] : [row(order(0))]);
  await projectStoredAccountOrders({ onScreen: () => true });
  const base = loadState();
  const dto = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [order(1)] } })[0]!;
  clock = NOW + 60_000;
  const next = mergeAccountParcel(base, base.shipments, dto, [PHONE], "interface5", clock, new Map());
  const staged = commitRefreshState(base, { ...base, shipments: next }, "interface5", clock, undefined, {
    previousById: new Map(base.shipments.map((shipment) => [shipment.identity.id, shipment])),
    batchId: "synthetic-attached-commit",
  }).state.pendingNotifications || [];
  assert.deepEqual(staged.map((event) => event.shipmentId), withWaybillRow ? [] : [ORDER_ID],
    withWaybillRow ? "an attached row stages nothing" : "control: a listed projected order still stages its update");
}

// A notification the order row staged while it was still listed is dropped once the row is attached: the replay
// acknowledges it without scheduling it (the same as a row hidden by retention).
{
  seed([row(order(0)), row(inTransit)]);
  hostRejects = true;
  // Without its union-page link in this list record the refresh itself does not project the order yet.
  await listRound([{ ...order(1), jumpList: [] }, inTransit], NOW + 60_000);
  hostRejects = false;
  assert.deepEqual((loadState().pendingNotifications || []).map((event) => event.shipmentId), [ORDER_ID],
    "the unprojected order's own update is staged");
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(isAttachedShipment(loadState().shipments, byId(ORDER_ID)!), true);
  await replayPendingShipmentNotifications();
  assert.deepEqual(titles(), [], "an attached row's staged notification is not posted");
  assert.deepEqual(loadState().pendingNotifications || [], []);
}

// 归属-6: the row that becomes attached hands its remark to the visible row when that row has none, and only then; an
// existing remark on the visible row is never overwritten, and a remark the user clears later does not come back.
{
  seed([{ ...row(order(0)), note: "订单备注" }, row(inTransit)]);
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(byId(WAYBILL_ID)!.note, "订单备注");
  assert.equal(byId(ORDER_ID)!.note, undefined, "the remark moved rather than copied");
  setShipmentNote(byId(WAYBILL_ID)!, "", clock);
  await listRound([order(1), inTransit], NOW + 60_000);
  assert.equal(byId(WAYBILL_ID)!.note, undefined, "a cleared remark stays cleared");
  seed([{ ...row(order(0)), note: "订单备注" }, { ...row(inTransit), note: "菜鸟备注" }]);
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(byId(WAYBILL_ID)!.note, "菜鸟备注");
  assert.equal(byId(ORDER_ID)!.note, "订单备注", "the hidden remark stays on its own row");
}

// Decision A (user 2026-09-26): the order took the number first and the waybill's own carrier record arrives later and
// is attached. A newer structured status from it (a signing) becomes the visible order's list status and headline, once;
// timelines stay separate.
{
  seed([row(order(0))]);
  await projectStoredAccountOrders({ onScreen: () => true });
  await listRound([order(0), delivering], NOW + 60_000);
  assert.equal(byId(WAYBILL_ID)!.identity.accountOrder, false);
  assert.equal(isAttachedShipment(loadState().shipments, byId(WAYBILL_ID)!), true, "the later carrier record is attached");
  assert.equal(onlyVisible().identity.id, ORDER_ID);
  assert.equal(onlyVisible().timeline.semantic, "TRANSIT", "an older carrier status is not adopted");
  assert.equal(onlyVisible().timeline.latestDetail, ORDER_PICKUP, "and neither is its older headline");
  assert.deepEqual(titles(), []);
  await listRound([order(0), signedToday], NOW + 120_000);
  const shown = onlyVisible();
  assert.equal(shown.identity.id, ORDER_ID);
  assert.equal(shown.timeline.semantic, "COMPLETED", "the carrier record's newer signing is adopted");
  assert.equal(shipmentPresentationStatus(shown).text, "已签收");
  assert.equal(shown.timeline.latestDetail, "您的快件已签收，签收人：本人");
  assert.ok(shown.timeline.tracks.every((track) => track.detail.includes("您的订单")),
    "timelines stay separate: no carrier node enters the order row");
  assert.ok(selectShipmentDetailPresentation(shown).tracks.every((track) => track.detail.includes("您的订单")));
  assert.deepEqual(titles(), ["圆通速递 7051 · 已签收"], "one notification for the signing");
  assert.equal(scheduled[0]!.body, "您的快件已签收，签收人：本人");
  const settled = loadState();
  clock += 1000;
  assert.equal(JSON.stringify(loadState().shipments), JSON.stringify(settled.shipments),
    "reading the carried status back changes nothing");
  await listRound([order(1), signedToday], NOW + 180_000);
  await listRound([order(2), signedToday], NOW + 240_000);
  assert.deepEqual(titles(), ["圆通速递 7051 · 已签收"], "only one notification");
  assert.equal(onlyVisible().timeline.semantic, "COMPLETED");
}

// Decision A, reverse direction: the waybill row was first and the order is attached; the order's completion never
// lends its status to the waybill row (the 2026-09-08 rule stands).
{
  seed([row(order(0)), row(delivering)]);
  await projectStoredAccountOrders({ onScreen: () => true });
  await listRound([completedOrder, delivering], NOW + 60_000);
  const shown = onlyVisible();
  assert.equal(shown.identity.id, WAYBILL_ID);
  assert.equal(shown.timeline.semantic, "DELIVERY");
  assert.equal(shown.attachedCarrierStatus, undefined);
  assert.deepEqual(titles(), []);
}

// 归属-2: the visible waybill row's sheet adds the attached order's order-stage nodes older than the shown package's
// earliest node, newest first, after it. Later order nodes are not added; the list row and the stored row do not change.
{
  const orderStage = {
    ...order(0),
    details: [
      { time: providerTime(NOW - DAY + 60_000), desc: "您的订单已到达【杭州转运中心】" },
      { time: providerTime(NOW - 3 * DAY), desc: "您的订单已出库" },
      { time: providerTime(NOW - 4 * DAY), desc: "您提交了订单，请等待系统确认" },
    ],
  };
  seed([row(orderStage), row(inTransit)]);
  await projectStoredAccountOrders({ onScreen: () => true });
  await listRound([orderStage, inTransit], NOW + 60_000);
  const state = loadState();
  const shown = onlyVisible();
  const attached = attachedProjectedOrders(state.shipments, shown);
  assert.deepEqual(attached.map((item) => item.identity.id), [ORDER_ID]);
  const plain = selectShipmentDetailPresentation(shown);
  const withStage = selectShipmentDetailPresentation(shown, attached);
  assert.deepEqual(withStage.tracks.map((track) => track.detail), [
    ...plain.tracks.map((track) => track.detail), "您的订单已出库", "您提交了订单，请等待系统确认",
  ]);
  assert.equal(shown.timeline.tracks.length, plain.tracks.length, "the stored row is unchanged");
  const orderRow = byId(ORDER_ID, state)!;
  assert.deepEqual(selectShipmentDetailPresentation(orderRow, attachedProjectedOrders(state.shipments, orderRow)).tracks,
    selectShipmentDetailPresentation(orderRow).tracks, "the attached row's sheet adds nothing");
}

// 归属-4 (existing data): the old code left an order-number row holding the waybill record's account tuple, the waybill
// row itself gone. Loading the stored state splits it once: the waybill row comes back as the visible row, showing what
// the merged row showed, with the parcel's caches, the user's sign-off and remark and its own route; the order returns to
// its own identity and is attached, keeping everything it had. No notification; one whitelisted log line per row.
{
  seed([row(order(1)), row(inTransit)]);
  await projectStoredAccountOrders({ onScreen: () => true });
  const projected = byId(ORDER_ID)!;
  const waybillRow = byId(WAYBILL_ID)!;
  const slot = (provider: string, detail: string, at: number): TimelinePackage => ({
    provider, waybill: WAYBILL, courierCode: "YTO", companyName: "圆通速递", semantic: "TRANSIT", complete: true,
    structuredStatus: false, statusEventAtMs: at, latestTimeText: providerTime(at), latestDetail: detail,
    tracks: [{ timeText: providerTime(at), timeMs: at, detail, statusCode: "", raw: {} },
      { timeText: providerTime(NOW - 2 * DAY), timeMs: NOW - 2 * DAY, detail: "快件已揽收", statusCode: "", raw: {} }],
    successAtMs: at,
  });
  const caches = [
    slot("jd_h5", "京粉页：运输中", NOW - DAY + 120_000),
    slot("v6_query", "在线查询：运输中", NOW - DAY + 180_000),
    slot("cn_h5", "菜鸟页：运输中", NOW - DAY + 240_000),
    slot("v5_query", "按件详情：运输中", NOW - DAY + 200_000),
  ];
  const mergedIdentity = { ...projected.identity, sourceProvider: "CaiNiao",
    rawCourierCode: "YTO", rawCompanyName: "圆通速递" };
  const merged: Shipment = {
    ...projected,
    identity: mergedIdentity,
    accountRecord: waybillRow.accountRecord,
    route: { kind: "cainiao", source: "interface5" },
    manualTimelines: caches,
    note: "合并行备注",
    forcedCompletedAtMs: NOW - 60_000,
    automaticOwnership: {
      ...projected.automaticOwnership!,
      observations: projected.automaticOwnership!.observations.map((observation) => ({
        ...observation, identity: mergedIdentity, accountRecord: waybillRow.accountRecord,
      })),
    },
  };
  delete merged.occupiedAtMs;
  // A second old merged row whose waybill row came back is left alone (its split would be ambiguous).
  const OTHER = "ZT1234567890123";
  const otherRow = row({ ...inTransit, mailNo: OTHER, provider: "CaiNiao", cpCode: "ZTO", name: "中通快递" });
  const otherOrder: Shipment = {
    ...projected,
    identity: { ...projected.identity, id: "interface5:account:3622448007481111", sourceId: "3622448007481111",
      orderId: "3622448007481111", projectedWaybill: OTHER, sourceProvider: "CaiNiao" },
    accountRecord: otherRow.accountRecord,
    automaticOwnership: undefined,
  };
  delete otherOrder.occupiedAtMs;
  delete otherRow.occupiedAtMs;
  const raw = { ...loadState(), shipments: [merged, otherOrder, otherRow], pendingNotifications: [] };
  const ROUTE = "https://page.cainiao.com/detail?synthetic=ownership-split";
  memory.clear();
  saveGatewayToken("AbCdEfGh_123-456");
  saveOrderProjectionReferences([{ ownerId: ORDER_ID, source: "interface5", url: REFERENCE }], NOW);
  assert.equal(saveShipmentRoute(ORDER_ID, "interface5", ROUTE, NOW), true);
  memory.set("pipi_deliveries_state_v1", { schema: 2, checksum: sha256(JSON.stringify(raw)), state: raw });
  setDiagnosticsEnabled(true);
  assert.equal(readDiagnostics().length, 0, "the log starts empty with the cleared store");
  scheduled.length = 0;
  clock = NOW + 60_000;

  const split = loadState(clock);
  const restored = byId(WAYBILL_ID, split)!;
  const orderRow = byId(ORDER_ID, split)!;
  assert.ok(restored, "the waybill row is rebuilt");
  assert.deepEqual(visibleShipments(split, clock).map((item) => item.identity.id).sort(),
    [WAYBILL_ID, otherRow.identity.id].sort(), "the rebuilt waybill row is the one listed");
  assert.equal(restored.identity.accountOrder, false);
  assert.equal(restored.identity.sourceProvider, "CaiNiao");
  assert.equal(restored.accountRecord?.waybill, WAYBILL);
  assert.equal(restored.timeline.latestDetail, merged.timeline.latestDetail, "what the merged row showed stays");
  assert.equal(restored.note, "合并行备注", "the remark follows the visible row");
  assert.equal(restored.forcedCompletedAtMs, merged.forcedCompletedAtMs, "the user's sign-off is kept");
  assert.deepEqual((restored.manualTimelines || []).map((timeline) => timeline.provider).sort(), ["cn_h5", "v6_query"],
    "parcel caches come along; the order's jd_h5 page and order-number query do not");
  assert.equal(loadShipmentRoute(WAYBILL_ID, "interface5", clock), ROUTE, "the record's route follows its own row");
  assert.equal(orderRow.identity.sourceProvider, "JingDong");
  assert.equal(orderRow.accountRecord?.waybill, ORDER);
  assert.equal(orderRow.identity.projectedWaybill, WAYBILL);
  assert.equal(orderRow.note, undefined);
  assert.equal(orderRow.forcedCompletedAtMs, merged.forcedCompletedAtMs, "nothing is deleted from the order row");
  assert.deepEqual((orderRow.manualTimelines || []).map((timeline) => timeline.provider).sort(),
    ["cn_h5", "jd_h5", "v5_query", "v6_query"], "no cache is deleted");
  assert.equal(isAttachedShipment(split.shipments, orderRow), true);
  assert.ok(orderRow.automaticOwnership!.observations.every((observation) =>
    observation.identity.sourceProvider === "JingDong" && observation.accountRecord?.waybill === ORDER));
  const other = byId("interface5:account:3622448007481111", split)!;
  assert.equal(other.identity.sourceProvider, "CaiNiao", "an ambiguous row is left as it was");
  assert.equal(other.accountRecord?.waybill, OTHER);
  assert.deepEqual(split.pendingNotifications || [], []);
  const events = readDiagnostics().filter((entry) => entry.event.startsWith("ownership.split."));
  assert.deepEqual(events.map((entry) => entry.event).sort(),
    ["ownership.split.applied", "ownership.split.completed", "ownership.split.skipped"]);
  assert.equal(events.find((entry) => entry.event === "ownership.split.skipped")!.details.skipReason,
    "waybill_row_exists");
  const summary = events.find((entry) => entry.event === "ownership.split.completed")!.details;
  assert.deepEqual([summary.records, summary.succeeded, summary.failed], [2, 1, 1]);
  for (const entry of events) {
    const text = JSON.stringify(entry.details);
    for (const number of [ORDER, WAYBILL, OTHER, "0579", "7051"]) {
      assert.ok(!text.includes(number), `no waybill or order number in ${entry.event}`);
    }
  }
  assert.equal(JSON.stringify(loadState(clock).shipments), JSON.stringify(split.shipments), "the split happens once");
  assert.equal(readDiagnostics().filter((entry) => entry.event.startsWith("ownership.split.")).length, 3);

  saveState({ ...loadState(clock), bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 7 * DAY }] }, clock);
  await listRound([order(1), inTransit], NOW + 120_000);
  assert.deepEqual(titles(), [], "the split never notifies");
  assert.equal(visibleShipments(loadState()).find((item) => item.identity.id === WAYBILL_ID)?.identity.id, WAYBILL_ID);
}

console.log("projected order ownership tests passed");
