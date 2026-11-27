import { Text } from "scripting";
import type { StatusSemantic } from "../models";
import { statusBadgeFillTint, statusTextTint } from "../services/status";

// Rendered only for sender rows: the call site leaves it out, because a component may not return null.
export function SenderBadge(props: { semantic: StatusSemantic; label: string }) {
  // Owner 2026-11-27 (修改 29): capsule base colour at 12% (light) / 22% (dark) under the shared text pair.
  return (
    <Text
      font={11}
      fontWeight="bold"
      foregroundStyle={statusTextTint(props.semantic, { label: props.label })}
      lineLimit={1}
      padding={{ horizontal: 6, vertical: 2 }}
      background={statusBadgeFillTint(props.semantic, { label: props.label })}
      clipShape={{ type: "rect", cornerRadius: 6, style: "continuous" }}
    >
      寄
    </Text>
  );
}
