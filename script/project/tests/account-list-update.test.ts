import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { emptyState, loadState, saveState } from "../services/storage";
import { refreshAllShipments } from "../services/sync";
import { parseAccountSyncResult } from "../services/account-parser";
import { parcelToShipment } from "../services/account-sync";
import { applyAccountShipment, selectShipmentTimeline } from "../services/shipment-policy";
import { saveGatewayToken } from "../services/credentials";
import {
  containsTimelineStartTrack,
  isProviderErrorDetail,
  parseProviderTime,
  shipmentPresentationStatus,
  timedTracks,
} from "../services/status";
import type { TimelinePackage } from "../models";

const NOW = Date.UTC(2026, 8, 12, 6);
const PHONE = "13800000000", WAYBILL = "SYNTHETICLIST0001";
const GENERIC = "快递状态已更新，点击查看>>";
const FRESH_TIME = "2026-09-12 10:00:00";
const realNow = Date.now;
Date.now = () => NOW;
process.on("exit", () => { Date.now = realNow; });
Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({ toHexString: () => createHmac("sha256", key).update(value).digest("hex") }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined },
  Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
});

// Xperia's original getList has stateNum and details[].time, with no root clock.
const raw = (desc: string, at: string, code: number) => ({
  mailNo: WAYBILL, provider: "CaiNiao", cpCode: "YTO", name: "Synthetic carrier", phone: PHONE,
  stateNum: code, details: [{ time: at, desc }],
});
const payload = (record: unknown) => ({ code: 0, data: { expressList: [record] } });
const parse = (record: unknown) => parseAccountSyncResult("interface5", payload(record)).parcels[0];

for (const legacyUntimedFeed of [false, true]) {
  memory.clear();
  let seed = applyAccountShipment(undefined, parcelToShipment(
    parse(raw("Previous list event", "2026-09-12 08:00:00", 104)), [PHONE], NOW - 3600000,
  )!, NOW - 3600000);
  if (legacyUntimedFeed) {
    // Previously filtered generic packets left an empty feed beside the query cache.
    const source = { ...seed.sourceTimeline!, tracks: [], latestTimeText: "", latestDetail: "", statusEventAtMs: null };
    seed = { ...seed, sourceTimeline: source, timeline: source };
  }
  const query: TimelinePackage = {
    provider: "v5_query", waybill: WAYBILL, courierCode: "YTO", companyName: "Synthetic carrier",
    semantic: "TRANSIT", structuredStatus: true, statusEventAtMs: parseProviderTime("2026-09-12 09:00:00"),
    latestTimeText: "2026-09-12 09:00:00", latestDetail: "Cached query event",
    tracks: [
      { timeText: "2026-09-12 09:00:00", timeMs: parseProviderTime("2026-09-12 09:00:00"), detail: "Cached query event", statusCode: "104", raw: { statusCode: "104", _pipiStatusSource: "interface5" } },
      { timeText: "2026-09-12 07:00:00", timeMs: parseProviderTime("2026-09-12 07:00:00"), detail: "已揽收", statusCode: "103", raw: { statusCode: "103", _pipiStatusSource: "interface5" } },
    ], complete: true, successAtMs: NOW - 1800000,
  };
  seed = { ...seed, manualTimelines: [query], timeline: query, detailSelection: { provider: "v5_query", selectedAtMs: NOW - 1800000 } };
  saveState({ ...emptyState(), shipments: [seed], bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }], feedSlotRebuiltAtMs: NOW - 86400000 }, NOW);
  saveGatewayToken("AbCdEfGh_123-456");
  const priorQuery = structuredClone(loadState(NOW).shipments[0].manualTimelines);
  let listCalls = 0;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "Synthetic offline authority" };
    assert.equal(path, "/api/express/accounts/sync", "list update must work without any query or manual provider");
    listCalls++;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload(raw(GENERIC, FRESH_TIME, 105))) };
  }) as typeof fetch;
  const run = await refreshAllShipments("interface5", { accountListOnly: true, accountOrderProjection: false });
  const stored = loadState(NOW).shipments[0];
  const displayed = selectShipmentTimeline(stored);
  assert.equal(listCalls, 1);
  assert.equal(run.failed, 0);
  assert.equal(stored.sourceTimeline?.semantic, "DELIVERY");
  assert.equal(stored.sourceTimeline?.statusEventAtMs, parseProviderTime(FRESH_TIME));
  assert.equal(stored.sourceTimeline?.latestDetail, GENERIC);
  assert.ok(stored.sourceTimeline?.tracks.some(track => track.detail === GENERIC && track.timeMs === parseProviderTime(FRESH_TIME)));
  assert.equal(stored.accountRecord?.updateTime, FRESH_TIME);
  assert.equal(displayed.semantic, "DELIVERY");
  assert.equal(displayed.statusEventAtMs, parseProviderTime(FRESH_TIME));
  assert.equal(displayed.latestDetail, "Cached query event");
  assert.equal(displayed.latestTimeText, "2026-09-12 09:00:00");
  assert.equal(stored.timeline.semantic, "DELIVERY");
  assert.equal(stored.timeline.latestDetail, "Cached query event");
  assert.equal(stored.timeline.latestTimeText, "2026-09-12 09:00:00");
  assert.equal(stored.timeline.statusEventAtMs, parseProviderTime(FRESH_TIME));
  assert.equal(shipmentPresentationStatus(stored).semantic, "DELIVERY");
  assert.deepEqual(stored.manualTimelines, priorQuery, "feed must not overwrite or splice the cached query history");
}

