import { Notification } from "scripting";
import type { AppState, Shipment } from "../models";
import { deadlineExpired, remainingTimeoutMs, waitForRefresh } from "./deadline";
import { readDurableTextCandidates, writeDurableText } from "./durable-files";
import { diagnosticErrorDetails, writeDiagnostic } from "./logger";
import { loadNotificationStatuses } from "./notification-preferences";
import { parcelActivityContent } from "./parcel-pickup";
import { acquireDurableRefreshLease } from "./refresh-runtime-state";
import { sha256Hex } from "./scripting-data";
import { latestTimelineTrackSemantic, timedTracks } from "./status";
import { peekStateRevision, visibleShipments } from "./storage";

const HOUR = 60 * 60 * 1000;
const LEDGER = "fengchao-pickup-reminders-v1.json";
const THREAD = "pipi.deliveries.fengchao-reminder";
const TITLE = "丰巢取件超时提醒";
const BODY = "预计 1 小时内超出免费保管期，请及时取件。";
type Due = { key: string; shipmentId: string; remindAt: number; freeUntil: number };
type Receipt = { scheduledAt: number; freeUntil: number };
let pendingRun = Promise.resolve(false);
let pendingRevision: number | undefined;

export function fengchaoReminder(shipment: Shipment, now: number): Due | null {
  const card = parcelActivityContent(shipment);
  if (!card?.target || !("waybill" in card.target) ||
      card.platform && card.platform !== "fengchao" || shipment.identity.sender) return null;
  const reuseAt = shipment.waybillReuseAtMs || 0;
  const timeline = shipment.timeline;
  const events = timedTracks(timeline.tracks).sort((a, b) => b.timeMs! - a.timeMs!);
  for (const event of events) {
    const at = event.timeMs!;
    if (at <= reuseAt || at > now) continue;
    const semantic = latestTimelineTrackSemantic([event]);
    if (semantic !== "UNKNOWN" && semantic !== "WAITING_PICKUP") break;
    const isWaitingEvent = semantic === "WAITING_PICKUP" ||
      timeline.semantic === "WAITING_PICKUP" && timeline.statusEventAtMs === at;
    if (!isWaitingEvent || !event.detail.includes("丰巢") ||
        !/入柜|放入|存入|投递到|投递至|投放至/.test(event.detail)) continue;
    const freeUntil = at + 18 * HOUR;
    if (freeUntil <= now) return null;
    return {
      key: sha256Hex(JSON.stringify([card.target.shipmentId, card.target.waybill, reuseAt])),
      shipmentId: shipment.identity.id,
      remindAt: freeUntil - HOUR,
      freeUntil,
    };
  }
  return null;
}

function readReceipts(): Record<string, Receipt> | null {
  for (const raw of readDurableTextCandidates(LEDGER)) {
    try {
      const entries = JSON.parse(raw);
      if (entries && typeof entries === "object" && !Array.isArray(entries)) return entries;
    } catch { /* Another valid mirror may be available. */ }
  }
  return null;
}

export function reconcileFengchaoReminders(state: AppState, { deadline, shipments, preferencesChanged }: {
  deadline?: number;
  shipments?: readonly Shipment[];
  preferencesChanged?: boolean;
} = {}): Promise<void> {
  const canJoin = !preferencesChanged && pendingRevision === state.revision;
  pendingRevision = state.revision;
  const run = pendingRun.then(completed => canJoin && completed || reconcileCurrent(state, deadline, shipments)).catch((error) => {
    writeDiagnostic("notification.fengchao.reminder.failed", { pushOrigin: "app_local", ...diagnosticErrorDetails(error) },
      "warning");
    return false;
  });
  pendingRun = run;
  return run.then(() => {
    if (pendingRun === run) pendingRevision = undefined;
  });
}

async function reconcileCurrent(state: AppState, deadline?: number, shipments?: readonly Shipment[]): Promise<boolean> {
  const now = Date.now();
  if (deadlineExpired(deadline, now) || peekStateRevision() !== state.revision) return false;
  const plans = new Map<string, Due>();
  for (const parcel of shipments ?? visibleShipments(state, now)) {
    const plan = fengchaoReminder(parcel, now);
    if (plan) plans.set(plan.key, plan);
  }
  if (!plans.size && !readReceipts()) return true;
  if (plans.size && !loadNotificationStatuses(true).includes("WAITING_PICKUP")) plans.clear();
  const budget = remainingTimeoutMs(deadline, 8_000);
  const lease = acquireDurableRefreshLease("fengchao-pickup-reminders", 10_000);
  if (!lease) return false;
  const end = now + budget;
  const current = () => lease.isCurrent() && peekStateRevision() === state.revision && Date.now() < end;
  try {
    const previous = readReceipts();
    if (!plans.size && !previous) return true;
    const receipts = previous || {};
    if (!previous) writeDurableText(LEDGER, "{}");
    const pending = await waitForRefresh(Notification.getAllPendingsOfCurrentScript(), end);
    if (!current()) return false;
    const retained = new Set<string>();
    const remove: string[] = [];
    for (const item of pending) {
      if (item.content.threadIdentifier !== THREAD) continue;
      const { fengchaoKey, remindAt, scheduledAt } = item.content.userInfo;
      const plan = plans.get(fengchaoKey);
      if (!plan || plan.remindAt !== remindAt || retained.has(fengchaoKey)) {
        remove.push(item.identifier);
      } else {
        retained.add(fengchaoKey);
        receipts[fengchaoKey] = { scheduledAt, freeUntil: plan.freeUntil };
      }
    }
    if (remove.length) await waitForRefresh(Notification.removePendings(remove), end);
    // D122: how many reminders this pass scheduled, removed and saw refused by the system (no shipment or code).
    let scheduled = 0, refused = 0;
    for (const [key, receipt] of Object.entries(receipts)) {
      if (receipt.freeUntil <= now || !plans.has(key) && receipt.scheduledAt > now) delete receipts[key];
    }
    for (const [key, plan] of plans) {
      if (!current()) return false;
      const time = Date.now();
      const scheduledAt = Math.max(time + 1_000, plan.remindAt);
      if (retained.has(key) || receipts[key]?.scheduledAt <= time || scheduledAt >= plan.freeUntil) continue;
      const accepted = await waitForRefresh(Notification.schedule({
        title: TITLE,
        body: BODY,
        threadIdentifier: THREAD,
        userInfo: { shipment: plan.shipmentId, fengchaoKey: key, remindAt: plan.remindAt, scheduledAt },
        trigger: new TimeIntervalNotificationTrigger({ timeInterval: (scheduledAt - time) / 1000, repeats: false }),
      }), end);
      if (accepted) {
        scheduled++;
        receipts[key] = { scheduledAt, freeUntil: plan.freeUntil };
        writeDurableText(LEDGER, JSON.stringify(receipts));
      } else refused++;
    }
    writeDurableText(LEDGER, JSON.stringify(receipts));
    if (scheduled || refused || remove.length) {
      writeDiagnostic("notification.fengchao.reminder.completed", {
        pushOrigin: "app_local", succeeded: scheduled, failed: refused, records: remove.length,
        result: refused ? "partial" : "succeeded",
      }, refused ? "warning" : "info");
    }
    return current();
  } finally {
    lease.release();
  }
}
