import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";

import { parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { saveGatewayToken } from "../services/credentials";
import { readDiagnostics, setDiagnosticsEnabled, writeDiagnostic, type DiagnosticEntry } from "../services/logger";
// A namespace import, so the file still loads — and fails on its assertions — against sources without the new export.
import * as logger from "../services/logger";
import { registerProjectionViewportHost, setProjectionSceneActive } from "../services/projection-viewport";
import { acquireDurableRefreshLease } from "../services/refresh-runtime-state";
import { saveOrderProjectionReferences } from "../services/routes";
import { publishSharedData, sharedData, withSharedFileTransaction } from "../services/shared-file-transaction";
import { applyAccountShipment } from "../services/shipment-policy";
import { emptyState, saveState } from "../services/storage";
import { projectStoredAccountOrders, refreshAllShipments } from "../services/sync";

// 用户 2026-09-28（日志类授权；预发布复查第 1、2 条）。The existing stage-cancellation tests call the inner functions with
// their own AbortController. Here the whole list refresh runs through refreshAllShipments and its coordinator: another
// runtime takes the lease while a stage waits on its request or page, and the next refresh in this runtime finds the
// flow no longer current and cancels it. The coordinator reports refresh.failed as soon as it cancels, and the log
// closes the flow there, so every stage cut off must have ended before that line — once. A Home projection pass cut off
// the same way ends its attempt once. Identities and node texts are synthetic.

const PHONE = "13800009997";
const ORDER = "3999999000000007";
const REFERENCE = "https://u.jd.com/forward?synthetic=coordinator-cancel";
const OLD = "2026-09-08 12:00:00", NEW = "2026-09-08 13:00:00";

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

const aborted = () => Object.assign(new Error("Synthetic request cut off"), { name: "AbortError" });
/** A request or page that answers only by being cut off, as a real one does when its signal aborts. */
function untilAborted<T>(signal?: AbortSignal | null): Promise<T> {
  return new Promise<T>((_, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(aborted());
    else signal.addEventListener("abort", () => reject(aborted()), { once: true });
  });
}

let pageOpened = false;
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    async loadURL() { pageOpened = true; return true; }
    evaluateJavaScript() { return new Promise(() => {}); }
    dispose() {}
  },
});
registerProjectionViewportHost({ mount: async () => true, unmount: () => {} });

type Hang = "list" | "online" | "account_detail" | null;
let hang: Hang = null;
let listRecords: unknown[] = [];
let inFlight = false;
const json = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const path = new URL(url).pathname;
  if (path === "/api/express/accounts/sync") {
    if (hang === "list") {
      inFlight = true;
      return untilAborted(init?.signal);
    }
    return json({ code: 0, data: { expressList: listRecords } });
  }
  if (path === "/api/express/timeline/source") {
    const request = JSON.parse(String(init?.body));
    if ((hang === "online" && request.interface === "v6") ||
        (hang === "account_detail" && request.interface === "v5" && request.mode === "detail")) {
      inFlight = true;
      return untilAborted(init?.signal);
    }
  }
  return { ok: false, status: 503, text: async () => "Synthetic offline" };
}) as typeof fetch;

const row = (mailNo: string, provider: string, cpCode: string, stateNum: number, at: string, desc: string) => ({
  mailNo, provider, cpCode, name: "Synthetic carrier", phone: PHONE, stateNum, details: [{ time: at, desc }],
});
const jdOrder = () => ({ ...row(ORDER, "JingDong", "JDKD", 103, NEW, "您的订单已出库"),
  jumpList: [{ type: "h5", link: REFERENCE }] });

