import assert from "node:assert/strict";
import type { AttachedCarrierStatus, NormalizedStatus, Shipment, StatusSemantic, TimelinePackage } from "../models";
import { selectShipmentTimeline } from "../services/shipment-policy";
import { parseProviderTime, shipmentPresentationStatus } from "../services/status";

// 采纳 A unified (user 2026-09-26, 其余裁决 9): when a projected order holds the waybill first, its list
// status follows the attached carrier record when that record's event is newer; with the same status a
// higher Worker priority also takes it (and a lower one never does); a signed or cancelled row never
// falls back to a non-terminal status; the headline changes only when it is not older (D6, kept).
const ORDER = "3610000000009901";
const WAYBILL = "JT0000000009901";
const at = (text: string) => parseProviderTime(text)!;

function projection(semantic: StatusSemantic, eventAtMs: number, code = "", priority = 0,
  text = ""): NormalizedStatus {
  return { version: 1, scope: "SHIPMENT", semantic, code, text: text || semantic, priority, eventAtMs,
    structured: true };
}

function feed(semantic: StatusSemantic, time: string, normalizedStatus?: NormalizedStatus): TimelinePackage {
  return {
    provider: "interface5", waybill: WAYBILL, courierCode: "JTSD", companyName: "极兔速递",
    semantic, structuredStatus: true, statusEventAtMs: at(time), ...(normalizedStatus ? { normalizedStatus } : {}),
    latestTimeText: time, latestDetail: `订单节点 ${time}`,
    tracks: [{ timeText: time, timeMs: at(time), detail: `订单节点 ${time}`, statusCode: "", raw: {} }],
    successAtMs: at(time),
  };
}

function order(source: TimelinePackage, carrier: AttachedCarrierStatus,
  manualTimelines: TimelinePackage[] = []): Shipment {
  return {
    identity: {
      id: `interface5:account:${ORDER}`, bindingSource: "interface5", sourceOwner: "interface5:order",
      sourceId: ORDER, orderId: ORDER, projectedWaybill: WAYBILL, accountOrder: true, manuallyAdded: false,
      sourceProvider: "JingDong", courierCode: "JTSD", companyName: "极兔速递", phone: "13800009901",
      phoneTail: "9901", createdAtMs: at("2026-09-18 08:00:00"),
    },
    timeline: source, sourceTimeline: source, manualTimelines, route: null, accountRecord: null,
    attachedCarrierStatus: carrier, updatedAtMs: at("2026-09-20 12:00:00"),
  };
}

function carrier(semantic: StatusSemantic, time: string, normalizedStatus?: NormalizedStatus,
  headline = `承运商节点 ${time}`): AttachedCarrierStatus {
  return { shipmentId: `interface5:account:${WAYBILL}`, semantic, statusEventAtMs: at(time),
    ...(normalizedStatus ? { normalizedStatus } : {}), latestTimeText: time, latestDetail: headline };
}

// A newer carrier event takes the status (unchanged behavior).
{
  const selected = selectShipmentTimeline(order(feed("TRANSIT", "2026-09-20 10:00:00"),
    carrier("COMPLETED", "2026-09-20 11:00:00")));
  assert.equal(selected.semantic, "COMPLETED");
  assert.equal(selected.latestDetail, "承运商节点 2026-09-20 11:00:00");
}

// Same status, higher priority: taken although the carrier's event is not newer.
{
  const own = "2026-09-20 10:00:00", older = "2026-09-20 09:00:00";
  const shipment = order(feed("DELIVERY", own, projection("DELIVERY", at(own))),
    carrier("DELIVERY", older, projection("DELIVERY", at(older), "STA_DELIVERING", 1, "驿站派送中")));
  const selected = selectShipmentTimeline(shipment);
  assert.equal(selected.semantic, "DELIVERY");
  assert.equal(selected.normalizedStatus?.code, "STA_DELIVERING", "the higher-priority subtype is adopted");
  assert.equal(selected.latestDetail, `订单节点 ${own}`, "an older carrier headline does not replace a newer one");
  assert.equal(shipmentPresentationStatus({ ...shipment, timeline: selected }).text, "待派送");
}

// Same status, lower priority: never taken, even with a newer event.
{
  const own = "2026-09-20 10:00:00", newer = "2026-09-20 11:00:00";
  const selected = selectShipmentTimeline(order(
    feed("DELIVERY", own, projection("DELIVERY", at(own), "STA_DELIVERING", 1, "驿站派送中")),
    carrier("DELIVERY", newer, projection("DELIVERY", at(newer)))));
  assert.equal(selected.normalizedStatus?.code, "STA_DELIVERING", "a lower-priority report keeps the row's own status");
  assert.equal(selected.statusEventAtMs, at(own));
}

// A signed row never falls back to a non-terminal status, even for a newer carrier event. The signing
// here is the row's own newer per-waybill query; the stored feed is still in transit.
{
  const feedTime = "2026-09-20 08:00:00", signed = "2026-09-20 10:00:00", later = "2026-09-20 11:00:00";
  const query: TimelinePackage = { ...feed("COMPLETED", signed), provider: "v5_query" };
  const selected = selectShipmentTimeline(order(feed("TRANSIT", feedTime), carrier("DELIVERY", later), [query]));
  assert.equal(selected.semantic, "COMPLETED", "a signed row stays signed");
  assert.equal(selected.statusEventAtMs, at(signed));
  // Terminal to terminal is not a regression.
  const cancelled = selectShipmentTimeline(order(feed("TRANSIT", feedTime), carrier("CANCELLED", later), [query]));
  assert.equal(cancelled.semantic, "CANCELLED");
}

console.log("attached carrier status tests passed");
