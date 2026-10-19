import { Notification, Script } from "scripting";
import type { AppState, ShipmentNotificationEvent } from "../models";
import { loadNotificationStatuses, notificationEnabled } from "./notification-preferences";
import { acknowledgeShipmentNotification, deferShipmentNotification, loadState } from "./storage";
import { acquireDurableRefreshLease, durableRefreshLeaseRemainingMs } from "./refresh-runtime-state";
import { diagnosticErrorDetails, writeDiagnostic } from "./logger";
import { deadlineExpired, remainingTimeoutMs, waitForRefresh } from "./deadline";
import { isHiddenCompletedOrderPlaceholder, isConfirmedNoItemOrder, isHiddenSignedShipment, isHiddenCancelledShipment, shipmentPresentationStatus } from "./status";
import { isAttachedShipment } from "./waybill-ownership";
import { shipmentNotificationPresentation } from "./notification-events";
import { isShunFengSourceShipment, selectShipmentTimeline, shipmentHeadlineMatchesStatus } from "./shipment-policy";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey } from "./row-ledger";

async function scheduleEvent(event: Omit<ShipmentNotificationEvent, "id">, deadlineAtMs: number): Promise<void> {
  const request = {
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
  };
  const timeoutMs = remainingTimeoutMs(deadlineAtMs, 10_000);
  const scheduleDeadline = Math.min(deadlineAtMs, Date.now() + timeoutMs);
  await waitForRefresh(Notification.schedule(request), scheduleDeadline);
}

function deliverableEvents(state: AppState): readonly ShipmentNotificationEvent[] {
  return (state.pendingNotifications || []).filter((event) => !event.awaitingCarrier);
}

export async function replayPendingShipmentNotifications(
  canSchedule: () => boolean = () => true,
  options: { deadlineAtMs?: number; flowId?: string; alignedShipmentId?: string } = {},
): Promise<AppState | undefined> {
  const startedAt = Date.now();
  const deadlineAtMs = Math.min(options.deadlineAtMs ?? Infinity, startedAt + 15_000);
  const budgetMs = Math.max(0, deadlineAtMs - startedAt);
  const details = { flowId: options.flowId, stage: "notifications" };
  if (deadlineExpired(deadlineAtMs) || !canSchedule()) {
    writeDiagnostic("notification.replay.skipped", {
      ...details, result: deadlineExpired(deadlineAtMs) ? "budget_exhausted" : "ownership_lost",
    });
    return;
  }
  const lease = acquireDurableRefreshLease("notifications", 15_000);
  if (!lease) {
    writeDiagnostic("notification.replay.skipped", { ...details, result: "active_notification_replay" });
    return;
  }
  let current: AppState | undefined;
  let attempted = 0, succeeded = 0, failed = 0;
  let result = "completed";
  const readStartedAt = Date.now();
  let readDurationMs: number | undefined;
  try {
    loadNotificationStatuses(true);
    current = loadState();
    // T23 (user 2026-09-26): an event queued while its row's carrier was unmatched waits for the carrier; storage
    // releases it with a rebuilt title, so it is neither scheduled nor acknowledged here.
    const events = deliverableEvents(current).filter(event => !options.alignedShipmentId ||
      (event.shipmentId === options.alignedShipmentId && event.semantic === "COMPLETED"));
    readDurationMs = Date.now() - readStartedAt;
    if (events.length > 0) {
      writeDiagnostic("notification.replay.started", { ...details, budgetMs });
      writeDiagnostic("notification.replay.loaded", {
        ...details, pendingNotifications: events.length, readDurationMs,
      });
    }
    for (const event of events) {
      if (deadlineExpired(deadlineAtMs)) { result = "budget_exhausted"; return current; }
      if (!canSchedule() || !lease.isCurrent()) { result = "ownership_lost"; return current; }
      const latest = current = loadState();
      if (!latest.pendingNotifications?.some((item) => item.id === event.id)) continue;
      if (deadlineExpired(deadlineAtMs)) { result = "budget_exhausted"; return current; }
      const shipment = latest.shipments.find((shipment) => shipment.identity.id === event.shipmentId);
      // Hidden owners still retire their queued events instead of waiting for a repair they no longer run.
      const deliverable = shipment && !isHiddenSignedShipment(shipment) && !isHiddenCancelledShipment(shipment) &&
        !isConfirmedNoItemOrder(shipment) && !isHiddenCompletedOrderPlaceholder(shipment) && !isAttachedShipment(latest.shipments, shipment) && notificationEnabled(event.semantic);
      const signedSF = deliverable && event.semantic === "COMPLETED" && isShunFengSourceShipment(shipment) &&
        shipmentPresentationStatus(shipment).semantic === "COMPLETED";
      if (signedSF) {
        const attempt = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(shipment.identity.id)]);
        const aligning = attempt && !attempt.finished &&
          durableRefreshLeaseRemainingMs(`detail:${shipment.identity.id}`) > 0;
        if (aligning || !shipmentHeadlineMatchesStatus(shipment)) {
          writeDiagnostic("notification.replay.deferred", {
            ...details, result: "awaiting_status_alignment",
            reason: aligning ? "alignment_in_progress" : "same_state_headline_missing",
          });
          continue;
        }
      }
      attempted++;
      try {
        // A queued event may cross the visibility cutoff before the host accepts it.
        // Acknowledge hidden owners below so they cannot block later visible events. A row that has since become
        // attached to another row's waybill (ownership plan T3, user 2026-09-25) is hidden the same way.
        if (deliverable) {
          // SF signing waits in the durable outbox while alignment settles. Its original payload may
          // predate that repair, so deliver the same current presentation as the list and widgets.
          const presentation = signedSF
            ? shipmentNotificationPresentation({ ...shipment, timeline: selectShipmentTimeline(shipment) })
            : event;
          await scheduleEvent(presentation, deadlineAtMs);
        }
      } catch (error) {
        failed++;
        writeDiagnostic("notification.schedule.failed", {
          ...details, result: "pending_retry", ...diagnosticErrorDetails(error),
        }, "warning");
        if (!canSchedule() || !lease.isCurrent()) { result = "ownership_lost"; return current; }
        // Persist rotation before another host wait: a bounded drain may expire
        // before reaching healthy events, which must lead the next attempt.
        current = deferShipmentNotification(event.id);
        if (deadlineExpired(deadlineAtMs)) { result = "budget_exhausted"; return current; }
        continue;
      }
      if (!canSchedule() || !lease.isCurrent()) { result = "ownership_lost"; return current; }
      // The host has no documented caller-selected request ID. A crash after scheduling
      // and before this durable acknowledgement can repeat the notification.
      current = acknowledgeShipmentNotification(event.id);
      succeeded++;
    }
  } catch (error) {
    result = "pending_retry";
    writeDiagnostic("notification.replay.failed", {
      ...details, result, ...diagnosticErrorDetails(error),
      ...(readDurationMs === undefined ? {
        stage: "notification_read", readDurationMs: Date.now() - readStartedAt,
      } : {}),
    }, "warning");
  } finally {
    lease.release();
    const pendingNotifications = current ? deliverableEvents(current).length : undefined;
    writeDiagnostic("notification.replay.completed", {
      ...details, result: result === "completed" && pendingNotifications ? "pending_retry" : result,
      durationMs: Date.now() - startedAt, pendingNotifications, attempted, succeeded, failed,
      budgetMs, readDurationMs: readDurationMs ?? Date.now() - readStartedAt,
    });
  }
  return current;
}
