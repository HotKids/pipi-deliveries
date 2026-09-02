import assert from "node:assert/strict";
import type { AccountParcelDto } from "../services/account-parser";
import { parseAccountSyncResponse } from "../services/account-parser";
import { buildAccountTimelineRequest } from "../services/account-api";
import {
  normalizeAccountParcelCarrierBestEffort,
  parcelToShipment,
} from "../services/account-sync";
import { OperationTimeoutError } from "../services/deadline";
import { GatewayError } from "../services/gateway";
import {
  applyAccountShipment,
  isQualifiedAutomaticShipment,
} from "../services/shipment-policy";
import {
  buildWidgetSnapshot,
  shipmentPresentationStatus,
  statusLabel,
} from "../services/status";

const NOW = Date.UTC(2026, 7, 27, 6, 46, 0);
const PHONE = "13800001515";
const CAINIAO_ROUTE = "https://page.cainiao.com/detail?mailNo=TEST";

function order(waybill: string, courierCode: string, companyName: string) {
  return {
    source: "interface5",
    ownerId: "ORDER202608270001",
    waybill,
    orderId: "ORDER202608270001",
    accountOrder: true,
    courierCode,
    companyName,
    sourceProvider: "JingDong",
    sourceStateCode: "102",
    sourceStateText: "运输中",
    semantic: "TRANSIT",
    normalizedStatusScope: "ORDER",
    normalizedStatusSemantic: "COMPLETED",
    normalizedStatusText: "已完成",
    receiverPhone: PHONE,
    senderPhone: "",
    latestTimeText: "2026-08-27 03:17:48",
    latestDetail: "您的订单已离开分拣中心",
    tracks: [{
      timeText: "2026-08-27 03:17:48",
      detail: "您的订单已离开分拣中心",
      statusCode: "102",
    }],
    routeUrl: "",
    projectionUrl: "https://u.jd.com/example",
  } satisfies AccountParcelDto;
}

const recognitionInput = order(
  "UNRECOGNIZED202608270001",
  "UPSTREAM_UNKNOWN",
  "上游原始名称",
);
for (const failure of [
  new OperationTimeoutError(),
  new GatewayError("synthetic recognition failure", 503),
]) {
  const preserved = await normalizeAccountParcelCarrierBestEffort(
    recognitionInput,
    { recognize: async () => { throw failure; } },
  );
  assert.strictEqual(
    preserved,
    recognitionInput,
    "display-only recognition failure must preserve the account parcel",
  );
}

const recognitionAbort = new Error("synthetic recognition cancellation");
recognitionAbort.name = "AbortError";
await assert.rejects(
  normalizeAccountParcelCarrierBestEffort(recognitionInput, {
    recognize: async () => { throw recognitionAbort; },
  }),
  (error) => error === recognitionAbort,
  "explicit recognition cancellation must still escape account sync",
);

const recognitionDefect = new TypeError("synthetic recognition defect");
await assert.rejects(
  normalizeAccountParcelCarrierBestEffort(recognitionInput, {
    recognize: async () => { throw recognitionDefect; },
  }),
  (error) => error === recognitionDefect,
  "unexpected recognition defects must not be hidden as best effort",
);

const cancelledRecognition = new AbortController();
const parentCancellation = new OperationTimeoutError();
await assert.rejects(
  normalizeAccountParcelCarrierBestEffort(recognitionInput, {
    signal: cancelledRecognition.signal,
    recognize: async () => {
      cancelledRecognition.abort();
      throw parentCancellation;
    },
  }),
  (error) => error === parentCancellation,
  "an aborted account-sync generation must not be converted into best effort",
);

