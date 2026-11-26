import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "./state-storage-mock";
import { internationalShipmentSnapshot } from "../services/international-records";
import { formatListTime, timelineTimeParts } from "../services/time-presentation";

// 2026-11-20 review, part 3 rule 1: the detail timeline shows every track time as an HH:mm clock above
// an MM-DD date. An international scan used to arrive as a whole ISO instant ("2026-11-18T06:32:00Z")
// that the 52 pt clock line cut to "2026-…", with an empty date and a time eight hours off the list row.
const now = Date.parse("2026-11-20T08:00:00Z");
const pickedUpAt = Date.parse("2026-11-18T03:10:00Z");
const outForDeliveryAt = Date.parse("2026-11-20T06:44:00Z");
const watch = internationalShipmentSnapshot({
  id: "00000000-0000-0000-0000-000000000005", waybill: "SYNTHETIC0005", carrierCode: "fedex",
  carrierName: "FedEx", icon: "fedex", status: "DELIVERY", statusText: "派送中", updatedAt: now - 1_000,
  tracks: [
    { at: pickedUpAt, time: "2026-11-18T03:10:00Z", detail: "广东省深圳市 · 已揽收" },
    { at: 0, time: "2026-11-17T09:00:00", detail: "Memphis, TN, US · Untimed scan" },
    { at: outForDeliveryAt, time: "2026-11-20T06:44:00Z", detail: "Shanghai, CN · 派送中" },
  ],
}, now);

assert.deepEqual(watch.timeline.tracks.map(track => track.timeText),
  ["2026-11-20 14:44", "2026-11-18 11:10", "2026-11-17T09:00:00"],
  "timed scans read in Beijing time; an untimed scan keeps its local time");
assert.equal(watch.timeline.latestTimeText, "2026-11-20 14:44");
assert.equal(formatListTime(watch.timeline.latestTimeText), watch.timeline.tracks[0].timeText,
  "the list row and the detail's first node show the same time");
assert.deepEqual(watch.timeline.tracks.map(track => timelineTimeParts(track.timeText)), [
  { date: "11-20", time: "14:44" },
  { date: "11-18", time: "11:10" },
  { date: "11-17", time: "09:00" },
]);

// The same forms Pipi splits (ExpressTimelineTimeTest).
for (const [raw, date, time] of [
  ["2026-11-18 14:32:00", "11-18", "14:32"],
  ["2026-11-18 14:32", "11-18", "14:32"],
  ["2026-11-18T14:32:00", "11-18", "14:32"],
  ["2026-11-18T14:32", "11-18", "14:32"],
  ["2026-11-18T14:32:00.123", "11-18", "14:32"],
  ["2026-11-18T06:32:00Z", "11-18", "14:32"],
  ["2026-11-18T22:32:00.123Z", "11-19", "06:32"],
  ["2026-11-18T09:32:00+03:00", "11-18", "14:32"],
  ["2026-11-18T06:32Z", "11-18", "14:32"],
  ["2026-11-18 06:32:00Z", "11-18", "14:32"],
  ["", "", ""],
  ["08:45", "", "08:45"],
  ["今天", "", "今天"],
  ["2026-11-18T09:32:00+0300", "", "2026-11-18T09:32:00+0300"],
] as const) {
  assert.deepEqual(timelineTimeParts(raw), { date, time }, raw);
}

// The detail renders those two lines in its fixed-width time column.
const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
assert.match(page, /time: timelineTimeParts\(track\.timeText\)/);
assert.match(page, /frame=\{\{ width: 52, alignment: "trailing" \}\}/);
console.log("International detail times read in Beijing time in two lines");
