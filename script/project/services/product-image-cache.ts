import { Path } from "scripting";
import type { ShipmentIdentity } from "../models";
import { utf8Data } from "./scripting-data";
import { writeDiagnostic } from "./logger";

const images = new Map<string, UIImage>();
const MEMORY_LIMIT = 32;
export const PRODUCT_IMAGE_TIMEOUT_MS = 20_000;
const IMAGE_NAME = /^[a-f0-9]{64}\.\d+-[a-z0-9]+\.img$/;
const DELETE_NAME = /^[a-f0-9]{64}\.\d+-[a-z0-9]+\.deleted$/;
const PENDING_NAME = /^[a-f0-9]{64}\.\d+-[a-z0-9]+\.img\.pending-(\d+)-[a-z0-9]+$/;

function directory(): string {
  return Path.join(FileManager.appGroupDocumentsDirectory, "pipi-deliveries", "product-images");
}

function cacheNames(): string[] {
  try {
    return FileManager.readDirectorySync(directory(), false).map(path => path.slice(path.lastIndexOf("/") + 1));
  } catch { return []; }
}

export function productImageCacheKey(identity: ShipmentIdentity): string {
  // Account refresh rebuilds createdAtMs; the owner and order remain stable across projection.
  try {
    return Crypto.sha256(utf8Data(JSON.stringify([
      identity.bindingSource, identity.id, identity.sourceId, identity.phone || "", identity.orderId || "",
    ]))).toHexString().toLowerCase();
  } catch {
    return "";
  }
}

export function productImageCachePath(key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid product image cache identity");
  return Path.join(directory(), `${key}.${Date.now()}-${Math.random().toString(36).slice(2) || "0"}.img`);
}

export function productImageCacheFiles(key: string): string[] {
  if (!/^[a-f0-9]{64}$/.test(key)) return [];
  return cacheNames().filter(name => IMAGE_NAME.test(name) && name.startsWith(`${key}.`) &&
    !FileManager.existsSync(Path.join(directory(), name.replace(/\.img$/, ".deleted"))))
    .sort().map(name => Path.join(directory(), name));
}

export function cachedProductImage(key: string): UIImage | null {
  if (!key) return null;
  const image = images.get(key);
  if (!image) return null;
  images.delete(key);
  images.set(key, image);
  return image;
}

export function rememberProductImage(key: string, image: UIImage): UIImage {
  if (!key) return image;
  const existing = cachedProductImage(key);
  if (existing) return existing;
  images.set(key, image);
  if (images.size > MEMORY_LIMIT) images.delete(images.keys().next().value!);
  return image;
}

export function pruneProductImages(previous: readonly ShipmentIdentity[], retained: readonly ShipmentIdentity[], now = Date.now()): void {
  let failed = false;
  try {
    const keep = new Set(retained.map(productImageCacheKey));
    if (keep.has("")) throw new Error("Product image identity unavailable");
    const names = cacheNames();
    for (const key of new Set(previous.map(productImageCacheKey))) {
      if (!key || keep.has(key)) continue;
      images.delete(key);
      for (const name of names.filter(value => IMAGE_NAME.test(value) && value.startsWith(`${key}.`))) {
        try { FileManager.writeAsStringSync(Path.join(directory(), name.replace(/\.img$/, ".deleted")), ""); }
        catch {
          failed = true;
          try { FileManager.removeSync(Path.join(directory(), name)); } catch { /* Leave the successful cleanup markers replayable. */ }
        }
      }
    }
  } catch { failed = true; }
  try {
    const names = cacheNames();
    // Markers name immutable files, so retrying an old deletion cannot remove a re-imported record's image.
    for (const name of names.filter(value => DELETE_NAME.test(value))) {
      try {
        const path = Path.join(directory(), name.replace(/\.deleted$/, ".img"));
        if (FileManager.existsSync(path)) FileManager.removeSync(path);
        FileManager.removeSync(Path.join(directory(), name));
      } catch { failed = true; }
    }
    // A terminated runtime cannot run finally; preserve pending files until their writer's deadline has passed.
    for (const name of names) {
      const started = PENDING_NAME.exec(name)?.[1];
      if (started == null || !Number.isSafeInteger(Number(started)) ||
          now - Number(started) <= PRODUCT_IMAGE_TIMEOUT_MS) continue;
      try { FileManager.removeSync(Path.join(directory(), name)); }
      catch { failed = true; }
    }
  } catch { failed = true; }
  if (failed) {
    try { writeDiagnostic("product.image.cache_cleanup_failed", { stage: "cache", result: "failed" }, "warning"); }
    catch { /* Image cleanup cannot fail a saved shipment transaction. */ }
  }
}
