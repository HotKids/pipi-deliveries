import type { Shipment, TimelinePackage, TrackNode } from "../models";
import type { AccountParcelDto } from "./account-parser";
import { parseListEventTime, parseProviderTime, timedTracks, semanticFromAccountState, semanticFromStored } from "./status";

/**
 * A carrier reusing an old waybill number (user decisions 2026-10-01/02, all four clients): 「C 新件优先（含 A）」,
 * 「至少晚 24 小时」, 「当新件初次出现，不通知」, details 「全部按推荐」.
 *
 * The number is reused when the old record is terminal (signed or cancelled) and the new record's anchor is at least
 * 24 hours after the old record's terminal time. The anchor is the new record's earliest timed node; a record without
 * nodes uses its own status time, then its latest time; a record with no time at all is never judged reused. The old
 * record's terminal time is the latest of its own status time, the time it shows and its newest timed node, so none of
 * the old parcel's own nodes falls inside the 24 hours (the same reading as Pipi). A time is valid when positive and not
 * in the future. JingDong business sources (JingDong-sourced rows, account orders) are excluded on either side.
 *
 * The new record takes the row as a first sighting: the old record's packages, latch, note, forced completion, detail
 * selection and carrier recognition go, and the row carries `waybillReuseAtMs` so storage neither restores the old
 * settled clock nor notifies the takeover. An old record meeting a row a newer parcel already took is ignored, and the
 * account list keeps the new record of the two in either order (detail 5).
 */
export const WAYBILL_REUSE_MIN_GAP_MS = 24 * 60 * 60 * 1_000;

type ReuseTimeline = Pick<TimelinePackage, "semantic" | "structuredStatus" | "statusEventAtMs" | "latestTimeText" | "tracks">;

function validTime(value: unknown, now: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= now ? value : 0;
}

function textTime(value: string, now: number): number {
  return validTime(parseListEventTime(value) ?? parseProviderTime(value), now);
}

/** The old record's terminal time: the latest of its status time, its shown time and its newest timed node; 0 when not terminal. */
export function waybillReuseTerminalAtMs(timeline: ReuseTimeline, now: number): number {
  if (timeline.structuredStatus !== true ||
      (timeline.semantic !== "COMPLETED" && timeline.semantic !== "CANCELLED")) return 0;
  let latest = Math.max(validTime(timeline.statusEventAtMs, now), textTime(timeline.latestTimeText, now));
  for (const track of timedTracks(timeline.tracks)) latest = Math.max(latest, validTime(track.timeMs, now));
  return latest;
}

/** The record's earliest timed node; without nodes its own status time, then its latest time; 0 without a time. */
export function waybillReuseAnchorAtMs(timeline: ReuseTimeline, now: number): number {
  let earliest = 0;
  for (const track of timedTracks(timeline.tracks)) {
    const at = validTime(track.timeMs, now);
    if (at && (!earliest || at < earliest)) earliest = at;
  }
  return earliest || validTime(timeline.statusEventAtMs, now) || textTime(timeline.latestTimeText, now);
}

export function reusesWaybill(oldTerminalAtMs: number, newAnchorAtMs: number): boolean {
  return oldTerminalAtMs > 0 && newAnchorAtMs > 0 && newAnchorAtMs - oldTerminalAtMs >= WAYBILL_REUSE_MIN_GAP_MS;
}

function jingDongSource(value: unknown): boolean {
  return String(value || "").trim().toLowerCase() === "jingdong";
}

function excludedShipment(shipment: Shipment): boolean {
  return Boolean(shipment.identity.accountOrder) || jingDongSource(shipment.identity.sourceProvider);
}

/**
 * The right-swipe sign-off (`forcedCompletedAtMs`) is neither a terminal status nor a terminal time here (用户 2026-10-02
 * 「修，和 Pipi 一致」): only what the row's own sources report counts. Callers pass each row as its sources present it
 * (shipment-policy `withoutForcedCompletion`); a presentation still carrying the latch (signed at exactly the click time)
 * is read as having no status, so it neither makes the row a reuse candidate nor anchors a new record.
 */
