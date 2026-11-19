import type { ColorStringHex } from "scripting";
import { carrierArtworkAccent } from "./carrier-presentation";
import type { ParcelActivityContent } from "./parcel-pickup";
import { blendStatusColor, rgbLuminance } from "./status";

export const PARCEL_LOCK_SCREEN_BOX = "box-lock-screen.png";

const STATION_ACCENT = { cainiao: "#0167FE", pinduoduo: "#EA0D15", fengchao: "#FED043" } as const;
const HANDOFF_ACCENT = { cainiao: "#016DFE", pinduoduo: "#F22308" } as const;
const COURIER_STICKERS = new Set([
  "danniao", "dbl", "ems", "jd", "jtsd", "kysy", "sf", "sto", "uc", "yd", "yto", "yzpy", "zjs", "zto",
]);

function mealAsset(asset?: string) {
  if (!asset || !/^[\w.-]+\.(?:png|webp)$/iu.test(asset)) return undefined;
  const filename = asset.replace(/\.webp$/iu, ".png");
  return { path: `meal-pickup/${filename}`, name: filename };
}

export function parcelCardArtwork(card: ParcelActivityContent) {
  if (card.kind === "meal") return {
    meal: mealAsset(card.mealStyle?.artworkAsset),
    mealSticker: mealAsset(card.mealStyle?.stickerAsset),
    mark: mealAsset(card.mealBrandId ? `brand-${card.mealBrandId}.png` : undefined),
  };
  const platform = card.platform;
  const icon = card.carrierIcon === "jdshopping" ? "jd" : card.carrierIcon;
  if (icon && card.kind !== "handoff" && COURIER_STICKERS.has(icon)) {
    return {
      sticker: { path: `parcel-activity/${icon}.png`, name: `${icon}.png` },
      mark: { path: `couriers/${card.carrierIcon}.png`, name: `carrier-${card.carrierIcon}.png` },
      accent: carrierArtworkAccent(card.carrierIcon ?? icon),
    };
  }
  if (!platform) return {};
  const mark = { path: `platform-accounts/${platform}.png`, name: `brand-${platform}.png` };
  if (card.kind === "handoff" && platform !== "fengchao") {
    return { mark, sticker: mark, accent: HANDOFF_ACCENT[platform] };
  }
  return {
    mark, sticker: { path: `parcel-activity/${platform}.png`, name: `${platform}.png` },
    accent: STATION_ACCENT[platform],
  };
}

const WHITE = 0xffffff;
const LEFT = 0x22262d;
const RIGHT = 0x38232d;
const OVERLAY = 0x1f / 0xff;

function asColor(value: number): ColorStringHex {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function contrast(first: number, second: number): number {
  const a = rgbLuminance(first) + 0.05;
  const b = rgbLuminance(second) + 0.05;
  return Math.max(a, b) / Math.min(a, b);
}

// Pipi's ExpressPickupCardPresentation.Palette uses the logo on the button and
// code, with a 0x1F overlay and separate contrast adjustments against each surface.
export function pickupCardPalette(card: ParcelActivityContent) {
  const meal = card.kind === "meal" ? card.mealStyle : undefined;
  return meal ? {
    gradient: [meal.gradientStartColor as ColorStringHex, meal.gradientEndColor as ColorStringHex] as const,
    code: meal.codeColor as ColorStringHex,
    capsule: meal.buttonColor as ColorStringHex,
    capsuleForeground: meal.buttonForegroundColor as ColorStringHex,
  } : { ...parcelCardPalette(parcelCardArtwork(card).accent), capsuleForeground: "white" as const };
}

export function parcelCardPalette(accent?: string) {
  if (!accent) return { gradient: [asColor(LEFT), asColor(RIGHT)], code: "white",
    capsule: "rgba(255,255,255,0.16)" } as const;
  const brand = Number.parseInt(accent.slice(1), 16);
  const right = blendStatusColor(RIGHT, brand, OVERLAY);
  let code = brand;
  for (let step = 1; step <= 20 && contrast(code, right) < 3; step++) {
    code = blendStatusColor(brand, WHITE, step * 0.05);
  }
  let capsule = brand;
  const brightness = Math.max(brand >> 16, brand >> 8 & 255, brand & 255);
  if (Math.round(brightness / 255 * 100) > 95) {
    for (let step = 1; step <= 100 && contrast(WHITE, capsule) < 3; step++) {
      capsule = blendStatusColor(brand, 0, step * 0.01);
    }
  }
  return { gradient: [asColor(blendStatusColor(LEFT, brand, OVERLAY)), asColor(right)],
    code: asColor(code), capsule: asColor(capsule) };
}
