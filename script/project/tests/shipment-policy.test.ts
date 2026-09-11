import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import {
  activeManualRefreshLease,
  absorbHistoricalShipment,
  applyAccountShipment,
  applyManualShipment,
  applySameSourceTimeline,
  applyTargetedAccountShipment,
  asAccountDetailObservation,
  beginManualRefreshAttempt,
  displayWaybill,
  hasCachedKdniaoTimeline,
  hasCachedTimelineBeforeKdniao,
  hasSettledTimelineHistory,
  isCompletedUnprojectedAccountOrder,
  isFrozenJingDongShipment,
  isHistoricalAccountDuplicate,
  isJingDongCarrierShipment,
  jingDongAutomaticH5TimelineAvailable,
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  manualTimelineOwnsShipment,
  needsAutomaticManualFallback,
  needsDetailFallback,
  ownsManualRefreshLease,
  releaseManualRefreshLease,
  selectShipmentDetailTimeline,
  selectShipmentTimeline,
  shouldScheduleManualRefresh,
  sourceTimelineOwnsShipment,
  unprojectedAccountOrder,
  usesManualSourceQuery,
} from "../services/shipment-policy";
import { buildWidgetSnapshot } from "../services/status";

const NOW = Date.UTC(2026, 7, 26, 8, 0, 0);

function timeline(
  provider: string,
  waybill: string,
  semantic: TimelinePackage["semantic"],
): TimelinePackage {
  return {
    provider,
    waybill,
    courierCode: "JD",
    companyName: "京东购物",
    semantic,
    statusEventAtMs: NOW,
    latestTimeText: "2026-08-26 16:00:00",
    latestDetail: semantic,
    tracks: [
      {
        timeText: "2026-08-26 16:00:00",
        timeMs: NOW,
        detail: semantic,
        statusCode: semantic === "COMPLETED" ? "3" : "101",
        raw: {},
      },
    ],
    successAtMs: NOW,
  };
}

function order(
  projectedWaybill: string,
  companyName: string,
  courierCode: string,
  route: Shipment["route"],
): Shipment {
  const source = timeline("interface5", "ORDER123456", "ORDERED");
  return {
    identity: {
      id: "interface5:account:ORDER123456",
      bindingSource: "interface5",
      sourceOwner: "interface5:order",
      sourceId: "ORDER123456",
      phoneTail: "1515",
      phone: "13800001515",
      courierCode,
      rawCourierCode: courierCode,
      companyName,
      sourceProvider: "account-order",
      orderId: "ORDER123456",
      projectedWaybill,
      accountOrder: true,
      manuallyAdded: false,
      createdAtMs: NOW - 60_000,
    },
    timeline: source,
    sourceTimeline: source,
    manualTimelines: [],
    route,
    accountRecord: null,
    updatedAtMs: NOW,
  };
}

assert.equal(isJingDongCarrierShipment(order(
  "JDVD1234567890",
  "上游原始名称",
  "JDVD",
  null,
)), true, "raw JD* cpCode participates in JD carrier policy without changing source");

const current = order(
  "SF1234567890",
  "顺丰速运",
  "SF",
  null,
);
const partialMotoTimeline: TimelinePackage = {
  ...timeline("local", "SF1234567890", "TRANSIT"),
  complete: false,
  tracks: [
    ...timeline("local", "SF1234567890", "TRANSIT").tracks,
    {
      timeText: "2026-08-26 15:00:00",
      timeMs: NOW - 60 * 60 * 1_000,
      detail: "PICKED",
      statusCode: "1",
      raw: {},
    },
  ],
};
const partialManualShipment: Shipment = {
  ...current,
  identity: {
    ...current.identity,
    id: "interface5:manual:SF1234567890",
    sourceOwner: "manual",
    sourceId: "SF1234567890",
    accountOrder: false,
    manuallyAdded: true,
  },
  timeline: partialMotoTimeline,
  sourceTimeline: null,
  manualTimelines: [partialMotoTimeline],
  statusPresentation: undefined,
};
const meizuPickerTimeline: TimelinePackage = {
  ...timeline("route", "SF1234567890", "PICKED"),
  complete: false,
};
const manualWithMeizuPicker: Shipment = {
  ...partialManualShipment,
  timeline: meizuPickerTimeline,
  manualTimelines: [
    partialMotoTimeline,
    meizuPickerTimeline,
    {
      ...timeline("web", "SF1234567890", "COMPLETED"),
      complete: true,
      tracks: [
        ...timeline("web", "SF1234567890", "COMPLETED").tracks,
        {
          ...timeline("web", "SF1234567890", "TRANSIT").tracks[0]!,
          timeText: "2026-08-26 15:00:00",
          timeMs: NOW - 60 * 60 * 1_000,
          detail: "TRANSIT",
        },
        {
          ...timeline("web", "SF1234567890", "PICKED").tracks[0]!,
          timeText: "2026-08-26 14:00:00",
          timeMs: NOW - 2 * 60 * 60 * 1_000,
          detail: "PICKED",
          statusCode: "1",
        },
      ],
    },
  ],
};
// 用户定 2026-09-05：手动件的首页头条跟详情同一套选包，不再由 picker 独占。
assert.equal(
  selectShipmentTimeline(manualWithMeizuPicker).provider,
  "web",
  "a manual Home row follows the same detail ranking (complete → coverage → tier → order)",
);
assert.equal(
  selectShipmentDetailTimeline(manualWithMeizuPicker).provider,
  "web",
  "manual detail history must still use the more complete Moto/K100 race result",
);
assert.equal(
  needsDetailFallback(partialManualShipment),
  false,
  "a pickup event suppresses the next interface even when the provider marks the package partial",
);
const missingStartTimeline: TimelinePackage = {
  ...partialMotoTimeline,
  tracks: [{
    ...partialMotoTimeline.tracks[0],
    detail: "快件运输中",
    statusCode: "104",
    raw: { statusCode: "104" },
  }],
};
assert.equal(
  needsDetailFallback({
    ...partialManualShipment,
    timeline: missingStartTimeline,
    manualTimelines: [missingStartTimeline],
  }),
  true,
  "a partial package without an order or pickup event still needs the next interface",
);
const completeWebTimeline: TimelinePackage = {
  ...partialMotoTimeline,
  provider: "web",
  complete: true,
};
assert.equal(
  needsDetailFallback({
    ...partialManualShipment,
    timeline: completeWebTimeline,
    manualTimelines: [partialMotoTimeline, completeWebTimeline],
  }),
  false,
  "a complete higher-priority package suppresses the final fallback",
);
// 完整的 K100 H5 抓取在实盘里一定带揽收节点——「完整」的判据是揽收 + 时间一致，
// 不是包自称的 complete 标志（用户定 2026-09-04）。
const firstHiddenWebIncrement: TimelinePackage = {
  ...timeline("web", "SF1234567890", "COMPLETED"),
  complete: true,
  tracks: [
    ...timeline("web", "SF1234567890", "COMPLETED").tracks,
    {
      ...timeline("web", "SF1234567890", "TRANSIT").tracks[0]!,
      timeText: "2026-08-26 14:30:00",
      timeMs: NOW - 90 * 60 * 1_000,
      detail: "TRANSIT",
    },
    {
      ...timeline("web", "SF1234567890", "PICKED").tracks[0]!,
      timeText: "2026-08-26 14:00:00",
      timeMs: NOW - 2 * 60 * 60 * 1_000,
      detail: "PICKED",
      statusCode: "1",
    },
  ],
};
const manualWithHiddenWeb = applySameSourceTimeline(
  partialManualShipment,
  firstHiddenWebIncrement,
  NOW + 1,
);
assert.equal(manualWithHiddenWeb.timeline.provider, "web");
assert.equal(
  selectShipmentDetailTimeline(manualWithHiddenWeb).provider,
  "web",
  "a complete hidden H5 package must outrank a partial local package in detail",
);
assert.equal(
  manualWithHiddenWeb.manualTimelines?.find(
    (item) => item.provider === "web",
  )?.tracks.length,
  3,
  "a hidden K100 H5 result must be persisted for a manually added shipment",
);
const earlierHiddenWebIncrement: TimelinePackage = {
  ...timeline("web", "SF1234567890", "PICKED"),
  complete: false,
  latestTimeText: "2026-08-26 15:00:00",
  latestDetail: "PICKED",
  statusEventAtMs: NOW - 60 * 60 * 1_000,
  tracks: [{
    ...timeline("web", "SF1234567890", "PICKED").tracks[0]!,
    timeText: "2026-08-26 15:00:00",
    timeMs: NOW - 60 * 60 * 1_000,
    detail: "PICKED",
  }],
  successAtMs: NOW + 2,
};
const incrementallyMergedHiddenWeb = applySameSourceTimeline(
  manualWithHiddenWeb,
  earlierHiddenWebIncrement,
  NOW + 2,
);
assert.equal(incrementallyMergedHiddenWeb.timeline.provider, "web");
assert.equal(incrementallyMergedHiddenWeb.timeline.semantic, "COMPLETED");
assert.equal(
  incrementallyMergedHiddenWeb.manualTimelines?.find(
    (item) => item.provider === "web",
  )?.tracks.length,
  4,
  "hidden K100 H5 responses must merge into their own durable history",
);
const shunFengWithHiddenWeb: Shipment = {
  ...current,
  identity: {
    ...current.identity,
    sourceProvider: "ShunFeng",
  },
  timeline: firstHiddenWebIncrement,
  sourceTimeline: timeline("interface5", "SF1234567890", "TRANSIT"),
  manualTimelines: [firstHiddenWebIncrement],
};
assert.equal(selectShipmentTimeline(shunFengWithHiddenWeb).provider, "web",
  "SF Home uses the same manual K100 package as detail (user decision 2026-09-09)");
