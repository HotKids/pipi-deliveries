import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory, NOW } from "./state-storage-mock";

import type { Shipment, TimelinePackage } from "../models";
import { parseAccountSyncResponse, parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { saveGatewayToken } from "../services/credentials";
import { setDiagnosticsEnabled } from "../services/logger";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { applyAccountShipment } from "../services/shipment-policy";
import { emptyState, loadState, saveState, visibleShipments } from "../services/storage";
import { refreshAllShipments } from "../services/sync";
import { parcelSupersedes, WAYBILL_REUSE_MIN_GAP_MS } from "../services/waybill-reuse";

// 承运商复用旧运单号（用户 2026-10-01/02，四端）：「C 新件优先（含 A）」「至少晚 24 小时」「当新件初次出现，不通知」，细节
// 「全部按推荐」。旧件已签收（或已取消），新件最早一条有时间的节点不早于旧件终态 24 小时 ⇒ 新件当初次出现拿走这一行：旧件的
// 轨迹、手动包、签收时钟、备注、手动签收、粘性选包与这个号码的承运商识别都清掉，这一轮不通知；之后新件的状态变化照常通知。
// 京东业务来源排除；列表同时带着新旧两条时新的胜出、旧的不再写入。合成的运单号与手机号。

const PHONE = "13800002626";
const DAY = 86400000;
const HOUR = 3600000;
const SIGNED = NOW - 5 * DAY;
const RECOGNITION_KEY = "pipi_deliveries_carrier_recognition_v1";

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
const scheduled: Array<{ title: string; body: string }> = [];
Object.assign(globalThis, {
  Notification: { schedule: async (request: { title: string; body: string }) => { scheduled.push(request); } },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class {
    async loadURL() { return true; }
    async evaluateJavaScript() { return { extractionSource: "probe", traceList: [] }; }
    dispose() {}
  },
});
registerProjectionViewportHost({ mount: async () => false, unmount: () => {} });

const providerTime = (at: number) =>
  new Date(at + 8 * HOUR).toISOString().slice(0, 19).replace("T", " ");
const record = (waybill: string, stateNum: number, details: readonly { at: number; desc: string }[],
  provider = "CaiNiao") => ({
  mailNo: waybill, provider, cpCode: provider === "JingDong" ? "JD" : "YTO",
  name: provider === "JingDong" ? "京东快递" : "圆通速递", phone: PHONE, stateNum,
  details: details.map(({ at, desc }) => ({ time: providerTime(at), desc })),
});
const oldSigned = (waybill: string, provider = "CaiNiao") => record(waybill, 107, [
  { at: SIGNED, desc: "已签收 synthetic old parcel" },
  { at: SIGNED - DAY, desc: "运输中 synthetic old parcel" },
], provider);
const newPicked = (waybill: string, at: number, provider = "CaiNiao") =>
  record(waybill, 103, [{ at, desc: "已揽收 synthetic new parcel" }], provider);

function row(input: unknown, at = SIGNED + HOUR): Shipment {
  const parcel = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [input] } })[0]!;
  return applyAccountShipment(undefined, parcelToShipment(parcel, [PHONE], at)!, at);
}

function k100(waybill: string): TimelinePackage {
  return {
    provider: "k100_h5", complete: true, structuredStatus: false, waybill, courierCode: "YTO", companyName: "圆通速递",
    semantic: "COMPLETED", statusEventAtMs: SIGNED, latestTimeText: providerTime(SIGNED),
    latestDetail: "已签收 synthetic manual package",
    tracks: [
      { timeText: providerTime(SIGNED), timeMs: SIGNED, detail: "已签收 synthetic manual package", statusCode: "", raw: {} },
      { timeText: providerTime(SIGNED - 2 * DAY), timeMs: SIGNED - 2 * DAY, detail: "已揽收 synthetic manual package",
        statusCode: "", raw: {} },
    ],
    successAtMs: SIGNED + HOUR,
  };
}

function seed(rows: Shipment[]) {
  clock = NOW;
  memory.clear();
  scheduled.length = 0;
  setDiagnosticsEnabled(true);
  saveState({
    ...emptyState(),
    shipments: rows,
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 30 * DAY }],
    feedSlotRebuiltAtMs: NOW - DAY,
  }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
}

async function listRound(records: readonly unknown[], at: number) {
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path !== "/api/express/accounts/sync") {
      return { ok: false, status: 503, text: async () => "Synthetic offline" };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: records } }) };
  }) as typeof fetch;
  clock = at;
  await refreshAllShipments();
}

const byId = (id: string) => loadState().shipments.find((shipment) => shipment.identity.id === id);
const titles = () => scheduled.map((request) => request.title);

