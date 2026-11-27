import { HStack, Image, Text, VStack, type Color, type DynamicShapeStyle, type PopoverPresentation } from "scripting";

export const TAB_FAB_DIAMETER = 58;
export const TAB_FAB_SCROLL_INSET = 104;
export const TAB_FAB_PADDING = { trailing: 20, bottom: 20 } as const;

export function tabFabPadding(): { trailing: number; bottom: number } {
  return TAB_FAB_PADDING;
}

export function dyn(light: Color, dark: Color): DynamicShapeStyle {
  return { light, dark };
}

export const ROOT_PAGE_BG = dyn("#F1F1F5", "#000000");
export const ROUND_BUTTON_FG = dyn("#1C1C1E", "#FFFFFF");
const CAPSULE_SHAPE = { type: "capsule", style: "continuous" } as const;

export function glassFill(): DynamicShapeStyle {
  return dyn("rgba(255,255,255,0.55)", "rgba(0,0,0,0.34)");
}

export function clearInteractiveGlass() {
  if (
    typeof Device !== "undefined" &&
    Number.parseInt(Device.systemVersion, 10) >= 26 &&
    typeof UIGlass !== "undefined"
  ) {
    return { glass: UIGlass.clear().interactive(true), shape: CAPSULE_SHAPE } as const;
  }
  return undefined;
}

export function tabCapsuleSurface(interactive = false) {
  if (
    typeof Device !== "undefined" &&
    Number.parseInt(Device.systemVersion, 10) >= 26 &&
    typeof UIGlass !== "undefined"
  ) {
    return { glassEffect: { glass: UIGlass.regular().interactive(interactive), shape: CAPSULE_SHAPE } } as const;
  }
  return { background: { style: "thinMaterial", shape: "capsule" } } as const;
}

export function RoundButton({
  size = 42,
  icon,
  iconSize = 17,
  label,
  accessibilityLabel,
  onTap,
  withShadow = false,
}: {
  size?: number;
  icon: string;
  iconSize?: number;
  label?: string;
  accessibilityLabel?: string;
  onTap?: () => void;
  withShadow?: boolean;
}) {
  const fg = ROUND_BUTTON_FG;
  const glass = clearInteractiveGlass();
  const bg = !glass && size > 48
    ? ({ style: "regularMaterial", shape: "circle" } as const)
    : ({ style: glassFill(), shape: "circle" } as const);
  const shadow = withShadow
    ? { color: "rgba(0,0,0,0.15)" as Color, radius: 12, x: 0, y: 4 }
    : undefined;
  return (
    <VStack
      frame={{ width: size, height: size }}
      background={bg}
      glassEffect={glass}
      shadow={shadow}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityAddTraits="isButton"
      onTapGesture={onTap}
      contentShape="circle"
    >
      <VStack spacing={label ? 1 : 0}>
        <Image systemName={icon} font={iconSize} fontWeight="semibold" foregroundStyle={fg} />
        {label ? <Text font={9} fontWeight="medium" foregroundStyle={fg}>{label}</Text> : null}
      </VStack>
    </VStack>
  );
}

export function TabFloatingActionButton({ title, symbol, label, action }: {
  title: string;
  symbol: string;
  label?: string;
  action: () => void;
}) {
  return (
    <RoundButton
      size={TAB_FAB_DIAMETER}
      icon={symbol}
      iconSize={label ? 19 : 22}
      label={label}
      accessibilityLabel={title}
      onTap={action}
      withShadow
    />
  );
}

export type FloatingActionItem = {
  symbol: string;
  label?: string;
  title?: string;
  action: () => void;
  popover?: PopoverPresentation | PopoverPresentation[];
  anchorPad?: number;
};

export function FloatingActions({ items }: { items: readonly FloatingActionItem[] }) {
  return (
    <VStack spacing={10} alignment="trailing">
      {items.map((item, index) => (
        <HStack key={index} spacing={0} popover={item.popover}>
          {item.anchorPad ? <VStack frame={{ width: item.anchorPad, height: TAB_FAB_DIAMETER }} /> : null}
          <TabFloatingActionButton
            title={item.title ?? item.label ?? ""}
            symbol={item.symbol}
            label={item.label}
            action={item.action}
          />
        </HStack>
      ))}
    </VStack>
  );
}
