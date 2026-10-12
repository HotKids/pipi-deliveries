import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";
import { installLeaseRenewalTimers } from "./live-timers";

import type { Shipment } from "../models";
import { CarrierRecognitionBudget, recognizeNonSyncCarrier } from "../services/carrier-recognition";
// A namespace import, so the file still loads — and fails on its assertions — against sources without the new export.
import * as recognition from "../services/carrier-recognition";
import { saveGatewayToken } from "../services/credentials";
import { OperationTimeoutError } from "../services/deadline";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { emptyState, loadState, saveState } from "../services/storage";
import { refreshAllShipments } from "../services/sync";

// 用户 2026-09-27 第二轮清单：截断排后（「被截断的下一轮排到最后」，四端同一做法）。一轮同步里被 30 秒识别预算截断的
// 运单——到点被放弃的那一张，以及因预算用光没发请求的——记下规范化运单号，存盘跨次运行保留；下一轮同步里各识别调用
// 把它们排到最后，其余顺序照旧。顺利识别或进入终态后清掉。标记不计失败、不进终态。

const TRUNCATED_KEY = "pipi_deliveries_carrier_recognition_truncated_v1";
const CACHE_KEY = "pipi_deliveries_carrier_recognition_v1";
const PHONE = "13800002828";
const DAY = 86400000;
let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
process.on("exit", () => { Date.now = realNow; });
// The slow recognizer below waits in a live runtime: the lease its refresh holds keeps renewing (用户 2026-09-28).
const leaseRenewingWait = installLeaseRenewalTimers({ now: () => clock, set: (value) => { clock = value; } });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(value).digest("hex"),
  }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
Object.assign(globalThis, {
  Notification: { schedule: async () => {} },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    async loadURL() { return true; }
    async evaluateJavaScript() { return { extractionSource: "probe", traceList: [] }; }
    dispose() {}
  },
});
registerProjectionViewportHost({ mount: async () => false, unmount: () => {} });

const asked: string[] = [];
let listRecords: unknown[] = [];
/** Waybills whose next free recognition takes 31 seconds of the fake clock and ends as a timeout. */
const slowOnce = new Set<string>();
globalThis.fetch = (async (url: string) => {
  const { hostname, pathname, searchParams } = new URL(url);
  if (hostname === "www.kuaidi100.com" && pathname === "/autonumber/autoComNum") {
    const waybill = searchParams.get("text") || "";
    asked.push(waybill);
    if (slowOnce.delete(waybill)) {
      await leaseRenewingWait(31_000);
      throw Object.assign(new Error("Synthetic timeout"), { name: "TimeoutError" });
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ auto: [{ comCode: "jtexpress", name: "极兔速递" }] }) };
  }
  if (pathname === "/api/express/accounts/sync") {
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: listRecords } }) };
  }
  return { ok: false, status: 503, text: async () => "Synthetic offline" };
}) as typeof fetch;

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

function reset(rows: Shipment[] = []): void {
  clock = NOW;
  memory.clear();
  asked.length = 0;
  listRecords = [];
  slowOnce.clear();
  saveState({
    ...emptyState(),
    shipments: rows,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - DAY }],
    feedSlotRebuiltAtMs: NOW - DAY,
  }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
}

function stored<T>(key: string): T[] {
  const raw = Storage.get<string>(key, { shared: true });
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? parsed : [];
}
const truncated = () => stored<{ waybill: string }>(TRUNCATED_KEY).map((mark) => mark.waybill);
/** Each mark's class as stored: "cut" (in flight when the limit hit) or "skipped" (not asked). */
const kinds = () => Object.fromEntries(stored<{ waybill: string; kind?: string }>(TRUNCATED_KEY)
  .map((mark) => [mark.waybill, mark.kind]));
/** A request that never answers; it ends when its signal is aborted. */
const hanging = async (_waybill: string, request?: { signal?: AbortSignal }) => new Promise<typeof jt>((_, reject) =>
  request?.signal?.addEventListener("abort", () =>
    reject(Object.assign(new Error("Synthetic abort"), { name: "AbortError" })), { once: true }));
const entries = () => stored<{ waybill: string; state: string; networkFailures: number }>(CACHE_KEY);
const timeout = (error: unknown) => error instanceof OperationTimeoutError;
const jt = [{ courierCode: "jtexpress", companyName: "极兔速递" }];

/** A round's budget with nothing left: the waybill is not asked. */
const spentRound = () => new CarrierRecognitionBudget(0, { syncRound: true });
/** A user operation's budget with nothing left. */
const spentOperation = () => new CarrierRecognitionBudget(0);

