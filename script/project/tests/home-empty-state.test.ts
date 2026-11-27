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
  /meal: \{ imagePath: "widget\/empty-pickup-grape\.png", label: "饮咗茶未" \},\s*parcel: \{ imagePath: "widget\/empty-pickup-sf-box\.png", label: "暂无包裹" \},/,
  "each Pickup illustration carries its own caption",
);
const emptyTabSource = emptyGroupSource.match(/^export function EmptyTabState\([\s\S]*?^\}/m)?.[0];
assert.ok(emptyTabSource);
assert.match(
  emptyTabSource,
  /const \{ imagePath, label \} = pickup \? pickupArtwork\[pickup\] : \{\s*imagePath: vehicleArtwork,\s*label: "暂无快递",\s*\};[\s\S]*?<Image filePath=\{/,
  "each empty state provides its bundled art on the first render",
);
assert.match(
  emptyTabSource,
  /<ZStack frame=\{frame\}>\s*\{illustration\}\s*<Image filePath=\{[^}]*\}[^>]*?colorConvert/,
  "the cup and original white brand mark are rendered together",
);
assert.match(
  emptyGroupSource,
  /<VStack alignment="center" spacing=\{spacing\}>\s*\{artwork\}\s*<Text\s+font=\{labelFont\}\s*fontWeight=\{widget \? "medium" : "regular"\}\s*foregroundStyle=\{widget \? EMPTY_WIDGET_TEXT_COLOR : "secondaryLabel"\}/,
  "the illustration and readable label share one intrinsic group",
);
assert.match(
  emptyGroupSource,
  /const size = pickup \? 96 : 81\.6;[\s\S]*?<VStack frame=\{\{ maxWidth: "infinity", maxHeight: "infinity" \}\} allowsHitTesting=\{false\}>\s*<EmptyStateGroup artwork=\{artwork\} label=\{label\} spacing=\{8\} labelFont="body" \/>/,
  "the pickup illustrations share a larger frame, typography and centering",
);
assert.match(
  homeSource,
  /<RootTabList key="shipments" title="快递"[^]*?refresh=\{refresh\}[^]*?emptyState=\{!shipments\.length \? <EmptyTabState \/> : undefined\}/,
  "the shared empty state sits inside the refreshable body",
);
for (const filename of ["empty-pickup-grape.png", "empty-pickup-sf-box.png"]) {
  const image = await readFile(resolve(projectDir, "assets/widget", filename));
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image[25], 6, `${filename} preserves transparent edges`);
}
assert.match(emptyGroupSource, /const heyteaLogo = "meal-pickup\/xicha\.png";/);
assert.equal((homeSource.match(/<RootTabList\b/g) ?? []).length, 1,
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
assert.match(homeSource, /<NavigationStack\b[^>]*toolbarBackgroundVisibility=\{\{ visibility: "hidden", bars: \["navigationBar"\] \}\}[^>]*>\s*<VStack spacing=\{0\}[^]*?<RootTabList\s+key="shipments"\s+title="快递"\s+subtitle=\{`\$\{groups\.pickup\.length\} 件待取 · \$\{groups\.all\.length\} 个包裹`\}\s+onClose=\{\(\) => dismiss\(\)\}[^]*?topAccessory=\{visibleFilters\.length > 1 \? \(\s*<ShipmentFilterBar/,
  "the subtitle and segmented filter scroll with the title in the common list");
assert.match(homeSource, /\{accessKeyNotice \? \(\s*<Section[^>]*>\s*\{accessKeyNotice\}\s*<\/Section>/,
  "the access-key notice retains its list row");
assert.doesNotMatch(homeSource, /safeAreaInset=|alignment: "topLeading",|headerCollapsed|rootPageScroll/,
  "the native list owns the scroll without a collapse observer");
assert.match(homeSource, /<TabFloatingActionButton title="查询" symbol="magnifyingglass" action=\{\(\) => searchPresented\.setValue\(true\)\} \/>/);
assert.match(homeSource, /bottomInset=\{TAB_FAB_SCROLL_INSET\}/);
const appSource = await readFile(resolve(projectDir, "index.tsx"), "utf8");
assert.match(appSource, /subscribeRefreshState\(applyState\)[\s\S]*?refreshAllShipments\(\)[\s\S]*?\}, \[hasState\]\);/,
  "the app owns the launch refresh and still reaches the missing-history repair entry");
assert.doesNotMatch(homeSource, /\brefreshAllShipments\(\)/,
  "reopening the list never starts another launch refresh");
assert.match(homeSource, /<Section\b[^>]*?listSectionSeparator=\{\{ visibility: "hidden", edges: "top" \}\}>/,
  "the first row has no section separator under any filter");
assert.doesNotMatch(homeSource, /navigationTitle="快递"|systemName="chevron\.left"/);
assert.doesNotMatch(
  homeSource,
  /minHeight: 420|padding=\{\{ bottom: 72 \}\}/,
  "the app home empty state must not use a fixed-height or visual offset",
);
assert.doesNotMatch(homeSource, /EmptyParcelIcon|暂无包裹信息/);
// 用户定 2026-09-04：这条分隔线是我擅自加的，不要。列表末尾只保留说明文字。
assert.doesNotMatch(
  homeSource.replaceAll('listRowBackground={<Rectangle fill="clear" />}', ""),
  /<Rectangle/,
  "the list must not draw its own separator anywhere",
);
assert.match(
  homeSource,
  /const shipmentListFooter = \(\s*<Text[\s\S]*?foregroundStyle="tertiaryLabel"[\s\S]*?>\s*只显示 14 天内的快递\s*<\/Text>[\s\S]*?<Section[\s\S]*?footer=\{shipmentListFooter\}[^>]*>\s*<ForEach/,
  "the populated list section carries the 14-day history footer",
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
assert.match(searchSheet, /<NavigationStack[\s\S]*?presentationBackground="systemGroupedBackground"[\s\S]*?<VStack[\s\S]*?background="systemGroupedBackground"[\s\S]*?ignoresSafeArea[\s\S]*?<ScrollView navigationTitle="查询快递"[\s\S]*?<HomeSearchBar/,
  "the existing search form has its own opaque sheet background, navigation and title");
assert.match(homeSource, /<TextField\s+title="查询快递单号"[^]*?prompt="请输入运单号"/,
  "the waybill field displays the requested prompt");
assert.match(searchSheet, /presentationDragIndicator="visible"/,
  "the search sheet uses pull-down dismissal");
assert.doesNotMatch(searchSheet, /cancellationAction|systemImage="xmark"/,
  "the search sheet omits a header close button and dismisses by pulling down");
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
assert.match(homeSource, /navigationDestination=\{\{\s*isPresented: Boolean\(selected \|\| identity\)/,
  "the main navigation destination presents shipment details or the shared station identity destination");
assert.match(homeSource, /titleAction=\{filter === "pickup" \? \(\s*<IdentityCodeButton onOpen=\{openIdentity\} \/>\s*\) : \(\s*<TabFloatingActionButton title="查询" symbol="magnifyingglass" action=\{\(\) => searchPresented\.setValue\(true\)\} \/>\s*\)\}/,
  "switching the express list filter to 待取 replaces the 查询 FAB with the shared 身份码 FAB");
const filterBar = homeSource.slice(
  homeSource.indexOf("function ShipmentFilterBar"),
  homeSource.indexOf("function shipmentFilter"),
);
assert.match(filterBar, /<Picker\s+title="筛选"\s+value=\{filter\}\s+onChanged=\{\(value: string\) => onSelect\(value as ShipmentFilter\)\}\s+pickerStyle="segmented"/,
  "ShipmentFilterBar uses native iOS 26 segmented Picker");
assert.match(filterBar, /<Text\s+key=\{key\}\s+tag=\{key\}\s+font=\{14\}\s+monospacedDigit\s+contentTransition="numericText"\s+animation=\{\{ animation: Animation\.snappy\(\{ duration: 0\.32 \}\), value: groups\[key\]\.length \}\}\s*>\{`\$\{shipmentFilters\[key\]\} \$\{groups\[key\]\.length\}`\}<\/Text>/,
  "each segmented Picker option uses numericText transition with snappy animation");
assert.doesNotMatch(filterBar, /GeometryReader|<Capsule|tertiarySystemFill/,
  "hand-rolled GeometryReader fake capsule bar is replaced by native segmented Picker");
const showFilter = homeSource.match(/^  function showFilter\([\s\S]*?^  \}/m)?.[0];
assert.ok(showFilter);
const allItems = [{ id: "synthetic-transit" }, { id: "synthetic-completed" }];
const transitItems = [allItems[0]];
const filterUpdates: unknown[] = [];
const selection = { current: { filter: "all", items: allItems } };
let currentSelectedFilter = "all";
const select = new Function(
  "groups",
  "selection",
  "visibleFilters",
  "observableItems",
  "getSelectedFilter",
  "setSelectedFilter",
  stripTypeScriptTypes(showFilter).replace(/\bselectedFilter\b/g, "getSelectedFilter()") + "\nreturn showFilter;",
)(
  { all: allItems, transit: transitItems },
  selection,
  ["all", "transit"],
  {
    setValue: (items: unknown) => {
      assert.equal(items, selection.current.items);
      filterUpdates.push({ filter: selection.current.filter, items });
    },
  },
  () => currentSelectedFilter,
  (next: string) => {
    currentSelectedFilter = next;
  },
);
select("all");
select("pickup");
select("transit");
select("transit");
assert.deepEqual(filterUpdates, [{ filter: "transit", items: transitItems }],
  "one update changes the highlight and native rows for a different visible segment");
assert.match(homeSource, /key === "all" \|\| groups\[key\]\.length > 0/);
assert.match(homeSource, /showFilter\(visibleFilters\.includes\(selected\) \? selected : "all"\)/);

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
