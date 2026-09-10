import assert from "node:assert/strict";
import type { AppState, Shipment } from "../models.ts";
import { memory, NOW, sha256 } from "./state-storage-mock.ts";
import { emptyState, loadState } from "../services/storage.ts";

let now = NOW;
Date.now = () => now;
const attempted: string[] = [];
let hangingCount = 2;
Object.assign(globalThis, {
  Script: {
    directory: "/synthetic", name: "synthetic",
    createRunSingleURLScheme: () => "synthetic:detail",
  },
  Notification: {
    async schedule(event: { userInfo: { shipment: string } }) {
      const id = event.userInfo.shipment;
      attempted.push(id);
      if (hangingCount > 0 && id.includes("AUDITA") ||
          hangingCount === 2 && id.includes("AUDITB")) return new Promise(() => {});
      return true;
    },
  },
});
const rows: Shipment[] = ["A", "B", "C"].map(id => ({
  identity: {
    id: `interface5:manual:AUDIT${id}123456`, bindingSource: "interface5", sourceOwner: "manual",
    sourceId: `AUDIT${id}123456`, phoneTail: "", courierCode: "", companyName: "synthetic",
    manuallyAdded: true, createdAtMs: NOW,
  },
  timeline: {
    provider: "v6_query", waybill: `AUDIT${id}123456`, courierCode: "", companyName: "synthetic",
    semantic: "DELIVERY", statusEventAtMs: NOW, latestTimeText: "", latestDetail: "synthetic",
    tracks: [], successAtMs: NOW,
  },
  updatedAtMs: NOW,
}));
const state: AppState = {
  ...emptyState(), revision: 1, updatedAtMs: NOW, shipments: rows,
  pendingNotifications: rows.map(row => ({
    id: `event-${row.identity.id}`, shipmentId: row.identity.id, semantic: "DELIVERY",
    title: "synthetic", body: "synthetic", iconName: null,
  })),
};
const payload = JSON.stringify(state);
memory.set("pipi_deliveries_state_v1", JSON.stringify({ schema: 3, checksum: sha256(payload), payload }));
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
// Advance only timers that actually fire; immediately settled schedules cancel
// their timer before the next event-loop turn, as in the host.
globalThis.setTimeout = ((callback: () => void, ms: number) => {
  const handle = { active: true };
  setImmediate(() => { if (handle.active) { now += ms; callback(); } });
  return handle;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((handle: { active: boolean }) => {
  handle.active = false;
}) as unknown as typeof clearTimeout;
try {
  const firstRuntime = await import("../services/notifications.ts?first-drain");
  await firstRuntime.replayPendingShipmentNotifications();
  assert.equal(loadState().pendingNotifications?.length, 3,
    "failed and not-yet-attempted events remain durable");
  const nextRuntime = await import("../services/notifications.ts?restarted-drain");
  await nextRuntime.replayPendingShipmentNotifications();
  assert.equal(attempted.filter(id => id.includes("AUDITC")).length, 1,
    "a healthy event must advance on a later runtime despite two stalled predecessors");
  assert.equal(loadState().pendingNotifications?.length, 2);
  hangingCount = 0;
  await nextRuntime.replayPendingShipmentNotifications();
  assert.equal(loadState().pendingNotifications?.length, 0,
    "failed events remain retryable when the host recovers");
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
console.log("notification replay advances healthy events across restarts");
