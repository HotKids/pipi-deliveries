import jsQR from "./vendor/jsQR.js";

export function readMealQRs(image: UIImage): string[] {
  if (typeof image.toPixels !== "function") return [];
  const { width, height, data } = image.toPixels();
  if (!(data instanceof Uint8Array) || width * height * 4 !== data.length) return [];
  return decodeMealQRs(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height);
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
