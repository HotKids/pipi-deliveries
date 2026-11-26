import assert from "node:assert/strict";
import "./state-storage-mock";
import { internationalShipmentSnapshot } from "../services/international-records";
import { isHiddenCancelledShipment, isHiddenSignedShipment, signedRetentionAtMs } from "../services/status";
import { isStoredShipmentRetained } from "../services/storage";

// G-MED-03 (2026-11-20 review): a terminal international Watch without a valid scan time (no scans, or only scans
// with at = 0) is retained by the cloud record's own update time, 14 days signed / 21 days stored / 4 hours cancelled,
// instead of never expiring. A scan's local wall clock is never read as Beijing time.
const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 25, 4);
const watch = (status: "COMPLETED" | "CANCELLED", updatedAt: number, tracks: unknown[]) =>
  internationalShipmentSnapshot({
    id: "00000000-0000-4000-8000-000000000501", waybill: "WATCHRETAIN1", carrierName: "UPS", icon: "ups",
    status, statusText: status === "COMPLETED" ? "已签收" : "已取消", updatedAt, tracks,
  }, now);

for (const tracks of [[], [{ at: 0, time: new Date(now - 2 * DAY).toISOString().slice(0, 19), detail: "Delivered" }]]) {
  const label = tracks.length ? "untimed scan" : "no scans";
  const signed = watch("COMPLETED", now - 15 * DAY, tracks);
  assert.equal(signedRetentionAtMs(signed, now), now - 15 * DAY, `${label}: the cloud update time anchors retention`);
  assert.equal(isHiddenSignedShipment(signed, now), true, `${label}: hidden after 14 days`);
  assert.equal(isStoredShipmentRetained(signed, now), true, `${label}: kept until day 21`);
  assert.equal(isStoredShipmentRetained(signed, now + 7 * DAY), false, `${label}: removed on day 21`);
  const recent = watch("COMPLETED", now - DAY, tracks);
  assert.equal(isHiddenSignedShipment(recent, now), false, `${label}: a recent update stays visible`);
  const cancelled = watch("CANCELLED", now - 5 * 3_600_000, tracks);
  assert.equal(isHiddenCancelledShipment(cancelled, now), true, `${label}: cancelled hides after 4 hours`);
}

// A timed scan keeps its own epoch, as the list shows it.
const timed = watch("COMPLETED", now - DAY, [{ at: now - 16 * DAY, time: "2026-11-09T08:00:00-05:00", detail: "Delivered" }]);
assert.equal(signedRetentionAtMs(timed, now), now - 16 * DAY);
assert.equal(isHiddenSignedShipment(timed, now), true);
console.log("international Watch retention uses its scan epoch, else the cloud update time");
