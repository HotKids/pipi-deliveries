import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import {
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
} from "../services/shipment-policy";

const NOW = Date.UTC(2026, 8, 1, 10, 0, 0);

function timeline(
  provider: string,
  count: number,
  options: Readonly<{
    courierCode?: string;
    semantic?: TimelinePackage["semantic"];
    complete?: boolean;
    marker?: string;
  }> = {},
): TimelinePackage {
  const courierCode = options.courierCode || "SF";
  const semantic = options.semantic || "TRANSIT";
  const tracks = Array.from({ length: count }, (_, index) => ({
    timeText: `2026-09-01 ${String(10 - index).padStart(2, "0")}:00:00`,
    timeMs: NOW - index * 60 * 60 * 1_000,
    detail: `${provider} node ${index + 1}`,
    statusCode: "",
    raw: options.marker ? { _pipiKuaidi100Com: options.marker } : {},
  }));
  return {
    provider,
    complete: options.complete ?? count >= 2,
    waybill: courierCode === "JD" ? "JD1234567890" : "SF1234567890",
    courierCode,
    companyName: courierCode === "JD" ? "京东快递" : "顺丰速运",
    semantic,
    statusEventAtMs: tracks[0]?.timeMs || null,
    latestTimeText: tracks[0]?.timeText || "",
    latestDetail: tracks[0]?.detail || "",
    tracks,
    successAtMs: NOW,
  };
}

function baseShipment(options: Readonly<{
  manuallyAdded?: boolean;
  sourceProvider?: string;
  courierCode?: string;
  manuals: TimelinePackage[];
  source?: TimelinePackage | null;
}>): Shipment {
  const courierCode = options.courierCode || "SF";
  const source = options.source ?? null;
  return {
    identity: {
      id: `interface5:${options.manuallyAdded ? "manual" : "account"}:test`,
      bindingSource: "interface5",
      sourceOwner: options.manuallyAdded ? "manual" : "account",
      sourceId: "test",
      phoneTail: "1234",
      courierCode,
      rawCourierCode: courierCode,
      companyName: courierCode === "JD" ? "京东快递" : "顺丰速运",
      sourceProvider: options.sourceProvider,
      manuallyAdded: Boolean(options.manuallyAdded),
      createdAtMs: NOW,
    },
    timeline: source || options.manuals[0],
    sourceTimeline: source,
    manualTimelines: options.manuals,
    updatedAtMs: NOW,
  };
}

const local = timeline("local", 3, { complete: false });
const richerWeb = timeline("web", 5);
const manual = baseShipment({ manuallyAdded: true, manuals: [local, richerWeb] });
assert.equal(
  selectShipmentTimeline(manual).provider,
  "web",
  "without a Picker result, the Home row must use the Moto/K100 race winner",
);
assert.equal(selectShipmentDetailTimeline(manual).provider, "web");
assert.equal(selectShipmentDetailTimeline(manual).tracks.length, 5);

const sparseWeb = timeline("web", 2);
const richerLocal = baseShipment({ manuallyAdded: true, manuals: [local, sparseWeb] });
assert.equal(
  selectShipmentDetailTimeline(richerLocal).provider,
  "web",
  "a complete whole package must outrank a larger partial package",
);
assert.equal(selectShipmentDetailTimeline(richerLocal).tracks.length, 2);

const equalCompleteMoto = timeline("local", 2, { complete: true });
const equalCompleteK100 = timeline("kuaidi100_h5", 2, {
  complete: true,
  marker: "shunfeng",
});
const equalPrimary = baseShipment({
  manuallyAdded: true,
  manuals: [equalCompleteMoto, equalCompleteK100],
});
assert.equal(
  selectShipmentDetailTimeline(equalPrimary).provider,
  "local",
  "otherwise equal iOS primary packages use Moto before K100 H5",
);

const equalCompletePicker = timeline("route", 2, { complete: true });
const equalCompletePickerFirst = baseShipment({
  manuallyAdded: true,
  manuals: [equalCompleteMoto, equalCompleteK100, equalCompletePicker],
});
assert.equal(
  selectShipmentDetailTimeline(equalCompletePickerFirst).provider,
  "route",
  "otherwise equal complete packages use Picker before the primary round",
);
const equalCompleteShunFengPickerFirst = baseShipment({
  sourceProvider: "ShunFeng",
  manuals: [equalCompleteK100, equalCompletePicker],
  source: timeline("interface5", 1, { complete: false }),
});
assert.equal(
  selectShipmentDetailTimeline(equalCompleteShunFengPickerFirst).provider,
  "route",
  "otherwise equal ShunFeng detail packages use Picker before K100 H5",
);

const partialPicker = timeline("route", 1, { complete: false });
const newerPartialMoto = {
  ...timeline("local", 3, { complete: false }),
  statusEventAtMs: NOW + 60 * 60 * 1_000,
};
const newestPartialK100 = {
  ...timeline("kuaidi100_h5", 5, {
    complete: false,
    marker: "shunfeng",
  }),
  statusEventAtMs: NOW + 2 * 60 * 60 * 1_000,
};
const partialPickerFirst = baseShipment({
  manuallyAdded: true,
  manuals: [newestPartialK100, newerPartialMoto, partialPicker],
});
assert.equal(
  selectShipmentDetailTimeline(partialPickerFirst).provider,
  "route",
  "without a complete package, the first usable package in query order wins",
);