assert.equal(selectShipmentDetailTimeline(shunFengWithHiddenWeb).provider, "web");
assert.equal(
  needsDetailFallback(shunFengWithHiddenWeb),
  false,
  "a hidden K100 history returned by Meizu must satisfy the SF detail chain",
);
current.sourceTimeline = timeline("interface5", "ORDER123456", "COMPLETED");
current.timeline = current.sourceTimeline;
const summary = order("", "京东购物", "JD", null);
const completedUnprojected = {
  ...summary,
  timeline: timeline("interface5", "ORDER123456", "COMPLETED"),
  sourceTimeline: timeline("interface5", "ORDER123456", "COMPLETED"),
};
const visibleUnprojected = applyAccountShipment(
  undefined,
  completedUnprojected,
  NOW,
);
assert.equal(visibleUnprojected.sourceTimeline?.semantic, "COMPLETED");
assert.equal(visibleUnprojected.timeline.semantic, "COMPLETED");
assert.equal(
  buildWidgetSnapshot([visibleUnprojected], NOW).rows[0]?.semantic,
  "COMPLETED",
);
const noTimedUnprojected = applyAccountShipment(undefined, {
  ...summary,
  timeline: {
    ...summary.timeline,
    semantic: "COMPLETED",
    tracks: [],
    statusEventAtMs: null,
    latestTimeText: "",
  },
  sourceTimeline: {
    ...summary.timeline,
    semantic: "COMPLETED",
    tracks: [],
    statusEventAtMs: null,
    latestTimeText: "",
  },
}, NOW);
assert.equal(noTimedUnprojected.timeline.semantic, "COMPLETED");
const anonymousOrderDetailTimeline = {
  ...timeline("interface5", summary.identity.sourceId, "TRANSIT"),
  courierCode: "JD",
  companyName: "京东购物",
};
const anonymousOrderDetail: Shipment = {
  ...summary,
  identity: {
    ...summary.identity,
    accountOrder: false,
    projectedWaybill: "",
  },
  timeline: anonymousOrderDetailTimeline,
  sourceTimeline: anonymousOrderDetailTimeline,
};
const afterAnonymousDetail = applyTargetedAccountShipment(
  summary,
  anonymousOrderDetail,
  NOW + 30_000,
);
assert.equal(afterAnonymousDetail.identity.projectedWaybill, "");
assert.equal(unprojectedAccountOrder(afterAnonymousDetail), true);
const orderPresentation = {
  scope: "ORDER" as const,
  semantic: "COMPLETED" as const,
  text: "订单已完成",
};
const completedOrderWithRetry: Shipment = {
  ...summary,
  statusPresentation: orderPresentation,
  identity: {
    ...summary.identity,
    orderProjectionRetry: {
      routeHash: "a".repeat(64),
      attemptId: "projection-completed-order",
      attemptExpiresAtMs: NOW + 60_000,
    },
  },
};
assert.equal(isCompletedUnprojectedAccountOrder(completedOrderWithRetry), true);
assert.equal(isFrozenJingDongShipment(completedOrderWithRetry), false);
const signedCompletedTimeline = {
  ...summary.timeline,
  waybill: "JD0256747737308",
  companyName: "京东快递",
  semantic: "COMPLETED" as const,
  latestDetail: "已签收",
};
const signedCompletedProjection: Shipment = {
  ...summary,
  statusPresentation: undefined,
  identity: {
    ...summary.identity,
    projectedWaybill: "JD0256747737308",
    companyName: "京东快递",
  },
  timeline: signedCompletedTimeline,
  sourceTimeline: signedCompletedTimeline,
};
const mappedCompletedOrder = applyAccountShipment(
  completedOrderWithRetry,
  signedCompletedProjection,
  NOW + 1,
);
assert.equal(mappedCompletedOrder.identity.projectedWaybill, "JD0256747737308");
assert.equal(mappedCompletedOrder.timeline.semantic, "COMPLETED");
assert.equal(mappedCompletedOrder.statusPresentation, undefined);
assert.equal(mappedCompletedOrder.identity.orderProjectionRetry, undefined);
const misclassifiedShortOrder: Shipment = {
  ...summary,
  identity: {
    ...summary.identity,
    id: "interface5:account:350365030147",
    sourceOwner: "interface5",
    sourceId: "350365030147",
    orderId: "",
    accountOrder: false,
    courierCode: "JD",
    companyName: "京东快递",
    sourceProvider: "JingDong",
  },
  timeline: {
    ...timeline("interface5", "350365030147", "COMPLETED"),
    latestDetail: "您的订单350365030147已完成",
  },
  sourceTimeline: {
    ...timeline("interface5", "350365030147", "COMPLETED"),
    latestDetail: "您的订单350365030147已完成",
  },
  manualTimelines: [timeline("kdniao", "350365030147", "COMPLETED")],
};
const correctedShortOrder = applyAccountShipment(
  misclassifiedShortOrder,
  {
    ...misclassifiedShortOrder,
    identity: {
      ...misclassifiedShortOrder.identity,
      sourceOwner: "interface5:order",
      orderId: "350365030147",
      accountOrder: true,
      companyName: "京东购物",
    },
    timeline: {
      ...misclassifiedShortOrder.timeline,
      companyName: "京东购物",
      semantic: "ORDERED",
    },
    sourceTimeline: {
      ...misclassifiedShortOrder.sourceTimeline!,
      companyName: "京东购物",
      semantic: "ORDERED",
    },
    manualTimelines: [],
  },
  NOW + 1,
);
assert.equal(correctedShortOrder.identity.accountOrder, true);
assert.equal(correctedShortOrder.identity.orderId, "350365030147");
assert.equal(correctedShortOrder.identity.companyName, "京东购物");
assert.equal(correctedShortOrder.timeline.semantic, "COMPLETED");
assert.deepEqual(correctedShortOrder.manualTimelines, []);
const mappedJingDongCompletion = {
  ...mappedCompletedOrder,
  identity: {
    ...mappedCompletedOrder.identity,
    sourceProvider: "JingDong",
  },
};
const protectedMappedJingDong = applyAccountShipment(
  mappedJingDongCompletion,
  {
    ...completedOrderWithRetry,
    identity: {
      ...completedOrderWithRetry.identity,
      sourceProvider: "JingDong",
    },
  },
  NOW + 2,
);
assert.equal(protectedMappedJingDong.identity.projectedWaybill, "JD0256747737308");
assert.equal(protectedMappedJingDong.sourceTimeline?.latestDetail, "已签收");
assert.equal(protectedMappedJingDong.timeline.semantic, "COMPLETED");
assert.equal(protectedMappedJingDong.statusPresentation, undefined);
const refreshedCompletedOrder = applyAccountShipment(
  completedOrderWithRetry,
  { ...summary, statusPresentation: orderPresentation },
  NOW + 2,
);
assert.equal(
  refreshedCompletedOrder.identity.orderProjectionRetry,
  completedOrderWithRetry.identity.orderProjectionRetry,
  "an order summary must not cancel an active projection attempt",
);
assert.equal(
  isCompletedUnprojectedAccountOrder(signedCompletedProjection),
  false,
  "an already confirmed carrier waybill remains authoritative",
);
const afterDetailWithoutSidecar = applyTargetedAccountShipment(
  { ...summary, statusPresentation: orderPresentation },
  { ...anonymousOrderDetail, statusPresentation: undefined },
  NOW + 35_000,
);
assert.deepEqual(
  afterDetailWithoutSidecar.statusPresentation,
  orderPresentation,
  "account detail must retain the list presentation for the same order",
);
const afterRealProjection = applyAccountShipment(
  afterAnonymousDetail,
  {
    ...summary,
    identity: {
      ...summary.identity,
      projectedWaybill: "SFREALPROJECTED001",
      courierCode: "SF",
      companyName: "顺丰速运",
    },
    timeline: {
      ...summary.timeline,
      waybill: "SFREALPROJECTED001",
      courierCode: "SF",
      companyName: "顺丰速运",
    },
  },
  NOW + 40_000,
);
assert.equal(afterRealProjection.identity.projectedWaybill, "SFREALPROJECTED001");
assert.equal(unprojectedAccountOrder(afterRealProjection), false);
assert.equal(
  applyAccountShipment(
    afterDetailWithoutSidecar,
    {
      ...summary,
      statusPresentation: undefined,
      identity: {
        ...summary.identity,
        projectedWaybill: "JD0256747737308",
      },
      timeline: {
        ...summary.timeline,
        waybill: "JD0256747737308",
      },
    },
    NOW + 45_000,
  ).statusPresentation,
  undefined,
  "a real waybill projection must replace the order-completed fallback",
);
const afterJdProjection = applyAccountShipment(
  summary,
  {
    ...summary,
    identity: {
      ...summary.identity,
      projectedWaybill: "JD0256747737308",
      courierCode: "JD",
      companyName: "京东快递",
    },
    timeline: {
      ...summary.timeline,
      waybill: "JD0256747737308",
    },
  },
  NOW + 50_000,
);
assert.equal(afterJdProjection.identity.companyName, "京东快递");
assert.equal(afterJdProjection.identity.courierCode, "JD");
const jdProjectionAfterSummaryRefresh = applyAccountShipment(
  afterJdProjection,
  summary,
  NOW + 55_000,
);
assert.equal(jdProjectionAfterSummaryRefresh.identity.companyName, "京东快递");
assert.equal(jdProjectionAfterSummaryRefresh.identity.projectedWaybill, "JD0256747737308");
const projectionRetry = {
  routeHash: "c".repeat(64),
  failedAtMs: NOW + 1,
};
const unprojectedWithRetry: Shipment = {
  ...summary,
  identity: {
    ...summary.identity,
    orderProjectionRetry: projectionRetry,
  },
};
const retryAfterSummaryRefresh = applyAccountShipment(
  unprojectedWithRetry,
  summary,
  NOW + 56_000,
);
assert.deepEqual(
  retryAfterSummaryRefresh.identity.orderProjectionRetry,
  projectionRetry,
);
const retryAfterProjection = applyAccountShipment(
  retryAfterSummaryRefresh,
  {
    ...summary,
    identity: {
      ...summary.identity,
      projectedWaybill: "JD0256747737308",
      courierCode: "JD",
      companyName: "京东购物",
    },
    timeline: {
      ...summary.timeline,
      waybill: "JD0256747737308",
    },
  },
  NOW + 57_000,
);
assert.equal(retryAfterProjection.identity.orderProjectionRetry, undefined);
const merged = applyAccountShipment(current, summary, NOW + 60_000);
assert.equal(merged.identity.projectedWaybill, "SF1234567890");
assert.equal(displayWaybill(merged), "SF1234567890");
assert.equal(merged.identity.companyName, "顺丰速运");
assert.equal(merged.identity.courierCode, "SF");
assert.deepEqual(merged.route, current.route);
assert.equal(merged.identity.createdAtMs, current.identity.createdAtMs);
assert.equal(merged.sourceTimeline?.semantic, "COMPLETED");
assert.equal(merged.timeline.semantic, "COMPLETED");
assert.equal(buildWidgetSnapshot([merged], NOW + 60_000).rows[0]?.waybillSuffix, "7890");

const completedCarrierBase = timeline("kuaidi100", "SF1234567890", "COMPLETED");
const completedCarrier = {
  ...completedCarrierBase,
  tracks: completedCarrierBase.tracks.map((track) => ({
    ...track,
    detail: "manual-only historical node",
  })),
};
const withCarrierAuthority = applyAccountShipment(
  { ...current, manualTimelines: [completedCarrier], timeline: completedCarrier },
  summary,
  NOW + 120_000,
);
assert.equal(withCarrierAuthority.sourceTimeline?.semantic, "COMPLETED");
assert.equal(withCarrierAuthority.timeline.semantic, "COMPLETED");
assert.equal(withCarrierAuthority.timeline.provider, "interface5");
assert.equal(
  withCarrierAuthority.timeline.tracks.some(
    (track) => track.detail === "manual-only historical node",
  ),
  false,
);
assert.equal(sourceTimelineOwnsShipment(withCarrierAuthority), false);
assert.equal(manualTimelineOwnsShipment(withCarrierAuthority), true);

