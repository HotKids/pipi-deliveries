import assert from "node:assert/strict";
import { memory } from "./state-storage-mock";
import { parseAccountSyncResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import {
  applyAccountShipment, applyTargetedAccountShipment, asAccountDetailObservation,
  selectShipmentTimeline, selectShipmentDetailTimeline, shipmentDetailComplete,
  needsDetailEntryQuery, shipmentSelectionEvidence,
} from "../services/shipment-policy";
import { buildWidgetSnapshot, shipmentDetailPresentationStatus } from "../services/status";
import { emptyState, loadState, saveState } from "../services/storage";
import type { Shipment } from "../models";

const PHONE = "13800000000";
const NOW = new Date("2026-09-11T10:00:00+08:00").getTime();
function packet(code: number, time: string, history = false): Shipment {
  const parcels = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
    mailNo: "SYNTHETICFEED0001", cpCode: "YTO", name: "Synthetic carrier",
    provider: "CaiNiao", stateNum: code, phone: PHONE,
    logisticsUpdateTime: time, lastLogisticDetail: `Synthetic event ${code}`,
    details: history ? [
      { time, desc: `Synthetic event ${code}`, statusCode: code },
      { time: "2026-09-10 08:00:00", desc: "Synthetic pickup", statusCode: 103 },
    ] : [],
  }] } });
  assert.equal(parcels.length, 1);
  return parcelToShipment(parcels[0], [PHONE], NOW)!;
}
function owner(history = false) {
  return applyAccountShipment(undefined, packet(103, "2026-09-10 08:00:00", history), NOW);
}
function queried(current: Shipment, code = 105, time = "2026-09-11 07:39:00", history = true) {
  return applyTargetedAccountShipment(current, asAccountDetailObservation(current, packet(code, time, history)), NOW);
}
function surfaces(row: Shipment, semantic: string) {
  const home = selectShipmentTimeline(row);
  assert.equal(home.semantic, semantic, "Home must use the accepted status");
  const detail = selectShipmentDetailTimeline(row);
  assert.equal(shipmentDetailPresentationStatus({ ...row, timeline: home }, detail).semantic, semantic);
  assert.equal(buildWidgetSnapshot([{ ...row, timeline: home }], NOW).rows[0]?.semantic, semantic);
}
const cases: [string, () => void][] = [
  ["a source-owned empty feed can establish ownership", () => {
    assert.equal(owner().automaticOwnership?.ownerSource, "interface5");
  }],
  ["status-only increments update with or without stored tracks", () => {
    for (const history of [false, true]) {
      const current = owner(history);
      const updated = applyAccountShipment(current, packet(105, "2026-09-11 07:39:00"), NOW);
      surfaces(updated, "DELIVERY");
      assert.deepEqual(updated.sourceTimeline!.tracks, current.sourceTimeline!.tracks);
      const stale = applyAccountShipment(updated, packet(103, "2026-09-10 08:00:00"), NOW + 1);
      surfaces(stale, "DELIVERY");
    }
  }],
  ["query takes over every surface and the completeness clock", () => {
    const before = owner(true);
    const row = queried(before);
    surfaces(row, "DELIVERY");
    assert.equal(row.timeline.provider, "v5_query");
    const evidence = shipmentSelectionEvidence(row);
    assert.equal(evidence.historyProvider, "v5_query");
    assert.equal(evidence.headlineProvider, "v5_query");
    assert.equal(evidence.statusProvider, "v5_query");
    assert.deepEqual(row.sourceTimeline, before.sourceTimeline, "query must not mutate the feed slot");
    assert.equal(shipmentDetailComplete(row), true);
    assert.equal(needsDetailEntryQuery(row), false);
  }],
  ["old feed after query and durable reload cannot undo takeover", () => {
    const row = applyAccountShipment(queried(owner()), packet(103, "2026-09-10 08:00:00"), NOW + 1);
    memory.clear();
    saveState({ ...emptyState(), shipments: [row], bindings: [
      { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
    ] }, NOW);
    const reloaded = loadState(NOW).shipments[0];
    surfaces(reloaded, "DELIVERY");
    assert.equal(reloaded.timeline.provider, "v5_query");
    assert.equal(reloaded.timeline.latestDetail, "Synthetic event 105");
  }],
  ["a later feed can regain authority without losing query history", () => {
    const current = queried(owner());
    const next = applyAccountShipment(current, packet(107, "2026-09-11 09:06:00", true), NOW);
    surfaces(next, "COMPLETED");
    assert.equal(next.timeline.provider, next.sourceTimeline!.provider);
    assert.equal(next.manualTimelines!.find(t => t.provider === "v5_query")!.tracks.length, 2);
  }],
  ["status-only query is retained and can advance status", () => {
    const row = queried(owner(true), 105, "2026-09-11 07:39:00", false);
    surfaces(row, "DELIVERY");
    assert.ok(row.manualTimelines!.some(t => t.provider === "v5_query" && t.structuredStatus));
  }],
  ["H5 prose cannot replace a known account status", () => {
    const row = owner(true);
    const h5 = { ...packet(107, "2026-09-11 09:06:00", true).timeline,
      provider: "cn_h5", structuredStatus: false, complete: true };
    const next = { ...row, manualTimelines: [h5] };
    surfaces(next, "PICKED");
  }],
  ["late query cannot rewind terminal status", () => {
    const completed = applyAccountShipment(owner(true), packet(107, "2026-09-11 09:06:00", true), NOW);
    surfaces(queried(completed), "COMPLETED");
  }],
  ["a newer nonterminal feed also replaces a sticky query", () => {
    const current = queried(owner());
    current.detailSelection = { provider: "v5_query", selectedAtMs: NOW };
    const next = applyAccountShipment(current, packet(105, "2026-09-11 09:06:00", true), NOW + 1);
    surfaces(next, "DELIVERY");
    assert.equal(next.timeline.provider, next.sourceTimeline!.provider);
    assert.equal(next.timeline.latestTimeText, "2026-09-11 09:06:00");
  }],
  ["a newer partial query does not claim complete history", () => {
    const current = owner(true);
    const incoming = packet(105, "2026-09-11 07:39:00", true);
    incoming.sourceTimeline!.tracks = incoming.sourceTimeline!.tracks.slice(0, 1);
    const row = applyTargetedAccountShipment(current, asAccountDetailObservation(current, incoming), NOW);
    surfaces(row, "DELIVERY");
    assert.equal(row.timeline.provider, "v5_query");
    assert.equal(shipmentDetailComplete(row), false);
  }],
  ["query prose or missing status time cannot replace known status", () => {
    for (const change of [{ structuredStatus: false }, { statusEventAtMs: null }]) {
      const current = owner(true);
      const incoming = packet(105, "2026-09-11 07:39:00", true);
      incoming.sourceTimeline = { ...incoming.sourceTimeline!, ...change };
      const row = applyTargetedAccountShipment(current, asAccountDetailObservation(current, incoming), NOW);
      surfaces(row, "PICKED");
      assert.equal(row.timeline.provider, "v5_query", "valid new history remains displayable");
    }
  }],
  ["same event ties keep the existing feed rule", () => {
    const row = queried(owner(true), 105, "2026-09-10 08:00:00");
    surfaces(row, "PICKED");
    assert.equal(row.timeline.provider, row.sourceTimeline!.provider);
  }],
  ["a mismatched query cannot enter the current parcel presentation", () => {
    const row = owner(true);
    const query = { ...packet(105, "2026-09-11 07:39:00", true).timeline,
      provider: "v5_query", waybill: "OTHERSYNTHETIC0002" };
    const next = { ...row, manualTimelines: [query] };
    surfaces(next, "PICKED");
    assert.deepEqual(selectShipmentDetailTimeline(next).tracks, row.sourceTimeline!.tracks);
  }],
  ["projected JingDong uses its carrier-level account query", () => {
    const current = owner(true);
    current.identity = { ...current.identity, sourceProvider: "JingDong", accountOrder: true,
      orderId: "SYNTHETICORDER0001", sourceId: "SYNTHETICORDER0001",
      projectedWaybill: current.timeline.waybill };
    const incoming = packet(105, "2026-09-11 07:39:00", true);
    incoming.identity = { ...current.identity };
    const row = applyTargetedAccountShipment(current, asAccountDetailObservation(current, incoming), NOW);
    surfaces(row, "DELIVERY");
    assert.equal(row.timeline.provider, "v5_query");
    assert.equal(shipmentDetailComplete(row), true);
  }],
];
let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${String(error)}`); }
}
assert.equal(failed, 0, `${failed} account/query contract partitions failed`);
