import assert from "node:assert/strict";
import type { AppState, Shipment, TimelinePackage } from "../models";
import { memory, NOW, sha256 } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";

const waybill = "SF123456789012";
function pack(provider: string, detail: string): TimelinePackage {
  return { provider, waybill, courierCode: "SF", rawCourierCode: "SF", companyName: "Carrier",
    complete: false, structuredStatus: true, semantic: "TRANSIT", statusEventAtMs: NOW,
    latestTimeText: "2026-09-08 14:00:00", latestDetail: detail, successAtMs: NOW,
    tracks: [{ timeMs: NOW, timeText: "2026-09-08 14:00:00", detail, statusCode: "2", raw: {} }] };
}
function row(manuallyAdded = false): Shipment {
  return { identity: { id: `interface5:${waybill}`, bindingSource: "interface5",
    sourceOwner: manuallyAdded ? "manual" : "account", sourceId: waybill, phoneTail: "",
    courierCode: "SF", companyName: "Carrier", sourceProvider: "ShunFeng", manuallyAdded,
    createdAtMs: NOW - 60_000 }, timeline: pack("interface5", "Account node"),
    manualRefreshAttemptAtMs: NOW - 1000,
    manualRefreshLease: { attemptId: "retained-attempt", startedAtMs: NOW - 1000, expiresAtMs: NOW + 1000 },
    updatedAtMs: NOW };
}
function seed(shipments: Shipment[]): AppState {
  memory.clear();
  const state = { ...emptyState(), revision: 10, updatedAtMs: NOW, feedSlotRebuiltAtMs: NOW, shipments };
  memory.set("pipi_deliveries_state_v1", { schema: 2, checksum: sha256(JSON.stringify(state)), state });
  return loadState(NOW);
}

// Clearing a removed sticky selection must leave the surviving source caches and cooldowns unchanged.
const current = row();
current.sourceTimeline = current.timeline;
current.manualTimelines = [pack("v6_query", "Canonical node"), pack("kdniao", "Other provider")];
const baseline = seed([current]);
const mixed: Shipment = { ...current, timeline: pack("v6_picker", "Retired primary"),
  detailSelection: { provider: "meizu_picker", selectedAtMs: NOW - 500 },
  manualTimelines: [pack("v6_picker", "Retired first"), ...current.manualTimelines,
    pack("meizu_picker", "Retired second")] };
const cleaned = seed([mixed]);
assert.deepEqual(cleaned, baseline, "cleanup only removes retired history and its sticky reference");
assert.equal(cleaned.shipments[0]!.timeline.provider, "v6_query");
const saved = saveState(cleaned, NOW);
assert.deepEqual(loadState(NOW), saved, "the next durable write cannot restore a removed slot");
assert.deepEqual(loadState(NOW), loadState(NOW), "cleanup is idempotent");

// A valid canonical selection is not invalidated just because retired sidecars are present.
const selected = { ...current, detailSelection: { provider: "v6_query", selectedAtMs: NOW - 500 } };
const selectedBaseline = seed([selected]);
assert.deepEqual(seed([{ ...selected, manualTimelines: mixed.manualTimelines }]), selectedBaseline);

// With no surviving manual cache, an automatic parcel uses its own retained account package.
for (const provider of ["v6_picker", "meizu_picker", " V6_PICKER "]) {
  const feedOnly = seed([{ ...current, manualTimelines: [] }]);
  assert.deepEqual(seed([{ ...current, timeline: pack(provider, "Retired only"),
    manualTimelines: [pack(provider, "Retired only")],
    detailSelection: { provider, selectedAtMs: NOW } }]), feedOnly);
}

// Duplicate manual owners must discard retired status before the ordinary same-waybill merge.
const manual = { ...row(true), timeline: pack("v6_query", "Canonical node"),
  manualTimelines: [pack("v6_query", "Canonical node")] };
const old = { ...manual, identity: { ...manual.identity, id: "retired-owner" },
  timeline: { ...pack("meizu_picker", "Retired signed node"), semantic: "COMPLETED" as const },
  manualTimelines: undefined, updatedAtMs: NOW - 1000 };
const duplicate = seed([old, manual]).shipments[0]!;
assert.equal(duplicate.timeline.semantic, "TRANSIT");
assert.deepEqual(duplicate.manualTimelines, manual.manualTimelines);
assert.equal(duplicate.manualRefreshAttemptAtMs, manual.manualRefreshAttemptAtMs);
assert.deepEqual(duplicate.manualRefreshLease, manual.manualRefreshLease);

// A legacy package stranded in an ownership observation cannot later reappear on takeover.
const observed = seed([current]).shipments[0]!;
const ownership = observed.automaticOwnership!;
const observation = ownership.observations[0]!;
const oldObservation = { ...observation, sourceTimeline: pack("meizu_picker", "Retired observation") };
const withOldObservation: Shipment = { ...observed, sourceTimeline: pack("v6_picker", "Retired source"),
  automaticOwnership: { ...ownership, observations: [oldObservation] } };
const repaired = seed([withOldObservation]).shipments[0]!;
assert.equal(repaired.sourceTimeline?.provider, "none");
assert.deepEqual(repaired.sourceTimeline?.tracks, []);
assert.deepEqual(repaired.automaticOwnership?.observations[0], {
  ...oldObservation, sourceTimeline: repaired.sourceTimeline,
});
assert.deepEqual(repaired.manualTimelines, observed.manualTimelines);
assert.equal(repaired.timeline.provider, "v6_query");

// User-forced completion is independent of the removed provider cache.
const forced = seed([{ ...row(true), timeline: pack("v6_picker", "Retired forced history"),
  forcedCompletedAtMs: NOW - 500 }]).shipments[0]!;
assert.equal(forced.forcedCompletedAtMs, NOW - 500);
assert.equal(forced.timeline.semantic, "COMPLETED");
assert.deepEqual(forced.timeline.tracks, []);
assert.equal(forced.manualRefreshAttemptAtMs, NOW - 1000);
assert.deepEqual(forced.manualRefreshLease, row(true).manualRefreshLease);
console.log("Meizu retired slots, selection recovery, owner isolation and cooldown tests passed");
