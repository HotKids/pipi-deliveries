import assert from "node:assert/strict";

import type { Shipment, TimelinePackage, TrackNode } from "../models";
import { GatewayError } from "../services/gateway";
import { needsManualPhoneTail } from "../services/jt-h5";
import { queryMotoShipment } from "../services/manual-query";
import {
  withAttachedOrderStage,
  withJingDongOwnerOrderStage,
} from "../services/order-stage-policy";
import { headlineTrack } from "../services/status";
import {
  isValidNonFutureStatusClock,
  preservesTerminalStatus,
} from "../services/terminal-clock-policy";

const NOW = Date.UTC(2026, 10, 15, 10, 0, 0);

function makeNode(
  timeText: string,
  timeMs: number,
  detail: string,
  raw?: Record<string, unknown>,
): TrackNode {
  return {
    timeText,
    timeMs,
    detail,
    statusCode: "",
    raw,
  };
}

function makePackage(overrides: Partial<TimelinePackage> = {}): TimelinePackage {
  return {
    provider: "interface5",
    waybill: "JT4006839564547",
    courierCode: "JTSD",
    companyName: "极兔速递",
    semantic: "COMPLETED",
    structuredStatus: true,
    statusEventAtMs: NOW - 3_600_000,
    latestTimeText: "2026-11-15 17:00:00",
    latestDetail: "快件已签收",
    complete: true,
    tracks: [
      makeNode("2026-11-15 17:00:00", NOW - 3_600_000, "快件已签收"),
    ],
    successAtMs: NOW,
    ...overrides,
  };
}

function makeOrderShipment(
  id: string,
  tracks: TrackNode[],
  semantic: TimelinePackage["semantic"] = "COMPLETED",
): Shipment {
  const sourceTimeline = makePackage({
    provider: "interface5",
    waybill: id,
    courierCode: "JDKD",
    companyName: "京东购物",
    semantic,
    structuredStatus: true,
    statusEventAtMs: NOW - 1_800_000,
    tracks,
  });
  return {
    id,
    identity: {
      waybill: id,
      projectedWaybill: "JT4006839564547",
      orderId: id,
      accountOrder: true,
      manuallyAdded: false,
      courierCode: "JTSD",
      rawCourierCode: "JDKD",
      companyName: "极兔速递",
      rawCompanyName: "京东购物",
      sourceProvider: "JingDong",
      bindingSource: "interface5",
      receiverPhone: "13800001515",
      senderPhone: "",
    },
    timeline: sourceTimeline,
    sourceTimeline,
    manualTimelines: {},
    updatedAtMs: NOW,
  } as unknown as Shipment;
}

// --- B-03: Same-terminal COMPLETED clock protection & future-clock repair ---
{
  assert.equal(isValidNonFutureStatusClock(NOW - 1_000, NOW), true);
  assert.equal(isValidNonFutureStatusClock(0, NOW), false);
  assert.equal(isValidNonFutureStatusClock(NOW + 60_000, NOW), false);

  const validAnchor = makePackage({
    semantic: "COMPLETED",
    structuredStatus: true,
    statusEventAtMs: NOW - 3_600_000,
  });
  const futureIncoming = makePackage({
    semantic: "COMPLETED",
    structuredStatus: true,
    statusEventAtMs: NOW + 86_400_000,
  });
  const missingIncoming = makePackage({
    semantic: "COMPLETED",
    structuredStatus: true,
    statusEventAtMs: 0,
  });

  const guardedAgainstFuture = preservesTerminalStatus(
    validAnchor,
    futureIncoming,
    true,
    false,
    NOW,
  );
  assert.equal(guardedAgainstFuture.statusEventAtMs, NOW - 3_600_000);

  const guardedAgainstMissing = preservesTerminalStatus(
    validAnchor,
    missingIncoming,
    true,
    false,
    NOW,
  );
  assert.equal(guardedAgainstMissing.statusEventAtMs, NOW - 3_600_000);

  const corruptedFutureStored = makePackage({
    semantic: "COMPLETED",
    structuredStatus: true,
    statusEventAtMs: NOW + 86_400_000,
  });
  const validRepair = makePackage({
    semantic: "COMPLETED",
    structuredStatus: true,
    statusEventAtMs: NOW - 900_000,
  });
  const repaired = preservesTerminalStatus(
    corruptedFutureStored,
    validRepair,
    true,
    true,
    NOW,
  );
  assert.equal(repaired.statusEventAtMs, NOW - 900_000);
}

