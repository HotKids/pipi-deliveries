import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import type { AppState, Shipment, TimelinePackage } from "../models";
import { setDiagnosticsEnabled } from "../services/logger";
import { refreshSummaryToast } from "../services/ui-feedback";

type FakeData = { value: string };
type FakeFetchInit = {
  body?: string;
  signal?: AbortSignal;
};

const files = new Map<string, string>();
const keychain = new Map<string, string>();
const storage = new Map<string, unknown>();
const fetchStages: string[] = [];
let accountListFailure: "timeout" | "unauthorized" | "unavailable" = "timeout";
let accountReply: (() => Promise<ReturnType<typeof jsonResponse>>) | null = null;
let onStorageRead: ((key: string) => void) | null = null;
let beforeDetailReply: (() => void) | null = null;
let rejectNotification = false;
let notificationAttempts = 0;
const notificationBodies: unknown[] = [];
let pickerReply: ((waybill: string) => ReturnType<typeof jsonResponse>) | null = null;

function providerTime(value: number): string {
  const date = new Date(value);
  const part = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${
    part(date.getHours())
  }:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

const detailEventAtMs = Date.now() - 1_000;
const detailTimeText = providerTime(detailEventAtMs);

function dataValue(value: FakeData | string): string {
  return typeof value === "string" ? value : value.value;
}

function jsonResponse(value: unknown) {
  const text = JSON.stringify(value);
  return {
    ok: true,
    status: 200,
    expectedContentLength: text.length,
    text: async () => text,
  };
}

Object.assign(globalThis, {
  Data: {
    fromFile: () => ({ value: "" }),
    fromIntArray: (value: number[]) => ({
      value: Buffer.from(value).toString("utf8"),
    }),
    fromRawString: (value: string) => ({ value }),
  },
  Crypto: {
    sha256: (value: FakeData | string) => ({
      toHexString: () => createHash("sha256")
        .update(dataValue(value))
        .digest("hex"),
    }),
    hmacSHA256: (value: FakeData, key: FakeData) => ({
      toHexString: () => createHmac("sha256", key.value)
        .update(value.value)
        .digest("hex"),
    }),
    generateSymmetricKey: () => ({
      toHexString: () => "0123456789abcdef0123456789abcdef",
    }),
  },
  Path: {
    join(...parts: string[]) {
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync(path: string) {
      return files.has(path);
    },
    isFileSync(path: string) {
      return files.has(path);
    },
    readAsStringSync(path: string) {
      const value = files.get(path);
      if (value == null) throw new Error("missing synthetic file");
      return value;
    },
    removeSync(path: string) {
      files.delete(path);
    },
    renameSync(path: string, newPath: string) {
      const value = files.get(path);
      if (value == null || files.has(newPath)) {
        throw new Error("synthetic rename rejected");
      }
      files.set(newPath, value);
      files.delete(path);
    },
    writeAsStringSync(path: string, value: string) {
      files.set(path, value);
    },
  },
  Keychain: {
    get(key: string): string | null {
      return keychain.get(key) ?? null;
    },
    set(key: string, value: string): boolean {
      keychain.set(key, value);
      return true;
    },
    remove(key: string): boolean {
      return keychain.delete(key);
    },
  },
  Storage: {
    get<T>(key: string): T | null {
      onStorageRead?.(key);
      return (storage.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean {
      storage.set(key, structuredClone(value));
      return true;
    },
    remove(key: string): void {
      storage.delete(key);
    },
  },
  Notification: {
    schedule: async (event: { body: string }) => {
      notificationAttempts++;
      notificationBodies.push(event.body);
      if (rejectNotification) throw new Error("synthetic notification failure");
    },
  },
  Widget: {
    reloadAll() {},
  },
  Script: {
    directory: "/script",
    name: "Pipi Deliveries Test",
    createRunSingleURLScheme: () => "pipi-test://shipment",
  },
  fetch: async (url: string, init?: FakeFetchInit) => {
    const route = new URL(url).pathname;
    if (route === "/api/express/accounts/sync") {
      fetchStages.push("account_list");
      if (accountReply) return accountReply();
      if (accountListFailure === "unauthorized") {
        const text = JSON.stringify({ error: "unauthorized" });
        return {
          ok: false,
          status: 401,
          expectedContentLength: text.length,
          text: async () => text,
        };
      }
      if (accountListFailure === "unavailable") {
        return { ok: false, status: 502,
          text: async () => JSON.stringify({ error: "upstream_unavailable" }) };
      }
      const timeout = new Error("synthetic account-list timeout");
      timeout.name = "TimeoutError";
      throw timeout;
    }
    if (route === "/api/express/timeline/source") {
      const body = JSON.parse(String(init?.body || "{}")) as {
        mode?: string;
        waybill?: string;
      };
      if ((body.mode === "refresh" || body.mode === "manual") && pickerReply) return pickerReply(body.waybill || "");
      assert.equal(body.mode, "detail");
      fetchStages.push("account_detail");
      beforeDetailReply?.();
      return jsonResponse({
        code: 0,
        data: {
          stateNum: 104,
          details: [{
            time: detailTimeText,
            desc: "cached detail refreshed after list timeout",
            stateNum: 104,
          }],
        },
      });
    }
    throw new Error(`unexpected synthetic route: ${route}`);
  },
});

// Diagnostics are recorded only when enabled: the formal track ships with recording off
// (user decision 2026-09-04), so a test that asserts on the log has to opt in explicitly.
setDiagnosticsEnabled(true);

const { saveGatewayToken } = await import("../services/credentials");
const { clearDiagnostics, readDiagnostics } = await import("../services/logger");
const { saveState, loadState } = await import("../services/storage");
const { refreshAllShipments, subscribeRefreshState } = await import("../services/sync");

const PHONE = "13800138000";
const WAYBILL = "ZTCACHED5900";

function timeline(detail: string, successAtMs: number): TimelinePackage {
  const timeText = providerTime(successAtMs);
  return {
    provider: "interface5",
    waybill: WAYBILL,
    courierCode: "ZTO",
    companyName: "中通快递",
    semantic: "TRANSIT", structuredStatus: true,
    statusEventAtMs: successAtMs,
    latestTimeText: timeText,
    latestDetail: detail,
    tracks: [{
      timeText,
      timeMs: successAtMs,
      detail,
      statusCode: "104",
      raw: {},
    }],
    successAtMs,
  };
}

function cachedShipment(now: number): Shipment {
  const sourceTimeline = timeline(
    "cached detail before refresh",
    now - 60_000,
  );
  return {
    identity: {
      id: `interface5:account:${WAYBILL}`,
      bindingSource: "interface5",
      sourceOwner: "interface5",
      sourceId: WAYBILL,
      phoneTail: PHONE.slice(-4),
      phone: PHONE,
      courierCode: "ZTO",
      rawCourierCode: "ZTO",
      companyName: "中通快递",
      sourceProvider: "CaiNiao",
      accountOrder: false,
      manuallyAdded: false,
      createdAtMs: now - 120_000,
    },
    timeline: sourceTimeline,
    sourceTimeline,
    manualTimelines: [],
    route: null,
    accountRecord: {
      waybill: WAYBILL,
      companyCode: "ZTO",
      name: "中通快递",
      provider: "CaiNiao",
      stateNumber: 104,
      updateTime: providerTime(now - 60_000),
      phone: PHONE,
      channel: "1",
    },
    updatedAtMs: now - 60_000,
  };
}

function state(shipments: readonly Shipment[]): AppState {
  const now = Date.now();
  return {
    version: 2,
    revision: 0,
    updatedAtMs: now,
    activeSource: "interface5",
    bindings: [{
      source: "interface5",
      phone: PHONE,
      boundAtMs: now - 120_000,
    }],
    pendingQueries: [],
    shipments,
  };
}

saveGatewayToken("AbCdEfGh_123-456");

const now = Date.now();
const initial = saveState(state([cachedShipment(now)]), now);
const initialId = initial.shipments[0]?.identity.id;
clearDiagnostics();
fetchStages.length = 0;

const fallback = await refreshAllShipments("interface5", {
  budgetMs: 30_000,
  accountOrderProjection: false,
});

assert.deepEqual(fetchStages, ["account_list"]);
assert.deepEqual(
  {
    attempted: fallback.attempted,
    succeeded: fallback.succeeded,
    failed: fallback.failed,
  },
  { attempted: 1, succeeded: 0, failed: 1 },
  "a list failure with usable cached status and tracks must not trigger per-parcel requests",
);
assert.equal(fallback.state.shipments.length, 1);
assert.notEqual(fallback.accountListUpdated, true, "cached fallback is not a successful list update");
assert.equal(fallback.state.shipments[0]?.identity.id, initialId);
// 用户定 2026-09-05 晚：feed 增量与 query 独立。行（列表头条）仍是 feed 自己的；按件详情住 v5_query 槽。
assert.equal(
  fallback.state.shipments[0]?.timeline.latestDetail,
  "cached detail before refresh",
  "the list row keeps the feed headline; the per-order detail never rewrites it",
);
assert.equal(
  fallback.state.shipments[0]?.manualTimelines?.find(
    (timeline) => timeline.provider === "v5_query",
  )?.latestDetail,
  undefined,
  "list failure must not populate the v5_query detail slot",
);
assert.equal(
  readDiagnostics().find((entry) => entry.event === "account.sync.failed")
    ?.details.result,
  "cached_fallback",
);
assert.equal(
  readDiagnostics().find((entry) => entry.event === "refresh.failed")
    ?.details.result,
  "failed",
);

saveState(state([]), Date.now());
clearDiagnostics();
fetchStages.length = 0;
const empty = await refreshAllShipments("interface5", {
  budgetMs: 30_000,
  accountOrderProjection: false,
});

assert.deepEqual(fetchStages, ["account_list"]);
assert.deepEqual(
  { attempted: empty.attempted, succeeded: empty.succeeded, failed: empty.failed },
  { attempted: 1, succeeded: 0, failed: 1 },
  "without persisted source state, an account-list failure must remain fail-closed",
);
assert.equal(empty.state.shipments.length, 0);
assert.equal(
  readDiagnostics().find((entry) => entry.event === "account.sync.failed")
    ?.details.result,
  "failed",
);

saveState(state([cachedShipment(Date.now())]), Date.now());
clearDiagnostics();
fetchStages.length = 0;
accountListFailure = "unauthorized";
await assert.rejects(
  refreshAllShipments("interface5", {
    budgetMs: 30_000,
    accountOrderProjection: false,
  }),
  /访问授权无效/,
  "credential recovery must remain fatal even when cached state exists",
);
assert.deepEqual(fetchStages, ["account_list"]);
assert.equal(
  readDiagnostics().find((entry) => entry.event === "account.sync.failed")
    ?.details.result,
  "failed",
);

console.log("account-list cached fallback production-path tests passed");

// A received 502 follows the full failure path and frees the same source immediately.
{
  accountListFailure = "unavailable";
  saveState(state([cachedShipment(Date.now())]), Date.now());
  clearDiagnostics();
  const failure = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 120_000 });
  assert.equal(failure.failed, 1);
  const events = readDiagnostics();
  assert.equal(events.find(entry => entry.event === "account.sync.failed")?.details.httpStatus, 502);
  for (const event of ["refresh.account.completed", "refresh.enrichment.completed", "refresh.finalization.completed", "refresh.failed"]) {
    assert.ok(events.some(entry => entry.event === event), `missing failure boundary: ${event}`);
  }
  const secondRuntime = await import("../services/sync.ts?after-502-runtime");
  const retry = await secondRuntime.refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 120_000 });
  assert.notEqual(retry.skipReason, "active_cross_runtime_refresh");
  accountListFailure = "timeout";
}

