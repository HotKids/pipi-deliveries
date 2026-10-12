import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";

import type { Shipment } from "../models";
import type { AccountOrderProjectionDiagnostics } from "../services/account-order-projection";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import {
  ACCOUNT_ORDER_PROJECTION_RETRY_MS,
  ACCOUNT_ORDER_PROJECTION_RISK_CONTROL_MS,
  accountOrderPageConfirmedEmpty,
  nextEmptyShellStrikes,
  shouldRetryAccountOrderProjection,
  shouldRetryAccountOrderProjectionUnprompted,
  unionPageOutcome,
} from "../services/account-sync-policy";
import { saveGatewayToken } from "../services/credentials";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { saveOrderProjectionReferences } from "../services/routes";
import { applyAccountShipment } from "../services/shipment-policy";
import { emptyState, loadState, saveState } from "../services/storage";
import { projectStoredAccountOrders, runShipmentRefreshForTesting } from "../services/sync";

// 用户 2026-09-25 同意（方案 A，与 Lite 同一语义）：已完成订单的京粉页一旦确认是空壳，就记住这一单，首页那一遍（含
// 同一条自动路径的列表刷新）与详情页取号都不再开；用户自己在详情页下拉照样开页（冷却照旧），抓到东西就清掉标记。
// 空壳：页面完整加载、在屏幕上（有宿主、非零尺寸、visible）、没有风控，且什么物流内容都没抓到——没有 probe 抓取、
// 没有 DOM／弹层包、没有轨迹、没有运单号；京东的 union 接口有没有回、回了 200 都不影响（Lite 上同一类页面根本没有
// union 响应）。一次空页不算数（Lite 上 …5251 空页 13 分钟后就取到了），要同一张已完成订单两次空壳、相隔至少一个
// 冷却（10 分钟）；任何抓到的东西都清零；风控既不计数也不清零；没完成的订单从不标记。

// iPhone 2026-09-25 07:58:22 …4421（无商品的赠品单）：页面加载完、在屏幕上，union 接口回 200，但什么都没抓到。
const EMPTY_PAGE = {
  loadSettled: true, loadCompleted: true, captureSeen: false, replayAttempted: true, replaySucceeded: false,
  probeInstalled: true, probeMatched: false, probeRequestCount: 31, unionSignalSeen: true,
  unionResourceSeen: true, resourceReplayBlockReason: "", domMatched: false, projectionComplete: false,
  projectionTrackCount: 0, requestCallbackCount: 5, evaluationAttempts: 4, evaluationFailures: 0,
  loadDurationMs: 20_000, resourceCount: 47, pageClass: "jd", readyState: "complete",
  visibilityState: "visible", viewportAvailable: true, viewportHosted: true, identitySource: "webview",
  unionResponseStatuses: "200", riskControlSeen: false, probeCaptureCount: 0,
} satisfies AccountOrderProjectionDiagnostics;
/** The Lite shape: the same loaded, visible page with no union response at all. */
const SILENT_PAGE = {
  ...EMPTY_PAGE, unionResponseStatuses: "", unionSignalSeen: false, unionResourceSeen: false, probeRequestCount: 0,
} satisfies AccountOrderProjectionDiagnostics;
const DAY = 86400000;

