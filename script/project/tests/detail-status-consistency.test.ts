import assert from "node:assert/strict";
import type { Shipment, StatusSemantic, TimelinePackage } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, saveState, loadState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import { selectShipmentDetailTimeline, shipmentDetailComplete, shipmentDetailIncompleteReason, shouldScheduleManualRefresh } from "../services/shipment-policy";
import { latestTimelineTrackSemantic, shouldRefreshShipment } from "../services/status";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";

const waybill = "SF123456789012";
function pack(provider: string, semantic: StatusSemantic, latest: string, count = 24): TimelinePackage {
  return { provider, waybill, courierCode: "SF", companyName: "SF", semantic, structuredStatus: true,
    statusEventAtMs: NOW - 60_000, successAtMs: NOW, complete: true,
    latestTimeText: String(NOW - 60_000), latestDetail: latest,
    tracks: Array.from({ length: count }, (_, i) => ({
      timeMs: NOW - 60_000 - i * 60_000, timeText: String(NOW - 60_000 - i * 60_000),
      detail: i === 0 ? latest : i === count - 1 ? "顺丰速运 已收取快件" : `Carrier event ${i}`,
      statusCode: "", raw: {},
    })),
  };
}
function shipment(semantic: StatusSemantic, latest: string, provider = "ShunFeng"): Shipment {
  const source = pack("v5_list", semantic, semantic === "COMPLETED" ? "已签收" : "正在派送", 1);
  const cached = pack("kdniao", semantic, latest);
  return { identity: { id: `interface5:account:${waybill}`, sourceId: waybill, bindingSource: "interface5",
    sourceOwner: "interface5:parcel", sourceProvider: provider, manuallyAdded: false, courierCode: "SF",
    rawCourierCode: "SF", companyName: "SF", phone: "13800001234", phoneTail: "1234", createdAtMs: NOW - 86400000 },
    timeline: source, sourceTimeline: source, manualTimelines: [cached],
    detailSelection: { provider: "kdniao", selectedAtMs: NOW - 60000 },
    accountRecord: { provider, waybill, companyCode: "SF", phone: "13800001234" }, updatedAtMs: NOW };
}

for (const latest of ["正在派送", "运输中", "异常件", "Carrier event", "预计明天送达"]) {
  const value = shipment("COMPLETED", latest);
  assert.equal(selectShipmentDetailTimeline(value).semantic, "COMPLETED");
  assert.equal(shipmentDetailComplete(value), true, `unstructured wording cannot veto otherwise sufficient history: ${latest}`);
  assert.equal(latestTimelineTrackSemantic(value.manualTimelines![0].tracks), "UNKNOWN",
    "an inherited terminal scalar and prose are not a node status enum");
}
for (const [semantic, latest] of [["COMPLETED", "已签收"], ["CANCELLED", "已取消"]] as const) {
  assert.equal(shipmentDetailComplete(shipment(semantic, latest)), true);
}
for (const [semantic, latest, expected] of [
  ["DELIVERY", "正在派送", true], ["DELIVERY", "运输中", true],
  ["TRANSIT", "运输中", true], ["PICKED", "已揽收", true],
  ["UNKNOWN", "Carrier event", false],
] as const) {
  const value = shipment(semantic, latest, "JingDong");
  value.sourceTimeline = pack("v5_list", semantic, latest);
  value.timeline = value.sourceTimeline;
  value.manualTimelines = [];
  assert.equal(shipmentDetailComplete(value), expected);
}
const structured = shipment("COMPLETED", "Carrier event");
assert.equal(shipmentDetailIncompleteReason(structured), null);
assert.equal(shipmentDetailIncompleteReason(shipment("COMPLETED", "正在派送")), null);
assert.equal(shipmentDetailIncompleteReason(shipment("DELIVERY", "正在派送")), "sf_active");
assert.equal(shipmentDetailIncompleteReason(shipment("COMPLETED", "已签收")), null);
const noTracks = shipment("COMPLETED", "已签收");
noTracks.timeline.tracks = [];
noTracks.manualTimelines![0].tracks = [];
assert.equal(shipmentDetailIncompleteReason(noTracks), "no_tracks");
const noPickup = shipment("COMPLETED", "已签收", "Cainiao");
noPickup.manualTimelines = [];
assert.equal(shipmentDetailIncompleteReason(noPickup), "missing_pickup");
const unknownStatus = shipment("UNKNOWN", "Carrier event", "JingDong");
unknownStatus.manualTimelines = [];
assert.equal(shipmentDetailIncompleteReason(unknownStatus), "status_unknown");
const oldHistory = shipment("COMPLETED", "已签收");
const oldPack = oldHistory.manualTimelines![0];
oldPack.statusEventAtMs! -= 86400000;
oldPack.latestTimeText = String(oldPack.statusEventAtMs);
oldPack.tracks = oldPack.tracks.map(track => ({ ...track, timeMs: track.timeMs! - 86400000,
  timeText: String(track.timeMs! - 86400000) }));
