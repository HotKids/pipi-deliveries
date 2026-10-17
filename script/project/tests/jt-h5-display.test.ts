import assert from "node:assert/strict";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, StatusSemantic, TimelinePackage } from "../models";
import { emptyState, loadState, saveState } from "../services/storage";
import { webTimelineFromExtraction } from "../services/web-timeline";
import * as status from "../services/status";
import { selectShipmentDetailPresentation, selectShipmentTimeline, shipmentSelectionEvidence } from "../services/shipment-policy";
import { shipmentNotificationPresentation } from "../services/notification-events";

const waybill = "JT0000000009001";
const timeText = "2026-09-08 12:00:00";
const olderTime = "2026-09-07 10:00:00";
const input = { waybill, courierCode: "JTSD", companyName: "J&T" };
const row = (label: unknown, body = "Parcel event", at = timeText) => ({
  timeText: at, detail: `${label} ${body}`, displayContext: body, jtStatusLabel: label,
});
const timeline = (rows = [row("运输中")]) => webTimelineFromExtraction({ tracks: rows }, input, NOW)!;
const shipment = (value: TimelinePackage): Shipment => ({
  identity: { id: "manual:jt-display", bindingSource: null, sourceOwner: "manual", sourceId: waybill,
    phoneTail: "", courierCode: "JTSD", companyName: "J&T", manuallyAdded: true, createdAtMs: NOW - 86_400_000 },
  timeline: value, manualTimelines: [value], updatedAtMs: NOW,
});
const failures: string[] = [];
let partitions = 0;
function check(name: string, body: () => void) {
  partitions++;
  try { body(); } catch (error) {
    failures.push(name);
    console.error(name, error instanceof Error ? error.message : "failed");
  }
}

check("DOM evidence and display remain separate", () => {
  const value = timeline([row("运输中", "运输中仍是正文的一部分")]);
  const track = value.tracks[0]!;
  assert.equal(track.detail, "运输中 运输中仍是正文的一部分");
  assert.equal(track.raw.jtStatusLabel, "运输中");
  assert.equal(track.raw._pipiStatusSource, "jt_h5");
  assert.equal(track.displayContext, "运输中仍是正文的一部分");
  assert.equal(status.trackDisplayDetail(value.provider, track), "运输中仍是正文的一部分");
});

const labels: Record<StatusSemantic, readonly string[]> = {
  CANCELLED: ["取消", "已取消", "订单取消", "取消订单"],
  DANGER: ["问题件", "异常件", "异常", "运输异常"],
  ORDERED: ["已下单"], SHIPPED: ["已发货"], PICKED: ["揽件", "已揽件", "已揽收"],
  TRANSIT: ["在途", "运输中"], DELIVERY: ["派件", "派送中"],
  WAITING_PICKUP: ["待取", "待取件", "代取件", "待领取"], COMPLETED: ["签收", "已签收"],
  UNKNOWN: ["SYNTHETIC_UNMAPPED", "已签收附加说明", ""],
};
for (const [semantic, words] of Object.entries(labels)) for (const label of words) {
  check(`whole DOM label: ${label || "empty"}`, () => {
    const value = timeline([row(label, "已签收 已下单 已揽件")]);
    assert.equal(value.semantic, semantic);
    assert.equal(value.structuredStatus, semantic !== "UNKNOWN");
    assert.equal(value.statusEventAtMs, semantic === "UNKNOWN" ? null : status.parseProviderTime(timeText));
    assert.equal(status.latestTimelineTrackSemantic(value.tracks), semantic);
    assert.equal(status.containsTimelineOriginTrack(value.tracks), ["ORDERED", "PICKED"].includes(semantic));
  });
}

check("unknown latest label blocks old label and prose status", () => {
  const value = timeline([row("SYNTHETIC_UNMAPPED", "已签收"), row("已揽件", "Parcel collected", olderTime)]);
  assert.equal(value.semantic, "UNKNOWN");
  assert.equal(value.statusEventAtMs, null);
  assert.equal(status.latestTimelineTrackSemantic(value.tracks), "UNKNOWN");
  assert.equal(status.shipmentPresentationStatus(shipment(value)).semantic, "UNKNOWN");
  assert.equal(status.containsTimelinePickupTrack(value.tracks), true, "the actual older origin is still retained");
});

