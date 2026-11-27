import { cachedMealRules } from "../carrier-authority";
import { mealCompactCode, type ParcelActivityContent } from "../parcel-pickup";
import { currentMeal, readMeals, updateMeals, type MealPayload, type MealSnapshot } from "./records";
import { alternateMealArtwork, resolvePickupVisualStyle } from "./pickup-artwork";
import { mealCredentialScope } from "./rules";

export function mealRedemption({ brandId, code, qrPayload }: MealPayload) {
  if (!qrPayload?.trim()) return undefined;
  if (brandId === "chayanyuese" && !code?.trim()) return { payload: qrPayload, label: "待核销", title: "核销码", prompt: "请扫码核销" };
  if (brandId === "ruixing") return { payload: qrPayload, label: code?.trim() || "待取餐", title: "取餐码", prompt: "请扫码取餐" };
}

function mealStyleFor(payload: MealPayload, stored: MealSnapshot["style"][string] | undefined) {
  if (stored && (!payload.drinkTemperature || stored.drinkTemperature === payload.drinkTemperature)) return stored;
  const rules = cachedMealRules();
  return rules ? resolvePickupVisualStyle(rules.raw, {
    brandId: payload.brandId, productName: payload.productName ?? "", evidenceText: "", drinkTemperature: payload.drinkTemperature,
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
  const brandName = payload.brandName?.trim() || "";
  const merchantName = payload.merchantName?.trim() || "";
  return {
    target: { mealId: id, mealScope: scope }, kind: "meal",
    capturedAtMs: payload.createdAt, expiresAtMs: payload.expiresAt,
    title: payload.productName?.trim() || brandName || "取餐码",
    location: merchantName && merchantName !== brandName ? merchantName : "",
    code, mealCompactCode: mealCompactCode(payload), mealStyle, mealBrandId: payload.brandId, hasMealQR: Boolean(redemption),
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
    changed = Boolean(payload && style && artworkAsset && style.artworkAsset === card.mealStyle?.artworkAsset);
    if (!changed || !payload || !style || !artworkAsset) return state;
    const drinkTemperature = artworkAsset === style.temperaturePair?.hot ? "hot" as const
      : artworkAsset === style.temperaturePair?.cold ? "cold" as const
      : style.drinkTemperature;
    const pending = state.edits[target.mealId];
    const mutationId = typeof UUID !== "undefined" ? UUID.string().toLowerCase() : `cup-${now}-${artworkAsset}`;
    return {
      ...state,
      style: { ...state.style, [target.mealId]: { ...style, artworkAsset, ...(drinkTemperature ? { drinkTemperature } : {}) } },
      edits: {
        ...state.edits,
        [target.mealId]: {
          mutationId,
          editedAt: now,
          payload: drinkTemperature ? { ...payload, drinkTemperature } : payload,
          ...(!pending || pending.requiresExisting ? { requiresExisting: true as const } : {}),
        },
      },
    };
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
