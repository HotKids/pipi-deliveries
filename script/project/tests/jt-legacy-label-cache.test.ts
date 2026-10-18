import assert from "node:assert/strict";
import { memory, NOW, sha256 } from "./state-storage-mock";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import { emptyState, loadState, saveState } from "../services/storage";
import { webTimelineFromExtraction } from "../services/web-timeline";
import { containsTimelinePickupTrack, latestTimelineTrackSemantic, parseProviderTime } from "../services/status";

const oldTime = "2026-09-08 11:00:00";
const newTime = "2026-09-08 12:00:00";
const input = { waybill: "JT0000000009001", courierCode: "JTSD", companyName: "J&T" };
const oldNode = (label = "", source = "jt_h5"): TrackNode => ({
  timeText: oldTime, timeMs: parseProviderTime(oldTime),
  detail: "已揽件 Parcel collected", displayContext: "已揽件 Parcel collected", statusCode: "",
  raw: { _pipiStatusSource: source, jtStatusLabel: label },
});
const timeline = (tracks: TrackNode[], extra: Partial<TimelinePackage> = {}): TimelinePackage => ({
  provider: "jt_h5", waybill: input.waybill, courierCode: "JTSD", companyName: "J&T",
  semantic: "UNKNOWN", structuredStatus: false, statusEventAtMs: null, complete: false,
  latestTimeText: tracks[0]!.timeText, latestDetail: tracks[0]!.detail, tracks, successAtMs: NOW,
  ...extra,
});
const shipment = (value: TimelinePackage): Shipment => ({
  identity: { id: "manual:jt-legacy", bindingSource: null, sourceOwner: "manual", sourceId: input.waybill,
    phoneTail: "", courierCode: "JTSD", companyName: "J&T", manuallyAdded: true, createdAtMs: NOW - 86_400_000 },
  timeline: value, manualTimelines: [value], updatedAtMs: NOW,
});

function readLegacy(value: TimelinePackage): Shipment {
  memory.clear();
  const state = { ...emptyState(), shipments: [shipment(value)] };
  const stored = { schema: 2, state, checksum: sha256(JSON.stringify(state)) };
  // Load the pre-fix bytes directly; saveState would first apply current normalization.
  memory.set("pipi_deliveries_state_v1", stored);
  memory.set("pipi_deliveries_state_backup_v1", stored);
  return loadState(NOW).shipments[0]!;
}

let partitions = 0;
function check(name: string, body: () => void) {
  body();
  partitions++;
  console.log(name);
}

check("old empty-label cache recovers only origin evidence, without inventing a status", () => {
  const restored = readLegacy(timeline([oldNode()]));
  for (const value of [restored.timeline, ...restored.manualTimelines || []]) {
    assert.equal(Object.hasOwn(value.tracks[0]!.raw, "jtStatusLabel"), false);
    assert.equal(value.tracks[0]!.raw._pipiStatusSource, "web");
    assert.equal(containsTimelinePickupTrack(value.tracks), true);
    assert.equal(latestTimelineTrackSemantic(value.tracks), "UNKNOWN");
    assert.equal(value.semantic, "UNKNOWN");
    assert.equal(value.structuredStatus, false);
    assert.equal(value.statusEventAtMs, null);
    assert.equal(value.tracks[0]!.detail, "已揽件 Parcel collected");
    assert.equal(value.tracks[0]!.displayContext, "已揽件 Parcel collected");
  }
  saveState({ ...emptyState(), shipments: [restored] }, NOW);
  const reread = loadState(NOW).shipments[0]!;
  assert.equal(Object.hasOwn(reread.manualTimelines![0]!.tracks[0]!.raw, "jtStatusLabel"), false);
  assert.equal(containsTimelinePickupTrack(reread.timeline.tracks), true);
});

check("signed cached rows repair their old origin node without recapture or status changes", () => {
  const signed: TrackNode = { timeText: newTime, timeMs: parseProviderTime(newTime),
    detail: "已签收 Parcel delivered", displayContext: "Parcel delivered", statusCode: "",
    raw: { _pipiStatusSource: "jt_h5", jtStatusLabel: "已签收" } };
  const value = timeline([signed, oldNode()], { semantic: "COMPLETED", structuredStatus: true,
    complete: true, statusEventAtMs: signed.timeMs });
  const restored = readLegacy(value);
  assert.equal(restored.timeline.semantic, "COMPLETED");
  assert.equal(restored.timeline.statusEventAtMs, signed.timeMs);
  assert.equal(restored.timeline.latestTimeText, newTime);
  assert.equal(restored.timeline.tracks.length, 2);
  assert.equal(containsTimelinePickupTrack(restored.timeline.tracks), true);
  assert.equal(restored.timeline.tracks[0]!.raw.jtStatusLabel, "已签收");
});

check("nonempty unknown and malformed labels never gain prose origin or status", () => {
  for (const label of ["SYNTHETIC_UNMAPPED", "已签收附加说明", null, 7]) {
    const node = oldNode();
    node.raw.jtStatusLabel = label;
    const restored = readLegacy(timeline([node]));
    assert.equal(restored.timeline.tracks[0]!.raw.jtStatusLabel, label);
    assert.equal(containsTimelinePickupTrack(restored.timeline.tracks), false);
    assert.equal(latestTimelineTrackSemantic(restored.timeline.tracks), "UNKNOWN");
    assert.equal(restored.timeline.semantic, "UNKNOWN");
  }
});

check("a newly captured explicit empty element retains labelled UNKNOWN after persistence", () => {
  const captured = webTimelineFromExtraction({ tracks: [{
    timeText: oldTime, detail: "已揽件 Parcel collected", displayContext: "已揽件 Parcel collected", jtStatusLabel: "",
  }] }, input, NOW)!;
  memory.clear();
  saveState({ ...emptyState(), shipments: [shipment(captured)] }, NOW);
  const restored = loadState(NOW).shipments[0]!;
  assert.equal(restored.timeline.tracks[0]!.raw.jtStatusLabel, "");
  assert.equal(containsTimelinePickupTrack(restored.timeline.tracks), false);
  assert.equal(restored.timeline.semantic, "UNKNOWN");
});

check("an empty field outside the JT capture provenance is left untouched", () => {
  const restored = readLegacy(timeline([oldNode("", "account")]));
  assert.equal(restored.timeline.tracks[0]!.raw.jtStatusLabel, "");
  assert.equal(restored.timeline.tracks[0]!.raw._pipiStatusSource, "account");
});

check("other provider packages do not receive the JT cache migration", () => {
  const restored = readLegacy(timeline([oldNode()], { provider: "v6_query" }));
  assert.equal(restored.timeline.tracks[0]!.raw.jtStatusLabel, "");
  assert.equal(restored.timeline.tracks[0]!.raw._pipiStatusSource, "jt_h5");
});

console.log(`JT legacy label cache: ${partitions} partitions passed`);
