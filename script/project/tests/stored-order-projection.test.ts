import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { memory, NOW } from "./state-storage-mock";

import type { Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment, storedAccountListStructuredSemantic } from "../services/account-sync";
import { ACCOUNT_ORDER_PROJECTION_RETRY_MS } from "../services/account-sync-policy";
import { saveGatewayToken } from "../services/credentials";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import {
  acquireDurableRefreshLease,
  durableRefreshLeaseRemainingMs,
} from "../services/refresh-runtime-state";
import { saveOrderProjectionReferences } from "../services/routes";
import { sharedCommitSequence } from "../services/shared-file-transaction";
import { applyAccountShipment, jingDongOrderPastPickup } from "../services/shipment-policy";
import { emptyState, loadState, saveState } from "../services/storage";
import { mergeAccountParcel, projectStoredAccountOrders, refreshAllShipments } from "../services/sync";

// 用户 2026-09-24 采纳：App 在前台时用存盘的行自己抓京东订单的运单号（与 Lite 首页同口径），不请求账号列表。
// 存盘的未投影订单行上「已揽收」被压成了「已下单」，揽收门读列表那一行原始的接口 5 状态码。

const PHONE = "13800001616";
const ORDER = "3622448007483901";
const OTHER_ORDER = "3622448007483902";
const REFERENCE = "https://u.jd.com/forward?synthetic=stored-pass";
const WAYBILL = "JD0256747737301";

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
let loadedUrls: string[] = [];
let pageOpens = true;
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    constructor() { pageLoads++; }
    // A page that does not open gives no waybill; one that opens names the carrier waybill.
    async loadURL(url: string) { loadedUrls.push(url); return pageOpens; }
    async evaluateJavaScript() {
      return pageOpens
        ? { extractionSource: "probe", waybillCode: WAYBILL, companyName: "京东快递", traceList: [] }
        : null;
    }
    dispose() {}
  },
});
const requests: string[] = [];
globalThis.fetch = (async (url: string) => {
  requests.push(new URL(url).pathname);
  return { ok: false, status: 503, text: async () => "Synthetic offline" };
}) as typeof fetch;

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

function orderRecord(stateNum: number, detail: string, mailNo = ORDER) {
  return {
    mailNo, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum,
    details: [{ time: providerTime(NOW - 3600000), desc: detail }],
  };
}

function storedOrder(stateNum: number, detail: string, mailNo = ORDER): Shipment {
  const parcel = parseAccountSyncResponse("interface5", {
    code: 0, data: { expressList: [orderRecord(stateNum, detail, mailNo)] },
  })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], NOW - 3600000)!, NOW - 3600000);
}

function seed(rows: Shipment[], referenced = rows.map((row) => row.identity.id)) {
  clock = NOW;
  memory.clear();
  setDiagnosticsEnabled(true);
  saveState({
    ...emptyState(),
    shipments: rows,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }],
    feedSlotRebuiltAtMs: NOW - 86400000,
  }, NOW);
  saveOrderProjectionReferences(
    referenced.map((ownerId) => ({ ownerId, source: "interface5" as const, url: REFERENCE })), NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  pageLoads = 0;
  loadedUrls = [];
  pageOpens = true;
  requests.length = 0;
}

// Audit L8 (adopted 2026-09-25): the list sync stores the Worker's pre-clamp structured status on the row,
// and the stored-row gate reads it rather than re-mapping the raw state code (which lacks the Worker's rules).
{
  const record = { ...orderRecord(101, "您的订单已出库"),
    normalizedStatus: { version: 1, scope: "ORDER", semantic: "PICKED", code: "103", text: "已揽件",
      priority: 0, eventAtMs: NOW - 3600000, structured: true } };
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
  const merged = mergeAccountParcel({ ...emptyState() }, [], parcel, [PHONE], "interface5", NOW, new Map());
  const row = merged.find((item) => item.identity.sourceId === ORDER)!;
  assert.equal(row.accountRecord?.stateNumber, 101, "the raw list code says ORDERED");
  assert.equal(row.listStructuredSemantic, "PICKED");
  assert.equal(storedAccountListStructuredSemantic(row), "PICKED", "the Worker's status wins over the raw code");
  seed([row]);
  const reloaded = loadState(NOW).shipments.find((item) => item.identity.sourceId === ORDER)!;
  assert.equal(storedAccountListStructuredSemantic(reloaded), "PICKED", "kept across save and load");
  const legacy = { ...row };
  delete legacy.listStructuredSemantic;
  assert.equal(storedAccountListStructuredSemantic(legacy), "ORDERED", "older rows fall back to the raw code");
}

const projectionEvents = () => readDiagnostics().filter((entry) => entry.event.startsWith("order.projection."));
const viewportHost = { mount: async () => false, unmount: () => {} };
registerProjectionViewportHost(viewportHost);