// The policy: earliest timed node against the terminal time, at least 24 hours, JD excluded, either list order.
{
  const parse = (records: unknown[]) => parseAccountSyncResult("interface5", { code: 0, data: { expressList: records } });
  const waybill = "YT8100000000001";
  const [older] = parse([oldSigned(waybill)]).parcels;
  const [later] = parse([newPicked(waybill, SIGNED + 25 * HOUR)]).parcels;
  const [early] = parse([newPicked(waybill, SIGNED + 23 * HOUR)]).parcels;
  assert.equal(WAYBILL_REUSE_MIN_GAP_MS, DAY);
  assert.equal(parcelSupersedes(older!, later!, NOW), true);
  assert.equal(parcelSupersedes(older!, early!, NOW), false, "23 hours is not a reuse");
  assert.equal(parcelSupersedes(later!, older!, NOW), false);
  const withHistory = parse([record(waybill, 105, [
    { at: SIGNED + 3 * DAY, desc: "派送中 synthetic" }, { at: SIGNED - DAY, desc: "运输中 synthetic old parcel" },
  ])]).parcels[0]!;
  assert.equal(parcelSupersedes(older!, withHistory, NOW), false, "its earliest node is the old parcel's history");
  const untimed = parse([{ mailNo: waybill, provider: "CaiNiao", cpCode: "YTO", name: "圆通速递", phone: PHONE,
    stateNum: 103, details: [] }]).parcels[0]!;
  assert.equal(parcelSupersedes(older!, untimed, NOW), false, "a record with no time is never judged reused");
  // Status time at the signing, a later node of the same parcel 10 hours on: the terminal time is that later node.
  const laterNode = {
    ...older!,
    normalizedStatus: { version: 1 as const, scope: "SHIPMENT" as const, semantic: "COMPLETED" as const, code: "SIGNED",
      text: "已签收", priority: 0, eventAtMs: SIGNED, structured: true },
    tracks: [
      { timeText: providerTime(SIGNED + 10 * HOUR), detail: "签收后的补充说明 synthetic", statusCode: "" },
      ...older!.tracks,
    ],
  };
  assert.equal(parcelSupersedes(laterNode, later!, NOW), false,
    "the terminal time is the latest of status, shown and node times");
  assert.equal(parse([oldSigned(waybill), newPicked(waybill, SIGNED + 2 * DAY)]).parcels[0]!.semantic, "PICKED");
  assert.equal(parse([newPicked(waybill, SIGNED + 2 * DAY), oldSigned(waybill)]).parcels[0]!.semantic, "PICKED");
  assert.equal(parse([oldSigned(waybill), newPicked(waybill, SIGNED + 2 * DAY)]).parcels.length, 1);
  const jd = "JDV810000000002";
  assert.equal(parse([oldSigned(jd, "JingDong"), newPicked(jd, SIGNED + 2 * DAY, "JingDong")]).parcels[0]!.semantic,
    "COMPLETED", "JD business sources keep their first record");
}