const carrierDetailTimeline = {
  ...timeline("interface5", "SF9988776655", "TRANSIT"),
  courierCode: "SF",
  companyName: "顺丰速运",
};
const carrierDetail: Shipment = {
  identity: {
    id: "interface5:account:SF9988776655",
    bindingSource: "interface5",
    sourceOwner: "interface5:parcel",
    sourceId: "SF9988776655",
    phoneTail: "1515",
    phone: "13800001515",
    courierCode: "SF",
    rawCourierCode: "SF",
    companyName: "顺丰速运",
    sourceProvider: "carrier-detail",
    accountOrder: false,
    manuallyAdded: false,
    createdAtMs: NOW + 180_000,
  },
  timeline: carrierDetailTimeline,
  sourceTimeline: carrierDetailTimeline,
  manualTimelines: [],
  route: { kind: "cainiao", source: "interface5" },
  accountRecord: null,
  updatedAtMs: NOW + 180_000,
};
const cainiaoWithHistoricalManual: Shipment = {
  ...carrierDetail,
  identity: { ...carrierDetail.identity, sourceProvider: "CaiNiao" },
  timeline: completedCarrier,
  manualTimelines: [completedCarrier],
};
const cainiaoSourceWins = applyAccountShipment(
  cainiaoWithHistoricalManual,
  {
    ...carrierDetail,
    identity: { ...carrierDetail.identity, sourceProvider: "CaiNiao" },
  },
  NOW + 180_000,
);
assert.equal(cainiaoSourceWins.timeline.provider, "interface5");
assert.equal(cainiaoSourceWins.timeline.semantic, "TRANSIT");
const emptyCainiaoSource: Shipment = {
  ...carrierDetail,
  identity: { ...carrierDetail.identity, sourceProvider: "CaiNiao" },
  timeline: {
    ...carrierDetailTimeline,
    semantic: "UNKNOWN",
    statusEventAtMs: null,
    latestTimeText: "",
    latestDetail: "暂无物流动态",
    tracks: [],
  },
  sourceTimeline: {
    ...carrierDetailTimeline,
    semantic: "UNKNOWN",
    statusEventAtMs: null,
    latestTimeText: "",
    latestDetail: "暂无物流动态",
    tracks: [],
  },
};
const cainiaoH5Timeline = {
  ...timeline("cainiao_h5", "SF9988776655", "COMPLETED"),
  courierCode: "SF",
  companyName: "顺丰速运",
  tracks: [{
    ...timeline("cainiao_h5", "SF9988776655", "COMPLETED").tracks[0],
    raw: { _pipiStatusSource: "cainiao_h5" },
  }],
};
const cainiaoWithH5 = applySameSourceTimeline(
  emptyCainiaoSource,
  cainiaoH5Timeline,
  NOW + 180_000,
);
assert.equal(cainiaoWithH5.timeline.provider, "cainiao_h5");
assert.equal(cainiaoWithH5.timeline.semantic, "COMPLETED");
assert.equal(
  cainiaoWithH5.timeline.tracks[0]?.raw._pipiStatusSource,
  "cainiao_h5",
);
assert.equal(sourceTimelineOwnsShipment(cainiaoWithH5), false);
assert.equal(needsAutomaticManualFallback(cainiaoWithH5), false);
assert.equal(
  hasCachedTimelineBeforeKdniao(cainiaoWithH5),
  false,
  "one terminal H5 event is not a usable history",
);
const earlierCainiaoH5 = {
  ...cainiaoH5Timeline,
  semantic: "TRANSIT" as const,
  latestDetail: "运输中",
  tracks: [{
    ...cainiaoH5Timeline.tracks[0],
    timeText: "2026-08-26 15:00:00",
    timeMs: NOW - 60 * 60 * 1000,
    detail: "运输中",
    statusCode: "0",
  }],
  successAtMs: NOW + 181_000,
};
const incrementallyMergedCainiaoH5 = applySameSourceTimeline(
  cainiaoWithH5,
  earlierCainiaoH5,
  NOW + 181_000,
);
assert.equal(incrementallyMergedCainiaoH5.timeline.provider, "cainiao_h5");
assert.equal(incrementallyMergedCainiaoH5.timeline.semantic, "COMPLETED");
assert.equal(incrementallyMergedCainiaoH5.timeline.tracks.length, 2);
assert.equal(hasCachedTimelineBeforeKdniao(incrementallyMergedCainiaoH5), true);
assert.equal(hasCachedTimelineBeforeKdniao({
  ...emptyCainiaoSource,
  manualTimelines: [timeline("kdniao", "SF9988776655", "COMPLETED")],
}), false);
const cachedCompleteKdniao = {
  ...timeline("kdniao", "SF9988776655", "COMPLETED"),
  complete: true,
  tracks: [
    ...timeline("kdniao", "SF9988776655", "COMPLETED").tracks,
    {
      ...timeline("kdniao", "SF9988776655", "PICKED").tracks[0],
      timeText: "2026-08-25 08:00:00",
      timeMs: NOW - 2 * 60 * 60 * 1000,
      detail: "快件已揽收",
      statusCode: "1",
    },
  ],
};
const oneTrackMeizu = timeline("meizu", "SF9988776655", "COMPLETED");
const earlierOneTrackMeizu: TimelinePackage = {
  ...timeline("meizu", "SF9988776655", "PICKED"),
  latestTimeText: "2026-08-26 15:00:00",
  latestDetail: "PICKED",
  tracks: [{
    ...timeline("meizu", "SF9988776655", "PICKED").tracks[0]!,
    timeText: "2026-08-26 15:00:00",
    timeMs: NOW - 60 * 60 * 1_000,
    detail: "PICKED",
  }],
  successAtMs: NOW + 1,
};
const firstMeizuIncrement = applyManualShipment(
  emptyCainiaoSource,
  {
    ...emptyCainiaoSource,
    timeline: oneTrackMeizu,
    manualTimelines: [oneTrackMeizu],
  },
  NOW + 1,
);
const secondMeizuIncrement = applyManualShipment(
  firstMeizuIncrement,
  {
    ...emptyCainiaoSource,
    timeline: earlierOneTrackMeizu,
    manualTimelines: [earlierOneTrackMeizu],
  },
  NOW + 2,
);
assert.equal(
  secondMeizuIncrement.manualTimelines?.find(
    (item) => item.provider === "meizu",
  )?.tracks.length,
  2,
  "one Meizu event per refresh must accumulate into durable history",
);
const restoredManualHistory = selectShipmentTimeline({
  ...emptyCainiaoSource,
  timeline: oneTrackMeizu,
  manualTimelines: [oneTrackMeizu, cachedCompleteKdniao],
});
assert.equal(restoredManualHistory.provider, "kdniao");
assert.equal(restoredManualHistory.semantic, "COMPLETED");
assert.equal(restoredManualHistory.tracks.length, 2);
assert.equal(hasSettledTimelineHistory({
  ...emptyCainiaoSource,
  timeline: restoredManualHistory,
  manualTimelines: [oneTrackMeizu, cachedCompleteKdniao],
}), true);
assert.equal(hasCachedKdniaoTimeline({
  ...emptyCainiaoSource,
  timeline: oneTrackMeizu,
  manualTimelines: [oneTrackMeizu, cachedCompleteKdniao],
}), true);
// The supplement step restores nodes the selected provider's own refresh omitted, so it follows the
// same headline rule as every other merge (status.withMergedHeadline): once the track set has grown
// past the stored headline, the newest node is the headline. One rule, both call sites.
const completeMeizuWithOlderHeadline: TimelinePackage = {
  ...timeline("meizu", "SF9988776655", "TRANSIT"),
  complete: true,
  latestTimeText: "2026-08-26 13:53:00",
  latestDetail: "快件已到达深圳中转场",
  tracks: [{
    ...timeline("meizu", "SF9988776655", "TRANSIT").tracks[0]!,
    timeText: "2026-08-26 13:53:00",
    timeMs: NOW - 127 * 60_000,
    detail: "快件已到达深圳中转场",
  }],
};
const cachedMeizuWithNewerNode: TimelinePackage = {
  ...completeMeizuWithOlderHeadline,
  complete: false,
  tracks: [{
    ...completeMeizuWithOlderHeadline.tracks[0]!,
    timeText: "2026-08-26 14:57:00",
    timeMs: NOW - 63 * 60_000,
    detail: "您的快件已发出",
  }],
};
const supplementedHeadline = selectShipmentTimeline({
  ...emptyCainiaoSource,
  timeline: completeMeizuWithOlderHeadline,
  manualTimelines: [completeMeizuWithOlderHeadline, cachedMeizuWithNewerNode],
});
assert.equal(supplementedHeadline.provider, "meizu");
assert.equal(supplementedHeadline.tracks.length, 2);
assert.equal(
  supplementedHeadline.latestDetail,
  "您的快件已发出",
  "a supplemented history must not leave the row on a node it has already passed",
);
assert.equal(supplementedHeadline.latestTimeText, "2026-08-26 14:57:00");