function reuseTimeline(shipment: Shipment): ReuseTimeline {
  const forcedAt = Number(shipment.forcedCompletedAtMs);
  const timeline = shipment.timeline;
  if (!(Number.isFinite(forcedAt) && forcedAt > 0) || timeline.statusEventAtMs !== forcedAt) return timeline;
  return { ...timeline, semantic: "UNKNOWN", statusEventAtMs: null };
}

/**
 * A row's own reuse anchor (the anchor `shipmentReusesWaybill` reads for a new record): its source record's earliest timed
 * node, then that record's status time, then its latest time; a manual row without a source record reads its own
 * presentation, the sign-off latch read as no status. 0 without a valid time. 优化 5 (user 2026-10-03) sends it with the
 * paid carrier classification.
 */
export function shipmentReuseAnchorAtMs(shipment: Shipment, now = Date.now()): number {
  return waybillReuseAnchorAtMs(shipment.sourceTimeline || reuseTimeline(shipment), now);
}

/** Whether `incoming` is a new parcel on the number the stored row `current` shows. */
export function shipmentReusesWaybill(current: Shipment, incoming: Shipment, now: number): boolean {
  if (excludedShipment(current) || excludedShipment(incoming)) return false;
  return reusesWaybill(
    waybillReuseTerminalAtMs(reuseTimeline(current), now),
    waybillReuseAnchorAtMs(incoming.sourceTimeline || reuseTimeline(incoming), now),
  );
}

/** The takeover generation of a row; 0 for a row never taken over. */
export function waybillReuseGeneration(shipment: Shipment | null | undefined): number {
  const value = Number(shipment?.waybillReuseAtMs);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Whether `next` is a later takeover generation of the row `previous` was: its baseline is not the new parcel's. */
export function newerWaybillReuseGeneration(
  previous: Shipment | null | undefined,
  next: Shipment | null | undefined,
): boolean {
  return Boolean(previous && next) && waybillReuseGeneration(next) > waybillReuseGeneration(previous);
}

function parcelTimeline(parcel: AccountParcelDto): ReuseTimeline {
  const tracks: TrackNode[] = parcel.tracks.map((track) => ({
    timeText: track.timeText,
    timeMs: parseProviderTime(track.timeText),
    detail: track.detail,
    statusCode: track.statusCode,
    raw: {},
  }));
  const latest = tracks.find((track) => track.timeMs != null && track.detail);
  return {
    semantic: parcel.semantic,
    structuredStatus: parcel.normalizedStatus?.structured ?? (parcel.semantic !== "UNKNOWN" && parcel.semantic === (
      parcel.source === "interface5" ? semanticFromAccountState(parcel.sourceStateCode, "")
        : semanticFromStored(parcel.sourceStateCode, "")
    )),
    statusEventAtMs: parcel.normalizedStatus
      ? parcel.normalizedStatus.eventAtMs || null
      : latest?.timeMs ?? parseProviderTime(parcel.latestTimeText),
    latestTimeText: latest?.timeText || parcel.latestTimeText,
    tracks,
  };
}

/** An account record's own reuse anchor (the same reading as `shipmentReuseAnchorAtMs`); 0 without a valid time. */
export function accountParcelReuseAnchorAtMs(parcel: AccountParcelDto, now = Date.now()): number {
  return waybillReuseAnchorAtMs(parcelTimeline(parcel), now);
}

/** Detail 5: of two list records with one identity, whether `newer` is the new parcel on the number `older` used. */
export function parcelSupersedes(older: AccountParcelDto, newer: AccountParcelDto, now: number): boolean {
  if (older.accountOrder || newer.accountOrder ||
      jingDongSource(older.sourceProvider) || jingDongSource(newer.sourceProvider)) return false;
  return reusesWaybill(
    waybillReuseTerminalAtMs(parcelTimeline(older), now),
    waybillReuseAnchorAtMs(parcelTimeline(newer), now),
  );
}
