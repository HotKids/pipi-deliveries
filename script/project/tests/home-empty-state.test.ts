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
  /visibleFilters\.length > 1 \? \([\s\S]*?<List[\s\S]*?refreshable=\{refresh\}[\s\S]*?frame=\{\{ maxWidth: "infinity", maxHeight: "infinity" \}\}[\s\S]*?overlay=\{!shipments\.length \? \{\s*alignment: "center",\s*content: \(\s*<EmptyDeliveryStateGroup\s+vehicleSize=\{81\.6\}\s+spacing=\{6\}\s+labelFont=\{24\}\s+deferArtwork\s*\/>\s*\),\s*\} : undefined\}/,
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
assert.match(homeSource, /navigationBarVisibility="hidden"[\s\S]*?<RootPageHeader title="快递" action=\{\(\) => dismiss\(\)\}/,
  "the Home title and exit are in the tab header above the list");
assert.match(homeSource, /overlay=\{\{\s*alignment: "bottomTrailing",\s*content: \(\s*<VStack padding=\{TAB_FAB_PADDING\}>\s*<TabFloatingActionButton title="查询"/);
assert.match(homeSource, /contentMargins=\{\{ edges: "bottom", insets: TAB_FAB_SCROLL_INSET, placement: "scrollContent" \}\}/);
const appSource = await readFile(resolve(projectDir, "index.tsx"), "utf8");
assert.match(appSource, /subscribeRefreshState\(applyState\)[\s\S]*?refreshAllShipments\(\)[\s\S]*?\}, \[hasState\]\);/,
  "the app owns the launch refresh and still reaches the missing-history repair entry");
assert.doesNotMatch(homeSource, /\brefreshAllShipments\(\)/,
  "reopening the list never starts another launch refresh");
assert.match(homeSource, /<Section listSectionSeparator=\{\{ visibility: "hidden", edges: "top" \}\}>/,
  "the first row has no section separator under any filter");
assert.doesNotMatch(homeSource, /placement="title"|systemName="chevron\.left"/,
  "the Home root has no second title or back button");
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
const filterBar = homeSource.match(/visibleFilters\.length > 1 \? \(([\s\S]*?)\) : null\}/)?.[1] ?? "";
assert.match(filterBar, /<Capsule\b[^>]*stroke=/);
assert.match(filterBar, /<Capsule\b[^>]*frame=\{\{ height: 32 \}\}/,
  "the visible filter track is 32 points tall");
assert.match(filterBar, /<VStack\b[^>]*minHeight: 44[^>]*contentShape="rect"/,
  "the compact track retains a 44-point button hit target");
assert.match(filterBar, /<Button key=\{key\}[\s\S]*?selectFilter\(key\)/);
assert.match(filterBar,
  /<Capsule fill="thinMaterial"[^>]*frame=\{\{ height: 32 \}\}[^>]*allowsHitTesting=\{false\}\s+background=\{\s*<GeometryReader>/,
  "the geometry reader measures the fixed track without expanding the filter row");
assert.equal((filterBar.match(/<GeometryReader\b/g) ?? []).length, 1);
assert.match(filterBar, /<\/GeometryReader>\s*\}\s*overlay=\{\s*<Capsule fill="secondarySystemFill" key="filter-selection"[^>]*offset=\{\{ x: filterIndicatorOffset, y: 0 \}\}/,
  "the moving capsule stays outside the geometry callback so its identity survives selection changes");
assert.equal((filterBar.match(/fill="secondarySystemFill"/g) ?? []).length, 1);
assert.match(filterBar, /<HStack spacing=\{0\} padding=\{\{ horizontal: FILTER_SEGMENT_INSET \}\}/,
  "the button row and the selection share the same end inset");
const selectFilter = homeSource.match(/^  function selectFilter\([\s\S]*?^  \}/m)?.[0];
assert.ok(selectFilter);
const filterUpdates: string[] = [];
const select = new Function("filter", "filterSelection", "Animation", "withAnimation",
  stripTypeScriptTypes(selectFilter) + "\nreturn selectFilter;")(
    "all", { setValue: (key: string) => filterUpdates.push(key) },
    { snappy: () => "spring" },
    (animation: string, update: () => void) => { filterUpdates.push(animation); update(); },
  );
select("all");
select("transit");
assert.deepEqual(filterUpdates, ["spring", "transit"],
  "tapping another filter updates its observable inside a native animation transaction");
const filterGeometry = homeSource.match(/^  const filterSegmentWidth = [\s\S]*?^  const filterIndicatorOffset = [\s\S]*?;/m)?.[0];
const segmentInset = homeSource.match(/const FILTER_SEGMENT_INSET = (\d+);/)?.[1];
assert.ok(filterGeometry && segmentInset);
const selectionFrame = new Function("filterTrackWidth", "visibleFilters", "filter",
  `const FILTER_SEGMENT_INSET = ${segmentInset};\n${filterGeometry}\nreturn { filterSegmentWidth, filterIndicatorOffset };`);
for (const [width, filters] of [
  [320, ["all", "transit"]],
  [548, ["all", "transit", "pickup", "danger"]],
] as const) {
  const inset = Number(segmentInset);
  const expectedWidth = (width - inset * 2) / filters.length;
  filters.forEach((filter, index) => {
    assert.deepEqual(selectionFrame(width, filters, filter), {
      filterSegmentWidth: expectedWidth,
      filterIndicatorOffset: inset + expectedWidth * (index + 0.5) - width / 2,
    });
  });
}
assert.match(filterBar, /<Text[^>]*background=\{\{ style: "systemFill", shape: "capsule" \}\}[^>]*>\s*\{groups\[key\]\.length\}/,
  "each segment shows its count inside a separate capsule");
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
