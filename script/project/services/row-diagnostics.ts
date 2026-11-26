/**
 * Per-row express lines (D131, the iOS counterpart of Pipi's D42/D21): what the list shows for a row, whether the
 * detail page shows the same state, and what became of the row's notification. Diagnostics only: nothing here changes
 * a row, a notification or what is stored.
 *
 * - `express.row.changed`: the row's list presentation (status, the packages that supply its status, headline and
 *   history, the detail page's state, the 寄 mark, the signed freeze) changed in a commit.
 * - `express.row.mismatch`: the same line when the list and the detail page show different states; it is also
 *   repeated for a row that stays mismatched, at most once per REPEAT_RELOG_MS on this device (the repeat
 *   record is shared by every runtime).
 * - `notification.decision`: a notification that was held for its carrier, suppressed or delivered. Suppressed
 *   first sightings are one count per commit.
 *
 * Rows are identified by the waybill's last four characters only (D5, owner 2026-11-21 「保留尾号写成例外，订单指纹换句柄
 * （推荐）」); no row id, order number or phone number is written.
 */
import type { Shipment, ShipmentNotificationEvent } from "../models";
import { changedSinceLastLogged, diagnosticsEnabled, writeDiagnosticBatch, type DiagnosticDetails } from "./logger";
import {
  displayWaybill, selectShipmentDetailTimeline, shipmentSelectionEvidence, signedRefreshFrozen,
} from "./shipment-policy";
import { normalizeWaybill, shipmentPresentationStatus } from "./status";

export type NotificationDecision = Readonly<{
  shipment: Shipment;
  semantic?: string;
  result: "held" | "notified" | "suppressed";
  skipReason?: "first_seen" | "retention_hidden" | "attached" | "no_item_order" | "channel_off" | "removed";
}>;

function rowTail(shipment: Shipment): string {
  const waybill = normalizeWaybill(displayWaybill(shipment));
  return waybill.length > 4 ? waybill.slice(-4) : "";
}

function numericFlowId(value: string | undefined): string | undefined {
  return value && /^\d{1,17}$/.test(value) ? value : undefined;
}

/** What the list and detail page show for a row: the facts `express.row.*` compares between commits. */
export function rowPresentationDetails(shipment: Shipment, now = Date.now()): DiagnosticDetails {
  const evidence = shipmentSelectionEvidence(shipment);
  const detail = selectShipmentDetailTimeline(shipment);
  return {
    waybillTail: rowTail(shipment),
    automatic: !shipment.identity.manuallyAdded,
    sourceProvider: String(shipment.identity.sourceProvider || "").trim().toLowerCase(),
    statusSemantic: shipmentPresentationStatus(shipment).semantic,
    statusProvider: evidence.statusProvider,
    headlineProvider: evidence.headlineProvider,
    historyProvider: evidence.historyProvider,
    selectionReason: evidence.selectionReason,
    detailStatusSemantic: detail.semantic,
    detailTimelineProvider: String(detail.provider || "").trim().toLowerCase(),
    senderRole: shipment.identity.sender === true,
    signedFrozen: signedRefreshFrozen(shipment, now),
  };
}

function presentationKey(details: DiagnosticDetails): string {
  return JSON.stringify(details);
}

/**
 * Called by the state commit with the state it replaces and the state it writes, only while recording is on. The
 * written state is a fresh decode, so every row's presentation is compared on each commit; a row whose object is
 * unchanged is skipped.
 */
export function recordRowPresentationChanges(
  previous: readonly Shipment[], next: readonly Shipment[], flowId?: string, now = Date.now(),
): void {
  if (!diagnosticsEnabled()) return;
  const previousById = new Map(previous.map(row => [row.identity.id, row]));
  const changed: DiagnosticDetails[] = [];
  const mismatched: DiagnosticDetails[] = [];
  for (const shipment of next) {
    const before = previousById.get(shipment.identity.id);
    if (before === shipment || shipment.timeline.provider === "demo") continue;
    const details = rowPresentationDetails(shipment, now);
    const fingerprint = presentationKey(details);
    const mismatch = details.statusSemantic !== details.detailStatusSemantic;
    const presentationChanged = !before || presentationKey(rowPresentationDetails(before, now)) !== fingerprint;
    // The row id reaches only the shared repeat record, as a short hash; it is never written to the log.
    const repeated = mismatch && changedSinceLastLogged(`express.row.mismatch\u0000${shipment.identity.id}`, fingerprint, now);
    if (!presentationChanged && !repeated) continue;
    const line = { ...details, flowId: numericFlowId(flowId), result: before ? "changed" : "added" };
    (mismatch ? mismatched : changed).push(line);
  }
  if (changed.length) writeDiagnosticBatch("express.row.changed", changed);
  if (mismatched.length) writeDiagnosticBatch("express.row.mismatch", mismatched, "warning");
}

/** One line per held, suppressed or delivered notification; first sightings are counted, not listed. */
export function recordNotificationDecisions(decisions: readonly NotificationDecision[], flowId?: string): void {
  if (!decisions.length || !diagnosticsEnabled()) return;
  const lines: DiagnosticDetails[] = [];
  let firstSeen = 0;
  for (const decision of decisions) {
    if (decision.skipReason === "first_seen") {
      firstSeen++;
      continue;
    }
    lines.push({
      flowId: numericFlowId(flowId),
      pushOrigin: "app_local",
      waybillTail: rowTail(decision.shipment),
      statusSemantic: decision.semantic || shipmentPresentationStatus(decision.shipment).semantic,
      result: decision.result,
      ...(decision.skipReason ? { skipReason: decision.skipReason } : {}),
    });
  }
  if (firstSeen) {
    lines.push({ flowId: numericFlowId(flowId), pushOrigin: "app_local", result: "suppressed",
      skipReason: "first_seen", records: firstSeen });
  }
  if (lines.length) writeDiagnosticBatch("notification.decision", lines);
}

/** The decision for an event the outbox drain delivers or retires without delivering. */
export function notificationDecisionForEvent(
  event: ShipmentNotificationEvent, shipment: Shipment | undefined, delivered: boolean, channelOff: boolean,
  attached: boolean,
): NotificationDecision | undefined {
  if (!shipment) return undefined;
  if (delivered) return { shipment, semantic: event.semantic, result: "notified" };
  return { shipment, semantic: event.semantic, result: "suppressed",
    skipReason: channelOff ? "channel_off" : attached ? "attached" : "retention_hidden" };
}

