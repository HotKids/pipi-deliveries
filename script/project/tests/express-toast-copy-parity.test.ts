import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";

// Audit R11 (adopted 2026-09-25): the express toast table is byte-identical on iOS and Lite (AGENTS §11),
// and nothing compared the two automatically. Lite's constants are UPPER_SNAKE forms of the iOS keys.
const lite = readFileSync(new URL(
  "../../../app/src/main/java/me/pipi/deliveries/feature/express/ExpressToastCopy.java", import.meta.url), "utf8");
const liteTable = new Map<string, string>();
for (const match of lite.matchAll(/static final String ([A-Z0-9_]+) = "((?:[^"\\]|\\.)*)";/g)) {
  liteTable.set(match[1], JSON.parse(`"${match[2]}"`));
}
const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const iosTable = new Map(Object.entries(EXPRESS_TOAST_COPY).map(([key, value]) => [snake(key), value]));
assert.ok(iosTable.size >= 31);
assert.deepEqual([...liteTable.keys()].sort(), [...iosTable.keys()].sort(), "the same rows on both clients");
for (const [key, value] of iosTable) assert.equal(liteTable.get(key), value, key);

console.log("express toast copy parity tests passed");