const account = timeline("interface5", 1, {
  semantic: "COMPLETED",
  complete: false,
});
const picker = timeline("route", 1, { complete: false });
const fallback = timeline("fallback", 7, { complete: true });
const shunFeng = baseShipment({
  sourceProvider: "ShunFeng",
  manuals: [picker, richerWeb, fallback],
  source: account,
});
assert.equal(selectShipmentTimeline(shunFeng).provider, "route");
assert.equal(
  selectShipmentDetailTimeline(shunFeng).provider,
  "web",
  "equal complete packages use the primary-source query order, not node count",
);
const shunFengFallback = { ...shunFeng, manualTimelines: [picker, fallback] };
assert.equal(selectShipmentDetailTimeline(shunFengFallback).provider, "fallback");

const jdAccount = timeline("interface5", 1, {
  courierCode: "JD",
  semantic: "COMPLETED",
  complete: false,
});
const jdLocal = timeline("local", 9, { courierCode: "JD" });
const jdKuaidi100 = timeline("kuaidi100_h5", 2, {
  courierCode: "JD",
  marker: "jd",
});
const jdFallback = timeline("fallback", 6, { courierCode: "JD" });
const jingDong = baseShipment({
  sourceProvider: "JingDong",
  courierCode: "JD",
  manuals: [jdLocal, jdKuaidi100, jdFallback],
  source: jdAccount,
});
assert.equal(
  selectShipmentTimeline(jingDong).provider,
  "kuaidi100_h5",
  "equal complete JD packages use K100 H5 before the final KDNiao fallback",
);
assert.equal(
  selectShipmentDetailTimeline(jingDong).provider,
  "kuaidi100_h5",
  "node count must not let the final fallback outrank an equal complete K100 H5 package",
);
const jingDongFallback = {
  ...jingDong,
  manualTimelines: [jdLocal, jdFallback],
};
assert.equal(selectShipmentDetailTimeline(jingDongFallback).provider, "fallback");

const jingDongPartialPicker = timeline("route", 1, {
  courierCode: "JD",
  complete: false,
});
const jingDongPartialKuaidi100 = timeline("kuaidi100_h5", 1, {
  courierCode: "JD",
  complete: false,
  marker: "jd",
});
const jingDongPickerFirst = {
  ...jingDong,
  manualTimelines: [jingDongPartialKuaidi100, jingDongPartialPicker],
};
assert.equal(
  selectShipmentDetailTimeline(jingDongPickerFirst).provider,
  "route",
  "a JD Picker package remains detail-only and wins equal partial packages before K100",
);

const jingDongCompleteKuaidi100 = timeline("kuaidi100_h5", 2, {
  courierCode: "JD",
  complete: true,
  marker: "jd",
});
const jingDongPartialFallbackWithStart = {
  ...timeline("fallback", 1, { courierCode: "JD", complete: false }),
  tracks: [{
    ...timeline("fallback", 1, { courierCode: "JD", complete: false }).tracks[0],
    detail: "京东订单已下单",
    statusCode: "101",
  }],
};
assert.equal(
  selectShipmentDetailTimeline({
    ...jingDong,
    manualTimelines: [
      jingDongCompleteKuaidi100,
      jingDongPartialFallbackWithStart,
    ],
  }).provider,
  "kuaidi100_h5",
  "start evidence gates calls but cannot let a partial fallback outrank a complete package",
);

const completeJdMoto = timeline("local", 2, {
  courierCode: "JD",
  complete: true,
});
const partialJdFallback = timeline("fallback", 1, {
  courierCode: "JD",
  complete: false,
});
assert.equal(
  selectShipmentDetailTimeline(baseShipment({
    manuallyAdded: true,
    courierCode: "JD",
    manuals: [partialJdFallback, completeJdMoto],
  })).provider,
  "local",
  "a JD carrier identity alone must not exclude Moto from a pure-manual detail",
);
assert.equal(
  selectShipmentDetailTimeline(baseShipment({
    sourceProvider: "CaiNiao",
    courierCode: "JD",
    manuals: [partialJdFallback, completeJdMoto],
    source: timeline("interface5", 1, {
      courierCode: "JD",
      complete: false,
    }),
  })).provider,
  "interface5",
  "a Cainiao-owned JD-carried parcel stays on its owner package despite stale manual sidecars",
);
assert.equal(
  selectShipmentDetailTimeline(baseShipment({
    sourceProvider: "Douyin",
    courierCode: "JD",
    manuals: [partialJdFallback, completeJdMoto],
    source: timeline("interface5", 1, {
      courierCode: "JD",
      complete: false,
    }),
  })).provider,
  "local",
  "an ordinary automatic JD-carried parcel must not be treated as a JingDong source",
);
assert.notEqual(
  selectShipmentDetailTimeline(baseShipment({
    sourceProvider: "JingDong",
    courierCode: "JD",
    manuals: [partialJdFallback, completeJdMoto],
    source: timeline("interface5", 1, {
      courierCode: "JD",
      complete: false,
    }),
  })).provider,
  "local",
  "a true JingDong business source must continue to exclude Moto",
);

console.log("manual detail timeline selection tests passed");
