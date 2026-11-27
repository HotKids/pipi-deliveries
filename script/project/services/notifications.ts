import { Notification, Script } from "scripting";
import type { AppState, ShipmentNotificationEvent } from "../models";
import { loadNotificationStatuses, notificationEnabled } from "./notification-preferences";
import {
  acknowledgeShipmentNotificationsSnapshot,
  deferShipmentNotificationSnapshot,
  loadStateSnapshot,
  type LoadedStateSnapshot,
} from "./storage";
import { acquireDurableRefreshLease, durableRefreshLeaseRemainingMs } from "./refresh-runtime-state";
import { beginDiagnosticFlow, diagnosticErrorDetails, writeDiagnostic } from "./logger";
import { deadlineExpired, pauseWhileActive, remainingTimeoutMs, waitForRefresh } from "./deadline";
import { isHiddenCompletedOrderPlaceholder, isConfirmedNoItemOrder, isHiddenSignedShipment, isHiddenCancelledShipment, shipmentPresentationStatus } from "./status";
import { isAttachedShipment } from "./waybill-ownership";
import { shipmentNotificationPresentation } from "./notification-events";
import { isShunFengSourceShipment, selectShipmentTimeline, shipmentHeadlineMatchesStatus } from "./shipment-policy";
import { loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey } from "./row-ledger";
import { reconcileFengchaoReminders } from "./fengchao-reminders";
import { notificationDecisionForEvent, recordNotificationDecisions, type NotificationDecision } from "./row-diagnostics";

