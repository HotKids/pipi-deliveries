import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { commitRefreshState, emptyState, loadState, saveState } from "../services/storage";
import { refreshAllShipments } from "../services/sync";
import { parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { activateCainiaoManualFallback, applyAccountShipment, FORCED_COMPLETION_REFRESH_WINDOW_MS,
  selectShipmentDetailTimeline, shipmentDetailComplete } from "../services/shipment-policy";
import { saveGatewayToken } from "../services/credentials";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { acquireDurableRefreshLease } from "../services/refresh-runtime-state";
import { OperationTimeoutError } from "../services/deadline";

const NOW = Date.UTC(2026, 8, 12, 6), PHONE = "13800000000";
const OLD = "2026-09-12 08:00:00", NEW = "2026-09-12 10:00:00";
const realNow = Date.now;
let clock = NOW;
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({ toHexString: () => createHmac("sha256", key).update(value).digest("hex") }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined }, Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class { constructor() { assert.fail("full-refresh supplements never open WebView"); } },
});
const json = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const row = (mailNo: string, provider = "CaiNiao", stateNum = 104, at = OLD) => ({
  mailNo, provider, cpCode: provider === "ShunFeng" ? "SF" : "YTO", name: "Synthetic carrier", phone: PHONE,
  stateNum, details: [{ time: at, desc: provider === "CaiNiao" ? "快递状态已更新，点击查看>>" : "在途源事件" }],
});
type Row = ReturnType<typeof row>;
type Options = Parameters<typeof refreshAllShipments>[1];

function seed(records: Row[]) {
  clock = NOW;
  memory.clear();
  setDiagnosticsEnabled(true);
  const parsed = parseAccountSyncResult("interface5", { code: 0, data: { expressList: records } });
  const shipments = parsed.parcels.map(parcel => applyAccountShipment(undefined,
    parcelToShipment(parcel, [PHONE], NOW - 3600000)!, NOW - 3600000));
  saveState({ ...emptyState(), shipments,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }],
    feedSlotRebuiltAtMs: NOW - 86400000 }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
}

async function round(records: Row[], options: Options, failQuery = false, expireAfterList = false) {
  const query: string[] = [], online: string[] = [];
  let lists = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "Synthetic offline authority" };
    if (path === "/api/express/accounts/sync") {
      lists++;
      if (expireAfterList) clock += 28_000;
      return json({ code: 0, data: { expressList: records } });
    }
    assert.equal(path, "/api/express/timeline/source");
    const request = JSON.parse(String(init.body));
    if (request.interface === "v6") {
      assert.equal(request.mode, "refresh");
      assert.ok(request.waybill.startsWith("SF"), "JD/Cainiao cannot enter Online");
      online.push(request.waybill);
      return json({ code: 200, value: { nu: request.waybill, com: "SF", name: "顺丰速运",
        logisticsStatus: "TRANSPORT", time: NEW, context: "Online 当前事件" } });
    }
    assert.equal(request.interface, "v5");
    assert.equal(request.mode, "detail");
    const record = records.find(value => value.mailNo === request.record.waybill)!;
    assert.equal(record?.provider, "CaiNiao", "JD full refresh remains list-only");
    query.push(record.mailNo);
    if (failQuery) return { ok: false, status: 503, text: async () => "Synthetic unavailable" };
    return json({ code: 0, data: { ...record, details: [
      { time: record.details[0].time, desc: "query 实际物流事件" }, { time: "2026-09-12 07:00:00", desc: "已揽收" },
    ] } });
  }) as typeof fetch;
  const summary = await refreshAllShipments("interface5", options);
  assert.equal(lists, 1);
  return { query: query.sort(), online: online.sort(), summary };
}

