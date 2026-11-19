import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installSharedFileMock } from "./shared-file-mock";
import { createPickupRuntime } from "../services/meal/pickup-runtime";
import { parsePickupCredentials } from "../services/meal/pickup-parser";
import { chineseParentheses, mealFromModel, onlineMealRequiresQR, recognizeMealText } from "../services/meal/recognize";
import { decodeMealQRs } from "../services/meal/qr";
import { completeMeal, currentMeal, putMealObservations, readMeals, stageLuckinDraft, updateMeals,
  type MealEnvelope, type MealSession } from "../services/meal/records";
import { applyMealPage, applyMealReceipt, mealPullRequest, prepareMealBatch, recoverMealConflict } from "../services/meal/cloud";

const raw = JSON.parse(readFileSync(new URL("../../../meal-pickup-rules.json", import.meta.url), "utf8"));
const rules = { raw, parsed: createPickupRuntime(raw) };
const now = Date.UTC(2026, 10, 19, 0);
const width = 1179, height = 1050;
function candidates(rows: readonly [string, number, number?, number?][]) {
  return rows.map(([content, top, left = 30, right = 540]) => ({
    content, boundingBox: { x: left / width, y: 1 - (top + 30) / height, width: (right - left) / width, height: 30 / height },
  }));
}

const firstPage = candidates([
  ["瑞幸咖啡", 40], ["精心制作中", 90, 30, 250], ["取餐码", 90, 900, 1050],
  ["万丰海岸城2楼平台店 (NO.17221)", 260, 30, 620],
  ["耶加雪菲·美式", 430, 250, 560], ["小黑杯/冰/不另外加糖", 490, 250, 650], ["共1件商品", 650, 30, 250],
]);
const order = recognizeMealText(firstPage, width, height, now, [], rules);
assert.deepEqual(order.meals, []);
assert.equal(order.draft?.payload.brandId, "ruixing");
assert.equal(order.draft?.payload.productName, "耶加雪菲·美式");
assert.equal(order.draft?.payload.merchantName, "万丰海岸城2楼平台店");
assert.equal(order.draft?.payload.itemCount, 1);
assert.equal(order.draft?.payload.status, "制作中");
assert.deepEqual(recognizeMealText([...firstPage, ...candidates([["订单已取消", 170]])], width, height, now, [], rules), { meals: [] });

const modal = candidates([["瑞幸咖啡", 100], ["取餐码 949", 180], ["待取餐", 250]]);
const second = (at: number, barcodes: string[]) => recognizeMealText(modal, width, height, at, barcodes, rules);
assert.deepEqual(second(now + 1, []).meals, []);
assert.deepEqual(second(now + 1, ["wrong-format"]).meals, []);
const match = second(now + 1, ["a1234567AA0="]).meals[0];
assert.equal(match?.payload.code, "949");
assert.equal(match?.payload.qrPayload, "a1234567AA0=");
assert.equal(match?.payload.brandId, "ruixing");

const redemption = candidates([["待扫码核销", 60], ["霸王茶姬小主", 110], ["深圳前海壹方城游园会店", 210],
  ["幽兰拿铁", 400], ["小杯/冰", 450], ["共1件商品", 490], ["实付 00.50", 540]]);
const tea = (qr: string[]) => recognizeMealText(redemption, width, height, now, qr, rules).meals[0];
assert.equal(tea([]), undefined);
assert.equal(tea(["first", "second"]), undefined);
const decoded = tea([" SYNTHETIC QR ", " SYNTHETIC QR "])?.payload;
assert.equal(decoded?.brandId, "chayanyuese");
assert.equal(decoded?.code, "");
assert.equal(decoded?.productName, "幽兰拿铁");
assert.equal(decoded?.merchantName, "深圳前海壹方城游园会店");
assert.equal(decoded?.qrPayload, " SYNTHETIC QR ");
assert.equal(decoded?.totalAmount, "00.50");
assert.equal(decoded?.expiresAt, now + 7200000);
assert.equal(onlineMealRequiresQR({ productName: "幽兰拿铁" }, rules), true);
assert.equal(onlineMealRequiresQR({ brand: "星巴克" }, rules), false);
assert.equal(mealFromModel({ brand: "星巴克", productName: "馥芮白®", pickupCode: "0123", productSpec: "大杯冰" }, now, rules)?.payload.productName, "馥芮白");
assert.equal(chineseParentheses("咖啡 (大杯) (L)"), "咖啡 （大杯） (L)");