// 1. 记下、存盘、不计失败：预算用光没发请求的，与到点被放弃的那一张，都记下规范化运单号；识别记录里什么都不写。
{
  reset();
  let detects = 0;
  await assert.rejects(recognizeNonSyncCarrier(" jt4006839600001 ", {
    budget: spentRound(), detect: async () => { detects++; return jt; },
  }), timeout);
  assert.equal(detects, 0, "a spent budget sends no request");
  assert.deepEqual(truncated(), ["JT4006839600001"], "the waybill is kept, normalised, in shared storage");
  assert.deepEqual(entries(), [], "no failure count and no terminal verdict");

  let signal: AbortSignal | undefined;
  await assert.rejects(recognizeNonSyncCarrier("JT4006839600002", {
    budget: new CarrierRecognitionBudget(40, { syncRound: true }),
    detect: async (_waybill, request) => {
      signal = request?.signal;
      return new Promise<typeof jt>((_, reject) => request?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("Synthetic abort"), { name: "AbortError" })), { once: true }));
    },
  }), timeout);
  assert.equal(signal?.aborted, true, "the request in flight when the budget ends is cancelled");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([...truncated()].sort(), ["JT4006839600001", "JT4006839600002"]);
  assert.deepEqual(entries(), [], "the abandoned request records no failure and no terminal verdict either");

  // A network failure is neither a recognition nor a terminal verdict: the mark stays.
  await recognizeNonSyncCarrier("JT4006839600002", { detect: async () => { throw new Error("offline"); } });
  assert.equal(entries()[0]?.networkFailures, 1);
  assert.ok(truncated().includes("JT4006839600002"));

  // Recognised: the mark goes.
  await recognizeNonSyncCarrier("JT4006839600001", { detect: async () => jt });
  assert.deepEqual(truncated(), ["JT4006839600002"], "a recognised waybill is no longer put last");

  // A terminal verdict (paid stage names no carrier): the mark goes too.
  clock = NOW + 16 * 60000;
  await recognizeNonSyncCarrier("JT4006839600002", { detect: async () => [], classify: async () => null });
  assert.equal(entries().find((entry) => entry.waybill === "JT4006839600002")?.state, "terminal");
  assert.deepEqual(truncated(), [], "a terminal waybill is no longer put last");
}

// 2. 下一轮账号列表落库前的逐件识别：上一轮被截断的排到最后，其余照列表顺序；识别出来后标记清掉。
{
  reset();
  const waybills = ["JT4006839600011", "JT4006839600012", "JT4006839600013", "JT4006839600014"];
  for (const waybill of [waybills[0], waybills[2]]) {
    await assert.rejects(recognizeNonSyncCarrier(waybill, { budget: spentRound() }), timeout);
  }
  assert.deepEqual([...truncated()].sort(), [waybills[0], waybills[2]]);
  listRecords = waybills.map((waybill) => ({
    mailNo: waybill, provider: "JingDong", cpCode: "JDKD", name: "京东快递", phone: PHONE, stateNum: 104,
    details: [{ time: providerTime(NOW - 3600000), desc: "快件已到达【杭州转运中心】" }],
  }));
  await refreshAllShipments();
  assert.deepEqual(asked, [waybills[1], waybills[3], waybills[0], waybills[2]],
    "the truncated waybills are asked last, each group in its own order");
  assert.deepEqual(truncated(), [], "recognised this round: nothing is put last any more");
  const rows = loadState().shipments;
  assert.deepEqual(waybills.map((waybill) =>
    rows.find((row) => row.identity.sourceId === waybill)?.identity.companyName), waybills.map(() => "极兔速递"));
}

// 3. 下一轮手动件的补识别：被截断的那一件排到最后，哪怕它本来最先轮到。
{
  const manual = (waybill: string, attemptAtMs: number): Shipment => {
    const at = NOW - DAY;
    const detail = "快件已到达【杭州转运中心】";
    const timeline = { provider: "v6_query", waybill, courierCode: "", companyName: "", semantic: "TRANSIT" as const,
      structuredStatus: true, statusEventAtMs: at, latestTimeText: providerTime(at), latestDetail: detail,
      successAtMs: at, tracks: [{ timeMs: at, timeText: providerTime(at), detail, statusCode: "", raw: {} }] };
    return {
      identity: { id: `interface5:manual:${waybill}`, bindingSource: "interface5", sourceOwner: "manual",
        sourceId: waybill, phoneTail: "2828", courierCode: "", companyName: "", manuallyAdded: true,
        createdAtMs: NOW - 2 * DAY },
      timeline, sourceTimeline: null, manualTimelines: [timeline], updatedAtMs: at,
      manualRefreshAttemptAtMs: attemptAtMs,
    };
  };
  const older = "MANUAL00000000281", newer = "MANUAL00000000282";
  reset([manual(older, NOW - 2 * 3600000), manual(newer, NOW - 3600000)]);
  await assert.rejects(recognizeNonSyncCarrier(older, { budget: spentRound() }), timeout);
  await refreshAllShipments(undefined, { forceManualRefresh: true });
  assert.deepEqual(asked, [newer, older], "the oldest row would go first, but it was truncated last round");
  assert.deepEqual(truncated(), []);
}

