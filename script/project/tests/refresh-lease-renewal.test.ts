import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";

import type { Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { saveGatewayToken } from "../services/credentials";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import * as leases from "../services/refresh-runtime-state";
import { saveOrderProjectionReferences } from "../services/routes";
import { publishSharedData, sharedData, withSharedFileTransaction } from "../services/shared-file-transaction";
import { applyAccountShipment } from "../services/shipment-policy";
import { emptyState, loadState, peekStateRevision, saveState } from "../services/storage";

// 用户 2026-09-28「30 秒有效 + 每 10 秒续约」。iPhone 03:05:20：beta1 的首页投影开京粉页时拿了 full:<source>（固定 125 秒）；
// 03:05:34 导入新包把那个运行时换掉，租约留在共享存储里没人持有；03:05:40 用户下拉等了 104 秒，小组件整段都被挡。
// 租约改为 30 秒有效、持有者每 10 秒续一次：死掉、被换掉、被挂起的持有者不再续，它的租约 30 秒内失效；
// 活着的持有者照旧挡住别人，等待方愿意等的上限不变（持有者的最长操作时长）。丢了租约的持有者不落库。

type SyncRuntime = typeof import("../services/sync");
/** Every Scripting runtime (app, widget, a replaced app) loads its own copy of sync.ts over the shared files. */
const runtime = (name: string) => import(`../services/sync.ts?runtime=${name}`) as Promise<SyncRuntime>;
const renewals = () => (leases as { activeDurableLeaseRenewalsForTesting?: () => number })
  .activeDurableLeaseRenewalsForTesting?.() ?? 0;

let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;

// Fake timers: time passes only when a scenario lets it, and a runtime that dies loses its timers.
type FakeTimer = { id: number; at: number; run: () => void };
const timers = new Map<number, FakeTimer>();
let nextTimerId = 1;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const id = nextTimerId++;
  timers.set(id, { id, at: clock + Math.max(0, Number(ms) || 0), run: () => callback(...args) });
  return id;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((id?: unknown) => {
  if (id != null) timers.delete(Number(id));
}) as unknown as typeof clearTimeout;
process.on("exit", () => {
  Date.now = realNow;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function drain(): Promise<void> {
  for (let index = 0; index < 5; index++) await turn();
}
const nextTimer = () => [...timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
async function fire(timer: FakeTimer): Promise<void> {
  timers.delete(timer.id);
  clock = Math.max(clock, timer.at);
  timer.run();
  await drain();
}
/** Runs every timer due by `target` in time order, then leaves the clock at `target`. */
async function advanceTo(target: number): Promise<void> {
  await drain();
  for (let timer = nextTimer(); timer && timer.at <= target; timer = nextTimer()) await fire(timer);
  clock = Math.max(clock, target);
  await drain();
}
/** Lets time pass until `work` settles; `limit` only stops a scenario that would never settle. */
async function settle<T>(work: Promise<T>, limit: number): Promise<PromiseSettledResult<T>> {
  let outcome: PromiseSettledResult<T> | undefined;
  work.then(
    (value) => { outcome = { status: "fulfilled", value }; },
    (reason) => { outcome = { status: "rejected", reason }; },
  );
  await drain();
  while (!outcome) {
    const timer = nextTimer();
    assert.ok(timer && timer.at <= limit, `work did not settle by +${limit - NOW} ms`);
    await fire(timer);
  }
  return outcome;
}
async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !condition(); index++) await turn();
  assert.ok(condition(), "condition not reached");
}
/** A runtime replaced or closed by the system: none of its timers fires again. */
const killRuntime = () => timers.clear();

Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });

const PHONE = "13800002828";
const ORDER = "3622448007482828";
const REFERENCE = "https://u.jd.com/forward?synthetic=lease-renewal";
const WAYBILL = "JD0256747732828";
const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

