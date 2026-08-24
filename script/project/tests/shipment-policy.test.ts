import assert from "node:assert/strict";
import type { Shipment, TimelinePackage } from "../models";
import {
  activeManualRefreshLease,
  absorbHistoricalShipment,
  applyAccountShipment,
  applyTargetedAccountShipment,
  beginManualRefreshAttempt,
  displayWaybill,
  isHistoricalAccountDuplicate,
  MANUAL_REFRESH_MIN_INTERVAL_MS,
  manualTimelineOwnsShipment,
  ownsManualRefreshLease,
  prefersKuaidi100First,
  releaseManualRefreshLease,
  shouldScheduleManualRefresh,
  sourceTimelineOwnsShipment,
  unprojectedAccountOrder,
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

const current = order(
  "SF1234567890",
  "顺丰速运",
  "SF",
  null,
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
assert.equal(noTimedUnprojected.timeline.semantic, "ORDERED");
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
const afterJdProjection = applyAccountShipment(
  summary,
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

const completedCarrier = timeline("kuaidi100", "SF1234567890", "COMPLETED");
const withCarrierAuthority = applyAccountShipment(
  { ...current, manualTimelines: [completedCarrier], timeline: completedCarrier },
  summary,
  NOW + 120_000,
);
assert.equal(withCarrierAuthority.sourceTimeline?.semantic, "COMPLETED");
assert.equal(withCarrierAuthority.timeline.semantic, "COMPLETED");
assert.equal(withCarrierAuthority.timeline.provider, "interface5");
assert.equal(sourceTimelineOwnsShipment(withCarrierAuthority), true);
assert.equal(manualTimelineOwnsShipment(withCarrierAuthority), false);

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
  true,
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
assert.equal(prefersKuaidi100First(alternateShunFeng), true);
assert.equal(sourceTimelineOwnsShipment(alternateShunFeng), false);
assert.equal(shouldScheduleManualRefresh(alternateShunFeng, NOW), true);
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
assert.equal(
  prefersKuaidi100First({
    ...alternateShunFeng,
    identity: { ...alternateShunFeng.identity, sourceProvider: "carrier-detail" },
  }),
  false,
);
assert.equal(
  prefersKuaidi100First({
    ...alternateShunFeng,
    identity: { ...alternateShunFeng.identity, bindingSource: "interface6" },
  }),
  false,
);
assert.equal(manualTimelineOwnsShipment(carrierDetail), false);
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
assert.equal(manualTimelineOwnsShipment(shunFengWithManual), true);
assert.equal(shouldScheduleManualRefresh(shunFengWithManual, NOW), false);
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
);

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
