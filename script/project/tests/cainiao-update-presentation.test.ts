import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import { parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import {
  applyAccountShipment,
  applyTargetedAccountShipment,
  asAccountDetailObservation,
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
  shipmentDetailIncompleteReason,
  shipmentSelectionEvidence,
} from "../services/shipment-policy";
import { emptyState, loadState, saveState } from "../services/storage";
import { parseProviderTime, shipmentPresentationStatus } from "../services/status";
import type { Shipment } from "../models";

const NOW = Date.UTC(2026, 8, 12, 6), PHONE = "13800000000";
const GENERIC = "快递状态已更新，点击查看>>";
const OLD = "2026-09-12 08:00:00", FRESH = "2026-09-12 10:00:00";
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

function packet(details: { time: string; desc: string }[], stateNum = 105, provider = "CaiNiao"): Shipment {
  const parcel = parseAccountSyncResult("interface5", { code: 0, data: { expressList: [{
    mailNo: "SYNTHETICPRESENTATION0001", provider, cpCode: provider === "ShunFeng" ? "SF" : "YTO",
    name: "Synthetic carrier", phone: PHONE, stateNum, details,
  }] } }).parcels[0];
  return parcelToShipment(parcel, [PHONE], NOW)!;
}

function stored(row: Shipment): Shipment {
  memory.clear();
  saveState({ ...emptyState(), shipments: [row], bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }], feedSlotRebuiltAtMs: NOW - 86400000 }, NOW);
  return loadState(NOW).shipments[0];
}

function assertPresentation(row: Shipment, text: string, at: string) {
  const fresh = stored(row);
  assert.equal(fresh.timeline.latestDetail, text, "ShipmentRow reads the persisted headline");
  assert.equal(fresh.timeline.latestTimeText, at, "a retained real headline keeps its own event time");
  assert.equal(shipmentPresentationStatus(fresh).semantic, "DELIVERY");
  assert.equal(fresh.timeline.statusEventAtMs, parseProviderTime(FRESH));
  assert.equal(fresh.sourceTimeline?.latestDetail, GENERIC, "the source update remains durable");
  assert.equal(fresh.sourceTimeline?.statusEventAtMs, parseProviderTime(FRESH));
  assert.ok(fresh.sourceTimeline?.tracks.some(track => track.detail === GENERIC));
  assert.ok(fresh.timeline.tracks.every(track => !track.detail.startsWith("快递状态已更新")));
  assert.ok(selectShipmentDetailTimeline(fresh).tracks.every(track => !track.detail.startsWith("快递状态已更新")));
  return fresh;
}

// A same-clock query supplies the actual event text; the generic feed still owns status.
let row = applyAccountShipment(undefined, packet([
  { time: FRESH, desc: GENERIC },
  { time: "2026-09-12 09:30:00", desc: GENERIC },
  { time: "2026-09-12 09:00:00", desc: GENERIC },
]), NOW);
const sourceBeforeQuery = structuredClone(row.sourceTimeline);
row = applyTargetedAccountShipment(row, asAccountDetailObservation(row, packet([
  { time: FRESH, desc: "Actual query delivery event" },
  { time: OLD, desc: "已揽收" },
], 104)), NOW);
let fresh = assertPresentation(row, "Actual query delivery event", FRESH);
assert.deepEqual(fresh.sourceTimeline, sourceBeforeQuery);
assert.equal(fresh.timeline.provider, "v5_query");
assert.deepEqual(fresh.timeline.tracks, fresh.manualTimelines?.find(value => value.provider === "v5_query")?.tracks);
assert.equal(shipmentSelectionEvidence(fresh).headlineProvider, "v5_query");

// A pending/failed query keeps older real history; an empty result must not erase it.
let previous = applyAccountShipment(undefined, packet([{ time: OLD, desc: "Earlier list event" }], 104), NOW);
previous = applyTargetedAccountShipment(previous, asAccountDetailObservation(previous, packet([
  { time: "2026-09-12 09:00:00", desc: "Earlier query event" },
  { time: OLD, desc: "已揽收" },
], 104)), NOW);
row = applyAccountShipment(previous, packet([{ time: FRESH, desc: GENERIC }]), NOW);
const queryBeforeEmpty = structuredClone(row.manualTimelines);
assertPresentation(row, "Earlier query event", "2026-09-12 09:00:00");
row = applyTargetedAccountShipment(row, asAccountDetailObservation(row, packet([])), NOW);
fresh = assertPresentation(row, "Earlier query event", "2026-09-12 09:00:00");
assert.deepEqual(fresh.manualTimelines, queryBeforeEmpty);
assert.equal(shipmentDetailIncompleteReason(fresh), "time_mismatch", "the raw feed clock still bounds completeness");

// Without query history, the newer list snapshot replaces earlier list nodes.
row = applyAccountShipment(undefined, packet([{ time: OLD, desc: "Earlier list event" }], 104), NOW);
row = applyAccountShipment(row, packet([{ time: FRESH, desc: GENERIC }]), NOW);
fresh = assertPresentation(row, "", "");
assert.equal(fresh.timeline.tracks.length, 0);
assert.equal(shipmentDetailIncompleteReason(fresh), "no_tracks");

// A source-only generic packet has status evidence, but no real detail or headline.
row = applyAccountShipment(undefined, packet([{ time: FRESH, desc: GENERIC }]), NOW);
fresh = assertPresentation(row, "", "");
assert.equal(fresh.timeline.tracks.length, 0);
assert.equal(shipmentDetailIncompleteReason(fresh), "no_tracks");

const unrelatedQuery = { ...packet([{ time: FRESH, desc: "Unrelated query event" }]).timeline,
  provider: "v5_query", waybill: "SYNTHETICOTHER0001" };
const unrelated = { ...row, manualTimelines: [unrelatedQuery] };
assert.equal(selectShipmentTimeline(unrelated).latestDetail, "");
assert.equal(selectShipmentDetailTimeline(unrelated).tracks.length, 0);

const unknown = packet([{ time: FRESH, desc: GENERIC }], 999);
const unknownPresentation = selectShipmentTimeline(unknown);
assert.equal(unknownPresentation.semantic, "UNKNOWN");
assert.equal(unknownPresentation.structuredStatus, false);
assert.equal(unknownPresentation.tracks.length, 0);

for (const desc of [GENERIC, "快递状态已更新,点击查看>>", "快递状态已更新"]) {
  const summaryOnly = selectShipmentTimeline(packet([{ time: FRESH, desc }]));
  assert.equal(summaryOnly.latestDetail, "");
  assert.equal(summaryOnly.latestTimeText, "");
  assert.equal(summaryOnly.tracks.length, 0);
  assert.equal(summaryOnly.statusEventAtMs, parseProviderTime(FRESH));
}

// This presentation rule is scoped to Cainiao; other source packages are unchanged.
for (const provider of ["JingDong", "ShunFeng"]) {
  const incoming = packet([{ time: FRESH, desc: GENERIC }], 105, provider);
  const other = applyAccountShipment(undefined, incoming, NOW);
  assert.equal(other.timeline.latestDetail, GENERIC);
  assert.equal(other.timeline.latestTimeText, FRESH);
  assert.equal(other.timeline.tracks.length, 1);
}

console.log("cainiao update presentation tests passed");
