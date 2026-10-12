import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { memory, NOW } from "./state-storage-mock";

import type { AppState, Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { saveGatewayToken } from "../services/credentials";
import {
  createForegroundOrderProjection,
  startForegroundOrderProjection,
  type ForegroundOrderProjectionDependencies,
} from "../services/foreground-order-projection";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { acquireDurableRefreshLease } from "../services/refresh-runtime-state";
import { saveOrderProjectionReferences } from "../services/routes";
import { applyAccountShipment } from "../services/shipment-policy";
import { emptyState, loadState, peekStateRevision, saveState } from "../services/storage";
import {
  projectStoredAccountOrders,
  refreshAllShipments,
  subscribeFullRefreshOutcome,
  type FullRefreshOutcome,
  type StoredOrderProjectionResult,
} from "../services/sync";

// 用户 2026-09-24 采纳：App 在屏幕上时自己抓京东订单的运单号，不等用户下拉（与 Lite 首页同口径）。
// 三种时候跑存盘行投影：本运行时的全量刷新落地或被别的运行时的租约挡掉、场景回到 active、前台时发现别的运行时落盘。

// ---------------------------------------------------------------------------------------------
// The controller on its own: manual timers, a scripted pass.
// ---------------------------------------------------------------------------------------------

function harness(results: StoredOrderProjectionResult[] = []) {
  let nextTimer = 1;
  const timers = new Map<number, { delayMs: number; callback: () => void }>();
  let listener: ((outcome: FullRefreshOutcome) => void) | null = null;
  let revision = 10;
  const passes: string[][] = [];
  const applied: AppState[] = [];
  let duringPass = () => {};
  let lastOptions: Parameters<ForegroundOrderProjectionDependencies["runPass"]>[0] | null = null;
  const dependencies: ForegroundOrderProjectionDependencies = {
    runPass: async (options) => {
      lastOptions = options;
      passes.push([...options.excludeOwnerIds]);
      duringPass();
      return results.shift() || { result: "nothing_due", moreDue: false };
    },
    subscribeRefreshOutcome: (next) => {
      listener = next;
      return () => { listener = null; };
    },
    peekRevision: () => revision,
    applyState: (state) => { applied.push(state); },
    setTimer: (callback, delayMs) => {
      const id = nextTimer++;
      timers.set(id, { delayMs, callback });
      return id;
    },
    clearTimer: (handle) => { timers.delete(handle as number); },
    watchIntervalMs: 1_000,
  };
  const controller = createForegroundOrderProjection(dependencies);
  const settle = async () => {
    for (let round = 0; round < 50; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const due = [...timers].filter(([, timer]) => timer.delayMs === 0);
      if (!due.length) continue;
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  const watchPending = () => [...timers.values()].some((timer) => timer.delayMs === 1_000);
  const tick = async () => {
    const watch = [...timers].find(([, timer]) => timer.delayMs === 1_000);
    assert.ok(watch, "the revision watch is scheduled while on screen");
    timers.delete(watch[0]);
    watch[1].callback();
    await settle();
  };
  return {
    controller,
    passes,
    applied,
    settle,
    tick,
    watchPending,
    publish: (outcome: FullRefreshOutcome) => listener?.(outcome),
    subscribed: () => listener != null,
    setRevision: (value: number) => { revision = value; },
    revision: () => revision,
    onPass: (callback: () => void) => { duringPass = callback; },
    options: () => lastOptions,
  };
}

const stateAt = (revision: number) => ({ ...emptyState(), revision }) as AppState;

// 用户 2026-09-25 同意：已完成、还没运单号的订单只在 App 在屏幕上时取号（`onScreen`）。在屏幕上跑的一遍
// onScreen 为真；这一遍还没跑完 App 就离开屏幕，同一个 onScreen 随即为假，isActive 也一起变假。
{
  const h = harness();
  const seen: boolean[] = [];
  h.onPass(() => {
    const options = h.options()!;
    seen.push(options.onScreen(), options.isActive());
    h.controller.scenePhaseChanged("inactive");
    seen.push(options.onScreen(), options.isActive());
  });
  h.controller.scenePhaseChanged("active");
  await h.settle();
  assert.deepEqual(seen, [true, true, false, false], "on screen, then off screen mid-pass");
  h.controller.stop();
}

// Scene: 'active' runs a pass; 'inactive' and 'background' never do, and stop the revision watch.
{
  const h = harness();
  await h.settle();
  assert.equal(h.passes.length, 0, "mounting alone runs nothing");
  assert.equal(h.watchPending(), true);
  h.controller.scenePhaseChanged("inactive");
  await h.settle();
  h.controller.scenePhaseChanged("background");
  await h.settle();
  assert.equal(h.passes.length, 0, "inactive and background never run a pass");
  assert.equal(h.watchPending(), false, "the revision watch stops off screen");
  h.setRevision(11);
  await h.settle();
  assert.equal(h.passes.length, 0, "another runtime's commit is not looked for off screen");
  h.controller.scenePhaseChanged("active");
  await h.settle();
  assert.equal(h.passes.length, 1, "returning to the foreground runs one pass");
  assert.equal(h.watchPending(), true, "the revision watch resumes on screen");
  await h.tick();
  assert.equal(h.passes.length, 1, "the commit seen by that pass does not start another");
  h.controller.stop();
  assert.equal(h.subscribed(), false);
  assert.equal(h.watchPending(), false);
  h.controller.scenePhaseChanged("active");
  await h.settle();
  assert.equal(h.passes.length, 1, "a stopped controller never runs again");
}

// Refresh outcomes: every app-runtime refresh that lands or is skipped runs a pass; a background
// host refresh never does.
{
  const h = harness();
  h.publish({ source: "interface5", trigger: "background" });
  await h.settle();
  assert.equal(h.passes.length, 0, "background refreshes never lead to a pass");
  for (const outcome of [
    { source: "interface5", trigger: "foreground" },
    { source: "interface5", trigger: "foreground", skipReason: "active_cross_runtime_refresh" },
    { source: "interface5", trigger: "list_pull" },
    { source: "interface5", trigger: "account_list_only" },
  ] as const) {
    const before = h.passes.length;
    h.publish(outcome);
    assert.equal(h.passes.length, before, "never inside the publishing refresh's own stack");
    await h.settle();
    assert.equal(h.passes.length, before + 1, JSON.stringify(outcome));
  }
  h.controller.stop();
}

// A chain: one order per pass, the tried ones excluded, until nothing else is due.
{
  const h = harness([
    { result: "attempted", ownerId: "interface5:account:A", moreDue: true, state: stateAt(21) },
    { result: "attempted", ownerId: "interface5:account:B", moreDue: false, state: stateAt(22) },
  ]);
  h.controller.scenePhaseChanged("active");
  await h.settle();
  assert.deepEqual(h.passes, [[], ["interface5:account:A"]]);
  assert.deepEqual(h.applied.map((state) => state.revision), [21, 22], "each committed state reaches Home");
  h.controller.stop();
}

// Another runtime's newer revision runs exactly one pass; that pass's own commits start no second.
{
  const h = harness([
    { result: "attempted", ownerId: "interface5:account:A", moreDue: false, state: stateAt(13) },
  ]);
  h.onPass(() => h.setRevision(13));
  await h.tick();
  assert.equal(h.passes.length, 0, "an unchanged revision runs nothing");
  h.setRevision(11);
  await h.tick();
  assert.equal(h.passes.length, 1, "a newer revision runs one pass");
  assert.equal(h.revision(), 13, "the pass committed twice itself");
  for (let round = 0; round < 5; round++) await h.tick();
  assert.equal(h.passes.length, 1, "the pass's own commits never start another");
  h.onPass(() => {});
  h.setRevision(14);
  await h.tick();
  assert.equal(h.passes.length, 2, "the next foreign commit is noticed again");
  h.controller.stop();
}

// Triggers that arrive while a chain runs collapse into one more pass afterwards.
{
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const results: StoredOrderProjectionResult[] = [];
  let calls = 0;
  const slow = createForegroundOrderProjection({
    runPass: async () => {
      calls++;
      if (calls === 1) await gate;
      return results.shift() || { result: "nothing_due", moreDue: false };
    },
    subscribeRefreshOutcome: () => () => {},
    peekRevision: () => 1,
    applyState: () => {},
    setTimer: (callback) => setTimeout(callback, 0),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    watchIntervalMs: 60_000,
  });
  slow.scenePhaseChanged("active");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  slow.scenePhaseChanged("inactive");
  slow.scenePhaseChanged("active");
  slow.scenePhaseChanged("active");
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 2, "one rerun, not one per trigger");
  slow.stop();
}

console.log("foreground order projection controller tests passed");

// ---------------------------------------------------------------------------------------------
// With the real refresh, storage and pass.
// ---------------------------------------------------------------------------------------------

const PHONE = "13800001717";
const ORDER = "3622448007483911";
const REFERENCE = "https://u.jd.com/forward?synthetic=foreground-pass";
const WAYBILL = "JD0256747737311";

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
const loadedUrls: string[] = [];
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    constructor() { pageLoads++; }
    async loadURL(url: string) { loadedUrls.push(url); return true; }
    async evaluateJavaScript() {
      return { extractionSource: "probe", waybillCode: WAYBILL, companyName: "京东快递", traceList: [] };
    }
    dispose() {}
  },
});
const requests: string[] = [];
globalThis.fetch = (async (url: string) => {
  requests.push(new URL(url).pathname);
  return { ok: false, status: 503, text: async () => "Synthetic offline" };
}) as typeof fetch;
registerProjectionViewportHost({ mount: async () => false, unmount: () => {} });

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

