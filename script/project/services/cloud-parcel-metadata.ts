import type { AbortSignal } from "scripting";
import { postGateway } from "./gateway";
import { productTitle } from "./platform-parcel-data";
import type { CloudParcelMetadata, CloudParcelPddLink } from "./platform-parcel-merge";
import { asPlainObject, cleanString, positiveFiniteTime, type JsonObject } from "./value-guards";

export type CloudParcelDetails = Readonly<{
  metadata?: CloudParcelMetadata;
  pddLink?: CloudParcelPddLink;
}>;

function parcelIdentity(value: JsonObject, waybill: string, now: number) {
  if (value.waybill !== waybill) return;
  const anchorAt = positiveFiniteTime(value.anchorAt, now);
  const terminalAt = positiveFiniteTime(value.terminalAt, now);
  if (!anchorAt || (Object.hasOwn(value, "terminalAt") && value.terminalAt !== 0 && terminalAt < anchorAt)) return;
  return { waybill, anchorAt, terminalAt };
}

export function parseCloudParcelDetails(result: JsonObject, waybill: string, now: number): CloudParcelDetails | undefined {
  if (result.ok !== true) return;
  const value = asPlainObject(result.metadata);
  const identity = parcelIdentity(value, waybill, now);
  const productName = productTitle(value.productName);
  const deliveryEstimate = cleanString(value.deliveryEstimate).replace(/。$/, "");
  const deliveryEstimateObservedAt = positiveFiniteTime(value.deliveryEstimateObservedAt, now);
  const metadata = identity && (productName || deliveryEstimate && deliveryEstimateObservedAt)
    ? { ...identity, productName, deliveryEstimate, deliveryEstimateObservedAt } : undefined;
  const link = asPlainObject(result.pddLink);
  const linkIdentity = parcelIdentity(link, waybill, now);
  const shippingId = typeof link.shippingId === "string" ? link.shippingId : "";
  const pddLink = linkIdentity && /^[1-9][0-9]{0,19}$/.test(shippingId) && positiveFiniteTime(link.observedAt, now)
    ? { ...linkIdentity, shippingId } : undefined;
  return metadata || pddLink ? { metadata, pddLink } : undefined;
}

export async function readCloudParcelMetadata(waybill: string, signal: AbortSignal): Promise<CloudParcelDetails | undefined> {
  const result = await postGateway("/api/cloud-records/parcel-metadata", { schemaVersion: 1, waybill }, { signal });
  return parseCloudParcelDetails(result, waybill, Date.now());
}