test("Home pull waits for the other runtime and then executes one real list refresh", async () => {
  seed([]);
  const background = acquireDurableRefreshLease("full:interface5", 125000, clock,
    { flowId: "synthetic-background", trigger: "background" })!;
  assert.ok(background);
  const release = setTimeout(() => background.release(), 20);
  try {
    const options = { forceManualRefresh: true, accountOrderProjection: false };
    const running = round([], options);
    const joined = refreshAllShipments("interface5", options);
    assert.equal(refreshAllShipments("interface5", options), joined, "repeated pulls share the pending wait");
    const [result, repeated] = await Promise.all([running, joined]);
    assert.equal(repeated, result.summary);
    assert.equal(result.summary.skipReason, undefined);
    assert.equal(result.summary.succeeded, 1);
  } finally { clearTimeout(release); background.release(); }
});

test("Home pull resumes after an abandoned foreign lease expires", async () => {
  seed([]);
  const abandoned = acquireDurableRefreshLease("full:interface5", 1000, clock,
    { flowId: "synthetic-abandoned", trigger: "list_pull" })!;
  const advance = setTimeout(() => { clock += 1001; }, 20);
  try {
    const result = await round([], { forceManualRefresh: true, accountOrderProjection: false });
    assert.equal(result.summary.succeeded, 1);
    assert.equal(abandoned.isCurrent(), false);
  } finally { clearTimeout(advance); abandoned.release(); }
});

test("an expired waiting pull cannot acquire a lease or start a late request", async () => {
  seed([]);
  const holder = acquireDurableRefreshLease("full:interface5", 125000, clock)!;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return json({}); }) as typeof fetch;
  const advance = setTimeout(() => { clock += 1001; }, 20);
  try {
    await assert.rejects(refreshAllShipments("interface5", { forceManualRefresh: true, budgetMs: 1000 }),
      OperationTimeoutError);
    assert.equal(requests, 0);
    assert.equal(holder.isCurrent(), true, "a live holder must not be evicted");
  } finally { clearTimeout(advance); holder.release(); }
  const retry = await round([], { forceManualRefresh: true, accountOrderProjection: false });
  assert.equal(retry.summary.succeeded, 1, "failed wait does not poison the next pull");
});

test("a pull following an in-process background run executes once without a self-wait", async () => {
  seed([]);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let lists = 0;
  globalThis.fetch = (async (url: string) => {
    if (new URL(url).pathname === "/api/express/carriers") return { ok: false, status: 503, text: async () => "offline" };
    assert.equal(new URL(url).pathname, "/api/express/accounts/sync");
    lists++;
    if (lists === 1) await gate;
    return json({ code: 0, data: { expressList: [] } });
  }) as typeof fetch;
  const background = refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 30000 });
  const options = { forceManualRefresh: true, accountOrderProjection: false };
  const pull = refreshAllShipments("interface5", options);
  assert.equal(refreshAllShipments("interface5", options), pull);
  release();
  const results = await Promise.all([background, pull]);
  assert.equal(lists, 2);
  assert.ok(results.every(result => result.succeeded === 1 && !result.skipReason));
});

