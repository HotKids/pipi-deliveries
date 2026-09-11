import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { widgetRunGapMs } from "../widget/telemetry";

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
  "widget.refresh.completed",
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

console.log("widget telemetry tests passed");