// The union page: `load` and `evaluate` are set per scenario.
const page = {
  load: (_url: string): Promise<boolean> => Promise.resolve(true),
  evaluate: (): Promise<unknown> => Promise.resolve(null),
};
const probe = () => ({ extractionSource: "probe", waybillCode: WAYBILL, companyName: "京东快递", traceList: [] });
let schedule: () => Promise<unknown> = async () => undefined;
Object.assign(globalThis, {
  Notification: { schedule: () => schedule() },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    async loadURL(url: string) { return page.load(url); }
    async evaluateJavaScript() { return page.evaluate(); }
    dispose() {}
  },
});
// The app root's viewport slot; a held mount stands for the app suspended before the page loads.
let holdMount = false;
let mountWaiting = false;
let releaseMount = () => {};
registerProjectionViewportHost({
  mount: () => new Promise<boolean>((resolve) => {
    if (!holdMount) {
      resolve(false);
      return;
    }
    mountWaiting = true;
    releaseMount = () => {
      mountWaiting = false;
      resolve(false);
    };
  }),
  unmount: () => {},
});

let listRecords: { mailNo: string; details: { time: string; desc: string }[] }[] = [];
let listGate: Promise<void> | null = null;
/** Runs once when the next list request has been answered upstream, before the client sees it. */
let onListAnswered: (() => void) | null = null;
let detailGate: Promise<void> | null = null;
let listRequests = 0;
const json = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const path = new URL(url).pathname;
  if (path === "/api/express/accounts/sync") {
    listRequests++;
    const gate = listGate;
    listGate = null;
    if (gate) await gate;
    const answered = onListAnswered;
    onListAnswered = null;
    answered?.();
    return json({ code: 0, data: { expressList: listRecords } });
  }
  const request = path === "/api/express/timeline/source" ? JSON.parse(String(init?.body)) : null;
  if (request?.interface === "v5" && request.mode === "detail") {
    const gate = detailGate;
    detailGate = null;
    if (gate) await gate;
    const record = listRecords.find((value) => value.mailNo === request.record.waybill)!;
    return json({ code: 0, data: { ...record, details: [
      { time: record.details[0]!.time, desc: "query 实际物流事件" },
      { time: providerTime(NOW - 86400000), desc: "已揽收" },
    ] } });
  }
  return { ok: false, status: 503, text: async () => "Synthetic offline" };
}) as typeof fetch;
/** Opens at `at` on the fake clock. */
const gateAt = (at: number) => new Promise<void>((resolve) => { setTimeout(resolve, at - clock); });

function orderRecord() {
  return {
    mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum: 103,
    details: [{ time: providerTime(NOW - 3600000), desc: "您的订单已出库" }],
  };
}
function listRow(mailNo: string, stateNum: number, at: number) {
  return {
    mailNo, provider: "CaiNiao", cpCode: "YTO", name: "Synthetic carrier", phone: PHONE, stateNum,
    details: [{ time: providerTime(at), desc: "在途源事件" }],
  };
}
function shipmentOf(record: unknown, previous?: Shipment): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
  return applyAccountShipment(previous, parcelToShipment(parcel, [PHONE], NOW - 3600000)!, NOW - 3600000);
}

function seed(rows: Shipment[] = [], referenced: Shipment[] = []): void {
  killRuntime();
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
    referenced.map((row) => ({ ownerId: row.identity.id, source: "interface5" as const, url: REFERENCE })), NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  page.load = () => Promise.resolve(true);
  page.evaluate = () => Promise.resolve(null);
  schedule = async () => undefined;
  holdMount = false;
  listRecords = [];
  listGate = null;
  onListAnswered = null;
  detailGate = null;
  listRequests = 0;
}

/**
 * The holder's lease lapsed and another runtime took `key`, at exactly this point of the holder's work.
 * Suspension cannot reach every point (each stage's own budget ends first), so the record is dropped here.
 */
function takeOverLapsedLease(key: string) {
  withSharedFileTransaction(() => {
    const refresh = sharedData().refresh as { leases: { key: string }[] };
    publishSharedData({ refresh: { ...refresh, leases: refresh.leases.filter((lease) => lease.key !== key) } });
  });
  return leases.acquireDurableRefreshLease(key, 60_000, clock,
    { flowId: "refresh-synthetic-other", trigger: "background" })!;
}

const events = (event: string, flowId?: unknown) => readDiagnostics()
  .filter((entry) => entry.event === event && (flowId == null || entry.details.flowId === flowId));
const flowOf = (event: string, trigger: string) =>
  events(event).find((entry) => entry.details.trigger === trigger)?.details.flowId;

// ---------------------------------------------------------------------------------------------
// The lease itself.
// ---------------------------------------------------------------------------------------------

