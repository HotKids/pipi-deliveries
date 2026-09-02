import assert from "node:assert/strict";
import type { Shipment } from "../models";
import { runManualDetailSourceContest } from "../services/manual-detail-refresh";

const NOW = Date.UTC(2026, 8, 1, 10, 0, 0);

function shipment(provider: string, start = false): Shipment {
  return {
    identity: {
      id: "interface5:manual:SF1234567890",
      bindingSource: "interface5",
      sourceOwner: "manual",
      sourceId: "SF1234567890",
      phoneTail: "1234",
      courierCode: "SF",
      rawCourierCode: "SF",
      companyName: "顺丰速运",
      manuallyAdded: true,
      createdAtMs: NOW,
    },
    timeline: {
      provider,
      complete: false,
      waybill: "SF1234567890",
      courierCode: "SF",
      companyName: "顺丰速运",
      semantic: start ? "PICKED" : "TRANSIT",
      statusEventAtMs: NOW,
      latestTimeText: "2026-09-01 10:00:00",
      latestDetail: start ? "快件已揽收" : "运输中",
      tracks: [{
        timeText: "2026-09-01 10:00:00",
        timeMs: NOW,
        detail: start ? "快件已揽收" : "运输中",
        statusCode: start ? "1" : "",
        raw: start ? { statusCode: "1" } : {},
      }],
      successAtMs: NOW,
    },
    sourceTimeline: null,
    manualTimelines: [],
    updatedAtMs: NOW,
  };
}

const events: string[] = [];
let releaseMoto!: () => void;
const motoGate = new Promise<void>((resolve) => { releaseMoto = resolve; });
let unexpectedFallbackCalls = 0;
const concurrent = await runManualDetailSourceContest({
  queryMoto: async () => {
    events.push("moto:start");
    await motoGate;
    events.push("moto:end");
    return shipment("local");
  },
  queryKuaidi100: async () => {
    events.push("kuaidi100:start");
    releaseMoto();
    return shipment("web", true);
  },
  queryKdniao: async () => {
    unexpectedFallbackCalls++;
    return shipment("fallback");
  },
});
assert.deepEqual(events.slice(0, 2), ["moto:start", "kuaidi100:start"]);
assert.equal(concurrent.primarySuccessCount, 2);
assert.equal(concurrent.primaryReachedTimelineStart, true);
assert.equal(unexpectedFallbackCalls, 0);

let singleFailureFallbackCalls = 0;
const singleFailure = await runManualDetailSourceContest({
  queryMoto: async () => { throw new Error("moto unavailable"); },
  queryKuaidi100: async () => shipment("web", true),
  queryKdniao: async () => {
    singleFailureFallbackCalls++;
    return shipment("fallback");
  },
});
assert.equal(singleFailure.primarySuccessCount, 1);
assert.equal(singleFailureFallbackCalls, 0);

let partialFallbackCalls = 0;
const partialPrimaries = await runManualDetailSourceContest({
  queryMoto: async () => shipment("local"),
  queryKuaidi100: async () => shipment("web"),
  queryKdniao: async () => {
    partialFallbackCalls++;
    return shipment("fallback", true);
  },
});
assert.equal(partialPrimaries.primarySuccessCount, 2);
assert.equal(partialPrimaries.primaryReachedTimelineStart, false);
assert.equal(partialPrimaries.kdniaoAttempted, true);
assert.equal(partialFallbackCalls, 1);

let fallbackCalls = 0;
const bothFailed = await runManualDetailSourceContest({
  queryMoto: async () => null,
  queryKuaidi100: async () => { throw new Error("kuaidi100 unavailable"); },
  queryKdniao: async () => {
    fallbackCalls++;
    return shipment("fallback");
  },
});
assert.equal(bothFailed.primarySuccessCount, 0);
assert.equal(bothFailed.kdniaoAttempted, true);
assert.equal(fallbackCalls, 1);
assert.equal(bothFailed.kdniao.shipment?.timeline.provider, "fallback");

let cancelledFallbackCalls = 0;
await runManualDetailSourceContest({
  queryMoto: async () => null,
  queryKuaidi100: async () => null,
  queryKdniao: async () => {
    cancelledFallbackCalls++;
    return shipment("fallback");
  },
  canQueryKdniao: () => false,
});
assert.equal(cancelledFallbackCalls, 0);

let accumulatedFallbackCalls = 0;
const accumulatedStart = await runManualDetailSourceContest({
  queryMoto: async () => shipment("local"),
  queryKuaidi100: async () => shipment("web"),
  queryKdniao: async () => {
    accumulatedFallbackCalls++;
    return shipment("fallback");
  },
  hasAccumulatedTimelineStart: () => true,
});
assert.equal(accumulatedStart.primaryReachedTimelineStart, true);
assert.equal(accumulatedStart.kdniaoAttempted, false);
assert.equal(accumulatedFallbackCalls, 0);

console.log("manual detail source contest tests passed");