const oneTrackXiaomi = {
  ...timeline("interface5", "SF9988776655", "COMPLETED"),
  latestDetail: "小米仅返回最新签收事件",
};
const selectedXiaomiTimeline = selectShipmentTimeline({
  ...emptyCainiaoSource,
  timeline: oneTrackXiaomi,
  sourceTimeline: oneTrackXiaomi,
  manualTimelines: [cachedCompleteKdniao],
});
assert.equal(selectedXiaomiTimeline.provider, "interface5");
assert.equal(selectedXiaomiTimeline.latestDetail, "小米仅返回最新签收事件");
assert.equal(
  selectedXiaomiTimeline.tracks.length,
  1,
  "a selected Xiaomi timeline must not absorb tracks from KDNiao",
);
assert.equal(hasSettledTimelineHistory({
  ...emptyCainiaoSource,
  timeline: oneTrackXiaomi,
  sourceTimeline: oneTrackXiaomi,
  manualTimelines: [],
}), false);
assert.equal(hasCachedTimelineBeforeKdniao({
  ...emptyCainiaoSource,
  timeline: oneTrackXiaomi,
  sourceTimeline: oneTrackXiaomi,
  manualTimelines: [],
}), false);
const cainiaoRoute = { kind: "cainiao" as const, source: "interface5" as const };
const withCainiaoRoute: Shipment = {
  ...cainiaoWithHistoricalManual,
  route: cainiaoRoute,
};
assert.deepEqual(
  applyAccountShipment(
    withCainiaoRoute,
    { ...carrierDetail, identity: {
      ...carrierDetail.identity,
      sourceProvider: "CaiNiao",
    }, route: null },
    NOW + 180_001,
  ).route,
  cainiaoRoute,
);
// A targeted detail response may contain fresh tracks without repeating the Cainiao route.
// Re-establishing automatic ownership must not discard the existing route capability while the
// shipment remains owned by Cainiao.
const cainiaoRouteWithUnclaimedOwnership: Shipment = {
  ...withCainiaoRoute,
  automaticOwnership: {
    ownerSource: null,
    ownerBindingIdentity: null,
    claimedAtMs: 0,
    lastTakeoverAtMs: 0,
    ownerMisses: 0,
    takeoverPending: false,
    observations: [],
  },
};
assert.deepEqual(
  applyTargetedAccountShipment(
    cainiaoRouteWithUnclaimedOwnership,
    {
      ...carrierDetail,
      identity: {
        ...carrierDetail.identity,
        sourceProvider: "CaiNiao",
      },
      route: null,
    },
    NOW + 180_001,
    { existingCainiaoRouteAvailable: true },
  ).route,
  cainiaoRoute,
);
assert.equal(
  applyTargetedAccountShipment(
    cainiaoRouteWithUnclaimedOwnership,
    {
      ...carrierDetail,
      identity: {
        ...carrierDetail.identity,
        sourceProvider: "ShunFeng",
      },
      route: null,
    },
    NOW + 180_002,
    { existingCainiaoRouteAvailable: true },
  ).route,
  null,
);
for (const sourceProvider of ["ShunFeng", "JingDong", "", "Other"]) {
  const transitioned = applyAccountShipment(
    withCainiaoRoute,
    { ...carrierDetail, identity: {
      ...carrierDetail.identity,
      sourceProvider,
    } },
    NOW + 180_002,
  );
  if (sourceProvider) assert.equal(transitioned.route, null);
  else assert.deepEqual(transitioned.route, cainiaoRoute);
  assert.equal(
    transitioned.identity.sourceProvider,
    sourceProvider || "CaiNiao",
  );
}
const accountOrderWithStaleRoute: Shipment = {
  ...current,
  identity: { ...current.identity, sourceProvider: "CaiNiao" },
  route: cainiaoRoute,
};
const correctedAccountOrder = applyAccountShipment(
  accountOrderWithStaleRoute,
  { ...carrierDetail, identity: {
    ...carrierDetail.identity,
    sourceProvider: "ShunFeng",
  } },
  NOW + 180_003,
);
assert.equal(correctedAccountOrder.identity.sourceProvider, "ShunFeng");
assert.equal(correctedAccountOrder.route, null);

const fullCachedHistory: TimelinePackage = {
  ...timeline("kuaidi100", "YT1234567890", "TRANSIT"),
  latestDetail: "快件运输中",
  tracks: [
    {
      timeText: "2026-08-26 15:00:00",
      timeMs: NOW - 60 * 60 * 1_000,
      detail: "快件运输中",
      statusCode: "101",
      raw: {},
    },
    {
      timeText: "2026-08-26 12:00:00",
      timeMs: NOW - 4 * 60 * 60 * 1_000,
      detail: "快件已揽收",
      statusCode: "1",
      raw: {},
    },
  ],
};
const sourceBeforeCompletion = {
  ...timeline("interface5", "YT1234567890", "TRANSIT"),
  latestDetail: "快递状态已更新",
};
const shipmentWithCachedHistory: Shipment = {
  ...carrierDetail,
  identity: {
    ...carrierDetail.identity,
    id: "interface5:account:YT1234567890",
    sourceId: "YT1234567890",
    courierCode: "YTO",
    companyName: "圆通速递",
    sourceProvider: "CaiNiao",
  },
  timeline: sourceBeforeCompletion,
  sourceTimeline: sourceBeforeCompletion,
  manualTimelines: [fullCachedHistory],
};
const completionOnlySource = {
  ...timeline("interface5", "YT1234567890", "COMPLETED"),
  latestDetail: "您的包裹已送货上门",
  tracks: [{
    timeText: "2026-08-26 16:00:00",
    timeMs: NOW,
    detail: "您的包裹已送货上门",
    statusCode: "3",
    raw: {},
  }],
};
const completedWithCachedHistory = applyAccountShipment(
  shipmentWithCachedHistory,
  {
    ...shipmentWithCachedHistory,
    timeline: completionOnlySource,
    sourceTimeline: completionOnlySource,
    manualTimelines: [],
  },
  NOW + 1,
);
assert.equal(completedWithCachedHistory.timeline.provider, "interface5");
assert.equal(completedWithCachedHistory.timeline.semantic, "COMPLETED");
assert.equal(
  completedWithCachedHistory.timeline.latestDetail,
  "您的包裹已送货上门",
);
assert.equal(
  completedWithCachedHistory.sourceTimeline?.tracks.some(
    (track) => track.detail === "快件已揽收",
  ),
  false,
);
assert.equal(
  completedWithCachedHistory.timeline.tracks.some(
    (track) => track.detail === "快件已揽收",
  ),
  false,
  "the selected Xiaomi timeline must not absorb cached history from another provider",
);
assert.equal(
  completedWithCachedHistory.manualTimelines?.[0]?.tracks.length,
  fullCachedHistory.tracks.length,
);
const projectedFromDetail = applyAccountShipment(
  current,
  carrierDetail,
  NOW + 180_000,
);
assert.equal(projectedFromDetail.identity.id, current.identity.id);
assert.equal(projectedFromDetail.identity.sourceId, current.identity.sourceId);
assert.equal(projectedFromDetail.identity.sourceOwner, current.identity.sourceOwner);
assert.equal(projectedFromDetail.identity.accountOrder, true);
assert.equal(projectedFromDetail.identity.projectedWaybill, "SF9988776655");
assert.equal(projectedFromDetail.identity.courierCode, "SF");
assert.equal(projectedFromDetail.identity.companyName, "顺丰速运");
assert.deepEqual(projectedFromDetail.route, current.route);
assert.throws(
  () => applyTargetedAccountShipment(current, carrierDetail, NOW + 180_000),
  /物流信息与当前运单不符/,
);
const knownProjectedOrder = {
  ...current,
  identity: {
    ...current.identity,
    projectedWaybill: "SF9988776655",
  },
};
assert.equal(
  applyTargetedAccountShipment(
    knownProjectedOrder,
    carrierDetail,
    NOW + 180_000,
  ).identity.id,
  current.identity.id,
);
assert.throws(
  () => applyTargetedAccountShipment(
    carrierDetail,
    {
      ...carrierDetail,
      identity: {
        ...carrierDetail.identity,
        id: "interface5:account:WRONG0001",
        sourceId: "WRONG0001",
      },
    },
    NOW + 180_000,
  ),
  /物流信息与当前运单不符/,
);

