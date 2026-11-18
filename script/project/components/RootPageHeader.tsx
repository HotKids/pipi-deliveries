import { Button, Rectangle, Text, VStack } from "scripting";

export const ROOT_PAGE_MARGIN = 20;
const CLOSE_SIZE = 44;

export function RootPageTitle({ title }: { title: string }) {
  return (
    <Text font="largeTitle" fontWeight="bold" foregroundStyle="label"
      frame={{ maxWidth: "infinity", minHeight: CLOSE_SIZE, alignment: "leading" }}
      listRowInsets={{ top: 12, leading: ROOT_PAGE_MARGIN, bottom: 16, trailing: ROOT_PAGE_MARGIN + CLOSE_SIZE }}
      listRowBackground={<Rectangle fill="clear" />} listRowSeparator="hidden">
      {title}
    </Text>
  );
}

export function RootPageCloseButton({ action }: { action: () => void }) {
  const glass = Number.parseInt(Device.systemVersion, 10) >= 26;
  return (
    <VStack padding={{ top: 4, trailing: ROOT_PAGE_MARGIN }}>
      <Button title="关闭" systemImage="xmark"
        labelStyle="iconOnly" buttonStyle="plain" action={action} font={17} fontWeight="semibold"
        foregroundStyle="label" frame={{ width: CLOSE_SIZE, height: CLOSE_SIZE }}
        background={glass ? undefined : { style: "secondarySystemGroupedBackground", shape: "circle" }}
        glassEffect={glass ? "circle" : undefined} contentShape="circle" />
    </VStack>
  );
}