const unresolved = parcelToShipment(
  order("ORDER202608270001", "JD", "京东购物"),
  [PHONE],
  NOW,
)!;
assert.equal(unresolved.identity.companyName, "京东购物");
assert.equal(unresolved.identity.projectedWaybill, "");
assert.equal(unresolved.timeline.semantic, "TRANSIT");
assert.deepEqual(unresolved.statusPresentation, {
  scope: "ORDER",
  semantic: "COMPLETED",
  text: "已完成",
});
assert.deepEqual(shipmentPresentationStatus(unresolved), {
  semantic: "COMPLETED",
  text: "已完成",
});
const unresolvedWidget = buildWidgetSnapshot([unresolved], NOW);
assert.equal(unresolvedWidget.rows[0]?.semantic, "COMPLETED");
assert.equal(unresolvedWidget.rows[0]?.statusLabel, "已完成");
assert.equal(unresolvedWidget.headline?.semantic, "COMPLETED");
assert.equal(unresolvedWidget.headline?.label, "已完成");
assert.equal(
  unresolvedWidget.activeCount,
  0,
  "an order-completed fallback is visible but is not an active shipment",
);

const completedShortOrder = parseAccountSyncResponse("interface5", {
  code: 0,
  data: {
    expressList: [{
      mailNo: "350365030147",
      cpCode: "JD",
      name: "京东快递",
      provider: "JingDong",
      state: "已完成",
      stateNum: 107,
      details: [{
        time: "2026-08-25 23:04:00",
        desc: "您的订单350365030147已完成，感谢您对京东的支持。",
      }],
    }],
  },
})[0];
const completedShortShipment = applyAccountShipment(
  undefined,
  parcelToShipment(completedShortOrder, [PHONE], NOW)!,
  NOW,
);
assert.equal(completedShortShipment.identity.accountOrder, true);
assert.equal(completedShortShipment.timeline.semantic, "COMPLETED");
assert.deepEqual(
  shipmentPresentationStatus(completedShortShipment),
  { semantic: "COMPLETED", text: "已完成" },
  "the completed short JD order shown in detail must never be relabelled as ordered",
);

const unresolvedPicked = parcelToShipment(
  {
    ...order("ORDER202608270001", "JD", "京东购物"),
    semantic: "PICKED",
    normalizedStatusSemantic: "PICKED",
    normalizedStatusText: "已揽收",
    latestDetail: "您的订单已由京东快递揽收",
    tracks: [{
      timeText: "2026-08-27 03:17:48",
      detail: "您的订单已由京东快递揽收",
      statusCode: "103",
    }],
  },
  [PHONE],
  NOW,
)!;
assert.equal(unresolvedPicked.timeline.semantic, "ORDERED");
assert.deepEqual(unresolvedPicked.statusPresentation, {
  scope: "ORDER",
  semantic: "PICKED",
  text: "已揽收",
});
assert.deepEqual(shipmentPresentationStatus(unresolvedPicked), {
  semantic: "ORDERED",
  text: "已下单",
});
assert.deepEqual(
  shipmentPresentationStatus({
    ...unresolvedPicked,
    statusPresentation: {
      scope: "ORDER",
      semantic: "PICKED",
      text: "已揽收",
    },
  }),
  { semantic: "ORDERED", text: "已下单" },
  "legacy cached order pickup must not bypass the unprojected-order status",
);
assert.deepEqual(
  shipmentPresentationStatus({
    ...unresolvedPicked,
    timeline: {
      ...unresolvedPicked.timeline,
      semantic: "COMPLETED",
      latestDetail: "您的订单350365030147已完成",
    },
  }),
  { semantic: "COMPLETED", text: "已完成" },
  "a stale pickup sidecar must not downgrade a completed order timeline",
);
assert.deepEqual(
  shipmentPresentationStatus({
    ...unresolved,
    statusPresentation: {
      scope: "ORDER",
      semantic: "COMPLETED",
      text: "订单已完成",
    },
  }),
  { semantic: "COMPLETED", text: "已完成" },
  "legacy cached order-completion copy is normalized at presentation time",
);

const projected = parcelToShipment(
  order("JD0256747737308", "JD", "京东快递"),
  [PHONE],
  NOW,
)!;
assert.equal(projected.identity.companyName, "京东快递");
assert.equal(projected.identity.courierCode, "JD");
assert.equal(projected.identity.projectedWaybill, "JD0256747737308");
assert.equal(projected.statusPresentation, undefined);
assert.equal(projected.timeline.companyName, "京东快递");
assert.equal(projected.timeline.courierCode, "JD");

