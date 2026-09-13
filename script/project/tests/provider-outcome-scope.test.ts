import assert from "node:assert/strict";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import { emptyState, saveState } from "../services/storage";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { runShipmentRefreshForTesting } from "../services/sync";
import { selectShipmentDetailTimeline } from "../services/shipment-policy";

const WAYBILL = "EMS000000000001", PHONE = "13800000000";
function pack(provider: string, count: number, at: number, pickup: boolean): TimelinePackage {
  return { provider, waybill: WAYBILL, courierCode: "EMS", companyName: "Synthetic carrier",
    semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: at, successAtMs: NOW,
    latestTimeText: String(at), latestDetail: "Synthetic final event", tracks:
      Array.from({ length: count }, (_, index) => ({ timeMs: at - index * 60_000,
        timeText: String(at - index * 60_000), detail: pickup && index === count - 1 ? "已揽收"
          : `Synthetic event ${index}`, statusCode: "", raw: {} })) };
}
const actualNow = Date.now;
Date.now = () => NOW;
try {
  memory.clear(); setDiagnosticsEnabled(true);
  const feed = pack("interface5", 1, NOW - 60_000, false);
  const row: Shipment = { identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL,
    bindingSource: "interface5", sourceOwner: "interface5", sourceProvider: "Cainiao",
    courierCode: "EMS", companyName: "Synthetic carrier", phone: PHONE,
    phoneTail: "0000", manuallyAdded: false, createdAtMs: NOW - 86400000 },
    timeline: feed, sourceTimeline: feed, manualTimelines: [], updatedAtMs: NOW };
  saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  const h5 = { ...pack("k100_h5", 14, NOW - 4 * 3600000, true),
    semantic: "WAITING_PICKUP" as const, structuredStatus: false, complete: true };
  const v4 = pack("v4_query", 17, NOW - 60_000, true);
  const response = (timeline: TimelinePackage): Shipment => ({ ...row, timeline,
    sourceTimeline: null, manualTimelines: [timeline] });
  const result = await runShipmentRefreshForTesting(row.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
    { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshCainiaoH5: async () => null,
      refreshWebTimeline: async () => response(h5),
      queryManualForSource: async (input) => {
        assert.equal(input.motoOnly, true);
        return { shipment: response(v4), pending: null, routeUrl: "" };
      },
    });
  assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "v4_query");
  const success = readDiagnostics().find(event => event.event === "detail.refresh.stage_succeeded"
    && event.details.requestProvider === "k100_h5")?.details;
  assert.ok(success);
  assert.equal(success.selectionScope, "query_response");
  assert.equal(success.statusSemantic, h5.semantic);
  assert.equal(success.structuredStatus, false);
  assert.equal(success.statusEventAtMs, h5.statusEventAtMs);
  assert.equal(success.latestTrackAtMs, h5.tracks[0].timeMs);
  assert.equal(success.latestEventAtMs, h5.statusEventAtMs);
  assert.equal(success.effectiveTrackCount, 14);
  assert.equal(success.displayedTrackCount, 17);
  assert.equal(success.displayTimelineProvider, "v4_query");
  assert.equal(success.statusProvider, undefined, "display authority belongs to selection/commit records");
  const commit = readDiagnostics().find(event => event.event === "detail.refresh.committed")?.details;
  assert.equal(commit?.selectionScope, "display");
  assert.equal(commit?.statusSemantic, "COMPLETED");
} finally { Date.now = actualNow; }
console.log("provider-response and selected-display diagnostic scope tests passed");