// ---------------------------------------------------------------------------------------------
// What one page result says.
// ---------------------------------------------------------------------------------------------
{
  assert.equal(unionPageOutcome(EMPTY_PAGE), "empty_shell", "the device evidence is an empty shell");
  assert.equal(unionPageOutcome(SILENT_PAGE), "empty_shell", "a page with no union answer at all counts too");
  assert.equal(unionPageOutcome({ ...SILENT_PAGE, unionPendingCount: 0 }), "empty_shell",
    "a page that never sent a union request is still an empty shell");
  for (const [label, changed] of [
    ["several union answers", { unionResponseStatuses: "200,204" }],
    // A logistics-looking navigation request carries no logistics by itself.
    ["logistics-looking request without a package", { captureSeen: true }],
  ] as const) {
    assert.equal(unionPageOutcome({ ...EMPTY_PAGE, ...changed }), "empty_shell", label);
  }
  for (const [label, changed] of [
    // A failed union answer is a JD outage, not an empty order: like risk control it proves nothing.
    ["failed union answer", { unionResponseStatuses: "500" }],
    ["union request failed on the network", { unionResponseStatuses: "0" }],
    ["one failed answer among successes", { unionResponseStatuses: "200,502" }],
    ["hidden page", { visibilityState: "hidden" }],
    ["no hosted viewport", { viewportHosted: false }],
    ["zero-sized viewport", { viewportAvailable: false }],
    ["incomplete load", { loadCompleted: false }],
    ["risk control status", { unionResponseStatuses: "200,403" }],
    ["risk control page", { riskControlSeen: true }],
    ["risk control page without a union answer", { ...SILENT_PAGE, riskControlSeen: true }],
    // User decision 2026-09-26 (其余裁决 4): a union request sent but still unanswered at the timeout
    // is as neutral as a failed answer; a page that never sent one (SILENT_PAGE) stays an empty shell.
    ["union request sent, no answer by the timeout", { unionPendingCount: 1 }],
    ["one unanswered request next to an answered one", { unionResponseStatuses: "200", unionPendingCount: 1 }],
  ] as const) {
    assert.equal(unionPageOutcome({ ...EMPTY_PAGE, ...changed }), "uninformative", label);
  }
  for (const [label, changed] of [
    ["probe capture", { probeCaptureCount: 1 }],
    ["probe or modal package", { probeMatched: true }],
    ["DOM or script package", { domMatched: true }],
    ["replayed package", { replaySucceeded: true }],
    ["timed track", { projectionTrackCount: 1 }],
  ] as const) {
    assert.equal(unionPageOutcome({ ...EMPTY_PAGE, ...changed }), "logistics", label);
    assert.equal(unionPageOutcome({ ...SILENT_PAGE, ...changed }), "logistics", `${label} (no union answer)`);
  }
  assert.equal(unionPageOutcome(EMPTY_PAGE, true), "logistics", "a returned waybill is logistics");
  assert.equal(unionPageOutcome(null), "uninformative");
}

// The strike arithmetic per order hash, and which paths the mark closes.
{
  const hash = "a".repeat(64);
  const record = (fields: object) => ({ routeHash: hash, failedAtMs: NOW, ...fields });
  const rest = ACCOUNT_ORDER_PROJECTION_RETRY_MS;
  assert.deepEqual(nextEmptyShellStrikes(undefined, hash, "empty_shell", true, NOW), { emptyShellAtMs: NOW });
  assert.deepEqual(nextEmptyShellStrikes(undefined, hash, "empty_shell", false, NOW), {},
    "an order that is not completed collects nothing");
  assert.deepEqual(nextEmptyShellStrikes(record({ emptyShellAtMs: NOW }), hash, "empty_shell", true, NOW + rest - 1),
    { emptyShellAtMs: NOW + rest - 1 }, "inside one rest the second empty page only moves the strike");
  assert.deepEqual(nextEmptyShellStrikes(record({ emptyShellAtMs: NOW }), hash, "empty_shell", true, NOW + rest),
    { emptyShellAtMs: NOW, emptyShellConfirmedAtMs: NOW + rest });
  assert.deepEqual(nextEmptyShellStrikes(record({ emptyShellAtMs: NOW }), hash, "uninformative", true, NOW + rest),
    { emptyShellAtMs: NOW }, "an uninformative result keeps the strike");
  assert.deepEqual(nextEmptyShellStrikes(record({ emptyShellAtMs: NOW }), hash, "logistics", true, NOW + rest), {});
  assert.deepEqual(nextEmptyShellStrikes(record({ emptyShellAtMs: NOW }), "b".repeat(64), "empty_shell", true, NOW + rest),
    { emptyShellAtMs: NOW + rest }, "another order hash (a new capture strategy) starts over");
  const confirmed = record({ emptyShellAtMs: NOW, emptyShellConfirmedAtMs: NOW + rest });
  assert.equal(accountOrderPageConfirmedEmpty(confirmed, hash), true);
  assert.equal(accountOrderPageConfirmedEmpty(confirmed, "b".repeat(64)), false);
  assert.deepEqual(nextEmptyShellStrikes(confirmed, hash, "logistics", true, NOW + DAY), {},
    "a capture clears the mark");
  assert.equal(shouldRetryAccountOrderProjectionUnprompted(confirmed, hash, NOW + 365 * DAY), false,
    "the Home pass, the list refresh and detail entry never reopen a confirmed empty page");
  assert.equal(shouldRetryAccountOrderProjection(confirmed, hash, NOW + 365 * DAY), true,
    "an explicit pull keeps only the ordinary rest");
  assert.equal(shouldRetryAccountOrderProjection(confirmed, hash, NOW + rest - 1), false,
    "the ordinary rest still holds for a pull");
  assert.equal(shouldRetryAccountOrderProjectionUnprompted(confirmed, "b".repeat(64), NOW + rest * 2), true);
  assert.equal(shouldRetryAccountOrderProjectionUnprompted(record({ emptyShellAtMs: NOW }), hash, NOW + rest), true,
    "one strike keeps the ordinary ten-minute rest");
}

