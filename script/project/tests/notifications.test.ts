import assert from "node:assert/strict";
import type { Shipment, StatusSemantic } from "../models";

const memory = new Map<string, unknown>();
const files = new Map<string, string>();
const scheduled: Record<string, unknown>[] = [];
let scheduleGate: Promise<void> | null = null;

Object.assign(globalThis, {
  Path: {
    join(...parts: string[]) {
      return parts.join("/").replace(/\/{2,}/g, "/");
    },
  },
  FileManager: {
    appGroupDocumentsDirectory: "/group",
    createDirectorySync() {},
    existsSync(path: string) {
      return files.has(path);
    },
    isFileSync(path: string) {
      return files.has(path);
    },
    readAsStringSync(path: string) {
      const value = files.get(path);
      if (value == null) throw new Error("missing file");
      return value;
    },
    removeSync(path: string) {
      files.delete(path);
    },
    renameSync(path: string, newPath: string) {
      const value = files.get(path);
      if (value == null || files.has(newPath)) throw new Error("rename rejected");
      files.set(newPath, value);
      files.delete(path);
    },
    writeAsStringSync(path: string, value: string) {
      files.set(path, value);
    },
  },
  Storage: {
    get<T>(key: string, options?: { shared: boolean }): T | null {
      const namespace = options?.shared ? "shared:" : "private:";
      return (memory.get(`${namespace}${key}`) as T | undefined) ?? null;
    },
    set(key: string, value: unknown, options?: { shared: boolean }): boolean {
      const namespace = options?.shared ? "shared:" : "private:";
      memory.set(`${namespace}${key}`, structuredClone(value));
      return true;
    },
  },
  Data: {
    fromFile(path: string) {
      return { path };
    },
  },
  Notification: {
    async schedule(value: Record<string, unknown>) {
      scheduled.push(value);
      if (scheduleGate) await scheduleGate;
    },
  },
  Script: {
    directory: "/script",
    name: "Pipi Deliveries",
    createRunSingleURLScheme(_name: string, query: Record<string, string>) {
      return `pipi://${query.shipment || ""}`;
    },
  },
});

const {
  IMPORTANT_NOTIFICATION_STATUSES,
  loadNotificationStatuses,
  NOTIFICATION_STATUS_OPTIONS,
  notificationEnabled,
  REGULAR_NOTIFICATION_STATUSES,
  saveNotificationStatuses,
  setNotificationGroupEnabled,
} = await import("../services/notification-preferences");
const { notifyShipmentChange, notifyShipmentChanges } = await import(
  "../services/notifications"
);

function shipment(
  semantic: StatusSemantic,
  detail: string,
): Shipment {
  return {
    identity: {
      id: "shipment-1",
      bindingSource: "interface5",
      sourceOwner: "account",
      sourceId: "SF1234567890",
      phoneTail: "8098",
      courierCode: "SF",
      companyName: "顺丰速运",
      manuallyAdded: false,
      createdAtMs: 1,
    },
    timeline: {
      provider: "interface5",
      waybill: "SF1234567890",
      courierCode: "SF",
      companyName: "顺丰速运",
      semantic,
      statusEventAtMs: 2,
      latestTimeText: "2026-08-27 12:00:00",
      latestDetail: detail,
      tracks: [],
      successAtMs: 2,
    },
    updatedAtMs: 2,
  };
}

assert.deepEqual(loadNotificationStatuses(true), NOTIFICATION_STATUS_OPTIONS);
assert.equal(notificationEnabled("UNKNOWN"), false);

const groupedStatuses = [
  ...IMPORTANT_NOTIFICATION_STATUSES,
  ...REGULAR_NOTIFICATION_STATUSES,
];
assert.equal(new Set(groupedStatuses).size, groupedStatuses.length);
assert.deepEqual(
  new Set(groupedStatuses),
  new Set(NOTIFICATION_STATUS_OPTIONS),
);
assert.equal(new Set<string>(groupedStatuses).has("UNKNOWN"), false);
assert.deepEqual(
  setNotificationGroupEnabled(["ORDERED"], IMPORTANT_NOTIFICATION_STATUSES, true),
  ["ORDERED", "PICKED", "DELIVERY", "WAITING_PICKUP", "DANGER", "CANCELLED"],
);
assert.deepEqual(
  setNotificationGroupEnabled(
    NOTIFICATION_STATUS_OPTIONS,
    IMPORTANT_NOTIFICATION_STATUSES,
    false,
  ),
  REGULAR_NOTIFICATION_STATUSES,
);

saveNotificationStatuses(["DELIVERY"], 100);
assert.deepEqual(loadNotificationStatuses(true), ["DELIVERY"]);
assert.equal(notificationEnabled("DELIVERY"), true);
assert.equal(notificationEnabled("TRANSIT"), false);

memory.delete("shared:pipi_deliveries_notification_preferences_v1");
assert.deepEqual(loadNotificationStatuses(true), ["DELIVERY"]);
saveNotificationStatuses(["DELIVERY"], 100);
files.clear();
assert.deepEqual(loadNotificationStatuses(true), ["DELIVERY"]);

await notifyShipmentChange(
  shipment("TRANSIT", "快件离开转运中心"),
  shipment("TRANSIT", "快件到达下一站"),
);
assert.equal(scheduled.length, 0);

