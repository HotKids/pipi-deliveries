import { parseProviderTime } from "./status";

export type TimelineTimeParts = {
  date: string;
  time: string;
};

/** List timestamps use the provider's China wall clock, independently of the host timezone. */
export function formatListTime(value: string): string {
  const raw = String(value || "").trim();
  const match = raw.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?(\.\d{3})?(Z|[+-]\d{2}:\d{2})?$/,
  );
  if (!match) return raw;
  const local = `${match[1]} ${match[2]}${match[3] || ":00"}`;
  const chinaTime = parseProviderTime(local);
  if (chinaTime == null) return raw;
  const epoch = match[5]
    ? Date.parse(`${local.replace(" ", "T")}${match[4] || ""}${match[5]}`)
    : chinaTime;
  return Number.isFinite(epoch)
    ? new Date(epoch + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ")
    : raw;
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
