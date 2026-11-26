import { Button, Label, VStack } from "scripting";

export const TAB_FAB_DIAMETER = 48;
export const TAB_FAB_SCROLL_INSET = 92;

export function tabFabPadding(): { trailing: number; bottom: number } {
  const ios26 = typeof Device !== "undefined" && Number.parseInt(Device.systemVersion, 10) >= 26;
  const screenWidth = typeof Device !== "undefined" ? Number(Device.screen?.width) || 393 : 393;
  if (ios26 && screenWidth >= 390) {
    const safeBottom = Math.max(0, Number(Device.safeAreaInsets?.bottom) || 34);
    return {
      trailing: screenWidth >= 414 ? 20 : 14,
      bottom: safeBottom > 0 ? Math.max(12, safeBottom - 7) : 12,
    };
  }
  return { trailing: 20, bottom: 16 };
}

export const TAB_FAB_PADDING = tabFabPadding();

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
        font={20}
        fontWeight="semibold"
        foregroundStyle="label"
        frame={{ width: TAB_FAB_DIAMETER, height: TAB_FAB_DIAMETER }}
      />
    </Button>
  );
}
