import { AbortController, fetch, Path, type AbortSignal } from "scripting";
import { utf8Data } from "./scripting-data";
import { writeDiagnostic, type DiagnosticDetails } from "./logger";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const THUMBNAIL_EDGE = 432;
const TIMEOUT_MS = 20_000;

function allowedURL(value: string): string | null {
  const trimmed = value.trim();
  if (/[\u0000-\u001f\u007f\\]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    const authority = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1];
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && authority != null && !authority.includes("@") &&
      (!url.port || url.port === "443") &&
      (host === "jd.com" || host.endsWith(".jd.com") ||
        host === "360buyimg.com" || host.endsWith(".360buyimg.com"))
      ? url.href : null;
  } catch {
    return null;
  }
}

async function decode(data: Data, signal: AbortSignal, details: DiagnosticDetails): Promise<UIImage | null> {
  if (signal.aborted || data.size <= 0 || data.size > MAX_IMAGE_BYTES) return null;
  details.stage = "metadata";
  if (typeof ImageIO === "undefined" || typeof ImageIO.readMetadata !== "function") {
    details.result = "unavailable_api";
    return null;
  }
  // Inspect the encoded container before creating a bitmap, including cached files.
  const metadata = await ImageIO.readMetadata(data);
  const width = metadata.pixelWidth || 0, height = metadata.pixelHeight || 0;
  if (signal.aborted || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
    details.result = "invalid_dimensions";
    return null;
  }
  details.stage = "decode";
  const image = UIImage.fromData(data)?.preparingThumbnail({
    width: THUMBNAIL_EDGE,
    height: THUMBNAIL_EDGE,
  }) || null;
  if (!image) details.result = "decode_failed";
  return image;
}

function cachePath(url: string): string {
  const hash = Crypto.sha256(utf8Data(url)).toHexString().toLowerCase();
  // Scripting exposes no cache directory; its temporary directory is system-purgeable.
  return Path.join(FileManager.temporaryDirectory, "pipi-product-images", `${hash}.img`);
}

async function cached(path: string, signal: AbortSignal, details: DiagnosticDetails): Promise<UIImage | null> {
  try {
    const stat = await FileManager.stat(path);
    if (signal.aborted || stat.type !== "file" || stat.size <= 0 ||
        stat.size > MAX_IMAGE_BYTES || await FileManager.isLink(path)) return null;
    const image = await decode(await FileManager.readAsData(path), signal, details);
    if (!image && !signal.aborted) await FileManager.remove(path);
    return image;
  } catch {
    return null;
  }
}

async function cache(path: string, data: Data, signal: AbortSignal): Promise<void> {
  const pending = `${path}.pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    if (signal.aborted) return;
    await FileManager.createDirectory(Path.join(FileManager.temporaryDirectory, "pipi-product-images"), true);
    if (signal.aborted) return;
    await FileManager.writeAsData(pending, data);
    if (signal.aborted) return;
    await FileManager.rename(pending, path);
  } catch {
    // An optional cache failure must not hide an already validated product image.
  } finally {
    try { await FileManager.remove(pending); } catch { /* Already published or absent. */ }
  }
}

async function download(url: string, controller: AbortController, details: DiagnosticDetails): Promise<Data | null> {
  details.stage = "request";
  details.result = "failed";
  const visited = new Set([url]);
  let redirects = 0, rejectedRedirect = false;
  const response = await fetch(url, {
    timeout: TIMEOUT_MS / 1000,
    signal: controller.signal,
    headers: {
      Accept: "image/jpeg,image/png,image/webp,image/gif",
      "Accept-Encoding": "identity",
    },
    handleRedirect: async (request) => {
      const target = allowedURL(request.url);
      if (controller.signal.aborted || !target || visited.has(target) || ++redirects > MAX_REDIRECTS) {
        rejectedRedirect = true;
        details.result = "redirect_rejected";
        return null;
      }
      visited.add(target);
      return { ...request, url: target, method: "GET", body: undefined, cookies: [], headers: {
        Accept: "image/jpeg,image/png,image/webp,image/gif",
        "Accept-Encoding": "identity",
      } };
    },
  });
  details.stage = "response";
  details.httpStatus = response.status;
  const mime = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const length = response.headers.get("content-length");
  const expected = response.expectedContentLength;
  const finalURL = allowedURL(response.url);
  if (controller.signal.aborted || rejectedRedirect || !response.ok ||
      !finalURL || !visited.has(finalURL) ||
      !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime) ||
      (length != null && (!/^\d+$/.test(length.trim()) || Number(length) > MAX_IMAGE_BYTES)) ||
      (expected != null && expected >= 0 && expected > MAX_IMAGE_BYTES)) {
    details.result = rejectedRedirect || !finalURL || !visited.has(finalURL) ? "redirect_rejected"
      : !response.ok ? "http_error"
        : !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime) ? "unsupported_type" : "body_limit";
    controller.abort();
    return null;
  }
  const reader = response.dataStream.getReader();
  details.stage = "body";
  const data = Data.fromIntArray([]);
  try {
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        if (!data.size) details.result = "empty_body";
        return data.size > 0 ? data : null;
      }
      if (!value || data.size + value.size > MAX_IMAGE_BYTES) {
        details.result = "body_limit";
        controller.abort();
        return null;
      }
      data.append(value);
    }
    return null;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Product images are optional; cancellation and every validation failure return null. */
export async function loadProductImage(value: string, signal?: AbortSignal): Promise<UIImage | null> {
  const url = allowedURL(value);
  if (signal?.aborted) return null;
  if (!url) {
    writeDiagnostic("product.image.completed", { stage: "validation", result: "invalid_url" }, "warning");
    return null;
  }
  const startedAt = Date.now();
  const details: DiagnosticDetails = { stage: "cache", result: "failed" };
  let timedOut = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, TIMEOUT_MS);
  signal?.addEventListener("abort", abort);
  let finishAbort: () => void = () => {};
  const cancelled = new Promise<null>((resolve) => { finishAbort = () => resolve(null); });
  controller.signal.addEventListener("abort", finishAbort);
  try {
    const work = async (): Promise<UIImage | null> => {
      let path: string | null = null;
      try { path = cachePath(url); } catch { /* A missing cache does not disable downloading. */ }
      if (path) {
        const image = await cached(path, controller.signal, details);
        if (image) { details.stage = "cache"; return image; }
      }
      if (controller.signal.aborted) return null;
      const data = await download(url, controller, details);
      if (!data || controller.signal.aborted) return null;
      const image = await decode(data, controller.signal, details);
      if (!image || controller.signal.aborted) return null;
      if (path) await cache(path, data, controller.signal);
      return controller.signal.aborted ? null : image;
    };
    const image = await Promise.race([work().catch(() => null), cancelled]);
    if (!signal?.aborted) writeDiagnostic("product.image.completed", {
      ...details, result: timedOut ? "timeout" : image ? "loaded" : details.result,
      durationMs: Date.now() - startedAt,
    }, image ? "info" : "warning");
    return image;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", finishAbort);
  }
}
