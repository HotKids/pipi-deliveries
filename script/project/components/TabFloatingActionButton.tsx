import { Label, VStack } from "scripting";

export const TAB_FAB_DIAMETER = 58;
const INSET = 20;
export const TAB_FAB_PADDING = { trailing: INSET, bottom: INSET };
export const TAB_FAB_SCROLL_INSET = TAB_FAB_DIAMETER + INSET;

export function tabCapsuleSurface(interactive = false) {
  if (Number.parseInt(Device.systemVersion, 10) >= 26) {
    return { glassEffect: { glass: UIGlass.regular().interactive(interactive),
      shape: { type: "capsule", style: "continuous" } } } as const;
  }
  return { background: { style: "thinMaterial", shape: "capsule" } } as const;
}

export function TabFloatingActionButton({ title, symbol, action }: {
  title: string;
  symbol: string;
  action: () => void;
}) {
  const glass = Number.parseInt(Device.systemVersion, 10) >= 26;
  return (
    <VStack frame={{ width: TAB_FAB_DIAMETER, height: TAB_FAB_DIAMETER }}
      background={{ style: { light: "rgba(255,255,255,0.55)", dark: "rgba(0,0,0,0.34)" }, shape: "circle" }}
      glassEffect={glass ? { glass: UIGlass.clear().interactive(true), shape: { type: "capsule", style: "continuous" } } : undefined}
      shadow={{ color: "rgba(0,0,0,0.15)", radius: 12, x: 0, y: 4 }}
      onTapGesture={action} contentShape="rect">
      <Label title={title} systemImage={symbol} labelStyle="iconOnly" font={22} fontWeight="semibold"
        foregroundStyle={{ light: "#1C1C1E", dark: "#FFFFFF" }} />
    </VStack>
  );
}
