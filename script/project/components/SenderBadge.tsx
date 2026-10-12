import { Text } from "scripting";
import type { StatusSemantic } from "../models";
import { statusTint } from "../services/status";

// Rendered only for sender rows: the call site leaves it out, because a component may not return null.
export function SenderBadge(props: { semantic: StatusSemantic }) {
  const color = statusTint(props.semantic);
  return (
    <Text
      font={11}
      fontWeight="bold"
      foregroundStyle={color}
      lineLimit={1}
      padding={{ horizontal: 6, vertical: 2 }}
      background={{ color, opacity: 0.1 }}
      clipShape={{ type: "rect", cornerRadius: 6 }}
    >
      寄
    </Text>
  );
}
