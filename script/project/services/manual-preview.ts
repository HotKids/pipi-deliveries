import type { PendingManualQuery, Shipment } from "../models";
import { hasTimelineStartBeforeKdniao } from "./shipment-policy";
import { timedTracks } from "./status";

export type ManualPreviewOutcome = {
  shipment: Shipment | null;
  pending: PendingManualQuery | null;
  routeUrl: string;
};

export type PreparedManualPreview = {
  shipment: Shipment | null;
  pending: PendingManualQuery | null;
  routeUrl: string;
  hasTimedResult: boolean;
};

/** Loading ends when a current provider's accumulated origin aligns with the latest parcel evidence. */
export function manualPreviewNeedsDetailRefresh(
  shipment: Shipment | null,
): boolean {
  return !shipment || !hasTimelineStartBeforeKdniao(shipment);
}

/** Normalizes the preview; the caller commits shipment and retry state atomically. */
export function prepareManualPreview(
  outcome: ManualPreviewOutcome,
): PreparedManualPreview {
  if (!outcome.shipment && !outcome.pending) throw new Error("暂无轨迹");
  return {
    shipment: outcome.shipment,
    pending: outcome.pending,
    routeUrl: outcome.routeUrl,
    hasTimedResult: Boolean(
      outcome.shipment && timedTracks(outcome.shipment.timeline.tracks).length > 0,
    ),
  };
}
