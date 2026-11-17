import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import type { ParcelHandoffRecord, PickupCodeRecord, Shipment } from "../models";
import { activePickupCards, applyRecognizedPickup, handoffActivityContent, independentPickupContent, parcelActivityContent, type ParcelActivityContent } from "../services/parcel-pickup";
import { recognizeParcelCodes } from "../services/parcel-code-ocr";
import { parcelTextRows, recognizeParcelWaybill } from "../services/parcel-waybill-ocr";

const number = "TEST81234567";
assert.equal(recognizeParcelWaybill("订单编号：TEST91234567 复制\n运单号：" + number), number);
assert.equal(recognizeParcelWaybill("顺丰速运 " + number + " | 物流电话"), number);
assert.equal(recognizeParcelWaybill(number + "\n复制"), number);
assert.equal(recognizeParcelWaybill(number), "");
assert.equal(recognizeParcelWaybill("快递单号：1" + "3" + "0".repeat(9)), "");
assert.equal(recognizeParcelWaybill("订单编号：" + number + "\n复制"), "");

const capture = Date.UTC(2026, 10, 16, 16, 30);
const parse = (value: string) => recognizeParcelCodes(parcelTextRows(value), capture);
const both = parse("测试驿站 测试店\n运单号：" + number + " 取件码 a1-0002");
assert.equal(both.lookup?.waybill, number);
assert.deepEqual(both.lookup?.pickup, { code: "A1-0002", locationName: "测试驿站 测试店" });
for (const [brand, platform] of [["菜鸟驿站", "cainiao"], ["多多驿站", "pinduoduo"], ["丰巢", "fengchao"]]) {
  const parsed = parse(brand + "\n取件码：\nABC123");
  assert.equal(parsed.lookup, undefined);
  assert.equal(parsed.independent?.kind, "pickup");
  assert.equal(parsed.independent?.platform, platform);
  assert.equal(parsed.independent?.code, "ABC123");
}
assert.deepEqual(parse("菜鸟驿站\n丰巢\n取件码 6821"), {});
assert.deepEqual(parse("菜鸟驿站\n运单号 TEST81234567\n运单号 TEST91234567\n取件码 6821"), {});
assert.deepEqual(parse("菜鸟驿站 运单号 TEST81234567 运单号 TEST91234567 取件码 6821"), {});
assert.equal(parse("运单号：" + number + "\n取件码 6821\n取件码 9326").lookup?.pickup, undefined);

const handoffParsed = parse("菜鸟\n待上门取件\n明天09:00–10:00上门取件\n寄件码\n9326");
assert.deepEqual(handoffParsed.independent, {
  kind: "handoff", platform: "cainiao", code: "9326", capturedAtMs: capture,
  windowText: "09:00–10:00", windowStartAtMs: Date.UTC(2026, 10, 18, 1), windowEndAtMs: Date.UTC(2026, 10, 18, 2),
});
const pdd = "退货详情\n待快递员取件\n取件码 6821\n请在快递员上门后出示";
const handoffAndWaybill = parse(pdd + "\n09:00–10:00上门取件\n运单号：" + number);
assert.equal(handoffAndWaybill.lookup?.waybill, number);
assert.equal(handoffAndWaybill.lookup?.pickup, undefined);
assert.deepEqual(handoffAndWaybill.independent, {
  kind: "handoff", platform: "pinduoduo", code: "6821", capturedAtMs: capture, windowText: "09:00–10:00",
});
assert.equal(parse(pdd + "\n取件码 9621").independent, undefined);
assert.equal(parse("待上门取件\n寄件码 9326").independent, undefined);

