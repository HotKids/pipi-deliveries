import assert from "node:assert/strict";
import type { AppState, Shipment, TimelinePackage } from "../models";
import type { AccountParcelDto } from "../services/account-parser";

const diagnosticStorage = new Map<string, unknown>();
Object.assign(globalThis, {
  Storage: {
    get<T>(key: string): T | null {
      return (diagnosticStorage.get(key) as T | undefined) ?? null;
    },
    set(key: string, value: unknown): boolean {
      diagnosticStorage.set(key, structuredClone(value));
      return true;
    },
    remove(key: string): void {
      diagnosticStorage.delete(key);
    },
  },
});

const { clearDiagnostics, readDiagnostics } = await import("../services/logger");
const { runAccountFollowupsForTesting } = await import("../services/sync");

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
const initial = appState(
  [shipment("5900", now), shipment("7226", now), shipment("0238", now)],
  now,
);
const detailStarts: string[] = [];
const checkpoints: string[] = [];
let releaseFirstDetail = () => {};
const firstDetailGate = new Promise<void>((resolve) => {
  releaseFirstDetail = resolve;
});
clearDiagnostics();
const successfulRound = runAccountFollowupsForTesting(
  initial,
  "interface5",
  now,
  "followup-causal-live",
  (candidate, _mutations, stage) => {
    checkpoints.push(stage);
    return candidate;
  },
  now + 60_000,
  new Set(),
  undefined,
  {
    async refreshAccountParcel(value) {
      detailStarts.push(value.identity.sourceId);
      if (value.identity.sourceId.endsWith("5900")) await firstDetailGate;
      return detailParcel(value, now + 1_000);
    },
  },
);

await Promise.resolve();
await Promise.resolve();
assert.deepEqual(
  detailStarts,
  ["ZT5900", "ZT7226", "ZT0238"],
  "all due unfinished rows must enter the production detail queue",
);
assert.equal(
  readDiagnostics().filter(
    (entry) =>
      entry.event === "refresh.stage.started" &&
      entry.details.flowId === "followup-causal-live" &&
      entry.details.stage === "account_detail",
  ).length,
  3,
  "account-detail start diagnostics must be written when each request actually starts",
);
await new Promise((resolve) => setTimeout(resolve, 30));
releaseFirstDetail();
const successful = await successfulRound;
assert.deepEqual(checkpoints, [
  "account_detail",
], "homepage followups persist only the Xiaomi account-detail increment");
assert.deepEqual(
  { attempted: successful.attempted, succeeded: successful.succeeded, failed: successful.failed },
  { attempted: 3, succeeded: 3, failed: 0 },
);
const successDurations = readDiagnostics()
  .filter(
    (entry) =>
      entry.event === "refresh.stage.succeeded" &&
      entry.details.flowId === "followup-causal-live" &&
      entry.details.stage === "account_detail",
  )
  .map((entry) => Number(entry.details.durationMs));
assert.equal(successDurations.length, 3);
assert.equal(
  successDurations.filter((duration) => duration >= 25).length,
  1,
  "each account-detail duration must stop when that request settles, not when its slowest peer settles",
);
assert.equal(
  readDiagnostics().some(
    (entry) =>
      entry.details.flowId === "followup-causal-live" &&
      entry.details.skipReason === "deadline_exhausted",
  ),
  false,
  "a slow candidate alone must not be labelled as deadline exhaustion",
);

clearDiagnostics();
let expiredBoundaryCalls = 0;
const expired = await runAccountFollowupsForTesting(
  initial,
  "interface5",
  now,
  "followup-causal-expired",
  () => {
    throw new Error("an expired round must not checkpoint");
  },
  Date.now() - 1,
  new Set(),
  undefined,
  {
    async refreshAccountParcel() {
      expiredBoundaryCalls++;
      return null;
    },
  },
);
assert.equal(expiredBoundaryCalls, 0);
assert.deepEqual(
  { attempted: expired.attempted, succeeded: expired.succeeded, failed: expired.failed },
  { attempted: 0, succeeded: 0, failed: 0 },
);
assert.equal(
  readDiagnostics().filter(
    (entry) =>
      entry.details.flowId === "followup-causal-expired" &&
      entry.details.skipReason === "deadline_exhausted",
  ).length,
  3,
  "only the truly expired Xiaomi detail candidates are classified as deadline exhaustion",
);

const screenedStarts: string[] = [];
const screenedState = appState(
  [completedOrder(now), settledShipment("SIGNED", now), shipment("9999", now)],
  now,
);
await runAccountFollowupsForTesting(
  screenedState,
  "interface5",
  now,
  "followup-completed-order-screen",
  (candidate) => candidate,
  now + 60_000,
  new Set(),
  undefined,
  {
    async refreshAccountParcel(value) {
      screenedStarts.push(`detail:${value.identity.sourceId}`);
      return detailParcel(value, now + 1_000);
    },
  },
);
assert.deepEqual(
  screenedStarts,
  [
    "detail:ZT9999",
  ],
  "homepage followups must keep JD on its Xiaomi account-list cache and refresh only non-JD account detail",
);

console.log("account followup production-path tests passed");
