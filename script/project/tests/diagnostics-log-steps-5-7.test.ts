// Diagnostics log plan (docs/DIAGNOSTICS_LOG_PLAN_20261121.md), Deliveries iOS steps 5, 6 and 7, under the owner's
// rulings: D4/D207 (owner 2026-11-21 「开始并入终态，卡住另记（推荐）」) applied to every iOS start line; D13 (owner
// 2026-11-21 「删噪声，低价值类保底降到 10（推荐）」) for the section 4.2 noise items D158–D170; D10 (closed events and
// enumerated words), D181, D183, D188, D191 and the page items D215, D221, D222, D225, D226, D228, D229.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import type { AppState, Shipment } from "../models.ts";
import { memory, NOW, sha256 } from "./state-storage-mock.ts";
import { emptyState, loadState, saveState } from "../services/storage.ts";
import {
  beginDiagnosticFlow, changedSinceLastLogged, clearDiagnostics, diagnosticCategory, diagnosticProviderWord,
  diagnosticSummaryText, readDiagnostics, setDiagnosticsEnabled, writeDiagnostic, writeRuntimeCapabilities,
  type DiagnosticEntry,
} from "../services/logger.ts";
import { DIAGNOSTIC_EVENTS } from "../services/diagnostic-events.ts";
import { openFlows, setOpenFlows } from "./open-flow-markers.ts";

Object.assign(globalThis, {
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic:detail" },
  Notification: { schedule: async () => true },
});

function reset() {
  memory.clear();
  setDiagnosticsEnabled(true);
  clearDiagnostics();
}


test("D4: a refresh writes no start line; its end line carries the start, the duration and the trigger", () => {
  reset();
  const flowId = String(Date.now() * 1024);
  beginDiagnosticFlow("refresh.started", { flowId, trigger: "list_pull", baseRevision: 7, scriptVersion: "0.9.4",
    executionBoundary: "per_stage" });
  assert.ok(Object.values(openFlows()).some(flow => flow.event === "refresh"), "a running refresh keeps a marker");
  writeDiagnostic("account.sync.completed", { flowId, stage: "account_list", records: 2 });
  writeDiagnostic("refresh.succeeded", { flowId, result: "succeeded", attempted: 1, succeeded: 1 });
  const entries = readDiagnostics();
  assert.deepEqual(entries.map(entry => entry.event), ["refresh.succeeded", "account.sync.completed"]);
  const [end, child] = entries;
  assert.equal(child!.details.trigger, "list_pull", "a child line inherits the flow's trigger without a start line");
  assert.equal(end!.details.baseRevision, 7, "the start's evidence is on the end line");
  assert.equal(end!.details.scriptVersion, "0.9.4");
  assert.equal(end!.details.trigger, "list_pull");
  assert.equal(typeof end!.details.durationMs, "number");
  assert.equal(Object.values(openFlows()).some(flow => flow.event === "refresh"), false, "the end closes the marker");
});

test("D4: a display-scope start does not lend its selection evidence to a query-response end", () => {
  reset();
  beginDiagnosticFlow("detail.refresh.stage_started", { flowId: "1", stage: "account_detail", waybillTail: "0001",
    selectionScope: "display", statusProvider: "v5_list", historyProvider: "v5_list", budgetMs: 10_000 });
  writeDiagnostic("detail.refresh.stage_succeeded", { flowId: "1", stage: "account_detail", waybillTail: "0001",
    selectionScope: "query_response", effectiveTrackCount: 3 });
  const [end] = readDiagnostics();
  assert.equal(end!.details.selectionScope, "query_response");
  assert.equal(end!.details.budgetMs, 10_000);
  assert.equal(end!.details.statusProvider, undefined);
  assert.equal(end!.details.historyProvider, undefined);
});

