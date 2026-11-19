import type { AbortSignal } from "scripting";
import type { Shipment } from "../models";
import { GatewayError, postGateway } from "./gateway";
import { beginDiagnosticOperation } from "./logger";
import { productTitle } from "./platform-parcel-data";
import type { CloudParcelMetadata, CloudParcelPddLink } from "./platform-parcel-merge";
import { cloudProductImageURL } from "./product-image-url";
import { publishSharedData, sharedData, withSharedFileTransaction } from "./shared-file-transaction";
import { asPlainObject, cleanString, positiveFiniteTime, type JsonObject } from "./value-guards";
import { matchesParcelMetadataLifecycle } from "./waybill-reuse";

export type CloudParcelDetails = Readonly<{
  metadata?: CloudParcelMetadata;
  pddLink?: CloudParcelPddLink;
}>;

export type CloudParcelMetadataCache = Readonly<{
  credential: string;
  deniedAt: number;
  entries: readonly { parcel: string; requestedAt: number; title?: CloudParcelMetadata }[];
}>;

const CACHE_LIMIT = 64;

export function cloudParcelMetadataForCache(shipment: Shipment, metadata?: CloudParcelMetadata): CloudParcelMetadata | undefined {
  if (!metadata || !matchesParcelMetadataLifecycle(shipment, metadata.anchorAt, metadata.terminalAt ?? 0, Date.now())) return;
  return metadata;
}

export function readCachedCloudParcelMetadata(credential: string, parcel: string): CloudParcelMetadata | undefined {
  const cache = sharedData().cloudParcelTitles;
  return cache?.credential === credential ? cache.entries.find(entry => entry.parcel === parcel)?.title : undefined;
}

export function recordCloudParcelMetadata(credential: string, parcel: string, requestedAt: number,
  result: CloudParcelMetadata | "denied" | undefined, isCurrent: () => boolean): void {
  try {
    withSharedFileTransaction(() => {
      if (!isCurrent()) return;
      const stored = sharedData().cloudParcelTitles;
      const cache = stored?.credential === credential ? stored : { credential, deniedAt: 0, entries: [] };
      if (requestedAt <= cache.deniedAt) return;
      if (result === "denied") {
        // A delayed response may be older than a successful lookup in another detail.
        publishSharedData({ cloudParcelTitles: { credential, deniedAt: requestedAt,
          entries: cache.entries.filter(entry => entry.requestedAt > requestedAt) } });
        return;
      }
      const previous = cache.entries.find(entry => entry.parcel === parcel);
      if (previous && previous.requestedAt >= requestedAt) return;
      const entries = [{ parcel, requestedAt, title: result }, ...cache.entries.filter(entry => entry.parcel !== parcel)];
      publishSharedData({ cloudParcelTitles: { ...cache, entries: entries.slice(0, CACHE_LIMIT) } });
    });
  } catch { /* A failed optional cache write cannot hide a verified result. */ }
}

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
  const productImageURL = cloudProductImageURL(value.productImageUrl);
  const deliveryEstimate = cleanString(value.deliveryEstimate).replace(/。$/, "");
  const deliveryEstimateObservedAt = positiveFiniteTime(value.deliveryEstimateObservedAt, now);
  const metadata = identity && (productName || productImageURL || deliveryEstimate && deliveryEstimateObservedAt)
    ? { ...identity, productName, ...(productImageURL ? { productImageURL } : {}), deliveryEstimate, deliveryEstimateObservedAt } : undefined;
  const link = asPlainObject(result.pddLink);
  const linkIdentity = parcelIdentity(link, waybill, now);
  const shippingId = typeof link.shippingId === "string" ? link.shippingId : "";
  const pddLink = linkIdentity && /^[1-9][0-9]{0,19}$/.test(shippingId) && positiveFiniteTime(link.observedAt, now)
    ? { ...linkIdentity, shippingId } : undefined;
  return metadata || pddLink ? { metadata, pddLink } : undefined;
}

export async function readCloudParcelMetadata(waybill: string, signal: AbortSignal): Promise<CloudParcelDetails | undefined> {
  const finish = beginDiagnosticOperation("cloud.parcel.metadata", { stage: "query" }, false);
  try {
    const result = await postGateway("/api/cloud-records/parcel-metadata", { schemaVersion: 1, waybill }, { signal });
    if (result.ok !== true || !Object.hasOwn(result, "metadata")) throw new GatewayError("服务响应异常");
    const details = parseCloudParcelDetails(result, waybill, Date.now());
    if (details) finish("succeeded");
    return details;
  } catch (error) {
    if (!signal.aborted) finish("failed", {}, "warning");
    throw error;
  }
}
