import assert from "node:assert/strict";
import { test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { emptyState, loadState, saveState } from "../services/storage";
import { readDiagnostics, reportUnfinishedDiagnosticFlows, setDiagnosticsEnabled } from "../services/logger";
import { runShipmentRefreshForTesting } from "../services/sync";
import { openFlows } from "./open-flow-markers";

// R5-NEW-07 ② (fifth review, 2026-11-25): a flow that left a device-local marker (D4) writes its end line on every
// exit, so a later runtime does not report it as 「上次未结束」. Identities are synthetic.
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const ORDER = "3999999000000072", WAYBILL = "JD9990000000072", PHONE = "13800009972";

function jdParcel(): AccountParcelDto {
  const tracks = Array.from({ length: 6 }, (_, i) => ({
    timeText: providerTime(NOW - 3600000 - i * 60000), detail: `Synthetic account event ${i}`, statusCode: "",
  }));
  return {
    source: "interface5", ownerId: ORDER, orderId: ORDER, accountOrder: true, waybill: WAYBILL,
    courierCode: "JD", rawCourierCode: "JD", companyName: "Synthetic carrier", sourceProvider: "JingDong",
    sourceStateCode: "105", sourceStateText: "DELIVERY", semantic: "DELIVERY", normalizedStatusScope: "SHIPMENT",
    normalizedStatusSemantic: "DELIVERY", normalizedStatusText: "DELIVERY", receiverPhone: PHONE, senderPhone: "",
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, tracks, routeUrl: "",
    projectionUrl: "https://u.jd.com/forward?test=early-exit",
  };
}

const openMarkers = () => Object.values(openFlows()).map(flow => flow.event);
// The user deletes the parcel while one of its requests is in flight; no request brings anything new.
const deleteRow = () => saveState({ ...loadState(), shipments: [] }, NOW);

// The pull runs the detail refresh flow (detail_open's entry query is a stage of its own and starts no flow).
for (const trigger of ["detail_pull"] as const) {
  test(`a ${trigger} refresh whose row was deleted meanwhile ends as removed and leaves no marker`, async () => {
    memory.clear();
    setDiagnosticsEnabled(true);
    const row = parcelToShipment(jdParcel(), [PHONE], NOW)!;
    saveState({ ...emptyState(), shipments: [row], bindings: [
      { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
    ] }, NOW);
    await assert.rejects(runShipmentRefreshForTesting(row.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30000 }, { trigger }, {
        refreshAccountParcel: async () => { deleteRow(); throw new Error("Synthetic per-waybill failure"); },
        projectAccountOrderWithCarrier: async () => null as never,
        refreshWebTimeline: async () => { deleteRow(); return null; },
        queryManualForSource: async () => {
          deleteRow();
          return { result: "empty_response" as const, shipment: null, pending: null, routeUrl: "" };
        },
      }), /该快递已从列表中移除/);
    const ends = readDiagnostics().filter(entry => entry.event === "detail.refresh.skipped" ||
      entry.event === "detail.refresh.failed" || entry.event === "detail.refresh.committed");
    assert.equal(ends.length, 1, JSON.stringify(readDiagnostics().map(entry => [entry.event, entry.details.skipReason])));
    assert.equal(ends[0].event, "detail.refresh.skipped");
    assert.equal(ends[0].details.skipReason, "removed");
    assert.equal(ends[0].details.result, "removed");
    assert.equal(ends[0].details.persisted, false);
    assert.equal(typeof ends[0].details.baseRevision, "number", "the start's state is merged into the end line");
    assert.deepEqual(openMarkers().filter(event => event === "detail.refresh"), [], "the flow's marker is closed");
    reportUnfinishedDiagnosticFlows(NOW + 11 * 60_000);
    assert.equal(readDiagnostics().some(entry => entry.event === "diagnostic.flow.unfinished"), false);
  });
}
