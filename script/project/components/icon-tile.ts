export function iconTileShape(size: number) {
  // The standard courier artwork is a 156 px tile with a 36 px corner.
  return { type: "rect", cornerRadius: size * 36 / 156, style: "continuous" } as const;
}
