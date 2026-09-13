import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
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

// One flow id ties the three records together.
assert.ok(widget.includes('createDiagnosticFlowId("widget")'));
for (const event of [
  "widget.run.started",
  "widget.refresh.skipped",
  "widget.run.presenting",
]) {
  assert.match(
    widget,
    new RegExp(`writeDiagnostic\\(\\s*(?:outcome === "skipped" \\? "widget\\.refresh\\.skipped" : )?"${event.replace(/\./g, "\\.")}"`),
    `widget.tsx must record ${event}`,
  );
}

// The cadence stamp is taken before the refresh, so a killed run still moves it forward.
const stampAt = widget.indexOf("recordWidgetRunAtMs(startedAtMs)");
const refreshAt = widget.indexOf("bestEffortWidgetRefresh(");
const presentAt = widget.indexOf("Widget.present(");
const presentingRecordAt = widget.search(
  /writeDiagnostic\(\s*"widget\.run\.presenting"/,
);
assert.ok(stampAt > 0 && refreshAt > 0 && presentAt > 0 && presentingRecordAt > 0);
assert.ok(stampAt < refreshAt, "the cadence stamp must precede the refresh");
// The host destroys the context at present time, so the completion record must come first.
assert.ok(
  presentingRecordAt < presentAt,
  "widget.run.presenting must be written before Widget.present",
);

// Telemetry must not change what the widget renders or how often it asks to be reloaded.
assert.ok(widget.includes("reloadPolicy: widgetReloadPolicy()"));
assert.equal(widget.includes("BackgroundKeeper"), false);

const runSource = widget.slice(widget.indexOf("async function run()"), widget.lastIndexOf("void run();"));
for (const [summary, result, event, level] of [
  [{ attempted: 1, succeeded: 1, failed: 0 }, "completed", "widget.refresh.completed", "info"],
  [{ attempted: 2, succeeded: 1, failed: 1 }, "partial", "widget.refresh.completed", "warning"],
  [{ attempted: 1, succeeded: 0, failed: 1 }, "failed", "widget.refresh.failed", "warning"],
  [{ attempted: 0, succeeded: 0, failed: 0, skipReason: "active_cross_runtime_refresh" },
    "skipped", "widget.refresh.skipped", "info"],
  [null, "timed_out", "widget.refresh.failed", "warning"],
] as const) {
  const entries: { event: string; details: Record<string, unknown>; level?: string }[] = [];
  const cached = { rows: [] };
  let presented = 0;
  await runInNewContext(`${runSource}\nrun();`, {
    ...runtime,
    bestEffortWidgetRefresh: (refresh: Parameters<typeof runtime.bestEffortWidgetRefresh>[0]) =>
      runtime.bestEffortWidgetRefresh(refresh, 1),
    refreshAllShipments: () => summary ? Promise.resolve(summary) : new Promise(() => {}),
    createDiagnosticFlowId: () => "widget-test",
    writeRuntimeCapabilities() {}, loadCarrierAuthorityCache() {}, recordWidgetRunAtMs() {},
    readWidgetRunAtMs: () => 0, lastNetworkRefreshSuccessAtMs: () => 0, widgetRunGapMs,
    writeDiagnostic: (event: string, details: Record<string, unknown>, level?: string) =>
      entries.push({ event, details, level }),
    widgetContent: () => cached,
    Widget: { family: "systemMedium", present: (content: unknown) => {
      assert.equal(content, cached);
      assert.equal(entries.at(-1)?.event, "widget.run.presenting");
      presented++;
    } },
  });
  assert.equal(presented, 1, "every refresh outcome must still present cached widget content");
  const terminal = entries.filter(entry => entry.event.startsWith("widget.refresh."));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].event, event);
  assert.equal(terminal[0].details.result, result);
  assert.equal(terminal[0].level, level);
}

console.log("widget telemetry tests passed");