// 4. 排序只挪位置、不丢不添：每一件都还在，被截断的在后，两组各自保持原顺序；没有标记时原样。
{
  reset();
  const order = recognition.truncatedCarrierRecognitionLast;
  const items = ["A0000000041", "B0000000042", "C0000000043", "D0000000044", "E0000000045"];
  assert.deepEqual(order(items, (item: string) => [item]), items, "nothing truncated: the order is kept");
  for (const waybill of [items[1], items[3]]) {
    await assert.rejects(recognizeNonSyncCarrier(waybill, { budget: spentRound() }), timeout);
  }
  assert.deepEqual(order(items, (item: string) => [item.toLowerCase()]),
    [items[0], items[2], items[4], items[1], items[3]], "every item is kept; the truncated ones come last");
}

// 5. 同步轮里因为任何时限被截住的都记（截断排后细则，用户 2026-09-27 提交前核对答「这样做」；「不让一张卡住的运单每轮
//    拖住后面的」是助手提问时写的目的，不是用户原话）：外层截止时间已过没发请求的、等待被外层截止时间截住的都记，但这不
//    算用光预算；用户操作（不是同步轮的预算）照旧不记。都不计失败、不进终态。
{
  reset();
  const round = new CarrierRecognitionBudget(undefined, { syncRound: true });
  let detects = 0;
  await assert.rejects(recognizeNonSyncCarrier("JT4006839600051", {
    budget: round, deadlineAtMs: clock - 1, detect: async () => { detects++; return jt; },
  }), timeout);
  assert.equal(detects, 0);
  assert.deepEqual(truncated(), ["JT4006839600051"], "past the round's outer deadline: not asked, put last");
  await assert.rejects(recognizeNonSyncCarrier("JT4006839600052", {
    budget: round, deadlineAtMs: clock + 30,
    detect: async (_waybill, request) => new Promise<typeof jt>((_, reject) =>
      request?.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("Synthetic abort"), { name: "AbortError" })), { once: true })),
  }), timeout);
  assert.deepEqual([...truncated()].sort(), ["JT4006839600051", "JT4006839600052"],
    "the wait the round's outer deadline ended is put last too");
  assert.equal(round.spent(), false, "the outer deadline is not the budget");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(entries(), []);

  const operation = new CarrierRecognitionBudget();
  await assert.rejects(recognizeNonSyncCarrier("JT4006839600053", {
    budget: operation, deadlineAtMs: clock - 1, detect: async () => jt,
  }), timeout);
  await assert.rejects(recognizeNonSyncCarrier("JT4006839600054", { budget: spentOperation() }), timeout);
  assert.ok(!truncated().includes("JT4006839600053") && !truncated().includes("JT4006839600054"),
    "a user operation's time limits mark nothing");
}

// 6. 端到端：列表阶段被 25 秒列表截止时间截住——等满的那一张与之后没来得及问的——下一轮都排到最后。
{
  reset();
  const waybills = ["JT4006839600061", "JT4006839600062", "JT4006839600063", "JT4006839600064"];
  const record = (waybill: string) => ({
    mailNo: waybill, provider: "JingDong", cpCode: "JDKD", name: "京东快递", phone: PHONE, stateNum: 104,
    details: [{ time: providerTime(NOW - 3600000), desc: "快件已到达【杭州转运中心】" }],
  });
  // Round 1: the first waybill is answered, the second takes 31 seconds (past the list's 25), the third is never asked.
  slowOnce.add(waybills[1]);
  listRecords = waybills.slice(0, 3).map(record);
  await refreshAllShipments();
  assert.deepEqual(asked, [waybills[0], waybills[1]]);
  assert.deepEqual([...truncated()].sort(), [waybills[1], waybills[2]],
    "cut off by the list's own deadline: both go last next round");
  assert.deepEqual(entries().map((entry) => entry.waybill), [waybills[0]], "no failure is recorded for them");

  // Round 2: the new waybill first, then the one not asked, last the one cut off in flight (第 7 段的两类排序，
  // 截断排后细则，用户 2026-09-27 提交前核对答「这样做」；此前这里期望两张被截断的按列表原顺序).
  clock += 16 * 60000;
  asked.length = 0;
  listRecords = [waybills[1], waybills[2], waybills[3]].map(record);
  await refreshAllShipments();
  assert.deepEqual(asked, [waybills[3], waybills[2], waybills[1]]);
  assert.deepEqual(truncated(), []);
}

