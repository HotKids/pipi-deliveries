import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detailPullToast,
  errorMessage,
  isManualQueryValidationMessage,
  manualDetailRefreshToast,
  manualQueryFailureToast,
  refreshSummaryToast,
  transientToast,
} from "../services/ui-feedback";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import { OperationTimeoutError } from "../services/deadline";

let dismissedMessage = "unchanged";
const visibleToast = transientToast("运单号已复制", (message) => {
  dismissedMessage = message;
});
assert.equal(visibleToast.isPresented, true);
assert.equal(visibleToast.message, "运单号已复制");
assert.equal(visibleToast.duration, 2);
assert.equal(visibleToast.position, "bottom");
visibleToast.onChanged(true);
assert.equal(dismissedMessage, "unchanged");
visibleToast.onChanged(false);
assert.equal(dismissedMessage, "");
assert.equal(transientToast("", () => {}).isPresented, false);
// 统一 toast 表（AGENTS §11，2026-09-05）：手动查件的提示是短 toast 一次，不再常驻到查完。
assert.equal(EXPRESS_TOAST_COPY.manualQuerying, "正在查询，请稍候");
assert.equal(manualQueryFailureToast(new OperationTimeoutError()), "请求超时，请稍后重试");
assert.equal(manualQueryFailureToast(new Error("K100 查询超时")), "请求超时，请稍后重试");
assert.equal(
  manualQueryFailureToast(new Error("网关暂不可用")),
  "查询失败，请稍后重试",
  "upstream text never reaches the page; only the unified copy does",
);
assert.equal(isManualQueryValidationMessage("请输入 4 位手机尾号"), true);
assert.equal(isManualQueryValidationMessage("请输入手机尾号"), true);
assert.equal(isManualQueryValidationMessage("请输入有效的快递单号"), true);
assert.equal(isManualQueryValidationMessage("查询失败，请稍后重试"), false);
assert.equal(detailPullToast(true, true), "轨迹加载成功");
assert.equal(detailPullToast(false, true), "当前轨迹已是最新");
assert.equal(detailPullToast(false, false), "暂未获取到可用轨迹");
assert.equal(
  refreshSummaryToast({ attempted: 3, succeeded: 2, failed: 1 }),
  "刷新完成，部分快递暂未更新",
);
assert.equal(
  refreshSummaryToast({ attempted: 2, succeeded: 0, failed: 2 }),
  "刷新失败，请稍后重试",
);
assert.equal(
  refreshSummaryToast({ attempted: 0, succeeded: 0, failed: 0 }),
  "当前已是最新",
);
assert.equal(
  refreshSummaryToast({ attempted: 2, succeeded: 2, failed: 0 }),
  "刷新完成",
);
assert.equal(
  errorMessage(new Error("网关暂不可用"), "刷新失败，请稍后重试"),
  "网关暂不可用",
  "the source's own message always wins over the page's fallback",
);
assert.equal(
  errorMessage(new Error(""), "刷新失败，请稍后重试"),
  "刷新失败，请稍后重试",
);
assert.equal(
  errorMessage("not an Error", "刷新失败，请稍后重试"),
  "刷新失败，请稍后重试",
  "a non-Error throw from a host API must still name the failed operation",
);
assert.equal(
  manualDetailRefreshToast(false, true),
  "",
  "cached tracks without a committed enrichment must not report success",
);
assert.equal(manualDetailRefreshToast(true, true), "轨迹加载成功");
assert.equal(
  manualDetailRefreshToast(false, false),
  "暂未获取到可用轨迹",
);

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transientPages = [
  "DetailPage.tsx",
  "DiagnosticLogPage.tsx",
  "HomePage.tsx",
  "NotificationSettingsPage.tsx",
  "PhoneBindingPage.tsx",
  "PhoneManagerPage.tsx",
  "SettingsPage.tsx",
];