// The Android scenario union uses this order summary and its distinct product row.
const starbucks = recognizeMealText(candidates([
  ["啡快口令", 90, 30, 180], ["“2./心间有彩虹”", 140, 30, 360], ["制作中,预计取餐时间 11:24", 250, 30, 420],
  ["星巴克(深圳沙井海岸城店)提供会议/茶歇... >", 520, 30, 600],
  ["广东省深圳市宝安区新桥街道万丰中路与丰山三路交界处海岸...", 580, 30, 720],
  ["太妃榛果拿铁", 680, 30, 300], ["女2杯饮品或1饮1食品套餐7折券-¥ 24.6", 750, 30, 600], ["X2", 810, 30, 90],
  ["大怀热/原萃浓缩/全脂牛奶/经典浓缩 (深烘)/经典糖/标", 880, 30, 720],
  ["准搅打稀奶油/少少甜/浓缩份数", 930, 30, 480], ["指定套餐7折析余 O次", 980, 30, 360], ["晒口令", 90, 520, 650],
]), width, height, now, [], rules).meals[0]?.payload;
assert.equal(starbucks?.brandId, "xingbake");
assert.equal(starbucks?.code, "2.心间有彩虹");
assert.equal(starbucks?.merchantName, "深圳沙井海岸城店");
assert.equal(starbucks?.productName, "太妃榛果拿铁");

assert.deepEqual(parsePickupCredentials({ blocks: [], recognizedAtMs: now, screenWidth: width }, rules.parsed), []);

const pixels = (grids: string[][]) => {
  const scale = 5, margin = 16;
  const width = 400, height = 180;
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [index, grid] of grids.entries()) for (const [y, row] of grid.entries()) {
    for (const [x, bit] of [...row].entries()) {
      if (bit !== "1") continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const pixel = ((y * scale + margin + dy) * width + x * scale + margin + index * 180 + dx) * 4;
        rgba.fill(0, pixel, pixel + 3);
      }
    }
  }
  return decodeMealQRs(rgba, width, height);
};
const qr0 = `
00000000000000000000000
01111111010001010000010
01000001000100010000110
01011101010101001101010
01011101000100010000100
01011101011010111101110
01000001001011100111000
01111111000110110110010
00000000010010100110100
01101001011101011000010
01111110001000010111100
01101101011101000100010
01000010010100011001100
01010101000110000100100
00000000001011000000000
01111111010101011111110
01000001001001010000010
01011101011001010111010
01011101000111010111010
01011101000100010111010
01000001010110010000010
01111111001000011111110
00000000000000000000000
`.trim().split("\n");
const qr1 = `
00000000000000000000000
01111111011101001000000
01000001001011110000010
01011101010101010010000
01011101010111111001000
01011101011110001001100
01000001011100000111010
01111111001110001010100
00000000011001001101010
01000111010001010011100
00110000101011101111100
00111001001001010001100
00001100101111001001000
01011111000110011111000
00000000011000000000000
01111111010101011111110
01000001011110010000010
01011101010101010111010
01011101010110010111010
01011101011001010111010
01000001000101010000010
01111111000100011111110
00000000000000000000000
`.trim().split("\n");
assert.deepEqual(pixels([]), []);
assert.deepEqual(pixels([qr0]), ["00-SYNTH-A"]);
assert.deepEqual(pixels([qr0, qr0]), ["00-SYNTH-A"]);
assert.deepEqual(new Set(pixels([qr0, qr1])), new Set(["00-SYNTH-A", " 00-SYNTH-B "]));