await notifyShipmentChange(
  shipment("TRANSIT", "快件离开转运中心"),
  shipment("DELIVERY", "快递员正在派送"),
);
assert.equal(scheduled.length, 1);
assert.equal(scheduled[0]?.title, "顺丰速运 7890 · 派送中");
assert.equal(scheduled[0]?.body, "快递员正在派送");
assert.deepEqual(scheduled[0]?.iconImageData, {
  path: "/script/assets/couriers/sf.png",
});
assert.deepEqual(scheduled[0]?.userInfo, { shipment: "shipment-1" });
assert.equal(
  (scheduled[0]?.actions as Array<{ title: string }> | undefined)?.[0]?.title,
  "查看详情",
);

await notifyShipmentChange(
  shipment("DELIVERY", "快递员正在派送"),
  shipment("DELIVERY", ""),
);
assert.equal(scheduled.length, 2);
assert.equal(scheduled[1]?.body, "物流状态已更新");

let releaseSchedule!: () => void;
scheduleGate = new Promise<void>((resolve) => {
  releaseSchedule = resolve;
});
let batchSettled = false;
const previous = shipment("TRANSIT", "快件离开转运中心");
const current = shipment("DELIVERY", "快递员再次派送");
const batch = notifyShipmentChanges(
  new Map([[previous.identity.id, previous]]),
  [current],
).then(() => {
  batchSettled = true;
});
await Promise.resolve();
assert.equal(batchSettled, false);
releaseSchedule();
await batch;
assert.equal(batchSettled, true);
scheduleGate = null;

const scheduledBeforeCancelledGeneration = scheduled.length;
await notifyShipmentChange(previous, current, () => false);
await notifyShipmentChanges(
  new Map([[previous.identity.id, previous]]),
  [current],
  () => false,
);
assert.equal(scheduled.length, scheduledBeforeCancelledGeneration);

await notifyShipmentChange(null, shipment("DELIVERY", "首次发现"));
assert.equal(scheduled.length, 3);

saveNotificationStatuses(["COMPLETED"], 101);
const completedJingDong = {
  ...shipment("COMPLETED", "手动权威包已签收"),
  identity: {
    ...shipment("COMPLETED", "手动权威包已签收").identity,
    courierCode: "RAW",
    companyName: "原始厂商标签",
    sourceProvider: "JingDong",
  },
  sourceTimeline: {
    ...shipment("TRANSIT", "源包运输中").timeline,
    latestDetail: "源包运输中",
  },
};
await notifyShipmentChange(completedJingDong, {
  ...completedJingDong,
  identity: {
    ...completedJingDong.identity,
    courierCode: "SF",
    companyName: "顺丰速运",
  },
});
assert.equal(
  scheduled.length,
  3,
  "carrier normalization after a displayed JD completion is not a status notification",
);
await notifyShipmentChange(
  {
    ...completedJingDong,
    timeline: shipment("TRANSIT", "运输中").timeline,
  },
  completedJingDong,
);
assert.equal(scheduled.length, 4, "the initial completion notification is retained");

saveNotificationStatuses(["ORDERED"], 102);
const orderedJingDong = {
  ...shipment("ORDERED", "订单已创建"),
  identity: {
    ...shipment("ORDERED", "订单已创建").identity,
    sourceId: "9876543210987654",
    orderId: "9876543210987654",
    projectedWaybill: "",
    accountOrder: true,
    courierCode: "JD",
    companyName: "京东购物",
  },
  timeline: {
    ...shipment("ORDERED", "订单已创建").timeline,
    waybill: "9876543210987654",
  },
};
await notifyShipmentChange(orderedJingDong, {
  ...orderedJingDong,
  statusPresentation: {
    scope: "ORDER",
    semantic: "COMPLETED",
    text: "订单已完成",
  },
});
assert.equal(scheduled.length, 5);
assert.equal(scheduled[4]?.title, "京东购物 7654 · 已完成");

saveNotificationStatuses([], 103);
assert.deepEqual(loadNotificationStatuses(true), []);
await notifyShipmentChange(
  shipment("TRANSIT", "快件离开转运中心"),
  shipment("DELIVERY", "再次派送"),
);
assert.equal(scheduled.length, 5);

files.clear();
memory.set(
  "shared:pipi_deliveries_notification_preferences_v1",
  JSON.stringify({ schema: 1, updatedAtMs: 104, enabled: ["UNKNOWN"] }),
);
assert.deepEqual(loadNotificationStatuses(true), NOTIFICATION_STATUS_OPTIONS);

saveNotificationStatuses(["DELIVERY"], 105);
const unknownCarrier = {
  ...shipment("DELIVERY", "未知承运商正在派送"),
  identity: {
    ...shipment("DELIVERY", "未知承运商正在派送").identity,
    courierCode: "UNKNOWN",
    companyName: "未知快递",
  },
};
await notifyShipmentChange(
  { ...unknownCarrier, timeline: shipment("TRANSIT", "运输中").timeline },
  unknownCarrier,
);
assert.equal(scheduled.length, 6);
assert.equal(scheduled[5]?.iconImageData, null);

console.log("notification preference and filtering tests passed");
