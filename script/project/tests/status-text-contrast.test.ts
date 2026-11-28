import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { StatusSemantic } from "../models";
import {
  BRAND_GRADIENT_STATUS_MIN_CONTRAST,
  statusBadgeFillTint,
  statusCapsuleAccent,
  statusTextAccent,
  statusTextTint,
} from "../services/status";
import { PARCEL_STATUS_BADGE_OPACITY } from "../services/status-tones.generated";
import { widgetStatusStyle } from "../widget/palette";

function rgb(value: number): number[] { return [value >> 16 & 255, value >> 8 & 255, value & 255]; }
function luminance(channels: number[]): number {
  return channels.reduce((sum, value, i) => {
    const c = value / 255;
    return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
  }, 0);
}
function contrast(text: string, background: number[]): number {
  const values = [luminance(rgb(parseInt(text.slice(1), 16))), luminance(background)].sort((a, b) => a - b);
  return (values[1] + .05) / (values[0] + .05);
}
const hex = (value: number) => `#${value.toString(16).padStart(6, "0")}`;
const mix = (from: number[], to: number[], amount: number) => from.map((c, i) => Math.round(c + (to[i] - c) * amount));
const channelsHex = (channels: number[]) => "#" + channels.map(c => c.toString(16).padStart(2, "0")).join("");

// Owner 2026-11-27 (修改 29) five-family 15-state palette (13 client labels: [semantic, label, lightText, darkText, lightCapsule, darkCapsule]).
const toneTable: Array<[StatusSemantic, string, number, number, number, number]> = [
  ["ORDERED", "已下单", 0x00838f, 0x4dd0e1, 0x00bcd4, 0x00acc1],
  ["SHIPPED", "已发货", 0x0277bd, 0x4fc3f7, 0x03a9f4, 0x039be5],
  ["PICKED", "已揽件", 0x1565c0, 0x64b5f6, 0x2196f3, 0x1e88e5],
  ["TRANSIT", "运输中", 0x00796b, 0x4db6ac, 0x26a69a, 0x26a69a],
  ["TRANSIT", "清关中", 0x00695c, 0x26a69a, 0x00796b, 0x00796b],
  ["DELIVERY", "待派送", 0xff6f00, 0xffd54f, 0xffc107, 0xffb300],
  ["DELIVERY", "派送中", 0xe65100, 0xffb74d, 0xff9800, 0xfb8c00],
  ["WAITING_PICKUP", "待取件", 0xbf360c, 0xff8a65, 0xff5722, 0xf4511e],
  ["COMPLETED", "已签收", 0x546e7a, 0xb0bec5, 0x78909c, 0x607d8b],
  ["COMPLETED", "已完成", 0x455a64, 0x90a4ae, 0x607d8b, 0x546e7a],
  ["DANGER", "异常件", 0xc62828, 0xe57373, 0xf44336, 0xe53935],
  ["CANCELLED", "已取消", 0x7e3a3a, 0xd98c8c, 0xc06060, 0xa84e4e],
  ["UNKNOWN", "暂无状态", 0x757575, 0xe0e0e0, 0xbdbdbd, 0x757575],
];

assert.deepEqual(PARCEL_STATUS_BADGE_OPACITY, { light: 0.12, dark: 0.22 });

