import { cachedMealRules } from "../carrier-authority";
import type { ParcelActivityContent } from "../parcel-pickup";
import { currentMeal, readMeals, updateMeals, type MealPayload, type MealSnapshot } from "./records";
import { alternateMealArtwork, resolvePickupVisualStyle } from "./pickup-artwork";
import { mealCredentialScope } from "./rules";

export function mealRedemption({ brandId, code, qrPayload }: MealPayload) {
  if (!qrPayload?.trim()) return undefined;
  const original = { payload: qrPayload, number: code?.trim() };
  if (brandId === "chayanyuese") return { ...original, label: "待核销", title: "核销码" };
  if (brandId === "ruixing") return { ...original, label: "待取餐", title: "取餐码" };
}

function mealStyleFor(payload: MealPayload, stored: MealSnapshot["style"][string] | undefined) {
  if (stored) return stored;
  const rules = cachedMealRules();
  return rules ? resolvePickupVisualStyle(rules.raw, {
    brandId: payload.brandId, productName: payload.productName ?? "", evidenceText: "",
  }) : undefined;
}

export function mealCard(scope: string, id: string, state: MealSnapshot, now: number): ParcelActivityContent | null {
  if (!scope) return null;
  const payload = currentMeal(state, id, now);
  if (!payload) return null;
  const redemption = mealRedemption(payload);
  const code = redemption?.label ?? payload.code?.trim();
  if (!code) return null;
  const mealStyle = mealStyleFor(payload, state.style[id]);
  return {
    target: { mealId: id, mealScope: scope }, kind: "meal",
    capturedAtMs: payload.createdAt, expiresAtMs: payload.expiresAt,
    title: payload.productName?.trim() || payload.brandName?.trim() || "取餐码",
    location: payload.merchantName?.trim() || "",
    code, mealStyle, mealBrandId: payload.brandId, hasMealQR: Boolean(redemption),
    ...(alternateMealArtwork(mealStyle) ? { artworkSwitchable: true } : {}),
  };
}

export function toggleMealCup(card: ParcelActivityContent, now = Date.now()): boolean {
  const target = card.target;
  if (!target || !("mealId" in target) || target.mealScope !== mealCredentialScope()) return false;
  let changed = false;
  updateMeals(target.mealScope, state => {
    const payload = currentMeal(state, target.mealId, now);
    const style = payload && mealStyleFor(payload, state.style[target.mealId]);
    const artworkAsset = alternateMealArtwork(style);
    changed = Boolean(style && artworkAsset && style.artworkAsset === card.mealStyle?.artworkAsset);
    return changed && style && artworkAsset
      ? { ...state, style: { ...state.style, [target.mealId]: { ...style, artworkAsset } } }
      : state;
  });
  return changed;
}

export function activeMealCards(now = Date.now()): ParcelActivityContent[] {
  const scope = mealCredentialScope();
  if (!scope) return [];
  const state = readMeals(scope);
  return [...new Set([...Object.keys(state.remote), ...Object.keys(state.edits)])]
    .map(id => mealCard(scope, id, state, now)).filter((card): card is ParcelActivityContent => card !== null)
    .sort((a, b) => (b.capturedAtMs ?? 0) - (a.capturedAtMs ?? 0));
}