function row(text: string, left: number, top: number) {
  return { text, bounds: { left, top, right: left + 280, bottom: top + 28 } };
}
const stationRow = row("上海示例广场店", 150, 20);
const codeRow = row("5-2-1234", 160, 70);
const waybillRow = row("韵达快递 " + number, 165, 110);
const cards = recognizeParcelCodes([stationRow, codeRow, {
  text: "6666", bounds: { left: 10, top: 95, right: 80, bottom: 106 },
}, waybillRow], capture);
assert.deepEqual(cards.lookup?.pickup, { code: "5-2-1234", locationName: "上海示例广场店" });
assert.equal(recognizeParcelCodes([stationRow, row("10-02", 160, 70), waybillRow], capture).lookup?.pickup, undefined);
assert.equal(recognizeParcelCodes([stationRow, codeRow, row("快递单号 " + number, 165, 110)], capture).lookup?.pickup, undefined);

const parcel: Shipment = {
  identity: {
    id: "synthetic-parcel",
    bindingSource: null,
    sourceOwner: "synthetic",
    sourceId: number,
    phoneTail: "",
    courierCode: "sf",
    companyName: "顺丰速运",
    manuallyAdded: false,
    createdAtMs: 1,
  },
  timeline: {
    provider: "synthetic",
    waybill: number,
    courierCode: "sf",
    companyName: "顺丰速运",
    semantic: "WAITING_PICKUP",
    statusEventAtMs: 2,
    latestTimeText: "",
    latestDetail: "",
    tracks: [],
    successAtMs: 2,
  },
  updatedAtMs: 2,
};
const pickup = {
  platform: "cainiao" as const,
  waybill: number,
  waybillGeneration: 0,
  capturedAtMs: 2,
  code: "1-2-3456",
  locationName: "测试驿站",
};
const attached = applyRecognizedPickup(parcel, both.lookup!);
assert.equal(attached.pickup?.code, "A1-0002");
assert.equal(parcelActivityContent(attached)?.code, "A1-0002");
const newGeneration = { ...parcel, waybillReuseAtMs: capture + 1 };
assert.equal(applyRecognizedPickup(newGeneration, both.lookup!), newGeneration);
const mismatched = { ...both.lookup!, waybill: "TEST91234567" };
assert.equal(applyRecognizedPickup(parcel, mismatched), parcel);
assert.equal(parcelActivityContent(parcel), null);
assert.equal(parcelActivityContent({ ...parcel, pickup })?.code, pickup.code);
assert.equal(parcelActivityContent({ ...parcel, pickup })?.location, pickup.locationName);
assert.equal(parcelActivityContent({ ...parcel, pickup, waybillReuseAtMs: 3 }), null);
assert.equal(parcelActivityContent({ ...parcel, pickup: { ...pickup, waybill: "TEST91234567" } }), null);
assert.equal(parcelActivityContent({ ...parcel, pickup: { ...pickup, capturedAtMs: 0 } }), null);
assert.equal(parcelActivityContent({ ...parcel, pickup, forcedCompletedAtMs: 3 }), null);
assert.equal(parcelActivityContent({ ...parcel, pickup, timeline: { ...parcel.timeline, semantic: "COMPLETED" } }), null);


const appointmentStart = Date.UTC(2026, 10, 16, 7);
const appointmentEnd = appointmentStart + 2 * 60 * 60 * 1000;
const handoff: ParcelHandoffRecord = {
  id: "synthetic-handoff", kind: "handoff", platform: "cainiao", code: "9543",
  capturedAtMs: appointmentStart - 1, windowStartAtMs: appointmentStart, windowEndAtMs: appointmentEnd,
};
assert.equal(handoffActivityContent(handoff)?.location, "11-16 15:00–17:00 上门");
const overnightStart = Date.UTC(2026, 10, 16, 15);
const overnightEnd = overnightStart + 2 * 60 * 60 * 1000;
assert.equal(handoffActivityContent({ ...handoff, windowStartAtMs: overnightStart, windowEndAtMs: overnightEnd })
  ?.location, "11-16 23:00–11-17 01:00 上门");
