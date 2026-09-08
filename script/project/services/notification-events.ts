import type { Shipment, ShipmentNotificationEvent, StatusSemantic } from "../models";
import { courierIconName } from "./carrier-presentation";
import {
  normalizedProjectedWaybill,
  shipmentPresentationStatus,
  waybillSuffix,
} from "./status";
import {
  displayWaybill,
  isFrozenJingDongShipment,
} from "./shipment-policy";
import { notificationEnabled } from "./notification-preferences";

function notificationTitle(shipment: Shipment): string {
  const suffix = waybillSuffix(displayWaybill(shipment));
  const presentation = shipmentPresentationStatus(shipment);
  const meta = suffix
    ? `${suffix} · ${presentation.text}`
    : presentation.text;
  return `${shipment.identity.companyName} ${meta}`.trim();
}

function presentedSemantic(shipment: Shipment): string {
  return shipment.statusPresentation?.semantic || shipment.timeline.semantic;
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
  const newerEvent = notificationEventAt(current) > notificationEventAt(previous);
  if (!statusChanged && !(visibleChanged && newerEvent)) return null;
  const iconName = courierIconName(
    current.identity.courierCode,
    current.identity.companyName,
    Boolean(current.identity.accountOrder && !normalizedProjectedWaybill(current.identity)),
  );
  return {
    shipmentId: current.identity.id,
    semantic: presentedSemantic(current) as StatusSemantic,
    title: notificationTitle(current),
    body: current.timeline.latestDetail.trim() || "物流状态已更新",
    iconName: !iconName || iconName === "default" ? null : iconName,
  };
}
