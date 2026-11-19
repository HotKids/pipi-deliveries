import type { AbortSignal } from "scripting";
import type { Shipment } from "../models";
import { GatewayError, postGateway } from "./gateway";
import { productTitle } from "./platform-parcel-data";
import type { CloudParcelMetadata, CloudParcelPddLink } from "./platform-parcel-merge";
import { publishSharedData, sharedData, withSharedFileTransaction } from "./shared-file-transaction";
import { asPlainObject, cleanString, positiveFiniteTime, type JsonObject } from "./value-guards";
import { matchesParcelMetadataLifecycle } from "./waybill-reuse";

export type CloudParcelDetails = Readonly<{
  metadata?: CloudParcelMetadata;
  pddLink?: CloudParcelPddLink;
}>;

type CloudParcelTitle = Pick<CloudParcelMetadata, "waybill" | "anchorAt" | "terminalAt"> & { productName: string };

export type CloudParcelTitleCache = Readonly<{
  credential: string;
  deniedAt: number;
  entries: readonly { parcel: string; requestedAt: number; title?: CloudParcelTitle }[];
}>;

const CLOUD_TITLE_CACHE_LIMIT = 64;

export function cloudParcelTitle(shipment: Shipment, metadata?: CloudParcelMetadata): CloudParcelTitle | undefined {
  if (!metadata?.productName ||
      !matchesParcelMetadataLifecycle(shipment, metadata.anchorAt, metadata.terminalAt ?? 0, Date.now())) return;
  return { waybill: metadata.waybill, anchorAt: metadata.anchorAt, terminalAt: metadata.terminalAt,
    productName: metadata.productName };
}

export function readCachedCloudParcelTitle(credential: string, parcel: string): CloudParcelTitle | undefined {
  const cache = sharedData().cloudParcelTitles;
  return cache?.credential === credential ? cache.entries.find(entry => entry.parcel === parcel)?.title : undefined;
}

export function recordCloudParcelTitle(credential: string, parcel: string, requestedAt: number,
  result: CloudParcelTitle | "denied" | undefined, isCurrent: () => boolean): void {
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
      publishSharedData({ cloudParcelTitles: { ...cache, entries: entries.slice(0, CLOUD_TITLE_CACHE_LIMIT) } });
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
  if (result.ok !== true || !Object.hasOwn(result, "metadata")) throw new GatewayError("服务响应异常");
  return parseCloudParcelDetails(result, waybill, Date.now());
}