// Two isolated sync modules share only the synthetic durable stores.
{
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    saveState(state([]), clock);
    let releaseFirst!: (response: ReturnType<typeof jsonResponse>) => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    accountReply = () => {
      enteredFirst();
      return new Promise((resolve) => { releaseFirst = resolve; });
    };
    let reads = 0;
    onStorageRead = (key) => {
      if (key === "pipi_deliveries_state_v1" && ++reads === 2) {
        // Model suspension during the initial state read, before a new network deadline.
        clock += 120_000;
        onStorageRead = null;
      }
    };
    const first = refreshAllShipments("interface5", { backgroundHostSafe: true });
    const firstResult = first.then(() => null, (error) => error);
    await firstEntered;
    const secondRuntime = await import("../services/sync.ts?second-runtime");
    const skipped = await secondRuntime.refreshAllShipments("interface5", { backgroundHostSafe: true });
    assert.equal(skipped.skipReason, "active_cross_runtime_refresh");
    assert.equal(skipped.attempted, 0);
    const blocked = readDiagnostics().find(entry => entry.event === "refresh.skipped" &&
      entry.details.result === "active_cross_runtime_refresh")!.details;
    assert.equal(blocked.trigger, "background");
    assert.equal(blocked.blockingTrigger, "background");
    assert.equal(blocked.blockingLeaseAgeMs, 120_000);
    assert.equal(blocked.blockingLeaseRemainingMs, 5_000);
    assert.ok(readDiagnostics().some(entry => entry.event === "refresh.started" &&
      entry.details.flowId === blocked.blockingFlowId));
    assert.equal("token" in blocked, false);
    clock += 6_000;
    accountReply = async () => jsonResponse({ code: 0, data: { expressList: [] } });
    await secondRuntime.refreshAllShipments("interface5", { backgroundHostSafe: true });
    const afterSecond = loadState(clock);
    releaseFirst(jsonResponse({ code: 0, data: { expressList: [{
      mailNo: "ZTSTALE5901", cpCode: "ZTO", name: "Synthetic carrier",
      provider: "CaiNiao", phone: PHONE, stateNum: 104,
      details: [{ time: providerTime(clock - 1_000), desc: "Synthetic late event" }],
    }] } }));
    const firstError = await firstResult;
    assert.ok(firstError, "the expired first runtime must reject its late account result");
    assert.deepEqual(loadState(clock).shipments, afterSecond.shipments,
      "a runtime that lost persistent ownership must not publish a late account commit");
  } finally {
    Date.now = realNow;
    accountReply = null;
    onStorageRead = null;
  }
}
console.log("cross-runtime full refresh fencing tests passed");

