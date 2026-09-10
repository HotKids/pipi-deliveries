import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import type { Shipment, TimelinePackage } from "../models";
import * as policy from "../services/shipment-policy";
import * as status from "../services/status";
import { runManualDetailSourceContest } from "../services/manual-detail-refresh";

const NOW = Date.UTC(2026, 8, 8, 10);
function timeline(provider: string, detail = "快件运输中", offset = 0): TimelinePackage {
  return { provider, complete: false, waybill: "SYNTHETIC123456", courierCode: "ZTO",
    companyName: "Test carrier", semantic: "TRANSIT", statusEventAtMs: NOW + offset,
    latestTimeText: "2026-09-08 10:00:00", latestDetail: detail, successAtMs: NOW,
    tracks: [{ timeText: "2026-09-08 10:00:00", timeMs: NOW + offset,
      detail, statusCode: "", raw: {} }] };
}
function shipment(kind = "manual", detail = "快件运输中"): Shipment {
  const owner = kind === "manual" ? null : timeline("interface5", detail);
  const selected = owner || timeline("v6_query", detail);
  return { identity: { id: "synthetic-parcel", bindingSource: "interface5",
    sourceOwner: kind === "manual" ? "manual" : "account", sourceId: "SYNTHETIC123456",
    sourceProvider: kind === "sf" ? "ShunFeng" : "DouYin", phoneTail: "1234",
    courierCode: "ZTO", rawCourierCode: "ZTO", companyName: "Test carrier",
    manuallyAdded: kind === "manual", createdAtMs: NOW }, timeline: selected,
    sourceTimeline: owner, manualTimelines: owner ? [] : [selected], updatedAtMs: NOW };
}

// Run the actual detail enrichment branch; only network/host seams are synthetic.
const source = readFileSync(new URL("../services/sync.ts", import.meta.url), "utf8");
const start = source.indexOf("      const ordinaryAutomaticSupplementRequested =");
const end = source.indexOf("      h5Result = rejectForeignManualResult", start);
assert.ok(start > 0 && end > start);
const branch = stripTypeScriptTypes(source.slice(start, end));
const supplementStart = source.indexOf("  const usableManualSupplement =");
const supplementEnd = source.indexOf("  let completedSourceQuery", supplementStart);
assert.ok(supplementStart > 0 && supplementEnd > supplementStart);
const supplementCheck = stripTypeScriptTypes(source.slice(supplementStart, supplementEnd));
async function detailRound(seed: Shipment, pickerDetail: string | null) {
  const calls: string[] = [];
  const explicit = !policy.shipmentDetailComplete(seed);
  const context = { ...policy, ...status, runManualDetailSourceContest,
    seed, calls, source: "interface5", sourceBindings: [], flowId: "synthetic",
    onQueryAttempted: () => {},
    explicitTimelineRefresh: explicit, detailComplete: !explicit,
    missingStatusRefresh: false, lacksStatus: () => false,
    requestedKuaidi100Timeline: explicit && (seed.identity.manuallyAdded ||
      policy.isShunFengSourceShipment(seed)), requestedJingDongDetailSupplement: false,
    jingDongManualFallbackRequested: false, cainiaoManualFallbackRequested: false,
    deadlineAtMs: undefined, signal: undefined, options: { includeKdniaoFallback: true },
    DETAIL_MANUAL_REFRESH_BUDGET_MS: 15_000, ACCOUNT_H5_BUDGET_MS: 8_000,
    TIMELINE_SLOT: { V6_QUERY: "v6_query", K100_H5: "k100_h5" },
    Date, accountChildDeadline: () => undefined, stageBudgetMs: () => 0,
    deadlineExpired: () => false, assertRefreshSignal: () => {}, writeDiagnostic: () => {},
    rethrowRefreshCancellation: () => {}, rejectForeignManualResult: (_owner: any, value: any) => value,
    refreshWebTimeline: async () => { calls.push("h5"); return null; },
    queryManualForSource: async (input: any) => {
      const provider = input.pickerOnly ? "picker" : input.motoOnly ? "moto" : "kdniao";
      calls.push(provider);
      const result = provider === "picker" && pickerDetail
        ? { ...shipment(), timeline: timeline("v6_query", pickerDetail, 60_000),
          manualTimelines: [timeline("v6_query", pickerDetail, 60_000)] }
        : null;
      return { shipment: result, routeUrl: "https://m.kuaidi100.com/synthetic" };
    },
  };
  await runInNewContext(`(async () => {
    const runtime = { queryManualForSource };
    ${supplementCheck}
    let enrichmentBase = seed, refreshed = seed, changed = false, stage = "";
    let webDiagnostics = null;
    ${branch}
  })()`, context);
  return calls;
}