check("empty body retains the node and invalid labels remain unknown", () => {
  const value = timeline([row("运输中", "")]);
  assert.equal(value.tracks.length, 1);
  assert.equal(status.trackDisplayDetail(value.provider, value.tracks[0]!), "运输中");
  assert.equal(value.semantic, "TRANSIT");
  for (const label of [null, 7, ["已签收"], { value: "已签收" }]) {
    const invalid = timeline([row(label, "已签收")]);
    assert.equal(invalid.semantic, "UNKNOWN");
    assert.equal(invalid.statusEventAtMs, null);
    assert.equal(status.containsTimelineOriginTrack(invalid.tracks), false);
  }
});

check("equal-time disagreement never picks an arbitrary label", () => {
  const value = timeline([row("已签收"), row("运输中")]);
  assert.equal(value.tracks.length, 2);
  assert.equal(value.semantic, "UNKNOWN");
  assert.equal(value.statusEventAtMs, null);
  assert.equal(status.latestTimelineTrackSemantic(value.tracks), "UNKNOWN");
});

check("same-time identical full context preserves conflicting independent labels", () => {
  const known = timeline([row("运输中", "")]);
  const unknown = timeline([row("", "运输中")]);
  assert.equal(known.latestDetail, unknown.latestDetail);
  const merged = status.mergeTimelinePackage(known, unknown);
  assert.equal(merged.tracks.length, 2);
  assert.deepEqual(merged.tracks.map(track => track.raw.jtStatusLabel).sort(), ["", "运输中"]);
  assert.equal(status.latestTimelineTrackSemantic(merged.tracks), "UNKNOWN");
  assert.equal(merged.semantic, "TRANSIT", "unknown evidence does not clear the existing valid snapshot");
  assert.equal(merged.statusEventAtMs, known.statusEventAtMs);
});

check("legacy cache and unrelated provider keep their original text and semantics", () => {
  const legacy = webTimelineFromExtraction({ tracks: [{ timeText, detail: "已揽件 Parcel collected" }] }, input, NOW)!;
  assert.equal(legacy.structuredStatus, false);
  assert.equal(legacy.semantic, "PICKED");
  assert.equal(status.containsTimelinePickupTrack(legacy.tracks), true);
  assert.equal(status.trackDisplayDetail("jt_h5", legacy.tracks[0]!), legacy.tracks[0]!.detail);
  const injected = { ...legacy.tracks[0]!, displayContext: "Do not use", raw: { ...legacy.tracks[0]!.raw, jtStatusLabel: "已签收" } };
  assert.equal(status.trackDisplayDetail("k100_h5", injected), injected.detail);
  assert.equal(status.latestTimelineTrackSemantic([injected]), "UNKNOWN");
  assert.equal(status.trackDisplayDetail("jt_h5", { ...injected, displayContext: "  " }), injected.detail);
  assert.equal(status.trackDisplayDetail("jt_h5", { ...injected, displayContext: 7 as unknown as string }), injected.detail);
  const other = webTimelineFromExtraction({ tracks: [row("已签收", "Parcel collected")] },
    { ...input, courierCode: "SF" }, NOW)!;
  assert.equal(other.tracks[0]!.displayContext, undefined);
  assert.equal(other.tracks[0]!.raw.jtStatusLabel, undefined);
});

check("same-event merge and durable normalization preserve optional presentation", () => {
  const value = timeline([row("运输中", "Parcel moving"), row("已揽件", "Parcel collected", olderTime)]);
  const legacy = { ...value, tracks: value.tracks.map(({ displayContext: _display, ...track }) => track) };
  const merged = status.mergeTimelinePackage(value, legacy);
  assert.equal(merged.tracks[0]!.displayContext, "Parcel moving");
  memory.clear();
  saveState({ ...emptyState(), shipments: [shipment(merged)] }, NOW);
  const restored = loadState(NOW).shipments[0]!;
  assert.equal(restored.manualTimelines?.[0]!.tracks[0]!.displayContext, "Parcel moving");
  assert.equal(restored.manualTimelines?.[0]!.tracks[0]!.raw.jtStatusLabel, "运输中");
  assert.equal(selectShipmentDetailPresentation(restored).tracks[0]!.detail, "运输中 Parcel moving");
  assert.equal(status.timelineDisplayDetail(selectShipmentTimeline(restored)), "Parcel moving");
});

