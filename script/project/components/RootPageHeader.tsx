import { Button, HStack, Rectangle, Spacer, Text, VStack, ZStack } from "scripting";
import { tabCapsuleSurface } from "./TabFloatingActionButton";

const NAVIGATION_CONTROL_HEIGHT = 44;
const COLLAPSE_DISTANCE = NAVIGATION_CONTROL_HEIGHT / 2;
export const ROOT_TITLE_CAPSULE_WIDTH = 68;
export const ROOT_HEADER_HORIZONTAL_INSET = 20;

type RootScrollGeometry = {
  contentOffset: { y: number };
  contentInsets: { top: number };
};

export function rootPageScroll(onCollapsed: (collapsed: boolean) => void) {
  const collapsedAt = (geometry: RootScrollGeometry) =>
    geometry.contentOffset.y + geometry.contentInsets.top >= COLLAPSE_DISTANCE;
  return {
    onScrollGeometryChange: {
      of: "geometry" as const,
      onChanged: (previous: RootScrollGeometry, next: RootScrollGeometry) => {
        const collapsed = collapsedAt(next);
        if (collapsed !== collapsedAt(previous)) onCollapsed(collapsed);
      },
    },
  };
}

export function RootPageHeader({ title, close, collapsed, background = "systemGroupedBackground" }: {
  title: string;
  close: () => void;
  collapsed: boolean;
  background?: "systemBackground" | "systemGroupedBackground";
}) {
  const glass = Number.parseInt(Device.systemVersion, 10) >= 26;
  return (
    <VStack spacing={0} padding={{ top: 8, bottom: 16, horizontal: ROOT_HEADER_HORIZONTAL_INSET }} background={background}>
      <HStack frame={{ maxWidth: "infinity", height: NAVIGATION_CONTROL_HEIGHT }}>
        <ZStack frame={{ width: ROOT_TITLE_CAPSULE_WIDTH, height: NAVIGATION_CONTROL_HEIGHT }}
          animation={{ animation: Animation.smooth({ duration: 0.22 }), value: collapsed }}>
          <VStack opacity={collapsed ? 1 : 0} allowsHitTesting={false}>
            <Rectangle fill="clear"
              frame={{ width: ROOT_TITLE_CAPSULE_WIDTH, height: NAVIGATION_CONTROL_HEIGHT }}
              {...tabCapsuleSurface()} />
          </VStack>
          <Text font="largeTitle" fontWeight={collapsed ? "semibold" : "bold"} foregroundStyle="label"
            lineLimit={1} minScaleFactor={0.7} frame={{ width: ROOT_TITLE_CAPSULE_WIDTH, alignment: "leading" }}
            scaleEffect={collapsed ? 0.5 : 1}>{title}</Text>
        </ZStack>
        <Spacer />
        <Button title="关闭" systemImage="xmark" labelStyle="iconOnly" buttonStyle="plain" action={close}
          font={17} fontWeight="semibold" foregroundStyle="label"
          frame={{ width: NAVIGATION_CONTROL_HEIGHT, height: NAVIGATION_CONTROL_HEIGHT }}
          background={glass ? undefined : { style: "secondarySystemGroupedBackground", shape: "circle" }}
          glassEffect={glass ? "circle" : undefined} contentShape="circle" />
      </HStack>
    </VStack>
  );
}
