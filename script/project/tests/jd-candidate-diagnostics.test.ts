import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { memory, NOW } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import * as policy from "../services/shipment-policy";
import { setDiagnosticsEnabled, readDiagnostics, writeDiagnostic } from "../services/logger";

const WAYBILL = "JD000000000001";
function pack(provider: string, count: number, pickup = false): TimelinePackage {
  return { provider, waybill: WAYBILL, courierCode: "JD", companyName: "Synthetic carrier",
    semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: NOW, successAtMs: NOW,
    latestTimeText: String(NOW), latestDetail: "Synthetic final event", tracks:
      Array.from({ length: count }, (_, i) => ({ timeMs: NOW - i * 60000, timeText: String(NOW - i * 60000),
        detail: i === count - 1 && pickup ? "已揽收" : `Synthetic event ${i}`, statusCode: "", raw: {} })) };
}
function row(): Shipment {
  const feed = pack("v5_list", 7);
  return { identity: { id: "interface5:account:3610000000000001", sourceId: "3610000000000001",
    orderId: "3610000000000001", accountOrder: true, projectedWaybill: WAYBILL,
    bindingSource: "interface5", sourceProvider: "JingDong", sourceOwner: "interface5:order",
    manuallyAdded: false, courierCode: "JD", companyName: "Synthetic carrier", phone: "13800000000",
    phoneTail: "0000", createdAtMs: NOW - 86400000 }, timeline: feed, sourceTimeline: feed,
    manualTimelines: [pack("v5_query", 24), pack("jd_h5", 8, true)],
    detailSelection: { provider: "v5_list", selectedAtMs: NOW }, updatedAtMs: NOW };
}

test("the owning page logs a changed cache even when its selected feed is unchanged", () => {
  const page = readFileSync(new URL("../pages/DetailPage.tsx", import.meta.url), "utf8");
  const expression = page.match(/const selectionSignature = ([\s\S]*?);/)?.[1];
  assert.ok(expression);
  function signature(shipment: Shipment) {
    const detailTimeline = shipment.sourceTimeline!;
    return runInNewContext(stripTypeScriptTypes(expression!), { shipment, detailTimeline,
      displayTracks: detailTimeline.tracks, effectiveTrackCount: 7, detailComplete: false,
      incompleteReason: "missing_pickup", latestTrackSemantic: "UNKNOWN" });
  }
  const before = row();
  const after = { ...before, manualTimelines: [pack("v5_query", 24), pack("jd_h5", 18, true)], updatedAtMs: NOW + 6000 };
  assert.notEqual(signature(after), signature(before), "successful H5 persistence must emit updated candidate facts");
  assert.equal(signature(after), signature({ ...after }), "an unchanged rerender must not repeat the snapshot");
});

test("JD candidate diagnostics expose the actual completeness and rejection evidence without changing selection", () => {
  const current = row();
  const complete = pack("jd_h5", 18, true);
  const evidence = (timeline: TimelinePackage) => policy.jingDongDetailCandidateEvidence(current, timeline);
  const before = policy.selectShipmentDetailTimeline(current);
  assert.equal(evidence(complete).detailComplete, true);
  assert.equal(evidence(complete).hasPickup, true);
  assert.equal(evidence(complete).foreignPackage, false);
  assert.equal(evidence(complete).waybillMatches, true);
  assert.equal(evidence(complete).earliestTrackAtMs, NOW - 17 * 60000);
  assert.equal(evidence(pack("jd_h5", 0)).earliestTrackAtMs, 0);
  assert.equal(evidence(pack("v5_query", 24)).incompleteReason, "missing_pickup");
  assert.equal(evidence({ ...complete, tracks: complete.tracks.map(t => ({ ...t, timeMs: t.timeMs! - 3600000 })) }).incompleteReason, "time_mismatch");
  assert.equal(evidence({ ...complete, waybill: "JD000000000002" }).waybillMatches, false);
  assert.deepEqual(policy.selectShipmentDetailTimeline(current), before, "inspection cannot change the selected package");
  current.sourceTimeline!.tracks.at(-1)!.detail = "已下单";
  const older = { ...complete, tracks: complete.tracks.map(t => ({ ...t, timeMs: t.timeMs! - 3 * 86400000 })) };
  assert.equal(evidence(older).foreignPackage, true);
  assert.equal(evidence(older).foreignAnchorAtMs, NOW - 6 * 60000 - 86400000);
  current.identity.sourceProvider = "ShunFeng";
  assert.deepEqual(evidence(older), {}, "JD evidence must not claim SF's different completeness reference");
});

test("candidate evidence survives the diagnostic allowlist without node text or identities", () => {
  memory.clear(); setDiagnosticsEnabled(true);
  const current = row();
  writeDiagnostic("detail.timeline.candidate", {
    timelineProvider: "jd_h5", ...policy.jingDongDetailCandidateEvidence(current, pack("jd_h5", 18, true)),
  });
  const details = readDiagnostics()[0].details;
  assert.equal(details.hasPickup, true);
  assert.equal(details.foreignPackage, false);
  assert.equal(details.waybillMatches, true);
  assert.equal(details.detailComplete, true);
  assert.equal(details.foreignAnchorAtMs, 0);
  assert.equal(details.earliestTrackAtMs, NOW - 17 * 60000);
  assert.equal(JSON.stringify(details).includes(WAYBILL), false);
  assert.equal(JSON.stringify(details).includes("Synthetic event"), false);
  setDiagnosticsEnabled(false);
});