test("D4: a detail refresh an earlier runtime left unfinished is reported once at the next host start", () => {
  reset();
  const flowId = String(Date.now() * 1024 + 3);
  beginDiagnosticFlow("detail.refresh.started", { flowId, trigger: "detail_pull" });
  const flows = openFlows();
  const key = Object.keys(flows).find(entry => entry.startsWith(`${flowId}:`))!;
  assert.equal(flows[key]!.event, "detail.refresh");
  flows[key] = { ...flows[key]!, runtime: "earlier-runtime", startedAtMs: Date.now() - 20 * 60_000 };
  setOpenFlows(flows);
  writeRuntimeCapabilities("widget");
  const unfinished = readDiagnostics().filter(entry => entry.event === "diagnostic.flow.unfinished");
  assert.equal(unfinished.length, 1);
  assert.equal(unfinished[0]!.details.unfinishedEvent, "detail.refresh");
  assert.equal(unfinished[0]!.level, "warning");
});

test("D164–D168: routine repeats are written once per change, and the record outlives the runtime", async () => {
  reset();
  const skip = (result: string) => writeDiagnostic("order.projection.skipped", { stage: "webview",
    ownerFingerprint: "abcdef012345", result });
  skip("before_pickup");
  skip("before_pickup");
  skip("cooldown");
  for (let index = 0; index < 3; index++) {
    writeDiagnostic("refresh.stage.skipped", { stage: "manual_refresh", waybillTail: "7054", skipReason: "cooldown",
      result: "cooldown", cooldownRemainingMs: 1_000 * index });
    writeDiagnostic("refresh.stage.skipped", { stage: "manual_refresh", waybillTail: "7054", skipReason: "lease_held",
      result: "lease_held" });
    writeDiagnostic("carrier.recognition.completed", { waybillTail: "7054", result: "cooldown" });
    writeDiagnostic("carrier.authority.loaded", { result: "cache_unavailable" });
  }
  writeDiagnostic("carrier.recognition.completed", { waybillTail: "7054", result: "failed" }, "warning");
  writeDiagnostic("carrier.recognition.completed", { waybillTail: "7054", result: "failed" }, "warning");
  const count = (event: string, predicate: (entry: DiagnosticEntry) => boolean = () => true) =>
    readDiagnostics().filter(entry => entry.event === event && predicate(entry)).length;
  assert.equal(count("order.projection.skipped", entry => entry.details.result === "before_pickup"), 1);
  assert.equal(count("order.projection.skipped", entry => entry.details.result === "cooldown"), 1, "a new reason is new");
  assert.equal(count("refresh.stage.skipped", entry => entry.details.skipReason === "cooldown"), 1);
  assert.equal(count("refresh.stage.skipped", entry => entry.details.skipReason === "lease_held"), 3,
    "only the listed outcomes are filtered");
  assert.equal(count("carrier.recognition.completed", entry => entry.details.result === "cooldown"), 1);
  assert.equal(count("carrier.authority.loaded"), 1);
  assert.equal(count("carrier.recognition.completed", entry => entry.level === "warning"), 2, "warnings always pass");
  await Promise.resolve();
  // A new runtime (a widget run) reads the shared record and does not repeat the line.
  const widget = await import("../services/logger.ts?widget-runtime");
  assert.equal(widget.changedSinceLastLogged(
    ["order.projection.skipped", "abcdef012345", "", "webview", ""].join("\u0000"), ["cooldown", ""].join("\u0000")),
  false, "the repeat record is shared by every runtime");
  const shared = String(memory.get("pipi_deliveries_diagnostic_repeat_v1") || "");
  assert.ok(shared.length > 2, "the record is kept on the device");
  assert.doesNotMatch(shared, /7054|abcdef012345|cooldown|order\.projection/, "the shared record keeps hashes, not the values");
});

