import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";
import { installLeaseRenewalTimers } from "./live-timers";

import type { Shipment } from "../models";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import {
  recognizeNonSyncCarrier,
  type CarrierRecognitionEntry,
  type CarrierRecognitionStore,
} from "../services/carrier-recognition";
import { carrierAwaitingRecognition } from "../services/carrier-gate";
import { saveGatewayToken } from "../services/credentials";
import { OperationTimeoutError } from "../services/deadline";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { applyAccountShipment } from "../services/shipment-policy";
import { emptyState, loadState, saveState } from "../services/storage";
import { refreshAllShipments, runShipmentRefreshForTesting } from "../services/sync";

// 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒（「Lite、iOS 也对齐到每轮 30 秒」）。一轮同步里账号列表落库前的
// 逐件识别、已投影订单的补识别、手动件的补识别共用一份 30 秒；超出的运单留到下一轮，照样压着通知（T23），不计失败、
// 不进终态。不在同步轮里的一次用户操作（打开详情 / 下拉）各自一份。
// 时间用假钟：快递100 免费识别的替身在「慢」的时候把钟拨快 31 秒再以超时结束（与真机上请求等满后被放弃一样，不写记录）。

const PHONE = "13800002727";
const DAY = 86400000;
const MINUTE = 60000;
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
const scheduled: Array<{ title: string; body: string }> = [];
let captures = 0;
Object.assign(globalThis, {
  Notification: { schedule: async (request: { title: string; body: string }) => { scheduled.push(request); } },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    constructor() { captures++; }
    async loadURL() { return true; }
    async evaluateJavaScript() { return { extractionSource: "probe", traceList: [] }; }
    dispose() {}
  },
});
registerProjectionViewportHost({ mount: async () => false, unmount: () => {} });

type Answer = "slow" | Array<{ comCode: string; name: string }>;
/** Kuaidi100's free recognizer, per waybill: "slow" takes 31 seconds and ends as a timeout; absent answers 503. */
let answers = new Map<string, Answer[]>();
let listRecords: unknown[] = [];
const asked: string[] = [];
globalThis.fetch = (async (url: string) => {
  const { hostname, pathname, searchParams } = new URL(url);
  if (hostname === "www.kuaidi100.com" && pathname === "/autonumber/autoComNum") {
    const waybill = searchParams.get("text") || "";
    asked.push(waybill);
    const answer = answers.get(waybill)?.shift();
    if (answer === "slow") {
      await leaseRenewingWait(31_000);
      throw Object.assign(new Error("Synthetic timeout"), { name: "TimeoutError" });
    }
    return answer
      ? { ok: true, status: 200, text: async () => JSON.stringify({ auto: answer }) }
      : { ok: false, status: 503, text: async () => "Synthetic offline" };
  }
  if (pathname === "/api/express/accounts/sync") {
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: listRecords } }) };
  }
  return { ok: false, status: 503, text: async () => "Synthetic offline" };
}) as typeof fetch;

const providerTime = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

function seed(rows: Shipment[]): void {
  clock = NOW;
  memory.clear();
  scheduled.length = 0;
  captures = 0;
  asked.length = 0;
  answers = new Map();
  saveState({
    ...emptyState(),
    shipments: rows,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - DAY }],
    feedSlotRebuiltAtMs: NOW - DAY,
  }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
}

function rowFrom(record: unknown, at = NOW - 3600000): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [record] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], at)!, at);
}

function recognitionEntries(): CarrierRecognitionEntry[] {
  const raw = Storage.get<string>("pipi_deliveries_carrier_recognition_v1", { shared: true });
  return typeof raw === "string" ? JSON.parse(raw) : [];
}

/** 用户 2026-09-27 第二轮清单：截断排后——一轮预算截断的运单记在识别记录旁边。 */
function truncatedWaybills(): string[] {
  const raw = Storage.get<string>("pipi_deliveries_carrier_recognition_truncated_v1", { shared: true });
  const marks = typeof raw === "string" ? JSON.parse(raw) : [];
  return Array.isArray(marks) ? marks.map((mark: { waybill: string }) => mark.waybill) : [];
}

const titles = () => scheduled.map((request) => request.title);
const stored = (id: string) => loadState().shipments.find((shipment) => shipment.identity.id === id)!;
const jt = [{ comCode: "jtexpress", name: "极兔速递" }];
const zto = [{ comCode: "zhongtong", name: "中通快递" }];

function manualRow(waybill: string): Shipment {
  const at = NOW - DAY;
  const detail = "快件已到达【杭州转运中心】";
  const timeline = { provider: "v6_query", waybill, courierCode: "", companyName: "", semantic: "TRANSIT" as const,
    structuredStatus: true, statusEventAtMs: at, latestTimeText: providerTime(at), latestDetail: detail,
    successAtMs: at, tracks: [{ timeMs: at, timeText: providerTime(at), detail, statusCode: "", raw: {} }] };
  return {
    identity: { id: `interface5:manual:${waybill}`, bindingSource: "interface5", sourceOwner: "manual",
      sourceId: waybill, phoneTail: "2727", courierCode: "", companyName: "", manuallyAdded: true,
      createdAtMs: NOW - 2 * DAY },
    timeline, sourceTimeline: null, manualTimelines: [timeline], updatedAtMs: at,
  };
}

