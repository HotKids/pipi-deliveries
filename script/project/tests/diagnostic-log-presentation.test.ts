import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
  "已解析脚本 ${details.parsedScriptCount}",
  "末个脚本 ${details.lastParsedScript}",
  "Vue ${details.vuePresent",
  "jQuery ${details.jqueryPresent",
  "页面状态 ${({ loading: \"加载中\"",
  "手机验证${details.phoneChallengeVisible",
  "尾号验证${details.phoneVerificationAttempted",
  "页面有效轨迹 ${details.timedTrackCount}",
  "承运商 ${details.carrierCode}",
  "原始轨迹 ${details.rawTrackCount}",
  "有效轨迹 ${details.validTrackCount}",
  "当前轨迹 ${details.effectiveTrackCount}",
  "详情有效轨迹 ${details.detailEffectiveTrackCount}",
  "主数据源成功 ${details.primarySuccessCount}",
  "跳过原因 ${reasonText(details.skipReason)}",
  "列表数据源 ${providerText(details.finalTimelineProvider)}",
  "详情轨迹 ${providerText(details.detailTimelineProvider)}",
  'item.event === "manual.query.completed"',
  "选中数据源 ${value}",
  "查询数据源 ${value}",
  // 统一用词（2026-09-05）：链上的一级就叫它的 level 词，旧日志里的名字映过去，不再翻成品牌词。
  'fallback: "kdniao"',
  'interface5: "v5_query"',
  'moto: "v4_query"',
  'kuaidi100_h5: "k100_h5"',
  'kuaidi100_query: "k100_h5 查询"',
  'meizu: "v6_query"',
  "仅采集必要的诊断信息，相关数据仅限本地存储与使用。",
]) {
  assert.ok(page.includes(contract), `missing diagnostic UI contract: ${contract}`);
}

assert.equal(page.includes("复现问题后，可返回此页面复制日志"), false);
assert.equal(page.includes("details.routeUrl"), false);
assert.equal(/details\.phone\b/.test(page), false);
assert.equal(page.includes("details.accessKey"), false);

// 数据源名（provider）就写 level 词；阶段名（stage）与 Pipi 阶段表同一格式：「<level> 查询」「vN_list 同步」（2026-11-12）。
for (const [name, suffix] of [["providerText", ""], ["stageText", " 查询"]] as const) {
  const source = page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))?.[0];
  assert.ok(source);
  const format = new Function(`${stripTypeScriptTypes(source)}; return ${name};`)() as (value: string) => string;
  for (const [input, expected] of [["cainiao", "cainiao"], ["jingdong", "jingdong"],
    ["shunfeng", "sfexpress"], ["sfexpress", "sfexpress"], ["douyin", "douyin"]]) {
    assert.equal(format(input), expected, `${name} keeps platform names distinct from H5 provider names`);
  }
  for (const [input, expected] of [["cainiao_h5", "cn_h5"], ["jingdong_h5", "jd_h5"], ["cn_h5", "cn_h5"],
    ["jd_h5", "jd_h5"], ["v6_picker", "v6_query"], ["meizu_picker", "v6_query"], ["v6_query", "v6_query"]]) {
    assert.equal(format(input), `${expected}${suffix}`, `${name} names ${input}`);
  }
}
{
  const source = page.match(/function stageText\([\s\S]*?\n}/)?.[0];
  assert.ok(source);
  const stageText = new Function(`${stripTypeScriptTypes(source)}; return stageText;`)() as (value: string) => string;
  for (const [input, expected] of [["v5_list", "v5_list 同步"], ["account_list", "v5_list 同步"],
    ["v3_list", "v3_list 同步"], ["v5_query", "v5_query 查询"], ["k100_h5", "k100_h5 查询"],
    ["jt_h5", "jt_h5 查询"], ["kdniao", "kdniao 查询"], ["v4_query", "v4_query 查询"],
    ["k100_autoCom", "承运商识别"], ["detail_refresh", "详情刷新"], ["widget_timeline", "小组件时间线"]]) {
    assert.equal(stageText(input), expected, `stage ${input}`);
  }
}

