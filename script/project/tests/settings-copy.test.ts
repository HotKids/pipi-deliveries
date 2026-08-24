import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const settings = readFileSync(join(projectRoot, "pages/SettingsPage.tsx"), "utf8");
const manifest = JSON.parse(
  readFileSync(join(projectRoot, "script.json"), "utf8"),
) as Record<string, unknown>;
const manager = readFileSync(
  join(projectRoot, "pages/PhoneManagerPage.tsx"),
  "utf8",
);
const privacy = readFileSync(join(projectRoot, "pages/PrivacyPage.tsx"), "utf8");

for (const expected of [
  "<Text>同步</Text>",
  "<Text>管理账号</Text>",
  "<Text>通知</Text>",
  "<Text>授权</Text>",
  "<Text>支持</Text>",
  "<Text>隐私政策</Text>",
  "<Text>关于</Text>",
  "<Text>派派助手</Text>",
  '<Text foregroundStyle="label">项目地址</Text>',
  "https://github.com/HotKids/pipi-deliveries",
  'title="Access Key"',
  '"请输入 Access Key"',
  '"Access Key 已保存"',
  '"Access Key 已失效"',
  '"未授权"',
  '"已授权"',
  '"不可用"',
  "Access Key 用于验证服务访问资格，仅保存在本机。",
]) {
  assert.ok(settings.includes(expected), `missing settings copy: ${expected}`);
}
for (const retiredTokenCopy of [
  'title="Token"',
  "粘贴 16 位 Token",
  "粘贴新 Token 以更新",
  "粘贴 16 位 Access Key",
  "粘贴新 Access Key 以更新",
  "Token 仅用于验证脚本访问资格",
]) {
  assert.equal(
    settings.includes(retiredTokenCopy),
    false,
    `found retired Token copy: ${retiredTokenCopy}`,
  );
}
assert.ok(
  settings.includes('credentialStatus === "unavailable"'),
  "server-rejected credentials must map to the unavailable settings state",
);
assert.equal(settings.includes("已开启 ${enabledNotificationCount} 项"), false);
assert.equal(settings.includes('title="已授权"'), false);
assert.equal(settings.includes('tint="systemGreen"'), false);
assert.equal(settings.includes("绑定手机号后，将自动同步关联的快递信息。"), false);
for (const symbol of [
  "phone",
  "bell",
  "key",
  "doc.text.magnifyingglass",
  "hand.raised",
  "link",
]) {
  assert.ok(
    settings.includes(`<SettingsRowIcon systemName="${symbol}" />`),
    `missing unified settings icon: ${symbol}`,
  );
}
const appIconStart = settings.indexOf("function SettingsAppIcon() {");
const appIconEnd = settings.indexOf(
  "export function SettingsPage",
  appIconStart,
);
assert.ok(appIconStart >= 0 && appIconEnd > appIconStart);
const appIcon = settings.slice(appIconStart, appIconEnd);
assert.ok(appIcon.includes('<SettingsRowIcon systemName="cat" />'));
assert.equal(appIcon.includes("cat.fill"), false);
assert.equal(appIcon.includes("script-icon.png"), false);
assert.equal(manifest.icon, "cat.fill");
assert.equal(manifest.color, "rgba(184, 114, 171, 1)");
assert.equal(Object.hasOwn(manifest, "iconImage"), false);
assert.ok(settings.includes("<SettingsAppIcon />"));
assert.equal(
  settings.includes('<SettingsRowIcon systemName="shippingbox" />'),
  false,
);

const supportStart = settings.indexOf('<Section header={<Text>支持</Text>}>');
const aboutStart = settings.indexOf('<Section header={<Text>关于</Text>}>');
assert.ok(supportStart >= 0 && aboutStart > supportStart);
const supportSection = settings.slice(supportStart, aboutStart);
for (const diagnosticContract of [
  'action={() => setDestination("diagnostics")}',
  "{diagnosticCount ? (",
  "{diagnosticCount}",
]) {
  assert.ok(
    supportSection.includes(diagnosticContract),
    `missing diagnostic navigation contract: ${diagnosticContract}`,
  );
}
assert.ok(settings.includes('<DiagnosticLogPage />'));

const projectLinkStart = settings.indexOf("<Link url={PROJECT_URL}>");
const projectLinkEnd = settings.indexOf("</Link>", projectLinkStart);
assert.ok(projectLinkStart >= 0 && projectLinkEnd > projectLinkStart);
const projectLink = settings.slice(projectLinkStart, projectLinkEnd);
for (const linkContract of [
  '<Text foregroundStyle="label">项目地址</Text>',
  '<Text foregroundStyle="secondaryLabel">GitHub</Text>',
  '<SettingsAccessoryIcon systemName="arrow.up.right" />',
]) {
  assert.ok(
    projectLink.includes(linkContract),
    `missing project link contract: ${linkContract}`,
  );
}
for (const oldSymbol of [
  "phone.fill",
  "bell.badge.fill",
  "key.fill",
  "hand.raised.fill",
  "shippingbox.fill",
]) {
  assert.equal(
    settings.includes(`systemName="${oldSymbol}"`),
    false,
    `found mixed filled settings icon: ${oldSymbol}`,
  );
}

assert.ok(manager.includes('navigationTitle="管理账号"'));
assert.ok(
  manager.includes(
    "最多可绑定 {EXPRESS_POLICY.sources.maxBindingsPerSource} 个手机号；绑定后，将自动同步关联的快递信息。",
  ),
);

assert.ok(privacy.includes('navigationTitle="隐私政策"'));
const privacyHeadings = ["隐私声明", "免责声明", "传播限制", "诊断日志"];
let previousHeadingIndex = -1;
for (const heading of privacyHeadings) {
  const headingIndex = privacy.indexOf(`<Text>${heading}</Text>`);
  assert.ok(headingIndex >= 0, `missing privacy heading: ${heading}`);
  assert.ok(
    headingIndex > previousHeadingIndex,
    `privacy heading is out of order: ${heading}`,
  );
  previousHeadingIndex = headingIndex;
}

console.log("settings and privacy copy contract tests passed");