const deadline = appointmentEnd + 3_600_000;
assert.equal(handoffActivityContent(handoff)?.expiresAtMs, deadline);
assert.equal(handoffActivityContent({ ...handoff, expiredAtMs: deadline }), null);
const timeOnly = handoffActivityContent({ ...handoff, windowEndAtMs: undefined, windowText: "15:00–17:00" });
assert.equal(timeOnly?.location, "15:00–17:00 上门");
assert.equal(timeOnly?.expiresAtMs, undefined);
assert.deepEqual(activePickupCards([parcel]), []);
assert.equal(activePickupCards([parcel], [handoff]).length, 1);
assert.equal(activePickupCards([parcel], [{ ...handoff, completedAtMs: appointmentStart }]).length, 0);
assert.equal(activePickupCards([parcel], [{
  kind: "pickup", id: "synthetic-station", platform: "cainiao", capturedAtMs: 2, code: "1-2-3456",
}])[0]?.title, "菜鸟驿站");

const service = ["parcel-activity-action", "parcel-live-activity"].map((name) =>
  stripTypeScriptTypes(readFileSync(new URL(`../services/${name}.ts`, import.meta.url), "utf8"), { mode: "transform" })
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, ""),
).join("\n");
const events: string[] = [];
let current: Shipment = { ...parcel, pickup };
let records: PickupCodeRecord[] = [];
const snapshot = () => ({ shipments: [current], pickupCodeRecords: records });
let stateReads = 0;
let loadFailed = false;
let session: unknown = null;
let activityId = "";
let linkId = "";
let nextId = 0;
let nextLink = 0;
let now = appointmentStart;
let staleDate: number | undefined;
let failEnd = false;
let capacity = Infinity;
const refused = new Set<string>();
const completions: string[] = [];
const native = new Map<string, ReturnType<typeof makeActivity>>();
const activeCodes = () => [...native.values()]
  .filter((item) => item.state === "active")
  .sort((left, right) => right.rank - left.rank)
  .map((item) => item.code);
