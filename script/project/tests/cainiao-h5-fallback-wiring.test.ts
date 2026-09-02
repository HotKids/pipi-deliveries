import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Shipment, TimelinePackage } from "../models";
import {
  activateCainiaoManualFallback,
  cainiaoAutomaticNeedsH5Supplement,
  selectShipmentDetailTimeline,
} from "../services/shipment-policy";

const NOW = Date.parse("2026-09-02T10:00:00+08:00");

function timeline(
  semantic: TimelinePackage["semantic"],
  detail: string,
  statusCode: string,
): TimelinePackage {
  return {
    provider: "interface5",
    complete: true,
    waybill: "784300000001",
    courierCode: "ZTO",
    companyName: "中通快递",
    semantic,
    statusEventAtMs: NOW,
    latestTimeText: "2026-09-02 10:00:00",
    latestDetail: detail,
    tracks: [{
      timeText: "2026-09-02 10:00:00",
      timeMs: NOW,
      detail,
      statusCode,
      raw: { statusCode, _pipiStatusSource: "interface5" },
    }],
    successAtMs: NOW,
  };
}

function shipment(sourceTimeline: TimelinePackage): Shipment {
  return {
    identity: {
      id: "interface5:account:784300000001",
      bindingSource: "interface5",
      sourceOwner: "interface5",
      sourceId: "784300000001",
      phoneTail: "1234",
      courierCode: "ZTO",
      companyName: "中通快递",
      sourceProvider: "CaiNiao",
      accountOrder: false,
      manuallyAdded: false,
      createdAtMs: NOW,
    },
    timeline: sourceTimeline,
    sourceTimeline,
    manualTimelines: [],
    route: { kind: "cainiao", source: "interface5" },
    accountRecord: null,
    updatedAtMs: NOW,
  };
}

const transitOnly = shipment(timeline("TRANSIT", "运输中", "2"));
assert.equal(
  cainiaoAutomaticNeedsH5Supplement(transitOnly),
  true,
  "a stateful Cainiao owner missing its pickup stage must request its own H5",
);

const picked = timeline("PICKED", "快件已揽收", "1");
assert.equal(
  cainiaoAutomaticNeedsH5Supplement(shipment(picked)),
  false,
  "a Cainiao source timeline containing pickup evidence must stay authoritative",
);

const empty = shipment({
  ...transitOnly.timeline,
  semantic: "UNKNOWN",
  statusEventAtMs: null,
  latestTimeText: "",
  latestDetail: "",
  tracks: [],
});
assert.equal(
  cainiaoAutomaticNeedsH5Supplement(empty),
  false,
  "an empty owner response is not the stateful missing-pickup partition",
);
assert.equal(
  cainiaoAutomaticNeedsH5Supplement({
    ...empty,
    timeline: { ...empty.timeline, semantic: "TRANSIT" },
    sourceTimeline: { ...empty.sourceTimeline!, semantic: "TRANSIT" },
  }),
  true,
  "a known Cainiao state with no pickup track still needs its own H5",
);
assert.equal(
  cainiaoAutomaticNeedsH5Supplement({
    ...transitOnly,
    identity: { ...transitOnly.identity, manuallyAdded: true },
  }),
  false,
  "manual shipments never enter the Cainiao automatic H5 gate",
);

const cainiaoH5: TimelinePackage = {
  ...timeline("TRANSIT", "快件运输中", "2"),
  provider: "cainiao_h5",
  complete: false,
};
const staleManual = {
  ...timeline("COMPLETED", "已签收", "5"),
  provider: "kdniao",
};
assert.equal(
  selectShipmentDetailTimeline({
    ...transitOnly,
    manualTimelines: [staleManual],
  }).provider,
  "interface5",
  "a missing pickup stage alone must not let a stale manual sidecar bypass Cainiao H5",
);
assert.equal(
  selectShipmentDetailTimeline(activateCainiaoManualFallback({
    ...transitOnly,
    manualTimelines: [staleManual],
  }, NOW + 1)).provider,
  "kdniao",
  "manual sidecars become eligible only after this shipment's Cainiao H5 failed",
);
assert.equal(
  selectShipmentDetailTimeline({
    ...transitOnly,
    manualTimelines: [
      cainiaoH5,
      { ...timeline("COMPLETED", "已签收", "5"), provider: "kdniao" },
    ],
  }).provider,
  "cainiao_h5",
  "a successful same-owner Cainiao H5 stays above every later manual package",
);

const sync = readFileSync(
  new URL("../services/sync.ts", import.meta.url),
  "utf8",
);
assert.match(
  sync,
  /const cainiaoH5Requested = explicitTimelineRefresh &&[\s\S]*?cainiaoAutomaticNeedsH5Supplement\(enrichmentBase\)[\s\S]*?await refreshCainiaoH5\([\s\S]*?cainiaoH5Succeeded = true;[\s\S]*?const cainiaoManualFallbackRequested = cainiaoH5Requested &&[\s\S]*?!cainiaoH5Succeeded;[\s\S]*?const pickerSupplementRequested =[\s\S]*?cainiaoManualFallbackRequested[\s\S]*?if \(pickerSupplementRequested\)/,
  "Cainiao must finish its gated automatic H5 before the ordinary manual chain may start",
);
assert.match(
  sync,
  /const ordinaryAutomaticPrimaryRequested =[\s\S]*?cainiaoManualFallbackRequested[\s\S]*?!hasTimelineStartBeforeKdniao\(enrichmentBase\)[\s\S]*?runManualDetailSourceContest\(/,
  "a failed Cainiao H5 must reuse Picker, Moto plus K100 H5, then gated KDNiao",
);
assert.doesNotMatch(
  sync,
  /h5Kind === "cainiao"/,
  "Cainiao automatic H5 must not remain inside the manual H5 provider contest",
);

console.log("Cainiao automatic H5 fallback wiring tests passed");