const alternateShunFeng = {
  ...carrierDetail,
  identity: {
    ...carrierDetail.identity,
    sourceProvider: "SHUNFENG",
  },
};
assert.equal(sourceTimelineOwnsShipment(alternateShunFeng), true);
assert.equal(shouldScheduleManualRefresh(alternateShunFeng, NOW), true);
// 用户定 2026-09-04：首页/列表页对终态件停止刷新，除非状态还没出来。终态 = 已签收**或已取消**
// 且已有可用轨迹历史；零轨迹的行不算终态，照常刷。与 Pipi 的 hasSettledTimelineHistory 同判据。
const cancelledShunFeng = {
  ...alternateShunFeng,
  timeline: {
    ...alternateShunFeng.timeline,
    semantic: "CANCELLED" as const,
    // 终态要求 ≥2 条可用轨迹（TERMINAL_HISTORY_MIN_TRACKS），只有一条不算已有历史。
    tracks: [
      ...alternateShunFeng.timeline.tracks,
      {
        timeText: "2026-08-26 15:00:00",
        timeMs: NOW - 3_600_000,
        detail: "运输中",
        statusCode: "101",
        raw: {},
      },
    ],
  },
};
assert.equal(
  shouldScheduleManualRefresh(cancelledShunFeng, NOW),
  false,
  "已取消且有可用轨迹的行不再排期刷新",
);
const settledButEmptyShunFeng = {
  ...alternateShunFeng,
  timeline: {
    ...alternateShunFeng.timeline,
    semantic: "COMPLETED" as const,
    tracks: [],
  },
};
assert.equal(
  shouldScheduleManualRefresh(settledButEmptyShunFeng, NOW),
  true,
  "状态到终态但零轨迹的行不算终态，必须照常刷",
);
const recentlyAttemptedShunFeng = {
  ...alternateShunFeng,
  manualRefreshAttemptAtMs: NOW,
};
assert.equal(
  shouldScheduleManualRefresh(
    recentlyAttemptedShunFeng,
    NOW + MANUAL_REFRESH_MIN_INTERVAL_MS - 1,
  ),
  false,
);
assert.equal(
  shouldScheduleManualRefresh(
    recentlyAttemptedShunFeng,
    NOW + MANUAL_REFRESH_MIN_INTERVAL_MS,
  ),
  true,
);
assert.equal(
  shouldScheduleManualRefresh(recentlyAttemptedShunFeng, NOW + 1, true),
  true,
);
assert.equal(
  shouldScheduleManualRefresh(recentlyAttemptedShunFeng, NOW - 1),
  true,
);
const activeManualAttempt = beginManualRefreshAttempt(
  alternateShunFeng,
  "manual-attempt-active",
  NOW,
  NOW + 30_000,
);
assert.equal(activeManualRefreshLease(activeManualAttempt, NOW), true);
assert.equal(ownsManualRefreshLease(activeManualAttempt, "manual-attempt-active"), true);
assert.equal(
  shouldScheduleManualRefresh(activeManualAttempt, NOW + 1, true),
  false,
);
assert.equal(
  shouldScheduleManualRefresh(activeManualAttempt, NOW + 30_000, true),
  true,
);
assert.equal(
  shouldScheduleManualRefresh(activeManualAttempt, NOW - 1, true),
  true,
);
assert.equal(
  applyAccountShipment(activeManualAttempt, alternateShunFeng, NOW + 1)
    .manualRefreshLease?.attemptId,
  "manual-attempt-active",
);
const releasedManualAttempt = releaseManualRefreshLease(
  activeManualAttempt,
  "manual-attempt-active",
);
assert.equal(releasedManualAttempt.manualRefreshLease, undefined);
assert.equal(releasedManualAttempt.manualRefreshAttemptAtMs, NOW);
assert.equal(
  shouldScheduleManualRefresh(releasedManualAttempt, NOW + 29_999),
  false,
);
assert.equal(
  shouldScheduleManualRefresh(releasedManualAttempt, NOW + 30_000),
  true,
);
assert.equal(shouldScheduleManualRefresh({
  ...alternateShunFeng,
  timeline: { ...alternateShunFeng.timeline, semantic: "COMPLETED" },
}, NOW), true);
assert.equal(shouldScheduleManualRefresh({
  ...alternateShunFeng,
  timeline: timeline("interface5", "SF9988776655", "COMPLETED"),
  sourceTimeline: timeline("interface5", "SF9988776655", "COMPLETED"),
  manualTimelines: [],
}, NOW + 25 * 60 * 60 * 1_000), true);
assert.equal(manualTimelineOwnsShipment(carrierDetail), false);
const ordinaryAutomaticWithoutStart: Shipment = {
  ...carrierDetail,
  timeline: {
    ...carrierDetail.timeline,
    latestDetail: "快件运输中",
    tracks: carrierDetail.timeline.tracks.map((track) => ({
      ...track,
      detail: "快件运输中",
      statusCode: "5",
      raw: { statusCode: "5" },
    })),
  },
  sourceTimeline: {
    ...(carrierDetail.sourceTimeline || carrierDetail.timeline),
    latestDetail: "快件运输中",
    tracks: (carrierDetail.sourceTimeline || carrierDetail.timeline).tracks.map(
      (track) => ({
        ...track,
        detail: "快件运输中",
        statusCode: "5",
        raw: { statusCode: "5" },
      }),
    ),
  },
};
assert.equal(
  needsAutomaticManualFallback(ordinaryAutomaticWithoutStart),
  true,
  "an incomplete ordinary automatic owner must allow detail supplementation",
);
assert.equal(needsAutomaticManualFallback({
  ...ordinaryAutomaticWithoutStart,
  sourceTimeline: {
    ...(ordinaryAutomaticWithoutStart.sourceTimeline ||
      ordinaryAutomaticWithoutStart.timeline),
    complete: true,
  },
}), true, "a generic source completeness flag cannot replace feed pickup evidence");
// 「更完整的手动包」现在要真的更完整：带揽收、且最新节点与 feed 对得上（判据见
// shipment-policy 的 detailTimelineComplete）。只靠节点数相同的一条 COMPLETED 不算。
const fullerCarrier = {
  ...completedCarrier,
  tracks: [
    ...completedCarrier.tracks,
    {
      ...completedCarrier.tracks[0]!,
      timeText: "2026-08-26 14:00:00",
      timeMs: NOW - 2 * 60 * 60 * 1_000,
      detail: "快件已揽收",
      statusCode: "1",
      raw: { statusCode: "1" },
    },
  ],
};
const ordinaryAutomaticWithManualDetail = applyManualShipment(
  ordinaryAutomaticWithoutStart,
  {
    ...carrierDetail,
    identity: {
      ...carrierDetail.identity,
      id: "interface5:manual:SF9988776655",
      manuallyAdded: true,
      bindingSource: undefined,
    },
    timeline: fullerCarrier,
    sourceTimeline: null,
    manualTimelines: [fullerCarrier],
  },
  NOW + 1,
);
assert.equal(
  selectShipmentTimeline(ordinaryAutomaticWithManualDetail).provider,
  "kuaidi100",
  "automatic Home shares the selected detail history",
);
assert.equal(
  selectShipmentDetailTimeline(ordinaryAutomaticWithManualDetail).provider,
  "kuaidi100",
  "ordinary automatic detail may use the fuller manual package",
);
assert.equal(
  shouldScheduleManualRefresh(ordinaryAutomaticWithoutStart, NOW),
  false,
  "ordinary automatic supplementation is detail-only",
);
assert.equal(
  manualTimelineOwnsShipment({
    ...carrierDetail,
    manualTimelines: [completedCarrier],
  }),
  false,
);
const shunFengWithManual = {
  ...alternateShunFeng,
  timeline: completedCarrier,
  manualTimelines: [completedCarrier],
};
assert.equal(manualTimelineOwnsShipment(shunFengWithManual), false);
assert.equal(shouldScheduleManualRefresh(shunFengWithManual, NOW), false);
const oneTrackTerminalKdniao = {
  ...timeline("kdniao", "SF9988776655", "COMPLETED"),
  complete: true,
};
assert.equal(shouldScheduleManualRefresh({
  ...alternateShunFeng,
  timeline: oneTrackTerminalKdniao,
  manualTimelines: [oneTrackTerminalKdniao],
}, NOW), true);
const twoTrackTerminalKdniao = {
  ...oneTrackTerminalKdniao,
  tracks: [
    ...oneTrackTerminalKdniao.tracks,
    {
      ...oneTrackTerminalKdniao.tracks[0],
      timeText: "2026-08-26 15:00:00",
      timeMs: NOW - 60 * 60 * 1_000,
      detail: "PICKED",
      statusCode: "1",
    },
  ],
};
assert.equal(shouldScheduleManualRefresh({
  ...alternateShunFeng,
  timeline: twoTrackTerminalKdniao,
  manualTimelines: [twoTrackTerminalKdniao],
}, NOW), false);
const manualJtBase = {
  ...alternateShunFeng,
  identity: {
    ...alternateShunFeng.identity,
    sourceOwner: "manual",
    sourceProvider: "J&T",
    manuallyAdded: true,
  },
  sourceTimeline: null,
};
assert.equal(shouldScheduleManualRefresh({
  ...manualJtBase,
  timeline: oneTrackTerminalKdniao,
  manualTimelines: [oneTrackTerminalKdniao],
}, NOW), true);
assert.equal(shouldScheduleManualRefresh({
  ...manualJtBase,
  timeline: twoTrackTerminalKdniao,
  manualTimelines: [twoTrackTerminalKdniao],
}, NOW), false);
assert.equal(shouldScheduleManualRefresh({
  ...manualJtBase,
  timeline: completedCarrier,
  manualTimelines: [completedCarrier],
}, NOW), false);
assert.equal(
  shouldScheduleManualRefresh(
    { ...alternateShunFeng, forcedCompletedAtMs: NOW },
    NOW + 1,
  ),
  false,
);
assert.equal(
  applyAccountShipment(shunFengWithManual, alternateShunFeng, NOW + 1)
    .timeline.semantic,
  "COMPLETED",
  "an SF account increment must not replace an already completed manual-chain package",
);
const cancelledCarrier = {
  ...completedCarrier,
  semantic: "CANCELLED" as const,
  statusEventAtMs: NOW,
  latestDetail: "运单已取消",
};
const laterStructuredDelivery = {
  ...timeline("kdniao", "SF9988776655", "DELIVERY"),
  complete: true,
  structuredStatus: true,
  statusEventAtMs: NOW + 10_000,
  latestDetail: "稍后出现的派送文案",
  // The headline is the newest node of the package, so the node carries that same text: a stored
  // headline that matches no node is not something a provider response can produce.
  tracks: timeline("kdniao", "SF9988776655", "DELIVERY").tracks.map((track) => ({
    ...track,
    detail: "稍后出现的派送文案",
    timeMs: NOW + 10_000,
  })),
};
const cancelledTerminalProtection = applyManualShipment(
  {
    ...shunFengWithManual,
    timeline: cancelledCarrier,
    manualTimelines: [cancelledCarrier],
  },
  {
    ...shunFengWithManual,
    timeline: laterStructuredDelivery,
    manualTimelines: [laterStructuredDelivery],
  },
  NOW + 10_000,
);
assert.equal(cancelledTerminalProtection.timeline.provider, "kuaidi100",
  "SF Home now follows the existing detail ranking among manual packages");
assert.equal(
  cancelledTerminalProtection.timeline.latestDetail,
  "运单已取消",
);
assert.equal(
  cancelledTerminalProtection.timeline.semantic,
  "CANCELLED",
  "retaining the selected manual package retains its terminal state",
);
assert.equal(cancelledTerminalProtection.timeline.statusEventAtMs, NOW);

const waitingPickupSourceTimeline = {
  ...carrierDetailTimeline,
  semantic: "WAITING_PICKUP" as const,
  statusEventAtMs: NOW - 60_000,
  latestDetail: "归属源待取件文案",
};
const waitingPickupShunFeng: Shipment = {
  ...alternateShunFeng,
  timeline: waitingPickupSourceTimeline,
  sourceTimeline: waitingPickupSourceTimeline,
};
const unstructuredManualTimeline = {
  ...timeline("kdniao", "SF9988776655", "TRANSIT"),
  complete: true,
  structuredStatus: false,
  latestDetail: "手动源最新头条与完整轨迹",
};
const unstructuredTakeover = applyManualShipment(
  waitingPickupShunFeng,
  {
    ...waitingPickupShunFeng,
    timeline: unstructuredManualTimeline,
    manualTimelines: [unstructuredManualTimeline],
  },
  NOW + 1,
);
assert.equal(unstructuredTakeover.timeline.provider, "kdniao");
assert.equal(unstructuredTakeover.timeline.latestDetail, "手动源最新头条与完整轨迹");
assert.equal(unstructuredTakeover.timeline.semantic, "TRANSIT");
assert.equal(unstructuredTakeover.timeline.statusEventAtMs, NOW);

const structuredManualTimeline = {
  ...unstructuredManualTimeline,
  structuredStatus: true,
  semantic: "DELIVERY" as const,
  statusEventAtMs: NOW,
};
const structuredTakeover = applyManualShipment(
  waitingPickupShunFeng,
  {
    ...waitingPickupShunFeng,
    timeline: structuredManualTimeline,
    manualTimelines: [structuredManualTimeline],
  },
  NOW + 2,
);
assert.equal(structuredTakeover.timeline.semantic, "DELIVERY");
assert.equal(structuredTakeover.timeline.statusEventAtMs, NOW);

const laterOppoTimeline = {
  ...timeline("oppo", "SF9988776655", "TRANSIT"),
  successAtMs: NOW + 2,
  latestDetail: "OPPO 最新完整包",
};
const shunFengLatestManual = applyAccountShipment(
  {
    ...shunFengWithManual,
    manualTimelines: [completedCarrier, laterOppoTimeline],
  },
  alternateShunFeng,
  NOW + 3,
);
assert.equal(shunFengLatestManual.timeline.provider, "kuaidi100",
  "an unsupported OPPO package cannot replace iOS SF manual authority on Home");
