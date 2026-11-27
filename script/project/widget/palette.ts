import type { ColorStringHex, ColorStringRGBA } from "scripting";
import { carrierArtworkAccent, courierIconName } from "../services/carrier-presentation";
import type { StatusSemantic } from "../models";
import { brandGradientStatusTint, statusBadgeFillTint } from "../services/status";
import { PARCEL_STATUS_BADGE_OPACITY } from "../services/status-tones.generated";

// Owner 2026-11-27 (修改 29): capsule base colour at 12% (light) / 22% (dark); text keeps the shared pair
// unless the carrier brand gradient pushes it under the 3.0:1 floor.
export function widgetStatusStyle(semantic: StatusSemantic, brandAccent: string, label = "") {
  return {
    background: statusBadgeFillTint(semantic, { label }),
    foreground: brandGradientStatusTint(semantic, {
      brandAccent,
      badgeOpacity: PARCEL_STATUS_BADGE_OPACITY,
      label,
    }),
  } as const;
}

const SENDER_TAG_BACKGROUND = {
  light: "rgba(117, 117, 117, 0.12)" as ColorStringRGBA,
  dark: "rgba(117, 117, 117, 0.22)" as ColorStringRGBA,
} as const;

const SENDER_TAG_INK: Readonly<{ light: RGB; dark: RGB }> = {
  light: [0x61, 0x61, 0x61],
  dark: [0xbd, 0xbd, 0xbd],
};

function srgbLuminance([r, g, b]: RGB): number {
  const linear = (channel: number) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function rgbContrast(a: RGB, b: RGB): number {
  const la = srgbLuminance(a);
  const lb = srgbLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function blendRGB(base: RGB, overlay: RGB, amount: number): RGB {
  return [
    Math.round(base[0] + (overlay[0] - base[0]) * amount),
    Math.round(base[1] + (overlay[1] - base[1]) * amount),
    Math.round(base[2] + (overlay[2] - base[2]) * amount),
  ];
}

function rgbToHex([r, g, b]: RGB): ColorStringHex {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}` as ColorStringHex;
}

function senderInkWithGradientFloor(ink: RGB, surface: RGB, brand: RGB, fillAlpha: number): ColorStringHex {
  const fill: RGB = [0x75, 0x75, 0x75];
  const plain = blendRGB(surface, fill, fillAlpha);
  const corner = blendRGB(blendRGB(surface, brand, 0x55 / 255), fill, fillAlpha);
  const atCorner = rgbContrast(ink, corner);
  if (atCorner >= 3.0 || atCorner >= rgbContrast(ink, plain)) return rgbToHex(ink);
  const target: RGB = rgbContrast([0, 0, 0], corner) >= rgbContrast([255, 255, 255], corner)
    ? [0, 0, 0]
    : [255, 255, 255];
  for (let step = 1; step <= 100; step++) {
    const candidate = blendRGB(ink, target, step / 100);
    if (rgbContrast(candidate, corner) >= 3.0) return rgbToHex(candidate);
  }
  return rgbToHex(target);
}

export function widgetSenderTagStyle(brandAccent?: string) {
  if (!brandAccent) {
    return {
      background: SENDER_TAG_BACKGROUND,
      foreground: { light: "#616161" as ColorStringHex, dark: "#BDBDBD" as ColorStringHex },
    } as const;
  }
  const brand = hexToRGB(brandAccent);
  return {
    background: SENDER_TAG_BACKGROUND,
    foreground: {
      light: senderInkWithGradientFloor(SENDER_TAG_INK.light, [255, 255, 255], brand, PARCEL_STATUS_BADGE_OPACITY.light),
      dark: senderInkWithGradientFloor(SENDER_TAG_INK.dark, [28, 28, 30], brand, PARCEL_STATUS_BADGE_OPACITY.dark),
    },
  } as const;
}

export const EMPTY_WIDGET_ACCENT = "#3482FF";

export const EMPTY_WIDGET_TEXT_COLOR = "secondaryLabel" as const;

type RGB = readonly [number, number, number];

export type WidgetLinearGradient = {
  gradient: {
    color: ColorStringRGBA;
    location: number;
  }[];
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
};

export type MediumWidgetBackground = {
  light: WidgetLinearGradient;
  dark: WidgetLinearGradient;
};

function hexToRGB(value: string): RGB {
  const normalized = value.replace(/^#/, "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function blend(base: RGB, accent: RGB, amount: number): ColorStringRGBA {
  const channel = (index: number) => Math.round(
    base[index] + (accent[index] - base[index]) * amount,
  );
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, 1)` as ColorStringRGBA;
}

function brandGradient(base: RGB, accent: RGB): WidgetLinearGradient {
  return {
    gradient: [
      { color: blend(base, accent, 0x55 / 0xff), location: 0 },
      { color: blend(base, accent, 0x18 / 0xff), location: 0.55 },
      { color: blend(base, accent, 0), location: 1 },
    ],
    startPoint: { x: 0, y: 0 },
    endPoint: { x: 1, y: 1 },
  };
}

export function carrierWidgetAccent(
  courierCode: string,
  companyName: string,
  accountOrder = false,
): ColorStringHex {
  const icon = courierIconName(courierCode, companyName, accountOrder);
  return carrierArtworkAccent(icon) ?? EMPTY_WIDGET_ACCENT;
}

export function mediumWidgetBackground(
  courierCode: string,
  companyName: string,
  accountOrder = false,
): MediumWidgetBackground {
  const accent = hexToRGB(
    carrierWidgetAccent(courierCode, companyName, accountOrder),
  );
  return {
    light: brandGradient([255, 255, 255], accent),
    dark: brandGradient([28, 28, 30], accent),
  };
}

export function emptyWidgetBackground(): MediumWidgetBackground {
  const accent = hexToRGB(EMPTY_WIDGET_ACCENT);
  const light = brandGradient([255, 255, 255], accent);
  const dark = brandGradient([28, 28, 30], accent);
  return {
    light: {
      ...light,
      startPoint: { x: 0, y: 1 },
      endPoint: { x: 1, y: 0 },
    },
    dark: {
      ...dark,
      startPoint: { x: 0, y: 1 },
      endPoint: { x: 1, y: 0 },
    },
  };
}