assert.equal(shipmentDetailIncompleteReason(oldHistory), "time_mismatch");
for (const [offsetMs, expected] of [
  [-30 * 60_000, null], [30 * 60_000, null],
  [-30 * 60_000 - 1, "time_mismatch"], [30 * 60_000 + 1, "time_mismatch"],
] as const) {
  const value = shipment("COMPLETED", "Carrier event");
  const candidate = value.manualTimelines![0];
  candidate.tracks = candidate.tracks.map(track => ({ ...track,
    timeMs: track.timeMs! + offsetMs, timeText: String(track.timeMs! + offsetMs),
  }));
  candidate.latestTimeText = candidate.tracks[0].timeText;
  candidate.statusEventAtMs = candidate.tracks[0].timeMs;
  candidate.successAtMs = NOW;
  assert.equal(shipmentDetailIncompleteReason(value), expected,
    "the existing 30-minute event-time boundary applies even without node enums or after a fresh fetch");
}
const manualActive = shipment("TRANSIT", "运输中", "");
manualActive.identity.manuallyAdded = true;
manualActive.timeline = manualActive.manualTimelines![0];
manualActive.sourceTimeline = null;
manualActive.accountRecord = null;
assert.equal(shipmentDetailIncompleteReason(manualActive), "missing_source_time");
structured.manualTimelines![0].tracks[0] = { ...structured.manualTimelines![0].tracks[0],
  statusCode: "301", raw: { statusCode: "301", _pipiStatusSource: "kdniao" } };
assert.equal(shipmentDetailComplete(structured), true, "the latest node's own enum can prove completion");
structured.manualTimelines![0].tracks.reverse();
assert.equal(shipmentDetailComplete(structured), true, "use event time rather than input array order");
structured.manualTimelines![0].tracks.push({ ...structured.manualTimelines![0].tracks.at(-1)!,
  detail: "正在派送", statusCode: "", raw: {} });
assert.equal(shipmentDetailComplete(structured), true, "an unstructured equal-time row is not a status conflict");
structured.manualTimelines![0].tracks.at(-1)!.statusCode = "5";
assert.equal(shipmentDetailIncompleteReason(structured), "status_mismatch",
  "a conflicting equal-time enum must not disappear into UNKNOWN");
structured.manualTimelines![0].tracks.at(-2)!.statusCode = "";
structured.manualTimelines![0].tracks.at(-2)!.raw = {};
assert.equal(shipmentDetailIncompleteReason(structured), "status_mismatch",
  "a known latest conflict still vetoes history when another latest row has no enum");

for (const [source, code, expected] of [
  ["interface5", "104", "status_mismatch"],
  ["interface5", "107", null],
  ["interface5", "unrecognized", null],
  ["kdniao", "301", null],
  ["kdniao", "5", "status_mismatch"],
] as const) {
  const value = shipment("COMPLETED", "已签收");
  value.manualTimelines![0].tracks[0].raw = { _pipiStatusSource: source, statusCode: code };
  assert.equal(shipmentDetailIncompleteReason(value), expected, `${source} node enum ${code}`);
}
const olderEnum = shipment("COMPLETED", "Carrier event");
olderEnum.manualTimelines![0].tracks[1].statusCode = "5";
assert.equal(shipmentDetailComplete(olderEnum), true, "older enums cannot stand in for the latest node");
assert.equal(latestTimelineTrackSemantic(olderEnum.manualTimelines![0].tracks), "UNKNOWN");

for (const provider of ["cn_h5", "jd_h5", "k100_h5", "jt_h5"]) {
  const h5 = pack(provider, "COMPLETED", "已签收");
  h5.structuredStatus = false;
  h5.tracks[0].raw = { _pipiStatusSource: "web" };
  assert.equal(latestTimelineTrackSemantic(h5.tracks), "UNKNOWN", "H5 prose is not a node enum");
  h5.tracks[0].detail = "物流状态已更新";
  assert.equal(latestTimelineTrackSemantic(h5.tracks), "UNKNOWN");
  h5.tracks[0].statusCode = "5";
  h5.tracks[0].detail = "已签收";
  assert.equal(latestTimelineTrackSemantic(h5.tracks), "DELIVERY", "own enum precedes prose");
  assert.equal(h5.structuredStatus, false, "classification does not promote H5 status authority");
}

