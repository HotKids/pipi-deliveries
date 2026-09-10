import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import { memory, NOW, sha256 } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { applyManualShipment } from "../services/shipment-policy";
import { normalizeTimelineSlot } from "../services/timeline-slot";
import { readDiagnostics, setDiagnosticsEnabled, writeDiagnostic } from "../services/logger";

const waybill = "SF123456789012";
function pack(provider: string, detail: string, offset = 0): TimelinePackage {
  return { provider, waybill, courierCode: "SF", rawCourierCode: "SF", companyName: "Carrier",
    complete: false, structuredStatus: true, semantic: "TRANSIT", statusEventAtMs: NOW + offset,
    latestTimeText: "2026-09-08 14:00:00", latestDetail: detail, successAtMs: NOW + offset,
    tracks: [{ timeMs: NOW + offset, timeText: "2026-09-08 14:00:00", detail, statusCode: "2", raw: {} }] };
}
function row(manuallyAdded: boolean): Shipment {
  return { identity: { id: `interface5:${waybill}`, bindingSource: "interface5", sourceOwner: manuallyAdded ? "manual" : "account",
    sourceId: waybill, phoneTail: "", courierCode: "SF", companyName: "Carrier", sourceProvider: "ShunFeng",
    manuallyAdded, createdAtMs: NOW - 60_000 }, timeline: pack("v6_picker", "Older node"),
    detailSelection: { provider: "v6_picker", selectedAtMs: NOW - 1000 }, updatedAtMs: NOW };
}
function seed(shipment: Shipment): void {
  memory.clear();
  const state = { ...emptyState(), revision: 10, updatedAtMs: NOW, feedSlotRebuiltAtMs: NOW, shipments: [shipment] };
  memory.set("pipi_deliveries_state_v1", { schema: 2, checksum: sha256(JSON.stringify(state)), state });
}

// Legacy primary-only rows must retain their history and selection without requiring a query.
seed(row(true));
const restored = loadState(NOW).shipments[0]!;
assert.equal(restored.timeline.provider, "v6_query");
assert.equal(restored.manualTimelines?.[0]?.provider, "v6_query");
assert.deepEqual(restored.detailSelection, { provider: "v6_query", selectedAtMs: NOW - 1000 });
assert.equal(restored.timeline.tracks[0]?.detail, "Older node");
assert.deepEqual(loadState(NOW), loadState(NOW), "migration is idempotent across durable reloads");
for (const key of ["pipi_deliveries_state_v1", "pipi_deliveries_state_backup_v1"]) {
  assert.equal(JSON.stringify(memory.get(key)).includes("v6_picker"), false, "healed state writes only the canonical slot");
}

// A partially upgraded row may contain both names. They are one source, while the feed and KDNiao remain separate.
const automatic = row(false);
automatic.timeline = pack("interface5", "Feed node");
automatic.sourceTimeline = automatic.timeline;
automatic.manualTimelines = [pack("v6_picker", "Older node", -1000), pack("v6_query", "Newer node"), pack("kdniao", "Other provider")];
seed(automatic);
const migrated = loadState(NOW).shipments[0]!;
const meizu = migrated.manualTimelines?.filter(value => value.provider === "v6_query") || [];
assert.equal(meizu.length, 1);
assert.deepEqual(new Set(meizu[0]!.tracks.map(value => value.detail)), new Set(["Older node", "Newer node"]));
assert.deepEqual(migrated.sourceTimeline, automatic.sourceTimeline);
assert.deepEqual(migrated.manualTimelines?.find(value => value.provider === "kdniao"), automatic.manualTimelines[2]);
assert.equal(migrated.identity.sourceProvider, "ShunFeng", "business ownership is not a timeline slot");
assert.deepEqual(migrated.detailSelection, { provider: "v6_query", selectedAtMs: NOW - 1000 });
const incoming = { ...migrated, timeline: pack("v6_query", "Current response", 1000), manualTimelines: [pack("v6_query", "Current response", 1000)] };
const saved = saveState({ ...emptyState(), shipments: [applyManualShipment(migrated, incoming, NOW + 1000)] }, NOW + 1000).shipments[0]!;
assert.deepEqual(new Set(saved.manualTimelines?.find(value => value.provider === "v6_query")?.tracks.map(value => value.detail)),
  new Set(["Older node", "Newer node", "Current response"]));
assert.equal(JSON.stringify(saved).includes("v6_picker"), false);

// Renaming a signed history must not erase its terminal latch or let a later transit packet roll it back.
const signed = row(true);
signed.timeline = { ...signed.timeline, semantic: "COMPLETED", statusEventAtMs: NOW - 1000 };
signed.settledAtMs = NOW - 1000;
seed(signed);
const signedBefore = loadState(NOW).shipments[0]!;
const transit = { ...signedBefore, timeline: pack("v6_query", "Later transit", 1000), manualTimelines: [pack("v6_query", "Later transit", 1000)] };
const signedAfter = saveState({ ...emptyState(), shipments: [applyManualShipment(signedBefore, transit, NOW + 1000)] }, NOW + 1000).shipments[0]!;
assert.equal(signedAfter.timeline.provider, "v6_query");
assert.equal(signedAfter.timeline.semantic, "COMPLETED");
assert.equal(signedAfter.settledAtMs, NOW - 1000);

for (const alias of ["route", "meizu", "meizu_picker", "v6_picker", "v6_query"]) assert.equal(normalizeTimelineSlot(alias), "v6_query");
for (const other of ["v5_query", "k100_h5", "v2_query", "kdniao"]) assert.equal(normalizeTimelineSlot(other), other);

// Old log records and fresh calls that still supply a legacy input display/write the same canonical identity.
setDiagnosticsEnabled(true);
memory.set("pipi_deliveries_diagnostic_log_v1", [{ at: new Date().toISOString(), level: "info", event: "manual.source.succeeded",
  details: { stage: "v6_picker", level: "v6_picker", timelineProvider: "v6_picker", detailTimelineProvider: "v6_picker" } }]);
assert.equal(JSON.stringify(readDiagnostics()).includes("v6_picker"), false);
writeDiagnostic("manual.source.succeeded", { stage: "v6_picker", level: "v6_picker", timelineProvider: "v6_picker" });
assert.equal(JSON.stringify(memory.get("pipi_deliveries_diagnostic_log_v1")).includes("v6_picker"), false);
console.log("Meizu canonical slot migration and same-source history tests passed");
