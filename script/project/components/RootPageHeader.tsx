import { HStack, List, Rectangle, Section, Spacer, Text, VStack, ZStack, type ListProps, type VirtualNode } from "scripting";
import { ROOT_PAGE_BG, RoundButton, TAB_FAB_PADDING } from "./TabFloatingActionButton";

export const ROOT_PAGE_MARGIN = 20;

export function BigTitle({ title, bottomPadding = 12 }: {
  title: string;
  bottomPadding?: number;
}) {
  return (
    <HStack frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top: 8, bottom: bottomPadding, trailing: 52 }}>
      <Text font={34} fontWeight="bold" foregroundStyle="label" lineLimit={1}>
        {title}
      </Text>
      <Spacer />
    </HStack>
  );
}

export function RootTabList({
  title,
  subtitle,
  onClose,
  topAccessory,
  titleAction,
  refresh,
  emptyState,
  bottomInset,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  topAccessory?: VirtualNode | null;
  titleAction?: VirtualNode;
  refresh?: () => Promise<void>;
  emptyState?: VirtualNode;
  bottomInset?: number;
  children?: ListProps["children"];
}) {
  const header = (
    <Section
      key="root-heading"
      listSectionMargins={0}
      listSectionSeparator="hidden"
      animation={{ animation: Animation.easeOut(0.18), value: true }}
    >
      <VStack
        alignment="leading"
        spacing={0}
        frame={{ maxWidth: "infinity", alignment: "leading" }}
        padding={{ top: 4, bottom: subtitle || topAccessory ? 8 : 0 }}
        listRowInsets={{ top: 0, bottom: 0, leading: ROOT_PAGE_MARGIN, trailing: ROOT_PAGE_MARGIN }}
        listRowBackground={<Rectangle fill="clear" />}
        listRowSeparator="hidden"
      >
        <BigTitle title={title} bottomPadding={subtitle ? 4 : topAccessory ? 8 : 12} />
        {subtitle ? (
          <Text font={15} foregroundStyle="secondaryLabel">
            {subtitle}
          </Text>
        ) : null}
        {topAccessory}
      </VStack>
    </Section>
  );

  return (
    <ZStack alignment="top" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background={ROOT_PAGE_BG} ignoresSafeArea />
      <List
        listStyle="insetGroup"
        navigationTitle=""
        navigationBarTitleDisplayMode="inline"
        toolbarVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}
        scrollContentBackground="hidden"
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        refreshable={refresh}
        contentMargins={bottomInset === undefined
          ? { edges: "top", insets: 0, placement: "scrollContent" }
          : { edges: "vertical", insets: { top: 0, bottom: bottomInset, leading: 0, trailing: 0 }, placement: "scrollContent" }}
        overlay={emptyState ? { alignment: "center", content: emptyState } : undefined}
      >
        {[header, ...[children].flat()]}
      </List>
      <VStack
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topTrailing" }}
        padding={{ trailing: ROOT_PAGE_MARGIN, top: 4 }}
      >
        <RoundButton icon="xmark" iconSize={17} accessibilityLabel="关闭" onTap={onClose} />
      </VStack>
      {titleAction ? (
        <VStack
          frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottomTrailing" }}
          padding={TAB_FAB_PADDING}
        >
          {titleAction}
        </VStack>
      ) : null}
    </ZStack>
  );
}
