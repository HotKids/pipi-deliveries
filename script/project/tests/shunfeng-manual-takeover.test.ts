import assert from "node:assert/strict";
import "./k100-html-fetch-mock";
import type { Shipment, TimelinePackage } from "../models";
import { memory, NOW } from "./state-storage-mock";
import { commitRefreshState, emptyState, loadState, saveState } from "../services/storage";
import { runShipmentEnrichmentForTesting, runShipmentRefreshForTesting } from "../services/sync";
import { readDiagnostics, setDiagnosticsEnabled } from "../services/logger";
import { hasCachedTimelineBeforeKdniao, hasTimelineStartBeforeKdniao,
  needsDetailFallback, selectShipmentDetailTimeline, selectShipmentTimeline } from "../services/shipment-policy";

const waybill = "SF123456789012";
const oldAt = NOW - 24 * 60 * 60_000;
function pack(provider: string, count: number, at: number, pickup = false): TimelinePackage {
  return { provider, waybill, courierCode: "SF", companyName: "顺丰速运",
    semantic: "TRANSIT", structuredStatus: true, statusEventAtMs: at,
    complete: provider === "cn_h5" || provider === "kdniao",
    latestTimeText: String(at), latestDetail: "Parcel in transit", successAtMs: NOW,
    tracks: Array.from({ length: count }, (_, i) => ({ timeMs: at - i * 60_000,
      timeText: String(at - i * 60_000), statusCode: "", raw: {},
      detail: pickup && i === count - 1 ? "顺丰速运 已收取快件" : `Parcel passed facility ${i}` })),
  };
}
function seed(sourceProvider = "ShunFeng"): Shipment {
  const source = pack("interface5", 1, oldAt, true);
  return { identity: { id: `interface5:account:${waybill}`, sourceId: waybill,
    bindingSource: "interface5", sourceOwner: "interface5:parcel", sourceProvider,
    courierCode: "SF", rawCourierCode: "SF", companyName: "顺丰速运", phone: "13800001234",
    phoneTail: "1234", manuallyAdded: false, createdAtMs: oldAt - 24 * 60 * 60_000 },
    timeline: source, sourceTimeline: source,
    manualTimelines: [pack("v5_query", 5, oldAt, true), pack("cn_h5", 2, oldAt, true)],
    updatedAtMs: NOW, detailSelection: { provider: "v5_query", selectedAtMs: oldAt },
    accountRecord: { waybill, companyCode: "SF", provider: sourceProvider, phone: "13800001234", stateNumber: 2 },
  };
}

