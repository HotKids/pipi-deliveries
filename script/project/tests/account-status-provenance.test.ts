import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import type { AccountParcelDto } from "../services/account-parser";
import { memory } from "./state-storage-mock";
import { emptyState, loadState, saveState, visibleShipments } from "../services/storage";
import { runAccountFollowupsForTesting } from "../services/sync";
import { mergeTimelinePackage } from "../services/status";

// Status flags, counts and event times come from the user's revision-5256 diagnostic.
// Identifiers and non-headline nodes are synthetic; this does not replay an unseen network body.
const cases = [
  { tail: "0058", carrier: "SF", at: 1787704489000, sourceCount: 0, queryCount: 11, visible: false },
  { tail: "6800", carrier: "SF", at: 1787532141000, sourceCount: 0, queryCount: 11, visible: false },
  { tail: "2500", carrier: "SF", at: 1787793004000, sourceCount: 20, queryCount: 11, visible: true },
  { tail: "4994", carrier: "YTO", at: 1787463751000, sourceCount: 13, queryCount: 12, visible: false },
];
const now = 1788940897682;
const phone = "13800001234";
const timeText = (at: number) => new Date(at + 8 * 3600000).toISOString().replace("T", " ").slice(0, 19);
const originalNow = Date.now;
Date.now = () => now;
try {
  memory.clear();
  const incomingById = new Map<string, AccountParcelDto>();
  const rows = cases.map((item, index): Shipment => {
    const orderId = `361000000000000${index}`;
    const waybill = `${item.carrier}123456${item.tail}`;
    const pack = (provider: string, count: number, semantic: TimelinePackage["semantic"]): TimelinePackage => ({
      provider, waybill, courierCode: item.carrier, companyName: item.carrier,
      semantic, structuredStatus: false, complete: false,
      statusEventAtMs: semantic === "COMPLETED" ? item.at : null,
      latestTimeText: count ? timeText(item.at) : "", latestDetail: count ? "Carrier delivery event" : "",
      successAtMs: now - 1000,
      tracks: Array.from({ length: count }, (_, n) => ({
        timeMs: item.at - n * 60000, timeText: timeText(item.at - n * 60000),
        detail: n ? `Carrier history event ${n}` : "Carrier delivery event", statusCode: "", raw: {},
      })),
    });
    const source = pack("interface5", item.sourceCount, "UNKNOWN");
    const query = pack("v5_query", item.queryCount, "COMPLETED");
    const identity = { id: `interface5:account:${orderId}`, sourceId: orderId, orderId,
      projectedWaybill: waybill, accountOrder: true, manuallyAdded: false,
      bindingSource: "interface5" as const, sourceProvider: "JingDong", sourceOwner: "interface5:order",
      courierCode: item.carrier, companyName: item.carrier, rawCourierCode: "JDKD",
      phone, phoneTail: "1234", createdAtMs: item.at - 86400000 };
    incomingById.set(identity.id, {
      source: "interface5", ownerId: orderId, orderId, accountOrder: true, waybill,
      courierCode: item.carrier, companyName: item.carrier, rawCourierCode: "JDKD", rawCompanyName: "JD",
      carrierNormalization: null, sourceProvider: "JingDong", sourceStateCode: "107", sourceStateText: "已签收",
      semantic: "COMPLETED", normalizedStatusScope: "SHIPMENT", normalizedStatusSemantic: "COMPLETED",
      normalizedStatusText: "已签收", receiverPhone: phone, senderPhone: "", routeUrl: "", projectionUrl: "",
      latestDetail: query.latestDetail, latestTimeText: query.latestTimeText, tracks: query.tracks,
    });
    return { identity, timeline: { ...source, tracks: source.tracks.length ? source.tracks : query.tracks },
      sourceTimeline: source, manualTimelines: [query], updatedAtMs: now - 1000,
      accountRecord: { waybill: orderId, companyCode: "JDKD", name: "JD", provider: "JingDong",
        stateNumber: 107, updateTime: timeText(item.at), phone, channel: "1" } };
  });
  const state = saveState({ ...emptyState(), shipments: rows,
    bindings: [{ source: "interface5", phone, boundAtMs: now - 86400000 }] }, now);
  assert.equal(visibleShipments(state, now).length, 4, "the observed cache bypasses signed retention");
  const result = await runAccountFollowupsForTesting(state, "interface5", now, "provenance-replay",
    candidate => saveState(candidate, now), now + 60000, new Set(), undefined, {
      refreshAccountParcel: async row => incomingById.get(row.identity.id)!,
    });
  assert.equal(result.succeeded, 4);
  const reloaded = loadState(now);
  for (const item of cases) {
    const row = reloaded.shipments.find(row => row.identity.projectedWaybill?.endsWith(item.tail))!;
    assert.equal(row.manualTimelines?.find(pack => pack.provider === "v5_query")?.structuredStatus, true,
      `${item.tail}: a same-source structured confirmation must upgrade the legacy provenance flag`);
    assert.equal(row.timeline.semantic, "COMPLETED", `${item.tail}: Home accepts the confirmed state`);
    assert.equal(row.settledAtMs, item.at, `${item.tail}: querying must not restart the signed clock`);
    assert.equal(visibleShipments(reloaded, now).some(value => value.identity.id === row.identity.id), item.visible);
    assert.equal(row.sourceTimeline?.tracks.length, item.sourceCount);
    assert.equal(row.manualTimelines?.find(pack => pack.provider === "v5_query")?.tracks.length, item.queryCount);
  }

  const cached = rows[0]!.manualTimelines![0]!;
  for (const tracks of [cached.tracks, []]) {
    const signed = { ...cached, structuredStatus: true, tracks, statusEventAtMs: cached.statusEventAtMs! - 1000 };
    const upgraded = mergeTimelinePackage(cached, signed);
    assert.equal(upgraded.structuredStatus, true);
    assert.equal(upgraded.statusEventAtMs, signed.statusEventAtMs);
    assert.deepEqual(upgraded.tracks, cached.tracks);
    assert.equal(upgraded.latestDetail, cached.latestDetail);
    const regressed = mergeTimelinePackage(upgraded, { ...signed, semantic: "TRANSIT" });
    assert.equal(regressed.semantic, "COMPLETED");
    assert.equal(regressed.statusEventAtMs, upgraded.statusEventAtMs);
  }
} finally {
  Date.now = originalNow;
}
console.log("legacy account status provenance and whole-row retention tests passed");
