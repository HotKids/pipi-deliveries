import { Button, Rectangle, Text, Toolbar, ToolbarItem } from "scripting";
import { tabCapsuleSurface } from "./TabFloatingActionButton";

const NAVIGATION_CONTROL_HEIGHT = 44;
export const ROOT_TITLE_CAPSULE_WIDTH = 68;

export function ScrollingRootTitle({ title, onCollapsed }: {
  title: string;
  onCollapsed: (collapsed: boolean) => void;
}) {
  const observeTitleVisibility = {
    onScrollVisibilityChange: { threshold: 0.5, onChanged: (visible: boolean) => onCollapsed(!visible) },
  };
  return (
    <Text font="largeTitle" fontWeight="bold" foregroundStyle="label" {...observeTitleVisibility}
      frame={{ maxWidth: "infinity", minHeight: 44, alignment: "leading" }} listRowSeparator="hidden"
      listRowInsets={{ top: 8, bottom: 16, leading: 20, trailing: 20 }}
      listRowBackground={<Rectangle fill="clear" />}>{title}</Text>
  );
}

export function rootPageNavigation(
  title: string,
  action: () => void,
  collapsed: boolean,
  background: "systemBackground" | "systemGroupedBackground" = "systemGroupedBackground",
) {
  const glass = Number.parseInt(Device.systemVersion, 10) >= 26;
  return {
    navigationTitle: collapsed ? title : "",
    navigationBarTitleDisplayMode: "inline" as const,
    scrollEdgeEffectHidden: "top" as const,
    toolbarBackground: { style: background, bars: ["navigationBar" as const] },
    toolbarBackgroundVisibility: {
      visibility: collapsed ? "hidden" as const : "visible" as const,
      bars: ["navigationBar" as const],
    },
    toolbar: (
      <Toolbar>
        {collapsed ? <ToolbarItem placement="title" sharedBackgroundVisibility="hidden">
          <Text font="headline" foregroundStyle="label" lineLimit={1} minScaleFactor={0.8}
            padding={{ horizontal: 12 }} frame={{ width: ROOT_TITLE_CAPSULE_WIDTH, height: NAVIGATION_CONTROL_HEIGHT }}
            {...tabCapsuleSurface()}>{title}</Text>
        </ToolbarItem> : null}
        <ToolbarItem placement="topBarTrailing" sharedBackgroundVisibility="hidden">
          <Button title="关闭" systemImage="xmark"
            labelStyle="iconOnly" buttonStyle="plain" action={action} font={17} fontWeight="semibold"
            foregroundStyle="label" frame={{ width: NAVIGATION_CONTROL_HEIGHT, height: NAVIGATION_CONTROL_HEIGHT }}
            background={glass ? undefined : { style: "secondarySystemGroupedBackground", shape: "circle" }}
            glassEffect={glass ? "circle" : undefined} contentShape="circle" />
        </ToolbarItem>
      </Toolbar>
    ),
  };
}
