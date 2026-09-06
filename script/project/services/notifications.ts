import { Notification, Script } from "scripting";
import type { Shipment, StatusSemantic } from "../models";
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

function notificationIcon(shipment: Shipment): Data | null {
  const icon = courierIconName(
    shipment.identity.courierCode,
    shipment.identity.companyName,
    Boolean(
      shipment.identity.accountOrder
      && !normalizedProjectedWaybill(shipment.identity),
    ),
  );
  // Android intentionally omits the generic carrier artwork from notifications.
  if (!icon || icon === "default") return null;
  return Data.fromFile(
    `${Script.directory}/assets/couriers/${icon}.png`,
  );
}

function presentedSemantic(shipment: Shipment): string {
  return shipment.statusPresentation?.semantic || shipment.timeline.semantic;
}

/** 通知看的事件时间：状态事件时间优先，没有就取最新有时间的节点。 */
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

export async function notifyShipmentChange(
  previous: Shipment | null,
  current: Shipment,
  canSchedule: () => boolean = () => true,
): Promise<void> {
  if (!previous) return;
  if (isFrozenJingDongShipment(previous)) return;
  // 开关看的是用户看见的状态（用户定 2026-09-06）：京东订单的 ORDER 级展示「已完成」就按「已完成」
  // 的开关判，与下面的状态比较、通知标题同一个语义；Lite / Pipi 的系统渠道也是按展示状态分的。
  if (!notificationEnabled(presentedSemantic(current) as StatusSemantic)) return;
  // 与 Pipi 的 shouldNotifyTrackChange 同口径（三端统一，2026-09-05）：只有**状态变了**，或者
  // **出现了更新的事件**（事件时间更晚且标题/正文确实变了），才是一次新通知。只比文案会让
  // 「摘要换成全量轨迹的头条」这种重写把早已签收的件再通知一遍——Lite 上八票同一分钟复发。
  // 状态看用户看见的那个：京东订单的 ORDER 级展示（statusPresentation）也算状态。
  const statusChanged = presentedSemantic(previous) !== presentedSemantic(current);
  const visibleChanged =
    notificationTitle(previous) !== notificationTitle(current) ||
    previous.timeline.latestDetail !== current.timeline.latestDetail;
  const newerEvent = notificationEventAt(current) > notificationEventAt(previous);
  if (!statusChanged && !(visibleChanged && newerEvent)) return;
  try {
    if (!canSchedule()) return;
    await Notification.schedule({
      title: notificationTitle(current),
      body: current.timeline.latestDetail.trim() || "物流状态已更新",
      iconImageData: notificationIcon(current),
      userInfo: { shipment: current.identity.id },
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
  canSchedule: () => boolean = () => true,
): Promise<void> {
  for (const shipment of shipments) {
    if (!canSchedule()) return;
    await notifyShipmentChange(
      previousById.get(shipment.identity.id) || null,
      shipment,
      canSchedule,
    );
  }
}