test("D10: only events of the closed table are written, and words cannot carry an identifier", () => {
  reset();
  writeDiagnostic("synthetic.event.name", { result: "succeeded" });
  writeDiagnostic("shipment.SF1234567890.succeeded", { result: "succeeded" });
  assert.deepEqual(readDiagnostics(), [], "an event outside the table is dropped");
  assert.equal(DIAGNOSTIC_EVENTS.has("refresh.started"), false, "start events are merged, not written (D4)");
  writeDiagnostic("refresh.stage.failed", { result: "SF1234567890", stage: "3201234567890", skipReason: "no_tracks",
    gateReason: "phone_13800138000", carrierCode: "SF", rawCarrierCode: "JD9988776655", trigger: "list_pull",
    flowId: String(NOW * 1024), scriptVersion: "0.9.4-beta" }, "warning");
  const [line] = readDiagnostics();
  assert.equal(line!.details.result, undefined);
  assert.equal(line!.details.stage, undefined);
  assert.equal(line!.details.gateReason, undefined);
  assert.equal(line!.details.rawCarrierCode, undefined);
  assert.equal(line!.details.skipReason, "no_tracks");
  assert.equal(line!.details.carrierCode, "SF");
  assert.equal(line!.details.trigger, "list_pull");
  assert.equal(line!.details.flowId, String(NOW * 1024), "an identifier key keeps its numeric id");
  assert.equal(line!.details.scriptVersion, "0.9.4-beta");
  assert.doesNotMatch(JSON.stringify(line), /1234567890|13800138000|9988776655/);
});

test("D181: the candidate map is one closed-word field; a map carrying an identifier is dropped", () => {
  reset();
  assert.equal(diagnosticProviderWord("interface5"), "v5_list");
  assert.equal(diagnosticProviderWord("kuaidi100_h5"), "k100_h5");
  writeDiagnostic("detail.timeline.selected", {
    candidateMap: "v5_list:selected:12:full:ok:0,jd_h5:available:5:part:provider_not_qualified:b30",
  });
  writeDiagnostic("detail.timeline.selected", { candidateMap: "v5_list:selected:12:full:SF1234567890:0" });
  writeDiagnostic("detail.timeline.selected", { candidateMap: "v5_list:selected:12:full:ok:0,13800138000" });
  const [third, second, first] = readDiagnostics();
  assert.equal(first!.details.candidateMap, "v5_list:selected:12:full:ok:0,jd_h5:available:5:part:provider_not_qualified:b30");
  assert.equal(second!.details.candidateMap, undefined);
  assert.equal(third!.details.candidateMap, undefined);
});

function manualRow(id: string): Shipment {
  return {
    identity: { id: `interface5:manual:${id}`, sourceId: id, bindingSource: "interface5", sourceOwner: "manual",
      phoneTail: "", courierCode: "", companyName: "Synthetic", manuallyAdded: true, createdAtMs: NOW },
    timeline: { provider: "v6_query", waybill: id, courierCode: "", companyName: "Synthetic", semantic: "TRANSIT",
      statusEventAtMs: NOW, latestTimeText: "", latestDetail: "Synthetic", tracks: [], successAtMs: NOW },
    updatedAtMs: NOW,
  } as Shipment;
}

test("D160: a healthy commit writes no storage.state.saved line", () => {
  reset();
  const state: AppState = { ...emptyState(), revision: 1, updatedAtMs: NOW, shipments: [manualRow("SYNTH0001A")] };
  const payload = JSON.stringify(state);
  memory.set("pipi_deliveries_state_v1", JSON.stringify({ schema: 3, checksum: sha256(payload), payload }));
  clearDiagnostics();
  const before = loadState(NOW);
  saveState({ ...before, shipments: [{ ...before.shipments[0]!, updatedAtMs: NOW + 1 }] }, NOW + 1);
  assert.equal(readDiagnostics().filter(entry => entry.event === "storage.state.saved").length, 0);
});

