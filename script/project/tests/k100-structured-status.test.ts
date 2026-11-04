import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import { emptyState, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import { scrapeWebTimeline, webTimelineFromExtraction } from "../services/web-timeline";
import { WebTimelinePhoneError } from "../services/jt-h5";
import { applySameSourceTimeline, selectShipmentTimeline, shipmentDetailIncompleteReason } from "../services/shipment-policy";

const WAYBILL = "SF000000007301", ORDER = "3610000000007301";
const AT = Date.UTC(2026, 10, 4, 13, 34, 16), NOW = AT + 3600000;
const time = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const input = { waybill: WAYBILL, courierCode: "SF", companyName: "Synthetic carrier", projectedJdOrder: true as const };
const rows = [{ timeText: time(AT), detail: "商品已到达承运商设施" },
  { timeText: time(AT - 86400000), detail: "快件已揽收" }];
const packet = (state: unknown = "0", fields = {}) => ({ tracks: rows,
  kuaidi100: { state, waybill: WAYBILL, com: "shunfeng", ...fields } });
const captured = () => webTimelineFromExtraction(packet(), input, NOW)!;
function shipment(pack = captured()) {
  const at = AT + 49000;
  const source: any = { provider: "interface5", waybill: WAYBILL, courierCode: "SF", companyName: input.companyName,
    semantic: "PICKED", structuredStatus: true, statusEventAtMs: at, listOriginAtMs: AT - 2 * 86400000, latestTimeText: time(at),
    latestDetail: "预计11月6日24:00前送达", tracks: [{ timeMs: at, timeText: time(at), detail: "预计11月6日24:00前送达", statusCode: "", raw: {} }],
    normalizedStatus: { version: 1, scope: "ORDER", semantic: "PICKED", code: "103", text: "已揽件", priority: 0, eventAtMs: at, structured: true } };
  return { identity: { id: "interface5:synthetic", bindingSource: "interface5", sourceOwner: "account", sourceId: ORDER,
    phoneTail: "1234", waybill: ORDER, projectedWaybill: WAYBILL, courierCode: "SF", rawCourierCode: "SF",
    companyName: input.companyName, sourceProvider: "JingDong", accountOrder: true, manuallyAdded: false, createdAtMs: AT - 2 * 86400000 },
    timeline: source, sourceTimeline: source, manualTimelines: [pack], updatedAtMs: NOW } as any;
}
const actualNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = actualNow; });

test("same-response K100 state zero is structured transit, with its event clock", () => {
  for (const state of ["0", 0]) {
    const value = webTimelineFromExtraction(packet(state), input, NOW)!;
    assert.equal(value.structuredStatus, true);
    assert.equal(value.semantic, "TRANSIT");
    assert.equal(value.statusEventAtMs, AT);
    assert.equal(value.normalizedStatus?.code, "0");
  }
});
test("missing, unknown or mismatched K100 proof never becomes structured status", () => {
  for (const value of [{ tracks: rows }, packet("999"), packet(""), packet(false), packet("3", { waybill: "SF000000009999" }), packet("3", { com: "zhongtong" })]) {
    assert.equal(webTimelineFromExtraction(value, input, NOW)!.structuredStatus, false);
  }
});
test("a complete same-waybill K100 status and headline supersede the JD order summary", () => {
  const row = shipment(); const before = JSON.stringify(row.sourceTimeline);
  const shown = selectShipmentTimeline(row);
  assert.equal(shown.semantic, "TRANSIT");
  assert.equal(shown.statusEventAtMs, AT);
  assert.equal(shown.latestDetail, rows[0].detail);
  assert.equal(shown.latestTimeText, time(AT));
  assert.equal(JSON.stringify(row.sourceTimeline), before);
  assert.deepEqual(shown.tracks, row.manualTimelines[0].tracks);
});
test("incomplete, stale, wrong-waybill, unstructured and wrong-provider packets do not take over", () => {
  const base = captured();
  const stale = { ...base, tracks: base.tracks.map(t => ({ ...t, timeMs: t.timeMs! - 3600000, timeText: time(t.timeMs! - 3600000) })),
    latestTimeText: time(AT - 3600000), statusEventAtMs: AT - 3600000,
    normalizedStatus: { ...base.normalizedStatus!, eventAtMs: AT - 3600000 } };
  for (const pack of [{ ...base, complete: false, tracks: base.tracks.slice(0, 1) },
    stale, { ...base, waybill: "SF000000009999" }, { ...base, structuredStatus: false, normalizedStatus: undefined },
    { ...base, provider: "jd_h5" }]) {
    assert.equal(selectShipmentTimeline(shipment(pack)).semantic, "PICKED");
  }
});
test("unresolved orders, shipment-scope accounts and accepted terminal states keep their boundaries", () => {
  for (const modify of [(row: any) => { row.identity.projectedWaybill = ""; },
    (row: any) => { row.sourceTimeline.normalizedStatus.scope = "SHIPMENT"; },
    (row: any) => { row.sourceTimeline.semantic = "COMPLETED"; row.sourceTimeline.normalizedStatus.semantic = "COMPLETED"; },
    (row: any) => { row.sourceTimeline.semantic = "CANCELLED"; row.sourceTimeline.normalizedStatus.semantic = "CANCELLED"; }]) {
    const row = shipment(); modify(row);
    assert.notEqual(selectShipmentTimeline(row).semantic, "TRANSIT");
  }
});
test("VM status belongs only to its returned identity, carrier and own result rows", async () => {
  for (const change of [{}, { nu: "SF000000009999" }, { com: "zhongtong" }, { loading: true }, { lastnum: "old" }, { errors: { type: "network" } }, { checkCode: { show: true } }]) {
    memory.clear();
    const vm = { num: WAYBILL, lastnum: WAYBILL, nu: WAYBILL, com: "shunfeng", state: "0", loading: false,
      alllists: rows.map(r => ({ time: r.timeText, context: r.detail })), ...change };
    Object.assign(globalThis, { WebViewController: class {
      loadURL() { return new Promise<boolean>(() => {}); }
      async evaluateJavaScript(script: string) {
        const main = { __vue__: vm };
        const document = { readyState: "complete", querySelector: () => main,
          querySelectorAll: (selector: string) => selector.includes("#main") ? [main] : [] };
        const result = new Function("window", "document", "location", script)({}, document,
          { hostname: "m.kuaidi100.com", href: `https://m.kuaidi100.com/app/query/?nu=${WAYBILL}` });
        if ("checkCode" in change) assert.equal(result.kuaidi100, undefined);
        return result;
      }
      dispose() {}
    } });
    if ("checkCode" in change) {
      await assert.rejects(() => scrapeWebTimeline(input), WebTimelinePhoneError);
    } else {
      const value = await scrapeWebTimeline(input);
      assert.equal(value?.structuredStatus, Object.keys(change).length === 0);
    }
  }
});

