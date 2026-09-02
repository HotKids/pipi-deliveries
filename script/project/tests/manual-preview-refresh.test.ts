import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import { manualPreviewNeedsDetailRefresh } from "../services/manual-preview";

const NOW = Date.UTC(2026, 8, 1, 10, 0, 0);

function timeline(
  provider: string,
  count: number,
  pickupIndex: number | null = null,
): TimelinePackage {
  const tracks = Array.from({ length: count }, (_, index) => ({
    timeText: `2026-09-01 ${String(10 - index).padStart(2, "0")}:00:00`,
    timeMs: NOW - index * 60 * 60 * 1_000,
    detail: index === pickupIndex ? "快件已揽收" : `${provider} node ${index + 1}`,
    statusCode: index === pickupIndex ? "1" : "",
    raw: index === pickupIndex ? { statusCode: "1" } : {},
  }));
  return {
    provider,
    complete: false,
    waybill: "SF1234567890",
    courierCode: "SF",
    companyName: "顺丰速运",
    semantic: "TRANSIT",
    statusEventAtMs: tracks[0]?.timeMs || null,
    latestTimeText: tracks[0]?.timeText || "",
    latestDetail: tracks[0]?.detail || "",
    tracks,
    successAtMs: NOW,
  };
}

function orderedTimeline(provider: string): TimelinePackage {
  const value = timeline(provider, 1);
  return {
    ...value,
    tracks: [{
      ...value.tracks[0],
      detail: "快递已下单",
      statusCode: "101",
      raw: { statusCode: "101" },
    }],
  };
}

function shipment(
  selected: TimelinePackage,
  options: Readonly<{
    manuallyAdded?: boolean;
    sourceProvider?: string;
    source?: TimelinePackage | null;
    manuals?: TimelinePackage[];
  }> = {},
): Shipment {
  const manuallyAdded = options.manuallyAdded ?? true;
  const source = options.source ?? (manuallyAdded ? null : selected);
  return {
    identity: {
      id: `interface5:${manuallyAdded ? "manual" : "account"}:test`,
      bindingSource: "interface5",
      sourceOwner: manuallyAdded ? "manual" : "account",
      sourceId: "test",
      phoneTail: "1234",
      courierCode: "SF",
      rawCourierCode: "SF",
      companyName: "顺丰速运",
      sourceProvider: options.sourceProvider,
      manuallyAdded,
      createdAtMs: NOW,
    },
    timeline: selected,
    sourceTimeline: source,
    manualTimelines: options.manuals ?? (manuallyAdded ? [selected] : []),
    updatedAtMs: NOW,
  };
}

assert.equal(manualPreviewNeedsDetailRefresh(null), true);
assert.equal(
  manualPreviewNeedsDetailRefresh(shipment(timeline("route", 1))),
  true,
  "a Picker status without pickup history still needs background enrichment",
);
assert.equal(
  manualPreviewNeedsDetailRefresh(shipment(timeline("route", 1, 0))),
  false,
  "one Picker pickup event is enough to open directly",
);
assert.equal(
  manualPreviewNeedsDetailRefresh(shipment(orderedTimeline("route"))),
  false,
  "one Picker order event is also enough to open directly",
);

const cachedSource = timeline("interface5", 21, 20);
assert.equal(
  manualPreviewNeedsDetailRefresh(shipment(cachedSource, {
    manuallyAdded: false,
    sourceProvider: "ShunFeng",
    source: cachedSource,
  })),
  false,
  "a cached source history containing pickup must not start a redundant detail contest",
);
assert.equal(
  manualPreviewNeedsDetailRefresh(shipment(timeline("interface5", 21), {
    manuallyAdded: false,
    sourceProvider: "ShunFeng",
  })),
  true,
  "many later events without pickup evidence must still request enrichment",
);

console.log("manual preview detail refresh tests passed");
