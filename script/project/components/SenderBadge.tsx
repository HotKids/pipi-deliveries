import { Text } from "scripting";
import type { StatusSemantic } from "../models";
import { statusTextAccent, statusTextTint } from "../services/status";

// Rendered only for sender rows: the call site leaves it out, because a component may not return null.
export function SenderBadge(props: { semantic: StatusSemantic; label: string }) {
  const rgb = statusTextAccent(props.semantic, props.label);
  const color = `rgba(${rgb >> 16 & 255}, ${rgb >> 8 & 255}, ${rgb & 255}, 0.1)` as const;
  return (
    <Text
      font={11}
      fontWeight="bold"
      foregroundStyle={statusTextTint(props.semantic, { badgeOpacity: 0.1, label: props.label })}
      lineLimit={1}
      padding={{ horizontal: 6, vertical: 2 }}
      background={color}
      clipShape={{ type: "rect", cornerRadius: 6 }}
    >
      寄
    </Text>
  );
}
