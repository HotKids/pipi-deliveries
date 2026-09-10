import assert from "node:assert/strict";
import type { Shipment } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { queryManualForSource } from "../services/manual-query";
import { applyManualShipment } from "../services/shipment-policy";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";

const waybill = "SF123456789012";
const timeline: Shipment["timeline"] = { provider: "v6_query", waybill, courierCode: "SF",
  companyName: "Carrier", semantic: "TRANSIT", complete: false, successAtMs: NOW,
  tracks: [{ timeMs: NOW - 60_000, timeText: "2026-09-08 13:59:00", detail: "Earlier facility",
    statusCode: "", raw: {} }], latestTimeText: "2026-09-08 13:59:00", latestDetail: "Earlier facility" };
function owner(sourceProvider: string): Shipment {
  return { identity: { id: `interface5:${waybill}`, sourceId: waybill, bindingSource: "interface5",
    sourceProvider, courierCode: "SF", rawCourierCode: "SF", companyName: "Carrier",
    manuallyAdded: false, createdAtMs: NOW - 120_000 }, timeline, manualTimelines: [timeline], updatedAtMs: NOW };
}

for (const scene of [
  { name: "manual add", scheduled: false, sourceProvider: undefined, currentShipment: undefined },
  { name: "SF detail", scheduled: false, sourceProvider: "ShunFeng", currentShipment: owner("ShunFeng") },
  { name: "SF list", scheduled: true, sourceProvider: "ShunFeng", currentShipment: owner("ShunFeng") },
  { name: "other source with SF carrier", scheduled: true, sourceProvider: "Cainiao", currentShipment: owner("Cainiao") },
  { name: "manual scheduled query", scheduled: true, sourceProvider: undefined, currentShipment: undefined },
]) {
  memory.clear();
  setDiagnosticsEnabled(true);
  const payloads: Record<string, unknown>[] = [];
  const result = await queryManualForSource({ source: "interface5", bindings: [], waybill,
    rawCourierCode: "SF", courierCode: "SF", pickerOnly: true,
    scheduled: scene.scheduled, sourceProvider: scene.sourceProvider, currentShipment: scene.currentShipment,
    diagnosticFlowId: "meizu-purpose-test", dependencies: { now: () => NOW, post: async (route, payload) => {
      assert.equal(route, "/api/express/timeline/source");
      payloads.push(payload);
      // Online returns a ServerExpressBean scalar, not a full timeline array.
      return { code: 200, value: JSON.stringify({ mailNo: waybill, cpCode: "SF", cpName: "Carrier",
        logisticsStatus: "TRANSPORT", logisticsGmtModified: "2026-09-09 18:51:23",
        lastLogisticDetail: "Parcel arrived at facility" }), redirect: "" };
    } } });
  const mode = "refresh";
  const level = "v6_query";
  assert.deepEqual(payloads, [{ interface: "v6", mode, waybill }], scene.name);
  assert.ok(result.shipment, scene.name);
  assert.equal(result.shipment.timeline.provider, "v6_query", "new responses use the canonical Meizu slot");
  assert.equal(result.shipment.timeline.complete, false, "a scalar latest event never proves full history");
  assert.equal(result.shipment.timeline.tracks.length, 1);
  assert.equal(result.shipment.timeline.tracks[0]?.timeText, "2026-09-09 18:51:23");
  assert.equal(result.shipment.timeline.tracks[0]?.detail, "Parcel arrived at facility");
  const merged = applyManualShipment(owner("ShunFeng"), result.shipment, NOW);
  const cached = merged.manualTimelines?.find(item => item.provider === "v6_query");
  assert.equal(cached?.tracks.length, 2, "existing same-provider history survives the endpoint change");
  assert.equal(cached?.complete, false, "accumulating scalar events does not prove complete history");
  for (const event of ["manual.source.started", "manual.meizu.response", "manual.source.succeeded", "manual.query.completed"]) {
    const entry = readDiagnostics().find(item => item.event === event);
    assert.ok(entry, `${scene.name}: ${event}`);
    assert.equal(entry.details.level, level, `${scene.name}: ${event} identifies the real endpoint purpose`);
    assert.equal(entry.details.timelineProvider, level);
    if (event === "manual.meizu.response") assert.equal(entry.details.mode, mode);
  }
}
console.log("Meizu Online-only add, detail and scheduled request tests passed");
