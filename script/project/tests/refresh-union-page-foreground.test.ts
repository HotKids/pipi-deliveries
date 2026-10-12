import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { memory, NOW } from "./state-storage-mock";

import type { Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { saveGatewayToken } from "../services/credentials";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import {
  registerProjectionViewportHost,
  setProjectionSceneActive,
} from "../services/projection-viewport";
import { saveOrderProjectionReferences } from "../services/routes";
import { applyAccountShipment } from "../services/shipment-policy";
import { emptyState, loadState, saveState } from "../services/storage";
import { projectStoredAccountOrders, refreshAllShipments, runShipmentRefreshForTesting } from "../services/sync";

// 用户 2026-09-25 同意：刷新流程只在 App 在前台（场景 active）时开京粉页；不在前台就跳过这一阶段、记一条跳过原因，
// 这一单留给前台那一遍存盘行投影。已经过了期限或租约的刷新流程一页都不开，照旧失败收尾。iPhone 07:52：一个挂了
// 57 分钟的 foreground_sync 在 App 不在屏幕上时开了京粉页（visibilityState=hidden），超时，结果又因租约失效作废。
// 小组件与 App Intent 照旧从不开页。

const PHONE = "13800002020";
const ORDER = "3622448007482020";
const OWNER_ID = `interface5:account:${ORDER}`;
const REFERENCE = "https://u.jd.com/forward?synthetic=foreground-only";
const WAYBILL = "JD0256747732020";

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

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const loadedUrls: string[] = [];
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    async loadURL(url: string) { loadedUrls.push(url); return true; }
    async evaluateJavaScript() {
      return { extractionSource: "probe", waybillCode: WAYBILL, companyName: "京东快递", traceList: [
        { time: providerTime(NOW - 3600000), desc: "快件已到达【深圳万丰站】" },
        { time: providerTime(NOW - 86400000), desc: "快件已揽收" },
      ] };
    }
    dispose() {}
  },
});

// The app root's slot. A held mount stands for the page waiting for its viewport.
let holdMount = false;
let mountWaiting = false;
let releaseMount = () => {};
registerProjectionViewportHost({
  mount: () => new Promise<boolean>((resolve) => {
    if (!holdMount) {
      resolve(true);
      return;
    }
    mountWaiting = true;
    releaseMount = () => {
      mountWaiting = false;
      resolve(true);
    };
  }),
  unmount: () => {},
});

// Raw 103: past pickup, so every refresh flow that may open the page opens it.
const record = {
  mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum: 103,
  details: [{ time: providerTime(NOW - 3600000), desc: "您的订单已出库" }],
  jumpList: [{ type: "h5", link: REFERENCE }],
};
const requests: string[] = [];
globalThis.fetch = (async (url: string) => {
  const path = new URL(url).pathname;
  requests.push(path);
  if (path !== "/api/express/accounts/sync") {
    return { ok: false, status: 503, text: async () => "Synthetic offline" };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: [record] } }) };
}) as typeof fetch;

function storedOrder(): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], NOW - 3600000)!, NOW - 3600000);
}

function seed() {
  clock = NOW;
  memory.clear();
  setDiagnosticsEnabled(true);
  saveState({
    ...emptyState(),
    shipments: [storedOrder()],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }],
    feedSlotRebuiltAtMs: NOW - 86400000,
  }, NOW);
  saveOrderProjectionReferences([{ ownerId: OWNER_ID, source: "interface5", url: REFERENCE }], NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  loadedUrls.length = 0;
  requests.length = 0;
  holdMount = false;
  setProjectionSceneActive(true);
}

