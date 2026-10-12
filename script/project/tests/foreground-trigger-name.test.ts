// 其余裁决第 21 条（用户 2026-09-26）：诊断日志里启动 / 回前台刷新的触发名统一为 `foreground`
// （iOS 由 `foreground_sync` 改名，Lite 本来就是）。新写入直接写 `foreground`；存盘的旧日志不改写，
// 只在读取时把 `foreground_sync` 翻成 `foreground`；诊断页中文标签照旧是「前台同步」。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { createHmac } from "node:crypto";
import { memory } from "./state-storage-mock";
import { emptyState, saveState } from "../services/storage";
import { refreshAllShipments, subscribeFullRefreshOutcome, type FullRefreshOutcome } from "../services/sync";
import { saveGatewayToken } from "../services/credentials";
import { diagnosticText, readDiagnostics, setDiagnosticsEnabled, writeDiagnostic } from "../services/logger";
import { durableRefreshLeaseDiagnostics } from "../services/refresh-runtime-state";

const DIAGNOSTIC_KEY = "pipi_deliveries_diagnostic_log_v1";
const PHONE = "13800000000";
type StoredEntry = { id: string; at: string; level: string; event: string; details: Record<string, unknown> };
const rawEntries = () => (memory.get(DIAGNOSTIC_KEY) as StoredEntry[] | undefined) ?? [];

Object.assign(Crypto, {
  hmacSHA256: (value: string, key: string) => ({ toHexString: () => createHmac("sha256", key).update(value).digest("hex") }),
  generateSymmetricKey: () => ({ toHexString: () => "0123456789abcdef0123456789abcdef" }),
});
Object.assign(Data, { fromFile: () => null });
Object.assign(globalThis, {
  Notification: { schedule: async () => undefined }, Widget: { reloadAll() {} },
  Script: { directory: "/synthetic", name: "Synthetic", createRunSingleURLScheme: () => "synthetic://shipment" },
  WebViewController: class { constructor() { assert.fail("an empty list refresh never opens a page"); } },
});

// 1. 启动 / 回前台刷新（没有 backgroundHostSafe、没有下拉、不是只同步账号列表）新写入就是 foreground：
//    落盘的日志原值、租约上记的触发名、发给前台控制器的刷新结果，三处都来自同一个 trigger。
{
  memory.clear();
  setDiagnosticsEnabled(true);
  const now = Date.now();
  saveState({ ...emptyState(), shipments: [],
    bindings: [{ source: "interface5", phone: PHONE, boundAtMs: now - 86_400_000 }],
    feedSlotRebuiltAtMs: now - 86_400_000 }, now);
  saveGatewayToken("AbCdEfGh_123-456");
  const leaseTriggers: unknown[] = [];
  globalThis.fetch = (async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/express/carriers") return { ok: false, status: 503, text: async () => "Synthetic offline authority" };
    assert.equal(path, "/api/express/accounts/sync");
    leaseTriggers.push(durableRefreshLeaseDiagnostics("full:interface5").blockingTrigger);
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { expressList: [] } }) };
  }) as typeof fetch;
  const outcomes: FullRefreshOutcome[] = [];
  const unsubscribe = subscribeFullRefreshOutcome((outcome) => { outcomes.push(outcome); });
  try {
    const summary = await refreshAllShipments("interface5", { accountOrderProjection: false });
    assert.equal(summary.failed, 0);
  } finally { unsubscribe(); }

  assert.deepEqual(outcomes.map((outcome) => outcome.trigger), ["foreground"],
    "the foreground controller hears the renamed trigger");
  assert.deepEqual(leaseTriggers, ["foreground"], "the lease records the renamed trigger");
  const started = rawEntries().filter((entry) => entry.event === "refresh.started");
  assert.equal(started.length, 1);
  assert.equal(started[0]!.details.trigger, "foreground", "the stored line is written foreground, not translated later");
  assert.equal(JSON.stringify(rawEntries()).includes("foreground_sync"), false, "no new line carries the old name");
}

// 2. 旧日志：存盘的 foreground_sync 不改写，读取（诊断页、复制）时才翻成 foreground，
//    trigger 与记录阻塞方触发名的 blockingTrigger 同一口径。
{
  memory.clear();
  setDiagnosticsEnabled(true);
  const at = new Date(Date.now() - 60_000).toISOString();
  const old: StoredEntry[] = [
    { id: "old-started", at, level: "info", event: "refresh.started",
      details: { flowId: "refresh-old1", source: "interface5", trigger: "foreground_sync" } },
    { id: "old-wait", at, level: "info", event: "refresh.wait.started",
      details: { flowId: "refresh-old2", source: "interface5", trigger: "list_pull",
        blockingFlowId: "refresh-old1", blockingTrigger: "foreground_sync" } },
  ];
  memory.set(DIAGNOSTIC_KEY, structuredClone(old));

  const read = readDiagnostics();
  const started = read.find((entry) => entry.event === "refresh.started")!;
  const wait = read.find((entry) => entry.event === "refresh.wait.started")!;
  assert.equal(started.details.trigger, "foreground");
  assert.equal(wait.details.blockingTrigger, "foreground");
  assert.equal(wait.details.trigger, "list_pull", "other trigger names are untouched");
  const copied = diagnosticText();
  assert.ok(copied.includes("trigger=foreground"), copied);
  assert.ok(copied.includes("blockingTrigger=foreground"), copied);
  assert.equal(copied.includes("foreground_sync"), false, "the copy export shows the unified name");
  assert.deepEqual(rawEntries(), old, "reading translates; it does not rewrite the stored log");

  // 翻译只在读取路径：写入按调用方给的原值落盘，新写入的 foreground 靠 sync.ts 自己写对。
  writeDiagnostic("refresh.started", { flowId: "refresh-new1", source: "interface5", trigger: "foreground_sync" });
  assert.equal(rawEntries().at(-1)!.details.trigger, "foreground_sync", "the write path does not translate");
}

// 3. 诊断页：foreground 显示「前台同步」，旧日志读出来之后同样显示「前台同步」。
{
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const page = readFileSync(join(projectRoot, "pages/DiagnosticLogPage.tsx"), "utf8");
  const functions = ["legacyBool", "bindingsCount", "providerText", "reasonText", "stageText",
    "timelineProviderText", "failureText", "detailsText"].map((name) => {
    const source = page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))?.[0];
    assert.ok(source, name);
    return stripTypeScriptTypes(source);
  }).join("\n");
  const renderDetails = new Function(`${functions}; return detailsText;`)() as
    (entry: { event: string; details: Record<string, unknown> }) => string;
  assert.ok(renderDetails({ event: "refresh.started", details: { trigger: "foreground" } }).includes("触发 前台同步"));

  memory.clear();
  setDiagnosticsEnabled(true);
  memory.set(DIAGNOSTIC_KEY, [{ id: "old-page", at: new Date(Date.now() - 60_000).toISOString(), level: "info",
    event: "refresh.started", details: { flowId: "refresh-old3", source: "interface5", trigger: "foreground_sync" } }]);
  const [entry] = readDiagnostics();
  assert.ok(renderDetails(entry!).includes("触发 前台同步"), "an old line reads as 前台同步 too");
}

console.log("foreground trigger name tests passed");
