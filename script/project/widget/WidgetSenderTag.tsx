import { Text } from "scripting";
import { widgetSenderTagStyle } from "./palette";

// Neutral light-capsule 寄 tag on outgoing-parcel widgets (owner 2026-11-27): 12% (light) / 22% (dark)
// gray fill and gray ink matching the status capsule style, stepped down 1pt for optical balance.
// Rendered only for sender rows: the call site leaves it out, because a component may not return null.
export function WidgetSenderTag(props: {
  font: number;
  verticalPadding: number;
  brandAccent?: string;
}) {
  const style = widgetSenderTagStyle(props.brandAccent);
  return (
    <Text
      font={props.font}
      fontWeight="medium"
      foregroundStyle={style.foreground}
      padding={{ horizontal: 3.5, vertical: props.verticalPadding }}
      background={style.background}
      clipShape={{
        type: "rect",
        cornerRadius: 3,
        style: "continuous",
      }}
      lineLimit={1}
      fixedSize={{ horizontal: true, vertical: true }}
      layoutPriority={1}
    >
      寄
    </Text>
  );
}
