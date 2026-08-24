import type { PendingManualQuery, Shipment } from "../models";
import { upsertPendingQuery } from "./storage";
import { timedTracks } from "./status";

export type ManualPreviewOutcome = {
  shipment: Shipment | null;
  pending: PendingManualQuery | null;
  routeUrl: string;
};

export type PreparedManualPreview = {
  shipment: Shipment;
  pending: PendingManualQuery | null;
  routeUrl: string;
  hasTimedResult: boolean;
};

/** Persists required retry state before the caller opens a detail screen or external page. */
export function prepareManualPreview(
  outcome: ManualPreviewOutcome,
): PreparedManualPreview {
  if (outcome.pending) {
    upsertPendingQuery({ ...outcome.pending, route: null });
  }
  if (!outcome.shipment) throw new Error("暂无轨迹");
  return {
    shipment: outcome.shipment,
    pending: outcome.pending,
    routeUrl: outcome.routeUrl,
    hasTimedResult: timedTracks(outcome.shipment.timeline.tracks).length > 0,
  };
}
