import assert from "node:assert/strict";
import {
  safelyLoadWidgetSnapshot,
  widgetPresentationKind,
} from "../widget/runtime";

assert.equal(widgetPresentationKind("systemSmall"), "small");
assert.equal(widgetPresentationKind("systemMedium"), "medium");
for (const family of [
  "systemLarge",
  "systemExtraLarge",
  "accessoryCircular",
  "accessoryRectangular",
  "accessoryInline",
  "",
  "unknown",
]) {
  assert.equal(widgetPresentationKind(family), "unsupported");
}

assert.deepEqual(safelyLoadWidgetSnapshot(() => ({ rows: 1 })), {
  ok: true,
  value: { rows: 1 },
});
assert.deepEqual(
  safelyLoadWidgetSnapshot(() => {
    throw new Error("unreadable state");
  }),
  { ok: false },
);

console.log("widget runtime family dispatch tests passed");
