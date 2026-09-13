import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import { emptyState, saveState } from "../services/storage";
import {
  applySameSourceTimeline, needsDetailEntryQuery, selectShipmentTimeline,
  shipmentDetailIncompleteReason, shipmentDetailCandidateEvidence,
} from "../services/shipment-policy";
import { runShipmentRefreshForTesting } from "../services/sync";
import { shouldRefreshShipment, terminalEvidenceAtMs } from "../services/status";

// Build 100's observed YTO clocks/counts; identities and track text are synthetic.
const EVENT = 1789094155000, NOW = Date.UTC(2026, 8, 11, 16, 9, 29);
const PHONE = "13800000000", WAYBILL = "SYNTHETICYTO0001";
function shipment(): Shipment {
  const query: TimelinePackage = {
    provider: "v5_query", waybill: WAYBILL, courierCode: "YTO", companyName: "Synthetic carrier",
    semantic: "TRANSIT", structuredStatus: true, statusEventAtMs: EVENT, complete: false,
    latestTimeText: String(EVENT), latestDetail: "Synthetic transit event", successAtMs: NOW,
    tracks: Array.from({ length: 5 }, (_, i) => ({
      timeMs: EVENT - i * 60000, timeText: String(EVENT - i * 60000),
      detail: i === 4 ? "已揽收" : "Synthetic transit event", statusCode: "", raw: {},
    })),
  };
  return {
    identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL,
      bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceProvider: "CaiNiao",
      courierCode: "YTO", rawCourierCode: "YTO", companyName: "Synthetic carrier",
      phone: PHONE, phoneTail: "0000", manuallyAdded: false, createdAtMs: EVENT },
    timeline: { ...query, semantic: "COMPLETED", statusEventAtMs: null },
    sourceTimeline: { ...query, provider: "v5_list", semantic: "COMPLETED",
      statusEventAtMs: null, latestTimeText: "", latestDetail: "", tracks: [] },
    manualTimelines: [query], updatedAtMs: NOW,
    accountRecord: { waybill: WAYBILL, companyCode: "YTO", provider: "CaiNiao", phone: PHONE },
  };
}
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });

test("an undated terminal overlay cannot certify old account history", () => {
  const row = shipment();
  const selected = selectShipmentTimeline(row);
  assert.equal(selected.semantic, "COMPLETED");
  assert.equal(selected.tracks.length, 5);
  assert.equal(terminalEvidenceAtMs({ ...row, timeline: selected }, NOW), 0);
  assert.equal(shipmentDetailIncompleteReason(row), "missing_source_time");
  assert.equal(needsDetailEntryQuery(row), true);
  const jd = { ...row, identity: { ...row.identity, sourceProvider: "JingDong" } };
  assert.equal(shipmentDetailCandidateEvidence(jd, row.manualTimelines![0]).incompleteReason,
    "missing_source_time", "candidate ranking and refresh must share the terminal evidence gate");
});

test("dated completion still freezes while forced completion stays authoritative", () => {
  const row = shipment();
  const dated = applySameSourceTimeline(row, { ...row.manualTimelines![0],
    semantic: "COMPLETED", statusEventAtMs: EVENT }, NOW);
  assert.equal(shipmentDetailIncompleteReason(dated), null);
  assert.equal(shouldRefreshShipment(dated, NOW), false);
  assert.equal(needsDetailEntryQuery(dated), false);
  const forced = { ...row, forcedCompletedAtMs: NOW };
  assert.equal(selectShipmentTimeline(forced).semantic, "COMPLETED");
  assert.equal(needsDetailEntryQuery(forced), false);
});

test("entry and pull reach their original providers without a terminal timestamp", async () => {
  memory.clear();
  const row = saveState({ ...emptyState(), shipments: [shipment()], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: EVENT },
  ] }, NOW).shipments[0];
  let queries = 0, captures = 0;
  const lease = { isCurrent: () => true, deadlineAtMs: NOW + 30000 };
  const entry = await runShipmentRefreshForTesting(row.identity.id, lease, { trigger: "detail_open" }, {
    refreshAccountParcel: async () => { queries++; return null; },
  });
  assert.equal(queries, 1, "entry must query this account ticket instead of accepting old history");
  const result = await runShipmentRefreshForTesting(row.identity.id, lease, {
    trigger: "detail_pull", forceManualRefresh: true, detailEntry: entry.detailEntry,
  }, {
    refreshAccountParcel: async () => { assert.fail("pull must not repeat the entry query"); },
    refreshCainiaoH5: async current => {
      captures++;
      return applySameSourceTimeline(current, { ...current.manualTimelines![0],
        provider: "cn_h5", structuredStatus: false, complete: true }, NOW);
    },
    refreshWebTimeline: async () => { assert.fail("existing pickup must not expand the free round"); },
    queryManualForSource: async () => { assert.fail("existing pickup must not start manual fallback"); },
  });
  assert.equal(captures, 1, "explicit pull must reach the original Cainiao H5 stage");
  assert.equal(selectShipmentTimeline(result.shipment).semantic, "COMPLETED");
  assert.equal(shipmentDetailIncompleteReason(result.shipment), "missing_source_time",
    "another transit-only response must not become proof of terminal completeness");
});