// The named helper: the stored raw list state code is the structured list status.
{
  const row = storedOrder(103, "您的订单已出库");
  assert.equal(row.sourceTimeline?.semantic, "ORDERED", "the stored row shows the order stage");
  assert.equal(row.accountRecord?.stateNumber, 103);
  assert.equal(storedAccountListStructuredSemantic(row), "PICKED");
  assert.equal(jingDongOrderPastPickup(row), false, "the clamped row alone cannot show the pickup");
  assert.equal(jingDongOrderPastPickup(row, storedAccountListStructuredSemantic(row)), true);
  for (const [code, semantic] of [
    [101, "ORDERED"], [102, "SHIPPED"], [104, "TRANSIT"], [105, "DELIVERY"], [106, "WAITING_PICKUP"],
    [107, "COMPLETED"],
  ] as const) {
    const coded = { ...row, accountRecord: { ...row.accountRecord!, stateNumber: code } };
    assert.equal(storedAccountListStructuredSemantic(coded), semantic, String(code));
  }
  assert.equal(storedAccountListStructuredSemantic({ ...row, accountRecord: { ...row.accountRecord!, stateNumber: 0 } }), null);
  assert.equal(storedAccountListStructuredSemantic({ ...row, accountRecord: { ...row.accountRecord!, stateNumber: 999 } }), null);
  assert.equal(storedAccountListStructuredSemantic({ ...row, accountRecord: null }), null);
  assert.equal(storedAccountListStructuredSemantic({
    ...row, identity: { ...row.identity, bindingSource: "interface6" },
  }), null, "only interface 5 speaks this state table");
}

// A stored order past pickup (raw 103, shown as 已下单) is projected with its saved page
// reference and without any account-list request.
{
  const row = storedOrder(103, "您的订单已出库");
  seed([row]);
  const outcome = await projectStoredAccountOrders();
  assert.equal(outcome.result, "attempted");
  assert.equal(outcome.ownerId, row.identity.id);
  assert.equal(outcome.moreDue, false);
  assert.equal(requests.includes("/api/express/accounts/sync"), false, "the pass never asks for the account list");
  assert.deepEqual(loadedUrls, [REFERENCE], "the union page opens from the saved reference");
  const owner = loadState().shipments.find((shipment) => shipment.identity.id === row.identity.id)!;
  assert.equal(owner.identity.projectedWaybill, WAYBILL);
  assert.equal(outcome.state?.shipments.find((shipment) => shipment.identity.id === row.identity.id)
    ?.identity.projectedWaybill, WAYBILL, "the pass hands the committed state to the page");
  const committed = projectionEvents().find((entry) => entry.event === "order.projection.committed");
  assert.equal(committed?.details.result, "applied");
  assert.match(String(committed?.details.flowId), /^home-projection-/);
  assert.equal(durableRefreshLeaseRemainingMs("full:interface5"), 0, "the pass released full:<source>");
}

// Raw 101 / 102 without pickup text are before pickup: nothing is due, so the pass takes no lease,
// opens no page and writes no projection log line.
for (const [code, detail] of [[101, "您提交了订单，请等待系统确认"], [102, "您的订单已出库"]] as const) {
  seed([storedOrder(code, detail)]);
  const revision = loadState().revision;
  const logged = readDiagnostics().length;
  const journal = sharedCommitSequence();
  const outcome = await projectStoredAccountOrders();
  assert.equal(outcome.result, "nothing_due", String(code));
  assert.equal(pageLoads, 0, String(code));
  assert.deepEqual(readDiagnostics().slice(logged), [], `${code}: no log spam`);
  assert.equal(sharedCommitSequence(), journal, `${code}: no lease was taken and nothing was written`);
  assert.equal(loadState().revision, revision, `${code}: nothing was committed`);
}

// 用户 2026-09-25 同意：已完成、还没运单号的订单（raw 107）只在 App 在屏幕上时取号，真实运单号出来了
// 就不该再停在订单号上；没传 onScreen（onScreen 为假）时照旧不开页。
{
  const row = storedOrder(107, "您的订单已完成，感谢您对京东的支持，欢迎再次光临");
  assert.equal(jingDongOrderPastPickup(row, storedAccountListStructuredSemantic(row)), false);
  assert.equal(jingDongOrderPastPickup(row, storedAccountListStructuredSemantic(row), true), true);
  seed([row]);
  assert.equal((await projectStoredAccountOrders()).result, "nothing_due");
  assert.equal((await projectStoredAccountOrders({ onScreen: () => false })).result, "nothing_due");
  assert.equal(pageLoads, 0, "off screen the completed order waits");
  const outcome = await projectStoredAccountOrders({ onScreen: () => true });
  assert.equal(outcome.result, "attempted");
  assert.deepEqual(loadedUrls, [REFERENCE]);
  assert.equal(loadState().shipments.find((shipment) => shipment.identity.id === row.identity.id)!
    .identity.projectedWaybill, WAYBILL);
}

