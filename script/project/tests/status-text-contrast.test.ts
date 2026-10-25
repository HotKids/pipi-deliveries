import assert from "node:assert/strict";
import type { StatusSemantic } from "../models";
import { statusTextTint, statusTint } from "../services/status";
import { widgetStatusStyle } from "../widget/palette";

const accents: Record<string, [number, number]> = {
  systemOrange: [0xff9500, .15], systemGreen: [0x34c759, .14],
  systemTeal: [0x30b0c7, .14], systemBlue: [0x007aff, .13],
  systemYellow: [0xffcc00, .20], systemRed: [0xff3b30, .13],
  secondaryLabel: [0x757575, .12],
};
function rgb(value: number): number[] { return [value >> 16 & 255, value >> 8 & 255, value & 255]; }
function luminance(channels: number[]): number {
  return channels.reduce((sum, value, i) => {
    const c = value / 255;
    return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
  }, 0);
}
function check(text: string, background: number[], description: string) {
  const values = [luminance(rgb(parseInt(text.slice(1), 16))), luminance(background)].sort((a, b) => a - b);
  assert.ok((values[1] + .05) / (values[0] + .05) >= 4.5, description);
}
const semantics: StatusSemantic[] = ["ORDERED", "SHIPPED", "PICKED", "TRANSIT", "DELIVERY", "WAITING_PICKUP", "COMPLETED", "DANGER", "CANCELLED", "UNKNOWN"];
for (const semantic of semantics) {
  const [accent] = accents[statusTint(semantic)];
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
assert.equal(statusTint("ORDERED"), "systemYellow");
assert.equal(statusTint("COMPLETED"), "systemTeal");
console.log("status text contrast: app and sender badge contrast passed; wide widget uses Lite semantic colors");

const liteColors: Record<string, number> = {
  ORDERED: 0xfbc02d, SHIPPED: 0xfbc02d, PICKED: 0x3275d6, TRANSIT: 0x3275d6,
  DELIVERY: 0x1a8a4a, WAITING_PICKUP: 0xe65b17, COMPLETED: 0x0f9d8a,
  DANGER: 0xd43d3d, CANCELLED: 0x757575, UNKNOWN: 0x757575,
};
for (const semantic of semantics) {
  const style = widgetStatusStyle(semantic);
  assert.equal(style.foreground, `#${liteColors[semantic].toString(16).padStart(6, "0")}`);
  assert.equal(Number(style.background.match(/[\d.]+/g)![3]), 0x1a / 255);
  assert.deepEqual(style.background.match(/[\d.]+/g)!.slice(0, 3).map(Number), rgb(liteColors[semantic]));
}
