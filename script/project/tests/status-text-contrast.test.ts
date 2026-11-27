import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { StatusSemantic } from "../models";
import { BRAND_GRADIENT_STATUS_MIN_CONTRAST, statusTextAccent, statusTextTint } from "../services/status";
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

// Owner 2026-11-27 (修改 24) Material non-capsule (text) pair.
const textTable: Array<[StatusSemantic, string, number, number]> = [
  ["ORDERED", "已下单", 0x455a64, 0xb0bec5],
  ["SHIPPED", "已发货", 0x00838f, 0x80deea],
  ["PICKED", "已揽件", 0x0277bd, 0x81d4fa],
  ["TRANSIT", "运输中", 0x1565c0, 0x90caf9],
  ["DELIVERY", "待派送", 0x00695c, 0x80cbc4],
  ["DELIVERY", "派送中", 0x2e7d32, 0xa5d6a7],
  ["WAITING_PICKUP", "待取件", 0x558b2f, 0xc5e1a5],
  ["COMPLETED", "已签收", 0xef6c00, 0xffcc80],
  ["COMPLETED", "已完成", 0xe64a19, 0xffab91],
  ["DANGER", "异常件", 0xd32f2f, 0xef9a9a],
  ["CANCELLED", "已取消", 0x757575, 0xe0e0e0],
  ["UNKNOWN", "暂无状态", 0x9e9e9e, 0xbdbdbd],
];

// Lists, details, the 寄 badge and the small widget emit the pair unchanged, with no 4.5:1 darkening.
for (const [semantic, label, light, dark] of textTable) {
  assert.equal(statusTextAccent(semantic, label), light, `${label} light`);
  assert.equal(statusTextAccent(semantic, label, true), dark, `${label} dark`);
  assert.deepEqual(statusTextTint(semantic, { label }), { light: hex(light), dark: hex(dark) }, label);
}
assert.deepEqual(statusTextTint("DELIVERY"), { light: "#2e7d32", dark: "#a5d6a7" }, "DELIVERY reads 派送中");
assert.deepEqual(statusTextTint("COMPLETED"), { light: "#ef6c00", dark: "#ffcc80" }, "COMPLETED reads 已签收");
assert.deepEqual(statusTextTint("TRANSIT", { label: "清关中" }), statusTextTint("TRANSIT"), "清关中 keeps 运输中");
console.log("status text: lists, details, sender badge and small widget emit the shared pair directly");

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
assert.ok(source("../components/ShipmentRow.tsx")
  .includes("statusTextTint(presentationStatus.semantic, { label: presentationStatus.text })"));
assert.ok(source("../pages/DetailPage.tsx")
  .includes("statusTextTint(presentationStatus.semantic, { label: presentationStatus.text })"));
assert.ok(source("../components/SenderBadge.tsx")
  .includes("statusTextTint(props.semantic, { label: props.label })"));
// The 寄 badge fill is the light text colour at exactly 0x1A, as on Lite and Pipi.
assert.ok(source("../components/SenderBadge.tsx")
  .includes("`rgba(${rgb >> 16 & 255}, ${rgb >> 8 & 255}, ${rgb & 255}, ${0x1a / 255})`"));
assert.ok(source("../widget/SmallWidget.tsx")
  .includes("statusTextTint(row.semantic, { label: row.statusLabel })"));
assert.match(source("../widget/MediumWidget.tsx"), /widgetStatusStyle\(props\.row\.semantic, props\.brandAccent, props\.row\.statusLabel\)/);
// The estimated delivery line uses the 运输中 text pair instead of the system blue.
const detailPage = source("../pages/DetailPage.tsx");
assert.match(detailPage, /foregroundStyle=\{statusTextTint\("TRANSIT"\)\}>\{platformFields\.estimate\}/);
assert.doesNotMatch(detailPage, /foregroundStyle="systemBlue">\{platformFields\.estimate\}/);
console.log("status text: every direct surface reads statusTextTint; the medium widget reads its badge style");

