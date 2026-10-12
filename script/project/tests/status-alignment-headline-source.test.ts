import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { memory, NOW } from "./state-storage-mock";
import type { NormalizedStatus, Shipment, StatusSemantic, TrackNode } from "../models";
import type { AccountParcelDto } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { selectShipmentTimeline, shipmentSelectionEvidence, statusAlignmentTimes } from "../services/shipment-policy";

const PHONE = "13800001009";
const WAYBILL = "SF900000001009";
const STATUS_AT = NOW - 3_600_000;
const HEADLINE_AT = NOW - 60_000;
const realNow = Date.now;
const timeText = (at: number) => new Date(at + 8 * 3_600_000)
  .toISOString().slice(0, 19).replace("T", " ");
const status = (semantic: StatusSemantic, at: number): NormalizedStatus => ({
  version: 1, scope: "SHIPMENT", semantic, code: semantic, text: semantic,
  priority: 0, eventAtMs: at, structured: true,
});
const track = (at: number, detail: string, semantic: StatusSemantic): TrackNode => ({
  timeMs: at, timeText: timeText(at), detail, statusCode: semantic,
  raw: { normalizedStatus: status(semantic, at) },
});

beforeEach(() => { memory.clear(); Date.now = () => NOW; });
afterEach(() => { Date.now = realNow; });

function duplicateHeadline(feedSemantic: StatusSemantic, selectedSemantic: StatusSemantic): Shipment {
  const parcel: AccountParcelDto = {
    source: "interface5", ownerId: WAYBILL, waybill: WAYBILL, orderId: "", accountOrder: false,
    courierCode: "SF", companyName: "Synthetic carrier", carrierNormalization: null,
    sourceProvider: "ShunFeng", sourceStateCode: "DELIVERY", sourceStateText: "DELIVERY",
    semantic: "DELIVERY", normalizedStatus: status("DELIVERY", STATUS_AT), normalizedStatusScope: "SHIPMENT",
    receiverPhone: PHONE, senderPhone: "", latestTimeText: timeText(HEADLINE_AT),
    latestDetail: "Shared newest event",
    tracks: [
      { timeText: timeText(HEADLINE_AT), detail: "Shared newest event", statusCode: feedSemantic,
        normalizedStatus: status(feedSemantic, HEADLINE_AT) },
      { timeText: timeText(STATUS_AT), detail: "Earlier delivery", statusCode: "DELIVERY",
        normalizedStatus: status("DELIVERY", STATUS_AT) },
    ],
    routeUrl: "", projectionUrl: "",
  };
  const shipment = parcelToShipment(parcel, [PHONE], NOW)!;
  assert.ok(shipment);
  const detailed = { ...shipment.sourceTimeline!, provider: "k100_h5", complete: true,
    tracks: [track(HEADLINE_AT, "Shared newest event", selectedSemantic),
      track(STATUS_AT, "Earlier delivery", "DELIVERY"),
      track(STATUS_AT - 86_400_000, "顺丰速运 已收取快件", "PICKED")] };
  return { ...shipment, manualTimelines: [detailed] };
}

for (const [feedSemantic, selectedSemantic] of [
  ["DELIVERY", "COMPLETED"],
  ["COMPLETED", "DELIVERY"],
] as const) {
  test(`identical feed and selected headlines retain the selected ${selectedSemantic} enum with or without diagnostics`, () => {
    const shipment = duplicateHeadline(feedSemantic, selectedSemantic);
    const original = structuredClone(shipment);
    const evidence = { historyProvider: "none", headlineProvider: "none",
      statusProvider: "none", selectionReason: "source_policy" };
    const ordinary = selectShipmentTimeline(shipment);
    const diagnosed = selectShipmentTimeline(shipment, evidence);

    assert.equal(evidence.headlineProvider, "k100_h5");
    assert.equal(ordinary.provider, "k100_h5");
    assert.equal(diagnosed.provider, "k100_h5");
    assert.equal(ordinary.semantic, selectedSemantic);
    assert.equal(ordinary.statusEventAtMs, HEADLINE_AT);
    assert.deepEqual(ordinary, diagnosed, "optional diagnostics cannot change business presentation");
    assert.deepEqual(ordinary.tracks, shipment.manualTimelines![0].tracks);
    assert.deepEqual(shipmentSelectionEvidence(shipment), evidence);
    assert.deepEqual(shipment, original, "selection does not rewrite either source package");
  });
}