// A new parcel a day and an hour after the signing takes the row silently, with nothing of the old parcel.
{
  const waybill = "YT8100000000003";
  const id = `interface5:account:${waybill}`;
  const old = row(oldSigned(waybill));
  seed([{
    ...old,
    note: "synthetic note",
    forcedCompletedAtMs: SIGNED + HOUR,
    detailSelection: { provider: "k100_h5", selectedAtMs: SIGNED + HOUR },
    manualTimelines: [...(old.manualTimelines || []), k100(waybill)],
    settledAtMs: SIGNED,
  }]);
  assert.equal(byId(id)!.timeline.semantic, "COMPLETED");
  memory.set(RECOGNITION_KEY, JSON.stringify([{ waybill, state: "resolved", networkFailures: 0, retryAfterMs: 0,
    updatedAtMs: SIGNED, normalization: { standardCode: "YTO", displayName: "圆通速递", kuaidi100Code: "yuantong",
      isBuiltIn: true, tableVersion: "synthetic" } }]));
  const arrived = SIGNED + DAY + HOUR;
  await listRound([newPicked(waybill, arrived)], NOW);
  const taken = byId(id)!;
  assert.equal(taken.timeline.semantic, "PICKED");
  assert.equal(taken.timeline.latestDetail, "已揽收 synthetic new parcel");
  assert.equal(taken.timeline.tracks.some((track) => track.detail.includes("old parcel")), false,
    "the timeline is the new parcel's only");
  assert.equal((taken.manualTimelines || []).length, 0, "the old manual packages are gone");
  assert.equal(taken.note, undefined, "the note is cleared");
  assert.equal(taken.forcedCompletedAtMs, undefined, "the manual sign-off is cleared");
  assert.equal(taken.detailSelection, undefined, "the remembered detail selection is cleared");
  assert.equal(taken.settledAtMs, undefined, "the old settled clock is not carried");
  assert.ok(Number(taken.waybillReuseAtMs) > 0);
  assert.deepEqual(titles(), [], "the takeover is a first sighting");
  assert.deepEqual(loadState().pendingNotifications || [], []);
  const recognition = JSON.parse(String(memory.get(RECOGNITION_KEY) || "[]")) as Array<{ waybill: string }>;
  assert.equal(recognition.some((entry) => entry.waybill === waybill), false, "carrier recognition is forgotten");
  assert.equal(visibleShipments(loadState()).length, 1);

  // The old record still listed after the takeover is ignored, in either order, and the row never flips.
  await listRound([oldSigned(waybill), newPicked(waybill, arrived)], NOW + 60_000);
  await listRound([newPicked(waybill, arrived), oldSigned(waybill)], NOW + 120_000);
  await listRound([oldSigned(waybill)], NOW + 180_000);
  assert.equal(byId(id)!.timeline.semantic, "PICKED");
  assert.deepEqual(titles(), []);

  // The new parcel's next status change notifies as usual.
  await listRound([record(waybill, 105, [
    { at: NOW + HOUR, desc: "派送中 synthetic new parcel" }, { at: arrived, desc: "已揽收 synthetic new parcel" },
  ])], NOW + 2 * HOUR);
  assert.deepEqual(titles(), ["圆通速递 0003 · 派送中"]);

  // Day 21 of the old signing removes nothing of the new parcel.
  clock = SIGNED + 21 * DAY + HOUR;
  saveState(loadState(clock), clock);
  assert.equal(byId(id)!.timeline.semantic, "DELIVERY");
}

// 23 hours after the signing is the same parcel: nothing changes.
{
  const waybill = "YT8100000000004";
  const id = `interface5:account:${waybill}`;
  seed([{ ...row(oldSigned(waybill)), note: "synthetic note" }]);
  await listRound([newPicked(waybill, SIGNED + 23 * HOUR)], NOW);
  assert.equal(byId(id)!.timeline.semantic, "COMPLETED");
  assert.equal(byId(id)!.note, "synthetic note");
  assert.equal(byId(id)!.waybillReuseAtMs, undefined);
  assert.deepEqual(titles(), []);
}

// JD business sources are never taken over.
{
  const waybill = "JDV810000000005";
  const id = `interface5:account:${waybill}`;
  seed([row(oldSigned(waybill, "JingDong"))]);
  await listRound([newPicked(waybill, SIGNED + 3 * DAY, "JingDong")], NOW);
  assert.equal(byId(id)!.timeline.semantic, "COMPLETED");
  assert.equal(byId(id)!.waybillReuseAtMs, undefined);
}

// A JD order projected onto the number makes it a JD purchase's waybill: the existing rules stay.
{
  const waybill = "YT8100000000010";
  const id = `interface5:account:${waybill}`;
  const order = row({ mailNo: "3630448013820010", provider: "JingDong", cpCode: "JDKD", name: "京东商品快递",
    phone: PHONE, stateNum: 104, details: [{ time: providerTime(SIGNED - DAY), desc: "您的订单已出库" }] });
  assert.equal(order.identity.accountOrder, true);
  seed([row(oldSigned(waybill)), {
    ...order, identity: { ...order.identity, projectedWaybill: waybill, sourceProvider: "JingDong" },
  }]);
  await listRound([newPicked(waybill, SIGNED + 2 * DAY)], NOW);
  assert.equal(byId(id)!.timeline.semantic, "COMPLETED");
  assert.equal(byId(id)!.waybillReuseAtMs, undefined);
}

// Both list orders keep the new record on the first round too.
for (const order of ["old-first", "new-first"] as const) {
  const waybill = order === "old-first" ? "YT8100000000006" : "YT8100000000007";
  const id = `interface5:account:${waybill}`;
  seed([row(oldSigned(waybill))]);
  const both = [oldSigned(waybill), newPicked(waybill, SIGNED + 2 * DAY)];
  await listRound(order === "old-first" ? both : [...both].reverse(), NOW);
  assert.equal(byId(id)!.timeline.semantic, "PICKED", order);
  assert.deepEqual(titles(), [], order);
}

