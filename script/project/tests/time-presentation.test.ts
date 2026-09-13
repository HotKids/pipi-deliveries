import assert from "node:assert/strict";
import {
  compactTimelineTime,
  formatListTime,
  timelineTimeParts,
} from "../services/time-presentation";

assert.deepEqual(timelineTimeParts("2026-08-27 03:17:48"), {
  date: "08-27",
  time: "03:17",
});
assert.equal(
  compactTimelineTime("2026-08-27 03:17:48", new Date(2026, 7, 27, 8)),
  "03:17",
);
assert.equal(
  compactTimelineTime("2026-08-26 22:41:01", new Date(2026, 7, 27, 8)),
  "08-26",
);
assert.equal(compactTimelineTime("刚刚更新", new Date()), "刚刚更新");

assert.equal(formatListTime("2026-09-13 15:49:59"), "2026-09-13 15:49");
assert.equal(formatListTime("2026-09-13T15:49"), "2026-09-13 15:49");
assert.equal(formatListTime("2026-09-13T07:49:59.637Z"), "2026-09-13 15:49");
assert.equal(formatListTime("2026-09-13T07:49+00:00"), "2026-09-13 15:49");
assert.equal(formatListTime("2026-09-13T23:49:00-04:00"), "2026-09-14 11:49");
assert.equal(formatListTime("2025-12-31T20:00:00Z"), "2026-01-01 04:00");
assert.equal(formatListTime("2026-02-30 15:49:00"), "2026-02-30 15:49:00");
assert.equal(formatListTime("刚刚更新"), "刚刚更新");
assert.equal(formatListTime(""), "");
