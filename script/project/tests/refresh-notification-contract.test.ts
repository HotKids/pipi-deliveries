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
  /await replayPendingShipmentNotifications\(lease\.isCurrent\)/,
  "a fresh runtime must drain committed notification obligations before account work",
);
assert.doesNotMatch(runFullRefresh, /notificationState|notifyShipmentChanges/,
  "notifications must not depend on volatile before/after snapshots");
assert.match(runFullRefresh,
  /finally\s*{[\s\S]*?if \(lease\.isCurrent\(\)\)[\s\S]*?await replayPendingShipmentNotifications\(lease\.isCurrent\)/,
  "only the current generation may drain notifications; skipped events remain durable");
console.log("refresh notification checkpoint contract tests passed");
