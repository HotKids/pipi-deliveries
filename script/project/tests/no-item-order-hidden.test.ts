import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";

import type { AppState, Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import {
  ACCOUNT_ORDER_PROJECTION_RETRY_MS,
  accountOrderProjectionRouteHash,
  nextEmptyShellStrikes,
} from "../services/account-sync-policy";
import { saveGatewayToken } from "../services/credentials";
import { setDiagnosticsEnabled } from "../services/logger";
import { replayPendingShipmentNotifications } from "../services/notifications";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { saveOrderProjectionReferences } from "../services/routes";
import { applyAccountShipment } from "../services/shipment-policy";
import { isConfirmedNoItemOrder } from "../services/status";
import {
  commitRefreshState,
  emptyState,
  loadState,
  loadWidgetSnapshot,
  saveState,
  visibleShipments,
} from "../services/storage";
import { projectStoredAccountOrders } from "../services/sync";
import { seedRecognizedCarriers } from "./carrier-recognition-seed";

// 用户 2026-09-25 同意（方案 B，iOS 与 Lite）：确认没有商品物流的京东订单行（…4421 这种赠品单）像留存期到了的行一样
// 隐藏：不上首页列表与小组件，隐藏期间不通知；存盘行、缓存与留存／删除时间表都不动；三条里任何一条不再成立就自动
// 重新显示。三条：(i) 接口 5 的京东账号订单、已完成、从未有过真实运单号；(ii) 它自己的 feed 只有订单级的完成／评价
// 节点；(iii) 方案 A 已确认它的京粉页是空壳。

const PHONE = "13800002121";
const ORDER = "351100064421";
const OWNER_ID = `interface5:account:${ORDER}`;
const REFERENCE = "https://u.jd.com/forward?synthetic=gift-order";
const REVIEW = `您的订单${ORDER}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。`;
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
const scheduled: string[] = [];
let pageLoads = 0;
// The gift order's union page: it loads, JD answers 200, and nothing about logistics ever comes back.
const EMPTY_SHELL = {
  extractionSource: "diagnostic", probeInstalled: true, probeRequestCount: 31, unionSignalSeen: true,
  unionResourceSeen: true, resourceReplayAttempted: true, resourceReplaySucceeded: false,
  resourceReplayBlockReason: "", resourceCount: 47, pageClass: "jd", riskControlSeen: false,
  readyState: "complete", visibilityState: "visible", viewportAvailable: true,
  unionResponseStatuses: "200", probeCaptureCount: 0,
};
Object.assign(globalThis, {
  Notification: { schedule: async (request: { title: string }) => { scheduled.push(request.title); } },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    constructor() { pageLoads++; }
    async loadURL() { return true; }
    async evaluateJavaScript() {
      clock += 10_000;
      return EMPTY_SHELL;
    }
    dispose() {}
  },
});
globalThis.fetch = (async () => ({ ok: false, status: 503, text: async () => "Synthetic offline" })) as typeof fetch;
registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

function orderRow(details: readonly { at: number; desc: string }[], stateNum = 107): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum,
    details: details.map(({ at, desc }) => ({ time: providerTime(at), desc })),
  }] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], NOW - DAY)!, NOW - DAY);
}
const giftRow = () => orderRow([{ at: NOW - 2 * DAY, desc: REVIEW }]);

/** The record change 2 leaves after two empty pages one rest apart. */
function marked(row: Shipment): Shipment {
  return { ...row, identity: { ...row.identity, orderProjectionRetry: {
    routeHash: accountOrderProjectionRouteHash(row.identity.id),
    failedAtMs: NOW - DAY,
    emptyShellAtMs: NOW - DAY - ACCOUNT_ORDER_PROJECTION_RETRY_MS - 60_000,
    emptyShellConfirmedAtMs: NOW - DAY,
  } } };
}

function seed(rows: Shipment[]) {
  clock = NOW;
  memory.clear();
  scheduled.length = 0;
  setDiagnosticsEnabled(true);
  saveState({
    ...emptyState(),
    shipments: rows,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 30 * DAY }],
    feedSlotRebuiltAtMs: NOW - DAY,
  }, NOW);
  saveOrderProjectionReferences([{ ownerId: OWNER_ID, source: "interface5", url: REFERENCE }], NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  pageLoads = 0;
}

const stored = (at = clock) => loadState(at).shipments.find((shipment) => shipment.identity.id === OWNER_ID);
const shown = (at = clock) => visibleShipments(loadState(at), at).some((shipment) => shipment.identity.id === OWNER_ID);

// End to end: the gift order's page is empty twice, a rest apart (change 2); the row then leaves the
// Home list and the widgets, and the pass that found it has nothing more to do.
{
  seed([giftRow()]);
  assert.equal(shown(), true);
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(shown(), true, "one empty page is not proof");
  clock = stored()!.identity.orderProjectionRetry!.failedAtMs! + ACCOUNT_ORDER_PROJECTION_RETRY_MS + 1_000;
  await projectStoredAccountOrders({ onScreen: () => true });
  assert.ok(stored()!.identity.orderProjectionRetry?.emptyShellConfirmedAtMs, "confirmed by change 2");
  assert.equal(isConfirmedNoItemOrder(stored()!), true);
  assert.equal(shown(), false, "hidden from the Home list");
  assert.equal(loadWidgetSnapshot(clock).totalCount, 0, "hidden from the widgets");
  assert.ok(stored(), "the stored row stays");
  assert.equal((await projectStoredAccountOrders({ onScreen: () => true })).result, "nothing_due");
  assert.equal(pageLoads, 2);
}

