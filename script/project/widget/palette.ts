import { courierIconName } from "../services/carrier-presentation";

export const EMPTY_WIDGET_ACCENT = "#3482FF";

export const EMPTY_WIDGET_TEXT_COLOR = {
  light: "rgba(0, 0, 0, 0.3)",
  dark: "rgba(255, 255, 255, 0.3)",
};

const FALLBACK_ACCENT = EMPTY_WIDGET_ACCENT;

// These values are generated from the bundled courier artwork with the same
// dominant-color filter used by the Android widget.
const ACCENT_BY_ICON: Readonly<Record<string, string>> = {
  danniao: "#3B2000",
  dbl: "#00519E",
  ems: "#F39400",
  emsgj: "#FF2600",
  jd: "#D32B2C",
  jdshopping: "#FE481E",
  jtsd: "#E33C24",
  kysy: "#762E97",
  sf: "#E3373F",
  sto: "#F57A00",
  uc: "#72388A",
  yd: "#F7CD23",
  yto: "#581A7E",
  yzpy: "#008E4F",
  zjs: "#009D51",
  zto: "#0480BB",
};

type RGB = readonly [number, number, number];

export type WidgetLinearGradient = {
  gradient: {
    color: string;
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

function blend(base: RGB, accent: RGB, amount: number): string {
  const channel = (index: number) => Math.round(
    base[index] + (accent[index] - base[index]) * amount,
  );
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, 1)`;
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
): string {
  const icon = courierIconName(courierCode, companyName, accountOrder);
  return ACCENT_BY_ICON[icon] || FALLBACK_ACCENT;
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