check("legacy same-event response cannot detach a captured label from its JT provenance", () => {
  const value = timeline([row("运输中", "已签收只是正文")]);
  const legacy = { ...value, structuredStatus: false, tracks: value.tracks.map(track => ({
    timeText: track.timeText, timeMs: track.timeMs, detail: track.detail, statusCode: "", raw: { _pipiStatusSource: "web" },
  })) };
  for (const [current, incoming] of [[value, legacy], [legacy, value]] as const) {
    const merged = status.mergeTimelinePackage(current, incoming);
    assert.equal(merged.tracks[0]!.raw._pipiStatusSource, "jt_h5");
    assert.equal(merged.tracks[0]!.raw.jtStatusLabel, "运输中");
    assert.equal(merged.tracks[0]!.displayContext, "已签收只是正文");
    assert.equal(status.latestTimelineTrackSemantic(merged.tracks), "TRANSIT");
    assert.equal(status.containsTimelineOriginTrack(merged.tracks), false);
  }
  const valid = { ...legacy.tracks[0]!, statusCode: "SIGNED", raw: { _pipiStatusSource: "web", statusCode: "SIGNED" } };
  const validMerged = status.mergeTracks(value.tracks, [valid]);
  assert.equal(validMerged.length, 2, "different structured sources retain their own conflicting states");
  assert.equal(validMerged[0]!.raw._pipiStatusSource, "web");
  assert.equal(validMerged[0]!.statusCode, "SIGNED");
  assert.equal(status.latestTimelineTrackSemantic(validMerged), "UNKNOWN");
  const account = { ...valid, raw: { ...valid.raw, _pipiStatusSource: "account" } };
  assert.equal(status.mergeTracks(value.tracks, [account])[0]!.raw._pipiStatusSource, "account");
  const noLabel = { ...legacy.tracks[0]!, displayContext: "Only display", raw: { _pipiStatusSource: "jt_h5" } };
  assert.equal(status.mergeTracks([noLabel], legacy.tracks)[0]!.raw._pipiStatusSource, "web");
});

check("unknown or stale labels cannot replace a valid status snapshot", () => {
  const current = timeline([row("运输中")]);
  const unknown = timeline([row("SYNTHETIC_UNMAPPED", "已签收", "2026-09-08 12:01:00")]);
  const merged = status.mergeTimelinePackage(current, unknown);
  assert.equal(merged.semantic, "TRANSIT");
  assert.equal(merged.statusEventAtMs, current.statusEventAtMs);
  const stale = timeline([row("已下单", "Parcel event", olderTime)]);
  const retained = status.mergeTimelinePackage(current, stale);
  assert.equal(retained.semantic, "TRANSIT");
  assert.equal(retained.statusEventAtMs, current.statusEventAtMs);
});

check("near-time legacy duplicate never borrows an older captured label or display", () => {
  const old = timeline([row("运输中", "已签收只是正文")]);
  const newerTime = "2026-09-08 12:01:00";
  const newer = webTimelineFromExtraction({ tracks: [{ timeText: newerTime, detail: old.latestDetail }] }, input, NOW)!;
  const tracks = status.mergeTracks(old.tracks, newer.tracks);
  assert.equal(tracks.length, 1, "the existing five-minute duplicate rule stays unchanged");
  assert.equal(tracks[0]!.timeText, newerTime);
  assert.equal(tracks[0]!.raw._pipiStatusSource, "web");
  assert.equal(tracks[0]!.raw.jtStatusLabel, undefined);
  assert.equal(tracks[0]!.displayContext, undefined);
  assert.equal(status.latestTimelineTrackSemantic(tracks), "UNKNOWN");
  assert.deepEqual(status.latestEventEvidence(tracks), { semantic: "UNKNOWN", eventAtMs: null });
});

