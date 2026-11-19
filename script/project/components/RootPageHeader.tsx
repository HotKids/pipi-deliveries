import { Button, List, Rectangle, Section, Text, VStack, ZStack, useState, type ListProps, type VirtualNode } from "scripting";

export const ROOT_PAGE_MARGIN = 20;
const CLOSE_SIZE = 44;
const HEADER_TOP_INSET = 4;

function RootPageTitle({ title, onVisibilityChange }: { title: string; onVisibilityChange?: (visible: boolean) => void }) {
  return (
    <Text font="largeTitle" fontWeight="bold" foregroundStyle="label"
      frame={{ maxWidth: "infinity", minHeight: CLOSE_SIZE, alignment: "leading" }}
      listRowInsets={{ top: HEADER_TOP_INSET, leading: ROOT_PAGE_MARGIN, bottom: 16, trailing: ROOT_PAGE_MARGIN + CLOSE_SIZE }}
      onScrollVisibilityChange={onVisibilityChange ? { onChanged: onVisibilityChange } : undefined}
      listRowBackground={<Rectangle fill="clear" />} listRowSeparator="hidden">
      {title}
    </Text>
  );
}

function RootPageCloseButton({ action }: { action: () => void }) {
  const glass = Number.parseInt(Device.systemVersion, 10) >= 26;
  return (
    <VStack padding={{ top: HEADER_TOP_INSET, trailing: ROOT_PAGE_MARGIN }}>
      <Button title="关闭" systemImage="xmark"
        labelStyle="iconOnly" buttonStyle="plain" action={action} font={17} fontWeight="semibold"
        foregroundStyle="label" frame={{ width: CLOSE_SIZE, height: CLOSE_SIZE }}
        background={glass ? undefined : { style: "secondarySystemGroupedBackground", shape: "circle" }}
        glassEffect={glass ? "circle" : undefined} contentShape="circle" />
    </VStack>
  );
}

export function RootTabList({ title, onClose, topAccessory, titleAction, refresh, emptyState, bottomInset, children }: {
  title: string;
  onClose: () => void;
  topAccessory?: VirtualNode | null;
  titleAction?: VirtualNode;
  refresh?: () => Promise<void>;
  emptyState?: VirtualNode;
  bottomInset?: number;
  children?: ListProps["children"];
}) {
  const [titleVisible, setTitleVisible] = useState(true);
  const trackVisibility = titleAction && Number.parseInt(Device.systemVersion, 10) >= 18;
  const header = (
    <Section key="root-heading" listSectionMargins={0} listSectionSeparator="hidden"
      animation={topAccessory === undefined ? undefined : { animation: Animation.easeOut(0.18), value: topAccessory !== null }}>
      <RootPageTitle title={title} onVisibilityChange={trackVisibility ? setTitleVisible : undefined} />
      {topAccessory}
    </Section>
  );
  return (
    <ZStack alignment="topTrailing" overlay={titleAction ? {
      alignment: "bottomTrailing",
      content: <VStack opacity={titleVisible ? 1 : 0} allowsHitTesting={titleVisible} accessibilityHidden={!titleVisible}
        animation={{ animation: Animation.easeOut(0.18), value: titleVisible }}>
        {titleAction}
      </VStack>,
    } : undefined}>
      <List listStyle="insetGroup" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        refreshable={refresh}
        contentMargins={bottomInset === undefined
          ? { edges: "top", insets: 0, placement: "scrollContent" }
          : { edges: "vertical", insets: { top: 0, bottom: bottomInset, leading: 0, trailing: 0 }, placement: "scrollContent" }}
        overlay={emptyState ? { alignment: "center", content: emptyState } : undefined}>
        {[header, ...[children].flat()]}
      </List>
      <RootPageCloseButton action={onClose} />
    </ZStack>
  );
}
