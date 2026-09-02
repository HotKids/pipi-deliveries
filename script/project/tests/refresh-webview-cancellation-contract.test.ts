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
  /async function synchronizeAccountList\([\s\S]*?\n}\n\nasync function projectAccountOrders/,
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

const projection = source.match(
  /async function projectAccountOrders\([\s\S]*?\n}\n\nasync function refreshAccountFollowups/,
)?.[0] || "";
assert.match(
  projection,
  /projectAccountOrderWithCarrier\([\s\S]*?signal,[\s\S]*?assertRefreshSignal\(signal\)/,
  "account-order projection must pass and re-check the parent signal",
);
assert.match(
  projection,
  /catch \(error\)\s*{\s*rethrowRefreshCancellation\(error, signal\);[\s\S]*?"order\.projection\.failed"/,
  "projection cancellation must escape before failure diagnostics and checkpointing",
);
assert.doesNotMatch(
  projection,
  /isCompletedUnprojectedAccountOrder|result: "order_completed"/,
  "order completion must not stop batch projection to the real waybill",
);
assert.match(
  projection,
  /let projectionRetained = false;[\s\S]*?accountParcelWithExistingProjection\([\s\S]*?projectionRetained = normalizeWaybill\([\s\S]*?if \(!projectionRetained\) \{[\s\S]*?recordProjectionFailure\(/,
  "an extracted projection that is not retained must enter retry cooldown instead of reporting success",
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
  /refreshKuaidi100H5\([\s\S]*?signal/,
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

const followups = source.match(
  /async function refreshAccountFollowups\([\s\S]*?\n}\n\nasync function refreshManualAndPending/,
)?.[0] || "";
assert.ok(
  (followups.match(/rethrowRefreshCancellation\([^,]+, signal\);/g) || []).length >= 1,
  "the Xiaomi detail gather must rethrow parent cancellation",
);
assert.doesNotMatch(
  followups,
  /refresh(?:JingDong|Cainiao)H5\(/,
  "homepage followups must not execute H5 timeline WebViews",
);
assert.match(
  followups,
  /async \(scheduled\)[\s\S]*?if \(deadlineExpired\(accountFollowupDeadlineAtMs\)\)[\s\S]*?outcome: "deadline_exhausted"/,
  "a queued detail that reaches the deadline must be classified before it starts",
);
assert.match(
  followups,
  /if \(detailAttempt\.outcome === "deadline_exhausted"\)[\s\S]*?"refresh\.stage\.skipped"[\s\S]*?continue;\s*}\s*attempted\+\+/,
  "an unstarted detail must not count as attempted or failed",
);
const runFullRefresh = source.match(
  /async function runFullRefresh\([\s\S]*?\n}\n\nexport function refreshAllShipments/,
)?.[0] || "";
assert.match(
  runFullRefresh,
  /const projection = await projectAccountOrders\([\s\S]*?hostPolicy\.accountOrderProjection,\s*lease\.signal,/,
  "the full-refresh lease signal must own account-order WebView projection",
);
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

const manualRefresh = source.match(
  /async function refreshManualAndPending\([\s\S]*?\n}\n\nexport type ManualShipmentPreview/,
)?.[0] || "";
assert.match(
  manualRefresh,
  /waveStart \+= MANUAL_REFRESH_CONCURRENCY[\s\S]*?"manual_refresh_attempt"[\s\S]*?runAccountFollowupCandidates\(\s*waveTasks/,
  "manual rows must be claimed immediately before their bounded query wave",
);
assert.equal(
  (manualRefresh.match(/"manual_refresh_attempt"/g) || []).length,
  1,
  "one wave must be persisted atomically instead of one write per row",
);

console.log("refresh WebView cancellation contract tests passed");
