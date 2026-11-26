import jsQR from "./vendor/jsQR.js";

const MAX_QR_SCAN_DIMENSION = 1440;

function prepareScanImage(image: UIImage): UIImage {
  const scale = typeof image.scale === "number" && image.scale > 0 ? image.scale : 1;
  const pixelWidth = image.width * scale;
  const pixelHeight = image.height * scale;
  const maxSide = Math.max(pixelWidth, pixelHeight);
  if (!(maxSide > MAX_QR_SCAN_DIMENSION) || typeof image.preparingThumbnail !== "function") {
    return image;
  }
  const ratio = MAX_QR_SCAN_DIMENSION / maxSide;
  const targetWidth = Math.max(1, Math.round((pixelWidth * ratio) / scale));
  const targetHeight = Math.max(1, Math.round((pixelHeight * ratio) / scale));
  try {
    return image.preparingThumbnail({ width: targetWidth, height: targetHeight }) ?? image;
  } catch {
    return image;
  }
}

function downsampleRgba(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  maxDimension: number,
): { pixels: Uint8ClampedArray; width: number; height: number } {
  const maxSide = Math.max(width, height);
  if (maxSide <= maxDimension) return { pixels: source, width, height };
  const ratio = maxDimension / maxSide;
  const targetWidth = Math.max(1, Math.round(width * ratio));
  const targetHeight = Math.max(1, Math.round(height * ratio));
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y++) {
    const srcY = Math.min(height - 1, Math.floor((y + 0.5) / ratio));
    const srcRow = srcY * width;
    const dstRow = y * targetWidth;
    for (let x = 0; x < targetWidth; x++) {
      const srcX = Math.min(width - 1, Math.floor((x + 0.5) / ratio));
      const srcOffset = (srcRow + srcX) * 4;
      const dstOffset = (dstRow + x) * 4;
      out[dstOffset] = source[srcOffset]!;
      out[dstOffset + 1] = source[srcOffset + 1]!;
      out[dstOffset + 2] = source[srcOffset + 2]!;
      out[dstOffset + 3] = source[srcOffset + 3]!;
    }
  }
  return { pixels: out, width: targetWidth, height: targetHeight };
}

export function readMealQRs(image: UIImage): string[] {
  if (typeof image.toPixels !== "function") return [];
  const prepared = prepareScanImage(image);
  const { width, height, data } = prepared.toPixels();
  if (!(data instanceof Uint8Array) || width * height * 4 !== data.length) return [];
  const clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const scaled = downsampleRgba(clamped, width, height, MAX_QR_SCAN_DIMENSION);
  return decodeMealQRs(scaled.pixels, scaled.width, scaled.height);
}

export function decodeMealQRs(pixels: Uint8ClampedArray, width: number, height: number): string[] {
  const values = new Set<string>();
  // Scan again with the decoded symbol covered, so a second distinct symbol can veto redemption.
  for (let attempt = 0; attempt < 16; attempt++) {
    const result = jsQR(pixels, width, height, { inversionAttempts: "attemptBoth" });
    if (!result) return [...values];
    if (result.data.trim()) values.add(result.data);
    if (values.size > 1) return [...values];
    const corners = [result.location.topLeftCorner, result.location.topRightCorner,
      result.location.bottomRightCorner, result.location.bottomLeftCorner];
    const top = Math.max(0, Math.floor(Math.min(...corners.map(p => p.y))));
    const bottom = Math.min(height, Math.ceil(Math.max(...corners.map(p => p.y))));
    // Cover the quadrilateral precisely, without erasing another QR in the same bounding box.
    for (let y = top; y < bottom; y++) {
      const intersections = corners.flatMap((a, i) => {
        const b = corners[(i + 1) % corners.length];
        return (a.y <= y && b.y > y || b.y <= y && a.y > y)
          ? [a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)] : [];
      });
      if (intersections.length < 2) continue;
      const left = Math.max(0, Math.floor(Math.min(...intersections)));
      const right = Math.min(width, Math.ceil(Math.max(...intersections)));
      pixels.fill(255, (y * width + left) * 4, (y * width + right) * 4);
    }
  }
  // The image has more decodable symbols than can be exhausted in one shortcut run.
  return [];
}
