type Point = { x: number; y: number };

export default function jsQR(pixels: Uint8ClampedArray, width: number, height: number, options?: {
  inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst";
}): { data: string; location: {
  topLeftCorner: Point; topRightCorner: Point; bottomRightCorner: Point; bottomLeftCorner: Point;
} } | null;