for (const file of transientPages) {
  const source = await readFile(resolve(projectDir, "pages", file), "utf8");
  const helper = "transientToast";
  assert.match(
    source,
    new RegExp(
      `import\\s*\\{[\\s\\S]*?${helper}[\\s\\S]*?\\}\\s*from "\\.\\.\\/services\\/ui-feedback";`,
    ),
    `${file} must use the shared transient feedback presentation`,
  );
  const toastBinding = "toast={transientToast(notice, setNotice)}";
  assert.ok(
    source.includes(toastBinding),
    `${file} must show operation feedback without occupying page layout`,
  );
  assert.doesNotMatch(
    source,
    /\{notice \? \([\s\S]{0,180}?<Text/,
    `${file} must not render transient notice text inline`,
  );
}

// Every page that reports a failed operation must reach the shared helper rather than keep a
// private copy with its own hard-coded fallback; three byte-identical copies are what let one
// gesture answer 刷新失败 on one path and 查询失败 on the other.
for (const file of ["HomePage.tsx", "PhoneBindingPage.tsx", "PhoneManagerPage.tsx"]) {
  const source = await readFile(resolve(projectDir, "pages", file), "utf8");
  assert.match(
    source,
    new RegExp(
      `import\\s*\\{[\\s\\S]*?errorMessage[\\s\\S]*?\\}\\s*from "\\.\\.\\/services\\/ui-feedback";`,
    ),
    `${file} must take its failure copy from the shared errorMessage helper`,
  );
  assert.doesNotMatch(
    source,
    /function errorMessage\(/,
    `${file} must not redefine errorMessage locally`,
  );
}

// Every toolbar glyph sits in a plain Button, which strips the button's own padding, so the
// tap target is exactly the label's frame. Without the explicit 44x44 the same affordance is
// ~17pt on one page and ~44pt on the next, and sits at a different inset from the trailing edge.
for (const file of transientPages) {
  const source = await readFile(resolve(projectDir, "pages", file), "utf8");
  const slots = source.match(
    /(?:topBarLeading|topBarTrailing):\s*\(\s*<Button[\s\S]{0,600}?<\/Button>/g,
  ) ?? [];
  for (const slot of slots) {
    if (!slot.includes("<Image")) continue;
    assert.ok(
      slot.includes("frame={{ width: 44, height: 44 }}"),
      `${file} toolbar glyphs must keep the shared 44pt tap target`,
    );
  }
}

const managerSource = await readFile(
  resolve(projectDir, "pages/PhoneManagerPage.tsx"),
  "utf8",
);
// The manager's pull-to-refresh makes the identical refreshAllShipments call HomePage makes,
// so it must report the identical four outcomes. refreshAllShipments resolves with failed > 0
// instead of rejecting, so "did the action throw" is not a usable success signal here.
assert.match(
  managerSource,
  /async function refresh\(\)[\s\S]*?await props\.onRefresh\(\)[\s\S]*?refreshSummaryToast\(summary\)[\s\S]*?EXPRESS_TOAST_COPY\.refreshFailed/,
  "the manager refresh must report through refreshSummaryToast, as HomePage does",
);
assert.ok(
  !managerSource.includes('"刷新完成"'),
  "the manager must not claim success from a summary it never inspected",
);
const settingsSource = await readFile(
  resolve(projectDir, "pages/SettingsPage.tsx"),
  "utf8",
);
assert.match(
  settingsSource,
  /onRefresh=\{async \(\) => \{[\s\S]*?return summary;[\s\S]*?\}\}/,
  "onRefresh must hand the summary counts to the manager instead of dropping them",
);

const phoneBindingSource = await readFile(
  resolve(projectDir, "pages/PhoneBindingPage.tsx"),
  "utf8",
);
assert.ok(
  phoneBindingSource.includes("{validationNotice || bindError ? ("),
  "phone and verification-code validation must remain inline",
);

const homeSource = await readFile(
  resolve(projectDir, "pages/HomePage.tsx"),
  "utf8",
);
assert.ok(
  homeSource.includes("{validationNotice && !phoneTailValidation ? ("),
  "manual-query validation must remain inline",
);
assert.match(
  homeSource,
  /setQuerying\(true\)[\s\S]*?await carrierDetectionCoordinatorRef\.current!\.resolve/,
  "query progress must begin before carrier recognition and network lookup",
);
assert.ok(homeSource.includes("setNotice(EXPRESS_TOAST_COPY.deleted)"));
// One gesture, one outcome: the resolve path and the reject path of the same pull-to-refresh
// must name the same failure, and a failed deletion must not be reported as a failed query.
assert.match(
  homeSource,
  /setNotice\(refreshSummaryToast\(summary\)\);[\s\S]{0,320}?setNotice\(EXPRESS_TOAST_COPY\.refreshFailed\)/,
  "a rejected refresh must name the same failure refreshSummaryToast names",
);
assert.match(
  homeSource,
  /async function confirmDelete[\s\S]*?setNotice\(EXPRESS_TOAST_COPY\.deleteFailed\)/,
  "a failed deletion reports the shared 删除失败 copy (AGENTS §11)",
);
assert.match(
  homeSource,
  /topBarTrailing:\s*\([\s\S]*?<Button[\s\S]*?buttonStyle="plain"[\s\S]*?action=\{\(\) => setNotice\("暂未接入"\)\}[\s\S]*?<Image\s+systemName="plus"\s+font=\{17\}\s+frame=\{\{ width: 44, height: 44 \}\}/,
  "the Home add placeholder must use a plus symbol matching the back control and only show its fixed toast",
);

assert.ok(phoneBindingSource.includes('setNotice(EXPRESS_TOAST_COPY.codeSent)'));

const notificationSource = await readFile(
  resolve(projectDir, "pages/NotificationSettingsPage.tsx"),
  "utf8",
);
assert.ok(notificationSource.includes('setNotice("保存失败，请稍后重试")'));

const diagnosticsSource = await readFile(
  resolve(projectDir, "pages/DiagnosticLogPage.tsx"),
  "utf8",
);
assert.ok(diagnosticsSource.includes('setNotice("暂无可复制的日志")'));
assert.ok(diagnosticsSource.includes('"复制失败，请稍后重试"'));

console.log("transient toast presentation tests passed");
