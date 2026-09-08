import { Image, Link, Spacer, Text, VStack } from "scripting";

export function FallbackWidget(props: {
  title: string;
  detail: string;
  openURL?: string;
}) {
  const content = (
    <VStack
      spacing={8}
      padding={14}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      widgetBackground="systemBackground"
    >
      <Spacer />
      <Image
        systemName="shippingbox.fill"
        font={28}
        foregroundStyle="secondaryLabel"
      />
      <Text font={15} fontWeight="semibold" lineLimit={1}>
        {props.title}
      </Text>
      <Text
        font={12}
        foregroundStyle="secondaryLabel"
        lineLimit={2}
        multilineTextAlignment="center"
      >
        {props.detail}
      </Text>
      <Spacer />
    </VStack>
  );
  return props.openURL ? <Link url={props.openURL}>{content}</Link> : content;
}
