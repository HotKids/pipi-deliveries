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

assert.match(manualSource, /local:\s*true[\s\S]*route:\s*true[\s\S]*fallback:\s*true/);
const list = syncSource.slice(syncSource.indexOf("async function refreshOnlineShipment"), syncSource.indexOf("export type ManualShipmentPreview"));
assert.match(list, /pickerOnly: true, includeKdniaoFallback: false/);
assert.doesNotMatch(list, /refreshWebTimeline|scrapeWebTimeline|queryPendingManualRound/);
const full = syncSource.slice(syncSource.indexOf("async function runFullRefresh"), syncSource.indexOf("export function refreshAllShipments"));
assert.doesNotMatch(full, /refreshAccountFollowups|refreshMissingShipmentHistories/);
assert.match(full, /synchronizeAccountList[\s\S]*?checkpoint\(account.state[\s\S]*?refreshShipmentEnrichment/,
  "the account list must commit before Online jobs begin");
const preview = syncSource.slice(syncSource.indexOf("export async function queryManualShipmentPreview"), syncSource.indexOf("export function commitManualShipmentPreview"));
assert.match(preview, /includeKdniaoFallback:\s*false[\s\S]*?pickerOnly:\s*true/);
const pendingCommit = syncSource.slice(syncSource.indexOf("export function commitManualShipmentPreview"), syncSource.indexOf("export type ManualPreviewContinuationDependencies"));
const previewOnly = pendingCommit.slice(pendingCommit.indexOf("if (!preview.hasTimedResult || preview.roundComplete === false)"), pendingCommit.indexOf("if (!preview.shipment) return state;"));
assert.doesNotMatch(previewOnly, /shipments:\s*replaceById|requestWidgetReload\(|notifyShipmentChanges\(/);
const detail = syncSource.slice(syncSource.indexOf("async function runShipmentRefreshById"), syncSource.indexOf("function runTargetedShipmentRefresh"));
assert.match(detail, /trigger === "detail_open"[\s\S]*?await runDetailEntryQuery/);
assert.match(detail, /trigger !== "detail_pull" && !unprojectedAccountOrder/);
assert.match(detail, /queryKuaidi100:\s*queryH5[\s\S]*?queryKdniao:/);
assert.match(syncSource, /async function refreshWebTimeline[\s\S]*?if \(unprojectedAccountOrder\(shipment\)\) return null;/);
assert.doesNotMatch(syncSource, /refreshKuaidi100H5|storedWebRoute|manualWebRoute|webRouteUrl/);
assert.doesNotMatch(webTimelineSource, /\.present\s*\(/);
assert.match(homePageSource, /needsDetailEntryQuery\(selected\)[\s\S]*?"detail_open"/);
assert.match(detailPageSource, /detailEntry: detailEntryRef.current/);
assert.match(manualDetailSource, /const motoTask = settle\(input\.queryMoto\);[\s\S]*?const kuaidi100Task = settle\(input\.queryKuaidi100\);[\s\S]*?Promise\.all/);
assert.match(manualDetailSource, /primaryReachedTimelineStart = [\s\S]*?containsTimelineStartTrack[\s\S]*?kdniaoAttempted = Boolean\([\s\S]*?!primaryReachedTimelineStart/);
console.log("manual preview, list, and detail entry contracts passed");

assert.match(full, /checkpoint\(account.state[\s\S]*?projectAccountOrders\([\s\S]*?refreshShipmentEnrichment/);
assert.match(homePageSource, /unprojectedAccountOrder\(selected\)\s*\? "detail_open"/);
