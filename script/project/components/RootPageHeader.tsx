import { HStack, List, Spacer, Text, VStack, ZStack, type ListProps, type VirtualNode } from "scripting";
import { ROOT_PAGE_BG, RoundButton, TAB_FAB_PADDING } from "./TabFloatingActionButton";

export const ROOT_PAGE_MARGIN = 20;

export function BigTitle({ title, onClose, bottomPadding = 0 }: {
  title: string;
  onClose?: () => void;
  bottomPadding?: number;
}) {
  return (
    <HStack
      alignment="center"
      spacing={12}
      frame={{ maxWidth: "infinity", minHeight: 42, alignment: "leading" }}
      padding={{ top: 0, bottom: bottomPadding }}
    >
      <Text font={34} fontWeight="bold" foregroundStyle="label" lineLimit={1}>
        {title}
      </Text>
      <Spacer />
      {onClose ? (
        <RoundButton icon="xmark" iconSize={17} accessibilityLabel="关闭" onTap={onClose} />
      ) : null}
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
  return (
    <ZStack alignment="top" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background={ROOT_PAGE_BG} ignoresSafeArea />
      <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <VStack
          alignment="leading"
          spacing={0}
          frame={{ maxWidth: "infinity", alignment: "leading" }}
          padding={{
            top: 4,
            bottom: subtitle || topAccessory ? 12 : 8,
            leading: ROOT_PAGE_MARGIN,
            trailing: ROOT_PAGE_MARGIN,
          }}
          background={ROOT_PAGE_BG}
          animation={topAccessory === undefined ? undefined : { animation: Animation.easeOut(0.18), value: topAccessory !== null }}
        >
          <BigTitle title={title} onClose={onClose} bottomPadding={subtitle ? 4 : 0} />
          {subtitle ? (
            <Text font={15} foregroundStyle="secondaryLabel">
              {subtitle}
            </Text>
          ) : null}
          {topAccessory}
        </VStack>
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
          {children}
        </List>
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
