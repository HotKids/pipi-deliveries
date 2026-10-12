import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";

import { parseAccountSyncResponse } from "../services/account-parser";
import { accountParcelStructuredSemantic, parcelToShipment } from "../services/account-sync";
import { ACCOUNT_ORDER_PROJECTION_RETRY_MS } from "../services/account-sync-policy";
import { saveGatewayToken } from "../services/credentials";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import {
  jingDongFeedReachedPickup,
  jingDongOrderPastPickup,
} from "../services/shipment-policy";
import { emptyState, loadState, saveState } from "../services/storage";
import { refreshAllShipments } from "../services/sync";

// 2026-09-24：京东列表只给最新一条「派送中」、没有揽收字样时，首页从来投影不出运单号，只能靠
// 详情页下拉。首页投影问的是「揽收了没有」，看结构化状态；详情页那道「feed 历史全不全」的门
// （jingDongFeedReachedPickup）照旧只认文字节点，不受影响。与 Lite ExpressHomeOrderProjectionCapture
// 同口径。

const PHONE = "13800001515";
const EVENT_AT = 1790207894000;

function orderRecord(semantic: string, detail: string, structured = true) {
  return {
    mailNo: "3622448007483887",
    provider: "JingDong",
    cpCode: "JDKD",
    name: "京东商品快递",
    phone: PHONE,
    normalizedStatus: {
      version: 1, scope: "ORDER", semantic, code: "SERVER_ENUM", text: semantic,
      priority: 0, eventAtMs: EVENT_AT, structured,
    },
    details: [{ time: "2026-09-24 07:58:14", desc: detail }],
  };
}

function orderParcel(record: ReturnType<typeof orderRecord>) {
  return parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
}

function orderRow(semantic: string, detail: string) {
  return parcelToShipment(orderParcel(orderRecord(semantic, detail)), [PHONE], EVENT_AT + 60_000)!;
}

for (const [semantic, detail] of [
  ["DELIVERY", "您的订单正在派送中，请您准备签收（快递员：测试员，电话：19900000000）"],
  ["TRANSIT", "您的订单已到达【深圳万丰站】，营业部电话：18126122042"],
] as const) {
  const row = orderRow(semantic, detail);
  assert.equal(jingDongFeedReachedPickup(row), false, `${semantic}: feed has no pickup node`);
  assert.equal(jingDongOrderPastPickup(row), true, `${semantic}: structured status is past pickup`);
}

for (const [semantic, detail] of [
  ["ORDERED", "您提交了订单，请等待系统确认"],
  ["SHIPPED", "您的订单已出库"],
  ["COMPLETED", "您的订单已完成"],
] as const) {
  const parcel = orderParcel(orderRecord(semantic, detail));
  const row = parcelToShipment(parcel, [PHONE], EVENT_AT + 60_000)!;
  assert.equal(jingDongOrderPastPickup(row, accountParcelStructuredSemantic(parcel)), false, semantic);
}

// 结构化的「已揽收」：未投影的订单行存盘时被压成「已下单」（「已揽收且没有运单号才显示已下单」），行上
// 不再挂 normalizedStatus，只看行永远判不出揽收。门要读列表这一行压之前的结构化状态。
{
  const parcel = orderParcel(orderRecord("PICKED", "您的订单已出库"));
  const row = parcelToShipment(parcel, [PHONE], EVENT_AT + 60_000)!;
  assert.equal(row.sourceTimeline?.semantic, "ORDERED", "the stored row keeps the order-stage display");
  assert.equal(jingDongOrderPastPickup(row), false, "the clamped row alone cannot show the pickup");
  assert.equal(accountParcelStructuredSemantic(parcel), "PICKED");
  assert.equal(jingDongOrderPastPickup(row, accountParcelStructuredSemantic(parcel)), true);
  // 接口 5 的状态码 103 本身就是结构化枚举；worker 标成非结构化的 PICKED 不算。
  const coded = orderParcel({ ...orderRecord("PICKED", "您的订单已出库"), normalizedStatus: undefined,
    stateNum: 103 } as unknown as ReturnType<typeof orderRecord>);
  assert.equal(accountParcelStructuredSemantic(coded), "PICKED");
  const prose = orderParcel(orderRecord("PICKED", "您的订单已出库", false));
  assert.equal(accountParcelStructuredSemantic(prose), null);
  assert.equal(jingDongOrderPastPickup(parcelToShipment(prose, [PHONE], EVENT_AT + 60_000)!,
    accountParcelStructuredSemantic(prose)), false);
}

// 首页刷新全程：结构化「已揽收」的订单这一轮开京粉页。京粉页打不开、给不出运单号时，这一单按 AGENTS §9
// 的既有冷却歇十分钟（orderProjectionRetry，按订单记），下一次列表刷新不再开页，十分钟后才再试一次。
{
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
  let pageLoads = 0;
  Object.assign(globalThis, {
    Notification: { schedule: async () => undefined },
    Widget: { reloadAll() {} },
    Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
    WebViewController: class {
      constructor() { pageLoads++; }
      // 京粉页打开失败，没有任何运单号。
      async loadURL() { return false; }
      async evaluateJavaScript() { return null; }
      dispose() {}
    },
  });
  const providerTime = (at: number) =>
    new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
  const record = {
    ...orderRecord("PICKED", "您的订单已出库"),
    details: [{ time: providerTime(NOW - 3600000), desc: "您的订单已出库" }],
    jumpList: [{ type: "h5", link: "https://u.jd.com/forward?synthetic=home-gate" }],
  };
  record.normalizedStatus = { ...record.normalizedStatus, eventAtMs: NOW - 1800000 };
  memory.clear();
  saveState({
    ...emptyState(),
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }],
    feedSlotRebuiltAtMs: NOW - 86400000,
  }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  setDiagnosticsEnabled(true);
  let lists = 0;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path !== "/api/express/accounts/sync") {
      return { ok: false, status: 503, text: async () => "Synthetic offline" };
    }
    lists++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: [record] } }) };
  }) as typeof fetch;
  const pull = () => refreshAllShipments("interface5", { accountOrderProjection: true, accountSourceFollowup: true });
  const skips = (result: string) => readDiagnostics().filter(entry =>
    entry.event === "order.projection.skipped" && entry.details.result === result).length;

  await pull();
  assert.equal(lists, 1);
  const owner = loadState().shipments[0]!;
  assert.equal(owner.identity.accountOrder, true);
  assert.equal(owner.identity.projectedWaybill || "", "");
  assert.equal(owner.sourceTimeline?.semantic, "ORDERED");
  assert.equal(pageLoads, 1, "a structured PICKED order opens the union page on the Home pull");
  assert.equal(skips("before_pickup"), 0);
  assert.ok(owner.identity.orderProjectionRetry?.failedAtMs, "the empty page rests the order");

  clock = NOW + 60_000;
  await pull();
  assert.equal(lists, 2);
  assert.equal(pageLoads, 1, "the next list pull inside the rest does not reopen the page");
  assert.equal(skips("cooldown"), 1);

  clock = NOW + ACCOUNT_ORDER_PROJECTION_RETRY_MS + 1_000;
  await pull();
  assert.equal(lists, 3);
  assert.equal(pageLoads, 2, "after the ten-minute rest the order is tried once more");
}

console.log("jingdong home projection gate tests passed");