// Re-entry in the same runtime must retire a suspended round before reusing its promise.
{
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  let releaseFirst: ((response: ReturnType<typeof jsonResponse>) => void) | undefined;
  let firstResult: Promise<unknown> | undefined;
  try {
    storage.delete("pipi_deliveries_refresh_runtime_v1");
    saveState(state([]), clock);
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
    accountReply = () => {
      enteredFirst();
      return new Promise(resolve => { releaseFirst = resolve; });
    };
    const first = refreshAllShipments("interface5");
    firstResult = first.then(() => null, error => error);
    await firstEntered;
    clock += 126_000;
    let replacementCalls = 0;
    accountReply = async () => {
      replacementCalls++;
      return jsonResponse({ code: 0, data: { expressList: [] } });
    };
    const second = refreshAllShipments("interface5");
    const secondResult = second.then(value => value, error => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      secondResult,
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 100); }),
    ]);
    clearTimeout(timer);
    assert.ok(outcome && !(outcome instanceof Error), "same-runtime refresh must not await an expired round");
    assert.equal(replacementCalls, 1);
    assert.ok(await firstResult instanceof Error, "old waiters must settle even if the provider ignores cancellation");
    const afterSecond = loadState(clock);
    releaseFirst!(jsonResponse({ code: 0, data: { expressList: [{
      mailNo: "ZTSTALE5901", cpCode: "ZTO", name: "Synthetic carrier", provider: "CaiNiao",
      phone: PHONE, stateNum: 104, details: [{ time: providerTime(clock), desc: "Synthetic late event" }],
    }] } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(loadState(clock), afterSecond, "late work cannot alter the replacement's durable state");
  } finally {
    releaseFirst?.(jsonResponse({ code: 0, data: { expressList: [] } }));
    await firstResult;
    Date.now = realNow;
    accountReply = null;
  }
}

// The real full-refresh path must recover a list-stage event after a later stage times out.
{
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    storage.delete("pipi_deliveries_refresh_runtime_v1");
    const manual = cachedShipment(clock);
    manual.identity = { ...manual.identity, id: "interface5:manual:SFTEST0001", sourceId: "SFTEST0001",
      manuallyAdded: true, sourceProvider: "", courierCode: "SF", rawCourierCode: "SF" };
    manual.timeline = { ...manual.timeline, provider: "v6_query", waybill: "SFTEST0001", courierCode: "SF" };
    manual.sourceTimeline = null; manual.manualTimelines = [manual.timeline]; manual.accountRecord = null;
    const initial = saveState(state([cachedShipment(clock), manual]), clock);
    notificationAttempts = 0;
    accountReply = async () => jsonResponse({ code: 0, data: { expressList: [{
      mailNo: WAYBILL, cpCode: "ZTO", name: "中通快递", provider: "CaiNiao",
      phone: PHONE, stateNum: 104,
      details: [{ time: providerTime(clock - 1_000), desc: "Synthetic newer account event" }],
    }] } });
    pickerReply = () => {
      assert.ok(loadState(clock).pendingNotifications?.length,
        "the account-list checkpoint stores its event before the next request");
      clock += 31_000;
      return jsonResponse({ code: 200, value: null });
    };
    await assert.rejects(refreshAllShipments("interface5", {
      budgetMs: 30_000, accountOrderProjection: false,
    }), /请求超时/);
    assert.equal(notificationAttempts, 0);
    assert.ok(loadState(clock).revision > initial.revision);
    assert.equal(loadState(clock).pendingNotifications?.length, 1);
    pickerReply = null;
    accountReply = async () => jsonResponse({ code: 0, data: { expressList: [] } });
    rejectNotification = true;
    const restarted = await import("../services/sync.ts?notification-restart");
    await restarted.refreshAllShipments("interface5", { backgroundHostSafe: true });
    assert.ok(notificationAttempts > 0);
    assert.equal(loadState(clock).pendingNotifications?.length, 1,
      "a failed host schedule remains durable even after another successful account round");
    rejectNotification = false;
    const anotherRuntime = await import("../services/sync.ts?notification-retry");
    const beforeSuccess = notificationAttempts;
    await anotherRuntime.refreshAllShipments("interface5", { backgroundHostSafe: true });
    assert.equal(notificationAttempts, beforeSuccess + 1);
    assert.deepEqual(loadState(clock).pendingNotifications, []);
    await anotherRuntime.refreshAllShipments("interface5", { backgroundHostSafe: true });
    assert.equal(notificationAttempts, beforeSuccess + 1);
  } finally {
    Date.now = realNow;
    accountReply = null;
    beforeDetailReply = null;
    pickerReply = null;
    rejectNotification = false;
  }
}
console.log("full refresh timeout notification recovery tests passed");