assert.equal(shunFengLatestManual.timeline.semantic, "COMPLETED");
assert.equal(shunFengLatestManual.timeline.latestDetail, completedCarrier.latestDetail);
assert.equal(shunFengLatestManual.identity.sourceProvider, "SHUNFENG");
assert.equal(usesManualSourceQuery(shunFengWithManual), true);
assert.equal(usesManualSourceQuery(carrierDetail), false);
const cainiaoWithXiaomiTimeline: Shipment = {
  ...carrierDetail,
  identity: { ...carrierDetail.identity, sourceProvider: "CaiNiao" },
};
assert.equal(sourceTimelineOwnsShipment(cainiaoWithXiaomiTimeline), true);
assert.equal(
  usesManualSourceQuery(cainiaoWithXiaomiTimeline),
  false,
  "a usable Xiaomi account timeline must not enqueue the redundant homepage Moto refresh",
);
assert.equal(
  usesManualSourceQuery({
    ...cainiaoWithXiaomiTimeline,
    timeline: {
      ...cainiaoWithXiaomiTimeline.timeline,
      semantic: "UNKNOWN",
      latestTimeText: "",
      latestDetail: "暂无物流动态",
      tracks: [],
    },
    sourceTimeline: {
      ...(cainiaoWithXiaomiTimeline.sourceTimeline ||
        cainiaoWithXiaomiTimeline.timeline),
      semantic: "UNKNOWN",
      latestTimeText: "",
      latestDetail: "暂无物流动态",
      tracks: [],
    },
  }),
  true,
  "Cainiao may use the local fallback only when Xiaomi returned no timed tracks",
);
assert.equal(
  shouldScheduleManualRefresh(
    {
      ...carrierDetail,
      identity: { ...carrierDetail.identity, sourceProvider: "ShunFeng" },
      timeline: { ...carrierDetail.timeline, semantic: "COMPLETED" },
      sourceTimeline: { ...carrierDetailTimeline, semantic: "COMPLETED" },
      manualTimelines: [],
    },
    NOW + 1,
  ),
  true,
  "a completed ShunFeng summary still requires its first manual package",
);

const jingDongCompleted: Shipment = {
  ...carrierDetail,
  identity: { ...carrierDetail.identity, sourceProvider: "JingDong" },
  timeline: {
    ...timeline("interface5", "JD9988776655", "COMPLETED"),
    tracks: timeline("interface5", "JD9988776655", "COMPLETED").tracks.map(
      (track) => ({
        ...track,
        statusCode: "107",
        raw: { statusCode: "107", _pipiStatusSource: "interface5" },
      }),
    ),
  },
  sourceTimeline: {
    ...timeline("interface5", "JD9988776655", "COMPLETED"),
    tracks: timeline("interface5", "JD9988776655", "COMPLETED").tracks.map(
      (track) => ({
        ...track,
        statusCode: "107",
        raw: { statusCode: "107", _pipiStatusSource: "interface5" },
      }),
    ),
  },
};
const partialJingDongH5Timeline: TimelinePackage = {
  ...timeline("interface5", "JD9988776655", "TRANSIT"),
  complete: false,
  tracks: timeline("interface5", "JD9988776655", "TRANSIT").tracks.map(
    (track) => ({
      ...track,
      raw: { _pipiStatusSource: "jingdong_h5" },
    }),
  ),
};
const partialJingDongH5: Shipment = {
  ...jingDongCompleted,
  identity: {
    ...jingDongCompleted.identity,
    courierCode: "JD",
    companyName: "京东快递",
    sourceProvider: "JingDong",
    projectedWaybill: "JD9988776655",
    accountOrder: true,
  },
  timeline: partialJingDongH5Timeline,
  sourceTimeline: partialJingDongH5Timeline,
};
assert.equal(
  jingDongAutomaticH5TimelineAvailable(partialJingDongH5),
  false,
  "a pre-click JD H5 summary must continue into Picker, K100 H5, and KDNiao",
);
// 用户定 2026-09-05 晚：H5 包住 jd_h5 槽，不再混在 source 里；闸门读的是那个槽。
assert.equal(
  jingDongAutomaticH5TimelineAvailable({
    ...partialJingDongH5,
    timeline: { ...partialJingDongH5Timeline, complete: true },
    sourceTimeline: { ...partialJingDongH5Timeline, complete: true },
  }),
  false,
  "an H5 package left inside the source never counts; it lives in the jd_h5 slot",
);
assert.equal(
  jingDongAutomaticH5TimelineAvailable({
    ...partialJingDongH5,
    manualTimelines: [{ ...partialJingDongH5Timeline, provider: "jd_h5", complete: true }],
  }),
  true,
  "only a causally proven full-progress response may stop the JD fallback chain",
);
const partialPickedJingDongH5Timeline: TimelinePackage = {
  ...partialJingDongH5Timeline,
  semantic: "PICKED",
  latestDetail: "快件已揽收",
  tracks: [{
    ...partialJingDongH5Timeline.tracks[0],
    detail: "快件已揽收",
    statusCode: "1",
    raw: { statusCode: "1", _pipiStatusSource: "jingdong_h5" },
  }],
};
// 真正完整的快递鸟包：带揽收、最新节点与 feed 对齐（判据同 detailTimelineComplete）。
const completeJingDongFallback: TimelinePackage = {
  ...timeline("kdniao", "JD9988776655", "TRANSIT"),
  complete: true,
  latestDetail: "快递鸟完整包",
  tracks: [
    ...timeline("kdniao", "JD9988776655", "TRANSIT").tracks,
    {
      ...timeline("kdniao", "JD9988776655", "TRANSIT").tracks[0]!,
      timeText: "2026-08-26 14:00:00",
      timeMs: NOW - 2 * 60 * 60 * 1_000,
      detail: "快件已揽收",
      statusCode: "1",
      raw: { statusCode: "1" },
    },
  ],
};
const partialPickedWithCompleteFallback: Shipment = {
  ...partialJingDongH5,
  timeline: partialPickedJingDongH5Timeline,
  sourceTimeline: partialPickedJingDongH5Timeline,
  manualTimelines: [completeJingDongFallback],
};
// 用户定 2026-09-05 晚：京东行的列表归 feed（source 包本身），完整的快递鸟包只在详情页选包时胜出。
assert.equal(
  selectShipmentTimeline(partialPickedWithCompleteFallback).provider,
  "interface5",
  "the JD list row stays on the feed package",
);
assert.equal(
  selectShipmentDetailTimeline(partialPickedWithCompleteFallback).provider,
  "interface5",
  "a transit fallback cannot prove consistency with the owner's picked status",
);

const completeAtomicJingDongH5Timeline: TimelinePackage = {
  ...partialJingDongH5Timeline,
  complete: true,
  semantic: "DELIVERY",
  statusEventAtMs: NOW + 2,
  latestTimeText: "2026-08-26 16:00:02",
  latestDetail: "完整物流进度响应",
  tracks: [{
    timeText: "2026-08-26 16:00:02",
    timeMs: NOW + 2,
    detail: "完整物流进度响应",
    statusCode: "",
    raw: { _pipiStatusSource: "jingdong_h5" },
  }],
  successAtMs: NOW + 2,
};
const atomicJingDongMerge = applyAccountShipment(
  partialJingDongH5,
  {
    ...partialJingDongH5,
    timeline: completeAtomicJingDongH5Timeline,
    sourceTimeline: completeAtomicJingDongH5Timeline,
    updatedAtMs: NOW + 2,
  },
  NOW + 2,
);
// 用户定 2026-09-05 晚：H5 包不进 source；完整的那一包住 jd_h5 槽，仍是一个原子包。
assert.deepEqual(
  atomicJingDongMerge.sourceTimeline?.tracks.filter(
    (track) => track.raw?._pipiStatusSource === "jingdong_h5",
  ),
  [],
  "the JD source keeps no H5 node",
);
assert.deepEqual(
  atomicJingDongMerge.manualTimelines?.find((timeline) => timeline.provider === "jd_h5")
    ?.tracks.map((track) => track.detail),
  ["完整物流进度响应"],
  "a later complete JD H5 response is one package in the jd_h5 slot",
);
const atomicJingDongObservation = atomicJingDongMerge.automaticOwnership
  ?.observations.find((observation) =>
    observation.source === "interface5" &&
    observation.bindingIdentity === "phone:13800001515"
  );
