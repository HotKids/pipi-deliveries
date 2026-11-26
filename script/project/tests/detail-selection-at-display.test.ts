import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import { emptyState, loadState, recordShipmentDetailSelection, saveState } from "../services/storage";
import { selectShipmentDetailTimeline } from "../services/shipment-policy";
import { parseProviderTime } from "../services/status";

// Audit D7 (adopted 2026-09-25): the sticky detail selection is recorded when the detail page shows a
// package, as on Lite (every render) and Pipi (every detail load). iOS recorded it only when a detail
// refresh committed, so a package arriving later from the list or a background round could take over
// the one the user had been looking at.
const WAYBILL = "YT0000000007707";
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

function pack(provider: string, count: number): TimelinePackage {
  const tracks = Array.from({ length: count }, (_, i) => {
    const at = NOW - 3600000 - i * 60_000;
    return { timeText: providerTime(at), timeMs: parseProviderTime(providerTime(at)), detail: `Synthetic ${provider} ${i}`,
      statusCode: "", raw: {} };
  });
  return { provider, waybill: WAYBILL, courierCode: "YTO", companyName: "圆通速递", semantic: "TRANSIT",
    statusEventAtMs: null, latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks,
    successAtMs: NOW, complete: false };
}

function manualRow(manualTimelines: TimelinePackage[]): Shipment {
  return {
    identity: { id: `interface5:manual:${WAYBILL}`, bindingSource: "interface5", sourceOwner: "manual",
      sourceId: WAYBILL, phoneTail: "", phone: "", courierCode: "YTO", companyName: "圆通速递",
      manuallyAdded: true, createdAtMs: NOW - 86400000 },
    timeline: manualTimelines[0], sourceTimeline: null, manualTimelines, route: null, accountRecord: null,
    updatedAtMs: NOW - 60_000,
  };
}

memory.clear();
const shown = pack("k100_h5", 3);
saveState({ ...emptyState(), shipments: [manualRow([shown])] }, NOW);
const id = `interface5:manual:${WAYBILL}`;
assert.equal(selectShipmentDetailTimeline(loadState(NOW).shipments[0]).provider, "k100_h5");
assert.ok(recordShipmentDetailSelection(id, NOW), "showing the package records it");
assert.equal(loadState(NOW).shipments[0].detailSelection?.provider, "k100_h5");
assert.equal(recordShipmentDetailSelection(id, NOW + 1), null, "an unchanged selection writes nothing");
assert.equal(recordShipmentDetailSelection("interface5:manual:MISSING", NOW), null);

// A richer but still incomplete package arriving later does not replace the package on screen.
const later = { ...loadState(NOW).shipments[0], manualTimelines: [shown, pack("v6_query", 5)] };
assert.equal(selectShipmentDetailTimeline(later).provider, "k100_h5", "the shown package stays");
const { detailSelection: _ignored, ...unrecorded } = later;
assert.equal(selectShipmentDetailTimeline(unrecorded).provider, "v6_query",
  "without the recorded selection the new package would have taken over");

// The page records the package it shows, except for a manual query preview.
const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
assert.match(page,
  /if \(!props\.manualPreview\) \{\s*try \{\s*recordShipmentDetailSelection\(shipment\.identity\.id\);[\s\S]*?\}, \[shipment\.identity\.id, selectionSignature\]\);/,
  "the selection effect records the shown package");

console.log("detail selection at display tests passed");
