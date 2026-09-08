import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const homeSource = await readFile(
  resolve(projectDir, "pages/HomePage.tsx"),
  "utf8",
);
const emptyGroupSource = await readFile(
  resolve(projectDir, "components/EmptyDeliveryVehicle.tsx"),
  "utf8",
);

assert.match(
  emptyGroupSource,
  /export function EmptyDeliveryStateGroup[\s\S]*?<VStack\s+alignment="center"\s+spacing=\{props\.spacing\}>[\s\S]*?<EmptyDeliveryVehicle size=\{props\.vehicleSize\} \/>[\s\S]*?<Text[\s\S]*?font=\{props\.labelFont\}[\s\S]*?fontWeight="medium"[\s\S]*?>\s*暂无快递\s*<\/Text>[\s\S]*?<\/VStack>/,
  "vehicle and label must be one intrinsic empty-state group",
);
assert.match(
  homeSource,
  /import \{ EmptyDeliveryStateGroup \} from "\.\.\/components\/EmptyDeliveryVehicle";/,
);
assert.match(
  homeSource,
  /shipments\.length \? \([\s\S]*?\) : \(\s*<VStack\s+spacing=\{0\}[\s\S]*?\{emptySearchArea\}[\s\S]*?<List[\s\S]*?frame=\{\{ maxWidth: "infinity", maxHeight: "infinity" \}\}[\s\S]*?overlay=\{\{\s*alignment: "center",\s*content: \(\s*<EmptyDeliveryStateGroup\s+vehicleSize=\{81\.6\}\s+spacing=\{6\}\s+labelFont=\{24\}\s*\/>\s*\),\s*\}\}/,
  "the 1.2x home vehicle group must be centered in the flexible body below the search area",
);
assert.doesNotMatch(
  homeSource,
  /minHeight: 420|padding=\{\{ bottom: 72 \}\}/,
  "the app home empty state must not use a fixed-height or visual offset",
);
assert.doesNotMatch(homeSource, /EmptyParcelIcon|暂无包裹信息/);
// 用户定 2026-09-04：这条分隔线是我擅自加的，不要。列表末尾只保留说明文字。
assert.doesNotMatch(
  homeSource,
  /<Rectangle/,
  "the list must not draw its own separator anywhere",
);
assert.match(
  homeSource,
  /shipments\.map\([\s\S]*?<Text[\s\S]*?foregroundStyle="tertiaryLabel"[\s\S]*?>\s*只显示 7 天内的快递信息\s*<\/Text>/,
  "the populated list still ends with the history note",
);

console.log("home empty-state presentation tests passed");
