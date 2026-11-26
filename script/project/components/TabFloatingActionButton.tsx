import { Button, Label, VStack } from "scripting";

export const TAB_FAB_DIAMETER = 58;
const INSET = 20;
export const TAB_FAB_PADDING = { trailing: INSET, bottom: INSET };
export const TAB_FAB_SCROLL_INSET = 92;

export function tabCapsuleSurface(interactive = false) {
  if (Number.parseInt(Device.systemVersion, 10) >= 26) {
    return { glassEffect: { glass: UIGlass.regular().interactive(interactive),
      shape: { type: "capsule", style: "continuous" } } } as const;
  }
  return { background: { style: "thinMaterial", shape: "capsule" } } as const;
}

export function TabFloatingActionSurface({ title, symbol }: { title: string; symbol: string }) {
  const glass = Number.parseInt(Device.systemVersion, 10) >= 26;
  return (
    <VStack
      frame={{ width: TAB_FAB_DIAMETER, height: TAB_FAB_DIAMETER }}
      background={glass ? undefined : { style: "regularMaterial", shape: "circle" }}
      glassEffect={glass ? { glass: UIGlass.regular().interactive(true), shape: "circle" } : undefined}
      contentShape="circle"
    >
      <Label
        title={title}
        systemImage={symbol}
        labelStyle="iconOnly"
        font={22}
        fontWeight="semibold"
        foregroundStyle="label"
        frame={{ width: TAB_FAB_DIAMETER, height: TAB_FAB_DIAMETER }}
      />
    </VStack>
  );
}

export function TabFloatingActionButton({ title, symbol, action }: {
  title: string;
  symbol: string;
  action: () => void;
}) {
  const glass = Number.parseInt(Device.systemVersion, 10) >= 26;
  return (
    <Button
      buttonStyle="plain"
      accessibilityLabel={title}
      action={action}
      contentShape="circle"
      frame={{ width: TAB_FAB_DIAMETER, height: TAB_FAB_DIAMETER }}
      background={glass ? undefined : { style: "regularMaterial", shape: "circle" }}
      glassEffect={glass ? { glass: UIGlass.regular().interactive(true), shape: "circle" } : undefined}
    >
      <Label
        title={title}
        systemImage={symbol}
        labelStyle="iconOnly"
        font={22}
        fontWeight="semibold"
        foregroundStyle="label"
        frame={{ width: TAB_FAB_DIAMETER, height: TAB_FAB_DIAMETER }}
      />
    </Button>
  );
}
