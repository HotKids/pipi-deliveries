import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { internationalShipmentSnapshot, watchDetailOpenRefreshes } from "../services/international-records";

// G-MED-02 (2026-11-20 review): opening a terminal Watch parcel that already shows its scans sends no Watch page
// read; a parcel still under way, or one without scans, reads it on open as before, and a pull always reads it.
const now = Date.UTC(2026, 10, 25, 4);
const watch = (status: string, tracks: unknown[]) => internationalShipmentSnapshot({
  id: "00000000-0000-4000-8000-000000000601", waybill: "WATCHOPEN1", carrierName: "DHL", icon: "dhl",
  status, statusText: status, updatedAt: now - 60_000, tracks,
}, now);
const scans = [{ at: now - 60_000, time: new Date(now - 60_000).toISOString(), detail: "Synthetic scan" }];
assert.equal(watchDetailOpenRefreshes(watch("COMPLETED", scans)), false);
assert.equal(watchDetailOpenRefreshes(watch("CANCELLED", scans)), false);
assert.equal(watchDetailOpenRefreshes(watch("COMPLETED", [])), true, "a terminal row without scans still reads them");
for (const status of ["TRANSIT", "DELIVERY", "DANGER", "UNKNOWN", "ORDERED"]) {
  assert.equal(watchDetailOpenRefreshes(watch(status, scans)), true, status);
}
// A local manual sign-off does not end the source's own refresh.
assert.equal(watchDetailOpenRefreshes({ ...watch("TRANSIT", scans), forcedCompletedAtMs: now }), true);

const home = readFileSync(new URL("../pages/HomePage.tsx", import.meta.url), "utf8");
assert.match(home, /refreshOnAppear=\{internationalShipment\(selected\)\s*\?\s*watchDetailOpenRefreshes\(selected\) \? "detail_open" : false/,
  "the Home detail entry asks the Watch rule before reading the page");
const detail = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
assert.match(detail, /if \(forceManualRefresh && pullInFlightRef\.current\) return pullInFlightRef\.current;/,
  "a pull keeps its own refresh path");
console.log("terminal Watch details open without a Watch page read");

// G-LOW-03 (2026-11-20 review): the detail hotline reads the carrier table for every parcel, a Watch included; the
// Watch carriers have no table row today, so nothing is shown, and a row added later would show like any carrier's.
assert.doesNotMatch(detail, /syncedInternational \? "" : courierHotline\(/, "no Watch-only hotline branch");
assert.match(detail, /const hotline = courierHotline\(\s*shipment\.identity\.courierCode,\s*shipment\.identity\.companyName,\s*\);/);
const { courierHotline } = await import("../services/carrier-presentation");
const ups = watch("TRANSIT", scans);
assert.equal(courierHotline(ups.identity.courierCode, ups.identity.companyName), "");
console.log("the detail hotline has one rule for every parcel");
