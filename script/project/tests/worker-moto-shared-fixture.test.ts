import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseMotoTimeline } from "../services/manual-query-parser";
import { containsTimelineStartTrack, containsTimelinePickupTrack, latestTimelineTrackSemantic } from "../services/status";

// The formal Worker regression also compares its actual output with these shared bytes.
const response = JSON.parse(readFileSync(new URL(
  "../../../../flutter_app/android/app/src/test/resources/express/moto-packet-pickup.json",
  import.meta.url,
), "utf8"));
const parsed = parseMotoTimeline(response);
assert.equal(parsed.semantic, "PICKED");
assert.equal(parsed.statusEventAtMs, 1789286113000);
assert.equal(parsed.tracks.length, 2);
assert.equal(latestTimelineTrackSemantic(parsed.tracks), "PICKED",
  "the real iOS parser must retain the packet status paired with the newest node");
assert.equal(containsTimelineStartTrack(parsed.tracks), true);
assert.equal(containsTimelinePickupTrack(parsed.tracks), true);
assert.equal(containsTimelineStartTrack(parsed.tracks.filter(track => track.timeMs !== parsed.statusEventAtMs)), false,
  "older enum-free nodes cannot inherit the packet pickup");
console.log("Shared formal Worker Moto fixture preserves iOS pickup evidence");
