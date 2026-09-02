import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  manualDetailRefreshToast,
  manualQueryToast,
  refreshSummaryToast,
  transientToast,
} from "../services/ui-feedback";

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
const queryingToast = manualQueryToast(true, "", () => {});
assert.equal(queryingToast.isPresented, true);
assert.equal(queryingToast.message, "正在查询，请稍候");
assert.equal(queryingToast.duration, 60);
const idleQueryToast = manualQueryToast(false, "", () => {});
assert.equal(idleQueryToast.isPresented, false);
assert.equal(idleQueryToast.duration, 2);
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
  const helper = file === "HomePage.tsx" ? "manualQueryToast" : "transientToast";
  assert.match(
    source,
    new RegExp(
      `import\\s*\\{[\\s\\S]*?${helper}[\\s\\S]*?\\}\\s*from "\\.\\.\\/services\\/ui-feedback";`,
    ),
    `${file} must use the shared transient feedback presentation`,
  );
  const toastBinding = file === "HomePage.tsx"
    ? "toast={manualQueryToast(querying, notice, setNotice)}"
    : "toast={transientToast(notice, setNotice)}";
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

const phoneBindingSource = await readFile(
  resolve(projectDir, "pages/PhoneBindingPage.tsx"),
  "utf8",
);
assert.ok(
  phoneBindingSource.includes("{validationNotice ? ("),
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
assert.ok(homeSource.includes('setNotice("该快递已删除")'));
assert.match(
  homeSource,
  /topBarTrailing:\s*\([\s\S]*?<Button[\s\S]*?buttonStyle="plain"[\s\S]*?action=\{\(\) => setNotice\("暂未接入"\)\}[\s\S]*?<Text[\s\S]*?font=\{17\}[\s\S]*?frame=\{\{ width: 44, height: 44 \}\}[\s\S]*?>\s*添加\s*<\/Text>/,
  "the Home add placeholder must mirror the back control and only show its fixed toast",
);

assert.ok(phoneBindingSource.includes('setNotice("验证码已发送")'));

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