test("other H5 caller scopes keep the prior unstructured K100 behavior", () => {
  const value = webTimelineFromExtraction(packet("3"), { ...input, projectedJdOrder: undefined }, NOW)!;
  assert.equal(value.structuredStatus, false);
  assert.equal(value.normalizedStatus, undefined);
});
test("each finite K100 enum uses the existing code mapping without reading headline prose", () => {
  for (const [code, semantic] of [["1", "PICKED"], ["5", "DELIVERY"], ["501", "WAITING_PICKUP"], ["3", "COMPLETED"], ["4", "DANGER"], ["401", "CANCELLED"]]) {
    const value = webTimelineFromExtraction(packet(code), input, NOW)!;
    assert.equal(value.structuredStatus, true);
    assert.equal(value.semantic, semantic);
    assert.equal(value.statusEventAtMs, AT);
  }
});

test("a legacy complete K100 cache cannot suppress the resolved-order state repair", async () => {
  for (const outcome of ["valid", "missing_enum", "failed", "already_structured"]) {
  memory.clear();
  const legacy = { ...captured(), structuredStatus: false, normalizedStatus: undefined };
  const row = shipment(outcome === "already_structured" ? captured() : legacy);
  row.accountRecord = { waybill: ORDER, companyCode: "JDKD", name: "京东商品快递", provider: "JingDong",
    updateTime: time(AT + 49000), phone: "13800001234", stateNumber: 103, channel: 1 };
  assert.equal(shipmentDetailIncompleteReason(row), outcome === "already_structured" ? null : "status_unknown");
  const state = saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: "13800001234", boundAtMs: NOW - 86400000 },
  ] }, NOW);
  const calls: string[] = [];
  const result = await runShipmentRefreshForTesting(state.shipments[0].identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
    { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshAccountParcel: async () => null,
      projectAccountOrderWithCarrier: async (input: any) => input,
      refreshWebTimeline: async (input: any) => {
        calls.push("k100_h5");
        if (outcome === "failed") return null;
        const pack = outcome === "missing_enum" ? legacy : captured();
        const merged = applySameSourceTimeline(input, pack, NOW);
        const cached = merged.manualTimelines!.find(value => value.provider === pack.provider)!;
        return { ...merged, timeline: cached, sourceTimeline: null, manualTimelines: [cached] };
      },
      queryManualForSource: async () => {
        calls.push("paid_or_manual");
        return { shipment: null, pending: null, routeUrl: "" };
      },
    } as any);
  assert.deepEqual(calls, outcome === "already_structured" ? [] : ["k100_h5"]);
  const repaired = outcome === "valid" || outcome === "already_structured";
  assert.equal(selectShipmentTimeline(result.shipment!).semantic, repaired ? "TRANSIT" : "PICKED");
  assert.equal(shipmentDetailIncompleteReason(result.shipment!), repaired ? null : "status_unknown");
  }
});
test("an unknown SHIPMENT projection does not certify the legacy K100 enum gap", () => {
  const pack = captured();
  const unknown = { ...pack, semantic: "UNKNOWN" as const, structuredStatus: false, statusEventAtMs: 0,
    normalizedStatus: { ...pack.normalizedStatus!, semantic: "UNKNOWN" as const, code: "999", text: "", eventAtMs: 0, structured: false } };
  assert.equal(shipmentDetailIncompleteReason(shipment(unknown)), "status_unknown");
  assert.equal(shipmentDetailIncompleteReason(shipment()), null);
});