// No saved reference and no waybill in the feed text: the stored row cannot reach the page.
{
  const row = storedOrder(103, "您的订单已出库");
  seed([row], []);
  assert.equal((await projectStoredAccountOrders()).result, "nothing_due");
  assert.equal(pageLoads, 0);
}

// The per-order cooldown (AGENTS §9) holds across passes: an empty page rests the order ten
// minutes; the next pass inside the rest does nothing, the one after it opens the page again.
{
  const row = storedOrder(104, "您的订单已到达【深圳万丰站】");
  seed([row]);
  pageOpens = false;
  assert.equal((await projectStoredAccountOrders()).result, "attempted");
  assert.equal(pageLoads, 1);
  assert.ok(loadState().shipments[0]!.identity.orderProjectionRetry?.failedAtMs, "the empty page rests the order");
  clock = NOW + 60_000;
  assert.equal((await projectStoredAccountOrders()).result, "nothing_due");
  assert.equal(pageLoads, 1, "inside the rest the page stays closed");
  clock = NOW + ACCOUNT_ORDER_PROJECTION_RETRY_MS + 1_000;
  pageOpens = true;
  assert.equal((await projectStoredAccountOrders()).result, "attempted");
  assert.equal(pageLoads, 2, "after the rest the order is tried once more");
  assert.equal(loadState().shipments[0]!.identity.projectedWaybill, WAYBILL);
}

// One order per pass; `moreDue` says another is waiting, and the caller's exclusion list is honoured.
{
  const first = storedOrder(103, "您的订单已出库");
  const second = storedOrder(105, "您的订单正在派送中", OTHER_ORDER);
  seed([first, second]);
  pageOpens = false;
  const one = await projectStoredAccountOrders();
  assert.equal(one.result, "attempted");
  assert.equal(one.moreDue, true);
  assert.equal(pageLoads, 1);
  const waiting = [first, second].find((row) => row.identity.id !== one.ownerId)!;
  assert.equal(
    (await projectStoredAccountOrders({ excludeOwnerIds: new Set([waiting.identity.id]) })).result,
    "nothing_due",
    "an excluded order is not opened even though it is due",
  );
  assert.equal(pageLoads, 1);
  const two = await projectStoredAccountOrders({ excludeOwnerIds: new Set([one.ownerId!]) });
  assert.equal(two.result, "attempted");
  assert.notEqual(two.ownerId, one.ownerId);
  assert.equal(two.moreDue, false);
  assert.equal(pageLoads, 2);
}

// Another runtime holding full:<source> makes the pass skip, or wait for it when asked.
{
  seed([storedOrder(103, "您的订单已出库")]);
  const widget = acquireDurableRefreshLease("full:interface5", 30_000, clock,
    { flowId: "synthetic-widget", trigger: "background" })!;
  assert.ok(widget);
  assert.equal((await projectStoredAccountOrders()).result, "lease_held");
  assert.equal(pageLoads, 0);
  setTimeout(() => widget.release(), 30);
  const waited = await projectStoredAccountOrders({ waitForOtherRuntime: true });
  assert.equal(waited.result, "attempted", "the pass runs once the holder releases");
  assert.equal(pageLoads, 1);
  const again = acquireDurableRefreshLease("full:interface5", 30_000, clock,
    { flowId: "synthetic-widget-2", trigger: "background" })!;
  let active = true;
  setTimeout(() => { active = false; }, 30);
  const left = await projectStoredAccountOrders({ waitForOtherRuntime: true, isActive: () => active });
  assert.equal(left.result, "inactive", "leaving the foreground ends the wait quietly");
  again.release();
}

// Widget and background hosts never open the page: without the app root's projection viewport
// the pass refuses to run, and a background refresh still only backfills feed text.
{
  seed([storedOrder(103, "您的订单已出库")]);
  registerProjectionViewportHost(null);
  assert.equal((await projectStoredAccountOrders()).result, "not_app_host");
  assert.equal(pageLoads, 0);
  const record = { ...orderRecord(103, "您的订单已出库"),
    jumpList: [{ type: "h5", link: REFERENCE }] };
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path !== "/api/express/accounts/sync") {
      return { ok: false, status: 503, text: async () => "Synthetic offline" };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: [record] } }) };
  }) as typeof fetch;
  const background = await refreshAllShipments("interface5", {
    backgroundHostSafe: true, accountOrderProjection: true, budgetMs: 30_000,
  });
  assert.equal(background.skipReason, undefined);
  assert.equal(requests.filter((path) => path === "/api/express/accounts/sync").length, 1);
  assert.equal(pageLoads, 0, "a background host refresh never opens the union page");
  registerProjectionViewportHost(viewportHost);
}

// Source contract: no background entry point reaches the stored-row pass or its controller.
for (const entry of ["widget.tsx", "app_intents.tsx", "intent.tsx"]) {
  const source = readFileSync(new URL(`../${entry}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /projectStoredAccountOrders|foreground-order-projection/, entry);
}

console.log("stored-row order projection pass tests passed");
