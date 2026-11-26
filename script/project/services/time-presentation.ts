import { parseListEventTime } from "./status";

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

// A time that names its zone is an instant; Pipi reads the same forms (ExpressTimeCodec.timelineTime).
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The provider wall clock of a track time (2026-11-20 review, part 3 rule 1). A zoned time first reads in
 * Beijing time, as the list does; an ISO local time drops its seconds and fraction.
 */
function matchProviderTime(value: string): RegExpMatchArray | null {
  const raw = String(value || "").trim();
  return (ZONED_TIME.test(raw) ? formatListTime(raw) : raw).match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/,
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