for (const [entry, options] of [
  ["Home", { forceManualRefresh: true, accountSourceFollowup: true, accountOrderProjection: false }],
  ["startup/resume", { accountOrderProjection: false }],
  ["background", { backgroundHostSafe: true, accountOrderProjection: true, budgetMs: 30_000 }],
  ["widget/intent", { backgroundHostSafe: true, accountOrderProjection: true, budgetMs: 120_000 }],
] as const) {
  test(`${entry}: changed/new Cainiao only, JD list-only, SF Online, unchanged list no query`, async () => {
    const original = [row("CNOLD001"), row("CNOLD002"), row("JDSYNTH001", "JingDong"), row("SFSYNTH001", "ShunFeng")];
    seed(original);
    const records = [row("CNOLD001", "CaiNiao", 105, NEW), original[1], original[2], original[3], row("CNNEW003")];
    const first = await round(records, options);
    assert.deepEqual(first.query, ["CNNEW003", "CNOLD001"]);
    assert.deepEqual(first.online, ["SFSYNTH001"]);
    assert.equal(first.summary.failed, 0);
    const accountStage = readDiagnostics().find(value => value.event === "refresh.stage.started" &&
      value.details.requestProvider === "v5_query");
    assert.equal(accountStage?.details.trigger, entry === "Home" ? "list_pull"
      : entry === "startup/resume" ? "foreground" : "background");
    assert.equal(loadState(clock).shipments.find(value => value.identity.sourceId === "CNOLD001")?.timeline.latestDetail,
      "query 实际物流事件");
    const repeat = await round(records, options);
    assert.deepEqual(repeat.query, []);
    assert.deepEqual(repeat.online, entry === "Home" ? ["SFSYNTH001"] : [], "scheduled Online retains cooldown");
    const events = readDiagnostics().filter(value => value.event.startsWith("refresh.stage.") &&
      ["manual_refresh", "account_detail"].includes(String(value.details.stage)));
    for (const event of events) {
      assert.ok(event.details.waybillTail, `${event.event} must identify its parcel`);
      assert.ok(event.details.carrierCode, `${event.event} must identify its carrier`);
      assert.ok(event.details.displayTimelineProvider, `${event.event} must identify the displayed history separately`);
      assert.ok(event.details.requestProvider, `${event.event} must separate the requested source`);
      if (event.event === "refresh.stage.succeeded") {
        assert.equal(event.details.selectionScope, "query_response");
        assert.equal(event.details.timelineProvider, event.details.requestProvider);
      }
    }
    const responses = readDiagnostics().filter(value => value.event === "manual.meizu.response");
    assert.ok(responses.length);
    assert.ok(responses.every(value => value.details.waybillTail === "H001" && value.details.carrierCode === "SF"));
  });
}

test("background query failure persists the list baseline and does not retry an identical signal", async () => {
  seed([row("CNFAIL001")]);
  await round([row("CNFAIL001", "CaiNiao", 104, "2026-09-12 09:00:00")],
    { backgroundHostSafe: true, budgetMs: 30_000 });
  const records = [row("CNFAIL001", "CaiNiao", 105, NEW)];
  const failed = await round(records, { backgroundHostSafe: true, budgetMs: 30_000 }, true);
  assert.deepEqual(failed.query, ["CNFAIL001"]);
  assert.equal(failed.summary.failed, 1);
  assert.equal(loadState(clock).shipments[0].sourceTimeline?.semantic, "DELIVERY");
  assert.equal(loadState(clock).shipments[0].timeline.latestTimeText, "2026-09-12 09:00:00",
    "a failed update preserves earlier real history with its own event time");
  assert.deepEqual((await round(records, { backgroundHostSafe: true, budgetMs: 30_000 })).query, []);
});

