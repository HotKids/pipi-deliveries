import type { Shipment, TimelinePackage } from "../models";
import { parseListEventTime, shipmentDetailSigningAtMs } from "./status";

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

export type TimelineTimeParts = {
  date: string;
  time: string;
};

/** List timestamps use the provider's China wall clock, independently of the host timezone. */
export function formatListTime(value: string): string {
  const raw = String(value || "").trim();
  const epoch = parseListEventTime(raw);
  return epoch != null
    ? new Date(epoch + CHINA_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ")
    : raw;
}

export function shipmentDetailReceiptLine(shipment: Shipment, detail: TimelinePackage, now = Date.now()): string {
  const phoneTail = [shipment.identity.phoneTail, shipment.identity.phone, shipment.accountRecord?.phone]
    .map(value => (value || "").replace(/\D/g, "").slice(-4)).find(tail => tail.length === 4);
  const signedAt = shipmentDetailSigningAtMs(shipment, detail, now);
  const signingTime = signedAt
    ? new Date(signedAt + CHINA_OFFSET_MS).toISOString().slice(5, 16).replace("-", "/").replace("T", " ")
    : "";
  return [phoneTail && `手机尾号：${phoneTail}`, signingTime && `${signingTime} 签收`]
    .filter(Boolean).join("｜");
}

function matchProviderTime(value: string): RegExpMatchArray | null {
  return String(value || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/,
  );
}

export function timelineTimeParts(value: string): TimelineTimeParts {
  const match = matchProviderTime(value);
  if (!match) {
    return { date: "", time: String(value || "").trim() };
  }
  return {
    date: `${match[2]}-${match[3]}`,
    time: `${match[4]}:${match[5]}`,
  };
}

export function compactTimelineTime(
  value: string,
  now = new Date(),
): string {
  const match = matchProviderTime(value);
  if (!match) return String(value || "").trim();
  const sameDay = Number(match[1]) === now.getFullYear()
    && Number(match[2]) === now.getMonth() + 1
    && Number(match[3]) === now.getDate();
  return sameDay
    ? `${match[4]}:${match[5]}`
    : `${match[2]}-${match[3]}`;
}