// Only a structured terminal permits destructive reuse; prose keeps the ordinary manual history and note.
for (const structuredStatus of [false, true]) {
  const waybill = "YT8100000000008";
  const manualPackage = { ...k100(waybill), structuredStatus };
  const manual: Shipment = {
    identity: {
      id: `interface5:manual:${waybill}`, bindingSource: "interface5", sourceOwner: "manual", sourceId: waybill,
      phoneTail: PHONE.slice(-4), courierCode: "YTO", companyName: "圆通速递", manuallyAdded: true,
      createdAtMs: SIGNED - 3 * DAY,
    },
    timeline: manualPackage,
    sourceTimeline: null,
    manualTimelines: [manualPackage],
    note: "synthetic manual note",
    updatedAtMs: SIGNED + HOUR,
  };
  seed([manual]);
  await listRound([newPicked(waybill, SIGNED + 2 * DAY)], NOW);
  const shipments = loadState().shipments;
  assert.equal(shipments.some((shipment) => shipment.identity.manuallyAdded), false, "the manual row is gone");
  const automatic = byId(`interface5:account:${waybill}`)!;
  assert.equal(automatic.timeline.semantic, "PICKED");
  assert.equal((automatic.manualTimelines || []).length, structuredStatus ? 0 : 1,
    "only a structured terminal authorizes removing the old manual timeline");
  assert.equal(automatic.note, structuredStatus ? undefined : manual.note);
  assert.deepEqual(titles(), []);
}

// A record with no time at all is never judged reused.
{
  const waybill = "YT8100000000009";
  const id = `interface5:account:${waybill}`;
  seed([row(oldSigned(waybill))]);
  await listRound([{ mailNo: waybill, provider: "CaiNiao", cpCode: "YTO", name: "圆通速递", phone: PHONE,
    stateNum: 103, details: [] }], NOW);
  assert.equal(byId(id)!.timeline.semantic, "COMPLETED");
  assert.equal(byId(id)!.waybillReuseAtMs, undefined);
}

// 右滑签收不是终态（用户 2026-10-02「修，和 Pipi 一致」）：来源只报过一条「快递状态已更新」占位（不算事件，展示里没有带日期的
// 节点）、仍在途的菜鸟行，
// 用户右滑签收两天后列表来了一条新节点——旧实现把签收闩锁（点击时间）当成旧件的终态时间，超过 24 小时就当重用整行接管、
// 清掉闩锁；来源自己不是终态，就不是重用对象，闩锁留着。
{
  const waybill = "YT8100000000011";
  const id = `interface5:account:${waybill}`;
  const placeholder = row(record(waybill, 104, [{ at: NOW - 4 * DAY, desc: "快递状态已更新，点击查看>>" }]),
    NOW - 4 * DAY);
  const signedOffAt = NOW - 2 * DAY;
  seed([{ ...placeholder, forcedCompletedAtMs: signedOffAt }]);
  const before = byId(id)!;
  assert.equal(before.timeline.semantic, "COMPLETED", "shown signed");
  assert.equal(before.timeline.statusEventAtMs, signedOffAt, "the stored presentation carries the click time");
  assert.deepEqual([before.timeline.latestTimeText, before.timeline.tracks.length], ["", 0],
    "the placeholder is no event: the presentation has no dated node, only the latched status time");
  assert.equal(before.sourceTimeline!.semantic, "TRANSIT", "the source itself is not terminal");
  await listRound([record(waybill, 105, [{ at: NOW - HOUR, desc: "派送中 synthetic same parcel" }])], NOW);
  const after = byId(id)!;
  assert.equal(after.waybillReuseAtMs, undefined, "not taken over as a new parcel");
  assert.equal(after.forcedCompletedAtMs, signedOffAt, "the sign-off stays");
  assert.equal(after.timeline.semantic, "COMPLETED");
  assert.deepEqual(titles(), []);
}

// The control: a source that is terminal itself is still a reuse candidate, judged by its own terminal time — the later
// click neither blocks it (the old reading used the click as the terminal time and found less than 24 hours) nor counts.
{
  const waybill = "YT8100000000012";
  const id = `interface5:account:${waybill}`;
  seed([{ ...row(oldSigned(waybill)), forcedCompletedAtMs: NOW - 2 * HOUR }]);
  assert.equal(byId(id)!.timeline.statusEventAtMs, NOW - 2 * HOUR);
  await listRound([newPicked(waybill, NOW - HOUR)], NOW);
  const taken = byId(id)!;
  assert.ok(Number(taken.waybillReuseAtMs) > 0, "the new parcel takes the row");
  assert.equal(taken.forcedCompletedAtMs, undefined, "the old parcel's sign-off goes with it");
  assert.equal(taken.timeline.semantic, "PICKED");
  assert.deepEqual(titles(), []);
}

console.log("waybill reuse tests passed");
