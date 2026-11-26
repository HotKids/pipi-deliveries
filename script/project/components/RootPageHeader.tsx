import { Button, List, Section, VStack, ZStack, useState, type ListProps, type ScrollPhase, type VirtualNode } from "scripting";

export const ROOT_PAGE_MARGIN = 20;

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
      overlay={titleAction ? {
        alignment: "bottomTrailing",
        content: (
          <VStack animation={{ animation: Animation.easeOut(0.18), value: fabVisible }}>
            {fabVisible ? (
              <VStack glassEffectTransition={supportsGlassTransition ? "materialize" : undefined}>
                {titleAction}
              </VStack>
            ) : null}
          </VStack>
        ),
      } : undefined}
    >
      <List
        listStyle="insetGroup"
        navigationTitle={title}
        navigationBarTitleDisplayMode="large"
        toolbar={{
          topBarTrailing: (
            <Button title="关闭" systemImage="xmark" labelStyle="iconOnly" action={onClose} />
          ),
        }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        refreshable={refresh}
        onScrollPhaseChange={supportsScrollPhase ? onScrollPhaseChange : undefined}
        contentMargins={bottomInset === undefined
          ? undefined
          : { edges: "bottom", insets: bottomInset, placement: "scrollContent" }}
        overlay={emptyState ? { alignment: "center", content: emptyState } : undefined}
      >
        {header ? [header, ...[children].flat()] : children}
      </List>
    </ZStack>
  );
}
