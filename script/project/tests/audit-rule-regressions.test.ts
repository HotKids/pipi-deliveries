import assert from "node:assert/strict";
import { memory, NOW, sha256 } from "./state-storage-mock";
import type { Shipment, TimelinePackage, TrackNode } from "../models";
import { isQualifiedAutomaticShipment, manualShipmentReusedBy } from "../services/shipment-policy";
import { emptyState, loadState, visibleShipments, saveState } from "../services/storage";
import { queryManualShipmentPreview } from "../services/sync";
import { queryMotoShipment, queryKdniaoShipment, queryManualForSource } from "../services/manual-query";
import { recordRefreshProviderResult } from "../services/refresh-runtime-state";
import { GatewayError } from "../services/gateway";
import { queryManualSourceChain } from "../services/manual-query-order";
import { scrapeWebTimeline } from "../services/web-timeline";
import { replayPendingShipmentNotifications } from "../services/notifications";
import { mergeTracks } from "../services/status";

const HOUR = 3_600_000;
const time = (at: number) => new Date(at + 8 * HOUR).toISOString().slice(0, 19).replace("T", " ");
const waybill = "YT8100000000099";
const track = (at: number, detail = "Synthetic event"): TrackNode =>
  ({ timeMs: at, timeText: time(at), detail, statusCode: "", raw: {} });
function pack(provider: string, semantic: TimelinePackage["semantic"], at: number,
  structuredStatus = true): TimelinePackage {
  return { provider, semantic, structuredStatus, complete: true, waybill, courierCode: "YTO", companyName: "YTO",
    statusEventAtMs: at, tracks: [track(at)], successAtMs: NOW, latestTimeText: time(at), latestDetail: "Synthetic event" };
}
function row(timeline: TimelinePackage): Shipment {
  return { identity: { id: `interface5:account:${waybill}`, bindingSource: "interface5", sourceOwner: "interface5",
    sourceId: waybill, phoneTail: "0000", phone: "13800000000", courierCode: "YTO", rawCourierCode: "YTO",
    rawCompanyName: "YTO", companyName: "YTO", manuallyAdded: false, sourceProvider: "CaiNiao", createdAtMs: NOW },
    timeline, sourceTimeline: timeline, manualTimelines: [], updatedAtMs: NOW };
}
let clock = NOW;
const realNow = Date.now;
Date.now = () => clock;
globalThis.fetch = (async () => { throw new Error("Synthetic test must not access the network"); }) as typeof fetch;
let failures = 0;
async function check(name: string, work: () => void | Promise<void>) {
  memory.clear(); clock = NOW;
  try { await work(); console.log(`${name}: passed`); }
  catch (error) { failures++; console.error(`${name}:`, error); }
}

await check("IOS-02 raw carrier placeholders", () => {
  for (const value of ["null", "OTHER", " unknown ", "未知", "其他", "ＯＴＨＥＲ"]) {
    const candidate = row(pack("interface5", "TRANSIT", NOW));
    candidate.identity.rawCourierCode = value; candidate.identity.rawCompanyName = "";
    assert.equal(isQualifiedAutomaticShipment(candidate), false, value);
    candidate.identity.rawCompanyName = "Otherworld Delivery";
    assert.equal(isQualifiedAutomaticShipment(candidate), true, "valid raw English name remains sufficient");
    candidate.identity.rawCourierCode = ""; candidate.identity.rawCompanyName = value;
    assert.equal(isQualifiedAutomaticShipment(candidate), false, "the raw name uses the same exact placeholder gate");
  }
});

await check("IOS-03 structured terminal reuse", () => {
  const old = pack("k100_h5", "COMPLETED", NOW - 3 * 24 * HOUR, false);
  const manual: Shipment = { ...row(old), identity: { ...row(old).identity, manuallyAdded: true },
    sourceTimeline: null, manualTimelines: [old], note: "Keep this note" };
  const incoming = row(pack("interface5", "PICKED", NOW - HOUR));
  assert.equal(manualShipmentReusedBy(manual, incoming, NOW), false, "prose cannot authorize deleting history or notes");
  old.structuredStatus = true;
  assert.equal(manualShipmentReusedBy(manual, incoming, NOW), true, "genuine structured signing still permits reuse");
});

