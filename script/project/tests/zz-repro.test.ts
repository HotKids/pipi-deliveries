import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import {
  applyAccountShipment,
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
  hasSettledTimelineHistory,
} from "../services/shipment-policy";

const NOW = Date.UTC(2026, 8, 8, 0, 14, 0);
const WAYBILL = "78770238";

function track(offsetMinutes: number, detail: string) {
  return {
    timeText: "2026-09-06 09:00:00",
    timeMs: NOW - offsetMinutes * 60_000,
    detail,
    statusCode: "0",
    raw: {},
  };
}

const eleven = Array.from({ length: 11 }, (_, index) =>
  track(2000 - index * 100, index === 0 ? "您的快件已签收" : `节点${index}`),
);

function carrierPackage(provider: string, complete: boolean): TimelinePackage {
  return {
    provider,
    complete,
    structuredStatus: true,
    waybill: WAYBILL,
    courierCode: "ZTO",
    companyName: "中通快递",
    semantic: "COMPLETED",
    statusEventAtMs: NOW - 2000 * 60_000,
    latestTimeText: "2026-09-06 09:00:00",
    latestDetail: "您的快件已签收",
    tracks: eleven,
    successAtMs: NOW - 600_000,
  } as TimelinePackage;
}

// feed 包：0 条带时间的节点，但结构化状态是已签收
const feed: TimelinePackage = {
  provider: "interface5",
  complete: false,
  structuredStatus: true,
  waybill: WAYBILL,
  courierCode: "ZTO",
  companyName: "中通快递",
  semantic: "COMPLETED",
  statusEventAtMs: null,
  latestTimeText: "",
  latestDetail: "",
  tracks: [],
  successAtMs: NOW - 600_000,
} as TimelinePackage;

const stored: Shipment = {
  identity: {
    id: `interface5:account:${WAYBILL}`,
    bindingSource: "interface5",
    sourceOwner: "interface5",
    sourceId: WAYBILL,
    phoneTail: "1515",
    phone: "13800001515",
    courierCode: "ZTO",
    rawCourierCode: "ZTO",
    rawCompanyName: "中通快递",
    companyName: "中通快递",
    sourceProvider: "CaiNiao",
    accountOrder: false,
    manuallyAdded: false,
    createdAtMs: NOW - 5 * 24 * 60 * 60 * 1000,
  },
  timeline: carrierPackage("cn_h5", true),
  sourceTimeline: feed,
  manualTimelines: [
    carrierPackage("cn_h5", true),
    carrierPackage("v4_query", false),
    carrierPackage("kdniao", true),
  ],
  route: { kind: "cainiao", source: "interface5" },
  accountRecord: null,
  updatedAtMs: NOW - 600_000,
} as unknown as Shipment;

console.log("settled?", hasSettledTimelineHistory(stored));
console.log("selected timeline provider", selectShipmentTimeline(stored).provider);
console.log("detail provider", selectShipmentDetailTimeline(stored).provider);

const incoming: Shipment = {
  ...stored,
  timeline: { ...feed, successAtMs: NOW },
  sourceTimeline: { ...feed, successAtMs: NOW },
  manualTimelines: [],
  updatedAtMs: NOW,
} as Shipment;

const after = applyAccountShipment(stored, incoming, NOW);
console.log("after manuals:", (after.manualTimelines || []).map((t) => t.provider));
console.log("after timeline:", after.timeline.provider, after.timeline.tracks.length);
console.log("after source:", after.sourceTimeline?.provider, after.sourceTimeline?.tracks.length);
