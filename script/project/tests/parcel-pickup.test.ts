import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import type { ParcelHandoffRecord, PickupCodeRecord, Shipment } from "../models";
import { activePickupCards, applyRecognizedPickup, handoffActivityContent, independentPickupContent, PARCEL_ACTIVITY_PREVIEW, parcelActivityContent, parcelPickupShortCode, parcelPickupSubtitle, pickupDateSections, type ParcelActivityContent } from "../services/parcel-pickup";
import { PARCEL_LOCK_SCREEN_BOX, parcelCardArtwork, parcelCardPalette } from "../services/parcel-card-appearance";
import { recognizeParcelCodes } from "../services/parcel-code-ocr";
import { parcelTextRows, recognizeParcelWaybill } from "../services/parcel-waybill-ocr";

assert.equal(PARCEL_ACTIVITY_PREVIEW.title, "派派的猫罐头");
assert.equal(PARCEL_ACTIVITY_PREVIEW.location, "旺旺多多驿站");
assert.equal(parcelCardArtwork(PARCEL_ACTIVITY_PREVIEW).sticker?.path, "parcel-activity/pinduoduo.png");
assert.equal(parcelCardArtwork({ ...PARCEL_ACTIVITY_PREVIEW, carrierIcon: "zto" }).sticker?.path,
  "parcel-activity/zto.png");
assert.equal(parcelCardArtwork({ ...PARCEL_ACTIVITY_PREVIEW, kind: "handoff" }).sticker?.path,
  "platform-accounts/pinduoduo.png");
assert.equal(parcelPickupShortCode("1-2-3456"), "1-2-3456");
assert.equal(parcelPickupShortCode("B-12-34567"), "B1234567");
const previewAddress = { ...PARCEL_ACTIVITY_PREVIEW, address: "示例路 8 号" };
assert.deepEqual(parcelPickupSubtitle(previewAddress), { text: "旺旺多多驿站", symbol: "house.fill" });
assert.deepEqual(parcelPickupSubtitle(previewAddress, previewAddress.address, true), { text: "示例路 8 号", symbol: "mappin.circle.fill" });
assert.deepEqual(parcelPickupSubtitle({ ...PARCEL_ACTIVITY_PREVIEW, location: "" }), { text: "请及时取件", symbol: "doc.text.fill" });
assert.deepEqual(parcelCardPalette(), {
  gradient: ["#22262d", "#38232d"], code: "white", capsule: "rgba(255,255,255,0.16)",
});
assert.deepEqual(parcelCardPalette("#1e88e5"), {
  gradient: ["#223243", "#352f43"], code: "#1e88e5", capsule: "#1e88e5",
});
assert.notEqual(parcelCardPalette("#3259a8").code, "#3259a8");
assert.equal(parcelCardPalette("#3259a8").capsule, "#3259a8");
assert.notEqual(parcelCardPalette("#ffd100").capsule, "#ffd100");
assert.equal(parcelCardPalette("#ffd100").code, "#ffd100");

const exampleDay = new Date(2026, 10, 18, 14);
const datedHandoff = handoffActivityContent({
  id: "synthetic-dated", kind: "handoff", platform: "pinduoduo", code: "S1111",
  capturedAtMs: Date.parse("2026-11-16T00:00:00Z"),
  windowStartAtMs: Date.parse("2026-11-18T16:30:00Z"),
});
assert.equal(datedHandoff?.businessDateKey, "2026-11-19");
assert.equal(parcelPickupSubtitle(datedHandoff!).symbol, "calendar.circle.fill");
assert.deepEqual(pickupDateSections([PARCEL_ACTIVITY_PREVIEW, datedHandoff!], true, "", exampleDay)
  .map(({ label, preview, items }) => [label, preview, items.length]),
[
  ["2026年11月18日 周三", true, 1],
  ["2026年11月19日 周四", false, 1],
]);
assert.equal(pickupDateSections([PARCEL_ACTIVITY_PREVIEW, datedHandoff!], false, "synthetic-dated", exampleDay)[0].key,
  "2026-11-19", "an explicitly requested record stays at the top");
