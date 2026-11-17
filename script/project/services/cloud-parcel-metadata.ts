import type { AbortSignal } from "scripting";
import { postGateway } from "./gateway";
import { productTitle } from "./platform-parcel-data";
import type { CloudParcelMetadata } from "./platform-parcel-merge";
import { asPlainObject, cleanString, positiveFiniteTime } from "./value-guards";

export async function readCloudParcelMetadata(waybill: string, signal: AbortSignal): Promise<CloudParcelMetadata | undefined> {
  const result = await postGateway("/api/cloud-records/parcel-metadata", { schemaVersion: 1, waybill }, { signal });
  const value = asPlainObject(result.metadata);
  if (result.ok !== true || value.waybill !== waybill) return;
  const now = Date.now();
  const anchorAt = positiveFiniteTime(value.anchorAt, now);
  const terminalAt = positiveFiniteTime(value.terminalAt, now);
  if (!anchorAt || (Object.hasOwn(value, "terminalAt") && value.terminalAt !== 0 && terminalAt < anchorAt)) return;
  const productName = productTitle(value.productName);
  const deliveryEstimate = cleanString(value.deliveryEstimate).replace(/。$/, "");
  const deliveryEstimateObservedAt = positiveFiniteTime(value.deliveryEstimateObservedAt, now);
  if (!productName && (!deliveryEstimate || !deliveryEstimateObservedAt)) return;
  return { waybill, anchorAt, terminalAt, productName, deliveryEstimate, deliveryEstimateObservedAt };
}
