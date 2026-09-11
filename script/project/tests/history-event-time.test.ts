import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import {
  selectShipmentTimeline, selectShipmentDetailTimeline, shipmentDetailComplete,
  shipmentDetailIncompleteReason, needsDetailEntryQuery, rankShipmentDetailCandidates,
  jingDongDetailCandidateEvidence, unprojectedAccountOrder,
} from "../services/shipment-policy";
import { emptyState, saveState, loadState } from "../services/storage";
import { timelineLatestEventAt, timelineLatestTrackAt } from "../services/status";
import { parseAccountSyncResponse } from "../services/account-parser";
import { runShipmentRefreshForTesting } from "../services/sync";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";

// Reproduce the supplied build 94 event clocks/counts with synthetic identities and nodes.
const EVENT = 1789085861000;
const OLD_H5_EVENT = 1789056101000;
const NOW = EVENT + 12 * 3600000;
const WAYBILL = "JD000000000001";
const PHONE = "13800000000";
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
function pack(provider: string, latestAt: number, count: number, pickup = true): TimelinePackage {
  const account = provider === "v5_list" || provider === "v5_query";
  return {
    provider, waybill: WAYBILL, courierCode: "JD", companyName: "Synthetic carrier",
    semantic: account ? "DELIVERY" : "UNKNOWN", structuredStatus: account,
    statusEventAtMs: account ? latestAt || null : null, complete: provider.endsWith("_h5"),
    latestTimeText: latestAt ? String(latestAt) : "", latestDetail: count ? "Synthetic latest event" : "",
    successAtMs: NOW,
    tracks: Array.from({ length: count }, (_, index) => ({
      timeMs: latestAt - index * 60000, timeText: String(latestAt - index * 60000),
      detail: `Synthetic ${provider} event ${index}`, statusCode: pickup && index === count - 1 ? "PICKED" : "",
      raw: {},
    })),
  };
}
function row(source: TimelinePackage, manuals: TimelinePackage[], preferred: string): Shipment {
  return {
    identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL, bindingSource: "interface5",
      sourceOwner: "interface5", sourceProvider: "JingDong", manuallyAdded: false,
      courierCode: "JD", companyName: "Synthetic carrier", phone: PHONE, phoneTail: "0000", createdAtMs: NOW },
    sourceTimeline: source, timeline: source, manualTimelines: manuals,
    accountRecord: { waybill: WAYBILL, companyCode: "JD", name: "Synthetic carrier", provider: "JingDong",
      stateNumber: 105, updateTime: String(EVENT), phone: PHONE, channel: "" },
    detailSelection: { provider: preferred, selectedAtMs: NOW - 60000 }, updatedAtMs: NOW,
  };
}
function reloaded(value: Shipment): Shipment {
  memory.clear();
  saveState({ ...emptyState(), shipments: [value], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  return loadState(NOW).shipments[0];
}
function assertHistory(value: Shipment, expected: TimelinePackage) {
  for (const select of [selectShipmentTimeline, selectShipmentDetailTimeline]) {
    const result = select(value);
    assert.equal(result.provider, expected.provider);
    assert.deepEqual(result.tracks, expected.tracks, "history is one whole source package");
  }
}

test("account display fields cannot make older H5 history complete", () => {
  const h5 = pack("jd_h5", OLD_H5_EVENT, 8);
  const value = row(pack("v5_list", EVENT, 6, false), [h5], "jd_h5");
  for (const current of [value, reloaded(value)]) {
    const displayed = selectShipmentDetailTimeline(current);
    assert.equal(displayed.semantic, "DELIVERY");
    assert.equal(displayed.statusEventAtMs, EVENT);
    assert.equal(timelineLatestEventAt(displayed), EVENT, "display clock still belongs to the account");
    assert.equal(shipmentDetailComplete(current), false, "the actual tracks are eight hours older");
    assert.equal(needsDetailEntryQuery(current), true, "old history must not suppress the entry query");
  }
});

for (const pickup of [true, false]) {
  test(`equal-current feed/query cannot leave an older H5 selected (query pickup=${pickup})`, () => {
    const query = pack("v5_query", EVENT, 18, pickup);
    const value = row(pack("v5_list", EVENT, 6, false), [pack("jd_h5", OLD_H5_EVENT, 8), query], "jd_h5");
    for (const current of [value, reloaded(value)]) {
      assertHistory(current, query);
      assert.equal(shipmentDetailComplete(current), pickup, "freshness never invents pickup evidence");
    }
  });
}

test("Cainiao query newer than an empty feed does not preempt equal-time complete v4 history", () => {
  const v4 = { ...pack("v4_query", EVENT, 6), semantic: "DELIVERY" as const, structuredStatus: true,
    statusEventAtMs: EVENT };
  const query = pack("v5_query", EVENT, 3, false);
  const value = row(pack("v5_list", 0, 0), [pack("cn_h5", EVENT, 4, false), v4, query], "v5_query");
  value.identity.sourceProvider = "CaiNiao";
  value.cainiaoH5FallbackActivatedAtMs = NOW;
  for (const current of [value, reloaded(value)]) {
    assertHistory(current, v4);
    assert.equal(shipmentDetailComplete(current), true);
    assert.equal(selectShipmentTimeline(current).statusEventAtMs, EVENT);
  }
});

test("same-time complete K100 remains sticky against a larger account query", () => {
  const k100 = pack("k100_h5", EVENT, 7);
  const value = row(pack("v5_list", EVENT, 5, false), [pack("jd_h5", OLD_H5_EVENT, 4, false),
    k100, pack("v5_query", EVENT, 15)], "k100_h5");
  assertHistory(value, k100);
  assert.equal(shipmentDetailComplete(value), true);
});

test("build 97's complete JD H5 survives the observed two-second feed difference", () => {
  const feedAt = 1789094018000;
  const feed = { ...pack("v5_list", feedAt, 7, false), semantic: "COMPLETED" as const };
  const query = { ...pack("v5_query", feedAt, 24), semantic: "COMPLETED" as const,
    waybill: "3610000000000001" };
  const h5 = pack("jd_h5", feedAt - 2000, 18);
  const value = row(feed, [query, h5], "v5_list");
  value.identity = { ...value.identity, id: `interface5:account:${query.waybill}`,
    sourceId: query.waybill, accountOrder: true, orderId: query.waybill,
    projectedWaybill: WAYBILL };
  for (const current of [value, reloaded(value)]) {
    assert.equal(unprojectedAccountOrder(current), false);
    const evidence = jingDongDetailCandidateEvidence(current, h5);
    assert.equal(evidence.waybillMatches, true);
    assert.equal(evidence.foreignPackage, false);
    assert.equal(evidence.hasPickup, true);
    assert.equal(evidence.detailComplete, true);
    assertHistory(current, h5);
    const selected = selectShipmentDetailTimeline(current);
    assert.equal(shipmentDetailIncompleteReason(current), null);
    assert.equal(selected.semantic, "COMPLETED");
    assert.equal(selected.statusEventAtMs, feedAt, "trusted status remains account-owned");
    assert.equal(timelineLatestEventAt(selected), feedAt, "the account keeps the displayed event clock");
    assert.equal(timelineLatestTrackAt(selected), feedAt - 2000, "H5 keeps its own node clock");
    assert.equal(needsDetailEntryQuery(current), false);
  }
  assertHistory({ ...value, manualTimelines: [query] }, feed);
});

for (const [offset, pickup, h5Wins] of [[-1800000, true, true], [-1800001, true, false], [-2000, false, false]] as const) {
  test(`account freshness preserves only complete competing history (offset=${offset}, pickup=${pickup})`, () => {
    const feed = pack("v5_list", EVENT, 7, false);
    const h5 = pack("jd_h5", EVENT + offset, 18, pickup);
    const value = row(feed, [h5], "v5_list");
    assertHistory(value, h5Wins ? h5 : feed);
    assert.equal(shipmentDetailComplete(value), h5Wins);
  });
}

test("query status time cannot certify its older accumulated tracks", () => {
  const query = { ...pack("v5_query", OLD_H5_EVENT, 18), statusEventAtMs: EVENT, latestTimeText: String(EVENT) };
  const value = row(pack("v5_list", 0, 0), [query], "v5_query");
  assertHistory(value, query);
  assert.equal(shipmentDetailIncompleteReason(value), "time_mismatch");
});

test("a newer partial account history can replace an older complete feed", () => {
  const query = pack("v5_query", EVENT, 3, false);
  const value = row(pack("v5_list", OLD_H5_EVENT, 6), [query], "v5_list");
  assertHistory(value, query);
  assert.equal(shipmentDetailIncompleteReason(value), "missing_pickup");
});

test("ranking and final completeness use the same track clock at the 30-minute boundary", () => {
  for (const [offset, complete] of [[-1800000, true], [-1800001, false], [1800000, true], [1800001, false]] as const) {
    const h5 = pack("jd_h5", EVENT + offset, 8);
    const value = row(pack("v5_list", EVENT, 0), [h5], "jd_h5");
    assert.equal(rankShipmentDetailCandidates(value)?.provider, "jd_h5");
    assert.equal(shipmentDetailComplete(value), complete, `track offset ${offset}`);
    assert.equal(shipmentDetailIncompleteReason(value), complete ? null : "time_mismatch");
  }
});

test("the actual detail entry repairs old H5 history with one account query", async () => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const value = reloaded(row(pack("v5_list", EVENT, 0), [pack("jd_h5", OLD_H5_EVENT, 8)], "jd_h5"));
    let calls = 0;
    setDiagnosticsEnabled(true);
    const result = await runShipmentRefreshForTesting(value.identity.id, { isCurrent: () => true },
      { trigger: "detail_open" }, {
        refreshAccountParcel: async () => {
          calls++;
          return parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [{
            mailNo: WAYBILL, cpCode: "JD", name: "Synthetic carrier", provider: "JingDong", stateNum: 105,
            phone: PHONE, logisticsUpdateTime: providerTime(EVENT), lastLogisticDetail: "Synthetic new history",
            details: pack("v5_query", EVENT, 18).tracks.map((track, index) => ({
              time: providerTime(track.timeMs!), desc: track.detail, statusCode: index === 17 ? 103 : 105,
            })),
          }] } })[0];
        },
        queryManualForSource: async () => { assert.fail("entry does not add v6 or manual fallback"); },
        projectAccountOrderWithCarrier: async () => { assert.fail("the real waybill is already known"); },
        refreshWebTimeline: async () => { assert.fail("entry does not start another H5"); },
      });
    assert.equal(calls, 1);
    assert.equal(selectShipmentDetailTimeline(result.shipment).provider, "v5_query");
    assert.equal(selectShipmentDetailTimeline(result.shipment).tracks.length, 18);
    assert.equal(shipmentDetailComplete(result.shipment), true);
    const cached = loadState(NOW).shipments[0];
    assert.equal(selectShipmentDetailTimeline(cached).provider, "v5_query");
    assert.equal(cached.sourceTimeline!.tracks.length, 0);
    const start = readDiagnostics().find(entry => entry.event === "detail.refresh.stage_started")!.details;
    assert.equal(start.latestEventAtMs, EVENT);
    assert.equal(start.statusEventAtMs, EVENT);
    assert.equal(start.latestTrackAtMs, OLD_H5_EVENT, "diagnostics distinguish old tracks from account display fields");
    assert.equal(start.incompleteReason, "time_mismatch");
  } finally { setDiagnosticsEnabled(false); Date.now = realNow; }
});
