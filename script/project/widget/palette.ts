import type { ColorStringHex, ColorStringRGBA } from "scripting";
import { carrierArtworkAccent, courierIconName } from "../services/carrier-presentation";
import type { StatusSemantic } from "../models";
import { blendStatusColor, statusTextAccent, statusTextTint } from "../services/status";

export function widgetStatusStyle(semantic: StatusSemantic, brandAccent: string, label = "") {
  const accent = statusTextAccent(semantic, label);
  const opacity = 0x1a / 255;
  const foreground = statusTextTint(semantic, { brandAccent, badgeOpacity: opacity, label });
  const light = blendStatusColor(accent, Number.parseInt(foreground.light.slice(1), 16), 0.5);
  return {
    background: `rgba(${accent >> 16 & 255}, ${accent >> 8 & 255}, ${accent & 255}, ${opacity})` as ColorStringRGBA,
    foreground: { light: `#${light.toString(16).padStart(6, "0")}`, dark: foreground.dark },
  } as const;
}

export const EMPTY_WIDGET_ACCENT = "#3482FF";

export const EMPTY_WIDGET_TEXT_COLOR = {
  light: "rgba(0, 0, 0, 0.3)",
  dark: "rgba(255, 255, 255, 0.3)",
} as const;

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