/** Raw list state 103: shown as 已下单 on the stored row, past pickup on the list. */
function pickedOrder(): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum: 103,
    details: [{ time: providerTime(NOW - 3600000), desc: "您的订单已出库" }],
  }] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], NOW - 3600000)!, NOW - 3600000);
}

function seed(rows: Shipment[]) {
  clock = NOW;
  memory.clear();
  setDiagnosticsEnabled(true);
  saveState({
    ...emptyState(),
    shipments: rows,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }],
    feedSlotRebuiltAtMs: NOW - 86400000,
  }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  pageLoads = 0;
  loadedUrls.length = 0;
  requests.length = 0;
}

const saveReference = (row: Shipment) => saveOrderProjectionReferences(
  [{ ownerId: row.identity.id, source: "interface5", url: REFERENCE }], NOW);

async function until(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = realNow() + timeoutMs;
  while (!condition()) {
    if (realNow() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const projectedWaybill = (row: Shipment) =>
  loadState().shipments.find((shipment) => shipment.identity.id === row.identity.id)?.identity.projectedWaybill;

// Launch not lost: the widget held full:<source>, so the app's launch refresh was skipped. The
// stored-row pass waits for the widget to release and then projects, still without a list request.
{
  const row = pickedOrder();
  seed([row]);
  saveReference(row);
  const widget = acquireDurableRefreshLease("full:interface5", 30_000, clock,
    { flowId: "synthetic-widget", trigger: "background" })!;
  assert.ok(widget);
  const applied: AppState[] = [];
  const app = startForegroundOrderProjection({ applyState: (state) => { applied.push(state); } });
  const launch = await refreshAllShipments();
  assert.equal(launch.skipReason, "active_cross_runtime_refresh");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(pageLoads, 0, "nothing opens while the widget still holds the lease");
  widget.release();
  await until(() => projectedWaybill(row) === WAYBILL);
  assert.equal(pageLoads, 1);
  assert.deepEqual(loadedUrls, [REFERENCE]);
  assert.equal(requests.includes("/api/express/accounts/sync"), false, "no account-list request");
  await until(() => applied.length > 0);
  assert.equal(applied.at(-1)!.shipments.find((shipment) => shipment.identity.id === row.identity.id)
    ?.identity.projectedWaybill, WAYBILL, "Home receives the projected row");
  app.stop();
}

// The app's own refresh lands: this list round carried no page link for the order, so the refresh
// could not open the union page; the pass that follows opens it from the saved reference.
{
  const row = pickedOrder();
  seed([row]);
  saveReference(row);
  const record = {
    mailNo: ORDER, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE, stateNum: 103,
    details: [{ time: providerTime(NOW - 3600000), desc: "您的订单已出库" }],
  };
  const offline = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path !== "/api/express/accounts/sync") {
      return { ok: false, status: 503, text: async () => "Synthetic offline" };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: [record] } }) };
  }) as typeof fetch;
  const app = startForegroundOrderProjection({ applyState: () => {} });
  const landed = await refreshAllShipments();
  assert.equal(landed.skipReason, undefined);
  assert.equal(pageLoads, 0, "the list round itself had no page link to open");
  const listRequests = requests.filter((path) => path === "/api/express/accounts/sync").length;
  assert.equal(listRequests, 1);
  await until(() => projectedWaybill(row) === WAYBILL);
  assert.equal(pageLoads, 1);
  assert.deepEqual(loadedUrls, [REFERENCE]);
  assert.equal(requests.filter((path) => path === "/api/express/accounts/sync").length, listRequests,
    "the pass after the landing makes no list request of its own");
  app.stop();
  globalThis.fetch = offline;
}

