import { Button, HStack, List, Section, Text, VStack, ZStack, useState, type ListProps, type ScrollPhase, type VirtualNode } from "scripting";

export const ROOT_PAGE_MARGIN = 20;
const CLOSE_SIZE = 44;

function RootPageHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const glass = Number.parseInt(Device.systemVersion, 10) >= 26;
  return (
    <HStack
      alignment="center"
      spacing={12}
      padding={{ top: 4, bottom: 8, leading: ROOT_PAGE_MARGIN, trailing: ROOT_PAGE_MARGIN }}
      frame={{ maxWidth: "infinity" }}
      background="systemGroupedBackground"
    >
      <Text
        font="largeTitle"
        fontWeight="bold"
        foregroundStyle="label"
        lineLimit={1}
        frame={{ maxWidth: "infinity", minHeight: CLOSE_SIZE, alignment: "leading" }}
      >
        {title}
      </Text>
      <Button
        title="关闭"
        systemImage="xmark"
        labelStyle="iconOnly"
        buttonStyle="plain"
        action={onClose}
        font={17}
        fontWeight="semibold"
        foregroundStyle="label"
        frame={{ width: CLOSE_SIZE, height: CLOSE_SIZE }}
        background={glass ? undefined : { style: "secondarySystemGroupedBackground", shape: "circle" }}
        glassEffect={glass ? "circle" : undefined}
        contentShape="circle"
      />
    </HStack>
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
  const [fabVisible, setFabVisible] = useState(true);
  const supportsScrollPhase = Boolean(titleAction) && Number.parseInt(Device.systemVersion, 10) >= 18;
  const supportsGlassTransition = Number.parseInt(Device.systemVersion, 10) >= 26;
  const alignFabWithTabBar = supportsGlassTransition && (Number(Device.screen?.width) || 393) >= 390;
  const onScrollPhaseChange = (_oldPhase: ScrollPhase, newPhase: ScrollPhase) => {
    setFabVisible(newPhase === "idle");
  };
  const header = topAccessory != null ? (
    <Section key="root-heading" listSectionMargins={0} listSectionSeparator="hidden"
      animation={{ animation: Animation.easeOut(0.18), value: true }}>
      {topAccessory}
    </Section>
  ) : null;
  return (
    <ZStack
      alignment="bottomTrailing"
      navigationBarVisibility="hidden"
      background="systemGroupedBackground"
      overlay={titleAction ? {
        alignment: "bottomTrailing",
        content: (
          <VStack
            ignoresSafeArea={alignFabWithTabBar ? { regions: "container", edges: "bottom" } : undefined}
            animation={{ animation: Animation.easeOut(0.18), value: fabVisible }}
          >
            {fabVisible ? (
              <VStack glassEffectTransition={supportsGlassTransition ? "materialize" : undefined}>
                {titleAction}
              </VStack>
            ) : null}
          </VStack>
        ),
      } : undefined}
    >
      <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <RootPageHeader title={title} onClose={onClose} />
        <List
          listStyle="insetGroup"
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          refreshable={refresh}
          onScrollPhaseChange={supportsScrollPhase ? onScrollPhaseChange : undefined}
          contentMargins={bottomInset === undefined
            ? { edges: "top", insets: 0, placement: "scrollContent" }
            : { edges: "vertical", insets: { top: 0, bottom: bottomInset, leading: 0, trailing: 0 }, placement: "scrollContent" }}
          overlay={emptyState ? { alignment: "center", content: emptyState } : undefined}
        >
          {header ? [header, ...[children].flat()] : children}
        </List>
      </VStack>
    </ZStack>
  );
}