function metadataOnlyFeed(manualSemantic: StatusSemantic): Shipment {
  const waybill = "ZT900000001009";
  const parcel: AccountParcelDto = {
    source: "interface5", ownerId: waybill, waybill, orderId: "", accountOrder: false,
    courierCode: "ZTO", companyName: "Synthetic carrier", carrierNormalization: null,
    sourceProvider: "ZhongTong", sourceStateCode: "DELIVERY", sourceStateText: "DELIVERY",
    semantic: "DELIVERY", normalizedStatus: status("DELIVERY", STATUS_AT), normalizedStatusScope: "SHIPMENT",
    receiverPhone: PHONE, senderPhone: "", latestTimeText: timeText(HEADLINE_AT),
    latestDetail: "Shared newest event", tracks: [], routeUrl: "", projectionUrl: "",
  };
  const shipment = parcelToShipment(parcel, [PHONE], NOW)!;
  assert.ok(shipment);
  const detailed = { ...shipment.sourceTimeline!, provider: "v6_query", complete: true,
    semantic: manualSemantic, structuredStatus: manualSemantic !== "UNKNOWN",
    statusEventAtMs: manualSemantic === "UNKNOWN" ? null : HEADLINE_AT,
    normalizedStatus: manualSemantic === "UNKNOWN" ? undefined : status(manualSemantic, HEADLINE_AT),
    tracks: [track(HEADLINE_AT, "Shared newest event", manualSemantic),
      track(STATUS_AT, "Earlier delivery", "DELIVERY"),
      track(STATUS_AT - 86_400_000, "Synthetic pickup", "PICKED")] };
  return { ...shipment, manualTimelines: [detailed] };
}

for (const manualSemantic of ["UNKNOWN", "DELIVERY", "COMPLETED"] as const) {
  test(`a metadata-only feed headline cannot borrow the ${manualSemantic} enum from its selected v6 history`, () => {
    const shipment = metadataOnlyFeed(manualSemantic);
    const original = structuredClone(shipment);
    const evidence = { historyProvider: "none", headlineProvider: "none",
      statusProvider: "none", selectionReason: "source_policy" };
    const ordinary = selectShipmentTimeline(shipment);
    const diagnosed = selectShipmentTimeline(shipment, evidence);

    assert.equal(evidence.historyProvider, "v6_query");
    assert.equal(evidence.headlineProvider, "interface5");
    assert.equal(evidence.statusProvider, "interface5");
    assert.equal(ordinary.provider, "v6_query");
    assert.deepEqual(ordinary.tracks, shipment.manualTimelines![0].tracks);
    assert.equal(ordinary.latestDetail, shipment.sourceTimeline!.latestDetail);
    assert.equal(ordinary.latestTimeText, shipment.sourceTimeline!.latestTimeText);
    assert.equal(ordinary.semantic, "DELIVERY", "a headline without its own node has unknown Hs");
    assert.equal(ordinary.statusEventAtMs, STATUS_AT, "history cannot supply the feed headline's enum or clock");
    assert.deepEqual(ordinary.normalizedStatus, shipment.sourceTimeline!.normalizedStatus);
    assert.equal(statusAlignmentTimes(shipment, NOW)?.headlineSemantic, undefined);
    assert.deepEqual(ordinary, diagnosed, "optional diagnostics cannot change business presentation");
    assert.deepEqual(shipmentSelectionEvidence(shipment), evidence);
    assert.deepEqual(shipment, original, "selection does not rewrite either package");
  });
}
