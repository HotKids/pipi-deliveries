import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { parseAccountTimelineResponse } from "../services/account-parser";
import { parcelToShipment, refreshAccountParcel } from "../services/account-sync";
import { applyAccountShipment, applyTargetedAccountShipment, asAccountDetailObservation,
  selectShipmentDetailTimeline, jingDongDetailCandidateEvidence } from "../services/shipment-policy";
import { emptyState, saveState, loadState } from "../services/storage";
import { saveGatewayToken } from "../services/credentials";
import { setDiagnosticsEnabled, writeDiagnostic, readDiagnostics } from "../services/logger";

const ORDER = "9999000011112222", WAYBILL = "JDSYNTHETIC0001", PHONE = "13800000000";
const NOW = Date.UTC(2026, 8, 11, 6);
Object.assign(Crypto, {
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
  hmacSHA256: (data: string, key: string) => ({
    toHexString: () => createHmac("sha256", key).update(data).digest("hex"),
  }),
});
function response(mailNo: string, code = 105, detail = "Synthetic query event") {
  return { code: 0, data: { mailNo, provider: "JingDong", cpCode: "JD", name: "Synthetic carrier",
    stateNum: code, normalizedStatusScope: "SHIPMENT", phone: PHONE, details: [
      { time: "2026-09-11 10:00:00", desc: detail, statusCode: code },
      { time: "2026-09-10 08:00:00", desc: "已揽收", statusCode: 103 },
    ] } };
}
function owner() {
  const dto = parseAccountTimelineResponse("interface5", response(ORDER), { waybill: ORDER })!;
  return applyAccountShipment(undefined, parcelToShipment({ ...dto, waybill: WAYBILL,
    tracks: [{ timeText: "2026-09-10 09:00:00", detail: "Synthetic feed-only event", statusCode: "104" }],
    semantic: "TRANSIT", sourceStateCode: "104" }, [PHONE], NOW)!, NOW);
}
function transport(value: unknown) {
  memory.clear(); saveGatewayToken("AbCdEfGh_123-456");
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body);
    assert.equal(request.mode, "detail");
    assert.equal(request.record.waybill, ORDER, "the original account request identity stays intact");
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  }) as unknown as typeof fetch;
}

for (const [name, mailNo, code] of [["order-key delivery", ORDER, 105], ["order-key pickup", ORDER, 103],
  ["identifier-omitting detail", "", 105],
  ["carrier-key delivery", WAYBILL, 105]] as const) {
  test(`${name} keeps query identity and history separate from feed`, async () => {
    transport(response(mailNo, code));
    const current = owner();
    const dto = await refreshAccountParcel(current, Date.now() + 1000);
    assert.ok(dto);
    assert.equal(dto.waybill, WAYBILL);
    assert.equal(dto.projectionTimeline, undefined, "identity restoration must not copy feed nodes into query");
    const incoming = parcelToShipment(dto, [PHONE], NOW + 1)!;
    const merged = applyTargetedAccountShipment(current, asAccountDetailObservation(current, incoming), NOW + 1);
    assert.equal(merged.identity.id, current.identity.id);
    assert.equal(merged.identity.projectedWaybill, WAYBILL);
    assert.deepEqual(merged.sourceTimeline!.tracks, current.sourceTimeline!.tracks);
    const query = merged.manualTimelines!.find(p => p.provider === "v5_query")!;
    assert.equal(query.waybill, WAYBILL);
    assert.equal(query.semantic, code === 103 ? "PICKED" : "DELIVERY");
    assert.equal(query.tracks.length, 2);
    assert.equal(query.tracks.some(t => t.detail === "Synthetic feed-only event"), false);
    assert.equal(selectShipmentDetailTimeline(merged).provider, "v5_query");
    saveState({ ...emptyState(), shipments: [merged], bindings: [
      { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
    ] }, NOW + 1);
    assert.equal(loadState(NOW + 1).shipments[0].manualTimelines!.find(p => p.provider === "v5_query")!.waybill, WAYBILL);
  });
}
test("an unrelated order cannot borrow the current projection", async () => {
  transport(response("9999000011113333"));
  assert.equal(await refreshAccountParcel(owner(), Date.now() + 1000), null);
});
test("order-only completion cannot overwrite a projected carrier query", async () => {
  const value = response(ORDER, 107, "Synthetic order completion");
  value.data.normalizedStatusScope = "ORDER";
  transport(value);
  assert.equal(await refreshAccountParcel(owner(), Date.now() + 1000), null);
});
test("fresh text identity is not replaced by the previous projection", async () => {
  const next = "JD000000000002";
  transport(response(ORDER, 104, `交付京东快递，运单号为 ${next}`));
  const dto = await refreshAccountParcel(owner(), Date.now() + 1000);
  assert.ok(dto?.textIdentity);
  assert.equal(parcelToShipment(dto!, [PHONE], NOW)!.identity.projectedWaybill, next);
});
test("legacy query diagnostics distinguish an order key without exposing it", () => {
  memory.clear(); setDiagnosticsEnabled(true);
  const current = owner();
  const query = { ...current.timeline, provider: "v5_query", waybill: ORDER };
  writeDiagnostic("detail.timeline.candidate", jingDongDetailCandidateEvidence(current, query));
  const details = readDiagnostics()[0].details;
  assert.equal(details.waybillMatches, false);
  assert.equal(details.waybillMatchesOrder, true);
  assert.equal(JSON.stringify(details).includes(ORDER), false);
  setDiagnosticsEnabled(false);
});
