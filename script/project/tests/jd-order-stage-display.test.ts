import assert from "node:assert/strict";
import { NOW } from "./state-storage-mock";
import type { AccountParcelDto } from "../services/account-parser";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import { parcelToShipment } from "../services/account-sync";
import {
  jingDongOrderStagePrepended,
  selectShipmentDetailPresentation,
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
  shipmentDetailIncompleteReason,
  shipmentSelectionEvidence,
} from "../services/shipment-policy";
import { parseProviderTime } from "../services/status";

// Pipi 1.4.0 rule (user decision 2026-09-17, parity backlog D-8): the selected JD carrier fallback
// package is shown whole; only the feed's own nodes older than its earliest timed node follow it.
const PHONE = "13800001234";
const ORDER = "3610448002878202";
const WAYBILL = "JT4006839564547";

function node(timeText: string, detail: string, raw: Record<string, unknown> = {}): TrackNode {
  return { timeText, timeMs: parseProviderTime(timeText), detail, statusCode: "", raw };
}

// Fold7 2026-09-03 JT4006839564547: the Samsung owner had five nodes, KDNiao one (Pipi's case).
const OWNER_NODES: readonly (readonly [string, string])[] = [
  ["2026-09-03 17:54:53", "预计9月4日(周五)送达"],
  ["2026-09-03 17:49:51", "【DK江门维达网点】已取件"],
  ["2026-09-03 17:22:06", "待出库交付极兔速递，运单号为JT4006839564547"],
  ["2026-09-03 14:49:46", "最快9月3日发货"],
  ["2026-09-03 14:49:42", "您的订单已进入第三方卖家仓库，准备出库"],
];

function jingDongRow(ownerNodes: readonly (readonly [string, string])[]): Shipment {
  const parcel: AccountParcelDto = {
    source: "interface5", ownerId: ORDER, orderId: ORDER,
    accountOrder: true, waybill: WAYBILL, courierCode: "JT", rawCourierCode: "JT",
    companyName: "极兔速递", sourceProvider: "JingDong", sourceStateCode: "104",
    sourceStateText: "运输中", semantic: "TRANSIT", normalizedStatusScope: "SHIPMENT",
    normalizedStatusSemantic: "TRANSIT", normalizedStatusText: "运输中",
    receiverPhone: PHONE, senderPhone: "", latestTimeText: ownerNodes[0][0],
    latestDetail: ownerNodes[0][1], routeUrl: "", projectionUrl: "",
    tracks: ownerNodes.map(([timeText, detail]) => ({ timeText, detail, statusCode: "" })),
  };
  const row = parcelToShipment(parcel, [PHONE], NOW)!;
  assert.ok(row);
  assert.equal(row.sourceTimeline!.tracks.length, ownerNodes.length);
  return row;
}

function fallback(provider: string, tracks: TrackNode[]): TimelinePackage {
  return {
    provider, waybill: WAYBILL, courierCode: "JT", companyName: "极兔速递",
    semantic: "UNKNOWN", structuredStatus: false, statusEventAtMs: null, complete: true, tracks,
    latestTimeText: tracks[0]?.timeText || "", latestDetail: tracks[0]?.detail || "", successAtMs: NOW,
  };
}

const times = (tracks: readonly TrackNode[]) => tracks.map(track => track.timeText);

// 1. A sticky one-node KDNiao package: the owner nodes older than 17:48:37 follow it, newest first;
//    the two later owner nodes never interleave and nothing replaces the package's own row.
{
  const kdniao = fallback("kdniao", [
    node("2026-09-03 17:48:37", "【DK江门维达网点】已揽收", { _pipiStatusSource: "kdniao" }),
  ]);
  const row: Shipment = { ...jingDongRow(OWNER_NODES), manualTimelines: [kdniao],
    detailSelection: { provider: "kdniao", selectedAtMs: NOW - 60_000 } };
  const raw = selectShipmentDetailTimeline(row);
  assert.equal(raw.provider, "kdniao");
  assert.deepEqual(raw.tracks, kdniao.tracks, "the raw selection stays the whole package");
  const presented = selectShipmentDetailPresentation(row);
  assert.equal(presented.provider, "kdniao");
  assert.deepEqual(times(presented.tracks), [
    "2026-09-03 17:48:37", "2026-09-03 17:22:06", "2026-09-03 14:49:46", "2026-09-03 14:49:42",
  ]);
  assert.equal(presented.tracks[2].detail, "最快9月3日发货", "forecast wording is display-only and stays");
  assert.equal(presented.latestDetail, raw.latestDetail, "the presentation keeps the selected headline");
  assert.equal(presented.latestTimeText, raw.latestTimeText);
  assert.equal(presented.semantic, raw.semantic);
  assert.equal(jingDongOrderStagePrepended(row), true);
  assert.equal(shipmentDetailIncompleteReason(row), null, "completeness judges the raw package");
  assert.deepEqual(selectShipmentTimeline(row).tracks, kdniao.tracks, "Home keeps the whole package");
  assert.equal(shipmentSelectionEvidence(row).historyProvider, "kdniao");
  assert.deepEqual(selectShipmentDetailTimeline(row).tracks, kdniao.tracks, "presentation never mutates the selection");
}