// A renewing holder's lease is valid for 30 seconds and renewed every 10 while the holder lives. It stays
// held past 30 seconds, never past the holder's maximum operation duration, and renewal ends there.
{
  seed();
  const acquire = leases.acquireRenewingDurableRefreshLease;
  assert.equal(typeof acquire, "function", "a renewing lease exists");
  const before = renewals();
  const holder = acquire("full:interface5", 125_000, clock,
    { flowId: "refresh-synthetic-live", trigger: "home_projection" })!;
  assert.ok(holder);
  assert.equal(leases.durableRefreshLeaseRemainingMs("full:interface5"), 30_000, "valid for 30 seconds");
  assert.equal(holder.expiresAtMs, NOW + 125_000, "the handle reports the holder's limit");
  assert.equal(renewals(), before + 1);
  await advanceTo(NOW + 35_000);
  assert.equal(holder.isCurrent(), true);
  assert.equal(leases.acquireDurableRefreshLease("full:interface5", 1_000, clock), null,
    "a live holder keeps its lease past 30 seconds");
  assert.equal(leases.durableRefreshLeaseRemainingMs("full:interface5"), 25_000, "renewed at +30 s");
  assert.equal(leases.durableRefreshLeaseMaxRemainingMs("full:interface5"), 90_000);
  assert.deepEqual(leases.durableRefreshLeaseDiagnostics("full:interface5"), {
    blockingFlowId: "refresh-synthetic-live", blockingTrigger: "home_projection",
    blockingLeaseAgeMs: 35_000, blockingLeaseRemainingMs: 25_000,
  }, "the existing diagnostics describe a renewed holder without new fields");
  await advanceTo(NOW + 124_999);
  assert.equal(holder.isCurrent(), true);
  assert.equal(timers.size, 0, "the last renewal already carried the lease to its limit");
  assert.equal(renewals(), before, "renewal ends at the limit");
  await advanceTo(NOW + 125_000);
  assert.equal(holder.isCurrent(), false, "never past the holder's maximum operation duration");
  holder.release();
}

// A holder that dies stops renewing: its lease lapses 30 seconds after its last renewal, and a late
// release from it cannot remove the next holder's lease.
{
  seed();
  const dead = leases.acquireRenewingDurableRefreshLease("full:interface5", 125_000, clock)!;
  const before = renewals();
  await advanceTo(NOW + 12_000);
  killRuntime();
  clock = NOW + 39_999;
  assert.equal(leases.acquireDurableRefreshLease("full:interface5", 1_000, clock), null);
  clock = NOW + 40_000;
  const next = leases.acquireDurableRefreshLease("full:interface5", 1_000, clock);
  assert.ok(next, "the dead holder's lease lapsed 30 seconds after its renewal at +10 s");
  dead.release();
  assert.equal(next.isCurrent(), true, "the dead holder's token no longer owns the key");
  assert.equal(renewals(), before - 1);
  next.release();
}

// Renewal extends only a lease its token still holds: never a lapsed one, never another holder's.
{
  seed();
  const suspended = leases.acquireRenewingDurableRefreshLease("full:interface5", 125_000, clock)!;
  const before = renewals();
  assert.equal(leases.renewDurableRefreshLease("full:interface5", "synthetic-other-token"), false);
  clock = NOW + 31_000;
  assert.equal(leases.renewDurableRefreshLease("full:interface5", suspended.token), false,
    "a lapsed lease is not revived");
  assert.equal(leases.durableRefreshLeaseRemainingMs("full:interface5"), 0);
  // Resumed, its overdue timer finds the lease gone and ends the loop.
  await advanceTo(clock);
  assert.equal(suspended.isCurrent(), false);
  assert.equal(renewals(), before - 1, "a failed renewal ends the loop");
  assert.equal(timers.size, 0);
  suspended.release();
}

// Release ends renewal at once. A holder whose maximum is inside 30 seconds keeps exactly that
// lease, with no timer at all.
{
  seed();
  const before = renewals();
  const holder = leases.acquireRenewingDurableRefreshLease("detail:synthetic", 35_000, clock)!;
  assert.equal(timers.size, 1);
  holder.release();
  assert.equal(timers.size, 0, "release clears the renewal timer");
  assert.equal(renewals(), before);
  assert.equal(leases.durableRefreshLeaseRemainingMs("detail:synthetic"), 0);
  const short = leases.acquireRenewingDurableRefreshLease("detail:h5", 21_000, clock)!;
  assert.equal(leases.durableRefreshLeaseRemainingMs("detail:h5"), 21_000, "a shorter maximum is not lengthened");
  assert.equal(timers.size, 0, "nothing to renew");
  assert.equal(renewals(), before);
  short.release();
}

