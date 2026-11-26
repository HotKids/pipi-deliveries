import { Text } from "scripting";

// The small gray 寄 tag of an outgoing parcel on the widgets (owner 2026-11-20): white 寄 on gray
// #9A9AA0 with 3-point corners, never pushed out. The 2×2 puts it after the status word at the
// carrier line's size; the 4×2 puts it after the waybill tail at its status capsule's size and height.
// Rendered only for sender rows: the call site leaves it out, because a component may not return null.
export function WidgetSenderTag(props: { font: number; verticalPadding: number }) {
  return (
    <Text
      font={props.font}
      fontWeight="medium"
      foregroundStyle="white"
      padding={{ horizontal: 3, vertical: props.verticalPadding }}
      background="rgba(154, 154, 160, 1)"
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