// 1. 一轮同步共用一份 30 秒：列表落库前第一张就等满了，同一轮里其余账号件与手动件都不再发识别请求；它们照样压着
//    （承运商空白、通知挂起），没有失败次数、没有终态。下一轮换一份新的 30 秒，识别出来再放行通知。
{
  const waybills = ["JT4006839590001", "JT4006839590002", "JT4006839590003"];
  const record = (waybill: string, stateNum: number, at: number, desc: string) => ({
    mailNo: waybill, provider: "JingDong", cpCode: "JDKD", name: "京东快递", phone: PHONE, stateNum,
    details: [{ time: providerTime(at), desc }],
  });
  const manualWaybill = "MANUAL00000000094";
  seed([
    ...waybills.map((waybill) => rowFrom(record(waybill, 104, NOW - DAY, "快件已到达【杭州转运中心】"), NOW - DAY)),
    manualRow(manualWaybill),
  ]);
  listRecords = waybills.map((waybill) => record(waybill, 105, NOW - 3600000, "【上海市】快件正在派送中"));
  answers.set(waybills[0], ["slow"]);
  answers.set(waybills[1], [jt]);
  answers.set(waybills[2], [jt]);
  answers.set(manualWaybill, [zto]);
  await refreshAllShipments(undefined, { forceManualRefresh: true });
  assert.deepEqual(asked, [waybills[0]],
    "the first waybill used the round's 30 seconds; nothing else in the round is asked");
  assert.deepEqual(recognitionEntries(), [], "no failure count and no terminal verdict are recorded");
  for (const waybill of waybills) {
    const row = loadState().shipments.find((shipment) => shipment.identity.sourceId === waybill)!;
    assert.equal(row.identity.companyName, "", `${waybill} stays without a carrier until a later round`);
    assert.equal(carrierAwaitingRecognition(row), true);
  }
  assert.equal(stored(`interface5:manual:${manualWaybill}`).identity.companyName, "",
    "the manual row's recognition in the same round waits for the next round too");
  assert.ok(truncatedWaybills().includes(manualWaybill),
    "截断排后: the waybill the round's spent budget did not ask goes last next round");
  assert.deepEqual(titles(), [], "no blank-carrier notification goes out");
  assert.ok((loadState().pendingNotifications || []).length > 0, "the round's changes are held");
  assert.ok((loadState().pendingNotifications || []).every((event) => event.awaitingCarrier === true));

  // The next round has a fresh budget: every waybill is asked, the carriers match and the held changes go out.
  clock = NOW + 16 * MINUTE;
  asked.length = 0;
  answers.set(waybills[0], [jt]);
  await refreshAllShipments(undefined, { forceManualRefresh: true });
  assert.deepEqual([...asked].sort(), [...waybills, manualWaybill].sort());
  for (const waybill of waybills) {
    const row = loadState().shipments.find((shipment) => shipment.identity.sourceId === waybill)!;
    assert.equal(row.identity.companyName, "极兔速递");
  }
  assert.equal(stored(`interface5:manual:${manualWaybill}`).identity.companyName, "中通快递");
  assert.deepEqual([...titles()].sort(), waybills.map((waybill) => `极兔速递 ${waybill.slice(-4)} · 派送中`).sort(),
    "the held notifications are released with their carriers");
  assert.ok(!truncatedWaybills().includes(manualWaybill), "recognised: no longer put last");
}

// 2. 一次详情操作一份 30 秒：订单文案给的运单号在打开详情时识别，第一次就等满了；同一次操作里（入口查询、身份投影与
//    其中的文案投影）不再为它发请求，订单保持原样。下一次操作再识别出来才投影。
{
  const order = "3610000000000271", waybill = "75600000000271";
  const text = `您的订单由第三方卖家拣货完成，待出库交付中通快递，运单号为 ${waybill}`;
  const record = { mailNo: order, provider: "JingDong", cpCode: "JDKD", name: "京东商品快递", phone: PHONE,
    stateNum: 103, details: [{ time: providerTime(NOW - 3600000), desc: text }] };
  const id = `interface5:account:${order}`;
  const runtime = { refreshAccountParcel: async () => null };
  seed([rowFrom(record)]);
  answers.set(waybill, ["slow", zto]);
  await runShipmentRefreshForTesting(id, { isCurrent: () => true }, { trigger: "detail_open" }, runtime);
  assert.deepEqual(asked, [waybill], "one operation, one budget: the waybill is not asked again in it");
  assert.equal(stored(id).identity.projectedWaybill, "", "the order stays as it was");
  assert.equal(stored(id).identity.companyName, "京东购物");
  assert.deepEqual(recognitionEntries(), []);
  assert.equal(captures, 0, "the feed text needs no union page");

  clock = NOW + MINUTE;
  await runShipmentRefreshForTesting(id, { isCurrent: () => true }, { trigger: "detail_open" }, runtime);
  assert.deepEqual(asked, [waybill, waybill]);
  assert.equal(stored(id).identity.projectedWaybill, waybill);
  assert.equal(stored(id).identity.companyName, "中通快递");
}

// 3. 不在任何一轮或操作里的单次识别（手动加件输入框）自己一份 30 秒，不再是原来的 45 秒。
{
  let entries: readonly CarrierRecognitionEntry[] = [];
  const store: CarrierRecognitionStore = { load: () => entries, save: (value) => { entries = value; } };
  clock = NOW;
  const takes = (ms: number) => async () => {
    clock += ms;
    return [{ courierCode: "jtexpress", companyName: "极兔速递" }];
  };
  await assert.rejects(recognizeNonSyncCarrier("JT4006839590031", { store, detect: takes(31_000) }),
    (error: unknown) => error instanceof OperationTimeoutError);
  const answered = await recognizeNonSyncCarrier("JT4006839590032", { store, detect: takes(29_000) });
  assert.equal(answered.normalization?.standardCode, "JTSD");
}

console.log("carrier recognition round budget tests passed");
