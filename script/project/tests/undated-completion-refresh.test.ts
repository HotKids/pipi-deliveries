import assert from "node:assert/strict";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { hasSettledTimelineHistory, preserveSettledShipment, shouldScheduleManualRefresh } from "../services/shipment-policy";
import { shouldRefreshShipment, terminalEvidenceAtMs } from "../services/status";
import { runAccountFollowupsForTesting } from "../services/sync";
import type { Shipment, TimelinePackage } from "../models";

const at = NOW - 60_000;
const pack: TimelinePackage = {
  provider: "interface5", waybill: "SF123456789012", courierCode: "SF", companyName: "SF",
  semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: null, complete: true,
  latestTimeText: "2026-09-08 13:59:00", latestDetail: "Carrier transit event", successAtMs: NOW,
  tracks: [0, 1].map(i => ({ timeMs: at - i * 60_000, timeText: "2026-09-08 13:59:00",
    detail: `Carrier transit event ${i}`, statusCode: "", raw: {} })),
};
const row: Shipment = {
  identity: { id: "interface5:account:SF123456789012", sourceId: pack.waybill,
    bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceProvider: "ShunFeng",
    courierCode: "SF", rawCourierCode: "SF", companyName: "SF", phone: "13800001234",
    phoneTail: "1234", manuallyAdded: false, createdAtMs: at },
  timeline: pack, sourceTimeline: pack, updatedAtMs: NOW,
  accountRecord: { waybill: pack.waybill, companyCode: "SF", name: "SF", provider: "ShunFeng",
    stateNumber: 3, phone: "13800001234", channel: "account" },
};
const realNow = Date.now;
Date.now = () => NOW;
try {
  // Dated history is not a delivery timestamp; the one-time local retention anchor cannot freeze it.
  for (const mode of ["undated", "dated", "transit", "forced"] as const) {
    memory.clear();
    const timeline = { ...pack, semantic: mode === "transit" ? "TRANSIT" as const : "COMPLETED" as const,
      statusEventAtMs: mode === "dated" ? at : null };
    saveState({ ...emptyState(), shipments: [{ ...row, timeline, sourceTimeline: timeline,
      forcedCompletedAtMs: mode === "forced" ? at : undefined }],
      bindings: [{ source: "interface5", phone: "13800001234", boundAtMs: at }] }, NOW);
    const state = loadState(NOW);
    const stored = state.shipments[0]!;
    const eligible = mode === "undated" || mode === "transit";
    if (mode === "undated") {
      assert.equal(stored.settledAtMs, NOW);
      assert.equal(terminalEvidenceAtMs(stored, NOW), 0);
      assert.equal(preserveSettledShipment(stored, { ...stored, timeline: { ...timeline, tracks: [] } })
        .timeline.tracks.length, 2, "keeping terminal history must not depend on refresh freezing");
    }
    assert.equal(shouldRefreshShipment(stored, NOW), eligible, mode);
    assert.equal(hasSettledTimelineHistory(stored), !eligible, mode);
    assert.equal(shouldScheduleManualRefresh(stored, NOW, true), eligible, mode);
    let requests = 0;
    await runAccountFollowupsForTesting(state, "interface5", NOW, "terminal-refresh-test",
      candidate => candidate, NOW + 60_000, new Set(), undefined, {
        refreshAccountParcel: async () => { requests++; return null; },
      });
    assert.equal(requests, eligible ? 1 : 0, mode);
  }
  for (const manuallyAdded of [false, true]) {
    const manual = { ...pack, provider: "kdniao" };
    const shipment = { ...row, identity: { ...row.identity, manuallyAdded },
      timeline: manual, manualTimelines: [manual] };
    assert.equal(shouldScheduleManualRefresh(shipment, NOW, true), true,
      "a complete manual package without a terminal timestamp must remain eligible");
    const dated = { ...manual, statusEventAtMs: at };
    assert.equal(shouldScheduleManualRefresh({ ...shipment, timeline: dated, manualTimelines: [dated] }, NOW, true), false);
  }
} finally { Date.now = realNow; }

console.log("undated completion refresh tests passed");
