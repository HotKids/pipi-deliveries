import type { AbortSignal } from "scripting";
import type { Shipment } from "../models";
import { GatewayError, postGateway } from "./gateway";
import { beginDiagnosticOperation, diagnosticErrorDetails } from "./logger";
import { productTitle } from "./platform-parcel-data";
import type { CloudParcelMetadata, CloudParcelPddLink } from "./platform-parcel-merge";
import { cloudProductImageURL } from "./product-image-url";
import { publishSharedData, sharedData, withSharedFileTransaction } from "./shared-file-transaction";
import { asPlainObject, cleanString, cloudRecordTime, type JsonObject } from "./value-guards";
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
  if (cache?.credential !== credential) return undefined;
  const exact = cache.entries.find(entry => entry.parcel === parcel);
  if (exact) return exact.title;
  try {
    const parsed = JSON.parse(parcel) as unknown;
    const waybill = Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : "";
    if (waybill) return cache.entries.find(entry => entry.parcel === waybill)?.title;
  } catch {
    const prefix = `[${JSON.stringify(parcel)},`;
    const byWaybill = cache.entries.find(entry => entry.parcel.startsWith(prefix));
    if (byWaybill) return byWaybill.title;
  }
  return undefined;
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

/**
 * R5-NEW-11 ④: a cloud time read on this device's clock, as the PDD pages read theirs (`cloudRecordTime`). A record the
 * Worker just wrote may lead a slow clock by up to the Worker's tolerance and reads as now; one further ahead is invalid.
 */
function cloudTime(value: unknown, now: number): number {
  return cloudRecordTime(value, now) ?? 0;
}

function parcelIdentity(value: JsonObject, waybill: string, now: number) {
  if (value.waybill !== waybill) return;
  const anchorAt = cloudTime(value.anchorAt, now);
  const terminalAt = cloudTime(value.terminalAt, now);
  if (!anchorAt || (Object.hasOwn(value, "terminalAt") && value.terminalAt !== 0 && terminalAt < anchorAt)) return;
  return { waybill, anchorAt, terminalAt };
}

export function parseCloudParcelDetails(result: JsonObject, waybill: string, now: number): CloudParcelDetails | undefined {
  if (result.ok !== true) return;
  const value = asPlainObject(result.metadata);
  const identity = parcelIdentity(value, waybill, now);
  const productName = productTitle(value.productName);
  const productNameObservedAt = cloudTime(value.productNameObservedAt, now);
  const productImageURL = cloudProductImageURL(value.productImageUrl);
  const deliveryEstimate = cleanString(value.deliveryEstimate).replace(/。$/, "");
  const deliveryEstimateObservedAt = cloudTime(value.deliveryEstimateObservedAt, now);
  const metadata = identity && (productName || productImageURL || deliveryEstimate && deliveryEstimateObservedAt)
    ? {
        ...identity,
        productName,
        ...(productName && productNameObservedAt ? { productNameObservedAt } : {}),
        ...(productImageURL ? { productImageURL } : {}),
        deliveryEstimate,
        deliveryEstimateObservedAt,
      } : undefined;
  const link = asPlainObject(result.pddLink);
  const linkIdentity = parcelIdentity(link, waybill, now);
  const shippingId = typeof link.shippingId === "string" ? link.shippingId : "";
  const pddLink = linkIdentity && /^[1-9][0-9]{0,19}$/.test(shippingId) && cloudTime(link.observedAt, now)
    ? { ...linkIdentity, shippingId } : undefined;
  return metadata || pddLink ? { metadata, pddLink } : undefined;
}

export async function readCloudParcelMetadata(waybill: string, signal: AbortSignal): Promise<CloudParcelDetails | undefined> {
  // D115: every read ends with one line; a failure carries its category and HTTP status, a closed page reads as
  // cancelled, and a reply without fields for this parcel as empty.
  // D188 (D29): the read is one cloud.sync line of the parcel_metadata domain.
  const finish = beginDiagnosticOperation("cloud.sync", { domain: "parcel_metadata", stage: "query" });
  try {
    const result = await postGateway("/api/cloud-records/parcel-metadata", { schemaVersion: 1, waybill }, { signal });
    if (result.ok !== true || !Object.hasOwn(result, "metadata")) throw new GatewayError("服务响应异常");
    const details = parseCloudParcelDetails(result, waybill, Date.now());
    finish(details ? "succeeded" : "empty");
    return details;
  } catch (error) {
    if (signal.aborted) finish("cancelled");
    else finish("failed", diagnosticErrorDetails(error), "warning");
    throw error;
  }
}
