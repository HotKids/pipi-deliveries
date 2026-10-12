import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AppState, RefreshSummary } from "../models";
import type { FullRefreshOutcome } from "../services/sync";
import { createForegroundRefresh, FOREGROUND_REFRESH_DEBOUNCE_MS } from "../services/foreground-return-refresh";

// Audit R4 / user default #11 (2026-09-25): all three clients refresh when the app returns to the
// foreground, with a shared debounce (2 minutes since the user decision of 2026-10-02, formerly 30 s).
// On iOS `Script.onResume` does not fire on an ordinary return, so the app root drives it from the
// scene phase.
assert.equal(FOREGROUND_REFRESH_DEBOUNCE_MS, 120_000);

function harness() {
  let clock = 1_000_000;
  const listeners: Array<(outcome: FullRefreshOutcome) => void> = [];
  const applied: AppState[] = [];
  let refreshes = 0;
  let release: (() => void) | null = null;
  const controller = createForegroundRefresh({
    now: () => clock,
    refresh: () => {
      refreshes++;
      return new Promise<RefreshSummary>((resolve) => {
        release = () => resolve({ state: { revision: refreshes } } as unknown as RefreshSummary);
      });
    },
    applyState: (state) => { applied.push(state); },
    subscribeRefreshOutcome: (listener) => { listeners.push(listener); return () => {}; },
  });
  return {
    controller, applied,
    refreshes: () => refreshes,
    advance: (ms: number) => { clock += ms; },
    finish: async () => { release?.(); release = null; await new Promise((r) => setImmediate(r)); },
    publish: (outcome: FullRefreshOutcome) => listeners.forEach((listener) => listener(outcome)),
  };
}

const back = (h: ReturnType<typeof harness>) => {
  h.controller.scenePhaseChanged("inactive");
  h.controller.scenePhaseChanged("background");
  h.controller.scenePhaseChanged("inactive");
  h.controller.scenePhaseChanged("active");
};

{
  const h = harness();
  h.advance(10_000);
  back(h);
  assert.equal(h.refreshes(), 0, "within 2 minutes of the launch refresh: debounced");
  h.advance(115_000);
  back(h);
  assert.equal(h.refreshes(), 1, "a return 125 s after launch refreshes");
  back(h);
  assert.equal(h.refreshes(), 1, "a refresh already running is not started twice");
  await h.finish();
  assert.equal(h.applied.length, 1, "the refreshed state reaches the page");
  h.advance(5_000);
  back(h);
  assert.equal(h.refreshes(), 1, "the last refresh restarts the debounce");
}

{
  const h = harness();
  h.advance(60_000);
  h.controller.scenePhaseChanged("inactive");
  h.controller.scenePhaseChanged("active");
  assert.equal(h.refreshes(), 0, "an inactive moment without the background is not a return");
  h.publish({ source: "interface5", trigger: "list_pull" });
  back(h);
  assert.equal(h.refreshes(), 0, "a pull that just finished counts as the last refresh");
  h.advance(121_000);
  h.publish({ source: "interface5", trigger: "background" });
  back(h);
  assert.equal(h.refreshes(), 1, "a background host's round is not the app's foreground refresh");
  h.controller.stop();
}

const root = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
assert.match(root, /const foregroundRefresh = startForegroundRefresh\(\{ applyState \}\);/);
assert.match(root, /AppEvents\.scenePhase\.addListener\(observe\)/);
assert.match(root, /foregroundRefresh\.scenePhaseChanged\(phase\);/);
assert.match(root, /foregroundRefresh\.stop\(\);/);
for (const host of ["widget.tsx", "app_intents.tsx", "intent.tsx"]) {
  assert.equal(readFileSync(new URL(`../${host}`, import.meta.url), "utf8").includes("foreground-return-refresh"), false,
    `${host} never refreshes on a scene phase`);
}

console.log("foreground refresh tests passed");
