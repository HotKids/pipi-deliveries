import { Button, HStack, Spacer, Text } from "scripting";

export function RootPageHeader({ title, action, background = "systemGroupedBackground" }: {
  title: string;
  action: () => void;
  background?: "systemBackground" | "systemGroupedBackground";
}) {
  const glass = Number.parseInt(Device.systemVersion, 10) >= 26;
  return (
    <HStack padding={{ top: 8, bottom: 16, horizontal: 20 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={background}>
      <Text font="largeTitle" fontWeight="bold" foregroundStyle="label">{title}</Text>
      <Spacer />
      <Button title="关闭" systemImage="xmark"
        labelStyle="iconOnly" buttonStyle="plain" action={action} font={17} fontWeight="semibold"
        foregroundStyle="label" frame={{ width: 44, height: 44 }}
        background={glass ? undefined : { style: "secondarySystemGroupedBackground", shape: "circle" }}
        glassEffect={glass ? "circle" : undefined} contentShape="circle" />
    </HStack>
  );
}
