import assert from "node:assert/strict";
import "./state-storage-mock";
import { saveGatewayToken } from "../services/credentials";
import { activeWatchScope, internationalShipmentSnapshot } from "../services/international-records";
import { selectShipmentDetailTimeline, selectShipmentTimeline } from "../services/shipment-policy";
import { listHeadline, shipmentPresentationStatus, sortShipments } from "../services/status";
import { commitWatchSnapshot, loadWidgetSnapshot, visibleShipments } from "../services/storage";
import { formatListTime } from "../services/time-presentation";

// R5 follow-up (owner 2026-11-25 「所有展示面都跳过（推荐）」): while a lagging Watch summary holds the newest
// delivered, exception or returned scans, the Bot's cloud Watch record says how many of its newest-first tracks are
// held (`heldTracks`). No surface leads with them: the list row, the widget, the row's sort time and every other
// headline reader skip them, while the detail timeline keeps every scan. Identities are synthetic.
saveGatewayToken("SyntheticKey_041");
const scope = activeWatchScope();
assert.ok(scope);
const now = Date.now();
const pickedUpAt = now - 2 * 86_400_000;
const outForDeliveryAt = now - 3 * 3_600_000;
const deliveredAt = now - 60_000;
const held = { at: deliveredAt, time: "", detail: "Shanghai, CN · 已签收" };
const shown = { at: outForDeliveryAt, time: "", detail: "Shanghai, CN · 派送中" };
const picked = { at: pickedUpAt, time: "", detail: "Memphis, TN, US · 已揽收" };
const record = (id: string, extra: Record<string, unknown>) => ({
  id: `00000000-0000-0000-0000-0000000000${id}`, waybill: `SYNTHETIC00${id}`, carrierCode: "fedex",
  carrierName: "FedEx", icon: "fedex", status: "DELIVERY", statusText: "派送中", updatedAt: now - 1_000,
  tracks: [held, shown, picked], ...extra,
});

const lagging = internationalShipmentSnapshot(record("41", { heldTracks: 1 }), now);
assert.equal(lagging.timeline.semantic, "DELIVERY", "the record's status is read as before");
assert.equal(lagging.timeline.latestDetail, shown.detail, "the headline starts after the held scan");
assert.equal(lagging.timeline.latestTimeText, formatListTime(new Date(outForDeliveryAt).toISOString()));
assert.equal(lagging.timeline.statusEventAtMs, outForDeliveryAt, "the row's time is its headline scan's");
assert.deepEqual(lagging.timeline.tracks.map(track => track.detail), [held.detail, shown.detail, picked.detail],
  "the stored history keeps the held scan");

// Every held scan: the headline falls back to the status text, as the Bot's notice card does.
const allHeld = internationalShipmentSnapshot(record("42", { heldTracks: 3, tracks: [held] }), now);
assert.equal(allHeld.timeline.latestDetail, "派送中");
assert.equal(allHeld.timeline.latestTimeText, "");
assert.equal(allHeld.timeline.statusEventAtMs, null);
assert.equal(allHeld.timeline.tracks.length, 1);

// A terminal status has caught up: nothing is held, whatever the record says.
const signed = internationalShipmentSnapshot(record("43", { status: "COMPLETED", statusText: "已签收", heldTracks: 1 }), now);
assert.equal(signed.timeline.latestDetail, held.detail);
assert.equal(signed.timeline.statusEventAtMs, deliveredAt);

// Absent or invalid reads as 0, so an older Bot record keeps today's headline.
for (const heldTracks of [undefined, 0, -1, 1.5, "1", null, true, Number.NaN]) {
  const extra = heldTracks === undefined ? {} : { heldTracks };
  const row = internationalShipmentSnapshot(record("44", extra), now);
  assert.equal(row.timeline.latestDetail, held.detail, `heldTracks ${String(heldTracks)}`);
  assert.equal(row.timeline.statusEventAtMs, deliveredAt, `heldTracks ${String(heldTracks)}`);
}