// 2. Ranking without stickiness: an order-stage-only feed lacks pickup, the complete KDNiao package
//    wins on its own, and the order stage still follows its oldest node.
{
  const kdniao = fallback("kdniao", [
    node("2026-09-03 17:50:00", "快件运输中", { _pipiStatusSource: "kdniao" }),
    node("2026-09-03 17:48:37", "【DK江门维达网点】已揽收", { _pipiStatusSource: "kdniao" }),
  ]);
  const row: Shipment = { ...jingDongRow([OWNER_NODES[0], ...OWNER_NODES.slice(2)]), manualTimelines: [kdniao] };
  assert.equal(selectShipmentDetailTimeline(row).provider, "kdniao");
  assert.equal(shipmentSelectionEvidence(row).selectionReason, "complete_history");
  assert.deepEqual(times(selectShipmentDetailPresentation(row).tracks), [
    "2026-09-03 17:50:00", "2026-09-03 17:48:37",
    "2026-09-03 17:22:06", "2026-09-03 14:49:46", "2026-09-03 14:49:42",
  ]);
}

// 3. Only the feed's own rows donate: grafted JD H5 rows and provider-tagged rows are skipped, and a
//    package whose earliest node predates every owner node is left untouched.
{
  const kdniao = fallback("kdniao", [
    node("2026-09-03 17:48:37", "【DK江门维达网点】已揽收", { _pipiStatusSource: "kdniao" }),
  ]);
  const base = jingDongRow(OWNER_NODES);
  const grafted = node("2026-09-03 14:00:00", "联合页嫁接节点", { _pipiStatusSource: "jingdong_h5" });
  const foreign = node("2026-09-03 14:10:00", "别的包的节点", { _pipiStatusSource: "kdniao" });
  const row: Shipment = { ...base, manualTimelines: [kdniao],
    sourceTimeline: { ...base.sourceTimeline!, tracks: [...base.sourceTimeline!.tracks, grafted, foreign] },
    detailSelection: { provider: "kdniao", selectedAtMs: NOW - 60_000 } };
  const presented = selectShipmentDetailPresentation(row);
  assert.equal(presented.tracks.length, 4);
  assert.ok(!presented.tracks.some(track => track.detail === "联合页嫁接节点"));
  assert.ok(!presented.tracks.some(track => track.detail === "别的包的节点"));

  const early = fallback("kdniao", [
    node("2026-09-03 14:30:00", "【DK江门维达网点】已揽收", { _pipiStatusSource: "kdniao" }),
    node("2026-09-03 17:48:37", "快件运输中", { _pipiStatusSource: "kdniao" }),
  ]);
  const untouched: Shipment = { ...base, manualTimelines: [early],
    detailSelection: { provider: "kdniao", selectedAtMs: NOW - 60_000 } };
  assert.equal(selectShipmentDetailTimeline(untouched).provider, "kdniao");
  assert.equal(jingDongOrderStagePrepended(untouched), false);
  assert.deepEqual(selectShipmentDetailPresentation(untouched).tracks, early.tracks);
}

// 4. Packages that already carry the shopping-order stage (JD H5, account query) and non-JD sources
//    are shown exactly as selected.
{
  const h5 = fallback("jd_h5", Array.from({ length: 7 }, (_, index) => node(
    `2026-09-03 17:${String(50 - index).padStart(2, "0")}:00`,
    index === 6 ? "已揽收" : `H5 event ${index}`, { _pipiStatusSource: "jingdong_h5" })));
  const withH5: Shipment = { ...jingDongRow(OWNER_NODES), manualTimelines: [h5],
    detailSelection: { provider: "jd_h5", selectedAtMs: NOW - 60_000 } };
  assert.equal(selectShipmentDetailTimeline(withH5).provider, "jd_h5");
  assert.equal(jingDongOrderStagePrepended(withH5), false);
  assert.deepEqual(selectShipmentDetailPresentation(withH5).tracks, h5.tracks);

  const kdniao = fallback("kdniao", [
    node("2026-09-03 17:48:37", "【DK江门维达网点】已揽收", { _pipiStatusSource: "kdniao" }),
  ]);
  const base = jingDongRow(OWNER_NODES);
  const unrelated: Shipment = { ...base, manualTimelines: [kdniao],
    identity: { ...base.identity, sourceProvider: "UnrelatedSource" },
    detailSelection: { provider: "kdniao", selectedAtMs: NOW - 60_000 } };
  assert.equal(jingDongOrderStagePrepended(unrelated), false);
  assert.deepEqual(selectShipmentDetailPresentation(unrelated), selectShipmentDetailTimeline(unrelated));
}

console.log("JD detail keeps the owner's order stage behind the selected fallback package");
