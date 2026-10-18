import type { AppState, Shipment } from "../models";
import type { StatusAlignmentTimes } from "./shipment-policy";
import {
  loadAlignmentRecords, parseAlignmentAttempt, rowLedgerKey, saveAlignmentRecords,
  type AlignmentAttempt,
} from "./row-ledger";
import { isAccountUpdateSummary, timelineLatestTrackAt } from "./status";
import { loadState, saveState } from "./storage";
import { withSharedFileTransaction } from "./shared-file-transaction";

export type StatusAlignmentRecordStore = Readonly<{
  load: () => Record<string, string>;
  save: (records: Record<string, string>) => void;
}>;

export const alignmentRecordStore: StatusAlignmentRecordStore = {
  load: loadAlignmentRecords, save: saveAlignmentRecords,
};

export function alignmentTimesKey(times: Readonly<StatusAlignmentTimes>): string {
  return `${times.statusAtMs}|${times.headlineAtMs}|${times.detailAtMs}`;
}

/** Enum corrections invalidate completion without restoring the same group's consumed allowance. */
export function alignmentCompletionApplies(record: AlignmentAttempt | null,
  times: Readonly<StatusAlignmentTimes>): boolean {
  return Boolean(record?.complete && record.completionStatus && record.completionHeadline &&
    (!times.statusSemantic || times.statusSemantic === "UNKNOWN" || times.statusSemantic === record.completionStatus) &&
    (!times.headlineSemantic || times.headlineSemantic === "UNKNOWN" || times.headlineSemantic === record.completionHeadline));
}

export function alignmentAttemptDue(record: AlignmentAttempt | null, times: Readonly<StatusAlignmentTimes>,
  now: number, interval: number, includeWaiting = false): boolean {
  return record?.times !== alignmentTimesKey(times) || !(alignmentCompletionApplies(record, times) ||
    record.attempts >= 3 || (!includeWaiting && now - record.lastAttemptAtMs < interval));
}

/** Call only at the provider's dispatch boundary, while holding the row's detail lease. */
export function reserveAlignmentAttempt(rowId: string, times: Readonly<StatusAlignmentTimes>, now: number,
  interval: number, records: StatusAlignmentRecordStore = alignmentRecordStore): AlignmentAttempt {
  const current = records.load(), key = rowLedgerKey(rowId), old = parseAlignmentAttempt(current[key]);
  if (!alignmentAttemptDue(old, times, now, interval)) throw new Error("Alignment attempt is no longer due");
  const reserved: AlignmentAttempt = { times: alignmentTimesKey(times),
    attempts: (old?.times === alignmentTimesKey(times) ? old.attempts : 0) + 1,
    lastAttemptAtMs: now, complete: false, finished: false };
  current[key] = JSON.stringify(reserved);
  records.save(current);
  return reserved;
}

/** Capture clocks alone are not newer logistics evidence. */
export function newerAlignmentEvidence(before: Shipment, after: Shipment | undefined): boolean {
  if (!after) return false;
  const packages = (shipment: Shipment) => {
    const slots = [shipment.sourceTimeline, ...shipment.manualTimelines || []]
      .filter((timeline): timeline is NonNullable<typeof timeline> => Boolean(timeline));
    return (slots.length ? slots : [shipment.timeline]).map(timeline => ({ ...timeline,
      tracks: timeline.tracks.filter(track => !isAccountUpdateSummary(track.detail)) }));
  };
  const previous = new Map(packages(before).map(timeline => [timeline.provider, timeline]));
  return packages(after).some(timeline => {
    const old = previous.get(timeline.provider);
    return timelineLatestTrackAt(timeline) > (old ? timelineLatestTrackAt(old) : 0) ||
      (timeline.structuredStatus === true && timeline.semantic !== "UNKNOWN" &&
        (timeline.statusEventAtMs || 0) > (old?.structuredStatus ? old.statusEventAtMs || 0 : 0));
  });
}

export function finishAlignmentAttempt(rowId: string, attempt: AlignmentAttempt, complete: boolean,
  snapshot: StatusAlignmentTimes | null, records: StatusAlignmentRecordStore = alignmentRecordStore): boolean {
  const current = records.load(), key = rowLedgerKey(rowId), reserved = parseAlignmentAttempt(current[key]);
  if (reserved?.times !== attempt.times || reserved.lastAttemptAtMs !== attempt.lastAttemptAtMs ||
      reserved.attempts !== attempt.attempts) return false;
  current[key] = JSON.stringify({ ...attempt, finished: true, complete,
    ...(snapshot ? { completionStatus: snapshot.statusSemantic || "UNKNOWN",
      completionHeadline: snapshot.headlineSemantic || "UNKNOWN" } : {}) });
  records.save(current);
  return true;
}

function owner(shipment: Shipment): string {
  const id = shipment.identity;
  return JSON.stringify([id.id, id.bindingSource, id.sourceOwner, id.sourceId, id.sourceProvider,
    id.createdAtMs, id.phone, id.manuallyAdded, id.projectedWaybill, id.orderId, shipment.waybillReuseAtMs]);
}

export function alignmentOwnerCurrent(before: AppState, target: Shipment, latest: AppState): boolean {
  const row = latest.shipments.find(item => item.identity.id === target.identity.id);
  const binding = (state: AppState) => state.bindings.filter(item =>
    item.source === target.identity.bindingSource && item.phone === target.identity.phone);
  return Boolean(row && owner(row) === owner(target) &&
    JSON.stringify(binding(before)) === JSON.stringify(binding(latest)));
}

/** Ledger-only projection changes need a real revision; never relax the UI's stale-state guard. */
export function publishAlignmentPresentation(before: AppState, target: Shipment, attempt: AlignmentAttempt,
  now: number, isCurrent: () => boolean = () => true): AppState | null {
  return withSharedFileTransaction(() => {
    const latest = loadState(now);
    const saved = parseAlignmentAttempt(loadAlignmentRecords()[rowLedgerKey(target.identity.id)]);
    if (!isCurrent() || !alignmentOwnerCurrent(before, target, latest) ||
        saved?.times !== attempt.times || saved.lastAttemptAtMs !== attempt.lastAttemptAtMs ||
        saved.attempts !== attempt.attempts || !saved.finished) return null;
    return saveState(latest, now);
  });
}
