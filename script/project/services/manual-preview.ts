import type { PendingManualQuery, Shipment } from "../models";
import { selectShipmentDetailTimeline } from "./shipment-policy";
import { containsTimelineStartTrack, timedTracks } from "./status";

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

/** An order or pickup event proves the selected history includes its starting stage. */
export function manualPreviewNeedsDetailRefresh(
  shipment: Shipment | null,
): boolean {
  if (!shipment) return true;
  return !containsTimelineStartTrack(
    selectShipmentDetailTimeline(shipment).tracks,
  );
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
