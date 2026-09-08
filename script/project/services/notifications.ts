import { Notification, Script } from "scripting";
import type { ShipmentNotificationEvent } from "../models";
import { loadNotificationStatuses, notificationEnabled } from "./notification-preferences";
import { acknowledgeShipmentNotification, loadState } from "./storage";
import { acquireDurableRefreshLease } from "./refresh-runtime-state";
import { writeDiagnostic } from "./logger";
import { OperationTimeoutError } from "./deadline";

async function scheduleEvent(event: Omit<ShipmentNotificationEvent, "id">): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Notification.schedule({
        title: event.title,
        body: event.body,
        iconImageData: event.iconName
          ? Data.fromFile(`${Script.directory}/assets/couriers/${event.iconName}.png`)
          : null,
        userInfo: { shipment: event.shipmentId },
        actions: [{
          title: "查看详情",
          url: Script.createRunSingleURLScheme(Script.name, {
            shipment: event.shipmentId,
          }),
        }],
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new OperationTimeoutError()), 10_000);
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

export async function replayPendingShipmentNotifications(
  canSchedule: () => boolean = () => true,
): Promise<void> {
  if (!canSchedule()) return;
  const lease = acquireDurableRefreshLease("notifications", 15_000);
  if (!lease) return;
  try {
    loadNotificationStatuses(true);
    const events = loadState().pendingNotifications || [];
    for (const event of events) {
      if (!canSchedule() || !lease.isCurrent()) return;
      const latest = loadState();
      if (!latest.pendingNotifications?.some((item) => item.id === event.id)) continue;
      const exists = latest.shipments.some((shipment) => shipment.identity.id === event.shipmentId);
      try {
        if (exists && notificationEnabled(event.semantic)) await scheduleEvent(event);
      } catch {
        // 一条排不出去的通知不能卡住整条队列：宿主拒绝或 10 秒超时时只跳过这一条，后面的照发，
        // 这一条留着下一轮重放。以前这里的 catch 在循环外，一条失败等于之后再也不发通知。
        writeDiagnostic("notification.schedule.failed", { result: "pending_retry" }, "warning");
        continue;
      }
      if (!canSchedule() || !lease.isCurrent()) return;
      // The host has no documented caller-selected request ID. A crash after scheduling
      // and before this durable acknowledgement can repeat the notification.
      acknowledgeShipmentNotification(event.id);
    }
  } catch {
    writeDiagnostic("notification.replay.failed", { result: "pending_retry" }, "warning");
  } finally {
    lease.release();
  }
}
