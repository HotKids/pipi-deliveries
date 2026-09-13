import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import {
  activateCainiaoManualFallback, applyAccountShipment, clearCainiaoManualFallback,
  selectShipmentDetailTimeline, selectShipmentTimeline, shipmentDetailComplete,
  shipmentDetailCandidateEvidence,
  applySameSourceTimeline,
} from "../services/shipment-policy";
import { emptyState, loadState, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";

const EVENT = 1789140502000;
const NOW = EVENT + 24 * 3600000;
const WAYBILL = "JT0000000000162";
const PHONE = "13800000000";
function pack(provider: string, count: number, pickup = false): TimelinePackage {
  return {
    provider, waybill: WAYBILL, courierCode: "HTKY", companyName: "Synthetic carrier",
    semantic: "TRANSIT", structuredStatus: !provider.endsWith("_h5"),
    statusEventAtMs: count ? EVENT : null, complete: provider.endsWith("_h5"),
    latestTimeText: count ? String(EVENT) : "", latestDetail: count ? "Synthetic transit" : "",
    tracks: Array.from({ length: count }, (_, index) => ({
      timeMs: EVENT - index * 60000, timeText: String(EVENT - index * 60000),
      detail: `Synthetic ${provider} node ${index}`,
      statusCode: pickup && index === count - 1 ? "PICKED" : "TRANSIT", raw: {},
    })), successAtMs: NOW,
  };
}
function packet(count = 0): Shipment {
  const source = pack("interface5", count);
  return {
    identity: { id: `interface5:account:${WAYBILL}`, sourceId: WAYBILL,
      bindingSource: "interface5", sourceOwner: "interface5", sourceProvider: "CaiNiao",
      courierCode: "HTKY", rawCourierCode: "HTKY", companyName: "Synthetic carrier",
      phone: PHONE, phoneTail: "0000", manuallyAdded: false, createdAtMs: NOW },
    timeline: source, sourceTimeline: source, manualTimelines: [], updatedAtMs: NOW,
  };
}
function owner(count = 0) {
  const value = applyAccountShipment(undefined, packet(count), NOW);
  assert.equal(value.automaticOwnership?.ownerSource, "interface5");
  return value;
}
function reload(value: Shipment): Shipment {
  memory.clear();
  saveState({ ...emptyState(), shipments: [value], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW);
  return loadState(NOW).shipments[0];
}
function assertHistory(value: Shipment, expected: TimelinePackage) {
  for (const select of [selectShipmentTimeline, selectShipmentDetailTimeline]) {
    assert.equal(select(value).provider, expected.provider);
    assert.deepEqual(select(value).tracks, expected.tracks);
  }
}

test("a same-owner list refresh retains an activated complete manual history through reload", () => {
  const v4 = pack("v4_query", 6, true);
  const current = activateCainiaoManualFallback({ ...owner(),
    manualTimelines: [pack("cn_h5", 4), pack("k100_h5", 4), pack("v5_query", 4), v4],
    detailSelection: { provider: "v4_query", selectedAtMs: NOW },
  }, NOW);
  assertHistory(current, v4);
  for (const count of [0, 1]) {
    const updated = applyAccountShipment(current, packet(count), NOW + 1);
    for (const value of [updated, reload(updated)]) {
      assert.equal(value.cainiaoH5FallbackActivatedAtMs, NOW);
      assertHistory(value, v4);
      assert.equal(shipmentDetailComplete(value), true);
    }
  }
});

test("an activated Cainiao parcel can select its same-waybill JT H5 history", () => {
  const jt = pack("jt_h5", 4, true);
  const current = activateCainiaoManualFallback({ ...owner(1), manualTimelines: [jt] }, NOW);
  for (const value of [current, reload(current)]) {
    assertHistory(value, jt);
    assert.equal(shipmentDetailComplete(value), true);
    const evidence = shipmentDetailCandidateEvidence(value, jt);
    assert.equal(evidence.candidateEligible, true);
    assert.equal(evidence.cainiaoFallbackActive, true);
    assert.equal(evidence.hasPickup, true);
    assert.equal(evidence.detailComplete, true);
  }
});

test("an inactive or explicitly cleared fallback cannot be activated by a cached provider", () => {
  const current = { ...owner(1), manualTimelines: [pack("v4_query", 6, true), pack("jt_h5", 4, true)] };
  for (const value of [current, clearCainiaoManualFallback(activateCainiaoManualFallback(current, NOW))]) {
    const updated = reload(applyAccountShipment(value, packet(1), NOW + 1));
    assert.equal(updated.cainiaoH5FallbackActivatedAtMs, undefined);
    assertHistory(updated, updated.sourceTimeline!);
    const evidence = shipmentDetailCandidateEvidence(updated, updated.manualTimelines![0]);
    assert.equal(evidence.candidateEligible, false);
    assert.equal(evidence.gateReason, "cainiao_h5_required");
  }
});

test("JT selection does not admit another waybill or an unrelated carrier", () => {
  for (const [code, waybill] of [["HTKY", "JT0000000000000"], ["ZTO", WAYBILL]]) {
    const jt = { ...pack("jt_h5", 4, true), waybill };
    const current = activateCainiaoManualFallback({ ...owner(1),
      identity: { ...owner(1).identity, courierCode: code }, manualTimelines: [jt],
    }, NOW);
    assertHistory(current, current.sourceTimeline!);
    assert.equal(shipmentDetailCandidateEvidence(current, jt).candidateEligible, false);
  }
});

test("a new row cannot inherit a deleted row's fallback activation", () => {
  const old = reload(activateCainiaoManualFallback(owner(1), NOW));
  const replacement = applyAccountShipment(undefined, packet(1), NOW + 1);
  assert.equal(old.cainiaoH5FallbackActivatedAtMs, NOW);
  assert.equal(replacement.cainiaoH5FallbackActivatedAtMs, undefined);
});

test("a Cainiao update notice is not eligible history just because it has a timestamp", () => {
  const current = owner(1);
  const source = { ...current.sourceTimeline!, tracks: current.sourceTimeline!.tracks.map(track =>
    ({ ...track, detail: "快递状态已更新，点击查看>>" })), latestDetail: "快递状态已更新，点击查看>>" };
  const evidence = shipmentDetailCandidateEvidence({ ...current, sourceTimeline: source }, source);
  assert.equal(evidence.candidateEligible, false);
  assert.equal(evidence.gateReason, "no_tracks");
  assert.equal(evidence.detailComplete, false);
});

test("SF diagnostics use eligible manual freshness and exclude the coarse source from the contest", () => {
  const source = pack("interface5", 1);
  const old = pack("k100_h5", 15, true);
  const newer = { ...pack("v6_query", 5, true),
    statusEventAtMs: EVENT + 3 * 3600000,
    tracks: pack("v6_query", 5, true).tracks.map(track => ({ ...track, timeMs: track.timeMs! + 3 * 3600000 })),
  };
  const current = { ...owner(1), sourceTimeline: source,
    identity: { ...owner(1).identity, sourceProvider: "ShunFeng", courierCode: "SF" },
    manualTimelines: [old, newer] };
  assert.equal(shipmentDetailCandidateEvidence(current, old).incompleteReason, "time_mismatch");
  assert.equal(shipmentDetailCandidateEvidence(current, newer).detailComplete, true);
  assert.equal(shipmentDetailCandidateEvidence(current, source).gateReason, "sf_manual_authority");
  assertHistory(current, newer);
});

test("HTKY detail pull commits JT history and reports the actual primary provider", async () => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const current = reload(owner(1));
    setDiagnosticsEnabled(true);
    const calls: string[] = [];
    const jt = pack("jt_h5", 4, true);
    const result = await runShipmentRefreshForTesting(current.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { assert.fail("detail pull must not repeat account queries"); },
        refreshCainiaoH5: async () => { calls.push("cn_h5"); return null; },
        refreshWebTimeline: async shipment => {
          calls.push("jt_h5");
          assert.equal(shipment.identity.courierCode, "HTKY");
          return applySameSourceTimeline(shipment, jt, NOW);
        },
        queryManualForSource: async input => {
          assert.equal(input.motoOnly, true, "JT pickup must stop paid fallback; no detail Online is added");
          calls.push("v4_query");
          return { shipment: null, pending: null, routeUrl: "" };
        },
      });
    assert.deepEqual(calls.sort(), ["cn_h5", "jt_h5", "v4_query"]);
    assertHistory(result.shipment!, jt);
    assertHistory(loadState(NOW).shipments[0], jt);
    const logs = readDiagnostics();
    const contest = logs.find(entry => entry.event === "detail.refresh.primary_contest.completed")!;
    assert.equal(contest.details.jtH5Succeeded, true);
    assert.equal(contest.details.k100H5Succeeded, undefined);
    assert.equal(contest.details.waybillTail, "0162");
    for (const entry of logs.filter(entry => entry.event.startsWith("detail.refresh.stage_"))) {
      assert.equal(entry.details.waybillTail, "0162");
      assert.equal(entry.details.carrierCode, "HTKY");
      assert.ok(entry.details.requestProvider);
    }
  } finally {
    Date.now = realNow;
    setDiagnosticsEnabled(false);
  }
});

