import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { memory } from "./state-storage-mock";
import { ACCOUNT_FAILURE_CODES, changedSinceLastLogged, SAFE_FAILURE_CODES, setDiagnosticsEnabled } from "../services/logger";

// G-MED-21 (2026-11-20 review; third review M-07).
// 1. While recording is off the repeat filter registers nothing, and turning recording on starts a clean filter, so the
//    first lines of a new recording are never collapsed by sightings from before it.
{
  memory.clear();
  const now = 2_000_000;
  setDiagnosticsEnabled(false);
  assert.equal(changedSinceLastLogged("row-off", "f1", now), true);
  assert.equal(changedSinceLastLogged("row-off", "f1", now + 1_000), true, "an off log registers no sighting");
  setDiagnosticsEnabled(true);
  assert.equal(changedSinceLastLogged("row-off", "f1", now + 2_000), true, "the first line after turning on is written");
  assert.equal(changedSinceLastLogged("row-off", "f1", now + 3_000), false, "a recording log still collapses repeats");
  setDiagnosticsEnabled(false);
  setDiagnosticsEnabled(true);
  assert.equal(changedSinceLastLogged("row-off", "f1", now + 4_000), true, "turning recording on clears the filter");
}

// 2. The page names every failure code in Chinese, and the Shortcut screen results. The Worker's own code keeps its
//    wire word (D175) and the request-phase fields stay on recognition lines (N1, 2026-11-21).
const page = readFileSync(new URL("../pages/DiagnosticLogPage.tsx", import.meta.url), "utf8");
const functions = ["legacyBool", "bindingsCount", "providerText", "reasonText", "errorText", "stageText",
  "timelineProviderText", "failureText", "recognitionParts", "phaseParts", "candidateParts", "resultText", "detailsText"]
  .map(name => stripTypeScriptTypes(page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))![0])).join("\n");
const render = new Function(`${functions}; return detailsText;`)() as
  (item: { event: string; details: Record<string, unknown> }) => string;
const hasChinese = /[一-鿿]/;
for (const code of [...SAFE_FAILURE_CODES, ...ACCOUNT_FAILURE_CODES]) {
  const text = render({ event: "refresh.stage.failed", details: { failureCode: code } });
  const label = text.match(/代码 ([^·]+)/)?.[1]?.trim() ?? "";
  assert.ok(label && hasChinese.test(label) && !label.includes(code), `failure code ${code} reads in Chinese: ${text}`);
}
assert.ok(render({ event: "gateway.request.failed", details: { httpStatus: 401, failureCode: "unauthorized" } })
  .includes("Access Key 不可用"), "the 401 Access Key wording is kept");

for (const [result, label] of [["manual_rescan_required", "需手动二次识别"], ["automatic_rescan_requested", "已请求自动二次识别"],
  ["meal_saved", "已保存取餐码"], ["pickup_saved", "已保存取件码"], ["handoff_saved", "已保存寄件码"],
  ["lookup_staged", "运单待确认"], ["waybill_recognized", "已识别运单号"], ["outdated_shortcut", "快捷指令需要更新"],
  ["invalid_input", "输入无效"]] as const) {
  const text = render({ event: "shortcut.screen.completed", details: { result, trigger: "luckin_rescan", stage: "screenshot" } });
  assert.ok(text.includes(`结果 ${label}`), `${result}: ${text}`);
  assert.ok(text.includes("触发 瑞幸二次识别") && !text.includes("luckin_rescan"), text);
}
// Every written trigger, stage and result word reads in Chinese, apart from the level and platform words the
// unified vocabulary keeps (2026-09-05, 2026-11-12; diagnostic-log-presentation.test.ts).
{
  const fn = (name: string) => new Function(`${stripTypeScriptTypes(page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))![0])}; return ${name};`)() as (value: string) => string;
  const stageText = fn("stageText"), reasonText = fn("reasonText");
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("..", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => readdirSync(dir).forEach((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (!["tests", "tools", "assets", "node_modules", "probes"].includes(name)) walk(path); }
    else if (/\.tsx?$/.test(name) && !path.endsWith("DiagnosticLogPage.tsx")) files.push(readFileSync(path, "utf8"));
  });
  walk(root);
  const words = (pattern: RegExp) => new Set(files.flatMap(text => [...text.matchAll(pattern)].map(match => match[1]!)));
  const kept = new Set(["cainiao", "jingdong", "douyin", "sfexpress", "pinduoduo", "fengchao", "none"]);
  const levelWord = (value: string, shown: string) => kept.has(value) || /^(v\d_|jd_h5|cn_h5|k100_|jt_h5|kdniao)/.test(shown);
  const rawStages = [...words(/stage: "([a-z_0-9]+)"/g)].filter(value => stageText(value) === value && !levelWord(value, value));
  const rawTriggers = [...words(/trigger: "([a-z_0-9]+)"/g)].filter(value => reasonText(value) === value);
  const rawResults = [...words(/result: "([a-z_0-9]+)"/g), ...words(/finish\("([a-z_]+)"/g)]
    .filter(value => reasonText(value) === value && !kept.has(value));
  assert.deepEqual(rawStages, [], `stages without Chinese: ${rawStages}`);
  assert.deepEqual(rawTriggers, [], `triggers without Chinese: ${rawTriggers}`);
  assert.deepEqual(rawResults, [], `results without Chinese: ${rawResults}`);
}
console.log("diagnostic vocabulary covers failure codes and Shortcut results");
