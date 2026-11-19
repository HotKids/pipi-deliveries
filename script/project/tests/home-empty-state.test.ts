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
  /<VStack alignment="center" spacing=\{spacing\}>\s*\{artwork\}\s*<Text\s+font=\{labelFont\}\s*fontWeight=\{widget \? "medium" : "regular"\}\s*foregroundStyle=\{widget \? EMPTY_WIDGET_TEXT_COLOR : "secondaryLabel"\}/,
  "the illustration and readable label share one intrinsic group",
);
assert.match(
  emptyGroupSource,
  /const size = 81\.6;[\s\S]*?<VStack frame=\{\{ maxWidth: "infinity", maxHeight: "infinity" \}\} allowsHitTesting=\{false\}>\s*<EmptyStateGroup artwork=\{artwork\} label=\{pickup \? "饮咗茶未" : "暂无快递"\} spacing=\{8\} labelFont="body" \/>/,
  "both tab placeholders use the same scale, Dynamic Type font and centering",
);
assert.match(
  homeSource,
  /<RootTabList key="shipments" title="快递"[^]*?refresh=\{refresh\}[^]*?emptyState=\{!shipments\.length \? <EmptyTabState \/> : undefined\}/,
  "the shared empty state sits inside the refreshable body",
);
const grapeArtwork = await readFile(resolve(projectDir, "assets/widget/empty-pickup-grape.png"));
assert.deepEqual([...grapeArtwork.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.equal(grapeArtwork[25], 6, "the grape drink illustration preserves transparent edges");
assert.match(emptyGroupSource, /const heyteaLogo = "meal-pickup\/xicha\.png";[\s\S]*?useBundledImage\(heyteaLogo\)[\s\S]*?<Image image=\{logo\}[^>]*?colorConvert/);
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
assert.match(homeSource, /<NavigationStack>\s*<VStack navigationBarVisibility="hidden"[^]*?<RootTabList key="shipments" title="快递" onClose=\{\(\) => dismiss\(\)\}[^]*?topAccessory=\{visibleFilters\.length > 1 \? \(\s*<ShipmentFilterBar/,
  "the filter scrolls with the title in the common list");
assert.match(homeSource, /\{accessKeyNotice \? \(\s*<VStack[^]*?\{accessKeyNotice\}/,
  "the access-key notice retains its list row");
assert.doesNotMatch(homeSource, /safeAreaInset=|alignment: "topLeading",|headerCollapsed|rootPageScroll/,
  "the native list owns the scroll without a collapse observer");
assert.match(homeSource, /<VStack padding=\{TAB_FAB_PADDING\}>\s*<TabFloatingActionButton title="查询"/);
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
assert.match(searchSheet, /<NavigationStack[\s\S]*?<ScrollView navigationTitle="查询快递"[\s\S]*?<HomeSearchBar/,
  "the existing search form has its own sheet navigation and title");
assert.match(homeSource, /<TextField\s+title="查询快递单号"[^]*?prompt="请输入运单号"/,
  "the waybill field displays the requested prompt");
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
const filterBar = homeSource.match(/<GeometryReader frame=\{\{ height: FILTER_ROW_HEIGHT \}\}>([^]*?)<\/GeometryReader>/)?.[1] ?? "";
assert.match(filterBar, /<Text font=\{11\} fontWeight="semibold" monospacedDigit[^]*?frame=\{\{ minWidth: 16, minHeight: 16 \}\}\s*background=\{\{ style: "systemFill", shape: "capsule" \}\}[^]*?>\s*\{groups\[key\]\.length\}/,
  "the horizontal filter uses the original independent count badge");
assert.match(filterBar, /<Capsule fill="secondarySystemFill" frame=\{\{ width: segmentWidth, height: 26 \}\}\s*offset=\{\{ x: selectedOffset, y: 0 \}\} allowsHitTesting=\{false\} \/>/,
  "one selection fill shares the segment layout's animation");
assert.match(filterBar, /<ZStack alignment="leading"[^\n]*\n\s*animation=\{\{ animation: Animation\.smooth\(\{ duration: FILTER_SLIDE_SECONDS \}\), value: layoutKey \}\}>/);
assert.equal(filterBar.match(/<Capsule fill="secondarySystemFill"/g)?.length, 1);
assert.doesNotMatch(filterBar, /glassEffect|tabCapsuleSurface|matchedGeometryEffect|NamespaceReader/);
const geometry = filterBar.match(/const segmentWidth = [^\n]+\n\s*const selectedOffset = [^\n]+\n\s*const layoutKey = [^\n]+/)?.[0];
assert.ok(geometry);
const slot = new Function("size", "visibleFilters", "filter", "FILTER_SEGMENT_INSET",
  geometry + "\nreturn { segmentWidth, selectedOffset, layoutKey }; ");
for (const width of [280, 362, 540]) {
  for (const filters of [["all", "transit"], ["all", "transit", "pickup", "danger"]]) {
    const first = slot({ width }, filters, filters[0], 3);
    const last = slot({ width }, filters, filters.at(-1), 3);
    assert.equal(first.selectedOffset, 3);
    assert.equal(last.segmentWidth, first.segmentWidth, "the sliding selection fill retains the slot width");
    assert.equal(last.selectedOffset + last.segmentWidth, width - 3);
    assert.notEqual(last.layoutKey, first.layoutKey);
  }
  const before = slot({ width }, ["all", "transit", "pickup"], "transit", 3);
  const after = slot({ width }, ["all", "transit"], "transit", 3);
  assert.notEqual(after.selectedOffset, before.selectedOffset);
  assert.notEqual(after.segmentWidth, before.segmentWidth);
  assert.notEqual(after.layoutKey, before.layoutKey, "removing a segment also animates a retained selection");
}
const showFilter = homeSource.match(/^  function showFilter\([\s\S]*?^  \}/m)?.[0];
assert.ok(showFilter);
const allItems = [{ id: "synthetic-transit" }, { id: "synthetic-completed" }];
const transitItems = [allItems[0]];
const filterUpdates: unknown[] = [];
const selection = { current: { filter: "all", items: allItems } };
const select = new Function("groups", "selection", "visibleFilters", "observableItems",
  stripTypeScriptTypes(showFilter) + "\nreturn showFilter;")(
    { all: allItems, transit: transitItems }, selection, ["all", "transit"],
    { setValue: (items: unknown) => {
      assert.equal(items, selection.current.items);
      filterUpdates.push({ filter: selection.current.filter, items });
    } },
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