function makeActivity() {
  const activity = {
    activityId: "synthetic-activity-" + ++nextId,
    state: "dismissed",
    rank: 0,
    code: "",
    start: async ({ code }: { code: string }, options?: { staleDate?: number; relevanceScore?: number }) => {
      if (activeCodes().length >= capacity || refused.has(code)) return false;
      events.push("start " + code);
      staleDate = options?.staleDate;
      activity.state = "active";
      activity.code = code;
      activity.rank = options?.relevanceScore ?? 0;
      activityId = activity.activityId;
      native.set(activityId, activity);
      return true;
    },
    update: async ({ code }: { code: string }, options?: { relevanceScore?: number }) => {
      events.push("update " + code);
      activity.code = code;
      activity.rank = options?.relevanceScore ?? 0;
      return true;
    },
    end: async () => {
      if (failEnd) return false;
      events.push("end");
      activity.state = "ended";
      return true;
    },
  };
  return activity;
}
const host = runInNewContext(service + "\n({ startParcelActivity, startAllParcelActivities, stopParcelActivity, reconcileParcelActivity, parcelActivityStatus, parcelActivityTarget, completeParcelActivity });", {
  Path: { join: (...parts: string[]) => parts.join("/") },
  Script: { directory: "/synthetic" },
  UUID: { string: () => { linkId = "synthetic-link-" + ++nextLink; return linkId; } },
  Date: { now: () => now },
  FileManager: {
    appGroupDocumentsDirectory: "/synthetic-shared",
    createDirectorySync: () => {},
    existsSync: () => true,
    isFileSync: () => true,
  },
  Storage: {
    get: () => session,
    set: (_key: string, value: unknown) => { session = value; return true; },
    remove: () => { session = null; },
  },
  LiveActivity: {
    areActivitiesEnabled: async () => true,
    getActivityState: async (id: string) => native.get(id)?.state ?? null,
    from: async (id: string) => native.get(id) ?? null,
  },
  PipiParcelActivity: makeActivity,
  PARCEL_ACTIVITY_ART: "art",
  parcelActivityContent,
  independentPickupContent,
  activePickupCards,
  parcelCardKey: ({ target }: Pick<ParcelActivityContent, "target">) => target
    ? "recordId" in target ? "record:" + target.recordId : JSON.stringify([target.shipmentId, target.waybill, target.waybillGeneration])
    : "",
  loadState: () => { stateReads++; return snapshot(); },
  stateLoadFailure: () => loadFailed,
  visibleShipments: (state: { shipments: Shipment[] }) => state.shipments,
  withSharedFileTransaction: (run: () => unknown) => run(),
  completeCurrentParcelCard: ({ target }: ParcelActivityContent) => {
    assert.ok(target);
    if ("recordId" in target) {
      completions.push(target.recordId);
      records = records.map((item) => item.id === target.recordId ? { ...item, completedAtMs: now } : item);
    } else {
      assert.equal(target.waybill, current.pickup?.waybill);
      assert.equal(target.waybillGeneration, current.waybillReuseAtMs ?? 0);
      completions.push(target.shipmentId);
      current = { ...current, forcedCompletedAtMs: now };
    }
  },
  writeDiagnostic: () => {},
});
const hasActivity = async () => (await host.parcelActivityStatus()).count > 0;
const target = parcelActivityContent(current)!.target;
await host.startParcelActivity(target);
session = (session as { receipts: unknown[] }).receipts[0];
assert.equal(host.parcelActivityTarget(snapshot(), linkId)?.shipmentId, parcel.identity.id);
host.reconcileParcelActivity(snapshot());
await hasActivity();
assert.deepEqual(events, ["start " + pickup.code], "an unrelated revision leaves the same activity in place");
current = { ...current, pickup: { ...pickup, code: "2-3-4567" } };
host.reconcileParcelActivity(snapshot());
assert.equal(await hasActivity(), true);
assert.deepEqual(events, ["start " + pickup.code, "update 2-3-4567"]);
assert.equal(stateReads, 1, "committed screen revisions do not re-read the saved state");
loadFailed = true;
host.reconcileParcelActivity(snapshot());
assert.equal(await hasActivity(), true, "an unreadable snapshot is not completion");
loadFailed = false;
current = { ...current, forcedCompletedAtMs: 3 };
host.reconcileParcelActivity(snapshot());
assert.equal(await hasActivity(), false);
assert.equal(events.at(-1), "end");
assert.equal(host.parcelActivityTarget(snapshot(), linkId), undefined);

current = { ...parcel, pickup };
await host.startParcelActivity(target);
native.get(activityId)!.state = "dismissed";
host.reconcileParcelActivity(snapshot());
assert.equal(await hasActivity(), false);
assert.equal(events.filter((event) => event.startsWith("start")).length, 2);

records = [handoff];
await host.startParcelActivity({ recordId: handoff.id });
assert.equal(host.parcelActivityTarget(snapshot(), linkId)?.recordId, handoff.id);
records = [{ ...handoff, completedAtMs: appointmentStart }];
host.reconcileParcelActivity(snapshot());
assert.equal(await hasActivity(), false);
assert.equal(events.at(-1), "end");
assert.equal(activePickupCards([current], records)[0]?.code, pickup.code);

records = [handoff];
await host.startParcelActivity({ recordId: handoff.id });
assert.equal(staleDate, deadline);
now = deadline;
host.reconcileParcelActivity(snapshot());
assert.equal(await hasActivity(), true, "the clock is not a committed terminal state");
records = [{ ...handoff, expiredAtMs: deadline }];
host.reconcileParcelActivity(snapshot());
assert.equal(await hasActivity(), false);
assert.equal(events.at(-1), "end");