const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); } catch (error) { failures.push(`${name}: ${String(error)}`); }
}
await check("automatic ORDERED still refreshes Picker", () => {
  assert.equal(policy.needsAutomaticManualFallback(shipment("automatic", "订单已提交")), true);
});
await check("generic complete bit cannot replace feed pickup evidence", () => {
  const seed = shipment("automatic");
  seed.sourceTimeline = { ...seed.sourceTimeline!, complete: true };
  assert.equal(policy.needsAutomaticManualFallback(seed), true);
});
await check("automatic PICKED stops before Picker", async () => {
  assert.deepEqual(await detailRound(shipment("automatic", "快件已揽收"), null), []);
});
for (const kind of ["manual", "sf", "automatic"]) {
  await check(`${kind} Picker first and stop on returned origin`, async () => {
    assert.deepEqual(await detailRound(shipment(kind), "订单已提交"), ["picker"]);
  });
  await check(`${kind} missing Picker origin allows the primary round`, async () => {
    const calls = await detailRound(shipment(kind), "快件运输中");
    assert.equal(calls[0], "picker");
    assert.ok(calls.includes("h5"));
    assert.equal(calls.includes("moto"), kind !== "sf");
  });
}
await check("old Picker origin merges before stopping primary", async () => {
  const seed = shipment("automatic");
  seed.manualTimelines = [timeline("v6_query", "订单已提交", -60_000)];
  assert.deepEqual(await detailRound(seed, "快件运输中"), ["picker"]);
});
await check("feed origin cannot impersonate the Picker origin", async () => {
  const calls = await detailRound(shipment("automatic", "订单已提交"), "快件运输中");
  assert.equal(calls[0], "picker");
  assert.ok(calls.includes("moto"));
});
await check("complete preferred detail remains frozen", async () => {
  const seed = shipment("manual", "快件已揽收");
  seed.timeline.semantic = "COMPLETED";
  assert.deepEqual(await detailRound(seed, "快件运输中"), []);
});
const jdGate = source.match(/const jingDongManualFallbackRequested =([\s\S]*?);/)?.[1];
assert.ok(jdGate);
await check("JD gate uses own feed pickup or a proven complete H5 package", () => {
  const seed = shipment("automatic");
  seed.identity.sourceProvider = "JingDong";
  seed.identity.accountOrder = true;
  seed.identity.sourceId = "ORDER123456";
  seed.identity.projectedWaybill = "SYNTHETIC123456";
  for (const [feedDetail, h5Complete, expected] of [
    ["订单已提交", false, true],
    ["快件已揽收", false, false],
    ["快件运输中", true, false],
  ] as const) {
    seed.sourceTimeline = timeline("interface5", feedDetail);
    seed.manualTimelines = [{ ...timeline("jd_h5", "快件已揽收"), complete: h5Complete }];
    assert.equal(runInNewContext(jdGate, { ...policy, ...status,
      enrichmentBase: seed, requestedJingDongDetailSupplement: true,
      jingDongAutomaticH5Available: policy.jingDongAutomaticH5TimelineAvailable(seed),
    }), expected);
  }
});
assert.equal(failures.length, 0, failures.join("\n"));
console.log("detail Picker gate tests passed");
