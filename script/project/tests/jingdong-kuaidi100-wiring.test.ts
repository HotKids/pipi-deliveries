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
// The fixed K100 app/query webpage does not authorize the obsolete JSON-query adapter.
assert.doesNotMatch(
  sync,
  /queryKuaidi100JdTimeline\(/,
  "详情链不得再直连 m.kuaidi100.com/query",
);
assert.match(
  sync,
  /const h5Stage = "kuaidi100_query";/,
  "the fixed K100 H5 page retains its existing diagnostic stage",
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
// Picker retains its own slot; the K100 page remains a separate eligible stage.
assert.match(
  manual,
  /query: async \(\) => queryMeizuShipment\(queryInput\)/,
  "the route stage uses the single Online query without a separate endpoint mode",
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
  /const jingDongAutomaticH5Available =[\s\S]*?jingDongAutomaticH5TimelineAvailable\(enrichmentBase\);[\s\S]*?const jingDongManualFallbackRequested =\s*requestedJingDongDetailSupplement &&[\s\S]*?!jingDongFeedReachedPickup\(enrichmentBase\) &&\s*!jingDongAutomaticH5Available;[\s\S]*?if \(pickerSupplementRequested\)[\s\S]*?pickerOnly: true/,
  "JD feed pickup or a complete automatic H5 package must stop before Picker",
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
  /const kuaidi100PrimaryRequested = !missingStatusRefresh && requestedKuaidi100Timeline &&[\s\S]*?!hasPickerTimelineStart\(enrichmentBase\)[\s\S]*?const kuaidi100LevelRequested = \(kuaidi100PrimaryRequested/,
  "K100 primary must stop when the refreshed Picker cache has its own origin",
);
assert.doesNotMatch(
  sync,
  /webRouteUrl|trustedWebTimelineRoute/,
  "Picker-returned URLs cannot control K100 stage eligibility or target",
);assert.match(
  sync,
  /const h5Kind = kuaidi100LevelRequested \? "web" : "none";/,
  "an eligible K100 stage does not require a Picker URL",
);assert.doesNotMatch(
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