function seed(stored: ReturnType<typeof row>[], nextHang: Hang, records: unknown[] = stored): void {
  clock = NOW;
  memory.clear();
  setDiagnosticsEnabled(true);
  const parsed = parseAccountSyncResult("interface5", { code: 0, data: { expressList: stored } });
  const shipments = parsed.parcels.map((parcel) => applyAccountShipment(undefined,
    parcelToShipment(parcel, [PHONE], NOW - 3600000)!, NOW - 3600000));
  saveState({ ...emptyState(), shipments,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }],
    feedSlotRebuiltAtMs: NOW - 86400000 }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  hang = nextHang;
  listRecords = records;
  inFlight = false;
  pageOpened = false;
  setProjectionSceneActive(true);
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = realNow() + 4_000;
  while (!condition()) {
    if (realNow() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Another runtime takes full:<source> from under this runtime's holder. */
function anotherRuntimeTakesTheLease() {
  withSharedFileTransaction(() => {
    const refresh = sharedData().refresh as { leases: { key: string }[] };
    publishSharedData({ refresh: { ...refresh,
      leases: refresh.leases.filter((lease) => lease.key !== "full:interface5") } });
  });
  return acquireDurableRefreshLease("full:interface5", 60_000, clock,
    { flowId: "refresh-synthetic-other", trigger: "background" })!;
}

/** The next refresh in this runtime asks the coordinator for the current one, which cancels it. */
async function nextRefreshFindsTheFlowLost(): Promise<void> {
  const other = anotherRuntimeTakesTheLease();
  const next = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.equal(next.skipReason, "active_cross_runtime_refresh");
  other.release();
}

function flowLines(flowId: unknown): DiagnosticEntry[] {
  return readDiagnostics().reverse().filter((entry) => entry.details.flowId === flowId);
}

/** Exactly one cancelled end of `stage`, written before the flow's refresh.failed. */
function assertStageEndedBeforeTheFlow(lines: DiagnosticEntry[], event: string, stage: string): number {
  const describe = JSON.stringify(lines.map((entry) => [entry.event, entry.details.stage, entry.details.errorCategory]));
  const ends = lines.flatMap((entry, index) => entry.event === event && entry.details.stage === stage ? [index] : []);
  assert.equal(ends.length, 1, `${event} ${stage}: ${describe}`);
  assert.equal(lines[ends[0]!]!.details.errorCategory, "cancelled", describe);
  const flowEnd = lines.findIndex((entry) => entry.event === "refresh.failed");
  assert.ok(flowEnd > ends[0]!, `the stage ends before the flow: ${describe}`);
  assert.equal(lines[flowEnd]!.details.errorCategory, "ownership_lost");
  return ends[0]!;
}

async function cutOffPull(options: Parameters<typeof refreshAllShipments>[1], started: () => boolean) {
  const pull = refreshAllShipments("interface5", options);
  const outcome = pull.then(() => null, (error: unknown) => error);
  await until(started);
  await nextRefreshFindsTheFlowLost();
  assert.ok(await outcome, "the cut-off refresh rejects");
  const flowId = readDiagnostics().find((entry) => entry.event === "refresh.started" &&
    entry.details.trigger === "list_pull")?.details.flowId;
  assert.ok(flowId);
  return flowLines(flowId);
}

const pull = { forceManualRefresh: true, accountOrderProjection: false } as const;

test("a list request cut off by the coordinator ends its stage before the flow", async () => {
  seed([], "list");
  const lines = await cutOffPull(pull, () => inFlight);
  assertStageEndedBeforeTheFlow(lines, "account.sync.failed", "v5_list");
});

test("an Online refresh cut off by the coordinator ends its source and stage before the flow", async () => {
  const sf = row("SF9990000000007", "ShunFeng", "SF", 104, OLD, "在途源事件");
  seed([sf], "online");
  const lines = await cutOffPull(pull, () => inFlight);
  const stageEnd = assertStageEndedBeforeTheFlow(lines, "refresh.stage.failed", "manual_refresh");
  const sourceEnds = lines.flatMap((entry, index) => entry.event === "manual.source.failed" ? [index] : []);
  assert.equal(sourceEnds.length, 1, JSON.stringify(lines.map((entry) => [entry.event, entry.details.stage])));
  assert.equal(lines[sourceEnds[0]!]!.details.errorCategory, "cancelled");
  assert.ok(sourceEnds[0]! < stageEnd, "the source ends before its stage, as when the stage's own catch writes both");
});

test("a Home account query cut off by the coordinator ends its stage before the flow", async () => {
  const stored = row("YT9990000000007", "CaiNiao", "YTO", 104, OLD, "在途源事件");
  seed([stored], "account_detail", [row("YT9990000000007", "CaiNiao", "YTO", 105, NEW, "派送中")]);
  const lines = await cutOffPull({ forceManualRefresh: true, accountSourceFollowup: true,
    accountOrderProjection: false }, () => inFlight);
  assertStageEndedBeforeTheFlow(lines, "refresh.stage.failed", "v5_query");
});

test("a union page cut off by the coordinator ends its projection stage before the flow", async () => {
  seed([], null, [jdOrder()]);
  const lines = await cutOffPull({ forceManualRefresh: true }, () => pageOpened);
  assertStageEndedBeforeTheFlow(lines, "order.projection.failed", "webview");
});

test("a Home projection pass cut off by the coordinator ends its attempt once", async () => {
  const order = jdOrder();
  seed([order], null);
  saveOrderProjectionReferences([{ ownerId: `interface5:account:${ORDER}`, source: "interface5", url: REFERENCE }], NOW);
  const pass = projectStoredAccountOrders();
  await until(() => pageOpened);
  await nextRefreshFindsTheFlowLost();
  assert.equal((await pass).result, "failed");
  const flowId = readDiagnostics().find((entry) => entry.event === "order.projection.started")?.details.flowId;
  const lines = flowLines(flowId);
  const ends = lines.filter((entry) => entry.event === "order.projection.failed");
  assert.equal(ends.length, 1, JSON.stringify(lines.map((entry) => [entry.event, entry.details.errorCategory])));
  assert.equal(ends[0]!.details.errorCategory, "ownership_lost", "the pass writes the attempt's end, with its reason");
  assert.equal(ends[0]!.details.stage, "webview");
});

test("a flow's end line comes after the cancelled ends its stages still owe it, each written once", () => {
  memory.clear();
  setDiagnosticsEnabled(true);
  const open = (logger as { openStageCancellationEnd?: typeof logger.openStageCancellationEnd }).openStageCancellationEnd;
  assert.equal(typeof open, "function");
  const flowId = "refresh-synthetic-owed";
  const cut = new AbortController();
  const stageEnd = (stage: string) => () =>
    writeDiagnostic("refresh.stage.failed", { flowId, stage, errorCategory: "cancelled" }, "warning");
  const outer = open!(flowId, cut.signal, stageEnd("manual_refresh"));
  const inner = open!(flowId, cut.signal, stageEnd("account_detail"));
  const finished = open!(flowId, cut.signal, stageEnd("account_list"));
  finished.close();
  const reached = open!(flowId, cut.signal, stageEnd("webview"));
  cut.abort();
  reached.end();
  writeDiagnostic("refresh.failed", { flowId, errorCategory: "ownership_lost" }, "error");
  outer.end();
  inner.end();
  assert.deepEqual(flowLines(flowId).map((entry) => [entry.event, entry.details.stage]), [
    ["refresh.stage.failed", "webview"],
    ["refresh.stage.failed", "v5_query"],
    ["refresh.stage.failed", "manual_refresh"],
    ["refresh.failed", undefined],
  ], "the stage that reached its own end writes it there; the ones still owed come innermost first; a closed one never");

  // A flow that ends without being cancelled owes nothing.
  const quiet = "refresh-synthetic-quiet";
  const running = open!(quiet, new AbortController().signal, () =>
    writeDiagnostic("refresh.stage.failed", { flowId: quiet, stage: "manual_refresh", errorCategory: "cancelled" }));
  writeDiagnostic("refresh.succeeded", { flowId: quiet });
  running.close();
  assert.deepEqual(flowLines(quiet).map((entry) => entry.event), ["refresh.succeeded"]);
});