// A full round publishes the final observation once, and never notifies a row first seen in that round.
{
  const now = Date.now();
  const eventTime = (at: number) => new Date(at + 8 * 60 * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const existingWaybill = "SFEXIST5901";
  const newWaybill = "SFNEW5902";
  const base = cachedShipment(now);
  const existing: Shipment = {
    ...base,
    identity: { ...base.identity, id: `interface5:account:${existingWaybill}`, sourceId: existingWaybill,
      courierCode: "SF", rawCourierCode: "SF", companyName: "顺丰速运", sourceProvider: "ShunFeng" },
    timeline: { ...base.timeline, waybill: existingWaybill, courierCode: "SF", companyName: "顺丰速运", semantic: "ORDERED" },
    sourceTimeline: undefined,
  };
  storage.delete("pipi_deliveries_refresh_runtime_v1");
  saveState(state([existing]), now);
  notificationAttempts = 0;
  notificationBodies.length = 0;
  accountReply = async () => jsonResponse({ code: 0, data: { expressList: [existingWaybill, newWaybill].map((waybill) => ({
    mailNo: waybill, cpCode: "SF", name: "顺丰速运", provider: "ShunFeng", phone: PHONE,
    stateNum: 104, details: [{ time: eventTime(now - 5_000), desc: `Synthetic feed ${waybill}` }],
  })) } });
  const published: AppState[] = [];
  const unsubscribe = subscribeRefreshState(state => published.push(state));
  let pickerCalls = 0;
  pickerReply = (waybill) => {
    assert.ok(published.some(state => state.shipments.length === 2), "the account batch is visible before Online finishes");
    pickerCalls++;
    return jsonResponse({ code: 200, value: JSON.stringify({
      nu: waybill, com: "SF", name: "顺丰速运", state: "3",
      time: eventTime(now), context: `Synthetic final ${waybill}`,
    }) });
  };
  try {
    const summary = await refreshAllShipments("interface5", { budgetMs: 30_000, forceManualRefresh: true });
    assert.equal(pickerCalls, 2, "both the existing and newly discovered rows reached the later Picker checkpoint");
    assert.equal(summary.state.shipments.length, 2);
    assert.equal(notificationAttempts, 1, "only the pre-existing row gets one final notification for the round");
    assert.deepEqual(notificationBodies, [`Synthetic final ${existingWaybill}`]);
    assert.deepEqual(loadState().pendingNotifications, []);
    assert.equal(summary.accountListUpdated, true);

    saveState(state([existing]), now);
    pickerReply = () => jsonResponse({ code: 10000 });
    const partial = await refreshAllShipments("interface5", { budgetMs: 30_000, forceManualRefresh: true });
    assert.ok(partial.failed > 0, "Online failures remain in the refresh summary");
    assert.ok(partial.succeeded > 0);
    assert.equal(partial.accountListUpdated, true);
    assert.equal(loadState().shipments.length, 2, "the account list is durably saved despite Online failure");
    assert.equal(refreshSummaryToast(partial), "列表已更新");

    saveState(state([existing]), now);
    accountReply = null;
    accountListFailure = "timeout";
    pickerReply = (waybill) => jsonResponse({ code: 200, value: JSON.stringify({
      nu: waybill, com: "SF", name: "顺丰速运", state: "3",
      time: eventTime(now), context: "Synthetic individual update after list failure",
    }) });
    const failedList = await refreshAllShipments("interface5", { budgetMs: 30_000, forceManualRefresh: true });
    assert.ok(failedList.failed > 0 && failedList.succeeded > 0);
    assert.equal(failedList.accountListUpdated, false);
    assert.notEqual(refreshSummaryToast(failedList), "列表已更新");
  } finally {
    unsubscribe();
    accountReply = null;
    pickerReply = null;
  }
}
console.log("full refresh notification baseline and aggregation tests passed");

// Binding refresh reuses account discovery without querying unrelated manual/SF parcels.
storage.delete("pipi_deliveries_refresh_runtime_v1");
accountReply = async () => jsonResponse({ code: 0, data: { expressList: [] } });
pickerReply = () => { assert.fail("binding refresh must not request Online"); };
try {
  const summary = await refreshAllShipments("interface5", { accountListOnly: true });
  assert.equal(summary.attempted, 1); assert.equal(summary.succeeded, 1);
} finally { accountReply = null; pickerReply = null; }

// Exercise the restored Home account-batch projection through the public refresh entry.
{
  const {fullRefreshHostPolicy} = await import("../services/refresh-mode");
  assert.equal(fullRefreshHostPolicy({accountOrderProjection: true, backgroundHostSafe: false}).accountOrderProjection, true);
  assert.equal(fullRefreshHostPolicy({accountOrderProjection: true, backgroundHostSafe: true}).accountOrderProjection, false);
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const previousWebView = globalRecord.WebViewController;
  let captures = 0;
  const realWaybill = "75600000001844";
  globalRecord.WebViewController = class {
    constructor() { captures++; }
    async loadURL() { return true; }
    async evaluateJavaScript() {
      return {waybillCode: realWaybill, companyName: "中通快递", extractionSource: "probe",
        traceList: [{time: providerTime(Date.now() - 1_000), desc: "已揽收"},
          {time: providerTime(Date.now() - 2_000), desc: "正在打包"}]};
    }
    dispose() {}
  };
  let sequence = 0;
  try {
    for (const background of [false, true]) {
      for (const detail of ["已揽收", "已下单", "正在打包", "等待揽收", "预计明天送达",
        `待出库交付中通快递，运单号为 ${realWaybill}`]) {
        storage.delete("pipi_deliveries_refresh_runtime_v1");
        saveState(state([]));
        captures = 0;
        fetchStages.length = 0;
        const order = `361000000000${String(++sequence).padStart(4, "0")}`;
        const hasTextIdentity = detail.includes("运单号为");
        accountReply = async () => jsonResponse({code: 0, data: {expressList: [{
          mailNo: order, cpCode: "JDKD", name: "京东购物", provider: "JingDong", phone: PHONE,
          stateNum: 102, details: [{time: providerTime(Date.now() - 5_000), desc: detail}],
          jumpList: [{type: "h5", link: "https://u.jd.com/forward?synthetic=home"}],
        }]}});
        pickerReply = () => { assert.fail("identity extraction must not query Online history"); };
        const expectedCaptures = !background && detail === "已揽收" ? 1 : 0;
        const expectedWaybill = hasTextIdentity || expectedCaptures ? realWaybill : "";
        for (let round = 0; round < 2; round++) {
          const summary = await refreshAllShipments("interface5", {accountOrderProjection: true, backgroundHostSafe: background});
          assert.equal(summary.accountListUpdated, true);
          assert.equal(summary.state.shipments.length, 1);
          assert.equal(summary.state.shipments[0].identity.projectedWaybill || "", expectedWaybill,
            `Home identity: background=${background}, detail=${detail}, round=${round}`);
          assert.equal(captures, expectedCaptures, "resolved and unpicked orders must not reopen H5");
          assert.equal(fetchStages.includes("account_detail"), false, "Home identity does not fetch per-parcel v5 history");
          if (!expectedCaptures) assert.equal(summary.state.shipments[0].identity.orderProjectionRetry, undefined);
        }
      }
    }
  } finally {
    globalRecord.WebViewController = previousWebView;
    accountReply = null;
    pickerReply = null;
  }
}
console.log("restored Home identity pipeline and independent pickup/text gates passed");
