import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import type { ParcelHandoffRecord, PickupCodeRecord, Shipment } from "../models";
import { MEAL_ARTWORK_TOKENS, PICKUP_STICKER_ENTRANCE } from "../components/pickup-card-tokens.generated";
import { PICKUP_TAB_TITLE, activePickupCards, applyRecognizedPickup, handoffActivityContent, independentPickupContent, nextPickupArtwork, PARCEL_ACTIVITY_PREVIEW, parcelActivityContent, parcelCardKey, parcelPickupShortCode, parcelPickupSubtitle, pickupDateSections, withPickupArtwork, type ParcelActivityContent } from "../services/parcel-pickup";
import { PARCEL_LOCK_SCREEN_BOX, parcelCardArtwork, parcelCardPalette, pickupCardAppearance, pickupCardPalette, type ParcelLockScreenStyle } from "../services/parcel-card-appearance";
import { resolvePickupVisualStyle } from "../services/meal/pickup-artwork";
import { recognizeParcelCodes } from "../services/parcel-code-ocr";
import { parcelTextRows, recognizeParcelWaybill } from "../services/parcel-waybill-ocr";
import { MEAL_ARTWORK_FRAME_ENDS } from "../services/meal/artwork-motion.generated";

assert.equal(PARCEL_ACTIVITY_PREVIEW.title, "派派的猫罐头");
assert.equal(PARCEL_ACTIVITY_PREVIEW.location, "旺旺多多驿站");
assert.equal(parcelCardArtwork(PARCEL_ACTIVITY_PREVIEW).sticker?.path, "parcel-activity/pinduoduo.png");
assert.equal(parcelCardArtwork({ ...PARCEL_ACTIVITY_PREVIEW, carrierIcon: "zto" }).sticker?.path,
  "parcel-activity/zto.png");
assert.equal(parcelCardArtwork({ ...PARCEL_ACTIVITY_PREVIEW, kind: "handoff" }).sticker?.path,
  "platform-accounts/pinduoduo.png");
const brandedMeal = { kind: "meal", title: "冷萃", location: "万丰海岸城店", code: "S5756",
  mealBrandId: "jpgcoffee" } as const satisfies ParcelActivityContent;
assert.deepEqual(parcelPickupSubtitle(brandedMeal), {
  text: "万丰海岸城店", symbol: parcelPickupSubtitle(PARCEL_ACTIVITY_PREVIEW).symbol,
});
assert.deepEqual(parcelCardArtwork(brandedMeal).mark, {
  path: "meal-pickup/brand-jpgcoffee.png", name: "brand-jpgcoffee.png",
});
assert.equal(MEAL_ARTWORK_FRAME_ENDS["aod_static_coffee_common_cold.png"]?.length, 53);
assert.equal(MEAL_ARTWORK_FRAME_ENDS["aod_static_coffee_common_cold.png"]?.at(-1), 1749);
assert.equal(PICKUP_STICKER_ENTRANCE.mealDelay, 367);
assert.equal(PICKUP_STICKER_ENTRANCE.parcelDelay, 1250);
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
const mealRules = JSON.parse(readFileSync(new URL("../../../pickup-rules.json", import.meta.url), "utf8"));
const jpgStyle = resolvePickupVisualStyle(mealRules, {
  brandId: brandedMeal.mealBrandId, productName: brandedMeal.title, evidenceText: "",
});
const jpgPalette = pickupCardPalette({ ...brandedMeal, mealStyle: jpgStyle });
assert.equal(jpgPalette.code, "#6E261D", "JPG uses Pipi's configured pickup code color");
assert.equal(jpgPalette.capsule, jpgStyle.buttonColor);
const previewPalette = pickupCardPalette(PARCEL_ACTIVITY_PREVIEW);
const dynamicAppearance = pickupCardAppearance(previewPalette);
assert.equal(dynamicAppearance.background, undefined);
assert.equal(pickupCardAppearance(jpgPalette).code, jpgPalette.code, "dynamic preserves the Pipi meal palette");
const blackAppearance = pickupCardAppearance(previewPalette, "black");
const whiteAppearance = pickupCardAppearance(previewPalette, "white");
assert.equal(blackAppearance.background, "#000000");
assert.equal(blackAppearance.titleColor, dynamicAppearance.titleColor);
assert.equal(whiteAppearance.background, "#ffffff");
assert.equal(whiteAppearance.titleColor, "#111111");
assert.equal(whiteAppearance.locationColor, "#57575b");
assert.equal(whiteAppearance.dotColor, "rgba(17,17,17,0.18)");
assert.equal(blackAppearance.code, previewPalette.code);
assert.equal(whiteAppearance.code, previewPalette.code);
assert.equal(whiteAppearance.capsule, previewPalette.capsule);
assert.equal(pickupCardAppearance(jpgPalette, "black").code, "#ffffff", "dark meal digits stay readable on pure black");
const neutralPalette = pickupCardPalette({ ...PARCEL_ACTIVITY_PREVIEW, platform: undefined });
const neutralOnWhite = pickupCardAppearance(neutralPalette, "white");
assert.equal(neutralOnWhite.code, "#111111");
assert.equal(neutralOnWhite.capsuleForeground, "#111111");
assert.equal(neutralOnWhite.capsule, "rgba(0,0,0,0.10)");

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

const unrecognized = { ...parcel, pickup: { ...pickup, platform: undefined },
  identity: { ...parcel.identity, courierCode: "", companyName: "" } };
