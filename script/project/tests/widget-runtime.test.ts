import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bestEffortWidgetRefresh,
  safelyLoadWidgetSnapshot,
  shouldRunWidgetNetworkRefresh,
  WIDGET_REFRESH_BUDGET_MS,
  WIDGET_RECENT_STATE_MS,
  WIDGET_RELOAD_AFTER_MS,
  widgetReloadPolicy,
  widgetPresentationKind,
} from "../widget/runtime";
import {
  FULL_REFRESH_FINALIZATION_RESERVE_MS,
  fullRefreshHostPolicy,
} from "../services/refresh-mode";
import {
  ACCOUNT_FOLLOWUP_RESERVE_MS,
  ACCOUNT_LIST_BUDGET_MS,
  accountChildDeadline,
} from "../services/account-sync-policy";

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

assert.equal(WIDGET_REFRESH_BUDGET_MS, 120_000);
assert.equal(WIDGET_RECENT_STATE_MS, 60_000);
assert.equal(WIDGET_RELOAD_AFTER_MS, 15 * 60 * 1_000);
assert.equal(widgetReloadPolicy(1_000).policy, "after");
assert.equal(widgetReloadPolicy(1_000).date.getTime(), 1_000 + 15 * 60 * 1_000);
assert.equal(await bestEffortWidgetRefresh(async () => {}), "completed");
assert.equal(
  await bestEffortWidgetRefresh(async () => {
    throw new Error("offline");
  }),
  "failed",
);
assert.equal(
  await bestEffortWidgetRefresh(() => new Promise(() => {}), 1),
  "timed_out",
);
assert.equal(shouldRunWidgetNetworkRefresh(0, 1_000_000), true);
assert.equal(shouldRunWidgetNetworkRefresh(Number.NaN, 1_000_000), true);
assert.equal(shouldRunWidgetNetworkRefresh(999_999, 1_000_000), false);
assert.equal(
  shouldRunWidgetNetworkRefresh(1_000_000 - WIDGET_RECENT_STATE_MS, 1_000_000),
  true,
);
const widgetHostPolicy = fullRefreshHostPolicy({
  accountOrderProjection: true,
  backgroundHostSafe: true,
});
assert.deepEqual(widgetHostPolicy, {
  accountOrderProjection: false,
  webViewEnrichment: false,
  accountFollowupReserveMs: 0,
  accountFollowups: true,
  manualAndPending: true,
});
assert.deepEqual(
  fullRefreshHostPolicy({
    accountOrderProjection: true,
    backgroundHostSafe: false,
  }),
  {
    accountOrderProjection: true,
    webViewEnrichment: true,
    accountFollowupReserveMs: ACCOUNT_FOLLOWUP_RESERVE_MS,
    accountFollowups: true,
    manualAndPending: true,
  },
);

const widgetRefreshStartedAt = 1_000_000;
const widgetAccountParentDeadline = widgetRefreshStartedAt +
  WIDGET_REFRESH_BUDGET_MS - FULL_REFRESH_FINALIZATION_RESERVE_MS;
const widgetAccountListDeadline = accountChildDeadline(
  widgetAccountParentDeadline,
  ACCOUNT_LIST_BUDGET_MS,
  widgetHostPolicy.accountFollowupReserveMs,
  widgetRefreshStartedAt,
);
assert.equal(
  widgetAccountListDeadline - widgetRefreshStartedAt,
  ACCOUNT_LIST_BUDGET_MS,
);
assert.ok(widgetAccountListDeadline > widgetRefreshStartedAt);

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const widgetSource = await readFile(resolve(projectDir, "widget.tsx"), "utf8");
const indexSource = await readFile(resolve(projectDir, "index.tsx"), "utf8");
const syncSource = await readFile(
  resolve(projectDir, "services/sync.ts"),
  "utf8",
);
assert.match(
  widgetSource,
  /shouldRunWidgetNetworkRefresh\(\s*lastNetworkRefreshSuccessAtMs\(\),?\s*\)[\s\S]*?if \(shouldRefresh\)[\s\S]*?await bestEffortWidgetRefresh[\s\S]*?budgetMs: WIDGET_REFRESH_BUDGET_MS[\s\S]*?accountOrderProjection: true[\s\S]*?backgroundHostSafe: true[\s\S]*?Widget\.present\(widgetContent\(\)/,
  "widget freshness must be based on successful network work rather than unrelated local state writes",
);
assert.doesNotMatch(widgetSource, /BackgroundKeeper/);

const runFullRefreshSource = syncSource.match(
  /async function runFullRefresh\([\s\S]*?\n}\n\nexport function refreshAllShipments/,
)?.[0] || "";
const synchronizeAccountListSource = syncSource.match(
  /async function synchronizeAccountList\([\s\S]*?\n}\n\nasync function projectAccountOrders/,
)?.[0] || "";
const bindPhoneSource = syncSource.match(
  /export async function bindPhone\([\s\S]*?\n}\n\nexport async function bindPhoneAndSync/,
)?.[0] || "";
assert.match(
  runFullRefreshSource,
  /synchronizeAccountList\([\s\S]*?hostPolicy\.accountFollowupReserveMs/,
);
assert.match(runFullRefreshSource, /hostPolicy\.accountOrderProjection/);
assert.match(runFullRefreshSource, /hostPolicy\.accountFollowups/);
assert.match(runFullRefreshSource, /hostPolicy\.manualAndPending/);
assert.doesNotMatch(
  runFullRefreshSource,
  /requestWidgetReload\(\)/,
  "persisting a checkpoint must not launch a competing widget runtime",
);
assert.doesNotMatch(
  indexSource,
  /requestWidgetReload\(\)/,
  "opening the app must not launch a widget refresh beside the foreground refresh",
);
assert.match(
  syncSource,
  /!options\.backgroundHostSafe[\s\S]*?statePresentationFingerprint\(summary\.state\) !==[\s\S]*?statePresentationFingerprint\(before\)[\s\S]*?requestWidgetReload\(\)/,
  "a foreground full refresh reloads widgets only after visible shipment state changes",
);
assert.doesNotMatch(
  bindPhoneSource,
  /requestWidgetReload\(\)/,
  "persisting a binding must not launch a widget beside its immediate full refresh",
);
assert.equal(
  (synchronizeAccountListSource.match(
    /budgetMs: stageBudgetMs\(listDeadlineAtMs, startedAt\)/g,
  ) || []).length,
  2,
);

console.log("widget runtime family dispatch tests passed");
