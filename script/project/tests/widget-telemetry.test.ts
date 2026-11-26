import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { widgetRunGapMs } from "../widget/telemetry";
import * as runtime from "../widget/runtime";

// 方案 A 验证 (2026-09-04): the widget timeline is the only background refresh path, and
// WidgetKit documents neither its cadence nor an execution budget. The log has to answer both
// questions on its own.

const NOW = Date.UTC(2026, 8, 4, 9, 0, 0);

assert.equal(widgetRunGapMs(NOW - 15 * 60_000, NOW), 15 * 60_000);
assert.equal(widgetRunGapMs(NOW, NOW), 0);
// No previous run, unusable stamps, and a backwards clock all omit the field rather than lie.
assert.equal(widgetRunGapMs(0, NOW), null);
assert.equal(widgetRunGapMs(-1, NOW), null);
assert.equal(widgetRunGapMs(Number.NaN, NOW), null);
assert.equal(widgetRunGapMs(NOW + 1_000, NOW), null);

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const widget = readFileSync(join(projectRoot, "widget.tsx"), "utf8");

// D159 (plan step 5, owner 2026-11-21 「删噪声，低价值类保底降到 10（推荐）」): one record per run, with a flow id whose
// start marker (D4) reports a run the extension killed.
assert.ok(widget.includes('createDiagnosticFlowId("widget")'));
assert.match(widget, /beginDiagnosticFlow\("widget\.run\.started"/);
assert.match(widget, /writeDiagnostic\("widget\.run\.completed"/);
for (const event of ["widget.run.presenting", "widget.refresh.completed", "widget.refresh.failed", "widget.refresh.skipped"]) {
  assert.equal(widget.includes(`"${event}"`), false, `widget.tsx no longer writes ${event}`);
}

// The cadence stamp is taken before the refresh, so a killed run still moves it forward.
const stampAt = widget.indexOf("recordWidgetRunAtMs(startedAtMs)");
const refreshAt = widget.indexOf("bestEffortWidgetRefresh(");
const presentAt = widget.indexOf("Widget.present(");
const presentingRecordAt = widget.search(/finish\(result, extra, level\)/);
const unsupportedRecordAt = widget.indexOf('finish("unsupported")');
assert.ok(unsupportedRecordAt > 0 && unsupportedRecordAt < presentAt,
  "the unsupported-size run is recorded before its Widget.present");
assert.ok(stampAt > 0 && refreshAt > 0 && presentAt > 0 && presentingRecordAt > 0);
assert.ok(stampAt < refreshAt, "the cadence stamp must precede the refresh");
// The host destroys the context at present time, so the completion record must come first.
assert.ok(
  presentingRecordAt < widget.lastIndexOf("Widget.present("),
  "widget.run.completed must be written before Widget.present",
);

// Telemetry must not change what the widget renders or how often it asks to be reloaded.
assert.ok(widget.includes("reloadPolicy: widgetReloadPolicy()"));
assert.equal(widget.includes("BackgroundKeeper"), false);

const runSource = widget.slice(widget.indexOf("async function run()"), widget.lastIndexOf("void run();"));
for (const [summary, result, level] of [
  [{ attempted: 1, succeeded: 1, failed: 0 }, "completed", "info"],
  [{ attempted: 2, succeeded: 1, failed: 1 }, "partial", "warning"],
  [{ attempted: 1, succeeded: 0, failed: 1 }, "failed", "warning"],
  [{ attempted: 0, succeeded: 0, failed: 0, skipReason: "active_cross_runtime_refresh" }, "skipped", "info"],
  [null, "timed_out", "warning"],
] as const) {
  const entries: { event: string; details: Record<string, unknown>; level?: string }[] = [];
  const cached = { rows: [] };
  let presented = 0;
  let flushes = 0;
  await runInNewContext(`${stripTypeScriptTypes(runSource)}\nrun();`, {
    ...runtime,
    bestEffortWidgetRefresh: (refresh: Parameters<typeof runtime.bestEffortWidgetRefresh>[0]) =>
      runtime.bestEffortWidgetRefresh(refresh, 1),
    refreshAllShipments: () => summary ? Promise.resolve(summary) : new Promise(() => {}),
    createDiagnosticFlowId: () => "widget-test",
    writeRuntimeCapabilities() {}, backgroundHostBootstrap() {}, recordWidgetRunAtMs() {}, beginDiagnosticFlow() {},
    backgroundRefreshOptions: (budgetMs: number) => ({ budgetMs, accountOrderProjection: true, backgroundHostSafe: true }),
    flushDiagnostics: () => { flushes++; },
    readWidgetRunAtMs: () => 0, lastNetworkRefreshSuccessAtMs: () => 0, widgetRunGapMs,
    writeDiagnostic: (event: string, details: Record<string, unknown>, level?: string) =>
      entries.push({ event, details, level }),
    widgetContent: () => cached,
    Widget: { family: "systemMedium", present: (content: unknown) => {
      assert.equal(content, cached);
      assert.equal(entries.at(-1)?.event, "widget.run.completed");
      assert.equal(flushes, 1, "all host logs are flushed before presentation destroys the context");
      presented++;
    } },
  });
  assert.equal(presented, 1, "every refresh outcome must still present cached widget content");
  assert.deepEqual(entries.map(entry => entry.event), ["widget.run.completed"], "one record per widget run");
  assert.equal(entries[0].details.result, result);
  assert.equal(entries[0].details.widgetSize, "medium");
  assert.equal(entries[0].level, level);
  assert.equal(typeof entries[0].details.refreshMs, "number");
}

// G-LOW-15 (2026-11-20 review): the telemetry header names the run's wait by its constant, not a stale 122 s.
{
  const header = readFileSync(new URL("../widget/telemetry.ts", import.meta.url), "utf8").split("*/")[0]!;
  assert.doesNotMatch(header, /\b\d+ s of network work/, "no hard-coded network wait");
  assert.match(header, /WIDGET_REFRESH_WAIT_MS/);
  assert.equal(runtime.WIDGET_REFRESH_WAIT_MS, 8_000);
}

console.log("widget telemetry tests passed");
