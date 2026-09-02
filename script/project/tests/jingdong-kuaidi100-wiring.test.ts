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
assert.match(
  sync,
  /refreshKuaidi100H5\([\s\S]*?queryKuaidi100JdTimeline\(/,
  "projected JD details must use the direct K100 background query",
);
assert.match(
  sync,
  /h5Kind === "kuaidi100"[\s\S]*?"kuaidi100_query"/,
  "direct K100 diagnostics must not identify the request as WebView extraction",
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
assert.match(
  manual,
  /isJingDongSource && !input\.pickerOnly[\s\S]*?queryJingDongKuaidi100Shipment\(queryInput\)[\s\S]*?: queryMeizuShipment\(queryInput\)/,
  "a JD non-Picker route uses K100 while pickerOnly continues to call Meizu",
);
assert.match(
  sync,
  /requestedJingDongDetailSupplement\s*=[\s\S]*?trigger === "identity_projection"[\s\S]*?trigger === "detail_open"[\s\S]*?trigger === "detail_pull"/,
  "JD fallback eligibility must follow the initial detail projection, later detail opens, and explicit pulls without reloading JD H5",
);
assert.match(
  sync,
  /const jingDongAutomaticH5Available =[\s\S]*?jingDongAutomaticH5TimelineAvailable\(enrichmentBase\);[\s\S]*?const jingDongManualFallbackRequested =\s*requestedJingDongDetailSupplement &&[\s\S]*?!jingDongAutomaticH5Available;[\s\S]*?if \(pickerSupplementRequested\)[\s\S]*?pickerOnly: true[\s\S]*?const jingDongPrimaryRequested = jingDongManualFallbackRequested &&[\s\S]*?!hasTimelineStartBeforeKdniao\(enrichmentBase\)/,
  "the initial JD H5 traceList must stop Picker, K100 H5, and KDNiao without another page load",
);
assert.match(
  sync,
  /const directKuaidi100PrimaryRequested = requestedDirectKuaidi100Timeline &&[\s\S]*?!requestedJingDongDetailSupplement \|\| jingDongPrimaryRequested[\s\S]*?const h5Kind = \(directKuaidi100PrimaryRequested/,
  "a successful automatic JD H5 must prevent the manual K100 primary from starting",
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
assert.match(
  sync,
  /feedback = kuaidi100ToastMessage\(h5Error, kuaidi100Diagnostics\)/,
  "detail pulls must return normalized K100 results for toast presentation",
);

console.log("JingDong direct K100 wiring tests passed");