test("HTKY's newer twelve-node primary history replaces its seven-node account cache", async () => {
  const queryAt = 1789258787000, primaryAt = 1789265961000, refreshNow = primaryAt + 60000;
  const realNow = Date.now;
  Date.now = () => refreshNow;
  try {
    memory.clear();
    const at = (provider: string, count: number, latestAt: number, pickup = false): TimelinePackage => {
      const value = pack(provider, count, pickup);
      return { ...value, semantic: "DELIVERY", statusEventAtMs: latestAt,
        latestTimeText: String(latestAt), latestDetail: `Synthetic ${provider} headline`, successAtMs: refreshNow,
        tracks: value.tracks.map((track, i) => ({ ...track,
          timeMs: latestAt - i * 60000, timeText: String(latestAt - i * 60000),
          statusCode: pickup && i === count - 1 ? "PICKED" : "",
        })),
      };
    };
    const source = at("interface5", 1, queryAt);
    const query = at("v5_query", 7, queryAt);
    const cn = at("cn_h5", 10, primaryAt);
    const v4 = at("v4_query", 12, primaryAt, true);
    const jt = at("jt_h5", 9, primaryAt - 21000, true);
    const initial = activateCainiaoManualFallback({ ...owner(1), sourceTimeline: source,
      timeline: query, manualTimelines: [query],
      detailSelection: { provider: "v5_query", selectedAtMs: refreshNow - 60000 },
    }, refreshNow);
    const current = saveState({ ...emptyState(), shipments: [initial], bindings: [
      { source: "interface5", phone: PHONE, boundAtMs: refreshNow - 86400000 },
    ] }, refreshNow).shipments[0];
    const calls: string[] = [];
    setDiagnosticsEnabled(true);
    const result = await runShipmentRefreshForTesting(current.identity.id,
      { isCurrent: () => true, deadlineAtMs: refreshNow + 30000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { assert.fail("detail pull must not repeat account queries"); },
        refreshCainiaoH5: async shipment => {
          calls.push("cn_h5"); return applySameSourceTimeline(shipment, cn, refreshNow);
        },
        refreshWebTimeline: async shipment => {
          calls.push("jt_h5"); return applySameSourceTimeline(shipment, jt, refreshNow);
        },
        queryManualForSource: async input => {
          assert.equal(input.motoOnly, true, "pickup still closes the paid fallback gate");
          calls.push("v4_query");
          return { shipment: { ...current, sourceTimeline: null, timeline: v4, manualTimelines: [v4] },
            pending: null, routeUrl: "" };
        },
      });
    assert.deepEqual(calls.sort(), ["cn_h5", "jt_h5", "v4_query"]);
    for (const value of [result.shipment, loadState(refreshNow).shipments[0]]) {
      assertHistory(value, v4);
      assert.equal(shipmentDetailComplete(value), true);
      assert.equal(shipmentDetailCandidateEvidence(value, v4).detailComplete, true);
      assert.equal(shipmentDetailCandidateEvidence(value, jt).detailComplete, true);
      assert.equal(selectShipmentTimeline(value).semantic, "DELIVERY");
      assert.equal(selectShipmentTimeline(value).statusEventAtMs, queryAt);
      assert.deepEqual(value.sourceTimeline, source);
      assert.deepEqual(value.manualTimelines!.find(t => t.provider === "v5_query")!.tracks, query.tracks);
      assert.deepEqual(value.manualTimelines!.find(t => t.provider === "jt_h5")!.tracks, jt.tracks);
    }
    const commit = readDiagnostics().find(entry => entry.event === "detail.refresh.committed")!;
    assert.equal(commit.details.displayedTrackCount, 12);
    assert.equal(commit.details.latestTrackAtMs, primaryAt);
    assert.equal(commit.details.statusEventAtMs, queryAt);
  } finally { Date.now = realNow; setDiagnosticsEnabled(false); }
});
