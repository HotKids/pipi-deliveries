import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  "自动来源 ${providerText(details.sourceProvider)}",
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
  'fallback: "KDNiao"',
  'interface5: "账号缓存"',
  'moto: "Moto"',
  'kuaidi100_h5: "K100 H5"',
  'kuaidi100_query: "K100 H5 轨迹查询"',
  'meizu: "魅族 Picker"',
  "仅采集必要的诊断信息，相关数据仅限本地存储与使用。",
]) {
  assert.ok(page.includes(contract), `missing diagnostic UI contract: ${contract}`);
}

assert.equal(page.includes("复现问题后，可返回此页面复制日志"), false);
assert.equal(page.includes("details.routeUrl"), false);
assert.equal(page.includes("details.phone"), false);
assert.equal(page.includes("details.accessKey"), false);

console.log("diagnostic log presentation contracts passed");
