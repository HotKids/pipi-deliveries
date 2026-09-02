import assert from "node:assert/strict";
import type { Shipment, TrackNode } from "../models";
import {
  hasPersistentTracking,
  MANUAL_SOURCE_ORDER,
  queryManualSourceChain,
  type ManualSource,
} from "../services/manual-query-order";
import { OperationTimeoutError } from "../services/deadline";

const NOW = Date.UTC(2026, 7, 29, 8, 0, 0);

function shipment(
  provider: ManualSource,
  options: Readonly<{
    tracked?: boolean;
    complete?: boolean;
    eventAtMs?: number;
    semantic?: Shipment["timeline"]["semantic"];
    start?: "ordered" | "picked";
  }> = {},
): Shipment {
  const tracked = options.tracked !== false;
  const eventAtMs = options.eventAtMs ?? NOW;
  const track: TrackNode = {
    timeText: new Date(eventAtMs).toISOString(),
    timeMs: eventAtMs,
    detail: options.start === "ordered"
      ? "快递已下单"
      : options.start === "picked"
        ? "快件已揽收"
        : options.semantic === "COMPLETED"
          ? "快件已签收"
          : "快件运输中",
    statusCode: options.start === "ordered"
      ? "101"
      : options.start === "picked"
        ? "1"
        : options.semantic === "COMPLETED" ? "311" : "104",
    raw: {},
  };
  return {
    identity: {
      id: "interface5:manual:SF1226181467773",
      bindingSource: "interface5",
      sourceOwner: "manual",
      sourceId: "SF1226181467773",
      phoneTail: "8000",
      courierCode: "SF",
      companyName: "顺丰速运",
      manuallyAdded: true,
      createdAtMs: NOW,
    },
    timeline: {
      provider,
      complete: options.complete,
      waybill: "SF1226181467773",
      courierCode: "SF",
      companyName: "顺丰速运",
      semantic: tracked ? options.semantic || "TRANSIT" : "UNKNOWN",
      statusEventAtMs: tracked ? eventAtMs : null,
      latestTimeText: tracked ? track.timeText : "",
      latestDetail: tracked ? track.detail : "",
      tracks: tracked ? [track] : [],
      successAtMs: NOW,
    },
    sourceTimeline: null,
    manualTimelines: [],
    route: null,
    updatedAtMs: NOW,
  };
}

assert.deepEqual(MANUAL_SOURCE_ORDER, ["local", "route", "fallback"]);
assert.equal(hasPersistentTracking(shipment("local", { tracked: false })), false);

const concurrentEvents: string[] = [];
let releaseLocal!: () => void;
const localGate = new Promise<void>((resolve) => { releaseLocal = resolve; });
const concurrent = queryManualSourceChain([
  {
    source: "local",
    enabled: true,
    query: async () => {
      concurrentEvents.push("local:start");
      await localGate;
      concurrentEvents.push("local:end");
      return { shipment: shipment("local", { complete: true }) };
    },
  },
  {
    source: "route",
    enabled: true,
    query: async () => {
      concurrentEvents.push("route:start");
      releaseLocal();
      return { shipment: shipment("route") };
    },
  },
]);
const concurrentResult = await concurrent;
assert.deepEqual(concurrentEvents.slice(0, 2), ["local:start", "route:start"]);
assert.equal(concurrentResult.selected?.timeline.provider, "local");

let fallbackCalls = 0;
const partial = await queryManualSourceChain([
  {
    source: "local",
    enabled: true,
    query: async () => ({ shipment: shipment("local", { complete: false }) }),
  },
  {
    source: "route",
    enabled: true,
    query: async () => ({ shipment: shipment("route", { complete: false }) }),
  },
  {
    source: "fallback",
    enabled: true,
    query: async () => {
      fallbackCalls++;
      return { shipment: shipment("fallback", { complete: true }) };
    },
  },
]);
assert.equal(fallbackCalls, 1);
assert.equal(
  partial.selected?.timeline.provider,
  "fallback",
  "a complete whole package must outrank earlier partial packages",
);
assert.deepEqual(
  partial.successes.map((item) => item.timeline.provider),
  ["fallback", "route", "local"],
);

let skippedFallbackCalls = 0;
await queryManualSourceChain([
  {
    source: "local",
    enabled: true,
    query: async () => ({
      shipment: shipment("local", { complete: false, start: "picked" }),
    }),
  },
  {
    source: "fallback",
    enabled: true,
    query: async () => {
      skippedFallbackCalls++;
      return { shipment: shipment("fallback", { complete: true }) };
    },
  },
]);
assert.equal(skippedFallbackCalls, 0);

let orderedFallbackCalls = 0;
await queryManualSourceChain([
  {
    source: "route",
    enabled: true,
    query: async () => ({
      shipment: shipment("route", { start: "ordered" }),
    }),
  },
  {
    source: "fallback",
    enabled: true,
    query: async () => {
      orderedFallbackCalls++;
      return { shipment: shipment("fallback", { complete: true }) };
    },
  },
]);
assert.equal(orderedFallbackCalls, 0);

let routeFirstLocalCalls = 0;
let routeFirstFallbackCalls = 0;
const routeFirst = await queryManualSourceChain([
  {
    source: "local",
    enabled: true,
    query: async () => {
      routeFirstLocalCalls++;
      return { shipment: shipment("local") };
    },
  },
  {
    source: "route",
    enabled: true,
    query: async () => ({ shipment: shipment("route") }),
  },
  {
    source: "fallback",
    enabled: true,
    query: async () => {
      routeFirstFallbackCalls++;
      return { shipment: shipment("fallback") };
    },
  },
], undefined, undefined, undefined, () => true, true);
assert.equal(routeFirst.selected?.timeline.provider, "route");
assert.equal(routeFirstLocalCalls, 0);
assert.equal(routeFirstFallbackCalls, 0);

const routeOnly = await queryManualSourceChain([{
  source: "route",
  enabled: true,
  query: async () => ({
    shipment: shipment("route", { tracked: false }),
    routeUrl: "https://m.kuaidi100.com/result.jsp?nu=SF1226181467773",
  }),
}]);
assert.equal(routeOnly.selected?.timeline.provider, "route");
assert.match(routeOnly.selectedRouteUrl, /^https:\/\/m\.kuaidi100\.com\//);
assert.deepEqual(routeOnly.successes, []);

await assert.rejects(
  queryManualSourceChain([{
    source: "local",
    enabled: true,
    query: async () => { throw new OperationTimeoutError(); },
  }]),
  /请求超时/,
);

const controller = new AbortController();
let cancelledFallbackCalls = 0;
await assert.rejects(
  queryManualSourceChain([
    {
      source: "local",
      enabled: true,
      query: async () => {
        controller.abort();
        return { shipment: shipment("local") };
      },
    },
    {
      source: "fallback",
      enabled: true,
      query: async () => {
        cancelledFallbackCalls++;
        return { shipment: shipment("fallback") };
      },
    },
  ], undefined, undefined, controller.signal),
  /请求超时/,
);
assert.equal(cancelledFallbackCalls, 0);

console.log("manual source chain tests passed");