const memory = new Map<string, unknown>();
installSharedFileMock(memory);
const scope = "a".repeat(64);
stageLuckinDraft(scope, order.draft!);
assert.deepEqual(readMeals(scope).edits, {}, "a first-page draft is never uploaded");
const [picked] = putMealObservations(scope, [match!], true);
assert.equal(readMeals(scope).luckinDraft, undefined);
assert.equal(currentMeal(readMeals(scope), picked, now)?.productName, "耶加雪菲·美式");
assert.equal(currentMeal(readMeals(scope), picked, now)?.qrPayload, "a1234567AA0=");
assert.equal(currentMeal(readMeals("b".repeat(64)), picked, now), undefined);
stageLuckinDraft(scope, order.draft!);
const [separate] = putMealObservations(scope, [second(now + 120001, ["a1234567AA0="]).meals[0]], true);
assert.notEqual(currentMeal(readMeals(scope), separate, now)?.productName, "耶加雪菲·美式");
assert.equal(completeMeal(scope, picked, now + 5), true);
assert.equal(currentMeal(readMeals(scope), picked, now + 5), undefined);
assert.ok(currentMeal(readMeals(scope), separate, now + 5));

const id = (n: number) => "4d953a34-7399-5d91-a36b-" + String(n).padStart(12, "0");
const session: MealSession = { ownerId: "a".repeat(64), endpointId: "scripting-meal:" + "b".repeat(64), epoch: id(1),
  generation: 1, nextSequence: 1 };
const response = { ...session, ok: true, schemaVersion: 1, enabled: true };
const first = updateMeals(scope, state => ({ ...state, session }));
const initial = { ...response, mode: "snapshot", reset: true, cursor: 0, hasMore: false, pageToken: null, records: [] };
const empty = applyMealPage(first, first, initial);
assert.equal(mealPullRequest(empty).epoch, session.epoch, "an empty completed snapshot proceeds to delta");
const frozen = prepareMealBatch(empty, now + 6, id(20));
const batch = frozen.batch!;
assert.equal(batch.mutations[0].payload.completedAt, now + 5);
assert.equal(batch.mutations[0].lifecycle, "history");
assert.equal(prepareMealBatch(frozen, now + 100, id(21)).batch, batch);
const receipt = { ...response, nextSequence: 2, sequence: 1, results: [{ recordId: picked,
  mutationId: batch.mutations[0].mutationId, revision: 1, editedAt: now + 5, deleted: false }] };
const committed = applyMealReceipt(frozen, batch, receipt);
assert.equal(committed.cursor, 0);
assert.equal(committed.edits[picked], undefined);
assert.equal(committed.remote[picked].lifecycle, "history");
assert.equal(applyMealReceipt(committed, batch, receipt), committed);
const afterConflict = recoverMealConflict(frozen, batch, { ...response, error: "revision_conflict", requestId: batch.requestId,
  sequence: 1, requestGeneration: session.generation, mutationOutcome: "not_committed",
  conflicts: [{ recordId: picked, current: { recordId: picked, type: "meal_pickup", revision: 2, changedAt: now + 100,
    editedAt: now + 100, deleted: true, lifecycle: "active", historyAt: 0, reason: "user" } satisfies MealEnvelope }] });
assert.equal(afterConflict.edits[picked], undefined);
assert.equal(afterConflict.remote[picked].deleted, true);
assert.equal(afterConflict.batch, undefined);
const away = applyMealPage(committed, committed, { ...response, nextSequence: 2,
  mode: "snapshot", reset: true, cursor: 3, pageToken: "continuation", hasMore: true, records: [] });
assert.equal(away.cursor, 0, "hidden filtered pages cannot commit a partial reset");
assert.ok(away.remote[picked]);
assert.equal(mealPullRequest(away).pageToken, "continuation");
console.log("Meal pickup, QR, local outbox and cloud recovery tests passed");