const actualNow = Date.now;
Date.now = () => NOW;
try {
 for (const count of [26, 23]) {
  memory.clear();
  setDiagnosticsEnabled(true);
  const original = shipment("COMPLETED", "异常件");
  original.manualTimelines![0].semantic = "DANGER";
  original.manualTimelines![0].tracks[0].statusCode = "EXCEPTION";
  const initial = saveState({ ...emptyState(), shipments: [original], bindings: [
    { source: "interface5", phone: "13800001234", boundAtMs: NOW - 86400000 },
  ] }, NOW).shipments[0];
  assert.equal(shipmentDetailComplete(initial), false);
  assert.equal(shouldRefreshShipment(initial, NOW), false);
  assert.equal(shouldScheduleManualRefresh(initial, NOW), false);
  const calls: string[] = [];
  // Observed SF K100 wording; personal contact fields are omitted from this fixture.
  const deliveredText = "[深圳市]您的快件已派送至本人，如有疑问请电联快递员。";
  const rows = pack("k100_h5", "COMPLETED", deliveredText, count).tracks.map(track => ({
    time: new Date(track.timeMs! + 8 * 3600000).toISOString().slice(0, 19).replace("T", " "),
    context: track.detail,
  }));
  Object.assign(globalThis, { WebViewController: class {
    async loadURL() { calls.push("k100_h5"); return true; }
    async evaluateJavaScript(script: string) {
      const main = { __vue__: { num: waybill, lastnum: waybill, com: "shunfeng", loading: false,
        alllists: rows, lists: rows.slice(0, 2), checkCode: { show: false }, errors: { type: "" } } };
      const document = { readyState: "interactive", querySelector: () => main,
        querySelectorAll: (selector: string) => selector === "script" ? [] : [main] };
      return new Function("window", "document", "location", script)(
        { Vue() {}, jQuery() {} }, document,
        { hostname: "m.kuaidi100.com", href: "https://m.kuaidi100.com/app/query/?nu=" + waybill });
    }
    dispose() {}
  } });
  const result = await runShipmentRefreshForTesting(initial.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
    { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshAccountParcel: async () => { assert.fail("no v5 query on pull"); },
      queryManualForSource: async () => { assert.fail("no Online or paid request after a sufficient H5 result"); },
    });
  assert.deepEqual(calls, ["k100_h5"]);
  const success = readDiagnostics().find(entry => entry.event === "detail.refresh.stage_succeeded" &&
    entry.details.timelineProvider === "k100_h5")!;
  assert.equal(success.details.effectiveTrackCount, count, "stage count describes its captured provider package");
  assert.deepEqual(Object.keys(success.details).sort(), [
    "clientBuild", "durationMs", "effectiveTrackCount", "flowId", "level", "result", "source", "stage", "timelineProvider", "trigger", "waybillTail",
  ].sort(), "successful capture keeps concise diagnostics");
  const contest = readDiagnostics().find(entry => entry.event === "detail.refresh.primary_contest.completed")!;
  assert.equal(contest.details.kdniaoSucceeded, undefined, "an unattempted provider is not a failure");
  assert.equal(contest.details.v4QuerySucceeded, undefined, "an unsupported provider is not a failure");
  assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "k100_h5");
  assert.equal(selectShipmentDetailTimeline(result.shipment).tracks[0].detail, deliveredText);
  assert.equal(shipmentDetailComplete(result.shipment), true);
  const persisted = loadState(NOW).shipments[0];
  assert.equal(selectShipmentDetailTimeline(persisted).provider, "k100_h5");
  assert.equal(persisted.timeline.structuredStatus, true);
  assert.equal(persisted.timeline.statusEventAtMs, initial.timeline.statusEventAtMs,
    "the selected H5 history retains the existing structured signed confirmation");
  assert.equal(persisted.manualTimelines?.find(p => p.provider === "k100_h5")?.structuredStatus, false,
    "the H5 source itself never gains structured status authority");
  assert.equal(persisted.manualTimelines?.find(p => p.provider === "kdniao")?.tracks[0].detail, "异常件");
 }
} finally { Date.now = actualNow; }

console.log("Latest-node status completeness, sticky selection, and SF signed detail refresh passed");
