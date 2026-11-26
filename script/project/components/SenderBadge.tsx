import { Text, type ShapeStyle } from "scripting";
import type { StatusSemantic } from "../models";
import { statusTextAccent, statusTextTint } from "../services/status";

// Rendered only for sender rows: the call site leaves it out, because a component may not return null.
export function SenderBadge(props: { semantic: StatusSemantic; label: string }) {
  const rgb = statusTextAccent(props.semantic, props.label);
  // The light text colour at 0x1A in both appearances, as on Lite and Pipi (owner 2026-11-20, 修改 11).
  const color = `rgba(${rgb >> 16 & 255}, ${rgb >> 8 & 255}, ${rgb & 255}, ${0x1a / 255})` as ShapeStyle;
  return (
    <Text
      font={11}
      fontWeight="bold"
      foregroundStyle={statusTextTint(props.semantic, { label: props.label })}
      lineLimit={1}
      padding={{ horizontal: 6, vertical: 2 }}
      background={color}
      clipShape={{ type: "rect", cornerRadius: 6, style: "continuous" }}
    >
      寄
    </Text>
  );
}