// ---------------------------------------------------------------------------------------------
// The Home pass and detail refreshes with a hosted page.
// ---------------------------------------------------------------------------------------------

const PHONE = "13800001919";
const ORDER = "3622448007484421";
const OWNER_ID = `interface5:account:${ORDER}`;
const REFERENCE = "https://u.jd.com/forward?synthetic=empty-page";
const WAYBILL = "JD0256747737321";

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
let pageMode: "empty" | "silent" | "risk" | "outage" | "offline" | "waybill" = "empty";
let pageLoads = 0;
const SNAPSHOT = {
  extractionSource: "diagnostic", probeInstalled: true, probeRequestCount: 31, unionSignalSeen: true,
  unionResourceSeen: true, resourceReplayAttempted: true, resourceReplaySucceeded: false,
  resourceReplayBlockReason: "", resourceCount: 47, pageClass: "jd", riskControlSeen: false,
  readyState: "complete", visibilityState: "visible", viewportAvailable: true,
  unionResponseStatuses: "200", probeCaptureCount: 0,
};
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    constructor() { pageLoads++; }
    async loadURL() { return true; }
    async evaluateJavaScript() {
      if (pageMode === "waybill") {
        return { ...SNAPSHOT, extractionSource: "probe", waybillCode: WAYBILL, companyName: "京东快递", traceList: [
          { time: providerTime(NOW - 3600000), desc: "您的快件已签收" },
          { time: providerTime(NOW - DAY), desc: "快件已揽收" },
        ] };
      }
      // Nothing ever arrives: each look takes ten seconds and the hosted capture waits out its
      // whole twenty (the look that crosses the deadline is discarded, as on the device).
      clock += 10_000;
      if (pageMode === "risk") return { ...SNAPSHOT, unionResponseStatuses: "403" };
      if (pageMode === "outage") return { ...SNAPSHOT, unionResponseStatuses: "200,502" };
      if (pageMode === "offline") return { ...SNAPSHOT, unionResponseStatuses: "0" };
      if (pageMode === "silent") {
        return { ...SNAPSHOT, unionResponseStatuses: "", unionSignalSeen: false, unionResourceSeen: false,
          probeRequestCount: 0 };
      }
      return SNAPSHOT;
    }
    dispose() {}
  },
});
globalThis.fetch = (async () => ({ ok: false, status: 503, text: async () => "Synthetic offline" })) as typeof fetch;
registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });

function storedOrder(stateNum: number, detail: string): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum,
    details: [{ time: providerTime(NOW - 7200000), desc: detail }],
  }] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], NOW - 7200000)!, NOW - 7200000);
}
const completedOrder = () => storedOrder(107, `您的订单${ORDER}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。`);
const transitOrder = () => storedOrder(104, "您的订单已到达【深圳万丰站】");

function seed(row: Shipment) {
  clock = NOW;
  memory.clear();
  setDiagnosticsEnabled(true);
  saveState({
    ...emptyState(),
    shipments: [row],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - DAY }],
    feedSlotRebuiltAtMs: NOW - DAY,
  }, NOW);
  saveOrderProjectionReferences([{ ownerId: OWNER_ID, source: "interface5", url: REFERENCE }], NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  pageLoads = 0;
  pageMode = "empty";
}

const owner = () => loadState().shipments.find((shipment) => shipment.identity.id === OWNER_ID)!;
const retry = () => owner().identity.orderProjectionRetry;
const pass = () => projectStoredAccountOrders({ onScreen: () => true });
/** The next due moment after the page load that ended at `endedAt`. */
const afterRest = (endedAt: number) => endedAt + ACCOUNT_ORDER_PROJECTION_RETRY_MS + 1_000;
/** Two Home passes one rest apart, both on an empty-shell page: the order is then marked. */
async function markEmpty(): Promise<void> {
  await pass();
  clock = afterRest(retry()!.failedAtMs!);
  await pass();
  assert.ok(retry()?.emptyShellConfirmedAtMs, "two empty pages one rest apart confirm it");
}
const skipResult = (logged: number) => readDiagnostics().slice(0, readDiagnostics().length - logged)
  .find((entry) => entry.event === "order.projection.skipped")?.details;
