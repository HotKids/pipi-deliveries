import type { Shipment } from "../models";
import type { AccountParcelDto } from "./account-parser";
import { normalizedProjectedWaybill } from "./status";

/**
 * Restores the account-list projection reference without exposing it through AppState. The
 * shipment remains the identity authority; a detail response may only enrich its presentation.
 */
export function accountParcelWithProjectionReference(
  shipment: Shipment,
  parcel: AccountParcelDto | null,
  projectionUrl: string,
): AccountParcelDto | null {
  const source = shipment.identity.bindingSource;
  if (
    !source ||
    shipment.identity.manuallyAdded ||
    !shipment.identity.accountOrder
  ) {
    return parcel;
  }
  const trustedReference = String(parcel?.projectionUrl || projectionUrl || "")
    .trim();
  if (!parcel && !trustedReference) return null;
  const timeline = shipment.sourceTimeline || shipment.timeline;
  const projectedWaybill = normalizedProjectedWaybill(shipment.identity);
  return {
    source,
    ownerId: shipment.identity.sourceId,
    waybill: projectedWaybill || parcel?.waybill || shipment.identity.sourceId,
    orderId: shipment.identity.orderId || parcel?.orderId ||
      shipment.identity.sourceId,
    accountOrder: true,
    courierCode: parcel?.courierCode || shipment.identity.courierCode,
    rawCourierCode:
      parcel?.rawCourierCode || shipment.identity.rawCourierCode || "",
    rawCompanyName:
      parcel?.rawCompanyName || shipment.identity.rawCompanyName || "",
    companyName: parcel?.companyName || shipment.identity.companyName,
    carrierNormalization: parcel?.carrierNormalization || null,
    sourceProvider: parcel?.sourceProvider ||
      shipment.identity.sourceProvider || "",
    sourceStateCode: parcel?.sourceStateCode ||
      String(shipment.accountRecord?.stateNumber || ""),
    sourceStateText: parcel?.sourceStateText || timeline.semantic,
    semantic: parcel?.semantic || timeline.semantic,
    normalizedStatusScope: parcel?.normalizedStatusScope,
    normalizedStatusSemantic: parcel?.normalizedStatusSemantic,
    normalizedStatusText: parcel?.normalizedStatusText,
    receiverPhone: parcel?.receiverPhone || shipment.identity.phone || "",
    senderPhone: parcel?.senderPhone || "",
    latestTimeText: parcel?.latestTimeText || timeline.latestTimeText,
    latestDetail: parcel?.latestDetail || timeline.latestDetail,
    tracks: parcel?.tracks || timeline.tracks.map((track) => ({
      timeText: track.timeText,
      detail: track.detail,
      statusCode: track.statusCode,
    })),
    routeUrl: parcel?.routeUrl || "",
    projectionUrl: trustedReference,
  };
}