// The stored rows: list row, widget, detail, sort order and the tracks-only headline (screen shortcut).
const older = internationalShipmentSnapshot(record("45", { tracks: [
  { at: outForDeliveryAt + 60_000, time: "", detail: "Beijing, CN · 派送中" }, picked] }), now);
const state = commitWatchSnapshot({ scope, snapshot: "snapshot-held", observedAtMs: now,
  shipments: [lagging, allHeld, older] });
const rows = visibleShipments(state);
const byId = new Map(rows.map(row => [row.identity.id, row]));
const listed = byId.get(lagging.identity.id)!;
const listedAllHeld = byId.get(allHeld.identity.id)!;
assert.deepEqual(shipmentPresentationStatus(listed), { semantic: "DELIVERY", text: "派送中" });
assert.equal(listHeadline(listed.timeline)?.detail, shown.detail, "the list row skips the held scan");
assert.equal(listHeadline(selectShipmentTimeline(listed), true)?.detail, shown.detail,
  "a tracks-only headline skips it too");
assert.equal(listed.timeline.statusEventAtMs, outForDeliveryAt);
assert.deepEqual(selectShipmentDetailTimeline(listed).tracks.map(track => track.detail),
  [held.detail, shown.detail, picked.detail], "the detail timeline still shows every scan");
assert.equal(listHeadline(listedAllHeld.timeline)?.detail, "派送中");
assert.equal(listHeadline(listedAllHeld.timeline)?.timeText, "");
assert.equal(listHeadline(selectShipmentTimeline(listedAllHeld), true)?.detail, "派送中");
assert.equal(selectShipmentDetailTimeline(listedAllHeld).tracks.length, 1);
const widgetRows = new Map(loadWidgetSnapshot().rows.map(row => [row.shipmentId, row]));
assert.equal(widgetRows.get(lagging.identity.id)?.latestDetail, shown.detail, "the widget skips the held scan");
assert.equal(widgetRows.get(allHeld.identity.id)?.latestDetail, "派送中");
// The held scan is newer than the other parcel's headline, but the row sorts by the scan it shows.
assert.deepEqual(sortShipments([listed, byId.get(older.identity.id)!]).map(row => row.identity.id),
  [older.identity.id, lagging.identity.id]);

// A held scan the status would otherwise borrow as its headline (the status time falls back to the newest scan when
// no scan is shown) still does not lead.
const unworded = internationalShipmentSnapshot(record("46", { heldTracks: 1,
  tracks: [{ at: deliveredAt, time: "", detail: "Shanghai, CN · Left at front door" }] }), now);
const [listedUnworded] = visibleShipments(commitWatchSnapshot({ scope, snapshot: "snapshot-unworded",
  observedAtMs: now + 1, shipments: [unworded] }));
assert.equal(listHeadline(listedUnworded.timeline)?.detail, "派送中");
assert.equal(loadWidgetSnapshot().rows[0]?.latestDetail, "派送中");

// A provider-error scan the stored row drops does not hand the headline to the held scan either.
const withError = internationalShipmentSnapshot(record("47", { heldTracks: 1,
  tracks: [held, { at: outForDeliveryAt + 60_000, time: "", detail: "No result" }, shown] }), now);
const [listedWithError] = visibleShipments(commitWatchSnapshot({ scope, snapshot: "snapshot-error",
  observedAtMs: now + 2, shipments: [withError] }));
assert.equal(listHeadline(listedWithError.timeline)?.detail, shown.detail);

// The next page, once the summary caught up, leads with the delivered scan.
const caughtUp = internationalShipmentSnapshot(record("41", { status: "COMPLETED", statusText: "已签收", heldTracks: 0 }), now);
const after = visibleShipments(commitWatchSnapshot({ scope, snapshot: "snapshot-caught-up", observedAtMs: now + 3,
  shipments: [caughtUp] }));
assert.equal(listHeadline(after[0].timeline)?.detail, held.detail);
console.log("Held Watch scans never lead a headline; the detail keeps them");
