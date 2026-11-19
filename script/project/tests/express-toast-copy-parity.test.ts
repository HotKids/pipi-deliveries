import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";

function javaToastTable(path: string) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  return new Map<string, string>(Array.from(
    source.matchAll(/static final String ([A-Z0-9_]+) = "((?:[^"\\]|\\.)*)";/g),
    match => [match[1], JSON.parse(`"${match[2]}"`)],
  ));
}

const liteTable = javaToastTable("../../../app/src/main/java/me/pipi/deliveries/feature/express/ExpressToastCopy.java");
const pipiTable = javaToastTable("../../../../flutter_app/android/app/src/main/java/me/pipi/assistant/express/ExpressToastCopy.java");
const snake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
const iosTable = new Map(Object.entries(EXPRESS_TOAST_COPY).map(([key, value]) => [snake(key), value]));

// The pickup and handoff actions in the express parity contract are shared by Pipi and iOS.
for (const [iosKey, pipiKey] of Object.entries({
  PICKUP_CODE_COPIED: "PICKUP_CODE_COPIED",
  HANDOFF_CODE_COPIED: "HANDOFF_CODE_COPIED",
  HANDOFF_COMPLETED: "HANDOFF_COMPLETED",
  HANDOFF_EXPIRED: "HANDOFF_EXPIRED",
  PICKUP_RECORD_ACTION_FAILED: "HANDOFF_FAILED",
})) {
  assert.ok(iosTable.has(iosKey), iosKey);
  assert.equal(iosTable.get(iosKey), pipiTable.get(pipiKey), iosKey);
  iosTable.delete(iosKey);
}

assert.ok(iosTable.size >= 31);
assert.deepEqual([...liteTable.keys()].sort(), [...iosTable.keys()].sort(), "the shared iOS and Lite rows");
for (const [key, value] of iosTable) assert.equal(liteTable.get(key), value, key);

console.log("express toast copy parity tests passed");
