import assert from "node:assert/strict";
import { test } from "node:test";
import type { Shipment } from "../models";
import { fengchaoReminder, reconcileFengchaoReminders } from "../services/fengchao-reminders";
import { emptyState, saveState } from "../services/storage";
import { memory } from "./state-storage-mock";

const HOUR = 3_600_000;
const ARRIVED = Date.UTC(2026, 10, 16, 4);
const WAYBILL = "JT000000024597";
const shipment: Shipment = {
  identity: {
    id: "fengchao-parcel", sourceOwner: "manual", sourceId: WAYBILL,
    phoneTail: "", courierCode: "jt", companyName: "极兔速递",
    manuallyAdded: true, createdAtMs: ARRIVED - HOUR,
  },
  timeline: {
    provider: "synthetic", waybill: WAYBILL, courierCode: "jt", companyName: "极兔速递",
    semantic: "WAITING_PICKUP", statusEventAtMs: ARRIVED,
    latestDetail: "快件已投递到丰巢快递柜", latestTimeText: "2026-11-16 12:00:00",
    successAtMs: ARRIVED,
    tracks: [{
      timeText: "2026-11-16 12:00:00", timeMs: ARRIVED, detail: "快件已投递到丰巢快递柜",
      statusCode: "WAITING_PICKUP", raw: {},
    }],
  },
  pickup: {
    waybill: WAYBILL, waybillGeneration: 0, code: "2557", locationName: "测试丰巢柜",
    capturedAtMs: ARRIVED + HOUR, platform: "fengchao",
  },
  updatedAtMs: ARRIVED + HOUR,
};

test("the free period starts at the corroborated deposit event", () => {
  const now = ARRIVED + 2 * HOUR;
  const timer = fengchaoReminder(shipment, now);
  assert.equal(timer?.remindAt, ARRIVED + 17 * HOUR);
  assert.equal(timer?.freeUntil, ARRIVED + 18 * HOUR);
  assert.equal(fengchaoReminder(shipment, ARRIVED + 18 * HOUR), null);
  assert.equal(fengchaoReminder({ ...shipment, timeline: { ...shipment.timeline, tracks: [] } }, now), null);
  assert.equal(fengchaoReminder({ ...shipment, forcedCompletedAtMs: now }, now), null);
});

test("one native trigger is reconciled and removed when the parcel is picked up", async () => {
  memory.clear();
  const now = ARRIVED + 2 * HOUR;
  const realNow = Date.now;
  Date.now = () => now;
  const originalNotify = globalThis.Notification;
  const pending = new Map<string, { identifier: string; content: any }>();
  const triggers: { timeInterval: number }[] = [];
  let notificationReads = 0;
  const originalTrigger = (globalThis as any).TimeIntervalNotificationTrigger;
  Object.assign(globalThis, {
    TimeIntervalNotificationTrigger: class {
      constructor(readonly options: { timeInterval: number }) { triggers.push(options); }
    },
    Notification: {
      async schedule(options: unknown) {
        const id = "test-native-reminder";
        pending.set(id, { identifier: id, content: options });
        return true;
      },
      async getAllPendingsOfCurrentScript() {
        notificationReads++;
        return [...pending.values()];
      },
      async removePendings(ids: string[]) { ids.forEach(id => pending.delete(id)); },
    },
  });
  try {
    const state = saveState({ ...emptyState(), shipments: [shipment] }, now);
    await Promise.all([
      reconcileFengchaoReminders(state, { shipments: state.shipments }),
      reconcileFengchaoReminders(state, { deadline: now + 10_000 }),
    ]);
    assert.equal(notificationReads, 1, "overlapping app and notification requests for one revision share one native pass");
    await reconcileFengchaoReminders(state);
    assert.deepEqual(triggers.map(item => item.timeInterval), [15 * 3600]);
    assert.equal(pending.size, 1);
    const completed = saveState({ ...state, shipments: state.shipments.map(row =>
      ({ ...row, forcedCompletedAtMs: now })) }, now);
    await reconcileFengchaoReminders(completed);
    assert.equal(pending.size, 0);
  } finally {
    Date.now = realNow;
    Object.assign(globalThis, { Notification: originalNotify, TimeIntervalNotificationTrigger: originalTrigger });
  }
});