// Another runtime commits while the app is on screen: the widget saves the order under its lease,
// then its page reference, then releases. Exactly one pass runs and projects; the pass's own
// commits bump the revision but start no second pass.
{
  seed([]);
  let passes = 0;
  const app = createForegroundOrderProjection({
    runPass: (options) => {
      passes++;
      return projectStoredAccountOrders({ ...options, waitForOtherRuntime: true });
    },
    subscribeRefreshOutcome: subscribeFullRefreshOutcome,
    peekRevision: peekStateRevision,
    applyState: () => {},
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    watchIntervalMs: 20,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(passes, 0, "an unchanged revision runs nothing");
  const widget = acquireDurableRefreshLease("full:interface5", 30_000, clock,
    { flowId: "synthetic-widget", trigger: "background" })!;
  const row = pickedOrder();
  saveState({ ...loadState(), shipments: [row] }, clock);
  const widgetRevision = peekStateRevision();
  await until(() => passes === 1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(pageLoads, 0, "the pass waits for the widget's lease");
  saveReference(row);
  widget.release();
  await until(() => projectedWaybill(row) === WAYBILL);
  assert.equal(pageLoads, 1);
  assert.ok(peekStateRevision() > widgetRevision, "the pass committed its reservation and result");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(passes, 1, "its own commits start no second pass");
  assert.equal(pageLoads, 1);
  assert.equal(requests.includes("/api/express/accounts/sync"), false);
  const pageEvents = readDiagnostics().filter((entry) => entry.event === "order.projection.started");
  assert.equal(pageEvents.length, 1);
  app.stop();
}

// The app root wires the controller to the scene phase and stops it on dismissal.
{
  const app = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
  assert.match(app,
    /startForegroundOrderProjection\(\{ applyState \}\)[\s\S]*?"app\.scene\.changed"[\s\S]*?scenePhaseChanged\(phase\)[\s\S]*?AppEvents\.scenePhase\.addListener[\s\S]*?orderProjection\.stop\(\)/);
}

console.log("foreground order projection integration tests passed");
