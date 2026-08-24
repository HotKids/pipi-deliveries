import { Notification, Script } from "scripting";
import type { Shipment } from "../models";
import { courierIconName } from "./carrier-presentation";
import {
  normalizedProjectedWaybill,
  statusLabel,
  waybillSuffix,
} from "./status";
import { displayWaybill } from "./shipment-policy";
import { notificationEnabled } from "./notification-preferences";

function notificationTitle(shipment: Shipment): string {
  const suffix = waybillSuffix(displayWaybill(shipment));
  const meta = suffix
    ? `${suffix} · ${statusLabel(shipment.timeline.semantic)}`
    : statusLabel(shipment.timeline.semantic);
  return `${shipment.identity.companyName} ${meta}`.trim();
}

function notificationIcon(shipment: Shipment): Data | null {
  const icon = courierIconName(
    shipment.identity.courierCode,
    shipment.identity.companyName,
    Boolean(
      shipment.identity.accountOrder
      && !normalizedProjectedWaybill(shipment.identity),
    ),
  );
  if (!icon) return null;
  return Data.fromFile(
    `${Script.directory}/assets/couriers/${icon}.png`,
  );
}

export async function notifyShipmentChange(
  previous: Shipment | null,
  current: Shipment,
): Promise<void> {
  if (!previous) return;
  if (!notificationEnabled(current.timeline.semantic)) return;
  const changed =
    notificationTitle(previous) !== notificationTitle(current) ||
    previous.timeline.latestDetail !== current.timeline.latestDetail;
  if (!changed) return;
  try {
    await Notification.schedule({
      title: notificationTitle(current),
      body: current.timeline.latestDetail.trim() || "物流状态已更新",
      iconImageData: notificationIcon(current),
      actions: [
        {
          title: "查看详情",
          url: Script.createRunSingleURLScheme(Script.name, {
            shipment: current.identity.id,
          }),
        },
      ],
    });
  } catch {
    /* notifications never roll back an already persisted shipment update */
  }
}

export async function notifyShipmentChanges(
  previousById: ReadonlyMap<string, Shipment>,
  shipments: readonly Shipment[],
): Promise<void> {
  await Promise.allSettled(
    shipments.map((shipment) =>
      notifyShipmentChange(
        previousById.get(shipment.identity.id) || null,
        shipment,
      )
    ),
  );
}