check("headline, widgets and notifications use the matching display node only", () => {
  const value = timeline([row("运输中", "Parcel moving"), row("已揽件", "Parcel collected", olderTime)]);
  const item = shipment(value);
  assert.equal(status.timelineDisplayDetail(value), "Parcel moving");
  assert.equal(status.timelineDisplayDetail({ ...value, latestDetail: "Account-owned headline" }), "Account-owned headline");
  assert.equal(status.timelineDisplayDetail({ ...value, latestTimeText: olderTime }), value.latestDetail);
  assert.equal(status.timelineDisplayDetail({ ...value, provider: "interface5" }), value.latestDetail);
  assert.equal(status.buildWidgetSnapshot([item], NOW).rows[0]!.latestDetail, "Parcel moving");
  assert.equal(shipmentNotificationPresentation(item).body, "Parcel moving");
  assert.equal(item.timeline.latestDetail, "运输中 Parcel moving", "display never rewrites stored selection evidence");
});

check("equal account headline keeps its own body when JT owns only the history", () => {
  const value = timeline([row("运输中", "Parcel moving"), row("已揽件", "Parcel collected", olderTime)]);
  const source: TimelinePackage = { ...value, provider: "interface5", tracks: value.tracks.slice(0, 1).map(track => ({
    timeText: track.timeText, timeMs: track.timeMs, detail: track.detail, statusCode: "104",
    raw: { _pipiStatusSource: "interface5", statusCode: "104" },
  })) };
  const base = shipment(value);
  const item: Shipment = { ...base, identity: { ...base.identity, id: "interface5:jt-display", bindingSource: "interface5",
    sourceOwner: "account", sourceProvider: "DouYin", manuallyAdded: false, phone: "13800009001", phoneTail: "9001" },
    timeline: source, sourceTimeline: source };
  const rawBefore = JSON.stringify([source, value]);
  const projected = selectShipmentTimeline(item);
  assert.equal(projected.provider, "jt_h5");
  assert.equal(shipmentSelectionEvidence(item).headlineProvider, "interface5");
  assert.equal(status.timelineDisplayDetail(projected), source.latestDetail);
  assert.equal(status.buildWidgetSnapshot([{ ...item, timeline: projected }], NOW).rows[0]!.latestDetail, source.latestDetail);
  assert.equal(shipmentNotificationPresentation(item).body, source.latestDetail);
  assert.equal(JSON.stringify([source, value]), rawBefore, "projection never changes raw packages");
  const actualJt = selectShipmentTimeline(base);
  assert.equal(status.timelineDisplayDetail(actualJt), "Parcel moving");
  assert.equal(status.timelineDisplayDetail({ ...actualJt, latestDetail: "Replacement donor text" }), "Replacement donor text");
  assert.equal(status.timelineDisplayDetail({ ...actualJt, latestTimeText: olderTime }), actualJt.latestDetail);
});

check("JT headline donor renders its own body while a different provider owns history", () => {
  const jt = timeline([row("派送中", "Actual JT donor body", "2026-09-08 12:01:00")]);
  const history: TimelinePackage = { ...jt, provider: "v6_query", complete: true,
    latestTimeText: timeText, latestDetail: "History original headline", tracks: [
      { timeText, timeMs: status.parseProviderTime(timeText), detail: "History original headline", statusCode: "", raw: {} },
      { timeText: olderTime, timeMs: status.parseProviderTime(olderTime), detail: "Parcel collected", statusCode: "PICKED", raw: { statusCode: "PICKED" } },
    ] };
  const item = { ...shipment(history), manualTimelines: [history, jt],
    detailSelection: { provider: "v6_query", selectedAtMs: NOW } };
  const projected = selectShipmentTimeline(item);
  assert.equal(projected.provider, "v6_query");
  assert.equal(shipmentSelectionEvidence(item).headlineProvider, "jt_h5");
  assert.equal(projected.latestDetail, jt.latestDetail);
  assert.equal(status.timelineDisplayDetail(projected), "Actual JT donor body");
  assert.equal(status.buildWidgetSnapshot([{ ...item, timeline: projected }], NOW).rows[0]!.latestDetail, "Actual JT donor body");
  assert.equal(shipmentNotificationPresentation(item).body, "Actual JT donor body");
  const { headlineDisplay: _hint, ...withoutHint } = projected;
  assert.equal(status.timelineDisplayDetail(withoutHint), jt.latestDetail, "a raw non-JT package cannot borrow JT display metadata");
});

assert.deepEqual(failures, []);
console.log(`JT display and label evidence: ${partitions} partitions passed`);