assert.deepEqual(pickupDateSections([], false, "", exampleDay), []);
assert.equal(pickupDateSections([], true, "", exampleDay)[0].label, "2026年11月18日 周三");

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
let lockScreenBoxCopied = false;
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
      assert.equal(lockScreenBoxCopied, true, "the shared artwork must exist before the host snapshots the card");
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
const host = runInNewContext(service + "\n({ startParcelActivity, startAllParcelActivities, stopParcelActivity, startParcelActivityPreview, stopParcelActivityPreview, onParcelActivityPreviewChanged, reconcileParcelActivity, parcelActivityStatus, parcelActivityTarget, completeParcelActivity });", {
  Path: { join: (...parts: string[]) => parts.join("/") },
  Script: { directory: "/synthetic" },
  UUID: { string: () => { linkId = "synthetic-link-" + ++nextLink; return linkId; } },
  Date: { now: () => now },
  FileManager: {
    appGroupDocumentsDirectory: "/synthetic-shared",
    createDirectorySync: () => {},
    existsSync: (path: string) => !path.endsWith(PARCEL_LOCK_SCREEN_BOX) || lockScreenBoxCopied,
    isFileSync: () => true,
    copyFileSync: (source: string, destination: string) => {
      assert.equal(source, `/synthetic/assets/parcel-activity/${PARCEL_LOCK_SCREEN_BOX}`);
      assert.equal(destination, `/synthetic-shared/art/${PARCEL_LOCK_SCREEN_BOX}`);
      lockScreenBoxCopied = true;
    },
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
  PARCEL_LOCK_SCREEN_BOX,
  PARCEL_ACTIVITY_PREVIEW,
  parcelCardArtwork,
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

records = [firstPickup];
let previewTransitions = 0;
const unsubscribePreview = host.onParcelActivityPreviewChanged(() => { previewTransitions++; });
await host.startAllParcelActivities();
await host.startParcelActivityPreview();
await host.startParcelActivityPreview();
assert.deepEqual(activeCodes(), [firstPickup.code, PARCEL_ACTIVITY_PREVIEW.code]);
assert.equal((await host.parcelActivityStatus()).count, 1);
assert.equal((await host.parcelActivityStatus()).previewing, true);
assert.equal(previewTransitions, 1, "the pickup tab is notified only after the saved preview starts");
await host.stopParcelActivityPreview();
assert.deepEqual(activeCodes(), [firstPickup.code], "closing the example keeps the real card active");
assert.equal((await host.parcelActivityStatus()).showAll, true);
await host.startParcelActivityPreview();
records = [firstPickup, fourthPickup];
host.reconcileParcelActivity(snapshot());
assert.equal((await host.parcelActivityStatus()).previewing, false);
assert.equal(previewTransitions, 4, "replacement by a real card also hides the preview from the tab");
unsubscribePreview();
assert.deepEqual(activeCodes(), [fourthPickup.code, firstPickup.code], "real cards take priority over the example at capacity");
await assert.rejects(host.startParcelActivityPreview(), /锁屏预览暂时无法启动/);
assert.deepEqual(activeCodes(), [fourthPickup.code, firstPickup.code]);
await host.stopParcelActivity();

const activityCardSource = readFileSync(new URL("../components/ParcelLiveActivityCard.tsx", import.meta.url), "utf8");
const fullBox = readFileSync(new URL("../assets/parcel-activity/box.png", import.meta.url));
const watchBox = readFileSync(new URL(`../assets/parcel-activity/${PARCEL_LOCK_SCREEN_BOX}`, import.meta.url));
assert.deepEqual([fullBox.readUInt32BE(16), fullBox.readUInt32BE(20)], [300, 351]);
assert.deepEqual([watchBox.readUInt32BE(16), watchBox.readUInt32BE(20)], [100, 117]);
assert.match(activityCardSource, /const lockScreenBoxPath = [^\n]+FileManager\.isFileSync\(boxPath\)\s*\? boxPath/,
  "the lock screen prefers the full-resolution box");
assert.match(activityCardSource, /<Image filePath=\{lockScreenBoxPath\}/);
assert.match(activityCardSource, /const watchBoxFile = hasWatchBox \? watchBoxPath : lockScreenBoxPath;/,
  "the watch keeps the compact App Group asset when available");
assert.match(activityCardSource, /handoff \? "我已寄件" : "我已取件"/, "the pickup and handoff activities each show their completion capsule");
assert.match(activityCardSource, /background=\{expanded \? undefined : cardBackground\}/,
  "the Lock Screen uses the pickup gradient and the island uses system black");
assert.match(activityCardSource, /background=\{cardBackground\} allowsHitTesting=\{false\}/,
  "the Smart Stack presents the same gradient");
assert.doesNotMatch(activityCardSource, /glassEffect|UIGlass/, "both activity surfaces use the plain gradient");
assert.match(activityCardSource, /activityBackgroundTint="clear" widgetURL=\{url\}/);
assert.doesNotMatch(activityCardSource, /<(?:EnvironmentValuesReader|GeometryReader|Canvas)\b/,
  "the lock screen snapshots a complete view tree");
assert.match(activityCardSource, /frame=\{\{ \.\.\.slot\(bottom - top\), minWidth: 0, maxWidth: "infinity"/);
assert.match(activityCardSource, /systemName="shippingbox\.fill" font=\{card\.capsuleIcon \* scale\}/,
  "the completion control uses the native package symbol");
const activityEntrySource = readFileSync(new URL("../live_activity.tsx", import.meta.url), "utf8");
assert.match(activityEntrySource, /<LiveActivityUIExpandedCenter>\s*<ParcelLiveActivityCard \{\.\.\.cardProps\} width=\{width\} expanded \/>/,
  "the tested center region uses the regular iPhone card scale");
assert.match(activityCardSource, /const artColumnWidth = expanded \? artWidth - card\.edge \* scale : artWidth;/,
  "the expanded host supplies the card's outside inset while the artwork keeps its regular size");
assert.match(activityCardSource, /minWidth: expanded \? artColumnWidth : Math\.min\(artWidth, MIN_COMPACT_ART_WIDTH\)/,
  "the expanded native host cannot squeeze the box into the Watch column");
assert.match(activityCardSource, /<VStack spacing=\{dividerToCapsule \* scale\} fixedSize=\{\{ horizontal: false, vertical: true \}\} layoutPriority=\{1\}>\s*\{divider\}\s*\{bottomRow\}\s*<\/VStack>/,
  "the expanded divider and action share a fixed spacing container");
assert.match(activityCardSource, /slot\(dividerTop - titleTop\)[^\n]*>\s*\{expandedLine\(title, card\.titleHeight, card\.titleLineHeight\)\}\s*<Rectangle fill="clear" frame=\{slot\(gap\)\} layoutPriority=\{-1\} \/>\s*\{expandedLine\(location, card\.locationHeight, card\.locationIcon, card\.locationLineHeight\)\}/,
  "the expanded text line frames release their spare height before the Pipi gaps shrink");
assert.match(activityCardSource, /fixedSize=\{\{ horizontal: false, vertical: true \}\}\s+frame=\{\{ minHeight: lineHeight \* scale, alignment: "topLeading" \}\}/,
  "the expanded Pipi line heights distribute leading without shrinking text");
assert.match(activityCardSource, /const MIN_COMPACT_ART_WIDTH = PIPI_CARD\.artWidth \/ 2;/);
assert.match(activityCardSource, /const balancedType = lockScreen \|\| lockScreenPreview;/);
assert.match(activityCardSource, /const codeFont = balancedType \? 26\.5 : card\.codeFont;/);
assert.match(activityCardSource, /font=\{codeFont \* scale\} fontWeight="semibold" fontWidth=\{balancedType \? "standard" : "condensed"\}/,
  "the selected Lock Screen font keeps standard digits and the expanded island keeps condensed digits");
assert.match(activityCardSource, /const SMART_STACK_ART_COLUMN_WIDTH = 56;/);
assert.match(activityCardSource, /const SMART_STACK_ART_WIDTH = 64;/);
assert.match(activityCardSource, /const SMART_STACK_ART_GAP = 4\.6;/);
assert.match(activityCardSource, /const SMART_STACK_CODE_FONT = 29;/);
const watchCardSource = activityCardSource.slice(activityCardSource.indexOf("const smartStack = ("));
assert.match(watchCardSource, /<ZStack frame=\{watchArtFrame\} scaleEffect=\{SMART_STACK_ART_WIDTH \/ SMART_STACK_ART_COLUMN_WIDTH\}>/,
  "the Smart Stack centers the enlarged box without the iPhone artwork offset");
assert.ok(/\{data\.title\}<\/Text>\s*<HStack spacing=\{0\} frame=\{\{ minHeight: gap, maxHeight: gap, maxWidth: "infinity" \}\}[\s\S]*?\{dividerDots\(watchContentWidth, 1\)\}[\s\S]*?<Text font=\{SMART_STACK_CODE_FONT\}/.test(watchCardSource),
  "the Smart Stack uses the Pipi body gap around the dotted divider");
assert.ok(/<VStack alignment="leading" spacing=\{0\}[\s\S]*?offset=\{\{ x: 0, y: \(gap - card\.iconGap\) \/ 2 \}\}/.test(watchCardSource),
  "the Smart Stack moves the text block down by half of the added gap");
assert.match(watchCardSource, /offset=\{\{ x: 0, y: SMART_STACK_DIVIDER_INK_OFFSET \}\}/,
  "the Smart Stack positions the divider between visible letters and digits");
assert.match(activityCardSource, /const flexibleHeight = lockScreen \|\| expanded;/,
  "the system presentations can yield empty space at their native height limits");
const activitySettingsSource = readFileSync(new URL("../pages/PickupSettingsPages.tsx", import.meta.url), "utf8");
assert.equal((activitySettingsSource.match(/<ParcelActivityPreviewCard\b/g) ?? []).length, 1,
  "the setting contains one example card");
assert.match(activitySettingsSource, /<ParcelActivityPreviewCard lockScreenPreview \/>/,
  "the settings preview uses the selected Lock Screen typography");
const tabCardSource = readFileSync(new URL("../components/PickupTabCard.tsx", import.meta.url), "utf8");
assert.match(tabCardSource, /listRowInsets=\{0\}[\s\S]*?<ParcelLiveActivityCard\b/);
assert.match(tabCardSource, /background=\{\s*<GeometryReader\b/, "only the in-app row reads layout geometry");
assert.match(activitySettingsSource, /<Text>锁屏预览<\/Text>[\s\S]*?"stop\.circle" : "play\.circle"[\s\S]*?disabled=\{busy\}/);
assert.match(activitySettingsSource, /<Text>截屏识别<\/Text>[\s\S]*?<Text>短信识别<\/Text>/);
assert.match(activitySettingsSource, /「在 App 中运行意图」[\s\S]*?「运行意图脚本」/);
assert.match(activitySettingsSource, /<Toggle title="实时活动"/);

const settingsSource = readFileSync(new URL("../pages/SettingsPage.tsx", import.meta.url), "utf8");
assert.doesNotMatch(settingsSource, /\breadDiagnostics\b/,
  "entering settings and returning from its pages never reads the log journal");
assert.match(settingsSource, /destination === "diagnostics" \? \(\s*<DiagnosticLogPage onCountChange=\{setDiagnosticCount\}/);
const logPageSource = readFileSync(new URL("../pages/DiagnosticLogPage.tsx", import.meta.url), "utf8");
assert.doesNotMatch(logPageSource, /useState\(\(\) => readDiagnostics\(\)\)/,
  "constructing the diagnostics destination never reads the log before it is shown");
assert.match(logPageSource, /onAppear=\{\(\) => \{\s*showItems\(readDiagnostics\(\)\);/);
assert.match(logPageSource, /onCountChange\(next\.length\)/);
assert.match(logPageSource, /clearDiagnostics\(\);\s*showItems\(\[\]\)/,
  "clearing the log updates the cached badge");

const appSource = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
assert.match(appSource, /useObservable<string>\(\s*navigationRequest\.pickupRecordId \? "pickup" : "deliveries"/);
assert.match(appSource, /pickupCards\.length > 0 \|\| pickupPreview/);
assert.match(appSource, /\{hasPickupTab \? \(\s*<Tab key="pickup" title="取件"[\s\S]*?<Tab key="deliveries" title="快递" systemImage="archivebox\.fill"/);
const pickupSource = readFileSync(new URL("../pages/PickupPage.tsx", import.meta.url), "utf8");
assert.match(pickupSource, /preview \? <ParcelActivityPreviewCard animate/);
assert.match(pickupSource, /<RootPageHeader title="取件" action=\{\(\) => dismiss\(\)\}/);
assert.match(settingsSource, /<RootPageHeader title="设置" action=\{\(\) => dismiss\(\)\}/);
const rootHeader = readFileSync(new URL("../components/RootPageHeader.tsx", import.meta.url), "utf8");
assert.match(rootHeader, /<Text font="largeTitle" fontWeight="bold"[\s\S]*?<Button title="关闭" systemImage="xmark"/);
assert.match(rootHeader, /labelStyle="iconOnly"[\s\S]*?width: 44, height: 44/);
assert.match(pickupSource, /<\/List>\s*<IdentityCodeButton onOpen=\{setIdentity\}/,
  "the identity popover is anchored beside the scrolling list");
assert.match(pickupSource, /<HStack spacing=\{0\} popover=\{\{\s*isPresented: showPicker,\s*onChanged: setShowPicker,/,
  "the containing row owns the reference popover binding");
assert.match(pickupSource, /<TabFloatingActionButton title="身份码" symbol="person\.text\.rectangle"/);
const floatingButtonSource = readFileSync(new URL("../components/TabFloatingActionButton.tsx", import.meta.url), "utf8");
assert.match(floatingButtonSource, /<Label title=\{title\} systemImage=\{symbol\} labelStyle="iconOnly"/,
  "both floating actions use a symbol-only label");
assert.match(pickupSource, /onLocationTap=\{canSwitch \? \(\) => setShowAddress\(!showAddress\)/);
const stationIdentitySource = readFileSync(new URL("../pages/StationIdentityPage.tsx", import.meta.url), "utf8");
assert.match(stationIdentitySource, /<QRImage data=\{value\} size=\{184\} \/>/,
  "the card pairs a QR code with the barcode for every valid identity");
assert.match(stationIdentitySource, /<QRImage data=\{value\} size=\{qrSize\} \/>/,
  "the full-screen QR uses the same current identity payload");

console.log("parcel OCR, tab entry, and Activity lifecycle tests passed");
