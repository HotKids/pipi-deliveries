import assert from "node:assert/strict";
import type { PendingManualQuery, Shipment, TimelinePackage } from "../models.ts";
import { memory, NOW } from "./state-storage-mock.ts";
import { loadState } from "../services/storage.ts";
import { commitManualShipmentPreview, continueManualShipmentPreview } from "../services/sync.ts";
import { selectShipmentDetailTimeline } from "../services/shipment-policy.ts";

Date.now = () => NOW;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const waybill = "TEST1234567890";
const timeline: TimelinePackage = {
  provider: "v6_query", waybill, courierCode: "TEST", companyName: "Carrier",
  semantic: "UNKNOWN", statusEventAtMs: null, latestTimeText: "", latestDetail: "",
  tracks: [], successAtMs: NOW, complete: false,
};
const seed: Shipment = {
  identity: { id: `interface5:manual:${waybill}`, bindingSource: "interface5",
    sourceOwner: "manual", sourceId: waybill, phoneTail: "", courierCode: "TEST",
    companyName: "Carrier", manuallyAdded: true, createdAtMs: NOW },
  timeline, manualTimelines: [], updatedAtMs: NOW,
};
const pending: PendingManualQuery = {
  id: `interface5:${waybill}`, source: "interface5", waybill, phoneTail: "",
  courierCode: "TEST", rawCourierCode: "TEST", companyName: "Carrier",
  createdAtMs: NOW, lastAttemptAtMs: NOW, attempts: 1, awaitingRoundCompletion: true,
};
function result(provider: string, full: boolean): Shipment {
  const detail = full ? "快件已揽收" : "Carrier event";
  const value: TimelinePackage = { ...timeline, provider, semantic: "TRANSIT",
    latestDetail: detail, latestTimeText: "2026-09-08 14:00:00", statusEventAtMs: NOW,
    tracks: [{ timeMs: NOW, timeText: "2026-09-08 14:00:00", detail, statusCode: "", raw: {} }],
  };
  return { ...seed, timeline: value, manualTimelines: [value] };
}

for (const firstFull of [false, true]) {
  memory.clear();
  const preview = { shipment: seed, pending, hasTimedResult: false, roundComplete: false,
    routeUrl: "", commitBase: { shipment: null, pending: null } };
  commitManualShipmentPreview(preview);
  const slow = deferred<Shipment | null>();
  const displayed = deferred<Shipment>();
  let finalCommitted = false;
  let fallbackCalls = 0;
  const work = continueManualShipmentPreview(preview, {
    onPreview: displayed.resolve,
    dependencies: {
      now: () => NOW,
      queryMoto: async () => result("v4_query", firstFull),
      queryKuaidi100: () => slow.promise,
      queryKdniao: async () => { fallbackCalls++; return result("kdniao", true); },
    },
  }).then((value) => { finalCommitted = true; return value; });
  const shown = await displayed.promise;
  assert.equal(selectShipmentDetailTimeline(shown).provider, "v4_query");
  assert.equal(shown.timeline.tracks.length, 1, "the first usable primary result is immediately available");
  assert.equal(finalCommitted, false, "a slow peer must not delay detail-only preview");
  assert.equal(loadState().shipments.length, 0, "preview does not publish an owner or terminal state");
  assert.equal(loadState().pendingQueries.length, 1);
  slow.resolve(null);
  const final = await work;
  assert.equal(fallbackCalls, firstFull ? 0 : 1, "only incomplete primary history reaches the final fallback");
  assert.equal(final.state.shipments.length, 1);
  assert.equal(final.state.pendingQueries.length, 0);
}
console.log("first provider progress and atomic final commit tests passed");