const projectedWithH5 = parcelToShipment(
  {
    ...order("JD0256747737308", "JD", "京东快递"),
    projectionTimeline: {
      provider: "interface5",
      complete: false,
      structuredStatus: false,
      waybill: "JD0256747737308",
      courierCode: "JD",
      companyName: "京东快递",
      semantic: "DELIVERY",
      statusEventAtMs: Date.UTC(2026, 7, 27, 0, 30, 0),
      latestTimeText: "2026-08-27 08:30:00",
      latestDetail: "正在派送",
      tracks: [{
        timeText: "2026-08-27 08:30:00",
        timeMs: Date.UTC(2026, 7, 27, 0, 30, 0),
        detail: "正在派送",
        statusCode: "",
        raw: {},
      }, {
        timeText: "2026-08-26 14:00:00",
        timeMs: Date.UTC(2026, 7, 26, 6, 0, 0),
        detail: "快件运输中",
        statusCode: "",
        raw: {},
      }, {
        timeText: "2026-08-25 09:00:00",
        timeMs: Date.UTC(2026, 7, 25, 1, 0, 0),
        detail: "快件已揽收",
        statusCode: "",
        raw: {},
      }],
      successAtMs: NOW + 1,
    },
  },
  [PHONE],
  NOW + 1,
)!;
assert.equal(projectedWithH5.timeline.latestDetail, "正在派送");
assert.equal(projectedWithH5.timeline.tracks.length, 3);
assert.equal(projectedWithH5.sourceTimeline?.tracks.length, 3);
assert.equal(
  projectedWithH5.timeline.tracks.some(
    (track) => track.detail === "您的订单已离开分拣中心",
  ),
  false,
  "an order summary must not enter the projected shipment timeline",
);

const completedH5WithStaleShipmentSidecar = {
  ...projectedWithH5,
  timeline: {
    ...projectedWithH5.timeline,
    semantic: "COMPLETED" as const,
    latestDetail: "已签收",
  },
  statusPresentation: {
    scope: "SHIPMENT" as const,
    semantic: "DELIVERY" as const,
    text: "派送中",
  },
};
assert.deepEqual(
  shipmentPresentationStatus(completedH5WithStaleShipmentSidecar),
  { semantic: "COMPLETED", text: "已签收" },
  "a stale account-list shipment sidecar must not override an H5 completion",
);
const completedH5WithStaleOrderSidecar = {
  ...completedH5WithStaleShipmentSidecar,
  statusPresentation: {
    scope: "ORDER" as const,
    semantic: "COMPLETED" as const,
    text: "订单已完成",
  },
};
assert.deepEqual(
  shipmentPresentationStatus(completedH5WithStaleOrderSidecar),
  { semantic: "COMPLETED", text: "已签收" },
  "a projected waybill must ignore even a stale order-completion presentation",
);
assert.equal(
  buildWidgetSnapshot([completedH5WithStaleOrderSidecar], NOW).rows[0]?.statusLabel,
  "已签收",
);
const mixedCompletedWidget = buildWidgetSnapshot([
  unresolved,
  completedH5WithStaleOrderSidecar,
], NOW);
assert.deepEqual(
  mixedCompletedWidget.rows.map((row) => row.statusLabel),
  ["已签收", "已完成"],
  "a real signed shipment must rank above an order-completed fallback",
);
assert.deepEqual(mixedCompletedWidget.headline, {
  semantic: "COMPLETED",
  label: "已签收",
  count: 1,
});
assert.equal(mixedCompletedWidget.activeCount, 0);
assert.equal(statusLabel("COMPLETED"), "已签收");

const widget = buildWidgetSnapshot([projected], NOW);
assert.equal(widget.rows[0]?.companyName, "京东快递");
assert.equal(widget.rows[0]?.accountOrder, false);
assert.equal(widget.compactIcons[0]?.companyName, "京东快递");

