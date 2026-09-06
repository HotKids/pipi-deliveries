import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sync = readFileSync(
  new URL("../services/sync.ts", import.meta.url),
  "utf8",
);
const manual = readFileSync(
  new URL("../services/manual-query.ts", import.meta.url),
  "utf8",
);
const home = readFileSync(
  new URL("../pages/HomePage.tsx", import.meta.url),
  "utf8",
);
const kuaidi100 = readFileSync(
  new URL("../services/kuaidi100-h5.ts", import.meta.url),
  "utf8",
);
const orderProjection = readFileSync(
  new URL("../services/account-order-projection.ts", import.meta.url),
  "utf8",
);
const shipmentPolicy = readFileSync(
  new URL("../services/shipment-policy.ts", import.meta.url),
  "utf8",
);
const status = readFileSync(
  new URL("../services/status.ts", import.meta.url),
  "utf8",
);
const packageVerifier = readFileSync(
  new URL("../tools/verify-package.sh", import.meta.url),
  "utf8",
);

assert.match(
  sync,
  /const stateParcel = parcel;/,
  "JD's own H5 must retain the full captured trace list instead of reducing it to the latest visible event",
);
// 用户定（表格「待改 1」）：K100 H5 只能是 picker `manual` 返回的 `detailUrl` 那一页。
// 原来这里钉的是「京东详情要用直连 K100 后台查询」，那条裁决已被表格取代。
assert.doesNotMatch(
  sync,
  /queryKuaidi100JdTimeline\(/,
  "详情链不得再直连 m.kuaidi100.com/query",
);
assert.match(
  sync,
  /const h5Stage = "kuaidi100_query";/,
  "抓 picker 的 K100 H5 页仍沿用 kuaidi100_query 这个 stage 名",
);
assert.doesNotMatch(
  sync,
  /function refreshJingDongH5\(/,
  "JD timeline capture must reuse order projection instead of loading JD H5 twice",
);
assert.match(
  orderProjection,
  /function projectionTrack\([\s\S]*?raw:[\s\S]*?_pipiStatusSource:\s*"jingdong_h5"/,
  "the initial order-projection response must mark its full traceList as JD H5 source data",
);
assert.match(
  sync,
  /const stateParcel = parcel;[\s\S]*?parcelToShipment\([\s\S]*?applyTargetedAccountShipment\(/,
  "the initial projection must commit its waybill, carrier, and traceList to the same automatic owner",
);
// 表格「待改 1」落地后，route 槽对所有来源都是 picker；K100 那一页由详情链下一级抓
// picker 返回的 `detailUrl`，不再有「京东走直连 K100」这条岔路。
assert.match(
  manual,
  /query: async \(\) => queryMeizuShipment\(\s*queryInput,/,
  "route 槽统一是 picker",
);
assert.doesNotMatch(
  manual,
  /queryJingDongKuaidi100Shipment\(queryInput\)/,
  "京东不得再走直连 K100 的 route 槽",
);
assert.match(
  sync,
  /requestedJingDongDetailSupplement\s*=[\s\S]*?trigger === "identity_projection"[\s\S]*?trigger === "detail_open"[\s\S]*?trigger === "detail_pull"/,
  "JD fallback eligibility must follow the initial detail projection, later detail opens, and explicit pulls without reloading JD H5",
);
assert.match(
  sync,
  /const jingDongAutomaticH5Available =[\s\S]*?jingDongAutomaticH5TimelineAvailable\(enrichmentBase\);[\s\S]*?const jingDongManualFallbackRequested =\s*requestedJingDongDetailSupplement &&[\s\S]*?!jingDongH5CaptureSufficient\(enrichmentBase\);[\s\S]*?if \(pickerSupplementRequested\)[\s\S]*?pickerOnly: true[\s\S]*?const jingDongPrimaryRequested = jingDongManualFallbackRequested &&[\s\S]*?!hasTimelineStartBeforeKdniao\(enrichmentBase\)/,
  "京东 H5 抓够了就停住 Picker / 快递100 / KDNiao，不再多开一次页",
);
// 用户定 2026-09-04：京东手动链只在两个自动源都不完整时启动，判据是揽收。
assert.match(
  sync,
  /!jingDongFeedReachedPickup\(original\) &&[\s\S]*?parcel\?\.projectionUrl,/,
  "联合页重开的判据必须是揽收，不是「已下单或揽收」",
);
assert.doesNotMatch(
  sync,
  /jingDongFeedReachedStart\(original\)/,
  "ORDERED 也算的旧判据不得留在重开闸门上",
);
// 用户定 2026-09-04：complete 只证明「这次抓取展开了列表」，不代表轨迹到此为止。拿它当重开闸门
// 会把一个还在运输中的包永久冻住（极兔 4547：抓到 9 条止于 06:17 后联合页再也不开）。
// 用户定 2026-09-04：签收即冻结，但**详情仍不完整时照样可以刷**（iOS 需用户下拉）。
assert.match(
  sync,
  /\(!jingDongTimelineSettled\(original\) \|\|\s*!jingDongH5CaptureSufficient\(original\)\) &&/,
  "已签收但 H5 还没抓够的行仍可重开联合页",
);
assert.doesNotMatch(
  sync,
  /!jingDongAutomaticH5TimelineAvailable\(original\) &&/,
  "「H5 包被判完整就永不重开」的旧闸门不得回归",
);
assert.match(
  sync,
  /const kuaidi100PrimaryRequested = requestedKuaidi100Timeline &&[\s\S]*?!requestedJingDongDetailSupplement \|\| jingDongPrimaryRequested[\s\S]*?const kuaidi100LevelRequested = \(kuaidi100PrimaryRequested/,
  "a successful automatic JD H5 must prevent the manual K100 primary from starting",
);
// 用户定（表格「待改 1」）：K100 H5 只能是 picker `manual` 返回的 `detailUrl` 那一页。
assert.match(
  sync,
  /if \(trustedWebTimelineRoute\(pickerOutcome\.routeUrl \|\| ""\)\) \{\s*webRouteUrl = pickerOutcome\.routeUrl;/,
  "picker 这一轮拿到的 detailUrl 必须立刻成为 K100 H5 那一级的入口",
);
assert.match(
  sync,
  /const h5Kind = \(kuaidi100LevelRequested \|\| explicitTimelineRefresh\) &&\s*trustedWebTimelineRoute\(webRouteUrl\)\s*\? "web"\s*: "none";/,
  "K100 那一级只能抓 picker 的 detailUrl 页，直连分支不得回归",
);
assert.doesNotMatch(
  sync,
  /refreshKuaidi100H5\(/,
  "详情链不得再直连 m.kuaidi100.com/query",
);
assert.match(
  sync,
  /const jingDongManualFallbackRequested =[\s\S]*?pickerOnly:\s*true[\s\S]*?queryKuaidi100:\s*queryH5[\s\S]*?queryKdniao:[\s\S]*?fallbackOnly:\s*true/,
  "a missing initial JD H5 traceList must use Picker, then K100 H5, with KDNiao last",
);
assert.match(
  sync,
  /const motoSupported = primaryContestRequested &&[\s\S]*?!isJingDongSourceShipment\(enrichmentBase\)/,
  "the JD fallback chain must not call Moto",
);
assert.match(
  sync,
  /!primaryContestRequested &&[\s\S]*?!jingDongAutomaticH5Available &&[\s\S]*?needsDetailFallback\(refreshed\)/,
  "a successful JD H5 must also block the standalone final fallback",
);
const selectedManualProviders = shipmentPolicy.slice(
  shipmentPolicy.indexOf("function selectedManualTimelines"),
  shipmentPolicy.indexOf("const PRE_KDNIAO_TIMELINE_PROVIDERS"),
);
assert.doesNotMatch(
  selectedManualProviders,
  /"jingdong_h5"/,
  "JD H5 is an automatic same-source timeline and must not enter manual package selection",
);
const manualProviderRegistry = status.slice(
  status.indexOf("const MANUAL_TIMELINE_PROVIDERS"),
  status.indexOf("export type TimelineCapability"),
);
assert.doesNotMatch(
  manualProviderRegistry,
  /"jingdong_h5"/,
  "legacy JD H5 labels must not be registered as manual providers",
);
assert.doesNotMatch(
  home,
  /jingdong_timeline/,
  "opening an identified JD shipment must not query K100 in the background",
);
assert.doesNotMatch(
  kuaidi100,
  /reserveKuaidi100Query|KUAIDI100_QUERY_COOLDOWN_MS|retryAfterMs|"cooldown"/,
  "K100 must let the upstream service decide whether a repeated query is limited",
);
assert.doesNotMatch(
  packageVerifier,
  /kuaidi100-query-guard/,
  "the removed local cooldown module must not remain in the package contract",
);
assert.doesNotMatch(
  sync,
  /kuaidi100ToastMessage|feedback/,
  "provider free-text feedback was removed: pages render only the shared toast table (AGENTS §11)",
);

console.log("JingDong direct K100 wiring tests passed");