// Lists, details, the 寄 badge and the small widget emit the text pair unchanged; light-capsule fills use 12% / 22%.
for (const [semantic, label, light, dark, lightCap, darkCap] of toneTable) {
  assert.equal(statusTextAccent(semantic, label), light, `${label} light text`);
  assert.equal(statusTextAccent(semantic, label, true), dark, `${label} dark text`);
  assert.equal(statusCapsuleAccent(semantic, label), lightCap, `${label} light capsule`);
  assert.equal(statusCapsuleAccent(semantic, label, true), darkCap, `${label} dark capsule`);
  assert.deepEqual(statusTextTint(semantic, { label }), { light: hex(light), dark: hex(dark) }, label);
  const fill = statusBadgeFillTint(semantic, { label });
  assert.equal(fill.light, `rgba(${rgb(lightCap).join(", ")}, 0.12)`);
  assert.equal(fill.dark, `rgba(${rgb(darkCap).join(", ")}, 0.22)`);
}
assert.deepEqual(statusTextTint("DELIVERY"), { light: "#e65100", dark: "#ffb74d" }, "DELIVERY reads 派送中");
assert.deepEqual(statusTextTint("COMPLETED"), { light: "#546e7a", dark: "#b0bec5" }, "COMPLETED reads 已签收");
assert.deepEqual(
  statusTextTint("TRANSIT", { label: "清关中" }),
  { light: "#00695c", dark: "#26a69a" },
  "清关中 uses dedicated text pair #00695c / #26a69a (修改 31)",
);
assert.notEqual(
  statusTextTint("TRANSIT", { label: "清关中" }).light,
  statusTextTint("TRANSIT", { label: "运输中" }).light,
);
assert.notEqual(
  statusTextTint("TRANSIT", { label: "清关中" }).dark,
  statusTextTint("TRANSIT", { label: "运输中" }).dark,
);
console.log("status text: lists, details, sender badge and small widget emit the shared pair directly");

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
assert.ok(source("../components/ShipmentRow.tsx")
  .includes("statusTextTint(presentationStatus.semantic, { label: presentationStatus.text })"));
assert.ok(source("../pages/DetailPage.tsx")
  .includes("statusTextTint(presentationStatus.semantic, { label: presentationStatus.text })"));
assert.ok(source("../components/SenderBadge.tsx")
  .includes("statusTextTint(props.semantic, { label: props.label })"));
assert.ok(source("../components/SenderBadge.tsx")
  .includes("statusBadgeFillTint(props.semantic, { label: props.label })"));
assert.ok(source("../widget/SmallWidget.tsx")
  .includes("statusTextTint(row.semantic, { label: row.statusLabel })"));
assert.match(source("../widget/MediumWidget.tsx"), /widgetStatusStyle\(props\.row\.semantic, props\.brandAccent, props\.row\.statusLabel\)/);
// The estimated delivery line uses the 运输中 text pair instead of the system blue.
const detailPage = source("../pages/DetailPage.tsx");
assert.match(detailPage, /foregroundStyle=\{statusTextTint\("TRANSIT"\)\}>\{platformFields\.estimate\}/);
assert.doesNotMatch(detailPage, /foregroundStyle="systemBlue">\{platformFields\.estimate\}/);
console.log("status text: every direct surface reads statusTextTint; the medium widget reads its badge style");

// Medium widget badge (修改 29): 12% light / 22% dark capsule base fill over the carrier brand gradient,
// keeping the shared text pair unless the gradient causes a drop below 3.0:1 at the brand corner.
assert.equal(BRAND_GRADIENT_STATUS_MIN_CONTRAST, 3);
const brands = ["#3B2000", "#00519E", "#F39400", "#FF2600", "#D32B2C", "#FA0352", "#E33C24", "#762E97",
  "#E3373F", "#F57A00", "#72388A", "#F7CD23", "#581A7E", "#008E4F", "#009D51", "#0480BB", "#3482FF",
  // International Watch brands (G-MED-04): DHL, FedEx, GLS, UPS and USPS.
  "#FECC00", "#4D138B", "#0519B0", "#EFB828", "#333267",
  // Synthetic accents: a white artwork (the gradient adds nothing) and a pale pink one (red on red at night).
  "#FFFFFF", "#FFCDD2"];
