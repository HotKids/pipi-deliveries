import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "./state-storage-mock";
import type { Shipment, TimelinePackage } from "../models";
import { applyAccountShipment, applySameSourceTimeline, shipmentDetailCandidateEvidence } from "../services/shipment-policy";
import { emptyState, saveState } from "../services/storage";
import { runShipmentRefreshForTesting } from "../services/sync";

// Audit D4 (adopted 2026-09-25; the 2026-09-24 rule 「缓存网页包要判完整才挡补查」 covers jd_h5 and cn_h5):
// a Cainiao page with a pickup node stops Moto / K100 / KDNiao only when detail selection also judges
// it complete — pickup, and a newest node no more than 30 minutes behind the account list. A pickup
// page that lags the list is kept, but the chain continues. Node texts are synthetic.
const LIST_AT = Date.UTC(2026, 8, 24, 9, 21);
const NOW = LIST_AT + 20 * 60_000;
const WAYBILL = "YT0000000009924", PHONE = "13800009924";
const providerTime = (at: number) => new Date(at + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");

function nodes(newestAt: number, count: number, pickup: boolean, label: string) {
  return Array.from({ length: count }, (_, i) => ({
    timeMs: newestAt - i * 30 * 60_000, timeText: providerTime(newestAt - i * 30 * 60_000),
    detail: pickup && i === count - 1 ? "快件已揽收" : `Synthetic ${label} transit ${count - i}`,
    statusCode: "", raw: {},
  }));
}

function seed(): Shipment {
  memory.clear();
  const tracks = nodes(LIST_AT, 2, false, "list").map((track) => ({ ...track, statusCode: "104",
    raw: { statusCode: "104", _pipiStatusSource: "interface5" } }));
  const feed: TimelinePackage = {
    provider: "interface5", waybill: WAYBILL, courierCode: "YTO", companyName: "圆通速递",
    semantic: "TRANSIT", structuredStatus: true, statusEventAtMs: LIST_AT, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: NOW,
  };
  const row: Shipment = applyAccountShipment(undefined, {
    identity: { id: `interface5:account:${WAYBILL}`, bindingSource: "interface5", sourceOwner: "interface5",
      sourceId: WAYBILL, sourceProvider: "CaiNiao", courierCode: "YTO", rawCourierCode: "YTO",
      companyName: "圆通速递", phone: PHONE, phoneTail: "9924", manuallyAdded: false, createdAtMs: NOW },
    timeline: feed, sourceTimeline: feed, manualTimelines: [], route: { kind: "cainiao", source: "interface5" },
    accountRecord: null, updatedAtMs: NOW,
  }, NOW);
  return saveState({ ...emptyState(), shipments: [row], bindings: [
    { source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 },
  ] }, NOW).shipments[0];
}

function cainiaoPage(newestAt: number): TimelinePackage {
  const tracks = nodes(newestAt, 4, true, "cn");
  return { provider: "cn_h5", waybill: WAYBILL, courierCode: "YTO", companyName: "圆通速递",
    semantic: "UNKNOWN", structuredStatus: false, complete: false, tracks,
    latestTimeText: tracks[0].timeText, latestDetail: tracks[0].detail, successAtMs: NOW };
}

async function pull(page: TimelinePackage) {
  const realNow = Date.now;
  Date.now = () => NOW;
  const calls: string[] = [];
  try {
    const row = seed();
    await runShipmentRefreshForTesting(row.identity.id, { isCurrent: () => true, deadlineAtMs: NOW + 30000 },
      { trigger: "detail_pull", forceManualRefresh: true, includeKdniaoFallback: true }, {
        refreshAccountParcel: async () => { throw new Error("a pull does not query v5 here"); },
        refreshCainiaoH5: async (shipment: Shipment) => {
          calls.push("cn_h5");
          return applySameSourceTimeline(shipment, page, NOW);
        },
        refreshWebTimeline: async () => { calls.push("k100_h5"); return null; },
        queryManualForSource: async (input: { motoOnly?: boolean; fallbackOnly?: boolean }) => {
          calls.push(input.fallbackOnly ? "kdniao" : input.motoOnly ? "v4_query" : "v6_query");
          return { result: "empty_response" as const, shipment: null, pending: null, routeUrl: "" };
        },
      });
    return { calls, row };
  } finally {
    Date.now = realNow;
  }
}

test("a pickup page 65 minutes behind the list no longer stops the manual chain", async () => {
  const stale = cainiaoPage(LIST_AT - 65 * 60_000);
  const { calls, row } = await pull(stale);
  const evidence = shipmentDetailCandidateEvidence(applySameSourceTimeline(row, stale, NOW), stale);
  assert.equal(evidence.hasPickup, true);
  assert.equal(evidence.detailComplete, false, "detail selection rejects the lagging page");
  assert.ok(calls.includes("cn_h5"));
  assert.ok(calls.includes("v4_query"), "Moto still runs");
  assert.ok(calls.includes("k100_h5"), "the K100 page still runs");
});

test("a complete pickup page still stops the chain", async () => {
  const { calls } = await pull(cainiaoPage(LIST_AT));
  assert.deepEqual(calls, ["cn_h5"]);
});
