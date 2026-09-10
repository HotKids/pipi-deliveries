import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { emptyState, saveState, loadState, commitRefreshState, removeBinding } from "../services/storage";
import { runShipmentEnrichmentForTesting, runMissingShipmentHistoriesForTesting,
  runShipmentRefreshForTesting } from "../services/sync";
import type { AccountParcelDto } from "../services/account-parser";
import { queryManualForSource } from "../services/manual-query";
import { selectShipmentTimeline, needsAutomaticListSupplement } from "../services/shipment-policy";

const waybill = "SF123456789012";
const phone = "13800001234";
function pack(semantic: TimelinePackage["semantic"], count: number, provider = "interface5"): TimelinePackage {
  return { provider, waybill, courierCode: "SF", companyName: "Carrier", semantic,
    structuredStatus: semantic !== "UNKNOWN", statusEventAtMs: semantic === "UNKNOWN" ? null : NOW - 60_000,
    latestDetail: "Source headline without a date", latestTimeText: "", successAtMs: NOW - 60_000,
    complete: count > 1,
    tracks: Array.from({ length: count }, (_, index) => ({ timeMs: NOW - 60_000 - index * 1000,
      timeText: "2026-09-08 13:59:00", detail: index ? "已揽收" : "Parcel event", statusCode: "", raw: {} })) };
}
function row(provider = "JingDong", semantic: TimelinePackage["semantic"] = "UNKNOWN", count = 3): Shipment {
  const timeline = pack(semantic, count);
  return { identity: { id: `interface5:account:${waybill}`, sourceId: waybill, sourceOwner: "interface5:parcel",
    sourceProvider: provider, bindingSource: "interface5", phone, phoneTail: "1234", manuallyAdded: false,
    courierCode: "SF", rawCourierCode: "SF", companyName: "Carrier", createdAtMs: NOW - 86_400_000 },
    timeline, sourceTimeline: timeline, manualTimelines: [], accountRecord: null, updatedAtMs: NOW - 60_000 };
}

function nativeParcel(owner: Shipment, semantic: TimelinePackage["semantic"], count: number): AccountParcelDto {
  const timeline = pack(semantic, count);
  return { source: "interface5", ownerId: owner.identity.sourceId, accountOrder: false,
    waybill, courierCode: "SF", rawCourierCode: "SF", companyName: "Carrier", rawCompanyName: "Carrier",
    carrierNormalization: null, sourceProvider: owner.identity.sourceProvider!,
    sourceStateCode: semantic === "COMPLETED" ? "107" : semantic === "UNKNOWN" ? "" : "104",
    sourceStateText: semantic === "COMPLETED" ? "已签收" : semantic === "UNKNOWN" ? "" : "运输中",
    semantic, normalizedStatusScope: "SHIPMENT", normalizedStatusSemantic: semantic,
    normalizedStatusText: semantic, receiverPhone: phone, senderPhone: "", routeUrl: "", projectionUrl: "",
    latestDetail: count ? "Native detail event" : "", latestTimeText: count ? "2026-09-08 14:00:00" : "",
    tracks: timeline.tracks.map((track, index) => ({ ...track, timeMs: NOW - index * 1000,
      detail: index ? "已揽收" : "Native detail event" })) };
}
function attachRecord(owner: Shipment) {
  owner.accountRecord = { waybill, companyCode: "SF", name: "Carrier", provider: owner.identity.sourceProvider!,
    phone, channel: "account" };
}
function seed(owner: Shipment) {
  memory.clear();
  return saveState({ ...emptyState(), shipments: [owner], bindings: [
    { source: "interface5", phone, boundAtMs: NOW - 86_400_000 },
  ] }, NOW);
}