now = appointmentStart;
const otherHandoff = { ...handoff, id: "synthetic-other-handoff" };
records = [handoff, otherHandoff];
await host.startParcelActivity({ recordId: handoff.id });
await host.completeParcelActivity({ linkId: "stale-link", kind: "handoff" });
assert.equal(completions.length, 0);
failEnd = true;
await assert.rejects(host.completeParcelActivity({ linkId: linkId, kind: "handoff" }), /实时活动结束失败/);
assert.equal(records[0].completedAtMs, now, "the handoff is saved before ending the activity");
assert.equal(records[1].completedAtMs, undefined, "a different handoff is unaffected");
failEnd = false;
await host.completeParcelActivity({ linkId: linkId, kind: "handoff" });
assert.deepEqual(completions, [handoff.id], "an end retry never writes the handoff twice");
assert.equal(await hasActivity(), false);
records = [{ kind: "pickup", id: "synthetic-receiver", platform: "cainiao", capturedAtMs: now, code: "4-5-6789" }];
await host.startParcelActivity({ recordId: "synthetic-receiver" });
await host.completeParcelActivity({ linkId: linkId, kind: "handoff" });
assert.equal(records[0].completedAtMs, undefined, "a receiver code cannot be completed by the handoff intent");
assert.equal(await hasActivity(), true);

await host.completeParcelActivity({ linkId: linkId, kind: "pickup" });
assert.equal(records[0].completedAtMs, now);
assert.equal(current.forcedCompletedAtMs, undefined);
assert.equal(await hasActivity(), false);

await host.startParcelActivity(target);
await host.completeParcelActivity({ linkId: linkId, kind: "pickup" });
assert.equal(current.forcedCompletedAtMs, now);
assert.equal(await hasActivity(), false);
assert.deepEqual(completions, [handoff.id, "synthetic-receiver", parcel.identity.id]);

current = { ...parcel, pickup };
await host.startParcelActivity(target);
current = { ...parcel, pickup: { ...pickup, waybillGeneration: now }, waybillReuseAtMs: now };
await host.completeParcelActivity({ linkId: linkId, kind: "pickup" });
assert.equal(current.forcedCompletedAtMs, undefined, "a reused waybill cannot be completed by its old activity");
assert.equal(await hasActivity(), false);
assert.equal(completions.length, 3);

current = { ...parcel, pickup: undefined };
const firstPickup: PickupCodeRecord = {
  kind: "pickup", id: "synthetic-first", platform: "cainiao", capturedAtMs: now - 3, code: "A-1234",
};
const thirdPickup: PickupCodeRecord = {
  ...firstPickup, id: "synthetic-third", capturedAtMs: now + 1, code: "C-7890",
};
records = [firstPickup, thirdPickup, { ...handoff, capturedAtMs: now }];
capacity = 2;
await assert.rejects(host.startAllParcelActivities(), /部分实时活动暂时无法显示/);
assert.deepEqual(activeCodes(), [thirdPickup.code, handoff.code], "start the newest records across both kinds first");
assert.equal((await host.parcelActivityStatus()).showAll, true);

const fourthPickup = { ...firstPickup, id: "synthetic-fourth", capturedAtMs: now + 2, code: "D-1234" };
records = [...records, fourthPickup];
host.reconcileParcelActivity(snapshot());
await host.parcelActivityStatus();
assert.deepEqual(activeCodes(), [fourthPickup.code, thirdPickup.code], "a full host swaps only the oldest activity");
assert.equal(records.find((item) => item.id === handoff.id)?.completedAtMs, undefined);

const fifthPickup = { ...firstPickup, id: "synthetic-fifth", capturedAtMs: now + 3, code: "E-5678" };
refused.add(fifthPickup.code);
records = [...records, fifthPickup];
host.reconcileParcelActivity(snapshot());
await host.parcelActivityStatus();
assert.deepEqual(activeCodes(), [fourthPickup.code, thirdPickup.code], "another refusal restores the displaced record");