async function until(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = realNow() + timeoutMs;
  while (!condition()) {
    if (realNow() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const owner = () => loadState().shipments.find((shipment) => shipment.identity.id === OWNER_ID)!;
const events = (event: string) => readDiagnostics().filter((entry) => entry.event === event);

// In the foreground the refresh flow opens the page as before.
{
  seed();
  await refreshAllShipments();
  assert.deepEqual(loadedUrls, [REFERENCE]);
  assert.equal(owner().identity.projectedWaybill, WAYBILL);
}

// Off screen the refresh flow skips the page: no load, no reservation, one skip line. Back on screen,
// the on-screen pass takes the order at once.
for (const phase of ["inactive", "background"] as const) {
  seed();
  setProjectionSceneActive(false);
  const summary = await refreshAllShipments();
  assert.equal(summary.skipReason, undefined, `${phase}: the refresh itself ran`);
  assert.equal(requests.filter((path) => path === "/api/express/accounts/sync").length, 1);
  assert.deepEqual(loadedUrls, [], `${phase}: the union page never loads off screen`);
  assert.equal(owner().identity.projectedWaybill || "", "");
  assert.equal(owner().identity.orderProjectionRetry, undefined, `${phase}: the order was not reserved`);
  assert.deepEqual(events("order.projection.started"), []);
  const skipped = events("order.projection.skipped").filter((entry) => entry.details.result === "not_foreground");
  assert.equal(skipped.length, 1, `${phase}: the skip is logged with its reason`);
  assert.equal(skipped[0]!.details.stage, "webview");
  setProjectionSceneActive(true);
  assert.equal((await projectStoredAccountOrders()).result, "attempted", `${phase}: the on-screen pass takes it`);
  assert.deepEqual(loadedUrls, [REFERENCE]);
  assert.equal(owner().identity.projectedWaybill, WAYBILL);
}

// The app leaves the foreground while the page waits for its viewport: the page still never loads,
// the reservation is given back, and the refresh flow finishes normally.
{
  seed();
  holdMount = true;
  const refresh = refreshAllShipments();
  await until(() => mountWaiting);
  assert.ok(owner().identity.orderProjectionRetry?.attemptId, "the order was reserved before the wait");
  setProjectionSceneActive(false);
  releaseMount();
  const summary = await refresh;
  assert.equal(summary.failed, 0);
  assert.deepEqual(loadedUrls, [], "no page load after the app left");
  assert.equal(owner().identity.orderProjectionRetry, undefined, "the reservation is given back");
  assert.equal(events("order.projection.skipped").filter((entry) => entry.details.result === "not_foreground").length, 1);
  assert.deepEqual(events("order.projection.failed"), []);
  assert.equal(events("refresh.succeeded").length, 1);
  setProjectionSceneActive(true);
  holdMount = false;
  assert.equal((await projectStoredAccountOrders()).result, "attempted", "no rest keeps the on-screen pass out");
  assert.equal(owner().identity.projectedWaybill, WAYBILL);
}

// A refresh flow suspended with the app past its lease loads nothing when it resumes; it ends as
// before, with the ownership invalidated at its deadline and the refresh failed.
{
  seed();
  holdMount = true;
  const refresh = refreshAllShipments();
  await until(() => mountWaiting);
  clock += 57 * 60_000;
  releaseMount();
  await assert.rejects(refresh);
  assert.deepEqual(loadedUrls, [], "a flow past its deadline starts no page load");
  const invalidated = events("refresh.ownership.invalidated");
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0]!.details.result, "deadline");
  assert.equal(invalidated[0]!.details.trigger, "foreground");
  assert.equal(events("refresh.failed").length, 1);
  assert.equal(owner().identity.projectedWaybill || "", "");
}

// 用户 2026-10-03「所有开京粉页的路都检查」（代码 4）：the stored-row pass checks the scene right before its page too
// (before 2026-10-03 only refresh flows were gated and this pass opened the page off screen): off screen the order is
// skipped, not reserved, and the next on-screen pass takes it. Background hosts still never open the page.
{
  seed();
  setProjectionSceneActive(false);
  assert.equal((await projectStoredAccountOrders()).result, "attempted");
  assert.deepEqual(loadedUrls, [], "the stored-row pass opens no page off screen");
  assert.equal(owner().identity.orderProjectionRetry, undefined, "the order was not reserved");
  const skipped = events("order.projection.skipped").filter((entry) => entry.details.result === "not_foreground");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.details.stage, "webview");
  setProjectionSceneActive(true);
  assert.equal((await projectStoredAccountOrders()).result, "attempted");
  assert.deepEqual(loadedUrls, [REFERENCE], "back on screen the pass takes the order");
  assert.equal(owner().identity.projectedWaybill, WAYBILL);

  // The app leaves the foreground while the stored-row pass waits for its viewport: no load, reservation given back.
  seed();
  holdMount = true;
  const pass = projectStoredAccountOrders();
  await until(() => mountWaiting);
  setProjectionSceneActive(false);
  releaseMount();
  await pass;
  assert.deepEqual(loadedUrls, []);
  assert.equal(owner().identity.orderProjectionRetry, undefined, "the reservation is given back");
  holdMount = false;

  seed();
  const background = await refreshAllShipments("interface5", {
    backgroundHostSafe: true, accountOrderProjection: true, budgetMs: 30_000,
  });
  assert.equal(background.skipReason, undefined);
  assert.deepEqual(loadedUrls, [], "a background host refresh never opens the union page");
  for (const entry of ["widget.tsx", "app_intents.tsx", "intent.tsx"]) {
    const source = readFileSync(new URL(`../${entry}`, import.meta.url), "utf8");
    assert.match(source, /backgroundHostSafe: true/, `${entry} refreshes as a background host`);
  }
}

