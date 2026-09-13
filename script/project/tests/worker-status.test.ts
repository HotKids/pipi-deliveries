import assert from "node:assert/strict";
import type { NormalizedStatus } from "../models";
import { parseMotoTimeline, parseMeizuTimeline, parseKdniaoTimeline,
  parseKuaidi100Timeline } from "../services/manual-query-parser";
import { parseAccountSyncResponse, parseAccountTimelineResponse } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { shipmentPresentationStatus, latestEventEvidence, mergeTimelinePackage } from "../services/status";

const status: NormalizedStatus = { version: 1, scope: "SHIPMENT", semantic: "DELIVERY",
  code: "STA_DELIVERING", text: "驿站派送中", priority: 1, eventAtMs: 1789290913000, structured: true };
const unknown: NormalizedStatus = { ...status, semantic: "UNKNOWN", code: "",
  text: "", priority: 0, eventAtMs: 0, structured: false };
const node = { time: "2026-09-13 17:15:13", desc: "已签收", context: "已签收",
  normalizedStatus: unknown, statusCode: "SIGN", status: "SIGN" };
for (const projection of [status, unknown]) {
  const responses = [
    parseMotoTimeline({ normalizedStatus: projection, data: { logisticsStatus: "SIGN", fullTraceDetail: [node] } }),
    parseMeizuTimeline({ normalizedStatus: projection, value: { tracks: [node] } }),
    parseKdniaoTimeline({ normalizedStatus: projection, state: "3", traces: [{ ...node,
      action: "3", acceptTime: node.time, acceptStation: node.desc }] }),
    parseKuaidi100Timeline({ normalizedStatus: projection, state: "3", data: [node] }),
  ];
  for (const parsed of responses) {
    assert.equal(parsed.semantic, projection.semantic);
    assert.equal(parsed.statusEventAtMs, projection.eventAtMs || null);
    assert.equal(parsed.hasStructuredStatus, projection.structured);
    assert.deepEqual(parsed.normalizedStatus, projection);
    assert.equal(latestEventEvidence(parsed.tracks).semantic, "UNKNOWN",
      "explicit node UNKNOWN must not be reinterpreted from raw codes or prose");
  }
  for (const source of ["interface5", "interface6"] as const) {
    const row = { mailNo: "8238522608021", cpCode: "EMS", name: "EMS", phone: "13800001234",
      stateNum: 107, logisticsStatus: "SIGN", state: "已签收", normalizedStatus: projection, details: [node] };
    const parcel = parseAccountSyncResponse(source, { code: 0, data: { expressList: [row] } })[0];
    assert.equal(parcel.semantic, projection.semantic);
    assert.deepEqual(parcel.normalizedStatus, projection);
    const shipment = parcelToShipment(parcel, ["13800001234"], status.eventAtMs + 60000)!;
    assert.equal(shipment.timeline.semantic, projection.semantic);
    assert.equal(shipment.timeline.statusEventAtMs, projection.eventAtMs || null);
    assert.deepEqual(shipment.timeline.normalizedStatus, projection);
    assert.equal(shipmentPresentationStatus(shipment).text, projection.text);
    const persisted = JSON.parse(JSON.stringify(shipment));
    assert.equal(shipmentPresentationStatus(persisted).text, projection.text);
    const merged = mergeTimelinePackage(shipment.timeline, { ...shipment.timeline,
      semantic: "COMPLETED", structuredStatus: true, statusEventAtMs: status.eventAtMs + 1,
      normalizedStatus: { ...status, semantic: "COMPLETED", text: "Worker completed",
        eventAtMs: status.eventAtMs + 1, priority: 0 } });
    assert.equal(merged.normalizedStatus?.text, "Worker completed");
  }
}
console.log("Worker-owned status tests passed");

// A single-query response may put its projection only on the outer gateway envelope.
const query = parseAccountTimelineResponse("interface5", { code: 0, normalizedStatus: status,
  data: { mailNo: "8238522608021", stateNum: 107, details: [node] } },
  { waybill: "8238522608021", courierCode: "EMS", phone: "13800001234" })!;
assert.deepEqual(query.normalizedStatus, status);
assert.equal(query.semantic, "DELIVERY");

const noClockNode = { timeText: node.time, timeMs: status.eventAtMs, detail: "Signed prose",
  statusCode: "SIGN", raw: { statusCode: "SIGN", normalizedStatus: {
    ...status, semantic: "COMPLETED", text: "Worker complete", eventAtMs: 0,
  } } };
assert.deepEqual(latestEventEvidence([noClockNode]), { semantic: "UNKNOWN", eventAtMs: null },
  "a raw node clock cannot fill the Worker's unpaired status time");

const base = parcelToShipment(query, ["13800001234"], status.eventAtMs + 60000)!.timeline;
for (const provider of ["interface5", "interface6", "v4_query", "v6_query"]) {
  const selected = { ...base, provider, normalizedStatus: { ...status,
    code: "WORKER_ONLY_SUBTYPE", text: "Worker subtype", priority: 9 } };
  const ordinary = { ...base, provider, statusEventAtMs: status.eventAtMs + 1,
    normalizedStatus: { ...status, code: "DELIVERING", text: "Worker delivery", priority: 0,
      eventAtMs: status.eventAtMs + 1 } };
  assert.equal(mergeTimelinePackage(selected, ordinary).normalizedStatus?.text, "Worker subtype");
  assert.equal(mergeTimelinePackage(ordinary, selected).normalizedStatus?.text, "Worker subtype");
  const terminal = { ...ordinary, semantic: "COMPLETED" as const, normalizedStatus: {
    ...ordinary.normalizedStatus, semantic: "COMPLETED" as const, text: "Worker signed" } };
  assert.equal(mergeTimelinePackage(selected, terminal).semantic, "COMPLETED");
  assert.equal(mergeTimelinePackage(terminal, selected).semantic, "COMPLETED");
}
console.log("Worker priority and paired clock tests passed");

const { GatewayError } = await import("../services/gateway");
const { queryKuaidi100Shipment } = await import("../services/manual-query");
let phoneQueries = 0;
await assert.rejects(queryKuaidi100Shipment({ waybill: "SF123456789012", rawCourierCode: "SF",
  phoneTail: "1234", dependencies: { post: async () => {
    phoneQueries++;
    throw new GatewayError("Worker verification rejected", 200, "phone_verification_required");
  } } }), (error: unknown) => error instanceof Error && error.message === "手机尾号不正确，请重新输入");
assert.equal(phoneQueries, 1, "a required-tail carrier uses the supplied tail after the normalized rejection");
console.log("Worker phone rejection context tests passed");