const actualNow = Date.now;
let now = NOW;
Date.now = () => now;
try {
  for (const response of ["complete", "partial", "no-result"] as const) {
    memory.clear();
    setDiagnosticsEnabled(true);
    now = NOW;
    const original = saveState({ ...emptyState(), shipments: [seed()], bindings: [
      { source: "interface5", phone: "13800001234", boundAtMs: oldAt },
    ] }, now).shipments[0]!;
    const calls: string[] = [];
    // Drive the real H5 scraper through its finite deadline without waiting eight wall-clock seconds.
    Object.assign(globalThis, { WebViewController: class {
      async loadHTML(_html: string, url: string) {
        assert.equal(url, `https://m.kuaidi100.com/app/query/?nu=${waybill}`,
          "the K100 stage uses the actual waybill, never the Picker-returned or cached URL");
        calls.push("k100_h5"); return true;
      }
      async evaluateJavaScript() { now += 8_001; return { tracks: [],
        page: { mainPresent: true, phoneChallengeVisible: true, readyState: "complete" } }; }
      dispose() {}
    } });
    const manual = pack("kdniao", response === "complete" ? 12 : 1, NOW - 60_000, response === "complete");
    manual.complete = response === "complete";
    const result = await runShipmentRefreshForTesting(original.identity.id,
      { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { assert.fail("SF starts with Picker, not its coarse account source"); },
        queryManualForSource: async (input) => {
          if (input.pickerOnly) {
            calls.push("picker");
            return { shipment: null, pending: null, routeUrl: response === "complete" ? "" :
              "https://m.kuaidi100.com/result.jsp?nu=SF000000000000" };
          }
          assert.equal(input.fallbackOnly, true);
          calls.push("kdniao");
          return { shipment: response === "no-result" ? null : { ...original, timeline: manual,
            sourceTimeline: null, manualTimelines: [manual] }, pending: null, routeUrl: "" };
        },
      });
    assert.deepEqual(calls, ["picker", "k100_h5", "kdniao"],
      "old SF feed/query/automatic-H5 pickup cannot close the manual chain after an empty Picker and H5 timeout");
    const k100Stage = readDiagnostics().filter(entry => entry.event === "detail.refresh.stage_failed" &&
      entry.details.timelineProvider === "k100_h5");
    assert.equal(k100Stage.length, 1, "page metadata is emitted once at the final K100 stage boundary");
    assert.equal(k100Stage[0]?.details.mainPresent, true);
    assert.equal(k100Stage[0]?.details.phoneChallengeVisible, true);
    assert.equal(k100Stage[0]?.details.readyState, "complete");
    assert.equal(k100Stage[0]?.details.timedTrackCount, 0);
    const persisted = loadState(now).shipments[0]!;
    if (response === "no-result") {
      assert.equal(result.refreshed, false);
      assert.equal(selectShipmentDetailTimeline(persisted).provider, "v5_query");
    } else {
      assert.equal(result.refreshed, true);
      for (const select of [selectShipmentTimeline, selectShipmentDetailTimeline]) {
        assert.equal(select(persisted).provider, "kdniao");
        assert.deepEqual(select(persisted).tracks, manual.tracks,
          "the whole manual package is persisted and selected on Home and detail, including a usable partial");
      }
      assert.equal(persisted.manualTimelines?.find(t => t.provider === "v5_query")?.tracks.length, 5,
        "coarse source data remains intact as fallback");
    }
  }

  const original = seed();
  const staleOnline = pack("v6_query", 1, oldAt);
  const completeManual = pack("kdniao", 17, NOW - 60_000, true);
  for (const preferred of ["v6_query", "kdniao"]) {
    const sf = { ...original, timeline: completeManual,
      manualTimelines: [...original.manualTimelines!, staleOnline, completeManual],
      detailSelection: { provider: preferred, selectedAtMs: NOW } };
    const manual = { ...sf, sourceTimeline: null,
      identity: { ...sf.identity, manuallyAdded: true, sourceOwner: "manual" } };
    for (const select of [selectShipmentTimeline, selectShipmentDetailTimeline]) {
      assert.equal(select(sf).provider, "kdniao", "a freshly fetched stale Online scalar cannot replace a complete manual package");
      assert.deepEqual(select(sf).tracks, completeManual.tracks);
      assert.deepEqual(select(sf).tracks, select(manual).tracks,
        "SF Home/detail and a manual item select the same whole package using the existing ranking");
    }
  }
  assert.equal(hasTimelineStartBeforeKdniao(original), false);
  assert.equal(hasCachedTimelineBeforeKdniao(original), false);
  assert.equal(needsDetailFallback(original), true);
  for (const provider of ["v6_query", "k100_h5", "kdniao"]) {
    const manual = pack(provider, 1, oldAt - 60_000);
    const row = { ...original, manualTimelines: [...original.manualTimelines!, manual] };
    for (const select of [selectShipmentTimeline, selectShipmentDetailTimeline]) {
      assert.equal(select(row).provider, provider,
        "any eligible timed manual package precedes automatic fallback, without freshness or node-count conditions");
    }
  }
  for (const provider of ["v6_query", "k100_h5"]) {
    const row = { ...original, manualTimelines: [...original.manualTimelines!, pack(provider, 2, NOW, true)] };
    assert.equal(hasTimelineStartBeforeKdniao(row), true, "accumulated manual pickup still stops paid fallback");
  }
  for (const invalid of [pack("v6_query", 0, NOW, true), pack("v2_query", 20, NOW, true),
    { ...pack("kuaidi100_h5", 3, NOW, true), rawCourierCode: "jd" }]) {
    const row = { ...original, manualTimelines: [...original.manualTimelines!, invalid] };
    assert.equal(selectShipmentDetailTimeline(row).provider, "v5_query",
      "empty, unsupported or unverified packages cannot displace SF fallback");
    assert.equal(hasTimelineStartBeforeKdniao(row), false);
  }
  assert.equal(hasTimelineStartBeforeKdniao({ ...original, manualTimelines: [pack("kdniao", 2, NOW, true)] }), false,
    "paid fallback never proves that the pre-fallback round has reached pickup");
  for (const sourceProvider of ["JingDong", "CaiNiao"]) {
    assert.equal(hasTimelineStartBeforeKdniao(seed(sourceProvider)), true,
      "the SF exception follows business source, not the carrier code");
  }

  memory.clear();
  now = NOW;
  let current = saveState({ ...emptyState(), shipments: [original], bindings: [
    { source: "interface5", phone: "13800001234", boundAtMs: oldAt },
  ] }, now);
  const latestPicker = pack("v6_query", 1, NOW - 60_000);
  let scheduledRequests = 0;
  await runShipmentEnrichmentForTesting(current, "interface5", "sf-scheduled-control",
    (candidate, _routes, _stage, base) => {
      const committed = commitRefreshState(base || current, candidate, "interface5", now);
      assert.equal(committed.applied, true);
      return current = committed.state;
    }, NOW + 60_000, new Set(), false, false, undefined, {
      refreshAccountParcel: async () => null,
      queryManualForSource: async (input) => {
        scheduledRequests++;
        assert.equal(input.scheduled, true);
        assert.equal(input.pickerFirst, true);
        assert.equal(input.hostSafe, true);
        assert.equal(input.includeKdniaoFallback, false, "scheduled SF keeps its existing Picker-only network scope");
        return { shipment: { ...original, timeline: latestPicker, sourceTimeline: null,
          manualTimelines: [latestPicker] }, pending: null, routeUrl: "" };
      },
    });
  assert.equal(scheduledRequests, 1);
  assert.deepEqual(selectShipmentTimeline(loadState(now).shipments[0]!).tracks, latestPicker.tracks,
    "scheduled Picker partials take over the same durable Home display without expanding the network chain");

  memory.clear();
  now = NOW;
  const phoneOwner = saveState({ ...emptyState(), shipments: [seed()], bindings: [
    { source: "interface5", phone: "13800004321", boundAtMs: oldAt },
  ] }, now).shipments[0]!;
  let phoneSubmissions = 0;
  const checkCode = { show: true };
  Object.defineProperty(checkCode, "value", { enumerable: true,
    get() { assert.fail("the client must not read the tail back"); },
    set(value) { assert.equal(value, phoneOwner.identity.phoneTail, "the same ticket tail wins over unrelated bindings"); },
  });
  const vue = { num: waybill, checkCode, $data: { lists: [] as object[], checkCode }, doCheckCode() {
    phoneSubmissions++;
    this.$data.lists = [
      { time: "2026-09-08 14:00:00", context: "Parcel arrived" },
      { time: "2026-09-07 14:00:00", context: "顺丰速运 已收取快件" },
    ];
  } };
  Object.assign(globalThis, { WebViewController: class {
    async loadHTML(_html: string, url: string) { assert.equal(url, `https://m.kuaidi100.com/app/query/?nu=${waybill}`); return true; }
    async evaluateJavaScript(script: string) {
      now++;
      const main = { __vue__: vue };
      const document = { readyState: "complete", querySelector: (selector: string) => selector === "#main" ? main : null,
        querySelectorAll: (selector: string) => selector.split(",").includes("#main") ? [main] : [] };
      return new Function("window", "document", "location", script)({}, document,
        { hostname: "m.kuaidi100.com", href: `https://m.kuaidi100.com/app/query/?nu=${waybill}` });
    }
    dispose() {}
  } });
  const verified = await runShipmentRefreshForTesting(phoneOwner.identity.id,
    { isCurrent: () => true, deadlineAtMs: NOW + 30_000 },
    { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
      refreshAccountParcel: async () => { assert.fail("SF starts with its manual chain"); },
      queryManualForSource: async (input) => {
        assert.equal(input.pickerOnly, true, "K100 pickup stops the existing final fallback");
        return { shipment: null, pending: null, routeUrl: "" };
      },
    });
  assert.equal(phoneSubmissions, 1, "the actual refreshWebTimeline caller passes the owner's phone tail");
  assert.equal(verified.refreshed, true);
  assert.equal(selectShipmentDetailTimeline(loadState(now).shipments[0]!).provider, "k100_h5");
} finally { Date.now = actualNow; }
console.log("ShunFeng manual takeover tests passed");
