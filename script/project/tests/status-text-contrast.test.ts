import assert from "node:assert/strict";
import type { StatusSemantic } from "../models";
import { statusTextAccent, statusTextTint } from "../services/status";
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
function check(text: string, background: number[], description: string, minimum = 4.5) {
  assert.ok(contrast(text, background) >= minimum, description);
}
const semantics: StatusSemantic[] = ["ORDERED", "SHIPPED", "PICKED", "TRANSIT", "DELIVERY", "WAITING_PICKUP", "COMPLETED", "DANGER", "CANCELLED", "UNKNOWN"];
for (const semantic of semantics) {
  const accent = statusTextAccent(semantic);
  for (const badgeOpacity of [0, .1]) {
    const text = statusTextTint(semantic, { badgeOpacity });
    for (const [mode, surfaces] of [["light", [0xffffff, 0xf2f2f7]], ["dark", [0, 0x1c1c1e, 0x2c2c2e]]] as const) {
      for (const surface of surfaces) {
        const background = rgb(surface).map((c, i) => Math.round(c + (rgb(accent)[i] - c) * badgeOpacity));
        check(text[mode], background, `${semantic} ${mode} sender=${badgeOpacity}`);
      }
    }
  }
}
assert.equal(statusTextAccent("ORDERED"), 0x0f61c1);
assert.equal(statusTextAccent("COMPLETED"), 0x005d2d);
assert.equal(statusTextAccent("DELIVERY", "待派送", true), 0xfaac20);
assert.equal(statusTextAccent("DANGER", "异常件", true), 0xff7164);
console.log("status text contrast: app and sender badge contrast passed");

const materialColors: Record<string, number> = {
  ORDERED: 0x0f61c1, SHIPPED: 0x0057b3, PICKED: 0x004ea1, TRANSIT: 0x004590,
  DELIVERY: 0x7a491d, WAITING_PICKUP: 0x693b10, COMPLETED: 0x005d2d,
  DANGER: 0xba1a1a, CANCELLED: 0x63696a, UNKNOWN: 0x545b5c,
};
for (const semantic of semantics) {
  for (const brand of ["#3B2000", "#00519E", "#F39400", "#FF2600", "#D32B2C", "#FA0352", "#E33C24", "#762E97", "#E3373F", "#F57A00", "#72388A", "#F7CD23", "#581A7E", "#008E4F", "#009D51", "#0480BB", "#3482FF"]) {
    const style = widgetStatusStyle(semantic, brand);
    const adjusted = statusTextTint(semantic, { brandAccent: brand, badgeOpacity: 0x1a / 255 });
    const rawText = `#${materialColors[semantic].toString(16).padStart(6, "0")}`;
    const original = rgb(materialColors[semantic]);
    const corrected = rgb(parseInt(adjusted.light.slice(1), 16));
    const midpoint = `#${original.map((c, i) => Math.round((c + corrected[i]) / 2).toString(16).padStart(2, "0")).join("")}`;
    assert.equal(style.foreground.light, midpoint);
    assert.equal(style.foreground.dark, adjusted.dark);
    assert.equal(Number(style.background.match(/[\d.]+/g)![3]), 0x1a / 255);
    assert.deepEqual(style.background.match(/[\d.]+/g)!.slice(0, 3).map(Number), original);
    for (const [mode, surface] of [["light", 0xffffff], ["dark", 0x1c1c1e]] as const) {
      for (let alpha = 0; alpha <= 0x55; alpha++) {
        const background = rgb(surface).map((c, i) => {
          const tinted = Math.round(c + (rgb(parseInt(brand.slice(1), 16))[i] - c) * alpha / 255);
          return Math.round(tinted + (original[i] - tinted) * 0x1a / 255);
        });
        check(style.foreground[mode], background, `${semantic} ${brand} ${mode} gradient=${alpha}`,
          mode === "light" ? contrast(rawText, background) : 4.5);
      }
    }
  }
}
console.log("widget badge contrast: light midpoint, dark contrast and unchanged fills passed");