const surfaces = { light: 0xffffff, dark: 0x1c1c1e } as const;
function badge(semantic: StatusSemantic, label: string, brand: string, mode: "light" | "dark") {
  const [, , light, dark, lightCap, darkCap] = toneTable.find(row => row[0] === semantic && row[1] === label)!;
  const raw = mode === "light" ? light : dark;
  const cap = mode === "light" ? lightCap : darkCap;
  const opacity = PARCEL_STATUS_BADGE_OPACITY[mode];
  const plain = mix(rgb(surfaces[mode]), rgb(cap), opacity);
  const corner = mix(mix(rgb(surfaces[mode]), rgb(parseInt(brand.slice(1), 16)), 0x55 / 255), rgb(cap), opacity);
  const shown = widgetStatusStyle(semantic, brand, label).foreground[mode];
  return { raw: hex(raw), plain, corner, shown, collides: contrast(hex(raw), corner) < 3 && contrast(hex(raw), corner) < contrast(hex(raw), plain) };
}
const counts = { light: { floored: 0, unchanged: 0 }, dark: { floored: 0, unchanged: 0 } };
for (const [semantic, label, , , lightCap, darkCap] of toneTable) {
  for (const brand of brands) {
    const style = widgetStatusStyle(semantic, brand, label);
    assert.equal(style.background.light, `rgba(${rgb(lightCap).join(", ")}, 0.12)`);
    assert.equal(style.background.dark, `rgba(${rgb(darkCap).join(", ")}, 0.22)`);
    for (const mode of ["light", "dark"] as const) {
      const { raw, corner, shown, collides } = badge(semantic, label, brand, mode);
      if (!collides) {
        assert.equal(shown, raw, `${label} ${brand} ${mode}: the gradient causes no drop, keep the shared pair`);
        counts[mode].unchanged++;
        continue;
      }
      counts[mode].floored++;
      assert.ok(contrast(shown, corner) >= 3, `${label} ${brand} ${mode} reaches 3.0:1 at the brand corner`);
      const target = contrast("#000000", corner) >= contrast("#ffffff", corner) ? [0, 0, 0] : [255, 255, 255];
      const step = Array.from({ length: 101 }, (_, index) => index)
        .find(index => channelsHex(mix(rgb(parseInt(raw.slice(1), 16)), target, index / 100)) === shown);
      assert.ok(step !== undefined && step > 0, `${label} ${brand} ${mode} steps toward ${target}`);
      const previous = channelsHex(mix(rgb(parseInt(raw.slice(1), 16)), target, (step! - 1) / 100));
      assert.ok(contrast(previous, corner) < 3, `${label} ${brand} ${mode} takes the smallest step`);
    }
  }
}
for (const mode of ["light", "dark"] as const) {
  assert.ok(counts[mode].floored > 0 && counts[mode].unchanged > 0, `${mode}: the floor applies only to collisions`);
}
for (const [semantic, label, brand] of [["DANGER", "异常件", "#D32B2C"], ["DELIVERY", "派送中", "#F39400"]] as const) {
  const light = badge(semantic, label, brand, "light");
  assert.ok(light.collides && light.shown !== light.raw, `${label} on ${brand} collides in light mode`);
}
for (const [semantic, label, brand] of [["ORDERED", "已下单", "#FFFFFF"], ["COMPLETED", "已签收", "#FFFFFF"],
  ["COMPLETED", "已完成", "#FFFFFF"], ["UNKNOWN", "暂无状态", "#FFFFFF"]] as const) {
  const light = badge(semantic, label, brand, "light");
  assert.ok(!light.collides && light.shown === light.raw, `${label} on ${brand} stays raw in light mode`);
}
for (const [semantic, label, brand] of [["DANGER", "异常件", "#FFFFFF"], ["COMPLETED", "已签收", "#FFFFFF"]] as const) {
  const dark = badge(semantic, label, brand, "dark");
  assert.ok(dark.collides && dark.shown !== dark.raw, `${label} on ${brand} collides in dark mode`);
}
for (const [semantic, label, brand] of [["DANGER", "异常件", "#00519E"], ["TRANSIT", "运输中", "#3482FF"]] as const) {
  const dark = badge(semantic, label, brand, "dark");
  assert.ok(!dark.collides && dark.shown === dark.raw, `${label} on ${brand} stays raw in dark mode`);
}
console.log("widget badge contrast: shared pair kept, 3.0:1 floor only where the brand gradient causes the drop");