// Medium widget badge (修改 11 rule 3): the 0x1A light-text fill over the carrier brand gradient. The text
// moves only when the gradient causes the drop: under 3.0:1 at the 0x55 brand corner and lower than on the
// plain badge. Then it takes the smallest 1% step toward black or white that reaches 3.0:1 at the corner.
assert.equal(BRAND_GRADIENT_STATUS_MIN_CONTRAST, 3);
const brands = ["#3B2000", "#00519E", "#F39400", "#FF2600", "#D32B2C", "#FA0352", "#E33C24", "#762E97",
  "#E3373F", "#F57A00", "#72388A", "#F7CD23", "#581A7E", "#008E4F", "#009D51", "#0480BB", "#3482FF",
  // International Watch brands (G-MED-04): DHL, FedEx, GLS, UPS and USPS.
  "#FECC00", "#4D138B", "#0519B0", "#EFB828", "#333267",
  // Synthetic accents: a white artwork (the gradient adds nothing) and a pale pink one (red on red at night).
  "#FFFFFF", "#FFCDD2"];
const surfaces = { light: 0xffffff, dark: 0x1c1c1e } as const;
function badge(semantic: StatusSemantic, label: string, brand: string, mode: "light" | "dark") {
  const [, , light, dark] = textTable.find(row => row[0] === semantic && row[1] === label)!;
  const raw = mode === "light" ? light : dark;
  const plain = mix(rgb(surfaces[mode]), rgb(light), 0x1a / 255);
  const corner = mix(mix(rgb(surfaces[mode]), rgb(parseInt(brand.slice(1), 16)), 0x55 / 255), rgb(light), 0x1a / 255);
  const shown = widgetStatusStyle(semantic, brand, label).foreground[mode];
  return { raw: hex(raw), plain, corner, shown, collides: contrast(hex(raw), corner) < 3 && contrast(hex(raw), corner) < contrast(hex(raw), plain) };
}
const counts = { light: { floored: 0, unchanged: 0 }, dark: { floored: 0, unchanged: 0 } };
for (const [semantic, label, light] of textTable) {
  for (const brand of brands) {
    const style = widgetStatusStyle(semantic, brand, label);
    assert.equal(Number(style.background.match(/[\d.]+/g)![3]), 0x1a / 255);
    assert.deepEqual(style.background.match(/[\d.]+/g)!.slice(0, 3).map(Number), rgb(light));
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
// Light: red on red and orange on orange collide; 已下单 on the blue fallback accent does not, and a white
// artwork leaves even the lightest pairs (已签收, 已完成, 暂无状态) as they are.
for (const [semantic, label, brand] of [["DANGER", "异常件", "#D32B2C"], ["COMPLETED", "已签收", "#F39400"]] as const) {
  const light = badge(semantic, label, brand, "light");
  assert.ok(light.collides && light.shown !== light.raw, `${label} on ${brand} collides in light mode`);
}
for (const [semantic, label, brand] of [["ORDERED", "已下单", "#3482FF"], ["COMPLETED", "已签收", "#FFFFFF"],
  ["COMPLETED", "已完成", "#FFFFFF"], ["UNKNOWN", "暂无状态", "#FFFFFF"]] as const) {
  const light = badge(semantic, label, brand, "light");
  assert.ok(!light.collides && light.shown === light.raw, `${label} on ${brand} stays raw in light mode`);
}
// Dark: 异常件 and 暂无状态 on a pure white accent collide; 异常件 on red and 运输中 on blue do not.
for (const [semantic, label, brand] of [["DANGER", "异常件", "#FFFFFF"], ["UNKNOWN", "暂无状态", "#FFFFFF"]] as const) {
  const dark = badge(semantic, label, brand, "dark");
  assert.ok(dark.collides && dark.shown !== dark.raw, `${label} on ${brand} collides in dark mode`);
}
for (const [semantic, label, brand] of [["DANGER", "异常件", "#D32B2C"], ["TRANSIT", "运输中", "#3482FF"]] as const) {
  const dark = badge(semantic, label, brand, "dark");
  assert.ok(!dark.collides && dark.shown === dark.raw, `${label} on ${brand} stays raw in dark mode`);
}
console.log("widget badge contrast: shared pair kept, 3.0:1 floor only where the brand gradient causes the drop");