// 7. 两类分开排（与 Pipi、Lite 同一语义）：没来得及问的在前，时限到时正在请求的那一张最后，两组内部照原顺序。同一张
//    再次被截断时按那一轮的类别改写；同一轮里既被截在途又没问到，算被截在途。没有类别的旧标记按「没来得及问」读。
{
  reset();
  const [cutOne, skippedOne, plain] = ["JT4006839600071", "JT4006839600072", "JT4006839600073"];
  const firstRound = new CarrierRecognitionBudget(undefined, { syncRound: true });
  await assert.rejects(recognizeNonSyncCarrier(cutOne, {
    budget: firstRound, deadlineAtMs: clock + 30, detect: hanging,
  }), timeout);
  await assert.rejects(recognizeNonSyncCarrier(skippedOne, { budget: spentRound() }), timeout);
  assert.deepEqual(kinds(), { [cutOne]: "cut", [skippedOne]: "skipped" });
  // Later in the same round the waybill cut in flight is not asked again: it stays the one that hung.
  await assert.rejects(recognizeNonSyncCarrier(cutOne, { budget: firstRound, deadlineAtMs: clock - 1 }), timeout);
  assert.equal(kinds()[cutOne], "cut");
  const order = recognition.truncatedCarrierRecognitionLast;
  assert.deepEqual(order([cutOne, skippedOne, plain], (item: string) => [item]), [plain, skippedOne, cutOne],
    "not truncated, then not asked, then the one cut off in flight");

  // A later round's truncation replaces the class.
  await assert.rejects(recognizeNonSyncCarrier(cutOne, { budget: spentRound() }), timeout);
  await assert.rejects(recognizeNonSyncCarrier(skippedOne, {
    budget: new CarrierRecognitionBudget(undefined, { syncRound: true }), deadlineAtMs: clock + 30, detect: hanging,
  }), timeout);
  assert.deepEqual(kinds(), { [cutOne]: "skipped", [skippedOne]: "cut" });
  assert.deepEqual(order([cutOne, skippedOne, plain], (item: string) => [item]), [plain, cutOne, skippedOne]);

  // A mark stored before classes existed reads as not asked.
  Storage.set(TRUNCATED_KEY, JSON.stringify([
    { waybill: cutOne, truncatedAtMs: NOW, kind: "cut" },
    { waybill: skippedOne, truncatedAtMs: NOW },
  ]), { shared: true });
  assert.deepEqual(order([cutOne, skippedOne, plain], (item: string) => [item]), [plain, skippedOne, cutOne]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(entries(), [], "classes are marks, never failures");
}

// 8. 端到端：列表 [A, B, C]，A 每一轮都卡住。第一轮 A 等满被列表截止时间截住、B 与 C 没来得及问；下一轮先问 B、C（识别
//    出来），A 仍排最后——卡住的那一张不再每轮拖住后面的。
{
  reset();
  const [a, b, c] = ["JT4006839600081", "JT4006839600082", "JT4006839600083"];
  const record = (waybill: string) => ({
    mailNo: waybill, provider: "JingDong", cpCode: "JDKD", name: "京东快递", phone: PHONE, stateNum: 104,
    details: [{ time: providerTime(NOW - 3600000), desc: "快件已到达【杭州转运中心】" }],
  });
  listRecords = [a, b, c].map(record);
  slowOnce.add(a);
  await refreshAllShipments();
  assert.deepEqual(asked, [a], "round 1: A hangs until the list's deadline; B and C are never asked");
  assert.deepEqual(kinds(), { [a]: "cut", [b]: "skipped", [c]: "skipped" });

  clock += 16 * 60000;
  asked.length = 0;
  slowOnce.add(a);
  await refreshAllShipments();
  assert.deepEqual(asked, [b, c, a], "round 2: B and C are asked first, A last");
  const rows = loadState().shipments;
  assert.deepEqual([b, c].map((waybill) =>
    rows.find((row) => row.identity.sourceId === waybill)?.identity.companyName), ["极兔速递", "极兔速递"]);
  assert.deepEqual(kinds(), { [a]: "cut" }, "B and C are recognised; A, cut again, stays last");
  assert.equal(entries().some((entry) => entry.waybill === a), false, "A's hang is no failure");
}

console.log("carrier recognition truncated-last tests passed");