const realNow = Date.now;
Date.now = () => NOW;
Object.assign(globalThis, {
  WebViewController: class { constructor() { assert.fail("automatic list supplementation must not create an H5 loader"); } },
  fetch: () => { assert.fail("automatic list supplementation must not call a direct provider"); },
});
try {
  for (const provider of ["JingDong", "CaiNiao", "DouYin"]) {
  for (const background of [true, false]) {
    for (const scenario of ["unknown with history", "known with zero timed tracks", "known with one timed track",
      "empty feed with complete manual cache", "forced", "signed", "hidden", "active lease", "recent attempt",
      "order number only", "unbound", "non-v5", "SF normal"] as const) {
      memory.clear();
      const source = scenario === "non-v5" ? "interface6" : "interface5";
      const owner = row(scenario === "SF normal" ? "ShunFeng" : provider,
        ["known with zero timed tracks", "known with one timed track", "SF normal"].includes(scenario) ? "TRANSIT" : "UNKNOWN",
        scenario === "known with zero timed tracks" ? 0 : scenario === "known with one timed track" ? 1 : 3);
      if (scenario === "empty feed with complete manual cache") {
        owner.timeline = pack("UNKNOWN", 0);
        owner.sourceTimeline = owner.timeline;
        owner.manualTimelines = [pack("TRANSIT", 5, "v6_query")];
      }
      if (scenario === "forced") owner.forcedCompletedAtMs = NOW - 60_000;
      if (scenario === "signed") { owner.timeline = pack("COMPLETED", 3); owner.sourceTimeline = owner.timeline; }
      if (scenario === "hidden") owner.emptyTimelineHiddenAtMs = NOW - 60_000;
      if (scenario === "recent attempt") owner.manualRefreshAttemptAtMs = NOW - 1000;
      if (scenario === "active lease") owner.manualRefreshLease = { attemptId: "active", startedAtMs: NOW - 1000, expiresAtMs: NOW + 30_000 };
      if (scenario === "order number only") owner.identity = { ...owner.identity, sourceId: "361000000000001", orderId: "361000000000001", accountOrder: true };
      if (scenario === "non-v5") owner.identity = { ...owner.identity, bindingSource: source };
      let current = saveState({ ...emptyState(), shipments: [owner], bindings: scenario === "unbound" ? [] : [
        { source, phone, boundAtMs: NOW - 86_400_000 },
      ] }, NOW);
      const payloads: Record<string, unknown>[] = [];
      await runShipmentEnrichmentForTesting(current, source, "automatic-list-supplement", (candidate, _routes, _stage, base) => {
        const result = commitRefreshState(base || current, candidate, source, NOW);
        assert.equal(result.applied, true);
        return current = result.state;
      }, NOW + 60_000, new Set(), false, !background, undefined, {
        refreshAccountParcel: async () => { assert.fail("these predicate fixtures have no native detail record"); },
        queryManualForSource: async input => {
          assert.equal(input.pickerOnly, true, "list exceptions do not open the rest of the manual chain");
          assert.equal(input.includeKdniaoFallback, false);
          assert.equal(input.hostSafe, true);
          return queryManualForSource({ ...input, dependencies: { now: () => NOW, post: async (route, payload) => {
            assert.equal(route, "/api/express/timeline/source");
            assert.deepEqual(payload, { interface: "v6", mode: "refresh", waybill });
            payloads.push(payload);
            return { code: 200, value: { mailNo: waybill, cpCode: "SF", cpName: "Carrier",
              status: "TRANSIT", logisticsGmtModified: "2026-09-08 14:00:00",
              lastLogisticDetail: "New Online event" }, redirect: "" };
          } } });
        },
      });
      const expected = ["unknown with history", "known with zero timed tracks", "SF normal"].includes(scenario) ? 1 : 0;
      assert.equal(payloads.length, expected, `${provider} ${background ? "background" : "foreground"}: ${scenario}`);
      if (expected) {
        assert.ok(loadState(NOW).shipments[0]?.manualTimelines?.some(t => t.provider === "v6_query"));
        const selected = selectShipmentTimeline(loadState(NOW).shipments[0]!);
        if (scenario === "known with zero timed tracks") {
          assert.equal(selected.tracks.length, 1, `${provider}: persisted Online history fills the empty list`);
          assert.equal(needsAutomaticListSupplement(loadState(NOW).shipments[0]!), false,
            "a text-only source headline plus the persisted timed package closes the list gap");
          assert.equal(selected.latestDetail, owner.timeline.latestDetail, "existing feed headline remains owned");
          assert.equal(selected.statusEventAtMs, owner.timeline.statusEventAtMs, "existing status time remains owned");
        }
        assert.equal(selected.semantic,
          scenario === "unknown with history" ? "UNKNOWN" : "TRANSIT",
          "an unstructured Online scalar cannot invent missing structured source status");
      }
    }
  }
  }
  for (const outcome of ["native fills gap", "native still unknown", "native empty", "unbound during native"] as const) {
    const owner = row("JingDong", outcome === "native empty" ? "TRANSIT" : "UNKNOWN", outcome === "native empty" ? 0 : 3);
    attachRecord(owner);
    let current = seed(owner);
    const calls: string[] = [];
    await runShipmentEnrichmentForTesting(current, "interface5", "native-before-supplement", (candidate, _routes, _stage, base) => {
      const committed = commitRefreshState(base || current, candidate, "interface5", NOW);
      assert.equal(committed.applied, true);
      return current = committed.state;
    }, NOW + 60_000, new Set(), false, false, undefined, {
      refreshAccountParcel: async input => {
        calls.push("native");
        if (outcome === "unbound during native") { removeBinding("interface5", phone, NOW); return null; }
        return nativeParcel(input, outcome === "native fills gap" ? "TRANSIT" : outcome === "native empty" ? "TRANSIT" : "UNKNOWN",
          outcome === "native empty" ? 0 : 3);
      },
      queryManualForSource: async input => {
        calls.push("online");
        assert.equal(input.pickerOnly, true);
        assert.equal(input.includeKdniaoFallback, false);
        const persisted = loadState(NOW).shipments[0]!;
        if (outcome === "native still unknown") assert.ok(persisted.manualTimelines?.some(pack => pack.provider === "v5_query"),
          "Online must observe its own native result after the durable checkpoint");
        return { shipment: null, pending: null, routeUrl: "" };
      },
    });
    assert.deepEqual(calls, outcome === "native fills gap" || outcome === "unbound during native" ? ["native"] : ["native", "online"], outcome);
  }

  // A signed automatic row stays frozen in both list paths; explicit incomplete detail still writes back.
  {
    const owner = row("JingDong", "COMPLETED", 0);
    owner.timeline.latestDetail = "";
    attachRecord(owner);
    let current = seed(owner);
    let nativeCalls = 0;
    const runtime = {
      refreshAccountParcel: async (input: Shipment, _deadline?: number, _signal?: AbortSignal, started?: (allowed: boolean) => void) => {
        started?.(true); nativeCalls++;
        return nativeParcel(input, "COMPLETED", 3);
      },
      queryManualForSource: async () => { assert.fail("native complete history must not open another provider"); },
    };
    await runShipmentEnrichmentForTesting(current, "interface5", "signed-list", candidate => current = candidate,
      NOW + 60_000, new Set(), true, true, undefined, runtime);
    const list = await runMissingShipmentHistoriesForTesting(current, "interface5", candidate => current = candidate,
      NOW + 60_000, undefined, (id, options) => runShipmentRefreshForTesting(id,
        { isCurrent: () => true, deadlineAtMs: NOW + 30_000 }, options, runtime));
    assert.equal(list.attempted, 0);
    assert.equal(nativeCalls, 0, "signed list refresh remains frozen even with no tracks");
    assert.equal(loadState(NOW).shipments[0]!.emptyTimelineHiddenAtMs, undefined);
    const detail = await runShipmentRefreshForTesting(owner.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30_000 }, { trigger: "detail_pull", includeKdniaoFallback: true }, runtime);
    assert.equal(nativeCalls, 1);
    assert.equal(detail.refreshed, true);
    const saved = loadState(NOW).shipments[0]!;
    assert.equal(saved.sourceTimeline!.tracks.length, 0, "detail history stays in its own source slot");
    assert.equal(selectShipmentTimeline(saved).tracks.length, 3, "the list reads the explicit detail commit");
    assert.equal(selectShipmentTimeline(saved).semantic, "COMPLETED");
  }

  for (const provider of ["JingDong", "CaiNiao", "DouYin"]) {
    const owner = row(provider, "UNKNOWN", 3);
    const before = seed(owner);
    let calls = 0;
    const detail = await runShipmentRefreshForTesting(owner.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30_000 }, { trigger: "detail_pull", includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { assert.fail("no source record in this status-only fixture"); },
        queryManualForSource: async input => {
          calls++;
          assert.equal(input.pickerOnly, true);
          const timeline = pack("DELIVERY", 3, "v6_query");
          return { shipment: { ...input.currentShipment!, timeline, manualTimelines: [timeline] }, pending: null, routeUrl: "" };
        },
      });
    assert.equal(calls, 1);
    assert.equal(detail.refreshed, true);
    const saved = loadState(NOW).shipments[0]!;
    assert.equal(selectShipmentTimeline(saved).semantic, "DELIVERY", `${provider}: accepted structured detail status fills missing list status`);
    assert.deepEqual(saved.sourceTimeline, before.shipments[0]!.sourceTimeline, "detail does not rewrite the original feed packet");
    assert.deepEqual(selectShipmentTimeline(saved).tracks, before.shipments[0]!.sourceTimeline!.tracks,
      "existing feed history is not replaced by non-SF manual history");
    assert.equal(needsAutomaticListSupplement(saved), false, "a repaired cache does not repeat list supplementation");
  }
} finally { Date.now = realNow; }
console.log("Automatic v5 list Online-only missing-information tests passed");
