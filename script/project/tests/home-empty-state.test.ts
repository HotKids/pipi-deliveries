import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { listHeadline } from "../services/status";
import type { TimelinePackage, TrackNode } from "../models";

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
  /export function EmptyDeliveryStateGroup[\s\S]*?<VStack\s+alignment="center"\s+spacing=\{props\.spacing\}>[\s\S]*?<EmptyDeliveryVehicle size=\{props\.vehicleSize\} deferArtwork=\{props\.deferArtwork\} \/>[\s\S]*?<Text[\s\S]*?font=\{props\.labelFont\}[\s\S]*?fontWeight="medium"[\s\S]*?>\s*暂无快递\s*<\/Text>[\s\S]*?<\/VStack>/,
  "vehicle and label must be one intrinsic empty-state group",
);
assert.match(
  homeSource,
  /import \{ EmptyDeliveryStateGroup \} from "\.\.\/components\/EmptyDeliveryVehicle";/,
);
assert.match(
  homeSource,
  /visibleFilters\.length > 1 \? \([\s\S]*?<List[\s\S]*?refreshable=\{refresh\}[\s\S]*?overlay=\{\{[\s\S]*?\{!shipments\.length \? \(\s*<VStack frame=\{\{ maxWidth: "infinity", maxHeight: "infinity" \}\} allowsHitTesting=\{false\}>\s*<EmptyDeliveryStateGroup vehicleSize=\{81\.6\} spacing=\{6\} labelFont=\{24\} deferArtwork \/>/,
  "the 1.2x home vehicle group must be centered in the flexible body below the segmented filter",
);
assert.equal((homeSource.match(/refreshable=\{refresh\}/g) ?? []).length, 1,
  "data arriving during a pull must not replace the refreshable list");
const makePull = homeSource.match(/const refresh = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[\]\);/)?.[0];
assert.ok(makePull);
const refreshForTest = new Function("useCallback", "currentPull", "pullInFlight", makePull + "\nreturn refresh;");
let beginCount = 0;
let finishPull!: () => void;
const currentPull = { current: () => {
  beginCount++;
  return new Promise<void>((resolve) => { finishPull = resolve; });
} };
const refresh = refreshForTest((callback: () => Promise<void>) => callback, currentPull, { current: null });
const pending = refresh();
assert.equal(refresh(), pending);
assert.equal(beginCount, 1, "a duplicate native callback waits for the same account phase");
finishPull();
await pending;
const next = refresh();
assert.equal(beginCount, 2, "a new gesture still starts another pull");
finishPull();
await next;
assert.match(homeSource, /<NavigationStack>\s*<VStack navigationBarVisibility="hidden"[^]*?<RootPageHeader title="快递"/);
assert.match(homeSource, /<List key="shipments" listStyle="plain" refreshable=\{refresh\}[^]*?rootPageScroll\(setHeaderCollapsed\)/);
assert.match(homeSource, /overlay=\{\{\s*alignment: "topLeading",[\s\S]*?\{compactFilters\}/);
assert.match(homeSource, /\{showListAccessories \? \(/,
  "the accessories keep their list row when the title collapses");
assert.doesNotMatch(homeSource, /safeAreaInset=\{headerCollapsed|!headerCollapsed && showListAccessories/,
  "scrolling cannot replace the list viewport inset or insert a row");
assert.match(homeSource, /\{!headerCollapsed \? <VStack padding=\{TAB_FAB_PADDING\}>\s*<TabFloatingActionButton title="查询"/);
const nativeHeader = await readFile(resolve(projectDir, "components/RootPageHeader.tsx"), "utf8");
assert.match(nativeHeader, /ROOT_TITLE_CAPSULE_WIDTH = 68;/);
assert.match(nativeHeader, /animation: Animation\.smooth\(\{ duration: 0\.22 \}\), value: collapsed/);
assert.match(nativeHeader, /opacity=\{collapsed \? 1 : 0\}[\s\S]*?tabCapsuleSurface\(\)/,
  "the glass background fades in on the compact title");
assert.match(nativeHeader, /scaleEffect=\{collapsed \? 0\.5 : 1\}>\{title\}<\/Text>/);
assert.match(nativeHeader, /width: ROOT_TITLE_CAPSULE_WIDTH, height: NAVIGATION_CONTROL_HEIGHT/);
assert.match(nativeHeader, /width: NAVIGATION_CONTROL_HEIGHT, height: NAVIGATION_CONTROL_HEIGHT/);
assert.match(nativeHeader, /<HStack frame=\{\{ maxWidth: "infinity", height: NAVIGATION_CONTROL_HEIGHT \}\}/);
const scrollBinding = nativeHeader.match(/^export function rootPageScroll\([\s\S]*?^\}/m)?.[0];
assert.ok(scrollBinding);
const rootPageScroll = new Function("COLLAPSE_DISTANCE",
  stripTypeScriptTypes(scrollBinding.replace(/^export /, "")) + "\nreturn rootPageScroll;")(22);
const collapsedStates: boolean[] = [];
const { onChanged } = rootPageScroll((collapsed: boolean) => collapsedStates.push(collapsed)).onScrollGeometryChange;
const scrollGeometry = (distance: number, inset: number) => ({
  contentOffset: { y: distance - inset },
  contentInsets: { top: inset },
});
const samples = [scrollGeometry(0, 68), scrollGeometry(-10, 68), scrollGeometry(8, 68),
  scrollGeometry(28, 68), scrollGeometry(45, 68), scrollGeometry(45, 80),
  scrollGeometry(8, 80), scrollGeometry(0, 80)];
for (let idx = 1; idx < samples.length; idx++) onChanged(samples[idx - 1], samples[idx]);
assert.deepEqual(collapsedStates, [true, false], "only crossing the normalized scroll threshold updates the header");
assert.match(homeSource, /contentMargins=\{\{ edges: "bottom", insets: TAB_FAB_SCROLL_INSET, placement: "scrollContent" \}\}/);
const appSource = await readFile(resolve(projectDir, "index.tsx"), "utf8");
assert.match(appSource, /subscribeRefreshState\(applyState\)[\s\S]*?refreshAllShipments\(\)[\s\S]*?\}, \[hasState\]\);/,
  "the app owns the launch refresh and still reaches the missing-history repair entry");
assert.doesNotMatch(homeSource, /\brefreshAllShipments\(\)/,
  "reopening the list never starts another launch refresh");
assert.match(homeSource, /<Section listSectionSeparator=\{\{ visibility: "hidden", edges: "top" \}\}>/,
  "the first row has no section separator under any filter");
assert.equal(homeSource.match(/<RootPageHeader\b/g)?.length, 1);
assert.doesNotMatch(homeSource, /navigationTitle="快递"|systemName="chevron\.left"/);
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
  /<ForEach[\s\S]*?<Text[\s\S]*?foregroundStyle="tertiaryLabel"[\s\S]*?>\s*只显示 14 天内的快递\s*<\/Text>/,
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
const compactFilters = homeSource.match(/const compactFilters = \(([\s\S]*?)\n  \);/)?.[1] ?? "";
assert.match(compactFilters, /<VStack spacing=\{4\}[\s\S]*?visibleFilters\.map[\s\S]*?frame=\{\{ width: ROOT_TITLE_CAPSULE_WIDTH, minHeight: 36 \}\}/,
  "each compact filter is stacked at the same width as the title");
assert.match(compactFilters, /\{\.\.\.tabCapsuleSurface\(true\)\}/);
assert.match(compactFilters, /padding=\{\{ leading: ROOT_HEADER_HORIZONTAL_INSET,/);
const filterBar = homeSource.match(/\{visibleFilters\.length > 1 \? \(([\s\S]*?)\) : null\}/)?.[1] ?? "";
assert.match(filterBar, /<Picker title="筛选" value=\{filter\} onChanged=\{selectFilter\} pickerStyle="segmented"/,
  "the platform segmented control owns the selection animation");
assert.match(filterBar, /<Text key=\{key\} tag=\{key\} font=\{14\} monospacedDigit\s+contentTransition="numericText"\s+animation=\{\{ animation: Animation\.snappy\(\{ duration: 0\.32 \}\), value: groups\[key\]\.length \}\}>\s*\{\x60\$\{shipmentFilters\[key\]\} \$\{groups\[key\]\.length\}\x60\}/,
  "stable option tags retain the filter when its numeric label changes");
assert.doesNotMatch(filterBar, /GeometryReader|matchedGeometryEffect|<Capsule|<Button/,
  "no custom selection indicator competes with the native one");
const selectFilter = homeSource.match(/^  function selectFilter\([\s\S]*?^  \}/m)?.[0];
assert.ok(selectFilter);
const filterUpdates: string[] = [];
const select = new Function("filter", "filterSelection", "visibleFilters",
  stripTypeScriptTypes(selectFilter) + "\nreturn selectFilter;")(
    "all", { setValue: (key: string) => filterUpdates.push(key) },
    ["all", "transit"],
  );
select("all");
select("pickup");
select("transit");
assert.deepEqual(filterUpdates, ["transit"],
  "the picker updates the selection only when choosing a different visible segment");
assert.match(homeSource, /key === "all" \|\| groups\[key\]\.length > 0/);
assert.match(homeSource, /visibleFilters\.includes\(selectedFilter\) \? selectedFilter : "all"/);

console.log("home empty-state presentation tests passed");

const shipmentRowSource = await readFile(resolve(projectDir, "components/ShipmentRow.tsx"), "utf8");
assert.doesNotMatch(shipmentRowSource, /暂无物流(?:信息|动态)/);
assert.match(shipmentRowSource, /const headline = listHeadline\(item\.timeline\)/);
assert.match(shipmentRowSource, /formatListTime\(headline\.timeText\)/);
assert.match(shipmentRowSource, /\{headline \? \(\s*<Text[\s\S]*?\{headline\.detail\}\s*<\/Text>\s*\) : null\}/);

const realTrack: TrackNode = { timeMs: 1_000, timeText: "10:00", detail: "快件已揽收", statusCode: "", raw: {} };
const timeline = {
  provider: "cainiao", waybill: "synthetic", courierCode: "zto", companyName: "中通快递",
  semantic: "UNKNOWN", statusEventAtMs: null, latestTimeText: "10:01", latestDetail: "",
  tracks: [], successAtMs: 2_000,
} satisfies TimelinePackage;
for (const placeholder of ["", "暂无物流信息", "暂无物流动态", "快递状态已更新，点击查看>>"]) {
  assert.equal(listHeadline({ ...timeline, latestDetail: placeholder }), null);
  assert.deepEqual(listHeadline({ ...timeline, latestDetail: placeholder,
    tracks: [{ ...realTrack, detail: placeholder, timeMs: 2_000 }, realTrack] }),
  { detail: realTrack.detail, timeText: realTrack.timeText });
}
assert.deepEqual(listHeadline({ ...timeline, latestDetail: "预计明日送达", tracks: [realTrack] }),
  { detail: "预计明日送达", timeText: timeline.latestTimeText });
