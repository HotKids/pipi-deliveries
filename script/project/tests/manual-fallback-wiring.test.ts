import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const syncSource = await readFile(resolve(projectDir, "services/sync.ts"), "utf8");
const manualSource = await readFile(
  resolve(projectDir, "services/manual-query.ts"),
  "utf8",
);
const detailPageSource = await readFile(
  resolve(projectDir, "pages/DetailPage.tsx"),
  "utf8",
);
const homePageSource = await readFile(
  resolve(projectDir, "pages/HomePage.tsx"),
  "utf8",
);
const webTimelineSource = await readFile(
  resolve(projectDir, "services/web-timeline.ts"),
  "utf8",
);
const manualDetailSource = await readFile(
  resolve(projectDir, "services/manual-detail-refresh.ts"),
  "utf8",
);

assert.match(
  manualSource,
  /local:\s*true[\s\S]*route:\s*true[\s\S]*fallback:\s*true/,
  "runtime source activation must expose only neutral capability names",
);

const background = syncSource.slice(
  syncSource.indexOf("async function refreshManualAndPending"),
  syncSource.indexOf("export type ManualShipmentPreview"),
);
assert.match(
  background,
  /semantic !== "COMPLETED" && semantic !== "CANCELLED"[\s\S]*?shouldScheduleManualRefresh\(current, now, forceManualRefresh\)/,
  "every active unsigned shipment must remain enrolled in background polling",
);
assert.match(background, /rawCourierCode:\s*current\.identity\.rawCourierCode/);
assert.match(
  background,
  /pickerFirst:\s*current\.identity\.manuallyAdded \|\|[\s\S]*?isShunFengSourceShipment\(current\)[\s\S]*?includeKdniaoFallback:\s*true[\s\S]*?hostSafe:\s*true/,
  "background polling must use Picker first for manual and SF parcels, allow KDNiao, and keep H5 disabled",
);
assert.doesNotMatch(
  background,
  /refreshWebTimeline\(|scrapeWebTimeline\(/,
  "homepage refresh must not load K100 H5 pages",
);
assert.match(
  background,
  /outcome\?\.routeUrl &&[\s\S]*?isShunFengSourceShipment\(current\)[\s\S]*?deferIncomingRoute\(/,
  "an untimed SF Picker response must still retain its K100 detail route",
);

const manualPreview = syncSource.slice(
  syncSource.indexOf("export async function queryManualShipmentPreview"),
  syncSource.indexOf("export function commitManualShipmentPreview"),
);
assert.match(
  manualPreview,
  /includeKdniaoFallback:\s*false[\s\S]*?pickerOnly:\s*true/,
  "manual submit must use Meizu Picker before entering detail",
);

const pendingCommit = syncSource.slice(
  syncSource.indexOf("export function commitManualShipmentPreview"),
  syncSource.indexOf("export type ManualPreviewContinuationDependencies"),
);
const nonpersistentPreviewBranch = pendingCommit.slice(
  pendingCommit.indexOf("if (!preview.hasTimedResult || preview.roundComplete === false)"),
  pendingCommit.indexOf("if (!preview.shipment) return state;"),
);
assert.doesNotMatch(
  nonpersistentPreviewBranch,
  /shipments:\s*replaceById|requestWidgetReload\(|notifyShipmentChanges\(/,
  "a Picker-only preview may persist retry metadata, but must not create an owner or publish UI side effects",
);

const pendingFirstRound = syncSource.slice(
  syncSource.indexOf("async function queryPendingManualRound"),
  syncSource.indexOf("async function refreshManualAndPending"),
);
assert.match(
  pendingFirstRound,
  /pickerOnly:\s*true[\s\S]*?hasTimelineStartBeforeKdniao\(seed\)[\s\S]*?runManualDetailSourceContest\(\{[\s\S]*?queryMoto:[\s\S]*?queryKuaidi100:[\s\S]*?queryKdniao:/,
  "a foreground restart must resume the staged Picker, Moto plus K100, then gated KDNiao round",
);
assert.match(
  background,
  /webViewEnrichment &&[\s\S]*?pending\.awaitingRoundCompletion === true/,
  "unfinished first rounds must resume only in a foreground host that can run K100 H5",
);

const detail = syncSource.slice(
  syncSource.indexOf("async function runShipmentRefreshById"),
  syncSource.indexOf("export function refreshShipmentById"),
);
const homepageProjection = syncSource.slice(
  syncSource.indexOf("async function projectAccountOrders"),
  syncSource.indexOf("async function refreshAccountFollowups"),
);
assert.match(
  homepageProjection,
  /applyAccountOrderProjectionToOwner\([\s\S]*?resolvedParcel!/,
  "homepage JD projection must retain the full H5 timeline returned with the real waybill",
);
assert.ok(detail.indexOf('stage = "cached_order_projection"') >= 0);
assert.match(
  detail,
  /runManualDetailSourceContest\(\{[\s\S]*?queryMoto:[\s\S]*?queryKuaidi100:\s*queryH5[\s\S]*?queryKdniao:[\s\S]*?fallbackOnly:\s*true/,
  "manual detail refresh must run its primary sources before the final fallback",
);
assert.match(
  syncSource,
  /function storedWebRoute\([\s\S]*?!shipment\.identity\.manuallyAdded && !isShunFengSourceShipment\(shipment\)[\s\S]*?route\?\.kind !== "web"/,
  "manual and SF detail refreshes must reuse their persisted Meizu K100 route",
);
assert.match(
  detail,
  /const requestedDirectKuaidi100Timeline = explicitTimelineRefresh && \([\s\S]*?!manualWebRoute[\s\S]*?original\.identity\.manuallyAdded[\s\S]*?isShunFengSourceShipment\(original\)[\s\S]*?const refreshDue = [\s\S]*?requestedDirectKuaidi100Timeline[\s\S]*?const directKuaidi100PrimaryRequested = requestedDirectKuaidi100Timeline &&[\s\S]*?!requestedJingDongDetailSupplement \|\| jingDongPrimaryRequested[\s\S]*?const h5Kind = \(directKuaidi100PrimaryRequested/,
  "manual and SF detail refreshes must still issue a direct K100 query when Picker returned no route",
);
assert.match(
  detail,
  /ordinaryAutomaticSupplementRequested[\s\S]*?pickerOnly:\s*true[\s\S]*?ordinaryAutomaticPrimaryRequested[\s\S]*?!hasTimelineStartBeforeKdniao\(enrichmentBase\)/,
  "ordinary automatic detail must refresh Picker before starting its primary round",
);
assert.match(
  homePageSource,
  /needsAutomaticManualFallback\(selected\)[\s\S]*?"detail_open"/,
  "opening an eligible ordinary automatic detail must start its supplementation round",
);
assert.match(
  syncSource,
  /async function refreshKuaidi100H5\([\s\S]*?!shipment\.identity\.manuallyAdded &&[\s\S]*?!isShunFengSourceShipment\(shipment\)[\s\S]*?!needsAutomaticManualFallback\(shipment\)[\s\S]*?queryKuaidi100JdTimeline\(/,
  "the direct K100 adapter must accept manual, SF, and eligible ordinary automatic shipments",
);
assert.match(
  manualDetailSource,
  /const motoTask = settle\(input\.queryMoto\);[\s\S]*?const kuaidi100Task = settle\(input\.queryKuaidi100\);[\s\S]*?Promise\.all/,
  "Moto and K100 H5 must start before either result is awaited",
);
assert.match(
  manualDetailSource,
  /primaryReachedTimelineStart = [\s\S]*?containsTimelineStartTrack[\s\S]*?kdniaoAttempted = Boolean\([\s\S]*?!primaryReachedTimelineStart[\s\S]*?input\.queryKdniao/,
  "KDNiao must run only when the primary sources did not reach an order or pickup event",
);
assert.match(
  detail,
  /const motoSupported = primaryContestRequested &&[\s\S]*?!isJingDongSourceShipment\(enrichmentBase\) &&[\s\S]*?!isShunFengSourceShipment\(enrichmentBase\)/,
  "only JingDong-owned and SF source routes skip Moto before KDNiao",
);
assert.match(
  syncSource,
  /\(!shipment\.identity\.manuallyAdded && !isShunFengSourceShipment\(shipment\)\)[\s\S]*?scrapeWebTimeline\(/,
  "hidden K100 extraction must accept manual and SF shipments without presenting the webpage",
);
assert.doesNotMatch(
  webTimelineSource,
  /\.present\s*\(/,
  "the iOS K100 extractor must never present its WebView",
);
assert.doesNotMatch(
  detail,
  /diagnosticStage:\s*"manual_sources"/,
  "detail refresh must not use the legacy broad source stage",
);
assert.match(
  detail,
  /waybill:\s*displayWaybill\(enrichmentBase\)[\s\S]*?fallbackOnly:\s*true/,
  "the final fallback must receive the projected or manually entered waybill",
);
assert.match(
  detail,
  /const requestedFinalFallback = Boolean\([\s\S]*?options\.includeKdniaoFallback === true[\s\S]*?explicitTimelineRefresh[\s\S]*?needsDetailFallback\(original\)[\s\S]*?!hasCachedKdniaoTimeline\(original\)[\s\S]*?const refreshDue = forceAccountOrderProjection \|\|[\s\S]*?requestedFinalFallback/,
  "manual submission must not let a settled but incomplete cache skip the requested final fallback",
);
assert.match(
  detail,
  /const manualWebRoute = storedWebRoute\(original, startedAt\);[\s\S]*?const requestedWebTimeline = explicitTimelineRefresh && Boolean\(manualWebRoute\);[\s\S]*?const refreshDue = forceAccountOrderProjection \|\|[\s\S]*?requestedWebTimeline/,
  "manual submission must run hidden H5 extraction even when an existing cache already looks complete",
);
assert.doesNotMatch(
  detail,
  /await refreshAccountParcel\(/,
  "detail refresh must reuse the list-page Xiaomi cache",
);
assert.doesNotMatch(
  detail,
  /completedUnprojectedOrder|isCompletedUnprojectedAccountOrder/,
  "order completion must not screen an unprojected JD order from real-waybill projection",
);
assert.match(detail, /rawCourierCode:\s*refreshed\.identity\.rawCourierCode/);
assert.doesNotMatch(
  detail,
  /includeKdniaoFallback:\s*options\.includeKdniaoFallback === true/,
  "detail refresh must not rerun the list-page local source chain",
);
assert.match(
  detail,
  /if \(completed && !options\.includeKdniaoFallback\) return completed;/,
  "a completed concurrent order projection must not bypass the requested detail fallback chain",
);
assert.match(
  detailPageSource,
  /forceManualRefresh \|\| props\.refreshOnAppear === "identity_projection"/,
  "an unprojected JD detail entry must force one H5 retry",
);
assert.match(
  detailPageSource,
  /includeKdniaoFallback:[\s\S]*?forceManualRefresh \|\|[\s\S]*?props\.refreshOnAppear === "manual_submit" \|\|[\s\S]*?props\.refreshOnAppear === "detail_open"/,
  "ordinary automatic detail entry must carry the final KDNiao fallback through the page boundary",
);

const refreshShipment = syncSource.slice(
  syncSource.indexOf("export function refreshShipmentById"),
  syncSource.indexOf("async function runFullRefresh"),
);
assert.match(
  refreshShipment,
  /requiresFreshDetailRun[\s\S]*?refreshCoordinator\.runDetailFresh/,
  "manual submit and pull-to-refresh must rerun after an older in-flight detail request",
);
assert.match(
  refreshShipment,
  /refreshOptions\.forceManualRefresh \|\|[\s\S]*?refreshOptions\.forceAccountOrderProjection \|\|[\s\S]*?refreshOptions\.trigger === "manual_submit"/,
  "detail pull, manual submission, and a still-unprojected JD open must rerun after a coalesced full refresh",
);
assert.doesNotMatch(
  refreshShipment,
  /refreshOptions\.includeKdniaoFallback\s*\)/,
  "automatic detail entry must not duplicate the full refresh merely because fallback is enabled",
);

const fullRefresh = syncSource.slice(
  syncSource.indexOf("async function runFullRefresh"),
  syncSource.indexOf("export function refreshAllShipments"),
);
assert.match(
  fullRefresh,
  /refreshAccountFollowups\([\s\S]*?refreshManualAndPending\(/,
  "the homepage Xiaomi increment must be followed by the local-source increment queue",
);

const accountFollowups = syncSource.slice(
  syncSource.indexOf("async function refreshAccountFollowups"),
  syncSource.indexOf("async function refreshManualAndPending"),
);
assert.doesNotMatch(
  accountFollowups,
  /refresh(?:JingDong|Cainiao)H5\(/,
  "homepage followups must not contain Cainiao or JD H5 timeline execution",
);

console.log("manual fallback production wiring tests passed");
