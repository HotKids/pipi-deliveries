export type TimelineTimeParts = {
  date: string;
  time: string;
};

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