assert.deepEqual(
  atomicJingDongObservation?.sourceTimeline.tracks.filter(
    (track) => track.raw?._pipiStatusSource === "jingdong_h5",
  ),
  [],
  "the persisted automatic observation carries no H5 node either",
);
const jingDongInTransit: Shipment = {
  ...jingDongCompleted,
  timeline: {
    ...timeline("interface5", "JD9988776655", "TRANSIT"),
    tracks: timeline("interface5", "JD9988776655", "TRANSIT").tracks.map(
      (track) => ({
        ...track,
        statusCode: "104",
        raw: { statusCode: "104", _pipiStatusSource: "interface5" },
      }),
    ),
  },
  sourceTimeline: {
    ...timeline("interface5", "JD9988776655", "TRANSIT"),
    tracks: timeline("interface5", "JD9988776655", "TRANSIT").tracks.map(
      (track) => ({
        ...track,
        statusCode: "104",
        raw: { statusCode: "104", _pipiStatusSource: "interface5" },
      }),
    ),
  },
};
const firstK100JingDong = {
  ...timeline("kuaidi100_h5", "JD9988776655", "TRANSIT"),
  complete: true,
  latestDetail: "K100 first node",
  tracks: [{
    ...timeline("kuaidi100_h5", "JD9988776655", "TRANSIT").tracks[0],
    detail: "K100 first node",
    raw: { _pipiKuaidi100Com: "jd" },
  }, {
    ...timeline("kuaidi100_h5", "JD9988776655", "TRANSIT").tracks[0],
    timeText: "2026-08-26 14:00:00",
    timeMs: NOW - 2 * 60 * 60 * 1_000,
    detail: "快件已揽收",
    statusCode: "1",
    raw: { statusCode: "1", _pipiKuaidi100Com: "jd" },
  }],
};
const jingDongWithK100 = applySameSourceTimeline(
  jingDongInTransit,
  firstK100JingDong,
  NOW + 1,
);
// Shared presentation uses one history package while account fields retain their authority.
assert.equal(jingDongWithK100.timeline.provider, "kuaidi100_h5");
assert.equal(
  selectShipmentDetailTimeline(jingDongWithK100).provider,
  "kuaidi100_h5",
);
assert.equal(
  selectShipmentDetailTimeline(jingDongWithK100).latestDetail,
  jingDongInTransit.sourceTimeline!.latestDetail,
);
const jingDongK100AfterAccountCompletion = applySameSourceTimeline(
  jingDongCompleted,
  firstK100JingDong,
  NOW + 1,
);
assert.equal(
  jingDongK100AfterAccountCompletion.timeline.provider,
  "kuaidi100_h5",
  // 用户定 2026-09-05 晚：京东行的列表归 feed；手动包只在详情页选包时顶上来。
  "shared history selection does not replace the completed account status",
);
assert.equal(
  selectShipmentDetailTimeline(jingDongK100AfterAccountCompletion).latestDetail,
  jingDongCompleted.sourceTimeline!.latestDetail,
);
const legacyJingDongPage = {
  ...timeline("jingdong_h5", "JD9988776655", "COMPLETED"),
  complete: true,
  latestDetail: "legacy JD page summary",
};
const jingDongWithLegacyPage = {
  ...jingDongCompleted,
  manualTimelines: [legacyJingDongPage, firstK100JingDong],
};
assert.equal(
  selectShipmentTimeline(jingDongWithLegacyPage).provider,
  "kuaidi100_h5",
  // 用户定 2026-09-05 晚：京东行的列表归 feed；K100 包只在详情页选包。
  "shared history selection ignores the unqualified legacy page",
);
assert.equal(
  selectShipmentDetailTimeline(jingDongWithLegacyPage).provider,
  "kuaidi100_h5",
  "legacy JD page caches must not hide a valid direct K100 package",
);
const unverifiedK100 = {
  ...firstK100JingDong,
  tracks: firstK100JingDong.tracks.map((track) => ({ ...track, raw: {} })),
};
assert.equal(
  selectShipmentDetailTimeline({
    ...jingDongCompleted,
    manualTimelines: [unverifiedK100],
  }).provider,
  "interface5",
  "a legacy K100 package without a validated carrier marker must be ignored",
);
const secondK100JingDong = {
  ...firstK100JingDong,
  statusEventAtMs: NOW + 60_000,
  latestTimeText: "2026-08-26 16:01:00",
  latestDetail: "K100 second node",
  tracks: [{
    ...firstK100JingDong.tracks[0],
    timeText: "2026-08-26 16:01:00",
    timeMs: NOW + 60_000,
    detail: "K100 second node",
  }],
  successAtMs: NOW + 60_000,
};
const jingDongIncremental = applySameSourceTimeline(
  jingDongWithK100,
  secondK100JingDong,
  NOW + 60_000,
);
assert.equal(jingDongIncremental.timeline.provider, "kuaidi100_h5");
assert.equal(selectShipmentDetailTimeline(jingDongIncremental).tracks.length, 3);
assert.equal(
  selectShipmentDetailTimeline(jingDongIncremental).latestDetail,
  jingDongInTransit.sourceTimeline!.latestDetail,
);
const carrierSwitchedK100 = {
  ...firstK100JingDong,
  courierCode: "SF",
  companyName: "顺丰速运",
  latestDetail: "ShunFeng carrier node",
  tracks: [{
    ...firstK100JingDong.tracks[0],
    detail: "ShunFeng carrier node",
    raw: { _pipiKuaidi100Com: "shunfeng" },
  }, {
    ...firstK100JingDong.tracks[0],
    timeText: "2026-08-26 14:00:00",
    timeMs: NOW - 2 * 60 * 60 * 1_000,
    detail: "快件已揽收",
    statusCode: "1",
    raw: { statusCode: "1", _pipiKuaidi100Com: "shunfeng" },
  }],
};
const jingDongCarrierSwitched = applySameSourceTimeline(
  jingDongIncremental,
  carrierSwitchedK100,
  NOW + 120_000,
);
assert.equal(
  selectShipmentDetailTimeline(jingDongCarrierSwitched).courierCode,
  "SF",
);
assert.equal(
  selectShipmentDetailTimeline(jingDongCarrierSwitched).tracks.length,
  2,
  "K100 caches from different detected carriers must never merge",
);
const jingDongReturned = {
  ...jingDongCompleted,
  timeline: {
    ...timeline("interface5", "JD9988776655", "TRANSIT"),
    successAtMs: NOW + 60_000,
    latestDetail: "退回处理中",
    tracks: [{
      ...timeline("interface5", "JD9988776655", "TRANSIT").tracks[0],
      detail: "退回处理中",
    }],
  },
  sourceTimeline: {
    ...timeline("interface5", "JD9988776655", "TRANSIT"),
    successAtMs: NOW + 60_000,
    latestDetail: "退回处理中",
    tracks: [{
      ...timeline("interface5", "JD9988776655", "TRANSIT").tracks[0],
      detail: "退回处理中",
    }],
  },
};
const frozenJingDong = applyAccountShipment(
  jingDongCompleted,
  jingDongReturned,
  NOW + 60_000,
);
assert.equal(frozenJingDong.timeline.semantic, "COMPLETED");
assert.equal(frozenJingDong.timeline.latestDetail, "COMPLETED");
assert.equal(frozenJingDong.sourceTimeline?.tracks.length, 2);
assert.equal(
  frozenJingDong.sourceTimeline?.tracks.some(
    (track) => track.detail === "退回处理中",
  ),
  true,
  "a later real-waybill package may add tracks without reopening a terminal shipment",
);
assert.equal(frozenJingDong.updatedAtMs, NOW + 60_000);

const manualJingDongCompletion = {
  ...timeline("oppo", "JD9988776655", "COMPLETED"),
  successAtMs: NOW + 30_000,
  latestDetail: "manual completion",
};
const jingDongCompletedByDisplayedAuthority: Shipment = {
  ...carrierDetail,
  identity: {
    ...carrierDetail.identity,
    id: "interface5:account:JD9988776655",
    sourceId: "JD9988776655",
    courierCode: "RAW",
    rawCourierCode: "RAW",
    companyName: "原始厂商标签",
    sourceProvider: "JingDong",
  },
  timeline: manualJingDongCompletion,
  sourceTimeline: {
    ...timeline("interface5", "JD9988776655", "TRANSIT"),
    latestDetail: "source transit before freeze",
  },
  manualTimelines: [manualJingDongCompletion],
};
const normalizedJingDongReopen: Shipment = {
  ...jingDongCompletedByDisplayedAuthority,
  identity: {
    ...jingDongCompletedByDisplayedAuthority.identity,
    courierCode: "SF",
    rawCourierCode: "SF",
    rawCompanyName: "原始厂商标签",
    companyName: "顺丰速运",
    carrierIsBuiltIn: true,
    carrierKuaidi100Code: "shunfeng",
    carrierTableVersion: "worker@1",
  },
  timeline: {
    ...timeline("interface5", "JD9988776655", "DELIVERY"),
    successAtMs: NOW + 120_000,
    latestDetail: "source reopened after completion",
  },
  sourceTimeline: {
    ...timeline("interface5", "JD9988776655", "DELIVERY"),
    successAtMs: NOW + 120_000,
    latestDetail: "source reopened after completion",
  },
  manualTimelines: [],
};
const normalizedFrozenJingDong = applyAccountShipment(
  jingDongCompletedByDisplayedAuthority,
  normalizedJingDongReopen,
  NOW + 120_000,
);
assert.equal(normalizedFrozenJingDong.identity.courierCode, "SF");
assert.equal(normalizedFrozenJingDong.identity.companyName, "顺丰速运");
assert.equal(normalizedFrozenJingDong.identity.carrierIsBuiltIn, true);
assert.equal(
  normalizedFrozenJingDong.sourceTimeline?.latestDetail,
  "source reopened after completion",
);
assert.equal(normalizedFrozenJingDong.timeline.semantic, "COMPLETED");
assert.equal(
  normalizedFrozenJingDong.timeline.latestDetail,
  "source reopened after completion",
);
assert.deepEqual(
  normalizedFrozenJingDong.manualTimelines,
  jingDongCompletedByDisplayedAuthority.manualTimelines,
);
assert.equal(normalizedFrozenJingDong.updatedAtMs, NOW + 120_000);
assert.equal(
  shouldScheduleManualRefresh(normalizedFrozenJingDong, NOW + 180_000, true),
  false,
  "JD must not enter the local or route capability refresh queue",
);

const secondJingDongCompletion: Shipment = {
  ...normalizedFrozenJingDong,
  identity: {
    ...normalizedFrozenJingDong.identity,
    id: "interface5:manual:JD9988776655",
    sourceOwner: "manual",
    manuallyAdded: true,
  },
  timeline: {
    ...timeline("oppo", "JD9988776655", "COMPLETED"),
    successAtMs: NOW + 180_000,
    latestDetail: "second completion after freeze",
    tracks: [{
      ...timeline("oppo", "JD9988776655", "COMPLETED").tracks[0],
      detail: "second completion after freeze",
    }],
  },
  sourceTimeline: null,
  manualTimelines: [{
    ...timeline("oppo", "JD9988776655", "COMPLETED"),
    successAtMs: NOW + 180_000,
    latestDetail: "second completion after freeze",
    tracks: [{
      ...timeline("oppo", "JD9988776655", "COMPLETED").tracks[0],
      detail: "second completion after freeze",
    }],
  }],
};
const afterSecondJingDongCompletion = applyManualShipment(
  normalizedFrozenJingDong,
  secondJingDongCompletion,
  NOW + 180_000,
);
assert.equal(afterSecondJingDongCompletion.timeline.semantic, "COMPLETED");
assert.equal(
  afterSecondJingDongCompletion.manualTimelines?.some((manual) =>
    manual.tracks.some((track) => track.detail === "second completion after freeze")
  ),
  true,
  "a later completed package may extend the terminal history",
);
assert.equal(afterSecondJingDongCompletion.updatedAtMs, NOW + 180_000);

const laterManualForCompletedJingDong: Shipment = {
  ...jingDongCompleted,
  identity: {
    ...jingDongCompleted.identity,
    id: "interface5:manual:JD9988776655",
    sourceOwner: "manual",
    manuallyAdded: true,
  },
  timeline: {
    ...timeline("oppo", "JD9988776655", "TRANSIT"),
    successAtMs: NOW + 120_000,
    latestDetail: "later manual package",
  },
  sourceTimeline: null,
  manualTimelines: [{
    ...timeline("oppo", "JD9988776655", "TRANSIT"),
    successAtMs: NOW + 120_000,
    latestDetail: "later manual package",
  }],
  updatedAtMs: NOW + 120_000,
};
const enrichedCompletedJingDong = applyManualShipment(
  jingDongCompleted,
  laterManualForCompletedJingDong,
  NOW + 120_000,
);
assert.equal(enrichedCompletedJingDong.timeline.semantic, "COMPLETED");
assert.equal(enrichedCompletedJingDong.timeline.latestDetail, "COMPLETED");
assert.equal(enrichedCompletedJingDong.manualTimelines?.length, 1);