await check("IOS-04 per-provider native timeout", async () => {
  const budgets: number[] = [];
  await queryManualShipmentPreview({ waybill,
    presentation: { courierCode: "YTO", companyName: "圆通速递", requiresPhoneTail: false } }, {
    post: async (_path, payload, options) => {
      budgets.push(options!.timeoutMs!);
      return { code: 0, value: { mailNo: payload.waybill, cpCode: "YTO", cpName: "圆通速递", logisticsStatus: "2",
        lastLogisticDetail: "Synthetic transit", logisticsGmtModified: time(NOW),
        logisticsInfo: [{ time: time(NOW), context: "Synthetic transit" }] } };
    },
  });
  for (const query of [queryMotoShipment, queryKdniaoShipment]) {
    await query({ waybill, courierCode: "YTO", rawCourierCode: "YTO", deadlineAtMs: NOW + 30_000,
      dependencies: { post: async (_path, _payload, options) => { budgets.push(options!.timeoutMs!); throw new Error("Synthetic response"); } },
    }).catch(() => {});
  }
  assert.equal(budgets.length, 3);
  assert.ok(budgets.every(budget => budget > 0 && budget <= 15_000), JSON.stringify(budgets));
  const retryBudgets: number[] = [];
  await queryManualForSource({ source: "interface5", bindings: [
    { source: "interface5", phone: "13800001234", boundAtMs: NOW - HOUR },
    { source: "interface5", phone: "13800005678", boundAtMs: NOW - HOUR },
  ], waybill: "SF123456789012", courierCode: "SF", rawCourierCode: "SF", companyName: "顺丰速运",
    deadlineAtMs: clock + 30_000, fallbackOnly: true, includeKdniaoFallback: true,
    dependencies: { post: async (_path, _payload, options) => {
      retryBudgets.push(options!.timeoutMs!);
      if (retryBudgets.length === 1) { clock += 14_000; throw new GatewayError("Synthetic mismatch", 400, "phone_verification_required"); }
      throw new Error("Synthetic next tail");
    } },
  });
  assert.deepEqual(retryBudgets, [15_000, 1_000], "phone retry shares the provider's original fifteen seconds");
  const realSetTimeout = globalThis.setTimeout;
  const childDeadlines: number[] = [];
  let ownedSignal: AbortSignal | undefined;
  const startedAt = clock;
  globalThis.setTimeout = ((callback: () => void, delay: number) => realSetTimeout(() => {
    clock += delay; callback();
  }, 0)) as typeof setTimeout;
  try {
    const result = await queryManualSourceChain([
      { source: "route", enabled: true, query: async (signal, deadlineAtMs) => {
        ownedSignal = signal; childDeadlines.push(deadlineAtMs!); return new Promise(() => {});
      } },
      { source: "fallback", enabled: true, query: async (_signal, deadlineAtMs) => {
        childDeadlines.push(deadlineAtMs!); return { shipment: row(pack("kdniao", "TRANSIT", clock)) };
      } },
    ], startedAt + 30_000, undefined, undefined, undefined, true);
    assert.deepEqual(childDeadlines, [startedAt + 15_000, startedAt + 30_000]);
    assert.equal(ownedSignal?.aborted, true, "timing out a child stage cancels its owned provider");
    assert.equal(result.selected?.timeline.provider, "kdniao", "the next stage can use the remaining parent budget");
  } finally { globalThis.setTimeout = realSetTimeout; }
});

await check("IOS-05 K100 same-waybill cooldown", async () => {
  let loads = 0;
  globalThis.WebViewController = class {
    async loadURL() { loads++; return true; }
    async evaluateJavaScript() { return { page: { readyState: "complete", phoneChallengeVisible: false },
      tracks: [{ timeText: time(NOW), detail: "Synthetic transit" }, { timeText: time(NOW - HOUR), detail: "已揽收" }] }; }
    dispose() {}
  } as unknown as typeof WebViewController;
  const input = { waybill, courierCode: "YTO", companyName: "YTO" };
  assert.ok(await scrapeWebTimeline(input));
  for (let index = 0; index < 260; index++) {
    clock++;
    recordRefreshProviderResult({ key: `synthetic-provider-${index}`, provider: "moto",
      identityFingerprint: "synthetic", result: "success", now: clock });
  }
  assert.equal(await scrapeWebTimeline(input), null, "a second actual capture is skipped inside the upstream window");
  assert.equal(loads, 1);
  clock = NOW + 30 * 60_000 - 1;
  assert.equal(await scrapeWebTimeline(input), null);
  clock++;
  assert.ok(await scrapeWebTimeline(input));
  assert.equal(loads, 2, "capture resumes exactly at thirty minutes");
  const aborted = new AbortController(); aborted.abort();
  const cancelledInput = { ...input, waybill: "YT8100000000100" };
  await assert.rejects(scrapeWebTimeline({ ...cancelledInput, signal: aborted.signal }), /请求超时/);
  assert.ok(await scrapeWebTimeline(cancelledInput), "a cancelled operation that never loaded does not consume the cooldown");
});