const station = parcelActivityContent(unrecognized)!;
assert.equal(nextPickupArtwork(station), "cainiao");
const stationKey = parcelCardKey(station);
assert.equal(nextPickupArtwork(withPickupArtwork(station, { [stationKey]: "cainiao" })), "pinduoduo");
assert.equal(nextPickupArtwork(withPickupArtwork(station, { [stationKey]: "pinduoduo" })), "fengchao");
const cabinetArt = activePickupCards([unrecognized], [], { [stationKey]: "fengchao" })[0];
assert.equal(nextPickupArtwork(cabinetArt), "cainiao");
assert.equal(parcelCardArtwork(cabinetArt).sticker?.path, "parcel-activity/fengchao.png");
assert.equal(cabinetArt.platform, undefined, "station artwork does not claim a cabinet session");
const recognized = activePickupCards([{ ...parcel, pickup }], [], { [stationKey]: "fengchao" })[0];
assert.equal(nextPickupArtwork(recognized), undefined, "a resolved carrier supersedes the local fallback");
assert.equal(parcelCardArtwork(recognized).sticker?.path, "parcel-activity/sf.png");
assert.equal(nextPickupArtwork(parcelActivityContent({
  ...parcel, pickup, identity: { ...parcel.identity, companyName: "" },
})!), undefined, "a known carrier code suffices even while its name is missing");

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
assert.equal(nextPickupArtwork(timeOnly!), "jingdong");
const handoffKey = parcelCardKey(timeOnly!);
assert.equal(nextPickupArtwork(withPickupArtwork(timeOnly!, { [handoffKey]: "jingdong" })), "douyin");
const douyin = withPickupArtwork(timeOnly!, { [handoffKey]: "douyin" });
assert.equal(nextPickupArtwork(douyin), "pinduoduo");
assert.equal(nextPickupArtwork(withPickupArtwork(timeOnly!, { [handoffKey]: "pinduoduo" })), "cainiao");
assert.equal(douyin.platform, "cainiao", "handoff artwork retains the recognized source");
assert.equal(parcelCardArtwork(douyin).mark?.path, "platform-accounts/douyin.png");
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
let mealBrandCopied = false;
let current: Shipment = { ...parcel, pickup };
let records: PickupCodeRecord[] = [];
const snapshot = () => ({ revision: 0, shipments: [current], pickupCodeRecords: records });
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
let activitiesEnabled = true;
let owner: symbol | undefined;
let onStart: (() => Promise<void>) | undefined;
let meals: ParcelActivityContent[] = [];
let pickupGeneration = 0;
let sharedMeta: {
  stateRef?: string; mealStateRef?: string;
  nativePickupTabClose?: { activityId: string; stateRef?: string; mealStateRef?: string };
} = {};
const refused = new Set<string>();
const completions: string[] = [];
const native = new Map<string, ReturnType<typeof makeActivity>>();
const activityUpdateListeners = new Set<(detail: { id: string; state: string }) => void>();
let batchStatusReads = 0;
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
    previewLinkId: undefined as string | undefined,
    lockScreenStyle: undefined as ParcelLockScreenStyle | undefined,
    start: async ({ code, mealBrandId, lockScreenStyle, previewLinkId }: ParcelActivityContent & {
      lockScreenStyle?: ParcelLockScreenStyle; previewLinkId?: string;
    },
      options?: { staleDate?: number; relevanceScore?: number }) => {
      if (onStart) await onStart();
      assert.equal(lockScreenBoxCopied, true, "the shared artwork must exist before the host snapshots the card");
      if (mealBrandId === "jpgcoffee") assert.ok(mealBrandCopied, "the branded badge must exist before the snapshot");
      if (activeCodes().length >= capacity || refused.has(code)) return false;
      events.push("start " + code);
      staleDate = options?.staleDate;
      activity.state = "active";
      activity.code = code;
      activity.previewLinkId = previewLinkId;
      activity.lockScreenStyle = lockScreenStyle;
      activity.rank = options?.relevanceScore ?? 0;
      activityId = activity.activityId;
      native.set(activityId, activity);
      return true;
    },
    update: async ({ code, lockScreenStyle, previewLinkId }: {
      code: string; lockScreenStyle?: ParcelLockScreenStyle; previewLinkId?: string;
    },
      options?: { relevanceScore?: number }) => {
      events.push("update " + code);
      activity.code = code;
      activity.previewLinkId = previewLinkId;
      activity.lockScreenStyle = lockScreenStyle;
      activity.rank = options?.relevanceScore ?? 0;
      return true;
    },
    end: async () => {
      if (failEnd) return false;
      events.push("end");
      activity.state = "ended";
      for (const listener of activityUpdateListeners) listener({ id: activity.activityId, state: "ended" });
      return true;
    },
  };
  return activity;
}
const activityGlobals = {
  Path: { join: (...parts: string[]) => parts.join("/") },
  Script: { directory: "/synthetic" },
  UUID: { string: () => { linkId = "synthetic-link-" + ++nextLink; return linkId; } },
  Date: { now: () => now },
  FileManager: {
    appGroupDocumentsDirectory: "/synthetic-shared",
    createDirectorySync: () => {},
    existsSync: (path: string) => path.endsWith(PARCEL_LOCK_SCREEN_BOX) ? lockScreenBoxCopied
      : path.endsWith("/brand-jpgcoffee.png") ? mealBrandCopied : true,
    isFileSync: () => true,
    copyFileSync: (source: string, destination: string) => {
      if (destination === "/synthetic-shared/art/brand-jpgcoffee.png") {
        assert.equal(source, "/synthetic/assets/meal-pickup/brand-jpgcoffee.png");
        mealBrandCopied = true;
        return;
      }
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
    areActivitiesEnabled: async () => activitiesEnabled,
    addActivityUpdateListener: (listener: (detail: { id: string; state: string }) => void) => {
      activityUpdateListeners.add(listener);
    },
    removeActivityUpdateListener: (listener: (detail: { id: string; state: string }) => void) => {
      activityUpdateListeners.delete(listener);
    },
    getAllActivities: async () => {
      batchStatusReads++;
      return [...native.values()].map(({ activityId, state }) => ({ id: activityId, state }));
    },
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
  withPickupArtwork,
  activePickupCards,
  activeMealCards: () => meals.filter(card => (card.expiresAtMs ?? Infinity) > now),
  mealCredentialScope: () => "synthetic-scope",
  readMeals: () => null,
  mealCard: (scope: string, id: string) => meals.find(card => card.target && "mealId" in card.target &&
    card.target.mealId === id && card.target.mealScope === scope && (card.expiresAtMs ?? Infinity) > now) ?? null,
  parcelCardKey: ({ target }: Pick<ParcelActivityContent, "target">) => target
    ? "recordId" in target ? "record:" + target.recordId : "mealId" in target ? `${target.mealScope}:${target.mealId}` :
      JSON.stringify([target.shipmentId, target.waybill, target.waybillGeneration])
    : "",
  loadState: () => { stateReads++; return snapshot(); },
  peekStateRevision: () => 0,
  stateLoadFailure: () => loadFailed,
  visibleShipments: (state: { shipments: Shipment[] }) => state.shipments,
  withSharedFileTransaction: (run: () => unknown) => run(),
  sharedData: () => sharedMeta,
  publishSharedData: (patch: typeof sharedMeta) => { sharedMeta = { ...sharedMeta, ...patch }; },
  completeCurrentParcelCard: ({ target }: ParcelActivityContent) => {
    assert.ok(target);
    if ("recordId" in target) {
      completions.push(target.recordId);
      records = records.map((item) => item.id === target.recordId ? { ...item, completedAtMs: now } : item);
    } else if ("shipmentId" in target) {
      assert.equal(target.waybill, current.pickup?.waybill);
      assert.equal(target.waybillGeneration, current.waybillReuseAtMs ?? 0);
      completions.push(target.shipmentId);
      current = { ...current, forcedCompletedAtMs: now };
    }
    sharedMeta = { ...sharedMeta, stateRef: "synthetic-state-" + ++pickupGeneration };
    return snapshot();
  },
  completeMeal: (scope: string, id: string) => {
    const previous = meals;
    meals = previous.filter(card => !(card.target && "mealId" in card.target &&
      card.target.mealId === id && card.target.mealScope === scope));
    if (meals.length === previous.length) return false;
    completions.push(id);
    sharedMeta = { ...sharedMeta, mealStateRef: "synthetic-meal-" + ++pickupGeneration };
    return true;
  },
  synchronizeMeals: async () => {},
  acquireDurableRefreshLease: (key: string) => {
    assert.equal(key, "parcel-activities");
    if (owner) return null;
    const token = Symbol(key);
    owner = token;
    return { isCurrent: () => owner === token, release: () => { if (owner === token) owner = undefined; } };
  },
  pauseWhileActive: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
  writeDiagnostic: () => {},
  beginDiagnosticOperation: () => () => {},
};
const createHost = () => runInNewContext(service + "\n({ startParcelActivity, startAllParcelActivities, stopParcelActivity, startParcelActivityPreview, stopParcelActivityPreview, onParcelActivityChanged, nativePickupTabCloseId, reconcileParcelActivity, parcelActivitySceneChanged, parcelActivityStatus, parcelActivityTarget, completeParcelActivity, showShortcutPickupActivities, setParcelLockScreenStyle });", { ...activityGlobals });
const host = createHost();
const hasActivity = async () => (await host.parcelActivityStatus()).count > 0;
const target = parcelActivityContent(current)!.target;
await host.startParcelActivity(target);
session = (session as { receipts: unknown[] }).receipts[0];
assert.equal((await host.parcelActivityStatus()).lockScreenStyle, "dynamic", "legacy receipts default to dynamic");
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
const nativeTabClosures: string[] = [];
const unsubscribePreview = host.onParcelActivityChanged((change: { kind: "preview" } | { kind: "pickup-tab-empty"; activityId: string }) => {
  if (change.kind === "preview") previewTransitions++;
  else nativeTabClosures.push(change.activityId);
});
await host.startAllParcelActivities();
Reflect.deleteProperty(session as object, "lockScreenStyle");
assert.equal((await host.parcelActivityStatus()).lockScreenStyle, "dynamic", "old registries retain their dynamic style");
await host.startParcelActivityPreview();
await host.startParcelActivityPreview();
assert.deepEqual(activeCodes(), [firstPickup.code, PARCEL_ACTIVITY_PREVIEW.code]);
assert.equal((await host.parcelActivityStatus()).count, 1);
assert.equal((await host.parcelActivityStatus()).previewing, true);
assert.equal(previewTransitions, 1, "the pickup tab is notified only after the saved preview starts");
const sameActivities = () => [...native.values()].filter(item => item.state === "active")
  .map(({ activityId, code, rank }) => ({ activityId, code, rank }));
const previousActivities = sameActivities();
const styleEventIndex = events.length;
const batchReadsBeforeStyle = batchStatusReads;
await host.setParcelLockScreenStyle("white");
assert.equal(batchStatusReads, batchReadsBeforeStyle + 1, "all running cards share one native status read");
assert.deepEqual(sameActivities(), previousActivities, "changing appearance preserves activity identity and relevance");
assert.deepEqual(events.slice(styleEventIndex), ["update " + firstPickup.code, "update " + PARCEL_ACTIVITY_PREVIEW.code]);
assert.equal(previewTransitions, 1, "recoloring is not a new preview");
assert.ok([...native.values()].filter(item => item.state === "active").every(item => item.lockScreenStyle === "white"));
const savedStyleHost = createHost();
assert.equal((await savedStyleHost.parcelActivityStatus()).lockScreenStyle, "white", "a new runtime reads the saved style");
const receipts = () => (session as { receipts: { id: string; linkId?: string; target?: unknown }[] }).receipts;
const originalPreview = receipts().find(receipt => !receipt.target)!;
const realReceipt = receipts().find(receipt => receipt.target)!;
assert.ok(originalPreview.linkId, "the example capsule addresses a specific preview instance");
assert.equal(native.get(originalPreview.id)?.previewLinkId, originalPreview.linkId);
delete originalPreview.linkId;
native.get(originalPreview.id)!.previewLinkId = undefined;
host.reconcileParcelActivity(snapshot());
await host.parcelActivityStatus();
const previewReceipt = receipts().find(receipt => !receipt.target)!;
assert.equal(previewReceipt.id, originalPreview.id, "an existing preview keeps its native instance");
assert.ok(previewReceipt.linkId);
assert.equal(native.get(previewReceipt.id)?.previewLinkId, previewReceipt.linkId, "an existing preview becomes interactive");
const beforePreviewClose = completions.length;
await savedStyleHost.completeParcelActivity({ kind: "preview", linkId: realReceipt.linkId });
await savedStyleHost.completeParcelActivity({ kind: "pickup", linkId: previewReceipt.linkId });
failEnd = true;
await assert.rejects(savedStyleHost.completeParcelActivity({ kind: "preview", linkId: previewReceipt.linkId }), /实时活动结束失败/);
failEnd = false;
assert.deepEqual(activeCodes(), [firstPickup.code, PARCEL_ACTIVITY_PREVIEW.code]);
await savedStyleHost.completeParcelActivity({ kind: "preview", linkId: previewReceipt.linkId });
assert.equal((await host.parcelActivityStatus()).previewing, false);
assert.equal(previewTransitions, 2, "the native end also clears the app's preview");
assert.deepEqual(activeCodes(), [firstPickup.code], "closing the example keeps the real card active");
assert.deepEqual(nativeTabClosures, [], "ending a preview with a remaining card cannot hide the tab");
assert.equal(completions.length, beforePreviewClose, "closing the example cannot complete a real record");
assert.equal((await host.parcelActivityStatus()).showAll, true);
await host.startParcelActivityPreview();
await savedStyleHost.completeParcelActivity({ kind: "preview", linkId: previewReceipt.linkId });
assert.equal((await host.parcelActivityStatus()).previewing, true, "an obsolete capsule cannot end a replacement preview");
await host.stopParcelActivityPreview();
assert.deepEqual(activeCodes(), [firstPickup.code], "ending the preview in-app still keeps real cards active");
await host.startParcelActivityPreview();
records = [firstPickup, fourthPickup];
const activeBeforeRecolor = activeCodes();
await host.setParcelLockScreenStyle("black");
assert.deepEqual(activeCodes(), activeBeforeRecolor, "appearance changes cannot start a pending card or evict the preview");
assert.equal((await host.parcelActivityStatus()).lockScreenStyle, "black");
host.reconcileParcelActivity(snapshot());
assert.equal((await host.parcelActivityStatus()).previewing, false);
assert.equal(previewTransitions, 6, "replacement by a real card also hides the preview from the tab");
assert.deepEqual(activeCodes(), [fourthPickup.code, firstPickup.code], "real cards take priority over the example at capacity");
await assert.rejects(host.startParcelActivityPreview(), /锁屏预览暂时无法启动/);
assert.deepEqual(activeCodes(), [fourthPickup.code, firstPickup.code]);
const realReceipts = receipts();
await savedStyleHost.completeParcelActivity({ kind: "pickup", linkId: realReceipts.find(receipt => native.get(receipt.id)?.code === firstPickup.code)!.linkId });
await host.parcelActivityStatus();
assert.deepEqual(nativeTabClosures, [], "completing one of two real cards leaves the tab displayed");
await host.startParcelActivityPreview();
const abandonedPreview = receipts().find(receipt => !receipt.target)!;
native.get(abandonedPreview.id)!.state = "ended";
const lastReal = realReceipts.find(receipt => native.get(receipt.id)?.code === fourthPickup.code)!;
await savedStyleHost.completeParcelActivity({ kind: "pickup", linkId: lastReal.linkId });
await host.parcelActivityStatus();
assert.deepEqual(nativeTabClosures, [lastReal.id]);
assert.equal(host.nativePickupTabCloseId(), lastReal.id, "the foreground reads the same cross-runtime close hint");
await host.startParcelActivityPreview();
const lastPreview = receipts().find(receipt => !receipt.target)!;
failEnd = true;
await assert.rejects(savedStyleHost.completeParcelActivity({ kind: "preview", linkId: lastPreview.linkId }), /实时活动结束失败/);
failEnd = false;
assert.notEqual(host.nativePickupTabCloseId(), lastPreview.id, "a refused preview dismissal cannot be reported as finished");
await savedStyleHost.completeParcelActivity({ kind: "preview", linkId: lastPreview.linkId });
assert.equal((await host.parcelActivityStatus()).previewing, false);
assert.deepEqual(nativeTabClosures, [lastReal.id, lastPreview.id]);
sharedMeta = { ...sharedMeta, mealStateRef: "different-meal-generation" };
assert.equal(host.nativePickupTabCloseId(), undefined, "a later card generation invalidates an old close hint");
meals = [{ ...brandedMeal, target: { mealId: "last-meal", mealScope: "synthetic-scope" } }];
assert.equal(await host.showShortcutPickupActivities([meals[0].target]), true);
const lastMeal = receipts().find(receipt => native.get(receipt.id)?.code === brandedMeal.code)!;
await savedStyleHost.completeParcelActivity({ kind: "meal", linkId: lastMeal.linkId });
await host.parcelActivityStatus();
assert.equal(completions.at(-1), "last-meal", "the meal App Intent uses the normal record completion");
assert.deepEqual(nativeTabClosures, [lastReal.id, lastPreview.id, lastMeal.id]);
unsubscribePreview();
assert.equal(activityUpdateListeners.size, 0, "native observation ends with the last subscriber");
await host.stopParcelActivity();

records = [];
await host.startAllParcelActivities();
const shortcut = createHost();
shortcut.parcelActivitySceneChanged("background");
const mealTarget = { mealScope: "synthetic-scope", mealId: "synthetic-meal" };
const firstTarget = { recordId: firstPickup.id };
records = [firstPickup, fourthPickup];
const mealDeadline = now + 60_000;
meals = [{ ...brandedMeal, target: mealTarget, code: "M1234", capturedAtMs: now + 3, expiresAtMs: mealDeadline }];
activitiesEnabled = false;
assert.equal(await shortcut.showShortcutPickupActivities([firstTarget]), false);
assert.deepEqual(activeCodes(), []);
activitiesEnabled = true;

const started = Promise.withResolvers<void>();
const releaseStart = Promise.withResolvers<void>();
onStart = () => { started.resolve(); return releaseStart.promise; };
const initial = shortcut.showShortcutPickupActivities([mealTarget, firstTarget]);
await started.promise;
const repeated = host.showShortcutPickupActivities([mealTarget, firstTarget]);
releaseStart.resolve();
assert.deepEqual(await Promise.all([initial, repeated]), [true, true]);
onStart = undefined;
assert.deepEqual(activeCodes(), ["M1234", firstPickup.code], "the background Shortcut only starts its committed records");
assert.ok([...native.values()].filter(item => item.state === "active").every(item => item.lockScreenStyle === "black"),
  "new meal and parcel activities from a background Shortcut use the saved style");
assert.equal(events.filter(event => event === "start M1234").length, 1, "two runtimes share one activity per record");
assert.equal(await shortcut.showShortcutPickupActivities([{ recordId: fourthPickup.id }]), false);
assert.deepEqual(activeCodes(), ["M1234", firstPickup.code], "a declined background start leaves existing cards visible");
host.parcelActivitySceneChanged("background");
host.reconcileParcelActivity(snapshot(), [independentPickupContent(firstPickup)!]);
await host.parcelActivityStatus();
assert.ok(activeCodes().includes("M1234"), "an older page snapshot cannot remove the new committed meal");
const mealActivity = [...native.values()].find(activity => activity.state === "active" && activity.code === "M1234")!;
capacity = 3;
await host.startParcelActivityPreview();
now = mealDeadline;
mealActivity.state = "stale";
failEnd = true;
assert.equal(await shortcut.showShortcutPickupActivities([firstTarget]), true,
  "a failed expiry cleanup preserves the requested Shortcut result");
assert.equal(mealActivity.state, "stale", "a failed end leaves the receipt available for retry");
failEnd = false;
assert.equal(await shortcut.showShortcutPickupActivities([firstTarget]), true);
assert.equal(mealActivity.state, "ended", "the background Shortcut retires the due meal at its next run");
assert.deepEqual(activeCodes(), [firstPickup.code, PARCEL_ACTIVITY_PREVIEW.code],
  "expiry leaves the valid parcel and the example visible");
await host.stopParcelActivity();
assert.equal(await shortcut.showShortcutPickupActivities([firstTarget]), false, "respect the saved Live Activity switch");

const activityCardSource = readFileSync(new URL("../components/ParcelLiveActivityCard.tsx", import.meta.url), "utf8");
const fullBox = readFileSync(new URL("../assets/parcel-activity/box.png", import.meta.url));
const watchBox = readFileSync(new URL(`../assets/parcel-activity/${PARCEL_LOCK_SCREEN_BOX}`, import.meta.url));
assert.deepEqual([fullBox.readUInt32BE(16), fullBox.readUInt32BE(20)], [300, 351]);
assert.deepEqual([watchBox.readUInt32BE(16), watchBox.readUInt32BE(20)], [100, 117]);
assert.match(activityCardSource, /const lockScreenBoxPath = [^\n]+FileManager\.isFileSync\(boxPath\)\s*\? boxPath/,
  "the lock screen prefers the full-resolution box");
assert.match(activityCardSource, /const artworkFile = [\s\S]*?\? mealImagePath : lockScreenBoxPath;/);
assert.match(activityCardSource, /<Image \{\.\.\.artworkImage\} resizable scaleToFit frame=\{artworkFrame\}/,
  "both artwork sources are drawn directly into the parcel canvas");
assert.match(activityCardSource, /<Image \{\.\.\.stickerImage\} resizable scaleToFit frame=\{\{ maxWidth: logoSize, maxHeight: logoSize \}\}/);
assert.match(activityCardSource, /const watchBoxFile = hasWatchBox \? watchBoxPath : lockScreenBoxPath;/,
  "the watch keeps the compact App Group asset when available");
assert.match(activityCardSource, /handoff \? "我已寄件" : "我已取件"/, "the pickup and handoff activities each show their completion capsule");
assert.match(activityCardSource, /background=\{expanded \? undefined : appearance\.background \?\? cardBackground\}/,
  "the Lock Screen defaults to the pickup gradient and the island uses system black");
assert.match(activityCardSource, /background=\{cardBackground\} allowsHitTesting=\{false\}/,
  "the Smart Stack presents the same gradient");
assert.doesNotMatch(activityCardSource, /glassEffect|UIGlass/, "both activity surfaces use the plain gradient");
assert.match(activityCardSource, /activityBackgroundTint="clear" widgetURL=\{url\}/);
assert.doesNotMatch(activityCardSource, /<(?:EnvironmentValuesReader|GeometryReader|Canvas)\b/,
  "the lock screen snapshots a complete view tree");
assert.match(activityCardSource, /frame=\{\{ \.\.\.slot\(bottom - top\), minWidth: 0, maxWidth: "infinity"/);
assert.match(activityCardSource, /systemName=\{isMeal \? "fork\.knife" : "shippingbox\.fill"\} font=\{card\.capsuleIcon \* scale\}/,
  "the meal capsule uses the original utensil symbol on the shared icon slot");
assert.match(activityCardSource, /isMeal \? "我已取餐"/);
const activityEntrySource = readFileSync(new URL("../live_activity.tsx", import.meta.url), "utf8");
assert.match(activityEntrySource, /content=\{<ParcelLiveActivityCard \{\.\.\.cardProps\} width=\{width\} lockScreen lockScreenStyle=\{data\.lockScreenStyle\} \/>\}/);
assert.match(activityEntrySource, /<LiveActivityUIExpandedCenter>\s*<ParcelLiveActivityCard \{\.\.\.cardProps\} width=\{width\} expanded \/>/,
  "the registered island uses the common Pipi card");
const islandAppearanceSource = activityEntrySource.match(/const expandedActionInset = [\s\S]*?^\};/m)?.[0];
assert.ok(islandAppearanceSource);
const islandAppearance = new Function("PIPI_CARD", islandAppearanceSource + "\nreturn expandedIslandAppearance;")({
  edge: 12, capsuleHeight: 35,
});
assert.deepEqual(islandAppearance.dynamicIslandContentMargins.expanded, { top: 0, leading: 12, trailing: 18, bottom: 18 },
  "the right and bottom edges share one clearance around the expanded capsule");
const activityScaleSource = activityCardSource.match(/  const widthScale = [\s\S]*?  const verticalScale = [\s\S]*?;/)?.[0];
assert.ok(activityScaleSource);
const activityScale = new Function("width", "card", "expanded", "lockScreen", "MAX_ACTIVITY_HEIGHT",
  activityScaleSource + "\nreturn { scale, verticalScale };");
const referenceCard = { width: 328, height: 132 };
for (const width of [320, 365, 380, 402]) {
  const islandScale = activityScale(width, referenceCard, true, false, 160);
  const lockScreenScale = activityScale(width, referenceCard, false, true, 160);
  assert.equal(islandScale.scale, lockScreenScale.scale, "both surfaces use the same horizontal scale");
  assert.equal(islandScale.verticalScale, Math.min(lockScreenScale.scale, 1),
    "the expanded row heights respect the constrained space below the camera");
  assert.equal(lockScreenScale.verticalScale, lockScreenScale.scale);
}
assert.match(activityEntrySource, /<LiveActivityUI\s*\{\.\.\.expandedIslandAppearance\}/);
assert.match(activityCardSource, /const artColumnWidth = expanded \? artWidth - card\.edge \* scale : artWidth;/,
  "the expanded host supplies the card's outside inset while the artwork keeps its regular size");
assert.match(activityCardSource, /minWidth: expanded \? artColumnWidth : Math\.min\(artWidth, MIN_COMPACT_ART_WIDTH\)/,
  "the expanded native host cannot squeeze the box into the Watch column");
const artworkLayoutSource = activityCardSource.match(/  const widthScale = [\s\S]*?  const artworkFrame = [\s\S]*?;/)?.[0];
assert.ok(artworkLayoutSource);
assert.match(activityCardSource, /background=\{\{ alignment: artworkAlignment, content: boxArtwork \}\}/);
assert.match(activityCardSource, /<ZStack frame=\{\{ width: artWidth, \.\.\.slot\(bottom - top\), alignment: artworkAlignment \}\}>\{appArtwork\}/);
assert.match(activityCardSource, /offset=\{\{ x: expanded \? -card\.edge \* scale : 0, y: artOffset \}\}/);
const artworkLayout = new Function("width", "card", "expanded", "lockScreen", "top", "MAX_ACTIVITY_HEIGHT",
  "isMeal", "MEAL_ARTWORK_TOKENS", artworkLayoutSource + "\nreturn { artworkFrame, scale, artOffset, artworkAlignment };");
const cardArtTop = Number(activityCardSource.match(/\bartTop: ([\d.]+),/)?.[1]);
assert.equal(cardArtTop, 1.5);
assert.equal(MEAL_ARTWORK_TOKENS.artTop, 9);
assert.equal(MEAL_ARTWORK_TOKENS.artTop + MEAL_ARTWORK_TOKENS.logoY, 72);
assert.match(activityCardSource, /const card = PIPI_CARD;/, "both kinds share the tuned parcel geometry and typography");
for (const width of [320, 328, 365, 374, 402]) {
  const box = { ...referenceCard, artWidth: 100, artHeight: 117, artTop: cardArtTop, edge: 12 };
  const titleTop = 16.3;
  const lock = artworkLayout(width, box, false, true, 0, 160, false, MEAL_ARTWORK_TOKENS);
  const island = artworkLayout(width, box, true, false, titleTop, 160, false, MEAL_ARTWORK_TOKENS);
  const scale = lock.scale;
  assert.equal(island.scale, scale, "the expanded island retains the lock screen artwork size");
  assert.equal(lock.artOffset, box.artTop * scale);
  assert.equal(lock.artworkAlignment, "topLeading", "keep the tuned parcel box placement");
  assert.equal(island.artOffset, (box.artTop - titleTop) * scale);
  assert.equal(island.artworkAlignment, "topLeading");
  assert.deepEqual(lock.artworkFrame, { maxWidth: box.artWidth * scale, maxHeight: box.artHeight * scale });
  assert.deepEqual(island.artworkFrame, { width: box.artWidth * scale, height: box.artHeight * scale });
  assert.deepEqual(artworkLayout(width, box, false, true, 0, 160, true, MEAL_ARTWORK_TOKENS),
    { ...lock, artOffset: 0, artworkAlignment: "leading" }, "only Lock Screen meal art moves to the vertical center");
  assert.deepEqual(artworkLayout(width, box, true, false, titleTop, 160, true, MEAL_ARTWORK_TOKENS), island);
  const home = artworkLayout(width, box, false, false, 0, 160, true, MEAL_ARTWORK_TOKENS);
  assert.equal(home.artOffset, MEAL_ARTWORK_TOKENS.artTop * (width / box.width));
  assert.equal(home.artworkAlignment, "topLeading");
}
assert.match(activityCardSource, /<VStack spacing=\{dividerToCapsule \* verticalScale\} fixedSize=\{\{ horizontal: false, vertical: true \}\} layoutPriority=\{1\}>\s*\{divider\}\s*\{bottomRow\}\s*<\/VStack>/,
  "the expanded divider and action share a fixed spacing container");
assert.match(activityCardSource, /slot\(dividerTop - titleTop, expandedHeaderMinimum\)[^\n]*>\s*\{expandedLine\(title, card\.titleHeight, card\.titleLineHeight\)\}\s*<Rectangle fill="clear" frame=\{slot\(gap, gap\)\} \/>\s*\{expandedLine\(location, card\.locationHeight, card\.locationLineHeight\)\}\s*<Rectangle fill="clear" frame=\{slot\(locationToDivider, locationToDivider\)\} \/>/,
  "the expanded text line frames release their spare height before the Pipi gaps shrink");
assert.match(activityCardSource, /fixedSize=\{\{ horizontal: false, vertical: true \}\}\s+frame=\{\{ minHeight: lineHeight \* verticalScale, alignment: "topLeading" \}\}/,
  "the expanded Pipi line heights distribute leading without shrinking text");
assert.match(activityCardSource, /const MIN_COMPACT_ART_WIDTH = PIPI_CARD\.artWidth \/ 2;/);
assert.match(activityCardSource, /titleFont: 16,[\s\S]*?locationFont: 12,[\s\S]*?codeFont: 26\.5,/);
assert.match(activityCardSource, /font=\{card\.titleFont \* scale\} fontWeight="semibold"/);
assert.match(activityCardSource, /font=\{card\.locationFont \* scale\} fontWeight="medium"/);
assert.match(activityCardSource, /font=\{card\.codeFont \* scale\} fontWeight="semibold" fontWidth="standard"[\s\S]*?kerning=\{0\}/,
  "the Pickup tab, Lock Screen and island all use the shared standard-width digits");
assert.doesNotMatch(activityCardSource, /balancedType|lockScreenPreview/);
assert.match(activityCardSource, /const SMART_STACK_ART_COLUMN_WIDTH = 56;/);
assert.match(activityCardSource, /const SMART_STACK_ART_WIDTH = 64;/);
assert.match(activityCardSource, /const SMART_STACK_ART_GAP = 4\.6;/);
assert.match(activityCardSource, /const SMART_STACK_ROW_GAP = 6;/);
assert.match(activityCardSource, /const SMART_STACK_TRAILING_INSET = 10;/);
assert.match(activityCardSource, /const SMART_STACK_CODE_FONT = 29;/);
const watchCardSource = activityCardSource.slice(activityCardSource.indexOf("const smartStack = ("));
assert.match(watchCardSource, /padding=\{\{ trailing: SMART_STACK_TRAILING_INSET \}\}/);
assert.match(watchCardSource, /<ZStack frame=\{watchArtFrame\} scaleEffect=\{SMART_STACK_ART_WIDTH \/ SMART_STACK_ART_COLUMN_WIDTH\}>/,
  "the Smart Stack centers the enlarged box without the iPhone artwork offset");
assert.ok(/\{data\.title\}<\/Text>\s*<HStack spacing=\{0\} frame=\{\{ minHeight: SMART_STACK_ROW_GAP, maxHeight: SMART_STACK_ROW_GAP, maxWidth: "infinity" \}\}[\s\S]*?\{dividerDots\(watchContentWidth, 1\)\}[\s\S]*?<Text font=\{SMART_STACK_CODE_FONT\}/.test(watchCardSource),
  "the Smart Stack uses its compact row gap around the dotted divider");
assert.match(watchCardSource, /offset=\{\{ x: 0, y: SMART_STACK_DIVIDER_INK_OFFSET \}\}/,
  "the Smart Stack positions the divider between visible letters and digits");
assert.match(activityCardSource, /const flexibleHeight = lockScreen \|\| expanded;/,
  "the system presentations can yield empty space at their native height limits");
const activitySettingsSource = readFileSync(new URL("../pages/PickupSettingsPages.tsx", import.meta.url), "utf8");
assert.equal((activitySettingsSource.match(/<ParcelActivityPreviewCard\b/g) ?? []).length, 1,
  "the setting contains one example card");
assert.match(activitySettingsSource, /<Picker title="锁屏样式" value=\{activity\.lockScreenStyle\} pickerStyle="menu"[^]*?<Text tag="dynamic">动态<\/Text>[^]*?<Text tag="black">纯黑<\/Text>[^]*?<Text tag="white">纯白<\/Text>/);
assert.match(activitySettingsSource, /const closePreview = \(\) => void change\(stopParcelActivityPreview\);/);
assert.match(activitySettingsSource, /<ParcelActivityPreviewCard lockScreenStyle=\{activity\.lockScreenStyle\}\s+onComplete=\{activity\.previewing \? closePreview : undefined\} actionPending=\{busy\} \/>/);
assert.doesNotMatch(watchCardSource, /\bappearance\b/, "the Watch Smart Stack keeps its existing palette");
const tabCardSource = readFileSync(new URL("../components/PickupTabCard.tsx", import.meta.url), "utf8");
assert.match(tabCardSource, /listRowInsets=\{0\}[\s\S]*?<ParcelLiveActivityCard\b/);
assert.match(tabCardSource, /background=\{\s*<GeometryReader\b/, "only the in-app row reads layout geometry");
assert.match(tabCardSource, /artwork=\{baseAsset \? <PickupTabArtwork\b/,
  "static and animated meals and parcels share the same app artwork loader");
assert.match(activitySettingsSource, /<Text>锁屏预览<\/Text>[\s\S]*?"stop\.circle" : "play\.circle"[\s\S]*?disabled=\{busy\}/);
assert.match(activitySettingsSource, /<Text>截屏识别<\/Text>[\s\S]*?「运行意图脚本」[\s\S]*?<Text>短信识别<\/Text>[\s\S]*?「运行意图脚本」/);
assert.doesNotMatch(activitySettingsSource, /「在 App 中运行意图」/);
assert.match(activitySettingsSource, /取件码和寄件码在「\$\{PICKUP_TAB_TITLE\}」中查看/);
assert.match(activitySettingsSource, /<Toggle title="实时活动"/);
assert.doesNotMatch(activitySettingsSource, /待取码|快递码|已显示|\bstartParcelActivity\b/,
  "the settings cannot start real cards individually");

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
const pickupProjection = appSource.match(/const pickupCards = useMemo\(\(\) => (\[[^\n]+\]),/);
assert.ok(pickupProjection);
const sameDayCards: ParcelActivityContent[] = runInNewContext(pickupProjection[1], {
  mealCards: [brandedMeal],
  shipments: [],
  state: undefined,
  activePickupCards: () => [PARCEL_ACTIVITY_PREVIEW],
});
assert.deepEqual(pickupDateSections(sameDayCards, false, "", exampleDay)[0].items.map(card => card.code),
  [brandedMeal.code, PARCEL_ACTIVITY_PREVIEW.code], "Pipi Home orders meals before parcels within a day");
const runSource = appSource.slice(appSource.indexOf("async function run()"), appSource.lastIndexOf("void run();"));
assert.match(runSource, /const initialStartup = await readStartupState\(\);[\s\S]*?initialPickupPreview = hasRegisteredParcelPreview\(\);[\s\S]*?await Navigation\.present/);
assert.doesNotMatch(runSource, /readPickupPreview\(/, "a slow native status read cannot delay presentation");
assert.match(appSource, /onParcelActivityChanged\(change => \{[\s\S]*?\}\);\s*if \(initialPickupPreview\) reload\(\);/,
  "a former preview is confirmed after mount");
assert.match(appSource, /\[pickupPreview, setPickupPreview\] = useState\(initialPickupPreview\)/,
  "a previously active preview shows its pickup tab on the first render");
assert.match(appSource, /useObservable<string>\(\s*navigationRequest\.pickupRecordId \? "pickup" : "deliveries"/);
assert.match(appSource, /const \{ visible: hasPickupTab, emptyArtwork \} = usePickupTabState\(pickupCards, pickupPreview, activityEndId\);/);
assert.match(appSource, /<PickupPage[^>]*emptyArtwork=\{emptyArtwork\}/);
assert.match(appSource, /if \(!hasPickupTab && selection\.value === "pickup"\) selection\.setValue\("deliveries"\)/);

const tabStateSource = stripTypeScriptTypes(appSource.slice(appSource.indexOf("function usePickupTabState("), appSource.indexOf("function App(")));
let tabRetained: boolean | undefined;
let previousDeps: unknown[] = [];
let refIndex = 0;
const visibilityRefs: { current: unknown }[] = [];
let nativeCloseId = "older-system-completion";
let scheduledEffect: (() => (() => void) | undefined) | undefined;
let cleanupVisibility: (() => void) | undefined;
let pendingHide: (() => void) | undefined;
const usePickupTabState = runInNewContext(tabStateSource + "\nusePickupTabState", {
  useState: (initial: boolean) => [tabRetained ??= initial, (visible: boolean) => { tabRetained = visible; }],
  useRef: (initial: unknown) => visibilityRefs[refIndex++] ?? (visibilityRefs[refIndex - 1] = { current: initial }),
  useEffect: (effect: typeof scheduledEffect, deps: unknown[]) => {
    if (deps.every((item, index) => item === previousDeps[index])) return;
    previousDeps = deps;
    scheduledEffect = effect;
  },
  setTimeout: (hide: () => void, delay: number) => {
    assert.equal(delay, 60_000);
    assert.equal(pendingHide, undefined, "only one timer can be pending");
    pendingHide = hide;
    return hide;
  },
  clearTimeout: (hide: () => void) => { if (pendingHide === hide) pendingHide = undefined; },
  nativePickupTabCloseId: () => nativeCloseId,
  writeDiagnostic: () => {},
});
function renderPickupTab(cards: readonly ParcelActivityContent[], previewing = false, activityEndId?: string) {
  refIndex = 0;
  const tab: { visible: boolean; emptyArtwork: "meal" | "parcel" } = usePickupTabState(cards, previewing, activityEndId);
  if (scheduledEffect) {
    cleanupVisibility?.();
    cleanupVisibility = scheduledEffect();
    scheduledEffect = undefined;
  }
  return tab;
}
const parcelCards = [PARCEL_ACTIVITY_PREVIEW];
function renderPickupVisibility(hasCards: boolean, activityEndId?: string): boolean {
  return renderPickupTab(hasCards ? parcelCards : [], false, activityEndId).visible;
}
assert.equal(renderPickupVisibility(false), false, "loading with no cards has no grace period");
assert.equal(renderPickupVisibility(true), true);
assert.equal(renderPickupVisibility(false), true, "removing the last card keeps the tab visible");
const firstHide = pendingHide;
assert.ok(firstHide);
assert.equal(renderPickupVisibility(false), true);
assert.equal(pendingHide, firstHide, "unrelated renders do not restart the minute");
assert.equal(renderPickupVisibility(true), true);
assert.equal(pendingHide, undefined, "a returning card cancels the timer");
assert.equal(renderPickupVisibility(false), true);
assert.notEqual(pendingHide, firstHide);
assert.ok(pendingHide);
pendingHide();
assert.equal(renderPickupVisibility(false), false, "a full minute with no cards hides the tab");
assert.equal(renderPickupVisibility(true), true);
nativeCloseId = "new-system-completion";
assert.equal(renderPickupVisibility(true, nativeCloseId), true, "a native signal cannot hide a card that's still on screen");
renderPickupVisibility(false, nativeCloseId);
assert.equal(renderPickupVisibility(false, nativeCloseId), false, "clearing the last card in the system hides the tab immediately");
assert.equal(pendingHide, undefined);
assert.equal(renderPickupVisibility(true, nativeCloseId), true);
assert.equal(renderPickupVisibility(false, nativeCloseId), true, "a later in-app completion gets a fresh minute");
assert.ok(pendingHide);

renderPickupTab([brandedMeal, ...parcelCards]);
renderPickupTab([brandedMeal]);
assert.equal(renderPickupTab([]).emptyArtwork, "meal", "a final meal chooses its artwork on the first empty frame");
renderPickupTab([brandedMeal, ...parcelCards]);
renderPickupTab(parcelCards);
assert.equal(renderPickupTab([]).emptyArtwork, "parcel", "a final parcel chooses its artwork on the first empty frame");
renderPickupTab([], true);
assert.equal(renderPickupTab([]).emptyArtwork, "meal", "the first preview-only round uses the drink");
assert.equal(renderPickupTab([]).emptyArtwork, "meal", "empty renders do not advance the preview round");
renderPickupTab(parcelCards, true);
renderPickupTab(parcelCards);
assert.equal(renderPickupTab([]).emptyArtwork, "parcel", "closing a preview while real cards remain keeps their artwork");
renderPickupTab([], true);
assert.equal(renderPickupTab([]).emptyArtwork, "parcel", "the next preview-only round uses the box");
renderPickupTab([], true);
assert.equal(renderPickupTab([]).emptyArtwork, "meal", "the preview alternates back to the drink");

assert.equal(PICKUP_TAB_TITLE, "待取");
assert.match(appSource, /\{hasPickupTab \? \(\s*<Tab key="pickup" title=\{PICKUP_TAB_TITLE\} systemImage="archivebox\.fill" value="pickup"[\s\S]*?<Tab key="deliveries" title="快递" systemImage="shippingbox\.fill" value="deliveries"/);
const pickupSource = readFileSync(new URL("../pages/PickupPage.tsx", import.meta.url), "utf8");
assert.match(pickupSource, /cardRow\(card, visible && sectionIndex === 0 && index === 0,\s*index < items.length - 1 \|\| preview\)/,
  "only the first visible row receives playback and spacing appears between cards in the same section");
assert.match(pickupSource, /await stopParcelActivityPreview\(\)/);
assert.match(pickupSource, /preview \? <ParcelActivityPreviewCard animate=\{visible && sectionIndex === 0 && items.length === 0\}\s+onComplete=\{\(\) => void closePreview\(\)\} actionPending=\{closingPreview\} \/>/,
  "a standalone preview retains its animation and a trailing preview uses the final frame");
const homeSource = readFileSync(new URL("../pages/HomePage.tsx", import.meta.url), "utf8");
for (const source of [homeSource, pickupSource, settingsSource]) {
  assert.match(source, /<NavigationStack>\s*<VStack navigationBarVisibility="hidden"[^]*?<RootTabList\b/,
    "each tab delegates its initial position and scroll layout to the same root");
  assert.doesNotMatch(source, /<List\b|<RootPageTitle\b|<RootPageCloseButton\b|listStyle=/);
}
assert.match(homeSource, /<RootTabList\b[^>]*\btitle="快递"/);
assert.match(pickupSource, /<RootTabList title=\{PICKUP_TAB_TITLE\} onClose=\{\(\) => dismiss\(\)\} bottomInset=\{TAB_FAB_SCROLL_INSET\}\s+emptyState=\{!sections\.length \? <EmptyTabState pickup=\{emptyArtwork\} \/> : undefined\}>/);
assert.match(settingsSource, /<RootTabList title="设置" onClose=\{\(\) => dismiss\(\)\}>/);
assert.doesNotMatch(pickupSource + settingsSource, /safeAreaInset=\{\{ top:|rootPageScroll|headerCollapsed/);
assert.doesNotMatch(pickupSource + settingsSource, /navigationTitle="(设置|待取|取件)"|navigationTitle=\{PICKUP_TAB_TITLE\}/);
const rootHeader = readFileSync(new URL("../components/RootPageHeader.tsx", import.meta.url), "utf8");
assert.match(rootHeader, /const header = \(\s*<Section key="root-heading" listSectionMargins=\{0\} listSectionSeparator="hidden"\s*animation=\{topAccessory === undefined \? undefined : \{ animation: Animation\.easeOut\(0\.18\), value: topAccessory !== null \}\}>\s*<RootPageTitle title=\{title\} onVisibilityChange=\{trackVisibility \? setTitleVisible : undefined\} \/>\s*\{topAccessory\}\s*<\/Section>/);
assert.match(rootHeader, /onScrollVisibilityChange=\{onVisibilityChange \? \{ onChanged: onVisibilityChange \} : undefined\}/);
assert.match(rootHeader, /<VStack opacity=\{titleVisible \? 1 : 0\} allowsHitTesting=\{titleVisible\} accessibilityHidden=\{!titleVisible\}\s*animation=\{\{ animation: Animation\.easeOut\(0\.18\), value: titleVisible \}\}>\s*\{titleAction\}\s*<\/VStack>/,
  "the query action fades while hit testing and accessibility follow title visibility immediately");
assert.match(rootHeader, /<List listStyle="insetGroup"[^]*?refreshable=\{refresh\}[^]*?edges: "top", insets: 0, placement: "scrollContent"[^]*?edges: "vertical", insets: \{ top: 0, bottom: bottomInset[^]*?>\s*\{\[header, \.\.\.\[children\]\.flat\(\)\]\}\s*<\/List>\s*<RootPageCloseButton action=\{onClose\} \/>/,
  "one grouped list scrolls every title and any filter from the same initial top inset under a fixed close control");
assert.doesNotMatch(rootHeader, /\bchildren=\{/,
  "Scripting's JSX factory receives the list rows as positional children");
assert.match(rootHeader, /function RootPageTitle[^]*?<Text font="largeTitle" fontWeight="bold"[^]*?\{title\}\s*<\/Text>/);
assert.match(rootHeader, /const HEADER_TOP_INSET = 4;/);
assert.match(rootHeader, /function RootPageTitle[^]*?minHeight: CLOSE_SIZE, alignment: "leading"[^]*?listRowInsets=\{\{ top: HEADER_TOP_INSET,/,
  "the large title shares the close control's initial vertical center");
assert.match(rootHeader, /function RootPageCloseButton[^]*?<VStack padding=\{\{ top: HEADER_TOP_INSET, trailing: ROOT_PAGE_MARGIN \}\}>\s*<Button title="关闭" systemImage="xmark"/);
assert.equal(rootHeader.match(/\{title\}\s*<\/Text>/g)?.length, 1);
assert.doesNotMatch(rootHeader, /navigationTitle|ToolbarItem|collapsed|import\s*\{[^}]*\bAnimation\b/);
assert.match(rootHeader, /const CLOSE_SIZE = 44;[^]*?labelStyle="iconOnly"[^]*?width: CLOSE_SIZE, height: CLOSE_SIZE/);
assert.match(pickupSource, /overlay=\{\{ alignment: "bottomTrailing", content: <IdentityCodeButton onOpen=\{openIdentity\}/,
  "the identity popover stays anchored to the bottom of the scrolling viewport");
assert.match(pickupSource, /onBindingUnavailable=\{\(\) => void openIdentity\(identity\.platform\)\}/,
  "an identity page whose binding expires uses the same app handoff as the picker");
assert.match(pickupSource, /<HStack spacing=\{0\} popover=\{\{\s*isPresented: showPicker,\s*onChanged: setShowPicker,/,
  "the containing row owns the reference popover binding");
assert.match(pickupSource, /<TabFloatingActionButton title="身份码" symbol="person\.text\.rectangle"/);
const floatingButtonSource = readFileSync(new URL("../components/TabFloatingActionButton.tsx", import.meta.url), "utf8");
assert.match(floatingButtonSource, /<Label title=\{title\} systemImage=\{symbol\} labelStyle="iconOnly"/,
  "both floating actions use a symbol-only label");
assert.match(pickupSource, /onLocationTap=\{canSwitch \? \(\) => setShowAddress\(!showAddress\)/);
const stationIdentitySource = readFileSync(new URL("../pages/StationIdentityPage.tsx", import.meta.url), "utf8");
assert.match(stationIdentitySource,
  /<Button buttonStyle="plain" listRowInsets=\{DETAIL_ROW_INSETS\} action=\{\(\) => void openRecovery\("app"\)\}>\s*<Text font=\{16\} foregroundStyle="accentColor"\s*frame=\{\{ maxWidth: "infinity", minHeight: DETAIL_ROW_HEIGHT \}\} contentShape="rect">\s*在\{providerName\}内打开/,
  "the provider app action centers its label across the form row");
assert.doesNotMatch(stationIdentitySource, /在网页打开|在拼多多 App 中打开/);
assert.match(stationIdentitySource, /后自动刷新` : "正在自动刷新…"/);
assert.match(stationIdentitySource, />点击条形码或二维码可放大刷新<\/Text>/);
assert.match(stationIdentitySource, />点击可缩小<\/Text>/);
assert.match(stationIdentitySource, /rotationEffect=\{portrait \? 90 : 0\}[\s\S]*?<Barcode[\s\S]*?\{number\}\{shrink\}\{time\}/,
  "the countdown stays with the rotated barcode and its labels");
assert.match(stationIdentitySource, /<QRImage data=\{value\} size=\{qrSize\}[\s\S]*?\{number\}\{shrink\}\s*\{time\}/,
  "the enlarged QR has the same live countdown");
assert.match(stationIdentitySource, /preferredColorScheme="light"\s+contentShape="rect" onTapGesture=\{onClose\}/);
assert.doesNotMatch(stationIdentitySource, /title="关闭" systemImage="xmark"/);
assert.match(stationIdentitySource, /header=\{detailTitle\("取件人"\)\}[\s\S]*?listRowInsets=\{DETAIL_ROW_INSETS\}[\s\S]*?header=\{detailTitle\("身份码编号"\)\}[\s\S]*?listRowInsets=\{DETAIL_ROW_INSETS\}/);
assert.match(stationIdentitySource,
  /const showNumber = valid \|\| \(platform === "cainiao" && !busy && failure !== null\);[^]*?\{showNumber \? \([^]*?action=\{onSwitchCainiao\}[^]*?\{valid \? value\.replace\([^\n]*? : "暂无编号"\}[^]*?\{valid \? <Button[^]*?action=\{\(\) => void copyIdentity\(\)\}/,
  "the number row and variant switch require a valid code or a completed Cainiao failure");
assert.match(stationIdentitySource,
  /async function copyIdentity\(\) \{\s*if \(!value \|\| !currentSession\(\) \|\| expiresAtMs <= Date\.now\(\)\) return;\s*const result = await copyText\(value\);/,
  "copying rechecks the identity and expiration before touching the pasteboard");
assert.match(stationIdentitySource,
  /foregroundStyle=\{valid \? "label" : "secondaryLabel"\}[^]*?frame=\{\{ maxWidth: "infinity", alignment: valid \? "leading" : "trailing" \}\}[^]*? : "暂无编号"\}/,
  "the unavailable number uses the form's trailing secondary value alignment");
assert.match(stationIdentitySource,
  /<Section key="identity-number" transition=\{revealResult\} header=\{detailTitle\("身份码编号"\)\}\s+footer=\{platform === "cainiao" \? \(\s*<Text font="footnote" foregroundStyle="secondaryLabel">点击图标切换淘宝身份码与菜鸟出库码<\/Text>\s*\) : undefined\}>/,
  "the switch hint is a form footer below the Cainiao number card");
assert.match(stationIdentitySource, /<StationIdentityContent key=\{`\$\{generation\}:\$\{variant\}`\}/,
  "switching providers or bindings discards the previous scan immediately");
assert.match(stationIdentitySource, /const revealResult = Transition\.asymmetric\(Transition\.opacity\(\), Transition\.identity\(\)\)/);
assert.match(stationIdentitySource, /<Form navigationTitle=\{IDENTITY_CODE_TITLES\[variant\]\}[^]*?animation=\{\{ animation: Animation\.easeOut\(0\.18\), value: `\$\{valid\}:\$\{showNumber\}:\$\{showRecovery\}` \}\}/,
  "only result visibility drives the form transition, so countdown ticks cannot restart it");
assert.match(stationIdentitySource, /listRowInsets=\{valid \? SCAN_ROW_INSETS : DETAIL_ROW_INSETS\}/);
assert.match(stationIdentitySource, /<Text font=\{16\} foregroundStyle="secondaryLabel" multilineTextAlignment="center"\s*frame=\{\{ maxWidth: "infinity", minHeight: DETAIL_ROW_HEIGHT \}\}>\s*\{status\}/,
  "an unavailable scan uses the shared detail-row height and insets");
assert.match(stationIdentitySource, /\{\.\.\.tabCapsuleSurface\(true\)\}>复制<\/Text>/);
assert.doesNotMatch(stationIdentitySource, /presentPlatformLogin|授权拼多多|登录淘宝/,
  "the identity page does not present an account setup form");
assert.match(stationIdentitySource, /<QRImage data=\{value\} size=\{184\} \/>/,
  "the card pairs a QR code with the barcode for every valid identity");
assert.match(stationIdentitySource, /<QRImage data=\{value\} size=\{qrSize\} \/>/,
  "the full-screen QR uses the same current identity payload");

console.log("parcel OCR, tab entry, and Activity lifecycle tests passed");