// 页面不露出原始事件键（2026-11-12）：源码里写入的每个事件都要有中文标题。
{
  const titles = new Set([...page.matchAll(/^  "([a-z0-9_.]+)": "/gm)].map((match) => match[1]));
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["tests", "node_modules", "probes"].includes(entry.name)) walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name)) sources.push(readFileSync(path, "utf8"));
    }
  };
  walk(projectRoot);
  const written = new Set<string>();
  for (const text of sources) {
    for (const match of text.matchAll(/writeDiagnostic(?:Batch)?\(\s*(?:[^"(),]*\?\s*)?"([a-z0-9_]+\.[a-z0-9_.]+)"/g)) written.add(match[1]!);
    for (const match of text.matchAll(/:\s*"((?:widget|order|manual)\.[a-z_]+\.[a-z_]+)"/g)) written.add(match[1]!);
  }
  for (const event of ["shipment.complete.succeeded", "shipment.complete.failed",
    "shipment.delete.succeeded", "shipment.delete.failed"]) written.add(event);
  const missing = [...written].filter((event) => !titles.has(event)).sort();
  assert.deepEqual(missing, [], `diagnostic events without a Chinese title: ${missing.join(", ")}`);
}

console.log("diagnostic log presentation contracts passed");

const diagnosticFunctions = ["legacyBool", "bindingsCount", "providerText", "reasonText", "errorText", "stageText", "timelineProviderText", "failureText", "detailsText"].map(name => {
  const source = page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))?.[0];
  assert.ok(source);
  return stripTypeScriptTypes(source);
}).join("\n");
const renderDetails = new Function(`${diagnosticFunctions}; return detailsText;`)();
const cacheSummary = renderDetails({ event: "detail.timeline.selected", details: {
  clientBuild: 83, trigger: "cache_read", candidateCount: 6, availableCandidateCount: 5,
  detailComplete: false, incompleteReason: "latest_unknown",
} });
for (const text of ["构建 83", "读取本地缓存", "缓存候选 6", "有轨迹候选 5", "最新节点状态无法识别"]) {
  assert.ok(cacheSummary.includes(text), text);
}
assert.equal(cacheSummary.includes("尝试"), false);
assert.equal(cacheSummary.includes("成功"), false);
const requestSummary = renderDetails({ event: "detail.refresh.stage_succeeded", details: {
  requestProvider: "v5_query", displayTimelineProvider: "cn_h5", trigger: "detail_open",
} });
assert.ok(requestSummary.includes("请求接口 v5_query"));
assert.ok(requestSummary.includes("显示缓存 cn_h5"));
const responseSummary = renderDetails({ event: "manual.query.completed", details: {
  timelineProvider: "v6_query", selectionScope: "query_response", returnedTrackCount: 1, effectiveTrackCount: 1,
} });
assert.ok(responseSummary.includes("回包数据源 v6_query"));
assert.ok(responseSummary.includes("回包轨迹 1"));
assert.equal(responseSummary.includes("当前轨迹"), false);
assert.equal(responseSummary.includes("选中数据源"), false);
const displaySummary = renderDetails({ event: "refresh.stage.succeeded", details: {
  requestProvider: "v6_query", displayTimelineProvider: "k100_h5", selectionScope: "display",
  displayedTrackCount: 16, effectiveTrackCount: 16,
} });
assert.ok(displaySummary.includes("显示轨迹 16"));
assert.ok(displaySummary.includes("显示缓存 k100_h5"));
const queryDetails = { locationNuMatches: true, vmNumMatches: false, lastQueriedNumMatches: false,
  vmLoading: true, carrierSelected: false, carrierCandidateCount: 1,
  allListsCount: 2, listsCount: 2, queryErrorType: "" };
const renderedQuery = renderDetails({ event: "detail.refresh.stage_failed", details: queryDetails });
for (const text of ["页面运单一致", "查询运单不一致", "查询未发起", "查询加载中",
  "承运商未选择", "承运商候选 1", "页面全部行 2", "页面显示行 2", "页面错误 未报告"]) {
  assert.ok(renderedQuery.includes(text), text);
}
assert.ok(renderDetails({ event: "detail.refresh.stage_failed", details: { queryErrorType: "network" } })
  .includes("页面错误 网络连接失败"));

const firstRowText = renderDetails({ event: "detail.refresh.stage_failed", details: {
  rawExtractedCount: 1, firstTimePresent: false, firstFtimePresent: true,
  firstContextPresent: true, firstRowOutcome: "invalid_time",
} });
for (const text of ["提取行 1", "首行时间缺失", "首行 ftime 存在", "首行内容存在", "首行结果 时间无效"]) {
  assert.ok(firstRowText.includes(text), text);
}