// 代码 4: the detail refresh paths check the scene right before the union page too — detail entry's identity projection,
// the detail pull and the status alignment run share that stage. Off screen the stage is skipped (not reserved, no rest
// taken) and the flow goes on; the scene leaving during the viewport wait gives the reservation back.
{
  for (const trigger of ["detail_open", "detail_pull", "status_alignment"] as const) {
    seed();
    setProjectionSceneActive(false);
    await runShipmentRefreshForTesting(OWNER_ID, { isCurrent: () => true, deadlineAtMs: clock + 30_000 },
      { trigger, forceAccountOrderProjection: true, forceManualRefresh: trigger !== "detail_open",
        includeKdniaoFallback: trigger !== "detail_open" });
    assert.deepEqual(loadedUrls, [], `${trigger}: no union page off screen`);
    assert.equal(owner().identity.orderProjectionRetry, undefined, `${trigger}: not reserved, no rest taken`);
    const skipped = events("order.projection.skipped").filter((entry) => entry.details.result === "not_foreground");
    assert.equal(skipped.length, 1, `${trigger}: one skip line`);
    assert.equal(skipped[0]!.details.stage, "detail_webview");
    assert.deepEqual(events("order.projection.started"), []);
    setProjectionSceneActive(true);
    await runShipmentRefreshForTesting(OWNER_ID, { isCurrent: () => true, deadlineAtMs: clock + 30_000 },
      { trigger, forceAccountOrderProjection: true, forceManualRefresh: trigger !== "detail_open",
        includeKdniaoFallback: trigger !== "detail_open" });
    assert.deepEqual(loadedUrls, [REFERENCE], `${trigger}: on screen the page opens at once`);
    assert.equal(owner().identity.projectedWaybill, WAYBILL);
  }

  seed();
  holdMount = true;
  const pull = runShipmentRefreshForTesting(OWNER_ID, { isCurrent: () => true, deadlineAtMs: clock + 30_000 },
    { trigger: "detail_pull", forceAccountOrderProjection: true, forceManualRefresh: true, includeKdniaoFallback: true });
  await until(() => mountWaiting);
  assert.ok(owner().identity.orderProjectionRetry?.attemptId, "the order was reserved before the wait");
  setProjectionSceneActive(false);
  releaseMount();
  await pull;
  holdMount = false;
  assert.deepEqual(loadedUrls, [], "no page load after the app left");
  assert.equal(owner().identity.orderProjectionRetry, undefined, "the reservation is given back");
  assert.equal(events("order.projection.skipped").filter((entry) => entry.details.result === "not_foreground").length, 1);
  assert.deepEqual(events("order.projection.failed"), []);
  setProjectionSceneActive(true);
}

// The app root reports every scene change before the order projection controller sees it.
{
  const app = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
  assert.match(app,
    /"app\.scene\.changed"[\s\S]*?setProjectionSceneActive\(phase === "active"\);[\s\S]*?orderProjection\.scenePhaseChanged\(phase\)/);
}

console.log("refresh union page foreground-only tests passed");
