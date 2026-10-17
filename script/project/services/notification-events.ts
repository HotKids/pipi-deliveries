import type { Shipment, ShipmentNotificationEvent, StatusSemantic } from "../models";
import { carrierDisplayName, courierIconName } from "./carrier-presentation";
import {
  normalizedProjectedWaybill,
  shipmentPresentationStatus,
  timelineDisplayDetail,
  waybillSuffix,
} from "./status";
import {
  displayWaybill,
  isFrozenJingDongShipment,
  selectShipmentTimeline,
} from "./shipment-policy";
import { notificationEnabled } from "./notification-preferences";

function notificationTitle(shipment: Shipment): string {
  const suffix = waybillSuffix(displayWaybill(shipment));
  const presentation = shipmentPresentationStatus(shipment);
  const meta = suffix
    ? `${suffix} · ${presentation.text}`
    : presentation.text;
  // 其余裁决 35: an empty carrier reads 「快递」 in the title (display only).
  return `${carrierDisplayName(shipment.identity.companyName)} ${meta}`.trim();
}

/**
 * The status the user sees (audit L2, adopted 2026-09-25; AGENTS §9 通知开关看用户看见的状态): the
 * same presentation as the list and the title, so an unprojected order the list shows as 已下单 uses
 * the 已下单 switch and its Worker order status moving from ORDERED to PICKED is not a change.
 */
function presentedSemantic(shipment: Shipment): string {
  return shipmentPresentationStatus(shipment).semantic;
}

/** Prefer structured status time, then the newest timed track. */
function notificationEventAt(shipment: Shipment): number {
  const statusAt = shipment.timeline.statusEventAtMs;
  if (typeof statusAt === "number" && Number.isFinite(statusAt) && statusAt > 0) {
    return statusAt;
  }
  let latest = 0;
  for (const track of shipment.timeline.tracks) {
    if (typeof track.timeMs === "number" && track.timeMs > latest) latest = track.timeMs;
  }
  return latest;
}

export function shipmentNotificationEvent(
  previous: Shipment | null,
  current: Shipment,
  /**
   * `statusChangeOnly`: the round in which a projected order row merged with an existing row of the
   * same waybill (user 2026-09-25) notifies only a change of the presented status; a newer event
   * with changed text alone does not.
   */
  rule: Readonly<{ statusChangeOnly?: boolean }> = {},
): Omit<ShipmentNotificationEvent, "id"> | null {
  if (!previous) return null;
  if (isFrozenJingDongShipment(previous)) return null;
  // Preferences and comparisons follow the visible status, including JD order completion.
  if (!notificationEnabled(presentedSemantic(current) as StatusSemantic)) return null;
  // Text-only rewrites of the same old event must not notify again.
  const statusChanged = presentedSemantic(previous) !== presentedSemantic(current);
  const visibleChanged =
    notificationTitle(previous) !== notificationTitle(current) ||
    previous.timeline.latestDetail !== current.timeline.latestDetail;
  // An event is newer only when the previous one has a known time: a timed rewrite of an untimed
  // version is the same event (Lite's strict reading, all four clients, user 2026-09-25; Fold7
  // re-notified six signed parcels that way on 2026-09-05).
  const previousEventAt = notificationEventAt(previous);
  const newerEvent = previousEventAt > 0 && notificationEventAt(current) > previousEventAt;
  if (!statusChanged && (rule.statusChangeOnly || !(visibleChanged && newerEvent))) return null;
  return shipmentNotificationPresentation(current);
}

/**
 * The notification one row shows as it is now. A queued event whose carrier was still unmatched is rebuilt from
 * this once the carrier is known (T23, user 2026-09-26), so its title never carries a blank carrier.
 */
export function shipmentNotificationPresentation(
  current: Shipment,
): Omit<ShipmentNotificationEvent, "id"> {
  const iconName = courierIconName(
    current.identity.courierCode,
    current.identity.companyName,
    Boolean(current.identity.accountOrder && !normalizedProjectedWaybill(current.identity)),
  );
  return {
    shipmentId: current.identity.id,
    semantic: presentedSemantic(current) as StatusSemantic,
    title: notificationTitle(current),
    body: timelineDisplayDetail(selectShipmentTimeline(current)).trim() || "物流状态已更新",
    iconName: !iconName || iconName === "default" ? null : iconName,
  };
}
