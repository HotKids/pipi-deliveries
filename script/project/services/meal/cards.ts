import { cachedMealRules } from "../carrier-authority";
import type { ParcelActivityContent } from "../parcel-pickup";
import { currentMeal, readMeals, type MealPayload, type MealSnapshot } from "./records";
import { resolvePickupVisualStyle } from "./pickup-artwork";
import { mealCredentialScope } from "./rules";

export function mealRedemption(payload: MealPayload): string {
  return (payload.brandId === "chayanyuese" || payload.brandId === "ruixing") && payload.qrPayload?.trim()
    ? payload.qrPayload : "";
}

export function mealCard(scope: string, id: string, state: MealSnapshot, now: number): ParcelActivityContent | null {
  if (!scope) return null;
  const payload = currentMeal(state, id, now);
  if (!payload) return null;
  const hasQR = Boolean(mealRedemption(payload));
  const code = hasQR ? "待取餐" : payload.code?.trim();
  if (!code) return null;
  const rules = cachedMealRules();
  const mealStyle = state.style[id] ?? (rules ? resolvePickupVisualStyle(rules.raw, {
    brandId: payload.brandId, productName: payload.productName ?? "", evidenceText: "",
  }) : undefined);
  return {
    target: { mealId: id, mealScope: scope }, kind: "meal",
    capturedAtMs: payload.createdAt, expiresAtMs: payload.expiresAt,
    title: payload.productName?.trim() || payload.brandName?.trim() || "取餐码",
    location: payload.merchantName?.trim() || "",
    code, mealStyle, mealBrandId: payload.brandId, hasMealQR: hasQR,
  };
}

export function activeMealCards(now = Date.now()): ParcelActivityContent[] {
  const scope = mealCredentialScope();
  if (!scope) return [];
  const state = readMeals(scope);
  return [...new Set([...Object.keys(state.remote), ...Object.keys(state.edits)])]
    .map(id => mealCard(scope, id, state, now)).filter((card): card is ParcelActivityContent => card !== null)
    .sort((a, b) => (b.capturedAtMs ?? 0) - (a.capturedAtMs ?? 0));
}
