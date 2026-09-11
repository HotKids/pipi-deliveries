import assert from "node:assert/strict";
import type { AppState, Shipment, TimelinePackage } from "../models";
import type { AccountParcelDto } from "../services/account-parser";
import { setDiagnosticsEnabled } from "../services/logger";

import { memory } from "./state-storage-mock";
import { emptyState, saveState, loadState } from "../services/storage";
import { clearDiagnostics, readDiagnostics } from "../services/logger";
import { runShipmentRefreshForTesting } from "../services/sync";
const PHONE = "13800138000";
const ROUTE = "https://page.cainiao.com/detail?mailNo=TEST";

function timeline(
  waybill: string,
  detail: string,
  successAtMs: number,
  semantic: TimelinePackage["semantic"] = "TRANSIT",
): TimelinePackage {
  return {
    provider: "interface5",
    waybill,
    courierCode: "ZTO",
    companyName: "中通快递",
    semantic,
    statusEventAtMs: successAtMs,
    latestTimeText: "2026-08-30 18:00:00",
    latestDetail: detail,
    tracks: [{
      timeText: "2026-08-30 18:00:00",
      timeMs: successAtMs,
      detail,
      statusCode: semantic === "DELIVERY" ? "107" : "104",
      raw: {},
    }],
    successAtMs,
  };
}

function shipment(suffix: string, now: number): Shipment {
  const waybill = `ZT${suffix}`;
  const sourceTimeline = timeline(waybill, `seed-${suffix}`, now - 10_000);
  return {
    identity: {
      id: `interface5:account:${waybill}`,
      bindingSource: "interface5",
      sourceOwner: "interface5",
      sourceId: waybill,
      phoneTail: PHONE.slice(-4),
      phone: PHONE,
      courierCode: "ZTO",
      rawCourierCode: "ZTO",
      companyName: "中通快递",
      sourceProvider: "Cainiao",
      accountOrder: false,
      manuallyAdded: false,
      createdAtMs: now - 20_000,
    },
    timeline: sourceTimeline,
    sourceTimeline,
    manualTimelines: [],
    route: { kind: "cainiao", source: "interface5" },
    accountRecord: {
      waybill,
      companyCode: "ZTO",
      name: "中通快递",
      provider: "Cainiao",
      stateNumber: 104,
      updateTime: "2026-08-30 18:00:00",
      phone: PHONE,
      channel: "account",
    },
    updatedAtMs: now - 10_000,
  };
}

function completedOrder(now: number): Shipment {
  const orderId = "ORDER202608307119";
  const sourceTimeline: TimelinePackage = {
    ...timeline(orderId, "订单已完成", now - 10_000, "ORDERED"),
    courierCode: "JD",
    companyName: "京东购物",
  };
  return {
    identity: {
      id: `interface5:account:${orderId}`,
      bindingSource: "interface5",
      sourceOwner: "interface5:order",
      sourceId: orderId,
      phoneTail: PHONE.slice(-4),
      phone: PHONE,
      courierCode: "JD",
      rawCourierCode: "JD",
      companyName: "京东购物",
      sourceProvider: "JingDong",
      orderId,
      projectedWaybill: "",
      accountOrder: true,
      manuallyAdded: false,
      createdAtMs: now - 20_000,
    },
    timeline: sourceTimeline,
    sourceTimeline,
    manualTimelines: [],
    statusPresentation: {
      scope: "ORDER",
      semantic: "COMPLETED",
      text: "已完成",
    },
    route: null,
    accountRecord: {
      waybill: orderId,
      companyCode: "JD",
      name: "京东购物",
      provider: "JingDong",
      stateNumber: 15,
      updateTime: "2026-08-30 18:00:00",
      phone: PHONE,
      channel: "account",
    },
    updatedAtMs: now - 10_000,
  };
}

function settledShipment(suffix: string, now: number): Shipment {
  const value = shipment(suffix, now);
  const completed = timeline(
    value.identity.sourceId,
    `signed-${suffix}`,
    now - 5_000,
    "COMPLETED",
  );
  completed.tracks.push({
    timeText: "2026-08-30 17:00:00",
    timeMs: now - 10_000,
    detail: `transit-${suffix}`,
    statusCode: "104",
    raw: {},
  });
  return {
    ...value,
    timeline: completed,
    sourceTimeline: completed,
    updatedAtMs: now - 5_000,
  };
}

function detailParcel(value: Shipment, now: number): AccountParcelDto {
  const waybill = value.identity.sourceId;
  return {
    source: "interface5",
    ownerId: waybill,
    waybill,
    orderId: "",
    accountOrder: false,
    courierCode: "ZTO",
    rawCourierCode: "ZTO",
    companyName: "中通快递",
    sourceProvider: "Cainiao",
    sourceStateCode: "104",
    sourceStateText: "运输中",
    semantic: "TRANSIT",
    receiverPhone: PHONE,
    senderPhone: "",
    latestTimeText: "2026-08-30 18:01:00",
    latestDetail: `detail-${waybill}`,
    tracks: [{
      timeText: "2026-08-30 18:01:00",
      detail: `detail-${waybill}`,
      statusCode: "104",
    }],
    routeUrl: ROUTE,
    projectionUrl: "",
  };
}

function appState(shipments: readonly Shipment[], now: number): AppState {
  return {
    version: 2,
    revision: 1,
    updatedAtMs: now,
    activeSource: "interface5",
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: now - 30_000 }],
    pendingQueries: [],
    shipments,
  };
}

const now = Date.now();
memory.clear(); setDiagnosticsEnabled(true);
const initial = saveState(appState([shipment("5900", now), shipment("7226", now)], now), now);
let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const calls: string[] = [];
const run = (row: Shipment) => runShipmentRefreshForTesting(row.identity.id,
  { isCurrent: () => true, deadlineAtMs: now + 60000 }, { trigger: "detail_open" }, {
    refreshAccountParcel: async current => {
      calls.push(current.identity.id);
      if (current.identity.sourceId.endsWith("5900")) await gate;
      return detailParcel(current, now + 1000);
    },
    queryManualForSource: async () => { assert.fail("an incomplete entry result must not cascade to providers"); },
  });
const slow = run(initial.shipments.find(row => row.identity.sourceId.endsWith("5900"))!);
const fast = await run(initial.shipments.find(row => row.identity.sourceId.endsWith("7226"))!);
assert.equal(fast.querySucceeded, true);
assert.ok(loadState().shipments.find(s => s.identity.id === fast.shipment.identity.id)?.manualTimelines?.some(p => p.provider === "v5_query"));
release(); assert.equal((await slow).querySucceeded, true);
assert.equal(calls.length, 2);
assert.ok(loadState().shipments.every(s => s.manualTimelines?.some(p => p.provider === "v5_query")),
  "independent detail entries preserve both committed slots");
console.log("account detail entry commits independently without starting the history chain");