test("background honors forced/unchanged terminal freeze but hydrates a new completed list signal once", async () => {
  seed([row("CNFORCED01"), row("CNFORCED02"), row("CNSIGNED01", "CaiNiao", 107), row("CNFINISH01"),
    row("SFSIGNED01", "ShunFeng", 107)]);
  // 用户 2026-10-02「我已取件这种硬冻结 也要等三态都是签收才冻结」，弹窗「点击后满 3 天也冻结」「iOS 右滑签收一起改」：
  // 满 72 小时的右滑签收（CNFORCED01）硬冻结；刚签收、来源仍在途的（CNFORCED02）照常跟着列表更新查一次。CNFORCED01 的来源
  // 不是终态，列表新节点不把它当重用的新件接管（用户 2026-10-02「修，和 Pipi 一致」），闩锁留着。
  const forcedAt: Record<string, number> = { CNFORCED01: NOW - FORCED_COMPLETION_REFRESH_WINDOW_MS, CNFORCED02: NOW - 1000 };
  saveState({ ...loadState(clock), shipments: loadState(clock).shipments.map(value =>
    forcedAt[value.identity.sourceId] ? { ...value, forcedCompletedAtMs: forcedAt[value.identity.sourceId] } : value) },
    clock);
  const records = [row("CNFORCED01", "CaiNiao", 105, NEW), row("CNFORCED02", "CaiNiao", 105, NEW),
    row("CNSIGNED01", "CaiNiao", 107), row("CNFINISH01", "CaiNiao", 107, NEW), row("SFSIGNED01", "ShunFeng", 107)];
  const first = await round(records, { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.deepEqual(first.query, ["CNFINISH01", "CNFORCED02"]);
  assert.equal(loadState(clock).shipments.find(value => value.identity.sourceId === "CNFORCED01")?.forcedCompletedAtMs,
    NOW - FORCED_COMPLETION_REFRESH_WINDOW_MS);
  assert.deepEqual(first.online, []);
  assert.deepEqual((await round(records, { backgroundHostSafe: true, budgetMs: 30_000 })).query, []);
});

test("host budget rejects an over-budget list before launching supplements", async () => {
  seed([row("CNBUDGET01")]);
  const result = await round([row("CNBUDGET01", "CaiNiao", 105, NEW)],
    { backgroundHostSafe: true, budgetMs: 30_000 }, false, true);
  assert.deepEqual(result.query, []);
  assert.equal(result.summary.accountListUpdated, false);
  assert.equal(result.summary.failed, 1);
});

test("real full refresh keeps an activated Cainiao history when list returns the same summary", async () => {
  const records = [row("JT0000000000162")];
  records[0].cpCode = "HTKY";
  seed(records);
  const base = loadState(clock);
  const current = base.shipments[0];
  const latestAt = new Date("2026-09-12T08:00:00+08:00").getTime();
  const history = { ...current.sourceTimeline!, provider: "v4_query", tracks: [
    { timeText: OLD, timeMs: latestAt, detail: "Synthetic transit", statusCode: "TRANSIT", raw: {} },
    { timeText: "2026-09-12 07:00:00", timeMs: latestAt - 3600000, detail: "Synthetic pickup", statusCode: "PICKED", raw: {} },
  ] };
  const activated = activateCainiaoManualFallback({ ...current, manualTimelines: [history],
    detailSelection: { provider: "v4_query", selectedAtMs: NOW },
  }, NOW);
  saveState({ ...base, shipments: [activated] }, clock);
  assert.equal(shipmentDetailComplete(loadState(clock).shipments[0]), true);
  const result = await round(records, { backgroundHostSafe: true, budgetMs: 30_000 });
  assert.deepEqual(result.query, []);
  assert.deepEqual(result.online, []);
  const persisted = loadState(clock).shipments[0];
  assert.equal(persisted.cainiaoH5FallbackActivatedAtMs, NOW);
  assert.equal(selectShipmentDetailTimeline(persisted).provider, "v4_query");
  assert.deepEqual(selectShipmentDetailTimeline(persisted).tracks, history.tracks);
  assert.equal(shipmentDetailComplete(persisted), true);
});

test("a full refresh appends its complete JD diagnostic batch with one log write", async () => {
  const records = Array.from({ length: 30 }, (_, i) => row(`JDBATCH${1000 + i}`, "JingDong"));
  seed(records);
  const originalSet = Storage.set;
  let batchWrites = 0;
  Storage.set = (key, value, ...options) => {
    if (key === "pipi_deliveries_diagnostic_log_v1" &&
        Array.isArray(value) && value.at(-1)?.event === "account.list.record") batchWrites++;
    return originalSet(key, value, ...options);
  };
  try {
    await round(records, { backgroundHostSafe: true, budgetMs: 30_000 });
  } finally { Storage.set = originalSet; }
  const entries = readDiagnostics().filter(entry => entry.event === "account.list.record");
  assert.equal(entries.length, records.length, "batching must preserve every parcel record");
  assert.equal(new Set(entries.map(entry => entry.details.ownerFingerprint)).size, records.length);
  assert.ok(entries.every(entry => entry.details.trigger === "background"));
  assert.equal(batchWrites, 1, "one synchronous list batch must not rewrite the log for every row");
});

test("full refresh traces preparation, account request and one notification drain after account work", async () => {
  seed([]);
  await round([], { backgroundHostSafe: true, budgetMs: 30_000 });
  const entries = readDiagnostics().reverse();
  const events = entries.map(entry => entry.event);
  const ordered = ["refresh.preparation.started", "refresh.preparation.completed", "account.sync.started",
    "account.sync.parsed", "refresh.account.completed", "refresh.finalization.started",
    "notification.replay.started", "notification.replay.completed", "refresh.finalization.completed",
    "refresh.succeeded"];
  for (let i = 0; i < ordered.length; i++) {
    assert.ok(events.includes(ordered[i]), `${ordered[i]} must be observable`);
    if (i) assert.ok(events.indexOf(ordered[i - 1]) < events.indexOf(ordered[i]));
  }
  assert.equal(events.filter(event => event === "notification.replay.started").length, 1);
  for (const event of ["refresh.preparation.completed", "refresh.account.completed",
    "notification.replay.completed", "refresh.finalization.completed"]) {
    assert.equal(typeof entries.find(entry => entry.event === event)?.details.durationMs, "number");
  }
  const replay = entries.find(entry => entry.event === "notification.replay.completed")!;
  assert.equal(replay.details.pendingNotifications, 0);
  assert.equal(replay.details.flowId, entries.find(entry => entry.event === "refresh.started")?.details.flowId);
});

for (const accountFailed of [false, true]) {
test(`a stalled notification preserves the ${accountFailed ? "failed" : "successful"} account result and releases ownership`, async () => {
  seed([row("JDNOTIFYBUDGET", "JingDong")]);
  const records = [row("JDNOTIFYBUDGET", "JingDong", 105, NEW)];
  const before = loadState(clock);
  const parsed = parseAccountSyncResult("interface5", { code: 0, data: { expressList: records } });
  const shipment = applyAccountShipment(before.shipments[0], parcelToShipment(parsed.parcels[0], [PHONE], clock)!, clock);
  commitRefreshState(before, { ...before, shipments: [shipment] }, "interface5", clock);
  assert.equal(loadState(clock).pendingNotifications?.length, 1);
  let listFinished = false, schedules = 0;
  const originalSchedule = Notification.schedule;
  Notification.schedule = () => {
    assert.equal(listFinished, true, "old notifications cannot delay this round's account request");
    schedules++;
    return new Promise(() => {});
  };
  globalThis.fetch = (async () => {
    clock += 6_000; listFinished = true;
    if (accountFailed) return { ok: false, status: 502, text: async () => "Synthetic upstream failure" };
    return json({ code: 0, data: { expressList: records } });
  }) as typeof fetch;
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set<{ at: number; callback: () => void }>();
  let pumping = false;
  function pump() {
    if (pumping) return;
    pumping = true;
    setImmediate(() => {
      pumping = false;
      const next = [...timers].sort((a, b) => a.at - b.at)[0];
      if (!next) return;
      timers.delete(next); clock = Math.max(clock, next.at); next.callback();
      if (timers.size) pump();
    });
  }
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    const timer = { at: clock + ms, callback };
    timers.add(timer); pump(); return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: { at: number; callback: () => void }) => timers.delete(timer)) as unknown as typeof clearTimeout;
  try {
    const summary = await refreshAllShipments("interface5", { backgroundHostSafe: true, budgetMs: 10_000 });
    assert.equal(summary.failed, accountFailed ? 1 : 0);
    assert.equal(summary.succeeded, accountFailed ? 0 : 1);
    assert.equal(clock, NOW + 7_000, "notification waits leave the existing three-second finalization reserve");
    assert.equal(schedules, 1);
    assert.equal(summary.state.pendingNotifications?.length, 1);
    assert.equal(loadState(clock).pendingNotifications?.length, 1);
    assert.equal(readDiagnostics().find(entry => entry.event === "notification.replay.completed")?.details.result,
      "budget_exhausted");
    const nextOwner = acquireDurableRefreshLease("full:interface5", 1_000, clock);
    assert.ok(nextOwner, "notification timeout must not strand the full-refresh lease");
    nextOwner.release();
  } finally {
    timers.clear(); Notification.schedule = originalSchedule;
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
  }
});
}