const detail = (trigger: "identity_projection" | "detail_pull", capture: () => Promise<void> | void) =>
  runShipmentRefreshForTesting(OWNER_ID, { isCurrent: () => true }, {
    trigger,
    forceAccountOrderProjection: true,
    ...(trigger === "detail_pull" ? { forceManualRefresh: true, includeKdniaoFallback: true } : {}),
  }, {
    projectAccountOrderWithCarrier: async (input, _deadline, _recognition, observe) => {
      await capture();
      // The pull's page captured a logistics package that named no waybill of its own.
      observe?.({ ...EMPTY_PAGE, probeCaptureCount: 1 });
      return input;
    },
  });

// One empty page is not proof: the order rests ten minutes and is tried again. The second empty
// page, more than one rest later, confirms it; from then on neither the Home pass nor detail entry
// opens the page, however long the row stays.
{
  seed(completedOrder());
  assert.equal((await pass()).result, "attempted");
  assert.equal(pageLoads, 1);
  const failed = readDiagnostics().find((entry) => entry.event === "order.projection.failed");
  assert.equal(failed?.details.errorCategory, "timeout", "the device's empty page ended in a timeout");
  const first = retry();
  assert.ok(first?.emptyShellAtMs, "the first empty page is a strike");
  assert.equal(first?.emptyShellConfirmedAtMs, undefined);
  clock = NOW + 60_000;
  assert.equal((await pass()).result, "nothing_due", "inside the rest nothing opens");
  clock = afterRest(first!.failedAtMs!);
  assert.equal((await pass()).result, "attempted", "one empty page leaves the order to be retried");
  assert.equal(pageLoads, 2);
  assert.ok(retry()?.emptyShellConfirmedAtMs, "the second empty page a rest later confirms it");

  clock = NOW + DAY;
  assert.equal((await pass()).result, "nothing_due");
  assert.equal(pageLoads, 2, "the Home pass never reopens a confirmed empty page");
  const logged = readDiagnostics().length;
  await detail("identity_projection", () => assert.fail("detail entry must not reopen a confirmed empty page"));
  assert.equal(skipResult(logged)?.result, "confirmed_empty");
  assert.equal(skipResult(logged)?.stage, "detail_webview");
  assert.equal(owner().identity.projectedWaybill || "", "", "the row stays as it was");
  assert.equal(pageLoads, 2);
}

// Lite's shape counts the same: a loaded, visible page with no union answer at all.
{
  seed(completedOrder());
  pageMode = "silent";
  await markEmpty();
  assert.equal(pageLoads, 2);
  clock += DAY;
  assert.equal((await pass()).result, "nothing_due");
  assert.equal(pageLoads, 2);
}

// An explicit detail pull is the user's own request: on a marked order it still opens the page,
// after the ordinary rest, and what it captures clears the mark, so the Home pass may try again.
{
  seed(completedOrder());
  await markEmpty();
  let opened = 0;
  clock += 60_000;
  let logged = readDiagnostics().length;
  await detail("detail_pull", () => { opened++; });
  assert.equal(opened, 0, "inside the ordinary rest a pull is refused like any other load");
  assert.equal(skipResult(logged)?.result, "cooldown");
  assert.ok(retry()?.emptyShellConfirmedAtMs);

  clock = afterRest(retry()!.failedAtMs!);
  logged = readDiagnostics().length;
  await detail("detail_pull", () => { opened++; });
  assert.equal(opened, 1, "the pull opens the page of a marked order");
  assert.equal(readDiagnostics().slice(0, readDiagnostics().length - logged)
    .filter((entry) => entry.event === "order.projection.started").length, 1);
  assert.equal(retry()?.emptyShellConfirmedAtMs, undefined, "the capture cleared the mark");
  assert.equal(retry()?.emptyShellAtMs, undefined);
  assert.equal(owner().identity.projectedWaybill || "", "");
  clock = afterRest(retry()!.failedAtMs!);
  assert.equal((await pass()).result, "attempted", "the Home pass opens the page again");
}

// Empty, then a page that names the waybill: the order is projected and carries no mark.
{
  seed(completedOrder());
  await pass();
  assert.ok(retry()?.emptyShellAtMs);
  clock = afterRest(retry()!.failedAtMs!);
  pageMode = "waybill";
  assert.equal((await pass()).result, "attempted");
  assert.equal(owner().identity.projectedWaybill, WAYBILL);
  assert.equal(owner().identity.orderProjectionRetry, undefined, "no strike and no mark survive a capture");
}