// ---------------------------------------------------------------------------------------------
// The incident: a home projection's runtime is replaced mid-capture; the user then pulls.
// ---------------------------------------------------------------------------------------------
{
  const row = shipmentOf(orderRecord());
  seed([row], [row]);
  const replaced = await runtime("replaced-app");
  const widget = await runtime("widget");
  const app = await runtime("new-app");
  // The union page is still loading when the runtime goes.
  page.load = () => new Promise<boolean>(() => {});
  void replaced.projectStoredAccountOrders();
  await advanceTo(NOW + 12_000);
  assert.equal(events("order.projection.started").length, 1, "the capture was running");
  killRuntime();
  const renewalsAfterDeath = renewals();

  clock = NOW + 20_000;
  const background = await widget.refreshAllShipments("interface5", {
    backgroundHostSafe: true, accountOrderProjection: true, budgetMs: 30_000,
  });
  assert.equal(background.skipReason, "active_cross_runtime_refresh", "widget skip semantics are unchanged");

  const pull = app.refreshAllShipments("interface5", { forceManualRefresh: true, accountOrderProjection: false });
  const outcome = await settle(pull, NOW + 200_000);
  assert.equal(outcome.status, "fulfilled");
  const flowId = flowOf("refresh.wait.started", "list_pull");
  assert.equal(events("refresh.wait.started", flowId)[0]?.details.blockingTrigger, "home_projection");
  const waited = Number(events("refresh.wait.completed", flowId)[0]?.details.durationMs);
  // Its last renewal at +10 s carried the dead holder's lease to +40 s; the fixed lease held it to +125 s.
  assert.ok(waited >= 20_000 && waited <= 20_250,
    `a dead holder blocks the pull until its lease lapses, not for 125 seconds (waited ${waited} ms)`);
  assert.equal((outcome as PromiseFulfilledResult<{ succeeded: number; skipReason?: string }>).value.skipReason,
    undefined);
  assert.equal(listRequests, 1, "the pull ran its own list request");
  assert.equal(renewals(), renewalsAfterDeath, "the pull's renewal ended with it");
  assert.equal(timers.size, 0, "no timer outlives the pull");
}

// ---------------------------------------------------------------------------------------------
// A live holder: a background refresh whose list answers at +24 s and whose detail query answers at
// +33 s. It keeps its lease past 30 seconds and commits; the user's pull waits for it all along.
// ---------------------------------------------------------------------------------------------
{
  seed([shipmentOf(listRow("CNLIVE0001", 104, NOW - 7200000))]);
  listRecords = [listRow("CNLIVE0001", 105, NOW - 3600000)];
  listGate = gateAt(NOW + 24_000);
  detailGate = gateAt(NOW + 33_000);
  const holderRuntime = await runtime("live-widget");
  const app = await runtime("live-app");
  const baseline = renewals();
  const holding = holderRuntime.refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 120_000 });
  await advanceTo(NOW + 1_000);
  const pull = app.refreshAllShipments("interface5", { forceManualRefresh: true, accountOrderProjection: false });
  await advanceTo(NOW + 31_000);
  assert.equal(leases.durableRefreshLeaseDiagnostics("full:interface5").blockingTrigger, "background",
    "the live holder still holds its lease past 30 seconds");
  assert.equal(events("refresh.wait.completed").length, 0, "the pull is still waiting");
  const [held, pulled] = [await settle(holding, NOW + 300_000), await settle(pull, NOW + 300_000)];
  assert.equal(held.status, "fulfilled");
  const holderFlow = flowOf("refresh.started", "background");
  assert.deepEqual(events("refresh.ownership.invalidated", holderFlow), [], "the live holder kept ownership");
  assert.equal(events("refresh.succeeded", holderFlow).length, 1);
  const query = loadState().shipments.find((shipment) => shipment.identity.sourceId === "CNLIVE0001")
    ?.manualTimelines?.find((timeline) => timeline.provider === "v5_query");
  assert.equal(query?.latestDetail, "query 实际物流事件");
  assert.equal(query?.successAtMs, NOW + 33_000, "the holder committed its +33 s detail");
  assert.equal(pulled.status, "fulfilled");
  const waited = Number(events("refresh.wait.completed", flowOf("refresh.wait.started", "list_pull"))[0]
    ?.details.durationMs);
  assert.ok(waited > 30_000 && waited <= 33_000,
    `the pull waited for the live holder's release (waited ${waited} ms)`);
  assert.equal(renewals(), baseline);
  assert.equal(timers.size, 0);
}

