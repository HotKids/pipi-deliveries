import { Image, VStack, type Color } from "scripting";
import { iconTileShape } from "./icon-tile";

export const SETTINGS_ORANGE = "#F0A03C";

export function SettingsRowIcon({ systemName, backgroundColor, size = 30 }: {
  systemName: string;
  backgroundColor: Color;
  size?: number;
}) {
  return (
    <VStack frame={{ width: size, height: size }}
      background={{ style: backgroundColor, shape: iconTileShape(size) }}>
      <Image systemName={systemName} font={16}
        symbolRenderingMode="monochrome" foregroundStyle="white" />
    </VStack>
  );
}