const projectedSf = parcelToShipment(
  order("SF0256747737309", "SF", "顺丰速运"),
  [PHONE],
  NOW,
)!;
assert.equal(projectedSf.identity.courierCode, "SF");
assert.equal(projectedSf.identity.companyName, "顺丰速运");

const routeParcel = {
  ...order("SF0256747737310", "SF", "顺丰速运"),
  ownerId: "SF0256747737310",
  orderId: "",
  accountOrder: false,
  sourceProvider: "CaiNiao",
  routeUrl: CAINIAO_ROUTE,
  projectionUrl: "",
} satisfies AccountParcelDto;

const normalizedWithoutRaw = parcelToShipment(
  {
    ...routeParcel,
    rawCourierCode: "",
    courierCode: "SF",
    companyName: "顺丰速运",
    carrierNormalization: {
      standardCode: "SF",
      displayName: "顺丰速运",
      kuaidi100Code: "shunfeng",
      isBuiltIn: true,
      tableVersion: "builtin-carriers-final-v2",
    },
  },
  [PHONE],
  NOW,
)!;
assert.equal(normalizedWithoutRaw.identity.courierCode, "SF");
assert.equal(normalizedWithoutRaw.identity.rawCourierCode, "");
assert.equal(
  isQualifiedAutomaticShipment(normalizedWithoutRaw, "interface5"),
  false,
  "display normalization must not substitute for a missing raw carrier",
);
assert.equal(
  isQualifiedAutomaticShipment({
    ...normalizedWithoutRaw,
    identity: {
      ...normalizedWithoutRaw.identity,
      rawCompanyName: "顺丰来源原名",
    },
  }, "interface5"),
  true,
  "an original Chinese carrier name satisfies the carrier qualification field",
);

function normalizedSourceShipment(
  standardCode: string,
  displayName: string,
) {
  const parcel = parseAccountSyncResponse("interface5", {
    code: 0,
    data: {
      expressList: [{
        mailNo: "RAWDETAILPAYLOAD0001",
        cpCode: "source_sf",
        name: "来源承运商原名",
        normalizedCarrierCode: standardCode,
        normalizedCarrierName: displayName,
        carrierBuiltIn: true,
        provider: "ShunFeng",
        stateNum: 104,
        phone: PHONE,
      }],
    },
  })[0];
  return parcelToShipment(parcel, [PHONE], NOW)!;
}

const displaySf = normalizedSourceShipment("SF", "顺丰速运");
const displayJd = normalizedSourceShipment("JD", "京东快递");
assert.equal(displaySf.identity.rawCourierCode, "source_sf");
assert.equal(displaySf.identity.rawCompanyName, "来源承运商原名");
assert.equal(displaySf.accountRecord?.companyCode, "source_sf");
assert.equal(displaySf.accountRecord?.name, "来源承运商原名");
assert.deepEqual(displaySf.accountRecord, displayJd.accountRecord);
const detailRequest = buildAccountTimelineRequest({
  source: "interface5",
  mode: "detail",
  identity: {
    userId: "1234567890",
    oaid: "0011223344556677",
    vaid: "8899aabbccddeeff",
  },
  record: displaySf.accountRecord!,
});
assert.equal(
  (detailRequest.payload.record as Record<string, unknown>).companyCode,
  "source_sf",
);
assert.equal(
  (detailRequest.payload.record as Record<string, unknown>).name,
  "来源承运商原名",
);
assert.notEqual(
  (detailRequest.payload.record as Record<string, unknown>).companyCode,
  displaySf.identity.courierCode,
);
assert.deepEqual(
  parcelToShipment(routeParcel, [PHONE], NOW)?.route,
  { kind: "cainiao", source: "interface5" },
);
for (const sourceProvider of ["ShunFeng", "JingDong", "", "Other"]) {
  assert.equal(
    parcelToShipment(
      { ...routeParcel, sourceProvider },
      [PHONE],
      NOW,
    )?.route,
    null,
  );
}

console.log("account shipment presentation tests passed");
