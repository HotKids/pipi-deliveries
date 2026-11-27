import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { carrierArtworkAccent, courierIconName } from "../services/carrier-presentation";
import { carrierWidgetAccent, EMPTY_WIDGET_ACCENT, widgetStatusStyle } from "../widget/palette";
import { internationalShipmentSnapshot } from "../services/international-records";

// G-MED-04 (2026-11-20 review): the five international Watch icons carry their own brand accent on the widgets and
// pickup cards, extracted with Pipi's ExpressWidgetPalette.dominantAccent filter from the bundled artwork, instead of
// falling back to the empty-widget blue.

function rgbaPixels(path: string): { width: number; height: number; pixels: Uint8Array } {
  const file = readFileSync(new URL(path, import.meta.url));
  assert.equal(file.subarray(1, 4).toString("latin1"), "PNG");
  let offset = 8, width = 0, height = 0;
  const data: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString("latin1");
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.deepEqual([body[8], body[9], body[12]], [8, 6, 0], `${path}: 8-bit RGBA, not interlaced`);
    } else if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 4;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
      const estimate = left + up - corner;
      const [pa, pb, pc] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
      assert.ok(predictor !== undefined, `${path}: filter ${filter}`);
      pixels[y * stride + x] = (row[x] + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}

/** Pipi's ExpressWidgetPalette.dominantAccent, line for line. */
function dominantAccent(pixels: Uint8Array): string | undefined {
  const weights = new Array(512).fill(0), reds = new Array(512).fill(0);
  const greens = new Array(512).fill(0), blues = new Array(512).fill(0);
  for (let index = 0; index < pixels.length; index += 4) {
    const [red, green, blue, alpha] = pixels.subarray(index, index + 4);
    if (alpha < 64) continue;
    const maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue);
    const chroma = maximum - minimum;
    if (maximum < 45 || chroma < 30 || chroma * 100 < maximum * 18) continue;
    const bucket = ((red >> 5) << 6) | ((green >> 5) << 3) | (blue >> 5);
    const weight = alpha * (chroma + 32);
    weights[bucket] += weight;
    reds[bucket] += weight * red;
    greens[bucket] += weight * green;
    blues[bucket] += weight * blue;
  }
  let best = -1;
  for (let index = 0; index < weights.length; index++) if (best < 0 || weights[index] > weights[best]) best = index;
  if (best < 0 || weights[best] === 0) return undefined;
  const channel = (sum: number) => Math.floor(sum / weights[best]).toString(16).padStart(2, "0");
  return `#${channel(reds[best])}${channel(greens[best])}${channel(blues[best])}`.toUpperCase();
}

const now = Date.UTC(2026, 10, 25);
for (const key of ["dhl", "fedex", "gls", "ups", "usps"]) {
  const icon = `watch-${key}`;
  const { width, height, pixels } = rgbaPixels(`../assets/couriers/${icon}.png`);
  assert.deepEqual([width, height], [156, 156]);
  const expected = dominantAccent(pixels);
  assert.ok(expected, `${icon} has a saturated brand colour`);
  assert.equal(carrierArtworkAccent(icon), expected, `${icon} accent follows its bundled artwork`);
  const watch = internationalShipmentSnapshot({
    id: "00000000-0000-4000-8000-000000000401", waybill: "WATCHACCENT1", carrierName: key.toUpperCase(), icon: key,
    status: "TRANSIT", statusText: "运输中", updatedAt: now - 60_000,
    tracks: [{ at: now - 60_000, time: new Date(now - 60_000).toISOString(), detail: "Synthetic scan" }],
  }, now);
  assert.equal(courierIconName(watch.identity.courierCode, watch.identity.companyName), icon);
  const accent = carrierWidgetAccent(watch.identity.courierCode, watch.identity.companyName);
  assert.equal(accent, expected, `${icon}: the widget gradient uses the brand accent`);
  assert.notEqual(accent, EMPTY_WIDGET_ACCENT);
  // The medium-widget badge over this brand gradient keeps the 3.0:1 floor like every domestic brand.
  assert.ok(widgetStatusStyle("TRANSIT", accent, "运输中").foreground.light.startsWith("#"));
}
assert.equal(carrierArtworkAccent("watch"), undefined, "a Watch carrier without its own icon keeps the fallback");
for (const [icon, expectedKey, expectedAccent] of [
  ["ems", "ems", "#F39400"],
  ["yzpy", "yzpy", "#008E4F"],
] as const) {
  const watch = internationalShipmentSnapshot({
    id: "00000000-0000-4000-8000-000000000402", waybill: "WATCHPOST01", carrierName: icon === "ems" ? "EMS" : "中国邮政",
    icon, status: "TRANSIT", statusText: "运输中", updatedAt: now - 60_000,
    tracks: [{ at: now - 60_000, time: new Date(now - 60_000).toISOString(), detail: "Synthetic scan" }],
  }, now);
  assert.equal(watch.identity.courierCode, `watch-${icon}`);
  assert.equal(courierIconName(watch.identity.courierCode, watch.identity.companyName), expectedKey);
  assert.equal(carrierWidgetAccent(watch.identity.courierCode, watch.identity.companyName), expectedAccent);
}
console.log("Watch carrier accents follow their bundled artwork");
