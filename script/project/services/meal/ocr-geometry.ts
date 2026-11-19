import type { PickupOcrBlock } from "./pickup-types";

export type VisionBoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function visionBoundingBoxToOcrBlock(
  text: string,
  boundingBox: VisionBoundingBox,
  imageWidth: number,
  imageHeight: number,
): PickupOcrBlock {
  return {
    text,
    left: boundingBox.x * imageWidth,
    top: (1 - boundingBox.y - boundingBox.height) * imageHeight,
    right: (boundingBox.x + boundingBox.width) * imageWidth,
    bottom: (1 - boundingBox.y) * imageHeight,
  };
}
