// 对账 R7（用户 2026-09-26 确认）：小组件没有物流节点时的占位与详情页空态同一句「暂无物流信息」
// （docs/COPY_BASELINE.md 2026-09-18：详情与小组件空态统一 `暂无物流信息`），原「暂无物流动态」不再用。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path: string) => readFile(resolve(projectDir, path), "utf8");
const [smallSource, mediumSource, detailSource] = await Promise.all([
  source("widget/SmallWidget.tsx"),
  source("widget/MediumWidget.tsx"),
  source("pages/DetailPage.tsx"),
]);

const detailEmpty = detailSource.match(/loadingManualDetail \? MANUAL_QUERY_IN_FLIGHT_TEXT : "([^"]+)"/)?.[1];
assert.equal(detailEmpty, "暂无物流信息", "the detail page empty state is the baseline copy");

const fallbacks = (text: string) => [...text.matchAll(/latestDetail \|\| "([^"]+)"/g)].map((match) => match[1]);
const small = fallbacks(smallSource);
const medium = fallbacks(mediumSource);
assert.equal(small.length, 1, "the 2x2 widget has one empty-detail fallback");
assert.equal(medium.length, 2, "both 4x2 detail branches (with and without a line limit) have a fallback");
for (const text of [...small, ...medium]) {
  assert.equal(text, detailEmpty, "widget and detail empty states share one copy");
}
assert.match(smallSource, /const detailText = row \? row\.latestDetail \|\| "暂无物流信息" : "";/,
  "an empty snapshot still shows no detail line at all");
for (const [name, text] of [["SmallWidget", smallSource], ["MediumWidget", mediumSource]] as const) {
  assert.equal(text.includes("暂无物流动态"), false, `${name} no longer uses the retired 暂无物流动态`);
}

console.log("widget empty-detail copy tests passed");