// ---------------------------------------------------------------------------------------------
// A holder that lost its lease commits nothing: the user left the app for 45 seconds mid-work.
// ---------------------------------------------------------------------------------------------

// The full refresh (a list pull): suspended while its list request was out, it resumes after another
// runtime took the lease. The pull is invalidated; the next pull does the work.
{
  seed();
  listRecords = [listRow("CNLEASE0001", 104, NOW - 3600000)];
  let openGate = () => {};
  listGate = new Promise<void>((resolve) => { openGate = resolve; });
  const app = await runtime("suspended-pull");
  const baseline = renewals();
  const pull = app.refreshAllShipments("interface5", { forceManualRefresh: true, accountOrderProjection: false });
  await until(() => listRequests === 1);
  clock = NOW + 46_000;
  const other = leases.acquireDurableRefreshLease("full:interface5", 60_000, clock,
    { flowId: "refresh-synthetic-other", trigger: "background" });
  assert.ok(other, "the suspended pull stopped renewing, so its lease lapsed and another runtime took it");
  const revision = peekStateRevision();
  openGate();
  const outcome = await settle(pull, NOW + 200_000);
  assert.equal(outcome.status, "rejected");
  const flowId = flowOf("refresh.started", "list_pull");
  assert.equal(events("refresh.ownership.invalidated", flowId)[0]?.details.result, "ownership_lost");
  assert.equal(events("refresh.failed", flowId)[0]?.details.errorCategory, "ownership_lost");
  assert.equal(peekStateRevision(), revision, "nothing was committed after the lease was lost");
  assert.equal(loadState().shipments.some((shipment) => shipment.identity.sourceId === "CNLEASE0001"), false);
  assert.equal(other.isCurrent(), true, "the invalidated pull's release leaves the new holder alone");
  assert.equal(renewals(), baseline);
  other.release();
  const retry = await settle(
    app.refreshAllShipments("interface5", { forceManualRefresh: true, accountOrderProjection: false }), clock + 200_000);
  assert.equal(retry.status, "fulfilled");
  assert.ok(loadState().shipments.some((shipment) => shipment.identity.sourceId === "CNLEASE0001"),
    "the next pull redoes the discarded work");
  assert.equal(renewals(), baseline);
  assert.equal(timers.size, 0);
}

// The home projection: suspended while the page waited for its viewport, it resumes after another
// runtime took the lease. It commits nothing and the pass ends as failed.
{
  const row = shipmentOf(orderRecord());
  seed([row], [row]);
  holdMount = true;
  page.evaluate = () => Promise.resolve(probe());
  const app = await runtime("suspended-home");
  const baseline = renewals();
  const pass = app.projectStoredAccountOrders();
  await until(() => mountWaiting);
  clock = NOW + 46_000;
  const other = leases.acquireDurableRefreshLease("full:interface5", 60_000, clock,
    { flowId: "refresh-synthetic-other", trigger: "background" });
  assert.ok(other, "the suspended pass stopped renewing, so its lease lapsed and another runtime took it");
  const revision = peekStateRevision();
  releaseMount();
  const outcome = await settle(pass, NOW + 200_000);
  assert.equal(outcome.status, "fulfilled");
  assert.equal((outcome as PromiseFulfilledResult<{ result: string }>).value.result, "failed");
  const flowId = events("order.projection.started")[0]?.details.flowId;
  assert.ok(events("order.projection.failed", flowId)
    .some((entry) => entry.details.errorCategory === "ownership_lost"));
  assert.deepEqual(events("order.projection.committed", flowId), []);
  assert.equal(peekStateRevision(), revision, "nothing was committed after the lease was lost");
  assert.equal(loadState().shipments.find((shipment) => shipment.identity.id === row.identity.id)
    ?.identity.projectedWaybill || "", "");
  assert.equal(other.isCurrent(), true);
  assert.equal(renewals(), baseline);
  other.release();
  holdMount = false;
}

