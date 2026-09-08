import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  carrierWidgetAccent,
  mediumWidgetBackground,
} from "../widget/palette";

assert.equal(carrierWidgetAccent("EMS", "EMS"), "#F39400");
assert.equal(carrierWidgetAccent("JD", "京东快递"), "#D32B2C");
assert.equal(carrierWidgetAccent("JD", "京东购物", true), "#FE481E");
assert.equal(carrierWidgetAccent("UNKNOWN", "未知快递"), "#3482FF");

const background = mediumWidgetBackground("EMS", "EMS");
assert.deepEqual(background.light.startPoint, { x: 0, y: 0 });
assert.deepEqual(background.light.endPoint, { x: 1, y: 1 });
assert.deepEqual(
  background.light.gradient.map((stop) => stop.location),
  [0, 0.55, 1],
);
assert.notEqual(
  background.light.gradient[0]?.color,
  background.dark.gradient[0]?.color,
  "dark mode must blend the carrier accent into a dark surface",
);
assert.equal(background.light.gradient[2]?.color, "rgba(255, 255, 255, 1)");
assert.equal(background.dark.gradient[2]?.color, "rgba(28, 28, 30, 1)");

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mediumSource = await readFile(
  resolve(projectDir, "widget/MediumWidget.tsx"),
  "utf8",
);
const smallSource = await readFile(
  resolve(projectDir, "widget/SmallWidget.tsx"),
  "utf8",
);
assert.match(mediumSource, /const leadingRow = snapshot\.rows\[0\]/);
assert.match(
  mediumSource,
  /const accent = leadingRow[\s\S]*?carrierWidgetAccent\([\s\S]*?: EMPTY_WIDGET_ACCENT;/,
  "the search tint must resolve from the same leading carrier as the gradient",
);
assert.match(
  mediumSource,
  /const background = leadingRow[\s\S]*?mediumWidgetBackground\(/,
);
assert.match(
  mediumSource,
  /systemName="magnifyingglass"[\s\S]*?foregroundStyle=\{accent\}/,
);
assert.match(
  smallSource,
  /const background = row[\s\S]*?mediumWidgetBackground\([\s\S]*?: emptyWidgetBackground\(\);[\s\S]*?widgetBackground=\{background\}/,
  "small populated and empty states must keep the same gradient policy as Android",
);

console.log("widget carrier gradient tests passed");
