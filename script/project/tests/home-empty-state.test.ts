import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

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
  /<Picker[\s\S]*?pickerStyle="segmented"[\s\S]*?shipments\.length \? \([\s\S]*?\) : \(\s*<VStack\s+spacing=\{0\}[\s\S]*?<List[\s\S]*?frame=\{\{ maxWidth: "infinity", maxHeight: "infinity" \}\}[\s\S]*?overlay=\{\{\s*alignment: "center",\s*content: \(\s*<EmptyDeliveryStateGroup\s+vehicleSize=\{81\.6\}\s+spacing=\{6\}\s+labelFont=\{24\}\s*\/>\s*\),\s*\}\}/,
  "the 1.2x home vehicle group must be centered in the flexible body below the segmented filter",
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
  /shownShipments\.map\([\s\S]*?<Text[\s\S]*?foregroundStyle="tertiaryLabel"[\s\S]*?>\s*只显示 14 天内的快递\s*<\/Text>/,
  "the populated list still ends with the history note",
);

const classifierSource = homeSource.match(/^function shipmentFilter\([\s\S]*?^\}/m)?.[0];
assert.ok(classifierSource);
const classify = new Function(stripTypeScriptTypes(classifierSource) + "\nreturn shipmentFilter;")();
for (const semantic of ["ORDERED", "SHIPPED", "PICKED", "TRANSIT", "DELIVERY"]) {
  assert.equal(classify(semantic), "transit");
}
assert.equal(classify("WAITING_PICKUP"), "pickup");
assert.equal(classify("DANGER"), "danger");
for (const semantic of ["COMPLETED", "CANCELLED", "UNKNOWN"]) {
  assert.equal(classify(semantic), undefined, "the all segment still includes the display row");
}
const searchSheet = homeSource.match(/sheet=\{\{([\s\S]*?)\n        \}\}/)?.[1] ?? "";
assert.match(homeSource, /const searchPresented = useObservable\(/,
  "search shares the native presentation binding");
assert.match(searchSheet, /isPresented: searchPresented,/);
assert.doesNotMatch(searchSheet, /onChanged:/,
  "the presentation binding owns dismissal without a second state callback");
assert.match(searchSheet, /<NavigationStack[\s\S]*?<ScrollView navigationTitle="查快递"[\s\S]*?<HomeSearchBar/,
  "the existing search form has its own sheet navigation");
assert.match(searchSheet, /systemImage="xmark" labelStyle="iconOnly"[\s\S]*?searchPresented\.setValue\(false\)/,
  "the search sheet must have an icon-only close button");
const navigationEffect = homeSource.match(/useEffect\(\(\) => \{\n(    const generation = props\.navigationRequestGeneration;[\s\S]*?)\n  \}, \[props\.navigationRequestGeneration\]\);/)?.[1];
assert.ok(navigationEffect, "the navigation request runs once per generation");
const openFromRequest = new Function("props", "handledNavigationRef", "searchPresented",
  "setShipmentNavigationTarget", navigationEffect);
const handledNavigation = { current: undefined };
const presentation = { value: false, setValue(value: boolean) { this.value = value; } };
const route = { navigationRequestGeneration: 1, autoFocusSearch: true };
openFromRequest(route, handledNavigation, presentation, () => {});
assert.equal(presentation.value, true);
presentation.setValue(false);
openFromRequest(route, handledNavigation, presentation, () => {});
assert.equal(presentation.value, false, "a dismissed search must not reopen for the same request");
openFromRequest({ ...route, navigationRequestGeneration: 2 }, handledNavigation, presentation, () => {});
assert.equal(presentation.value, true, "a new search request may open after dismissal");
assert.match(searchSheet, /autoFocusSearch=\{props\.autoFocusSearch\}/,
  "only the existing focus and shortcut entry points should open the keyboard automatically");
assert.match(homeSource, /navigationDestination=\{\{\s*isPresented: Boolean\(selected\)/,
  "the main navigation destination presents shipment details");
assert.match(homeSource, /visibleFilters\.length > 1 \? \(\s*<Picker/);
assert.match(homeSource, /key === "all" \|\| groups\[key\]\.length > 0/);
assert.match(homeSource, /visibleFilters\.includes\(selectedFilter\) \? selectedFilter : "all"/);

console.log("home empty-state presentation tests passed");

const shipmentRowSource = await readFile(resolve(projectDir, "components/ShipmentRow.tsx"), "utf8");
assert.doesNotMatch(shipmentRowSource, /暂无物流动态/,
  "Home uses the current empty-tracking copy");
assert.match(shipmentRowSource, /\{latestDetail\.trim\(\) \|\| "暂无物流信息"\}/,
  "Home shows the real headline when present and an empty-tracking label otherwise");
assert.doesNotMatch(shipmentRowSource, /\{latestDetail \? \(/);
assert.match(homeSource, /useEffect\(\(\) => \{[\s\S]*?void refreshAllShipments\(\)/,
  "Home's initial refresh reaches the missing-history repair entry");