test("D225: the copied summary counts kinds, levels, problems and unfinished flows without identifiers", () => {
  reset();
  writeDiagnostic("refresh.succeeded", { result: "succeeded" });
  writeDiagnostic("cloud.sync.failed", { domain: "international", errorCategory: "network" }, "warning");
  writeDiagnostic("diagnostic.flow.unfinished", { unfinishedEvent: "refresh", ageMs: 700_000 }, "warning");
  writeDiagnostic("diagnostics.recording.started", { result: "started" });
  const summary = diagnosticSummaryText();
  assert.match(summary, /^# summary version=\S+ track=\S+ build=\d+ entries=4 warnings=2 errors=0 unfinished=1/);
  assert.match(summary, /recordingSince=\d{4}-\d\d-\d\dT/);
  assert.match(summary, /# kinds app=2 cloud=1 express=1/);
  assert.match(summary, /# problems cloud\.sync\.failed=1 diagnostic\.flow\.unfinished=1/);
  assert.equal(diagnosticCategory("account.enhanced.failed"), "platform");
  assert.equal(diagnosticCategory("alignment.completed"), "express");
  assert.equal(diagnosticCategory("shortcut.screen.completed"), "ocr");
  assert.equal(diagnosticCategory("widget.run.completed"), "app");
});

// ---- The log page (step 6).
const page = readFileSync(new URL("../pages/DiagnosticLogPage.tsx", import.meta.url), "utf8");
function pageFunction<T>(names: readonly string[], result: string, scope: Record<string, unknown> = {}): T {
  const source = names.map(name => {
    const match = page.match(new RegExp(`(?:export )?function ${name}\\([\\s\\S]*?\\n}`))?.[0];
    assert.ok(match, name);
    return stripTypeScriptTypes(match.replace(/^export /, ""));
  }).join("\n");
  const constants = ["EVENT_TITLES", "RETIRED_EVENT_TITLES", "UNFINISHED_TITLES", "CLOUD_DOMAIN_TITLES"].map(name => {
    const match = page.match(new RegExp(`const ${name}: [^=]+= \\{[\\s\\S]*?\\n\\};`))?.[0];
    assert.ok(match, name);
    return stripTypeScriptTypes(match);
  }).join("\n");
  return new Function(...Object.keys(scope), `${constants}\n${source}; return ${result};`)(...Object.values(scope)) as T;
}
const DETAIL_FUNCTIONS = ["legacyBool", "bindingsCount", "providerText", "reasonText", "errorText", "stageText",
  "timelineProviderText", "failureText", "recognitionParts", "phaseParts", "candidateParts", "resultText", "detailsText"];

test("D215, D229: titles follow the line's result, reason, domain and flow", () => {
  const eventTitle = pageFunction<(item: Partial<DiagnosticEntry>) => string>(["eventTitle"], "eventTitle");
  const title = (event: string, details: Record<string, unknown>) => eventTitle({ event, details } as DiagnosticEntry);
  assert.equal(title("manual.source.skipped", { result: "cooldown" }), "数据源冷却中，未查询");
  assert.equal(title("manual.source.skipped", { result: "no_timed_tracks" }), "数据源没有有效轨迹");
  assert.equal(title("cloud.sync.completed", { domain: "pdd" }), "拼多多云记录同步结束");
  assert.equal(title("cloud.sync.failed", { domain: "international" }), "国际物流同步未完成");
  assert.equal(title("cloud.sync.skipped", { domain: "meal_pickup" }), "取餐码同步跳过");
  assert.equal(title("alignment.completed", { result: "forced" }), "状态与头条对不上，已强制刷新");
  assert.equal(title("alignment.completed", { result: "skipped", skipReason: "no_query" }), "状态对齐未请求数据源");
  // A background alignment that stopped after its request because the row changed did ask a source.
  assert.equal(title("alignment.completed", { result: "skipped", skipReason: "stale_target" }), "状态对齐已跳过");
  assert.equal(title("recognition.online.completed", { trigger: "connection_test" }), "连接测试结束");
  assert.equal(title("diagnostic.flow.unfinished", { unfinishedEvent: "refresh" }), "上次未结束：快递同步");
  assert.equal(title("detail.refresh.skipped", { skipReason: "stale_target" }), "详情刷新未执行");
  // A line stored by an earlier build keeps its own title after the update (up to seven days of log).
  assert.equal(title("refresh.started", {}), "快递同步开始");
  assert.equal(title("widget.run.presenting", {}), "小组件开始显示");
  assert.equal(title("detail.refresh.alignment", { result: "failed" }), "状态对齐强刷失败");
  assert.equal(title("detail.refresh.alignment", {}), "状态与头条对不上，强制刷新");
  const retired = page.match(/const RETIRED_EVENT_TITLES: [^=]+= \{([\s\S]*?)\n\};/)?.[1] ?? "";
  const retiredEvents = [...retired.matchAll(/^\s*"([^"]+)":/gm)].map(match => match[1]!);
  assert.ok(retiredEvents.length > 0);
  assert.deepEqual(retiredEvents.filter(event => DIAGNOSTIC_EVENTS.has(event)), [],
    "a retired title never names an event the logger accepts");
});

test("D226, D228, D158, D181: the page shows the chain level, phases, ledger and candidates", () => {
  const detailsText = pageFunction<(item: Partial<DiagnosticEntry>) => string>(DETAIL_FUNCTIONS, "detailsText");
  const text = detailsText({ event: "refresh.succeeded", details: {
    level: "v5_list", interface: "v5", preparationMs: 12, accountMs: 340, enrichmentMs: 900, finalizationMs: 30,
    accountContinued: false, appliedRevision: 41, gateReason: "owner_pickup",
  } } as DiagnosticEntry);
  for (const part of ["链路级别 v5_list", "接口 v5", "准备 12 ms", "账号阶段 340 ms", "逐票补充 900 ms", "收尾 30 ms",
    "账号阶段后未继续", "界面版本 41", "闸门 owner_pickup"]) assert.ok(text.includes(part), part);
  const alignment = detailsText({ event: "alignment.completed", details: {
    alignmentAttempts: 2, attemptCounted: true, nextAttemptInMs: 600_000,
  } } as DiagnosticEntry);
  assert.ok(alignment.includes("已用强刷 2/3") && alignment.includes("10 分钟后可再次强刷"), alignment);
  const candidates = detailsText({ event: "detail.timeline.selected", details: {
    candidateMap: "v5_list:selected:12:full:ok:0,jd_h5:available:5:part:no_tracks:b30",
  } } as DiagnosticEntry);
  assert.ok(candidates.includes("候选 v5_list 已选 12 条 完整"), candidates);
  assert.ok(candidates.includes("候选 jd_h5 有轨迹 5 条 不完整 · 没有有效时间节点 · 旧 30 分钟"), candidates);
});

test("D222, D221, D230: one flow folds into one card under the kind of its newest line", () => {
  const groupDiagnostics = pageFunction<(items: readonly DiagnosticEntry[]) => Array<{
    head: DiagnosticEntry; steps: DiagnosticEntry[]; category: string;
  }>>(["groupDiagnostics"], "groupDiagnostics", { diagnosticCategory });
  const line = (id: string, event: string, flowId?: string): DiagnosticEntry =>
    ({ id, at: new Date(NOW).toISOString(), level: "info", event, details: flowId ? { flowId } : {} });
  // Newest first, as readDiagnostics returns them.
  const groups = groupDiagnostics([
    line("4", "refresh.succeeded", "11"), line("3", "notification.replay.completed", "11"),
    line("2", "settings.changed"), line("1", "account.sync.completed", "11"),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.head.event, "refresh.succeeded");
  assert.deepEqual(groups[0]!.steps.map(step => step.event), ["notification.replay.completed", "account.sync.completed"]);
  assert.equal(groups[0]!.category, "express", "the notification line stays in its refresh's card");
  assert.equal(groups[1]!.head.event, "settings.changed");
});