// --- B-04: Order-stage headline skip & redundant completion node filtering ---
{
  const orderOnlyNode = makeNode(
    "2026-11-15 17:30:00",
    NOW - 1_800_000,
    "您的订单已完成",
    {
      normalizedStatus: {
        version: 1,
        scope: "ORDER",
        semantic: "COMPLETED",
        code: "ORDER_COMPLETED",
        text: "已完成",
        priority: 10,
        eventAtMs: NOW - 1_800_000,
        structured: true,
        orderStageOnly: true,
      },
    },
  );
  const shipmentPickupNode = makeNode(
    "2026-11-15 15:00:00",
    NOW - 10_800_000,
    "极兔速递已揽收",
    {
      normalizedStatus: {
        version: 1,
        scope: "SHIPMENT",
        semantic: "PICKED",
        code: "PICKED",
        text: "已揽收",
        priority: 20,
        eventAtMs: NOW - 10_800_000,
        structured: true,
      },
    },
  );

  // When SHIPMENT-scoped observations exist, orderStageOnly yields headline.
  assert.equal(
    headlineTrack([orderOnlyNode, shipmentPickupNode])?.detail,
    "极兔速递已揽收",
  );
  // Prior to carrier pickup (no SHIPMENT node yet), order-stage node stays headline.
  assert.equal(headlineTrack([orderOnlyNode])?.detail, "您的订单已完成");

  const tOrderCreated = NOW - 20_000_000;
  const tOrderPicked = NOW - 18_000_000;
  const tOrderFakeDone = NOW - 15_000_000;
  const tCarrierPickup = NOW - 12_000_000;

  const ownerFeedTracks: TrackNode[] = [
    makeNode(
      "2026-11-15 13:50:00",
      tOrderFakeDone,
      "您的订单[极兔测试商品]已完成，10京豆等您拿，完成评价即有机会获得，不要错过呦！",
    ),
    makeNode(
      "2026-11-15 13:48:00",
      tOrderFakeDone - 30_000,
      "感谢您在京东购物",
      { logisticsStatusDesc: "评价赢京豆" },
    ),
    makeNode("2026-11-15 13:45:00", tOrderFakeDone - 60_000, "订单已完成"),
    makeNode(
      "2026-11-15 13:40:00",
      tOrderFakeDone - 120_000,
      "系统确认完成",
      {
        normalizedStatus: {
          version: 1,
          scope: "ORDER",
          semantic: "COMPLETED",
          code: "DONE",
          text: "已完成",
          priority: 10,
          eventAtMs: tOrderFakeDone - 120_000,
          structured: true,
        },
      },
    ),
    makeNode(
      "2026-11-15 13:00:00",
      tOrderPicked,
      "您的订单已经拣货完成，待出库交付极兔速递",
    ),
    makeNode(
      "2026-11-15 12:26:40",
      tOrderCreated,
      "您提交了订单，请等待系统确认",
    ),
  ];

  const owner = makeOrderShipment("3610448002878202", ownerFeedTracks);
  const carrierFallback = makePackage({
    provider: "kuaidi100",
    semantic: "TRANSIT",
    tracks: [
      makeNode("2026-11-15 14:40:00", tCarrierPickup, "极兔速递已收取快件"),
    ],
  });

  const withOwnerStage = withJingDongOwnerOrderStage(
    owner,
    carrierFallback,
    true,
    (s) => s.sourceTimeline || null,
  );
  assert.deepEqual(
    withOwnerStage.tracks.map((n) => n.detail),
    [
      "极兔速递已收取快件",
      "您的订单已经拣货完成，待出库交付极兔速递",
      "您提交了订单，请等待系统确认",
    ],
  );

  const withAttached = withAttachedOrderStage(
    carrierFallback,
    [owner],
    (s) => s.sourceTimeline || null,
  );
  assert.deepEqual(
    withAttached.tracks.map((n) => n.detail),
    [
      "极兔速递已收取快件",
      "您的订单已经拣货完成，待出库交付极兔速递",
      "您提交了订单，请等待系统确认",
    ],
  );
}

// --- B-05: Moto phone-verification error classification ---
{
  await assert.rejects(
    () =>
      queryMotoShipment({
        waybill: "ZT123456789012",
        rawCourierCode: "ZTO",
        courierCode: "ZTO",
        dependencies: {
          post: async () => {
            throw new GatewayError(
              "Phone tail required",
              400,
              "phone_verification_required",
            );
          },
        },
      }),
    (err: unknown) => {
      assert.equal(needsManualPhoneTail(err), true);
      return true;
    },
  );

  await assert.rejects(
    () =>
      queryMotoShipment({
        waybill: "ZT123456789012",
        rawCourierCode: "ZTO",
        courierCode: "ZTO",
        dependencies: {
          post: async () => ({
            status: "201",
            reason: "请输入收寄件人手机尾号后四位进行验证",
          }),
        },
      }),
    (err: unknown) => {
      assert.equal(needsManualPhoneTail(err), true);
      return true;
    },
  );
}