const laterHistoryForCompletedJingDong: Shipment = {
  ...laterManualForCompletedJingDong,
  identity: {
    ...laterManualForCompletedJingDong.identity,
    id: "interface6:account:JD9988776655",
    bindingSource: null,
    sourceOwner: "interface6:parcel",
    manuallyAdded: false,
  },
  sourceTimeline: laterManualForCompletedJingDong.timeline,
  manualTimelines: [],
};
const enrichedFromHistoricalJingDong = absorbHistoricalShipment(
  jingDongCompleted,
  laterHistoryForCompletedJingDong,
  NOW + 120_000,
);
assert.equal(enrichedFromHistoricalJingDong.timeline.semantic, "COMPLETED");
assert.equal(
  enrichedFromHistoricalJingDong.timeline.latestDetail,
  "COMPLETED",
);
assert.equal(enrichedFromHistoricalJingDong.manualTimelines?.length, 1);

const historicalTimeline = {
  ...timeline("interface6", "SF9988776655", "TRANSIT"),
  latestDetail: "Legacy full timeline",
};
const historicalOwner: Shipment = {
  ...carrierDetail,
  identity: {
    ...carrierDetail.identity,
    id: "legacy-account-owner",
    bindingSource: null,
  },
  timeline: historicalTimeline,
  sourceTimeline: historicalTimeline,
  manualTimelines: [],
};
assert.equal(isHistoricalAccountDuplicate(historicalOwner, carrierDetail), true);
const absorbedHistory = absorbHistoricalShipment(
  carrierDetail,
  historicalOwner,
  NOW + 240_000,
);
assert.equal(absorbedHistory.identity.id, carrierDetail.identity.id);
assert.equal(absorbedHistory.identity.bindingSource, "interface5");
assert.equal(absorbedHistory.sourceTimeline?.provider, "interface5");
assert.deepEqual(
  absorbedHistory.manualTimelines?.map((item) => item.provider),
  ["interface6"],
);
assert.equal(absorbedHistory.timeline.latestDetail, carrierDetail.timeline.latestDetail);
const untimedHistory = {
  ...historicalOwner,
  timeline: {
    ...historicalTimeline,
    provider: "legacy-cache",
    statusEventAtMs: null,
    latestTimeText: "",
    tracks: [{
      timeText: "",
      timeMs: null,
      detail: "Untimed cached node",
      statusCode: "",
      raw: {},
    }],
  },
  sourceTimeline: null,
  manualTimelines: [],
};
const withUntimedHistory = absorbHistoricalShipment(
  absorbedHistory,
  untimedHistory,
  NOW + 300_000,
);
assert.equal(
  withUntimedHistory.manualTimelines?.find(
    (item) => item.provider === "legacy-cache",
  )?.tracks[0]?.detail,
  "Untimed cached node",
);
assert.notEqual(withUntimedHistory.timeline.provider, "legacy-cache");

console.log("shipment projection preservation tests passed");

// 用户定 2026-09-05 晚：feed 增量与 query 独立。接口 5 按件详情（mode=detail）住 v5_query 槽，
// source 槽只装列表 feed；以前详情节点被并进 source，京东订单 4424 的详情页出现两条同一分钟、秒数
// 不同的「预计…」（2026-09-06）。
{
  const feedTrack = (timeText: string, ms: number, detail: string) => ({
    timeText,
    timeMs: ms,
    detail,
    statusCode: "101",
    raw: {},
  });
  const feed: TimelinePackage = {
    ...timeline("interface5", "ORDER123456", "ORDERED"),
    latestTimeText: "2026-08-26 16:00:43",
    latestDetail: "预计8月27日发货，8月28日(周四)送达",
    tracks: [
      feedTrack("2026-08-26 16:00:43", NOW + 43_000, "预计8月27日发货，8月28日(周四)送达"),
      feedTrack("2026-08-26 16:00:39", NOW + 39_000, "您的订单已进入第三方卖家仓库，准备出库"),
    ],
  };
  const row: Shipment = {
    ...order("", "京东购物", "JDKD", null),
    timeline: feed,
    sourceTimeline: feed,
  };
  const detail: TimelinePackage = {
    ...timeline("interface5", "ORDER123456", "ORDERED"),
    latestTimeText: "2026-08-26 16:00:45",
    latestDetail: "预计8月27日发货，8月28日(周四)送达",
    tracks: [
      feedTrack("2026-08-26 16:00:45", NOW + 45_000, "预计8月27日发货，8月28日(周四)送达"),
      feedTrack("2026-08-26 16:00:39", NOW + 39_000, "您的订单已进入第三方卖家仓库，准备出库"),
      feedTrack("2026-08-26 16:00:20", NOW + 20_000, "您提交了订单，请等待第三方卖家系统确认"),
    ],
  };
  const incoming: Shipment = { ...row, timeline: detail, sourceTimeline: detail, manualTimelines: [] };
  const merged = applyTargetedAccountShipment(
    row,
    asAccountDetailObservation(row, incoming),
    NOW + 60_000,
  );
  const source = merged.sourceTimeline || merged.timeline;
  assert.equal(source.provider, "interface5");
  assert.deepEqual(
    source.tracks.map((track) => track.timeText),
    ["2026-08-26 16:00:43", "2026-08-26 16:00:39"],
    "the feed slot keeps only the list feed's own nodes",
  );
  const query = merged.manualTimelines?.find((item) => item.provider === "v5_query");
  assert.equal(query?.tracks.length, 3, "the per-order detail lives whole in the v5_query slot");
  assert.equal(
    merged.timeline.tracks.length,
    3,
    "the newer account query supplies the same whole package to Home and detail",
  );
  const shown = selectShipmentDetailTimeline(merged);
  assert.equal(shown.provider, "v5_query", "the detail page picks the query package on node count");
  assert.equal(shown.tracks.length, 3, "no union with the feed: three nodes, one 「预计」 line");

  // 第二轮详情：同槽增量合并只在 v5_query 内发生，source 仍是 feed。
  const again = applyTargetedAccountShipment(
    merged,
    asAccountDetailObservation(merged, incoming),
    NOW + 120_000,
  );
  assert.equal((again.sourceTimeline || again.timeline).tracks.length, 2);
  assert.equal(
    again.manualTimelines?.filter((item) => item.provider === "v5_query").length,
    1,
  );
}

// 一次性修复（2026-09-06）：带 feedRebuildPending 的 feed 槽被下一次列表同步整包替换（标记随之消失）；
// 按件详情的占位副本带着标记，不触发替换，标记留到真正的列表同步。
{
  const mixed: TimelinePackage = {
    ...timeline("interface5", "ORDER123456", "ORDERED"),
    feedRebuildPending: true,
    // 老版本把详情节点并进了 feed：三条各不相同（同文案 5 分钟内的重复另有合并规则，这里不掺）。
    tracks: [
      { timeText: "2026-08-26 16:00:43", timeMs: NOW + 43_000, detail: "预计8月27日发货", statusCode: "101", raw: {} },
      { timeText: "2026-08-26 16:00:39", timeMs: NOW + 39_000, detail: "您的订单已进入第三方卖家仓库，准备出库", statusCode: "101", raw: {} },
      { timeText: "2026-08-26 16:00:20", timeMs: NOW + 20_000, detail: "您提交了订单", statusCode: "101", raw: {} },
    ],
  };
  const row: Shipment = { ...order("", "京东购物", "JDKD", null), timeline: mixed, sourceTimeline: mixed };
  const listFeed: TimelinePackage = {
    ...timeline("interface5", "ORDER123456", "ORDERED"),
    tracks: [
      { timeText: "2026-08-26 16:00:43", timeMs: NOW + 43_000, detail: "预计8月27日发货", statusCode: "101", raw: {} },
      { timeText: "2026-08-26 16:00:39", timeMs: NOW + 39_000, detail: "您的订单已进入第三方卖家仓库，准备出库", statusCode: "101", raw: {} },
    ],
  };
  const detailIncoming: Shipment = { ...row, timeline: listFeed, sourceTimeline: listFeed, manualTimelines: [] };
  const afterDetail = applyTargetedAccountShipment(
    row,
    asAccountDetailObservation(row, { ...detailIncoming, timeline: { ...listFeed, tracks: [...listFeed.tracks, { timeText: "2026-08-26 16:00:20", timeMs: NOW + 20_000, detail: "您提交了订单", statusCode: "101", raw: {} }] } }),
    NOW + 60_000,
  );
  assert.equal((afterDetail.sourceTimeline || afterDetail.timeline).feedRebuildPending, true, "a detail observation keeps the rebuild mark");
  assert.equal((afterDetail.sourceTimeline || afterDetail.timeline).tracks.length, 3, "a detail observation does not touch the mixed feed slot");

  const afterList = applyAccountShipment(afterDetail, detailIncoming, NOW + 120_000);
  const rebuilt = afterList.sourceTimeline || afterList.timeline;
  assert.equal(rebuilt.feedRebuildPending, undefined, "the list sync clears the mark");
  assert.deepEqual(
    rebuilt.tracks.map((track) => track.timeText),
    ["2026-08-26 16:00:43", "2026-08-26 16:00:39"],
    "the list sync replaces the mixed feed slot with the feed alone",
  );
  const afterSecondList = applyAccountShipment(afterList, detailIncoming, NOW + 180_000);
  assert.equal((afterSecondList.sourceTimeline || afterSecondList.timeline).tracks.length, 2, "later syncs go back to the incremental union");
}

// 签收之后轨迹跟状态一起冻结：终态那一刻存下来的节点，后续任何合并都不许让它变少
// （用户定 2026-09-07。节点被抹空的行连「冻结」判据都不成立，于是继续刷新、再抹一次）。
const settledWithHistory: Shipment = (() => {
  const settled: TimelinePackage = {
    ...timeline("interface5", "SF1234567890", "COMPLETED"),
    latestDetail: "您的快件已签收",
    tracks: [
      {
        timeText: "2026-09-06 09:00:00",
        timeMs: NOW - 7_200_000,
        detail: "快件已到达深圳宝安",
        statusCode: "0",
        raw: {},
      },
      {
        timeText: "2026-09-06 11:00:00",
        timeMs: NOW,
        detail: "您的快件已签收",
        statusCode: "3",
        raw: {},
      },
    ],
  };
  return {
    ...shipmentWithCachedHistory,
    identity: { ...shipmentWithCachedHistory.identity, id: "interface5:account:SF1234567890" },
    timeline: settled,
    sourceTimeline: settled,
    manualTimelines: [],
  };
})();
assert.equal(hasSettledTimelineHistory(settledWithHistory), true);

const summaryOnly: TimelinePackage = {
  ...timeline("interface5", "SF1234567890", "COMPLETED"),
  latestDetail: "",
  latestTimeText: "",
  tracks: [],
};
const afterSummaryRound = applyAccountShipment(
  settledWithHistory,
  { ...settledWithHistory, timeline: summaryOnly, sourceTimeline: summaryOnly },
  NOW + 1,
);
assert.equal(
  afterSummaryRound.timeline.tracks.length,
  2,
  "a settled row must not lose its nodes to a later summary-only round",
);
assert.equal(hasSettledTimelineHistory(afterSummaryRound), true);
