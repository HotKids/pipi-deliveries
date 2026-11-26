import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import { refreshSummaryToast, withWatchPullOutcome } from "../services/ui-feedback";

// G-HIGH-10 (2026-11-20 review): the Home list pull waits for its international Watch page read and counts it in the
// toast, so 当前已是最新 is not shown before the Watch rows were read.
function sourceFunction(path: string, begin: string, end: string, scope: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const start = source.indexOf(begin);
  assert.ok(start >= 0, begin);
  const code = stripTypeScriptTypes(source.slice(start, source.indexOf(end, start)));
  const name = /function (\w+)/.exec(begin)![1];
  return Function(...Object.keys(scope), `${code}\nreturn ${name};`)(...Object.values(scope));
}

const idle = { attempted: 0, succeeded: 0, failed: 0 };
const done = { attempted: 2, succeeded: 2, failed: 0 };
assert.equal(refreshSummaryToast(withWatchPullOutcome(idle, "refreshed")), EXPRESS_TOAST_COPY.refreshDone);
assert.equal(refreshSummaryToast(withWatchPullOutcome(idle, "unchanged")), EXPRESS_TOAST_COPY.refreshUpToDate);
assert.equal(refreshSummaryToast(withWatchPullOutcome(idle, "skipped")), EXPRESS_TOAST_COPY.refreshUpToDate);
assert.equal(refreshSummaryToast(withWatchPullOutcome(idle, undefined)), EXPRESS_TOAST_COPY.refreshUpToDate);
assert.equal(refreshSummaryToast(withWatchPullOutcome(idle, "failed")), EXPRESS_TOAST_COPY.refreshFailed);
assert.equal(refreshSummaryToast(withWatchPullOutcome(done, "failed")), EXPRESS_TOAST_COPY.listUpdated);
assert.equal(refreshSummaryToast(withWatchPullOutcome(done, "unchanged")), EXPRESS_TOAST_COPY.refreshDone);
assert.equal(refreshSummaryToast(withWatchPullOutcome({ ...idle, continuing: true }, "refreshed")),
  EXPRESS_TOAST_COPY.refreshContinuing, "E1 keeps its own answer");

// HomePage: the toast follows the Watch read.
for (const [outcome, expected] of [["refreshed", EXPRESS_TOAST_COPY.refreshDone],
  ["unchanged", EXPRESS_TOAST_COPY.refreshUpToDate], ["failed", EXPRESS_TOAST_COPY.refreshFailed]] as const) {
  const events: string[] = [];
  let release!: () => void;
  const watch = new Promise<void>(resolve => { release = resolve; });
  const runListPull = sourceFunction("../pages/HomePage.tsx", "async function runListPull()", "const currentPull", {
    setNotice: (value: string) => { if (value) events.push(`notice:${value}`); },
    refreshAllShipmentsForPull: async () => ({ summary: idle, completion: Promise.resolve(idle) }),
    applyInteractiveRefreshSummary: () => events.push("applied"),
    props: { onListPull: () => { events.push("pull"); return watch.then(() => outcome); } },
    refreshSummaryToast, withWatchPullOutcome, followPullCompletion: () => {}, EXPRESS_TOAST_COPY,
  });
  const running = runListPull();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(events, ["applied", "pull"], `${outcome}: no toast before the Watch read ends`);
  release();
  await running;
  assert.deepEqual(events, ["applied", "pull", `notice:${expected}`], outcome);
}

// index.tsx: the app's Watch owner reports what its read did.
for (const [result, scope, expected] of [[{ revision: 9 }, "scope", "refreshed"], [{ revision: 3 }, "scope", "unchanged"],
  [undefined, "scope", "failed"], [undefined, "", "skipped"]] as const) {
  const applied: unknown[] = [];
  const refreshInternational = sourceFunction("../index.tsx", "function refreshInternational(force = false)", "function reloadMeals()", {
    internationalRequest: { current: { generation: 0, startedAt: 0 } }, revision: { current: 5 },
    changedSinceLastLogged: () => false, writeDiagnostic: () => {}, diagnosticErrorDetails: () => ({}),
    activeWatchScope: () => scope,
    refreshStoredWatchShipments: async () => result,
    applyState: (state: unknown) => applied.push(state),
  });
  assert.equal(await refreshInternational(true), expected, expected);
  assert.equal(applied.length, expected === "refreshed" ? 1 : 0);
}
const index = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
assert.match(index, /onListPull=\{\(\) => \{ refreshPlatformList\("pull"\); return startCloudRecords\("list_pull"\)\.international; \}\}/,
  "the list pull hands its Watch read back to the page");
console.log("list pulls wait for and count the international Watch read");
