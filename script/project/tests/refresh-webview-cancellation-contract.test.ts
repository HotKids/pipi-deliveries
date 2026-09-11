import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../services/sync.ts", import.meta.url),
  "utf8",
);

const cancellationHelper = source.match(
  /function rethrowRefreshCancellation\([\s\S]*?\n}/,
)?.[0] || "";
assert.match(
  cancellationHelper,
  /assertRefreshSignal\(signal\)/,
  "parent signal cancellation must escape before stage diagnostics",
);
assert.doesNotMatch(
  cancellationHelper,
  /error instanceof OperationTimeoutError/,
  "a child-stage timeout must remain recoverable so later H5 fallback can run",
);

const accountList = source.match(
  /async function synchronizeAccountList\([\s\S]*?\n}\n\ntype ManualRefreshTask/,
)?.[0] || "";
assert.match(
  accountList,
  /fetched = await fetchAccountParcels\([\s\S]*?signal,[\s\S]*?assertRefreshSignal\(signal\)/,
  "account-list success must re-check the parent generation before diagnostics or state work",
);
assert.match(
  accountList,
  /catch \(error\)\s*{\s*rethrowRefreshCancellation\(error, signal\);[\s\S]*?"account\.sync\.failed"/,
  "account-list cancellation must escape before its stage-failure diagnostic",
);

const detail = source.match(
  /async function runShipmentRefreshById\([\s\S]*?\n}\n\nfunction runTargetedShipmentRefresh/,
)?.[0] || "";
assert.doesNotMatch(
  detail,
  /isCompletedUnprojectedAccountOrder|result: "order_completed"/,
  "order completion must not stop detail projection to the real waybill",
);
assert.match(
  detail,
  /const settledHistory = hasSettledTimelineHistory\(original\)[\s\S]*?!settledHistory/,
  "automatic detail refresh must reuse a complete terminal history",
);
assert.match(
  detail,
  /projectAccountOrderWithCarrier\([\s\S]*?signal,[\s\S]*?rethrowRefreshCancellation\(error, signal\)/,
  "detail order projection must be cancelled when its page disappears",
);
assert.match(
  detail,
  /refreshWebTimeline\([\s\S]*?signal/,
  "K100 detail work must receive the page cancellation signal",
);
assert.match(
  detail,
  /refreshCainiaoH5\([\s\S]*?signal/,
  "Cainiao H5 detail work must receive the page cancellation signal",
);
assert.match(
  detail,
  /queryManualForSource\(\{[\s\S]*?signal,[\s\S]*?rethrowRefreshCancellation\(error, signal\)/,
  "detail KDNiao fallback must receive the page cancellation signal",
);

const runFullRefresh = source.match(
  /async function runFullRefresh\([\s\S]*?\n}\n\nexport function refreshAllShipments/,
)?.[0] || "";
assert.doesNotMatch(runFullRefresh, /refreshMissingShipmentHistories|refreshAccountFollowups/,
  "list and background must not enter history work");
assert.match(
  runFullRefresh,
  /deadlineAtMs: number \| undefined/,
  "foreground refreshes must be able to run with per-stage deadlines only",
);

const refreshAll = source.slice(
  source.indexOf("export function refreshAllShipments"),
);
assert.doesNotMatch(
  refreshAll,
  /FULL_REFRESH_BUDGET_MS|Math\.min\([\s\S]*?60_000/,
  "foreground refresh must not restore a fixed whole-round 30/60 second cap",
);
assert.match(
  refreshAll,
  /deadlineAtMs == null \? \{\} : \{ operationDeadlineAtMs: deadlineAtMs \}/,
  "only callers with an explicit host budget may arm the coordinator deadline",
);

const online = source.slice(source.indexOf("async function refreshOnlineShipment"), source.indexOf("export type ManualShipmentPreview"));
assert.match(online, /beginManualRefreshAttempt[\s\S]*?outcome = await query/,
  "each Online job must durably own its attempt before dispatch");
assert.match(online, /assertRefreshSignal\(signal\)/);
assert.match(source, /active.size < MANUAL_REFRESH_CONCURRENCY/);
console.log("refresh WebView cancellation contract tests passed");