const fourthReceipt = (session as { receipts: { id: string; linkId: string; target: { recordId: string } }[] })
  .receipts.find((receipt) => receipt.target.recordId === fourthPickup.id)!;
await host.completeParcelActivity({ linkId: fourthReceipt.linkId, kind: "pickup" });
assert.deepEqual(activeCodes(), [thirdPickup.code], "completion ends the matching id while its sibling is still active");
records = records.filter((item) => item.id !== fifthPickup.id);
host.reconcileParcelActivity(snapshot());
await host.parcelActivityStatus();
assert.deepEqual(activeCodes(), [thirdPickup.code, handoff.code], "a freed place is filled at the next synchronization");

const dismissedReceipt = (session as { receipts: { id: string; target: { recordId: string } }[] })
  .receipts.find((receipt) => receipt.target.recordId === thirdPickup.id)!;
native.get(dismissedReceipt.id)!.state = "dismissed";
host.reconcileParcelActivity(snapshot());
await host.parcelActivityStatus();
assert.deepEqual(activeCodes(), [handoff.code, firstPickup.code], "a dismissed card stays dismissed");
await host.stopParcelActivity();
assert.equal((await host.parcelActivityStatus()).showAll, false);
assert.deepEqual(activeCodes(), []);

const activityCardSource = readFileSync(new URL("../components/ParcelLiveActivityCard.tsx", import.meta.url), "utf8");
assert.match(activityCardSource, /handoff \? "我已寄件" : "我已取件"/, "the pickup and handoff activities each show their completion capsule");
assert.match(activityCardSource, /background=\{expanded \? undefined : gradient/, "the system island provides the expanded background");
assert.match(activityCardSource, /frame=\{preview \? \{ maxWidth: card\.width, minHeight: card\.height, maxHeight: card\.height \} : undefined\}/,
  "the list preview reserves the whole card height using the flexible frame");
const activitySettingsSource = readFileSync(new URL("../pages/PickupSettingsPages.tsx", import.meta.url), "utf8");
assert.equal((activitySettingsSource.match(/<ParcelLiveActivityCard\b/g) ?? []).length, 1,
  "the setting contains one example card");

const settingsSource = readFileSync(new URL("../pages/SettingsPage.tsx", import.meta.url), "utf8");
const countFunctions = ["cancelDiagnosticCount", "scheduleDiagnosticCount"].map((name) => {
  const source = settingsSource.match(new RegExp("  function " + name + "\\(\\) \\{[\\s\\S]*?\\n  \\}"))?.[0];
  assert.ok(source);
  return source;
}).join("\n");
let diagnosticReads = 0;
let scheduled: (() => void) | undefined;
const count = runInNewContext(countFunctions + "\n({ scheduleDiagnosticCount, cancelDiagnosticCount });", {
  diagnosticCountTimer: { current: undefined },
  setTimeout: (run: () => void) => { scheduled = run; return 1; },
  clearTimeout: () => { scheduled = undefined; },
  readDiagnostics: () => { diagnosticReads++; return []; },
  setDiagnosticCount: () => {},
});
count.scheduleDiagnosticCount();
count.scheduleDiagnosticCount();
assert.equal(diagnosticReads, 0, "tab presentation does not read the diagnostic journal synchronously");
scheduled?.();
assert.equal(diagnosticReads, 1, "duplicate appearance callbacks share one diagnostic read");
count.scheduleDiagnosticCount();
count.cancelDiagnosticCount();
assert.equal(scheduled, undefined);

const appSource = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
assert.match(appSource, /useObservable<string>\(\s*navigationRequest\.pickupRecordId \? "pickup" : "deliveries"/);
assert.match(appSource, /\{pickupCards\.length \? \(\s*<Tab key="pickup" title="取件"[\s\S]*?<Tab key="deliveries" title="快递"/);

console.log("parcel OCR, tab entry, and Activity lifecycle tests passed");
