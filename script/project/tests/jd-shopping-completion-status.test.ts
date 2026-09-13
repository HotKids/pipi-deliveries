import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { parseAccountSyncResponse, parseAccountTimelineResponse } from "../services/account-parser";
import { parcelToShipment, refreshAccountParcel } from "../services/account-sync";
import { applyAccountShipment, applyTargetedAccountShipment, asAccountDetailObservation,
  selectShipmentTimeline } from "../services/shipment-policy";
import { mergeAccountParcel } from "../services/sync";
import { saveGatewayToken } from "../services/credentials";
import { shouldRefreshShipment, terminalEvidenceAtMs, shipmentPresentationStatus,
  shipmentDetailPresentationStatus } from "../services/status";

const ORDER = "9999000011112222", WAYBILL = "JD000000009751", PHONE = "13800000000";
const OLD_AT = Date.UTC(2026, 8, 10, 0), REVIEW_AT = Date.UTC(2026, 8, 11, 2);
const NOW = REVIEW_AT + 3600000;
const REVIEW = `您的订单${ORDER}已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。`;
Object.assign(Crypto, {
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
  hmacSHA256: (data: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(data).digest("hex"),
  }),
});
function normalized(code: number, eventAtMs: number, scope = "ORDER") {
  return { version: 1, scope, semantic: code === 107 ? "COMPLETED" : code === 105 ? "DELIVERY" : "UNKNOWN",
    code: String(code), text: code === 107 ? scope === "ORDER" ? "已完成" : "已签收"
      : code === 105 ? "派送中" : "",
    priority: code === 107 ? 6 : code === 105 ? 5 : 0, eventAtMs, structured: code !== 0 };
}
function response(mailNo: string, reviewOnly = false, code = 107) {
  return { code: 0, data: { mailNo, provider: "JingDong", cpCode: "JD", name: "Synthetic carrier",
    phone: PHONE, stateNum: code, normalizedStatus: normalized(code, REVIEW_AT),
    details: [{ time: "2026-09-11 10:00:00", desc: REVIEW,
      normalizedStatus: normalized(0, REVIEW_AT) },
    ...reviewOnly ? [] : [{ time: "2026-09-10 09:00:00", desc: "您的快件已送达至【家门口】",
      normalizedStatus: normalized(0, OLD_AT + 3600000) }]] } };
}
function owner(direct: boolean, completed: boolean) {
  const mailNo = direct ? WAYBILL : ORDER;
  const code = completed ? 107 : 105;
  const dto = parseAccountTimelineResponse("interface5", { code: 0, data: {
    mailNo, provider: "JingDong", cpCode: "JD", name: "Synthetic carrier", phone: PHONE,
    stateNum: code, normalizedStatus: normalized(code, OLD_AT, "SHIPMENT"),
    details: [{ time: "2026-09-10 08:00:00", desc: "Synthetic accepted carrier event",
      normalizedStatus: normalized(code, OLD_AT, "SHIPMENT") }],
  } }, { waybill: mailNo })!;
  return applyAccountShipment(undefined, parcelToShipment({ ...dto, waybill: WAYBILL }, [PHONE], NOW)!, NOW);
}
for (const direct of [false, true]) for (const path of ["query", "list"] as const) {
  for (const reviewOnly of [false, true]) for (const completed of [false, true]) {
    test(`${path} ${direct ? "direct waybill" : "projected order"}: ${completed ? "retains signed status" : "accepts first completion"}, ${reviewOnly ? "review only" : "unknown carrier node"}`, async () => {
      memory.clear(); saveGatewayToken("AbCdEfGh_123-456");
      const current = owner(direct, completed);
      const value = response(direct ? WAYBILL : ORDER, reviewOnly);
      globalThis.fetch = (async (_url: string, init: { body: string }) => {
        const request = JSON.parse(init.body);
        assert.equal(request.mode, "detail");
        assert.equal(request.record.waybill, current.identity.sourceId);
        return { ok: true, status: 200, text: async () => JSON.stringify(value) };
      }) as unknown as typeof fetch;
      const dto = path === "query"
        ? await refreshAccountParcel(current, Date.now() + 1000, undefined, undefined, { recognizeCarrier: false })
        : parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [value.data] } })[0];
      assert.ok(dto);
      const incoming = parcelToShipment({ ...dto, waybill: WAYBILL }, [PHONE], NOW + 1)!;
      assert.equal(incoming.timeline.semantic, "COMPLETED", "removing review prose must preserve the packet's structured completion");
      assert.equal(incoming.timeline.statusEventAtMs, REVIEW_AT, "the provider owns the original structured status clock");
      assert.deepEqual(incoming.timeline.normalizedStatus, normalized(107, REVIEW_AT));
      assert.equal(incoming.timeline.tracks.length, reviewOnly ? 0 : 1);
      const merged = path === "query"
        ? applyTargetedAccountShipment(current, asAccountDetailObservation(current, incoming), NOW + 1)
        : mergeAccountParcel({ shipments: [current] } as never, [current], dto, [PHONE],
          "interface5", NOW + 1, new Map())[0]!;
      const selected = selectShipmentTimeline(merged);
      assert.equal(selected.semantic, "COMPLETED", "a first structured completion must replace DELIVERY");
      assert.equal(shipmentPresentationStatus({ ...merged, timeline: selected }).text, "已签收");
      assert.equal(shipmentDetailPresentationStatus({ ...merged, timeline: selected }, selected).text, "已签收");
      assert.equal(selected.statusEventAtMs, completed ? OLD_AT : REVIEW_AT,
        "a later shopping completion must not move an already accepted signature time");
      assert.equal(selected.latestDetail.includes("评价"), false);
      assert.equal(merged.identity.sourceId, current.identity.sourceId);
      assert.equal(merged.identity.projectedWaybill, current.identity.projectedWaybill);
      if (path === "query") {
        assert.deepEqual(merged.sourceTimeline, current.sourceTimeline, "query must not rewrite the list snapshot");
        assert.ok(merged.manualTimelines?.some(packet => packet.provider === "v5_query"));
      }
    });
  }
}
test("unknown packet and delivery prose do not create a structured signature", () => {
  const value = response(WAYBILL, false, 0);
  const dto = parseAccountTimelineResponse("interface5", value, { waybill: WAYBILL })!;
  const incoming = parcelToShipment(dto, [PHONE], NOW)!;
  assert.equal(incoming.timeline.semantic, "UNKNOWN");
  assert.equal(incoming.timeline.structuredStatus, false);
  assert.equal(incoming.timeline.statusEventAtMs, null);
});
test("a structured completion without an upstream clock remains undated and refreshable", () => {
  const value = response(WAYBILL, true);
  value.data.normalizedStatus.eventAtMs = 0;
  const dto = parseAccountTimelineResponse("interface5", value, { waybill: WAYBILL })!;
  const incoming = parcelToShipment(dto, [PHONE], NOW)!;
  assert.equal(incoming.timeline.semantic, "COMPLETED");
  assert.equal(incoming.timeline.structuredStatus, true);
  assert.equal(incoming.timeline.statusEventAtMs, null);
  assert.equal(incoming.timeline.normalizedStatus?.eventAtMs, 0);
  assert.equal(terminalEvidenceAtMs(incoming, NOW), 0);
  assert.equal(shouldRefreshShipment(incoming, NOW), true);
});
test("unresolved order presentation retains its existing order label", () => {
  const value = response(ORDER, true);
  const dto = parseAccountTimelineResponse("interface5", value, { waybill: ORDER })!;
  const incoming = parcelToShipment(dto, [PHONE], NOW)!;
  assert.equal(incoming.identity.projectedWaybill, "");
  assert.equal(shipmentPresentationStatus(incoming).text, "已完成");
  assert.deepEqual(incoming.timeline.normalizedStatus, value.data.normalizedStatus);
});
test("a later order list cannot replace the signature previously accepted from query", () => {
  const base = owner(false, false);
  const signedAt = OLD_AT + 1000;
  const signed = { ...base.timeline, semantic: "COMPLETED" as const, structuredStatus: true,
    statusEventAtMs: signedAt, normalizedStatus: { ...base.timeline.normalizedStatus!,
      semantic: "COMPLETED" as const, code: "107", text: "已签收", eventAtMs: signedAt } };
  const current = applyTargetedAccountShipment(base, asAccountDetailObservation(base,
    { ...base, timeline: signed, sourceTimeline: signed, manualTimelines: [] }), NOW);
  assert.equal(current.timeline.semantic, "COMPLETED");
  assert.equal(current.sourceTimeline!.semantic, "DELIVERY");
  const value = response(ORDER);
  const dto = parseAccountSyncResponse("interface5", { code: 0, data: { expressList: [value.data] } })[0]!;
  const merged = mergeAccountParcel({ shipments: [current] } as never, [current], dto, [PHONE],
    "interface5", NOW + 1, new Map())[0]!;
  assert.equal(selectShipmentTimeline(merged).statusEventAtMs, signedAt,
    "a known signed query owns the clock before a later order-list completion");
});