for (const desc of [GENERIC, "快递状态已更新,点击查看>>", "快递状态已更新"]) {
  const dto = parse(raw(desc, FRESH_TIME, 105));
  const incoming = parcelToShipment(dto, [PHONE], NOW)!;
  assert.equal(dto.latestDetail, desc);
  assert.equal(dto.latestTimeText, FRESH_TIME);
  assert.equal(isProviderErrorDetail(desc), false);
  assert.equal(timedTracks(incoming.timeline.tracks).length, 1);
  assert.equal(containsTimelineStartTrack(incoming.timeline.tracks), false);
  assert.notEqual(incoming.timeline.complete, true, "an update summary alone does not prove complete history");
}

const unknown = parcelToShipment(parse(raw(GENERIC, "", 999)), [PHONE], NOW)!;
assert.equal(unknown.timeline.semantic, "UNKNOWN");
assert.equal(unknown.timeline.structuredStatus, false);
assert.equal(unknown.timeline.statusEventAtMs, null);
for (const desc of ["", "   ", "查无结果", "noresult"]) {
  const dto = parse(raw(desc, FRESH_TIME, 999));
  assert.equal(dto.tracks.length, 0);
  assert.equal(dto.latestDetail, "");
}

memory.clear();
const initialRecords = ["CNTEST0001", "CNTEST0002"].map(mailNo => ({
  ...raw("Previous real list event", "2026-09-12 08:00:00", 104), mailNo,
}));
saveState({ ...emptyState(),
  shipments: initialRecords.map(record => applyAccountShipment(undefined,
    parcelToShipment(parse(record), [PHONE], NOW - 3600000)!, NOW - 3600000)),
  bindings: [{ source: "interface5", phone: PHONE, boundAtMs: NOW - 86400000 }],
  feedSlotRebuiltAtMs: NOW - 86400000,
}, NOW);
saveGatewayToken("AbCdEfGh_123-456");