// The same shape without the mark is shown.
{
  seed([giftRow()]);
  assert.equal(isConfirmedNoItemOrder(stored()!), false);
  assert.equal(shown(), true);
  assert.equal(loadWidgetSnapshot(clock).totalCount, 1);
}

// A real order with a logistics node is never hidden, even with the mark.
{
  seed([marked(orderRow([
    { at: NOW - 2 * DAY, desc: REVIEW },
    { at: NOW - 3 * DAY, desc: "您的订单已由京东快递揽收，揽收员：李四" },
  ]))]);
  assert.ok(stored()!.identity.orderProjectionRetry?.emptyShellConfirmedAtMs);
  assert.equal(isConfirmedNoItemOrder(stored()!), false);
  assert.equal(shown(), true);
}

// A projected order is never hidden.
{
  const projected = marked(giftRow());
  const row = { ...projected, identity: { ...projected.identity, projectedWaybill: "JD0256747734421" } };
  assert.equal(isConfirmedNoItemOrder(row), false);
  seed([row]);
  assert.equal(shown(), true);
}

// Hidden rows never notify: a change that notifies the unmarked row queues nothing for the marked
// one, and an event queued while the row was shown is not delivered once it is hidden.
{
  // The list's previous answer for the same order: still 派送中 (raw 105).
  const before = (row: Shipment): Shipment => ({
    ...orderRow([{ at: NOW - 3 * DAY, desc: "您的订单正在派送中，请您准备签收" }], 105),
    identity: row.identity,
  });
  const commit = (previous: Shipment, next: Shipment): AppState => {
    seed([previous]);
    const base = loadState();
    return commitRefreshState(base, { ...base, shipments: [next] }, "interface5", clock).state;
  };
  assert.equal(commit(before(giftRow()), giftRow()).pendingNotifications?.length, 1,
    "control: the shown row's status change is an event");
  assert.deepEqual(commit(before(marked(giftRow())), marked(giftRow())).pendingNotifications || [], [],
    "the hidden row queues nothing");

  commit(before(giftRow()), giftRow());
  saveState({ ...loadState(), shipments: [marked(stored()!)] }, clock);
  assert.equal(loadState().pendingNotifications?.length, 1);
  await replayPendingShipmentNotifications();
  assert.deepEqual(scheduled, [], "a queued event is not delivered while the row is hidden");
  assert.deepEqual(loadState().pendingNotifications || [], []);
}

// The ordinary retention and deletion schedule is unchanged; nothing is deleted early.
{
  const schedule = (row: Shipment) => {
    seed([row]);
    return [18, 20].map((days) => {
      clock = NOW + days * DAY;
      saveState(loadState(clock), clock);
      return Boolean(stored());
    });
  };
  assert.deepEqual(schedule(marked(giftRow())), schedule(giftRow()));
  assert.deepEqual(schedule(marked(giftRow())), [true, false], "kept to day 21 of its list date, then deleted");
}

// The row comes back by itself as soon as a condition stops holding.
{
  // (iii) A later capture clears the mark (the record a capture leaves carries no strikes).
  const hidden = marked(giftRow());
  seed([hidden]);
  assert.equal(shown(), false);
  const previous = hidden.identity.orderProjectionRetry!;
  const captured: Shipment = { ...hidden, identity: { ...hidden.identity, orderProjectionRetry: {
    routeHash: previous.routeHash,
    failedAtMs: clock,
    ...nextEmptyShellStrikes(previous, previous.routeHash, "logistics", true, clock),
  } } };
  saveState({ ...loadState(), shipments: [captured] }, clock);
  assert.equal(stored()!.identity.orderProjectionRetry?.emptyShellConfirmedAtMs, undefined);
  assert.equal(shown(), true, "a later capture brings the row back");

  // (ii) A logistics node in its own feed.
  seed([hidden]);
  const withNode = marked(orderRow([
    { at: NOW - DAY, desc: "您的订单已由京东快递揽收，揽收员：李四" },
    { at: NOW - 2 * DAY, desc: REVIEW },
  ]));
  saveState({ ...loadState(), shipments: [withNode] }, clock);
  assert.equal(shown(), true, "a logistics node brings the row back");

  // (i) A real waybill named by the feed text. T23 (user 2026-09-26, 其余裁决 28): it is projected once recognition
  // matched its carrier.
  seed([hidden]);
  seedRecognizedCarriers({ JD0256747734421: "JD" });
  const named = orderRow([
    { at: NOW - DAY, desc: "您的订单已交付京东快递，运单号为JD0256747734421" },
    { at: NOW - 2 * DAY, desc: REVIEW },
  ]);
  assert.equal(named.identity.projectedWaybill, "JD0256747734421");
  saveState({ ...loadState(), shipments: [marked(named)] }, clock);
  assert.equal(shown(), true, "a waybill brings the row back");
}

console.log("confirmed no-item JD order visibility tests passed");
