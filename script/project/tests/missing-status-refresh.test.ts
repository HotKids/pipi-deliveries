import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, saveState, loadState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";
import { queryManualForSource } from "../services/manual-query";
import { GatewayError } from "../services/gateway";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { selectShipmentTimeline, selectShipmentDetailTimeline, shipmentDetailComplete } from "../services/shipment-policy";

const actualNow = Date.now;
Date.now = () => NOW;
const waybill = "JD1234567890";
function pack(provider: string, semantic: TimelinePackage["semantic"], count: number, pickup = false): TimelinePackage {
  return { provider, waybill, courierCode: "JD", companyName: "JD", semantic,
    structuredStatus: semantic !== "UNKNOWN", statusEventAtMs: semantic === "UNKNOWN" ? null : NOW - 1000,
    latestDetail: "Carrier event", latestTimeText: "2026-09-08 13:59:59", successAtMs: NOW,
    tracks: Array.from({ length: count }, (_, index) => ({ timeMs: NOW - 1000 - index * 1000,
      timeText: `2026-09-08 13:59:${59 - index}`, detail: pickup && index === count - 1 ? "快件已揽收" : "Carrier event",
      statusCode: index === 0 ? semantic : "", raw: {} })),
  };
}
function seed(semantic: TimelinePackage["semantic"] = "UNKNOWN", provider = "JingDong") {
  const feed = pack("interface5", semantic, 3, true);
  const row: Shipment = { identity: { id: "interface5:account:361000000000001", sourceId: "361000000000001",
    orderId: provider === "JingDong" ? "361000000000001" : "", accountOrder: provider === "JingDong",
    projectedWaybill: provider === "JingDong" ? waybill : "",
    bindingSource: "interface5", sourceProvider: provider, sourceOwner: "account", manuallyAdded: false,
    phone: "13800001234", phoneTail: "1234", courierCode: "JD", rawCourierCode: "JD", companyName: "JD",
    createdAtMs: NOW - 86400000 }, timeline: feed, sourceTimeline: feed,
    manualTimelines: [pack("v5_query", semantic, 6, true)], accountRecord: null, updatedAtMs: NOW };
  return saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: "13800001234", boundAtMs: NOW - 86400000 },
  ] }, NOW);
}
const failures: string[] = [];
try {
  for (const trigger of ["detail_pull"] as const) {
  for (const scenario of ["richer-fallback", "summary-status", "cached-summary-status", "known-status", "all-errors"] as const) {
    try {
      memory.clear();
      setDiagnosticsEnabled(true);
      let state = seed(scenario === "known-status" ? "DELIVERY" : "UNKNOWN");
      if (scenario === "cached-summary-status") {
        const row = state.shipments[0]!;
        state = saveState({ ...state, shipments: [{ ...row,
          manualTimelines: [...row.manualTimelines!, pack("kdniao", "UNKNOWN", 2)],
        }] }, NOW);
      }
      const original = state.shipments[0]!;
      const originalDetail = selectShipmentDetailTimeline(original);
      assert.equal(shipmentDetailComplete(original), scenario === "known-status",
        "history with an unknown overall status cannot prove latest-node consistency");
      const calls: string[] = [];
      const result = await runShipmentRefreshForTesting(original.identity.id,
        { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
        { trigger, includeKdniaoFallback: true }, {
          refreshAccountParcel: async () => { calls.push("account"); return null; },
          refreshWebTimeline: async () => null,
          queryManualForSource: async (input) => {
            const provider = input.pickerOnly ? "v6_query" : input.fallbackOnly ? "kdniao" : "v4_query";
            calls.push(provider);
            assert.equal(input.phoneTail, "1234");
            assert.ok((input.deadlineAtMs || 0) <= NOW + 30000);
            if (scenario === "all-errors") return queryManualForSource({ ...input,
              dependencies: { post: async () => { throw new GatewayError("synthetic provider failure", 502); } },
            });
            if ((scenario === "summary-status" || scenario === "cached-summary-status") && provider === "kdniao") {
              const outcome = await queryManualForSource({ ...input,
                dependencies: { post: async () => ({ success: true, logisticCode: waybill,
                  shipperCode: "JD", stateEx: "301", traces: [] }) },
              });
              assert.equal(outcome.shipment?.timeline.structuredStatus, true);
              assert.equal(outcome.shipment?.timeline.semantic, "COMPLETED");
              const sourceLog = readDiagnostics().find((entry) => entry.event === "manual.source.succeeded" &&
                entry.details.timelineProvider === "kdniao" && entry.details.flowId === input.diagnosticFlowId);
              assert.equal(sourceLog?.details.statusSemantic, "COMPLETED");
              assert.equal(sourceLog?.details.structuredStatus, true);
              assert.equal(sourceLog?.details.result, "status_only");
              return outcome;
            }
            const value = provider === "kdniao"
              ? pack(provider, "COMPLETED", scenario === "richer-fallback" ? 10 : 1, scenario === "richer-fallback")
              : null;
            return { shipment: value ? { ...original, timeline: value, sourceTimeline: null,
              manualTimelines: [value] } : null, pending: null, routeUrl: "" };
          },
        });
      if (scenario === "known-status") {
        assert.deepEqual(calls, [], "a complete history with known status still skips providers");
      } else if (scenario === "all-errors") {
        assert.deepEqual(calls, ["kdniao"]);
        assert.equal(result.shipment.timeline.semantic, "UNKNOWN");
      } else {
        assert.deepEqual(calls, ["kdniao"],
          "status supplementation follows the existing JD provider permissions and stops on a valid status");
        assert.equal(result.shipment.timeline.semantic, "COMPLETED");
        assert.equal(result.shipment.timeline.statusEventAtMs, (scenario === "summary-status" || scenario === "cached-summary-status") ? null : NOW - 1000);
        assert.equal(loadState(NOW + 1).shipments[0]?.timeline.semantic, "COMPLETED");
      }
      if (scenario === "richer-fallback") {
        assert.equal(selectShipmentDetailTimeline(result.shipment).provider, originalDetail.provider,
          "missing node enums do not disqualify otherwise complete sticky history after status repair");
        assert.equal(result.shipment.manualTimelines?.find(p => p.provider === "kdniao")?.semantic, "COMPLETED",
          "the successful status source remains available in its own slot");
        assert.equal(shipmentDetailComplete(result.shipment), true);
        assert.deepEqual(result.shipment.manualTimelines?.find(p => p.provider === originalDetail.provider)?.tracks,
          originalDetail.tracks, "the previous provider's history remains in its own slot");
      } else {
        assert.deepEqual(selectShipmentDetailTimeline(result.shipment).tracks, originalDetail.tracks,
          "status-only supplementation retains the selected history without manufacturing a signed node");
        assert.equal(selectShipmentDetailTimeline(result.shipment).provider, originalDetail.provider);
      }
    } catch (error) {
      failures.push(`${scenario}: ${String(error)}`);
    }
  }
  }
  for (const trigger of ["detail_pull"] as const) {
    try {
      memory.clear();
      const seeded = seed();
      const row = seeded.shipments[0]!;
      const state = saveState({ ...seeded, shipments: [{ ...row, manualTimelines: [{
        ...pack("v5_query", "COMPLETED", 6, true), structuredStatus: false,
      }] }] }, NOW);
      const original = state.shipments[0]!;
      const originalDetail = selectShipmentDetailTimeline(original);
      assert.equal(selectShipmentTimeline(original).semantic, "UNKNOWN");
      assert.equal(originalDetail.semantic, "UNKNOWN", "unstructured query prose cannot provide account status");
      assert.equal(originalDetail.structuredStatus, false);
      assert.equal(shipmentDetailComplete(original), false, "the unknown Home status cannot be proved by a legacy detail scalar");
      const calls: string[] = [];
      const result = await runShipmentRefreshForTesting(original.identity.id,
        { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
        { trigger, includeKdniaoFallback: true }, {
          refreshWebTimeline: async () => null,
          queryManualForSource: async (input) => {
            const provider = input.pickerOnly ? "v6_query" : "kdniao";
            calls.push(provider);
            const value = provider === "kdniao" ? pack(provider, "COMPLETED", 1) : null;
            return { shipment: value ? { ...original, timeline: value, sourceTimeline: null,
              manualTimelines: [value] } : null, pending: null, routeUrl: "" };
          },
        });
      assert.deepEqual(calls, ["kdniao"],
        "a legacy detail semantic without structured evidence cannot suppress missing Home status repair");
      assert.equal(selectShipmentTimeline(result.shipment).semantic, "COMPLETED");
      assert.equal(selectShipmentTimeline(loadState(NOW + 1).shipments[0]!).semantic, "COMPLETED");
      assert.deepEqual(selectShipmentDetailTimeline(result.shipment).tracks, originalDetail.tracks);
    } catch (error) { failures.push(`unusable detail status (${trigger}): ${String(error)}`); }
  }
  for (const provider of ["CaiNiao", "ShunFeng"]) {
    try {
      memory.clear();
      const state = seed("UNKNOWN", provider);
      const original = state.shipments[0]!;
      const calls: string[] = [];
      const result = await runShipmentRefreshForTesting(original.identity.id,
        { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
        { trigger: "detail_pull", includeKdniaoFallback: true }, {
          refreshWebTimeline: async () => null,
          queryManualForSource: async (input) => {
            const source = input.pickerOnly ? "v6_query" : input.motoOnly ? "v4_query" : "kdniao";
            calls.push(source);
            const value = source === "v6_query" ? pack(source, "UNKNOWN", 1, true)
              : pack(source, "COMPLETED", 1);
            return { shipment: { ...original, timeline: value, sourceTimeline: null,
              manualTimelines: [value] }, pending: null, routeUrl: "" };
          },
        });
      assert.deepEqual(calls, [provider === "ShunFeng" ? "kdniao" : "v4_query"]);
      assert.equal(result.shipment.timeline.semantic, "COMPLETED");
    } catch (error) { failures.push(`${provider}: ${String(error)}`); }
  }
  try {
    memory.clear();
    const state = seed();
    const original = state.shipments[0]!;
    const abort = new AbortController();
    let finish!: (value: any) => void;
    const work = runShipmentRefreshForTesting(original.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30000, signal: abort.signal },
      { trigger: "detail_pull", includeKdniaoFallback: true }, {
        refreshWebTimeline: async () => null,
        queryManualForSource: () => new Promise((resolve) => { finish = resolve; }),
      });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(finish);
    abort.abort();
    const value = pack("kdniao", "COMPLETED", 1);
    finish({ shipment: { ...original, timeline: value, manualTimelines: [value] }, pending: null, routeUrl: "" });
    await assert.rejects(work);
    assert.equal(loadState(NOW + 1).shipments[0]?.timeline.semantic, "UNKNOWN",
      "cancelled status repair cannot publish a late provider result");
  } catch (error) { failures.push(`cancellation: ${String(error)}`); }
} finally {
  Date.now = actualNow;
}
assert.equal(failures.length, 0, failures.join("\n"));
console.log("missing status explicit refresh tests passed");