export async function scheduleShipmentNotification(
  event: Omit<ShipmentNotificationEvent, "id">, deadlineAtMs: number,
): Promise<boolean> {
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
  return waitForRefresh(Notification.schedule(request), scheduleDeadline);
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
  // The drain's own lines follow the section 10 routine-noise exception, with its start merged into its end (D4/D207,
  // owner 2026-11-21 「开始并入终态，卡住另记（推荐）」: 「iOS 例行降噪例外按同一规则处理」). Every line names the
  // app_local layer (D191): iOS has local notifications only.
  const details = { flowId: options.flowId, stage: "notifications", pushOrigin: "app_local" as const };
  // D131: what became of each event this drain handled, written once at its end.
  const decisions: NotificationDecision[] = [];
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
  let scheduleDurationMs = 0, writeDurationMs = 0;
  let result = "completed";
  const readStartedAt = Date.now();
  let readDurationMs: number | undefined;
  let snapshot: LoadedStateSnapshot | undefined;
  const pendingSuppressedBatch: Array<{ id: string; decision?: NotificationDecision }> = [];
  const commitAckIds = (eventIds: readonly string[], observed: LoadedStateSnapshot): AppState => {
    const commitStartedAt = Date.now();
    try {
      snapshot = acknowledgeShipmentNotificationsSnapshot(eventIds, commitStartedAt, observed);
      return snapshot.state;
    } finally {
      // Include the owning mutation's reads and cleanup, separately from host scheduling.
      writeDurationMs += Date.now() - commitStartedAt;
    }
  };
  const commitDeferred = (eventId: string, observed: LoadedStateSnapshot): AppState => {
    const commitStartedAt = Date.now();
    try {
      snapshot = deferShipmentNotificationSnapshot(eventId, commitStartedAt, observed);
      return snapshot.state;
    } finally {
      writeDurationMs += Date.now() - commitStartedAt;
    }
  };
  const flushSuppressedAcks = (): boolean => {
    if (!pendingSuppressedBatch.length || !snapshot) return true;
    if (!canSchedule() || !lease.isCurrent()) {
      pendingSuppressedBatch.length = 0;
      result = deadlineExpired(deadlineAtMs) ? "budget_exhausted" : "ownership_lost";
      return false;
    }
    const batch = pendingSuppressedBatch.splice(0, pendingSuppressedBatch.length);
    current = commitAckIds(batch.map((item) => item.id), snapshot);
    succeeded += batch.length;
    for (const item of batch) {
      if (item.decision) decisions.push(item.decision);
    }
    return true;
  };
  try {
    loadNotificationStatuses(true);
    snapshot = loadStateSnapshot();
    current = snapshot.state;
    // T23 (user 2026-09-26): an event queued while its row's carrier was unmatched waits for the carrier; storage
    // releases it with a rebuilt title, so it is neither scheduled nor acknowledged here.
    const events = deliverableEvents(current).filter(event => !options.alignedShipmentId ||
      (event.shipmentId === options.alignedShipmentId && event.semantic === "COMPLETED"));
    readDurationMs = Date.now() - readStartedAt;
    if (events.length > 0) {
      beginDiagnosticFlow("notification.replay.started", { ...details, budgetMs });
      writeDiagnostic("notification.replay.loaded", {
        ...details, pendingNotifications: events.length, readDurationMs,
      });
    }
    let yieldedAfterCommit = false;
    for (const event of events) {
      // Finish each durable ACK before letting a queued UI event run.
      if (yieldedAfterCommit) {
        yieldedAfterCommit = false;
        await pauseWhileActive(0);
      }
      if (deadlineExpired(deadlineAtMs)) { flushSuppressedAcks(); result = "budget_exhausted"; return current; }
      if (!canSchedule() || !lease.isCurrent()) { pendingSuppressedBatch.length = 0; result = "ownership_lost"; return current; }
      snapshot = loadStateSnapshot(Date.now(), snapshot);
      const latest = current = snapshot.state;
      if (!latest.pendingNotifications?.some((item) => item.id === event.id)) continue;
      if (deadlineExpired(deadlineAtMs)) { flushSuppressedAcks(); result = "budget_exhausted"; return current; }
      const shipment = latest.shipments.find((shipment) => shipment.identity.id === event.shipmentId);
      // Hidden owners still retire their queued events instead of waiting for a repair they no longer run.
      const attachedOwner = Boolean(shipment && isAttachedShipment(latest.shipments, shipment));
      const channelOff = !notificationEnabled(event.semantic);
      const deliverable = shipment && !isHiddenSignedShipment(shipment) && !isHiddenCancelledShipment(shipment) &&
        !isConfirmedNoItemOrder(shipment) && !isHiddenCompletedOrderPlaceholder(shipment) && !attachedOwner && !channelOff;
      const signedSF = deliverable && event.semantic === "COMPLETED" && isShunFengSourceShipment(shipment) &&
        shipmentPresentationStatus(shipment).semantic === "COMPLETED";
      if (signedSF) {
        const attempt = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(shipment.identity.id)]);
        const aligning = attempt && !attempt.finished &&
          durableRefreshLeaseRemainingMs(`detail:${shipment.identity.id}`) > 0;
        if (aligning || !shipmentHeadlineMatchesStatus(shipment)) {
          writeDiagnostic("notification.replay.deferred", {
            ...details, result: "awaiting_status_alignment",
          });
          continue;
        }
      }
      if (!deliverable) {
        attempted++;
        const decision = notificationDecisionForEvent(event, shipment, false, channelOff, attachedOwner);
        pendingSuppressedBatch.push({ id: event.id, decision });
        continue;
      }
      if (!flushSuppressedAcks()) return current;
      attempted++;
      const scheduleStartedAt = Date.now();
      try {
        try {
          // SF signing waits in the durable outbox while alignment settles. Its original payload may
          // predate that repair, so deliver the same current presentation as the list and widgets.
          const presentation = signedSF
            ? shipmentNotificationPresentation({ ...shipment, timeline: selectShipmentTimeline(shipment) })
            : event;
          await scheduleShipmentNotification(presentation, deadlineAtMs);
        } finally {
          scheduleDurationMs += Date.now() - scheduleStartedAt;
        }
      } catch (error) {
        failed++;
        writeDiagnostic("notification.schedule.failed", {
          ...details, result: "pending_retry", durationMs: Date.now() - scheduleStartedAt,
          ...diagnosticErrorDetails(error),
        }, "warning");
        if (!canSchedule() || !lease.isCurrent()) {
          result = deadlineExpired(deadlineAtMs) ? "budget_exhausted" : "ownership_lost";
          return current;
        }
        // Persist rotation before another host wait: a bounded drain may expire
        // before reaching healthy events, which must lead the next attempt.
        current = commitDeferred(event.id, snapshot);
        if (deadlineExpired(deadlineAtMs)) { result = "budget_exhausted"; return current; }
        yieldedAfterCommit = true;
        continue;
      }
      if (!canSchedule() || !lease.isCurrent()) {
        result = deadlineExpired(deadlineAtMs) ? "budget_exhausted" : "ownership_lost";
        return current;
      }
      // The host has no documented caller-selected request ID. A crash after scheduling
      // and before this durable acknowledgement can repeat the notification.
      current = commitAckIds([event.id], snapshot);
      succeeded++;
      yieldedAfterCommit = true;
      const decision = notificationDecisionForEvent(event, shipment, true, channelOff, attachedOwner);
      if (decision) decisions.push(decision);
    }
    if (!flushSuppressedAcks()) return current;
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
    try { recordNotificationDecisions(decisions, options.flowId); } catch { /* Diagnostics are optional. */ }
    const pendingNotifications = current ? deliverableEvents(current).length : undefined;
    writeDiagnostic("notification.replay.completed", {
      ...details, result: result === "completed" && pendingNotifications ? "pending_retry" : result,
      durationMs: Date.now() - startedAt, pendingNotifications, attempted, succeeded, failed,
      budgetMs, readDurationMs: readDurationMs ?? Date.now() - readStartedAt,
      // Durable totals already include the separately logged storage subphases.
      scheduleDurationMs, writeDurationMs,
    });
  }
  if (current && !options.alignedShipmentId && canSchedule()) {
    await reconcileFengchaoReminders(current, { deadline: deadlineAtMs });
  }
  return current;
}