// Any capture resets the count, even one that leaves no waybill: empty, captured, empty is one strike.
{
  seed(completedOrder());
  await pass();
  clock = afterRest(retry()!.failedAtMs!);
  await detail("identity_projection", () => {});
  assert.equal(retry()?.emptyShellAtMs, undefined, "the capture cleared the strike");
  clock = afterRest(retry()!.failedAtMs!);
  assert.equal((await pass()).result, "attempted");
  assert.ok(retry()?.emptyShellAtMs);
  assert.equal(retry()?.emptyShellConfirmedAtMs, undefined, "a new first strike, not a confirmation");
  clock = afterRest(retry()!.failedAtMs!);
  assert.equal((await pass()).result, "attempted", "still retried");
}

// An order that is not completed is never marked, however often its page is empty.
{
  seed(transitOrder());
  await pass();
  clock = afterRest(retry()!.failedAtMs!);
  await pass();
  assert.equal(pageLoads, 2);
  assert.equal(retry()?.emptyShellAtMs, undefined);
  assert.equal(retry()?.emptyShellConfirmedAtMs, undefined);
  clock = afterRest(retry()!.failedAtMs!);
  assert.equal((await pass()).result, "attempted", "it keeps its ordinary retries");
  assert.equal(pageLoads, 3);
}

// Risk control neither counts nor resets: empty, then risk-controlled, keeps the first strike without
// confirming; the order rests its hour, and the next empty page confirms against that first strike.
// Two risk-controlled pages mark nothing.
{
  seed(completedOrder());
  await pass();
  const firstStrike = retry()!.emptyShellAtMs;
  assert.ok(firstStrike);
  clock = afterRest(retry()!.failedAtMs!);
  pageMode = "risk";
  await pass();
  assert.equal(pageLoads, 2);
  assert.ok(retry()?.riskControlAtMs);
  assert.equal(retry()?.emptyShellAtMs, firstStrike, "the risk-controlled page did not reset the strike");
  assert.equal(retry()?.emptyShellConfirmedAtMs, undefined, "and did not count as a second one");
  clock = retry()!.riskControlAtMs! + ACCOUNT_ORDER_PROJECTION_RISK_CONTROL_MS - 1_000;
  assert.equal((await pass()).result, "nothing_due", "the risk-control hour still holds");
  clock = retry()!.riskControlAtMs! + ACCOUNT_ORDER_PROJECTION_RISK_CONTROL_MS + 1_000;
  pageMode = "empty";
  assert.equal((await pass()).result, "attempted", "the order is opened again after the hour");
  assert.equal(pageLoads, 3);
  assert.ok(retry()?.emptyShellConfirmedAtMs, "the kept first strike and this empty page confirm it");

  seed(completedOrder());
  pageMode = "risk";
  await pass();
  clock = retry()!.riskControlAtMs! + ACCOUNT_ORDER_PROJECTION_RISK_CONTROL_MS + 1_000;
  await pass();
  assert.equal(pageLoads, 2);
  assert.equal(retry()?.emptyShellAtMs, undefined);
  assert.equal(retry()?.emptyShellConfirmedAtMs, undefined);
}

// A failed union answer is a JD outage, not an empty order: like risk control it neither counts nor
// resets. Empty, then an outage a rest later, keeps the first strike unconfirmed; the next empty
// page confirms against it. Two outages (an error status, then a network failure) mark nothing.
{
  seed(completedOrder());
  await pass();
  const firstStrike = retry()!.emptyShellAtMs;
  assert.ok(firstStrike);
  clock = afterRest(retry()!.failedAtMs!);
  pageMode = "outage";
  assert.equal((await pass()).result, "attempted");
  assert.equal(pageLoads, 2);
  assert.equal(retry()?.emptyShellAtMs, firstStrike, "the outage did not reset the strike");
  assert.equal(retry()?.emptyShellConfirmedAtMs, undefined, "and did not count as a second one");
  clock = afterRest(retry()!.failedAtMs!);
  pageMode = "empty";
  assert.equal((await pass()).result, "attempted");
  assert.equal(pageLoads, 3);
  assert.ok(retry()?.emptyShellConfirmedAtMs, "the kept first strike and this empty page confirm it");

  seed(completedOrder());
  pageMode = "outage";
  await pass();
  clock = afterRest(retry()!.failedAtMs!);
  pageMode = "offline";
  await pass();
  assert.equal(pageLoads, 2);
  assert.equal(retry()?.emptyShellAtMs, undefined, "two JD outages ten minutes apart mark nothing");
  assert.equal(retry()?.emptyShellConfirmedAtMs, undefined);
  clock += DAY;
  pageMode = "empty";
  assert.equal((await pass()).result, "attempted", "the order keeps its ordinary retries");
}

console.log("empty union page mark tests passed");
