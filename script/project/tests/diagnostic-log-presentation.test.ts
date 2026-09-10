import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = readFileSync(
  join(projectRoot, "pages/DiagnosticLogPage.tsx"),
  "utf8",
);

for (const contract of [
  '"refresh.stage.started": "快递刷新阶段开始"',
  '"refresh.stage.succeeded": "快递刷新阶段完成"',
  '"refresh.stage.failed": "快递刷新阶段失败"',
  '"refresh.stage.skipped": "快递刷新阶段跳过"',
  '"detail.refresh.stage_started": "详情刷新阶段开始"',
  '"detail.refresh.stage_succeeded": "详情刷新阶段完成"',
  '"detail.refresh.stage_failed": "详情刷新阶段失败"',
  '"detail.refresh.stage_skipped": "详情刷新阶段跳过"',
  '"manual.query.completed": "手动查询完成"',
  '"manual.source.succeeded": "数据源查询成功"',
  "运单尾号 ${details.waybillTail}",
  "自动来源 ${details.sourceProvider}",
  "页面主体${details.mainPresent",
  "网页内容${details.htmlFetchCompleted",
  "广告脚本${details.adScriptRemoved",
  "已解析脚本 ${details.parsedScriptCount}",
  "末个脚本 ${details.lastParsedScript}",
  "Vue ${details.vuePresent",
  "jQuery ${details.jqueryPresent",
  "页面状态 ${details.readyState}",
  "手机验证${details.phoneChallengeVisible",
  "尾号验证${details.phoneVerificationAttempted",
  "页面有效轨迹 ${details.timedTrackCount}",
  "承运商 ${details.carrierCode}",
  "原始轨迹 ${details.rawTrackCount}",
  "有效轨迹 ${details.validTrackCount}",
  "当前轨迹 ${details.effectiveTrackCount}",
  "详情轨迹 ${details.detailEffectiveTrackCount}",
  "主数据源成功 ${details.primarySuccessCount}",
  "跳过原因 ${reasonText(details.skipReason)}",
  "列表数据源 ${providerText(details.finalTimelineProvider)}",
  "详情数据源 ${providerText(details.detailTimelineProvider)}",
  'item.event === "manual.query.completed"',
  "选中数据源 ${value}",
  "查询数据源 ${value}",
  // 统一用词（2026-09-05）：链上的一级就叫它的 level 词，旧日志里的名字映过去，不再翻成品牌词。
  'fallback: "kdniao"',
  'interface5: "v5_query"',
  'moto: "v4_query"',
  'kuaidi100_h5: "k100_h5"',
  'kuaidi100_query: "k100_h5"',
  'meizu: "v6_query"',
  "仅采集必要的诊断信息，相关数据仅限本地存储与使用。",
]) {
  assert.ok(page.includes(contract), `missing diagnostic UI contract: ${contract}`);
}

assert.equal(page.includes("复现问题后，可返回此页面复制日志"), false);
assert.equal(page.includes("details.routeUrl"), false);
assert.equal(/details\.phone\b/.test(page), false);
assert.equal(page.includes("details.accessKey"), false);

for (const name of ["providerText", "stageText"]) {
  const source = page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))?.[0];
  assert.ok(source);
  const format = new Function(`${stripTypeScriptTypes(source)}; return ${name};`)() as (value: string) => string;
  for (const [input, expected] of [["cainiao", "cainiao"], ["jingdong", "jingdong"],
    ["shunfeng", "sfexpress"], ["sfexpress", "sfexpress"], ["douyin", "douyin"],
    ["cainiao_h5", "cn_h5"], ["jingdong_h5", "jd_h5"], ["cn_h5", "cn_h5"], ["jd_h5", "jd_h5"],
    ["v6_picker", "v6_query"], ["meizu_picker", "v6_query"], ["v6_query", "v6_query"]]) {
    assert.equal(format(input), expected, `${name} keeps platform names distinct from H5 provider names`);
  }
}

console.log("diagnostic log presentation contracts passed");

const diagnosticFunctions = ["legacyBool", "bindingsCount", "timelineProviderText", "failureText", "detailsText"].map(name => {
  const source = page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))?.[0];
  assert.ok(source);
  return stripTypeScriptTypes(source);
}).join("\n");
const renderDetails = new Function(`${diagnosticFunctions}; return detailsText;`)();
const queryDetails = { locationNuMatches: true, vmNumMatches: false, lastQueriedNumMatches: false,
  vmLoading: true, carrierSelected: false, carrierCandidateCount: 1,
  allListsCount: 2, listsCount: 2, queryErrorType: "" };
const renderedQuery = renderDetails({ event: "detail.refresh.stage_failed", details: queryDetails });
for (const text of ["Page target matches", "Query target differs", "Query entered no", "Query loading yes",
  "Carrier selected no", "Carrier options 1", "Full page rows 2", "Displayed page rows 2", "Page error none reported"]) {
  assert.ok(renderedQuery.includes(text), text);
}
assert.ok(renderDetails({ event: "detail.refresh.stage_failed", details: { queryErrorType: "network" } })
  .includes("Page error network"));

const firstRowText = renderDetails({ event: "detail.refresh.stage_failed", details: {
  rawExtractedCount: 1, firstTimePresent: false, firstFtimePresent: true,
  firstContextPresent: true, firstRowOutcome: "invalid_time",
} });
for (const text of ["Extracted rows 1", "First time absent", "First ftime present", "First context present", "First row invalid_time"]) {
  assert.ok(firstRowText.includes(text), text);
}
