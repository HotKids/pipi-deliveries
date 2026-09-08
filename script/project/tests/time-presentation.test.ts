import assert from "node:assert/strict";
import {
  compactTimelineTime,
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
