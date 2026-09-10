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
      statusCode: "", raw: {} })),
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
  for (const trigger of ["detail_open", "detail_pull"] as const) {
  for (const scenario of ["empty-picker", "picker-origin-only", "picker-status", "richer-fallback", "summary-status", "cached-summary-status", "known-status", "all-errors"] as const) {
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
      assert.equal(shipmentDetailComplete(original), true, "the real fault starts with a complete history");
      const calls: string[] = [];
      const result = await runShipmentRefreshForTesting(original.identity.id,
        { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
        { trigger, includeKdniaoFallback: true }, {
          refreshAccountParcel: async () => { calls.push("account"); return null; },
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
            const value = provider === "kdniao" || scenario === "picker-status"
              ? pack(provider, "COMPLETED", scenario === "richer-fallback" ? 10 : 1, scenario === "richer-fallback")
              : scenario === "picker-origin-only" ? pack(provider, "UNKNOWN", 1, true) : null;
            return { shipment: value ? { ...original, timeline: value, sourceTimeline: null,
              manualTimelines: [value] } : null, pending: null, routeUrl: "" };
          },
        });
      if (scenario === "known-status") {
        assert.deepEqual(calls, [], "a complete history with known status still skips providers");
      } else if (scenario === "all-errors") {
        assert.deepEqual(calls, ["v6_query", "kdniao"]);
        assert.equal(result.shipment.timeline.semantic, "UNKNOWN");
      } else {
        assert.deepEqual(calls, scenario === "picker-status" ? ["v6_query"] : ["v6_query", "kdniao"],
          "status supplementation follows the existing JD provider permissions and stops on a valid status");
        assert.equal(result.shipment.timeline.semantic, "COMPLETED");
        assert.equal(result.shipment.timeline.statusEventAtMs, (scenario === "summary-status" || scenario === "cached-summary-status") ? null : NOW - 1000);
        assert.equal(loadState(NOW + 1).shipments[0]?.timeline.semantic, "COMPLETED");
      }
      assert.deepEqual(selectShipmentDetailTimeline(result.shipment).tracks, originalDetail.tracks,
        "status-only supplementation cannot replace the complete selected history");
      assert.equal(selectShipmentDetailTimeline(result.shipment).provider, originalDetail.provider);
    } catch (error) {
      failures.push(`${scenario}: ${String(error)}`);
    }
  }
  }
  try {
    memory.clear();
    const state = seed();
    const original = state.shipments[0]!;
    const originalDetail = selectShipmentDetailTimeline(original);
    const calls: string[] = [];
    const result = await runShipmentRefreshForTesting(original.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
      { trigger: "identity_projection", forceAccountOrderProjection: true, includeKdniaoFallback: true }, {
        queryManualForSource: async (input) => {
          const provider = input.pickerOnly ? "v6_query" : "kdniao";
          calls.push(provider);
          const value = provider === "kdniao" ? pack(provider, "COMPLETED", 1) : null;
          return { shipment: value ? { ...original, timeline: value, sourceTimeline: null,
            manualTimelines: [value] } : null, pending: null, routeUrl: "" };
        },
      });
    assert.deepEqual(calls, ["v6_query", "kdniao"],
      "detail opened before projection must still repair missing status after the full refresh projects it");
    assert.equal(result.shipment.timeline.semantic, "COMPLETED");
    assert.deepEqual(selectShipmentDetailTimeline(result.shipment).tracks, originalDetail.tracks);
  } catch (error) { failures.push(`projection completed while waiting: ${String(error)}`); }
  for (const trigger of ["detail_open", "detail_pull", "identity_projection"] as const) {
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
      assert.equal(originalDetail.semantic, "COMPLETED");
      assert.equal(originalDetail.structuredStatus, false);
      assert.equal(shipmentDetailComplete(original), true);
      const calls: string[] = [];
      const result = await runShipmentRefreshForTesting(original.identity.id,
        { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
        { trigger, includeKdniaoFallback: true }, {
          queryManualForSource: async (input) => {
            const provider = input.pickerOnly ? "v6_query" : "kdniao";
            calls.push(provider);
            const value = provider === "kdniao" ? pack(provider, "COMPLETED", 1) : null;
            return { shipment: value ? { ...original, timeline: value, sourceTimeline: null,
              manualTimelines: [value] } : null, pending: null, routeUrl: "" };
          },
        });
      assert.deepEqual(calls, ["v6_query", "kdniao"],
        "a legacy detail semantic without structured evidence cannot suppress missing Home status repair");
      assert.equal(selectShipmentTimeline(result.shipment).semantic, "COMPLETED");
      assert.equal(selectShipmentTimeline(loadState(NOW + 1).shipments[0]!).semantic, "COMPLETED");
      assert.deepEqual(selectShipmentDetailTimeline(result.shipment).tracks, originalDetail.tracks);
    } catch (error) { failures.push(`unusable detail status (${trigger}): ${String(error)}`); }
  }
  for (const provider of ["DouYin", "ShunFeng"]) {
    try {
      memory.clear();
      const state = seed("UNKNOWN", provider);
      const original = state.shipments[0]!;
      const calls: string[] = [];
      const result = await runShipmentRefreshForTesting(original.identity.id,
        { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
        { trigger: "detail_open", includeKdniaoFallback: true }, {
          queryManualForSource: async (input) => {
            const source = input.pickerOnly ? "v6_query" : input.motoOnly ? "v4_query" : "kdniao";
            calls.push(source);
            const value = source === "v6_query" ? pack(source, "UNKNOWN", 1, true)
              : pack(source, "COMPLETED", 1);
            return { shipment: { ...original, timeline: value, sourceTimeline: null,
              manualTimelines: [value] }, pending: null, routeUrl: "" };
          },
        });
      assert.deepEqual(calls, ["v6_query", provider === "ShunFeng" ? "kdniao" : "v4_query"]);
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
      { trigger: "detail_open", includeKdniaoFallback: true }, {
        queryManualForSource: () => new Promise((resolve) => { finish = resolve; }),
      });
    assert.ok(finish);
    abort.abort();
    const value = pack("v6_query", "COMPLETED", 1);
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
