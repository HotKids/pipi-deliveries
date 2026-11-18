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
  /<List key="shipments"[^]*?refreshable=\{refresh\}[^]*?overlay=\{!shipments\.length \? \{\s*alignment: "center",\s*content: \(\s*<VStack frame=\{\{ maxWidth: "infinity", maxHeight: "infinity" \}\} allowsHitTesting=\{false\}>\s*<EmptyDeliveryStateGroup vehicleSize=\{81\.6\} spacing=\{6\} labelFont=\{24\} deferArtwork \/>/,
  "the 1.2x home vehicle group is centered in the refreshable body",
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
assert.match(homeSource, /<NavigationStack>\s*<VStack navigationBarVisibility="hidden"[^]*?<ZStack alignment="topTrailing">\s*<List key="shipments"[^]*?<RootPageTitle title="快递" \/>[^]*?<ShipmentFilterBar[^]*?<\/List>\s*<RootPageCloseButton/,
  "the list scrolls its title and filters underneath a fixed close control");
assert.match(homeSource, /\{accessKeyNotice \? \(\s*<VStack[^]*?\{accessKeyNotice\}/,
  "the access-key notice retains its list row");
assert.doesNotMatch(homeSource, /safeAreaInset=|alignment: "topLeading",|headerCollapsed|rootPageScroll/,
  "the native list owns the scroll without a collapse observer");
assert.match(homeSource, /<VStack padding=\{TAB_FAB_PADDING\}>\s*<TabFloatingActionButton title="查询"/);
assert.match(homeSource, /contentMargins=\{\{ edges: "bottom", insets: TAB_FAB_SCROLL_INSET, placement: "scrollContent" \}\}/);
const appSource = await readFile(resolve(projectDir, "index.tsx"), "utf8");
assert.match(appSource, /subscribeRefreshState\(applyState\)[\s\S]*?refreshAllShipments\(\)[\s\S]*?\}, \[hasState\]\);/,
  "the app owns the launch refresh and still reaches the missing-history repair entry");
assert.doesNotMatch(homeSource, /\brefreshAllShipments\(\)/,
  "reopening the list never starts another launch refresh");
assert.match(homeSource, /<Section listSectionSeparator=\{\{ visibility: "hidden", edges: "top" \}\}>/,
  "the first row has no section separator under any filter");
assert.equal(homeSource.match(/<RootPageTitle\b/g)?.length, 1);
assert.doesNotMatch(homeSource, /navigationTitle="快递"|systemName="chevron\.left"/);
assert.doesNotMatch(
  homeSource,
  /minHeight: 420|padding=\{\{ bottom: 72 \}\}/,
  "the app home empty state must not use a fixed-height or visual offset",
);
assert.doesNotMatch(homeSource, /EmptyParcelIcon|暂无包裹信息/);
// 用户定 2026-09-04：这条分隔线是我擅自加的，不要。列表末尾只保留说明文字。
assert.doesNotMatch(
  homeSource.replace('listRowBackground={<Rectangle fill="clear" />}', ""),
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
  "the original full-width selection fill does not carry the glass animation");
assert.match(filterBar, /<VStack opacity=\{filterSliding \? 1 : 0\} allowsHitTesting=\{false\}>\s*<Capsule fill="clear" \{\.\.\.tabCapsuleSurface\(\)\}\s*frame=\{\{ width: 34, height: 26 \}\}\s*matchedGeometryEffect=\{\{ id: filter, namespace, properties: "position", isSource: false \}\}\s*animation=\{\{ animation: Animation\.snappy\(\{ duration: FILTER_SLIDE_SECONDS \}\), value: filter \}\}/,
  "the glass slide follows the fixed-width label only during interaction");
assert.match(filterBar, /<Text font=\{14\}[^]*?matchedGeometryEffect=\{\{ id: key, namespace, properties: "position" \}\}>\s*\{shipmentFilters\[key\]\}\s*<\/Text>\s*<Text font=\{11\}/,
  "the geometry source is the label text and the number retains its own pill");
const switchFilter = homeSource.match(/^  function switchFilter\([^]*?^  \}/m)?.[0];
assert.ok(switchFilter);
const visibility: boolean[] = [];
const interactions: string[] = [];
const timer = { current: null as number | null };
const pendingGlass = new Map<number, () => void>();
let timerId = 0;
const press = new Function("filter", "filterSlideTimer", "setFilterSliding", "onSelect", "clearTimeout", "setTimeout", "FILTER_SLIDE_SECONDS",
  stripTypeScriptTypes(switchFilter) + "\nreturn switchFilter;")(
    "all", timer, (shown: boolean) => visibility.push(shown), (key: string) => interactions.push(key),
    (id: number) => pendingGlass.delete(id), (callback: () => void, delay: number) => {
      assert.equal(delay, 320);
      pendingGlass.set(++timerId, callback);
      return timerId;
    }, 0.32,
  );
press("all");
assert.equal(pendingGlass.size, 0);
press("transit");
press("pickup");
assert.deepEqual(interactions, ["transit", "pickup"]);
assert.deepEqual([...pendingGlass.keys()], [2], "a second tap restarts the glass window");
pendingGlass.get(2)?.();
assert.deepEqual(visibility, [true, true, false]);
assert.equal(timer.current, null);
const geometry = filterBar.match(/const segmentWidth = [^\n]+\n\s*const selectedOffset = [^\n]+/)?.[0];
assert.ok(geometry);
const slot = new Function("size", "visibleFilters", "filter", "FILTER_SEGMENT_INSET",
  geometry + "\nreturn { segmentWidth, selectedOffset }; ");
for (const width of [280, 362, 540]) {
  for (const filters of [["all", "transit"], ["all", "transit", "pickup", "danger"]]) {
    const first = slot({ width }, filters, filters[0], 3);
    const last = slot({ width }, filters, filters.at(-1), 3);
    assert.equal(first.selectedOffset, 3);
    assert.equal(last.segmentWidth, first.segmentWidth, "the static selection fill retains the slot width");
    assert.equal(last.selectedOffset + last.segmentWidth, width - 3);
  }
}
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