// The commit checks themselves: ownership is lost right after the list answered on time (full refresh) and
// right after the page named the waybill (home projection, its attempt reservation still valid). Each
// holder confirms it still owns the lease before committing and commits nothing.
{
  seed();
  listRecords = [listRow("CNLEASE0002", 104, NOW - 3600000)];
  let other: ReturnType<typeof takeOverLapsedLease> | undefined;
  onListAnswered = () => { other = takeOverLapsedLease("full:interface5"); };
  const app = await runtime("lost-at-list-commit");
  const revision = peekStateRevision();
  const outcome = await settle(
    app.refreshAllShipments("interface5", { forceManualRefresh: true, accountOrderProjection: false }), NOW + 60_000);
  assert.equal(outcome.status, "rejected");
  const flowId = flowOf("refresh.started", "list_pull");
  assert.equal(events("account.sync.parsed", flowId).length, 1, "the list answered in time");
  assert.equal(events("refresh.ownership.invalidated", flowId)[0]?.details.result, "ownership_lost");
  assert.equal(peekStateRevision(), revision, "the list result was not committed");
  assert.equal(loadState().shipments.some((shipment) => shipment.identity.sourceId === "CNLEASE0002"), false);
  assert.equal(other?.isCurrent(), true);
  other!.release();
  assert.equal(timers.size, 0);
}
{
  const row = shipmentOf(orderRecord());
  seed([row], [row]);
  let other: ReturnType<typeof takeOverLapsedLease> | undefined;
  page.evaluate = () => {
    other ??= takeOverLapsedLease("full:interface5");
    return Promise.resolve(probe());
  };
  const app = await runtime("lost-at-projection-commit");
  const outcome = await settle(app.projectStoredAccountOrders(), NOW + 60_000);
  assert.equal((outcome as PromiseFulfilledResult<{ result: string }>).value.result, "failed");
  const flowId = events("order.projection.started")[0]?.details.flowId;
  assert.equal(events("order.projection.extracted", flowId).length, 1, "the page named the waybill");
  assert.deepEqual(events("order.projection.skipped", flowId), [], "the attempt reservation was still its own");
  assert.equal(events("order.projection.failed", flowId)[0]?.details.errorCategory, "ownership_lost");
  assert.deepEqual(events("order.projection.committed", flowId), []);
  assert.equal(loadState().shipments.find((shipment) => shipment.identity.id === row.identity.id)
    ?.identity.projectedWaybill || "", "", "the projection was not committed");
  assert.equal(other?.isCurrent(), true);
  other!.release();
  assert.equal(timers.size, 0);
}

// ---------------------------------------------------------------------------------------------
// Renewal ends with the work however it ends.
// ---------------------------------------------------------------------------------------------

// A home projection whose page fails.
{
  const row = shipmentOf(orderRecord());
  seed([row], [row]);
  page.load = () => Promise.reject(new Error("Synthetic page failure"));
  const app = await runtime("page-error");
  const baseline = renewals();
  const outcome = await settle(app.projectStoredAccountOrders(), NOW + 200_000);
  assert.equal(outcome.status, "fulfilled");
  assert.equal(leases.durableRefreshLeaseRemainingMs("full:interface5"), 0);
  assert.equal(renewals(), baseline);
  assert.equal(timers.size, 0);
}

// A background refresh cancelled at its host budget while its list request never answers.
{
  seed();
  listGate = new Promise<void>(() => {});
  const widget = await runtime("cancelled-widget");
  const baseline = renewals();
  const run = widget.refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 40_000 });
  await advanceTo(NOW + 15_000);
  assert.equal(renewals(), baseline + 1, "the refresh renews its lease while it runs");
  assert.equal(leases.durableRefreshLeaseRemainingMs("full:interface5"), 25_000, "renewed at +10 s");
  const outcome = await settle(run, NOW + 200_000);
  assert.equal(outcome.status, "rejected");
  assert.equal(leases.durableRefreshLeaseRemainingMs("full:interface5"), 0);
  assert.equal(renewals(), baseline);
  assert.equal(timers.size, 0);
}

console.log("refresh lease renewal tests passed");