async function listRound(records: typeof initialRecords, outcome: "success" | "empty" | "failure" = "success") {
  const queried: string[] = [];
  let listCalls = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const json = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "Synthetic offline authority" };
    if (path === "/api/express/accounts/sync") {
      listCalls++;
      return json({ code: 0, data: { expressList: records } });
    }
    assert.equal(path, "/api/express/timeline/source", "no manual or H5 provider may run");
    const request = JSON.parse(String(init.body));
    assert.equal(request.interface, "v5");
    assert.equal(request.mode, "detail");
    const record = records.find(row => row.mailNo === request.record.waybill)!;
    assert.ok(record);
    queried.push(record.mailNo);
    if (outcome === "failure") return { ok: false, status: 503, text: async () => "Synthetic unavailable query" };
    if (outcome === "empty") return json({ code: 0, data: { expressList: [] } });
    return json({ code: 0, data: { ...record, details: [
      { time: record.details[0].time, desc: "Fresh real delivery event" },
      { time: "2026-09-12 07:00:00", desc: "已揽收" },
    ] } });
  }) as typeof fetch;
  await refreshAllShipments("interface5", {
    accountSourceFollowup: true, forceManualRefresh: true, accountOrderProjection: false,
  });
  assert.equal(listCalls, 1);
  return queried.sort();
}

assert.deepEqual(await listRound(initialRecords), [], "identical list must not query any Cainiao parcel");
const updatedRecords = initialRecords.map((record, i) => i ? record : {
  ...record, stateNum: 105, details: [{ time: FRESH_TIME, desc: GENERIC }],
});
assert.deepEqual(await listRound(updatedRecords), ["CNTEST0001"], "query only the changed parcel");
let stored = loadState(NOW).shipments.find(row => row.identity.sourceId === "CNTEST0001")!;
assert.equal(stored.sourceTimeline?.latestDetail, GENERIC, "raw update signal remains list-owned");
assert.equal(stored.timeline.latestDetail, "Fresh real delivery event");
assert.equal(stored.timeline.latestTimeText, FRESH_TIME);
assert.equal(stored.timeline.semantic, "DELIVERY");
assert.ok(stored.manualTimelines?.find(pack => pack.provider === "v5_query")?.tracks.length === 2);
assert.deepEqual(await listRound(updatedRecords), [], "repeat list does not repeat the query");
const hydrated = updatedRecords.map((record, i) => i ? record : {
  ...record, details: [{ time: FRESH_TIME, desc: "Fresh real delivery event" }],
});
assert.deepEqual(await listRound(hydrated), [], "query hydration at the same state/time is not a new update");
const next = hydrated.map((record, i) => i ? record : {
  ...record, details: [{ time: "2026-09-12 11:00:00", desc: GENERIC }],
});
assert.deepEqual(await listRound(next, "failure"), ["CNTEST0001"]);
stored = loadState(NOW).shipments.find(row => row.identity.sourceId === "CNTEST0001")!;
assert.equal(stored.timeline.latestDetail, "Fresh real delivery event", "failure retains actual earlier text");
assert.equal(stored.timeline.latestTimeText, FRESH_TIME, "old description must retain its actual time");
assert.equal(stored.sourceTimeline?.statusEventAtMs, parseProviderTime("2026-09-12 11:00:00"));
assert.deepEqual(await listRound(next), [], "a failed query does not make an unchanged list new");
const stateChanged = next.map((record, i) => i ? record : { ...record, stateNum: 106 });
assert.deepEqual(await listRound(stateChanged, "empty"), ["CNTEST0001"], "same-time structured status update counts");
assert.deepEqual(await listRound(stateChanged), [], "an empty query does not repeat on the same list");
assert.deepEqual(await listRound(initialRecords), [], "stale list cannot trigger a regression query");
const completed = stateChanged.map((record, i) => i ? record : {
  ...record, stateNum: 107, details: [{ time: "2026-09-12 12:00:00", desc: GENERIC }],
});
assert.deepEqual(await listRound(completed), ["CNTEST0001"], "new completion gets its final tracks once");
assert.deepEqual(await listRound(completed), []);
const discovered = [...completed, { ...initialRecords[1], mailNo: "CNTEST0003" }];
assert.deepEqual(await listRound(discovered), ["CNTEST0003"], "new parcel is queried without touching existing rows");
console.log("account-list-update tests passed");