await check("IOS-06 queued cancelled event expiry", async () => {
  let schedules = 0;
  Object.assign(globalThis, { Script: { directory: "/synthetic", name: "Synthetic",
    createRunSingleURLScheme: () => "synthetic:detail" }, Notification: { schedule: async () => { schedules++; } } });
  Object.assign(Data, { fromFile: () => null });
  const cancelled = row(pack("interface5", "CANCELLED", NOW - 5 * HOUR));
  const state = { ...emptyState(), revision: 1, updatedAtMs: NOW, shipments: [cancelled],
    pendingNotifications: [{ id: "synthetic-cancel", shipmentId: cancelled.identity.id, semantic: "CANCELLED" as const,
      title: "Synthetic cancellation", body: "Synthetic cancellation", iconName: null }] };
  const payload = JSON.stringify(state);
  memory.set("pipi_deliveries_state_v1", JSON.stringify({ schema: 3, checksum: sha256(payload), payload }));
  assert.equal(visibleShipments(loadState(NOW), NOW).length, 0);
  await replayPendingShipmentNotifications();
  assert.equal(schedules, 0, "hidden cancellation must be acknowledged without native scheduling");
  assert.equal(loadState().pendingNotifications?.length || 0, 0);
  const recent = row(pack("interface5", "CANCELLED", NOW - HOUR));
  const prior = row(pack("interface5", "TRANSIT", NOW - 2 * HOUR));
  recent.identity.companyName = prior.identity.companyName = "Synthetic Delivery";
  saveState({ ...emptyState(), shipments: [prior] }, NOW);
  saveState({ ...loadState(), shipments: [cancelled] }, NOW, { notifyChanges: true });
  assert.equal(loadState().pendingNotifications?.length || 0, 0, "event generation also respects the cutoff");
  memory.clear();
  saveState({ ...emptyState(), shipments: [prior] }, NOW);
  saveState({ ...loadState(), shipments: [recent] }, NOW, { notifyChanges: true });
  assert.equal(loadState().pendingNotifications?.length, 1, "a recent cancellation still creates its ordinary event");
  await replayPendingShipmentNotifications();
  assert.equal(schedules, 1, "recent cancellation remains deliverable");
});

await check("IOS-07 Worker structured conflict dedup", () => {
  const projected = (at: number, semantic: "PICKED" | "TRANSIT" | "UNKNOWN", code = semantic, structured = true): TrackNode =>
    ({ ...track(at, "Same synthetic message"), raw: { _pipiStatusSource: "interface5", normalizedStatus: {
      version: 1, scope: "SHIPMENT", semantic, code, text: semantic, priority: 0, eventAtMs: at, structured } } });
  assert.equal(mergeTracks([projected(NOW - 120_000, "PICKED")], [projected(NOW, "TRANSIT")]).length, 2);
  assert.equal(mergeTracks([projected(NOW - 120_000, "PICKED")], [projected(NOW, "PICKED")]).length, 1);
  assert.equal(mergeTracks([projected(NOW - 120_000, "UNKNOWN", "UNMAPPED")], [projected(NOW, "TRANSIT")]).length, 1,
    "unknown is not a known semantic conflict");
  for (const [semantic, structured, legacy] of [["UNKNOWN", true, "COMPLETED"], ["PICKED", false, "PICKED"]] as const) {
    const previous = projected(NOW - 120_000, semantic, semantic, structured);
    previous.statusCode = legacy;
    previous.raw.statusCode = legacy;
    assert.equal(mergeTracks([previous], [projected(NOW, "TRANSIT")]).length, 1,
      "an authoritative unknown or unstructured projection cannot borrow a stale raw status");
  }
  assert.equal(mergeTracks([projected(NOW, "PICKED")], [projected(NOW, "TRANSIT")]).length, 2,
    "same-time conflicts must survive the earlier exact-time merge too");
});

Date.now = realNow;
assert.equal(failures, 0, `${failures} audit regression partitions failed`);
