import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../services/sync.ts", import.meta.url),
  "utf8",
);

const runFullRefresh = source.match(
  /async function runFullRefresh\([\s\S]*?\n}\n\nexport function refreshAllShipments/,
)?.[0] || "";

assert.ok(runFullRefresh, "the full refresh implementation must remain discoverable");
assert.match(
  runFullRefresh,
  /let notificationState = initial;/,
  "notifications must start from the initial persisted snapshot",
);
assert.ok(
  (runFullRefresh.match(/notificationState = next;/g) || []).length >= 2,
  "every state checkpoint path must advance the notification snapshot",
);
assert.match(
  runFullRefresh,
  /finally\s*{[\s\S]*?if \(lease\.isCurrent\(\)\)[\s\S]*?await notifyShipmentChanges\([\s\S]*?notificationState\.shipments[\s\S]*?lease\.isCurrent/,
  "only the current generation may notify from its last committed checkpoint",
);

console.log("refresh notification checkpoint contract tests passed");
