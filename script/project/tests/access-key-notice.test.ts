import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../pages/HomePage.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../index.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../pages/SettingsPage.tsx", import.meta.url), "utf8");
const bannerStart = home.indexOf("const shownAccessKeyNotice =");
assert.ok(bannerStart > 0);
const banner = home.slice(bannerStart, home.indexOf("\n  return (", bannerStart));

// The notices share one row; the 401 notice keeps its copy, the unreadable-key notices are new (2026-11-21).
assert.match(home, /rejected: "Access Key 已失效，请通过 TG Bot 重新获取。",/);
assert.match(home, /missing: "Access Key 未设置，请重新填写。",/);
assert.match(home, /conflict: "检测到本地授权记录不一致，请重新保存 Access Key。",/,
  "the conflict notice repeats the Settings authorization notice");
assert.match(banner, /\{ACCESS_KEY_NOTICE_COPY\[shownAccessKeyNotice\]\}/);
assert.match(home, /useState\(accessKeyReminder\)/);
assert.match(home, /return subscribeAccessKeyReminder\(setAccessKeyNoticeKind\)/);
assert.match(home, /\[dismissedAccessKeyNotice, setDismissedAccessKeyNotice\] = useState<AccessKeyReminder \| null>\(null\)/);
assert.match(banner, /accessKeyNoticeKind && accessKeyNoticeKind !== dismissedAccessKeyNotice/,
  "closing hides the notice that was shown, and a different notice still appears");
assert.match(banner, /action=\{\(\) => setDismissedAccessKeyNotice\(shownAccessKeyNotice\)\}/);

// Every notice opens Settings, where the key is entered; the 401 notice keeps its text (owner decision 2026-11-21:
// 「已失效」提醒也能点进设置（推荐）).
assert.match(banner, /const openAccessKeySettings = shownAccessKeyNotice \? props\.onOpenSettings : undefined;/);
assert.doesNotMatch(banner, /!== "rejected"/, "the rejected notice is tappable too");
assert.match(banner, /\{openAccessKeySettings \? \(\s*<Button buttonStyle="plain" action=\{openAccessKeySettings\}>\s*\{accessKeyNoticeText\}\s*<\/Button>\s*\) : accessKeyNoticeText\}/);
assert.match(banner, /frame=\{\{ maxWidth: "infinity", minHeight: 44, alignment: "leading" \}\}\s*contentShape="rect"/,
  "the text keeps a 44-point target inside the existing row height");
assert.match(home, /onOpenSettings\?: \(\) => void;/);
assert.match(app, /<HomePage[\s\S]*?onOpenSettings=\{\(\) => \{\s*setSettingsRootRequest\(value => value \+ 1\);\s*selection\.setValue\("settings"\);\s*\}\}/,
  "the app opens its Settings tab and asks it for its root");
// Settings keeps its own sub-page state, so a notice brings it back to the root where the Access Key field is (N2).
assert.match(app, /const \[settingsRootRequest, setSettingsRootRequest\] = useState\(0\);/);
assert.match(app, /<SettingsPage [^>]*rootRequest=\{settingsRootRequest\}/);
assert.match(settings, /rootRequest\?: number;/);
assert.match(settings, /useEffect\(\(\) => \{\s*if \(props\.rootRequest\) setDestination\(""\);\s*\}, \[props\.rootRequest\]\);/,
  "each request closes the open sub-page (recognition, diagnostics, phones and the rest)");
assert.match(app, /<Tab key="settings" title="设置" systemImage="gearshape\.fill" value="settings">/);

assert.match(banner, /background="secondarySystemBackground"/);
assert.match(banner, /systemName="xmark"\s*font=\{16\}\s*foregroundStyle="secondaryLabel"/);
assert.match(banner, /frame=\{\{ width: 44, height: 44 \}\}/);
assert.match(banner, /cornerRadius: 20/);
assert.equal((banner.match(/foregroundStyle="secondaryLabel"/g) ?? []).length, 2);
assert.doesNotMatch(banner, /Storage|Keychain|fetch|postGateway|refreshAllShipments|saveGatewayToken/,
  "dismissing the common Home banner adds neither a persistent setting nor network work");
assert.match(home, /\{accessKeyNotice \? \(\s*<Section listSectionMargins=\{0\} listSectionSpacing=\{16\} listSectionSeparator="hidden">\s*\{accessKeyNotice\}\s*<\/Section>\s*\) : null\}\s*\{shipments\.length \? \(/,
  "the notice has 16 points between sections and stays ahead of the shipment rows");
assert.match(banner, /listRowInsets=\{\{ top: 0, bottom: 0, leading: ROOT_PAGE_MARGIN, trailing: ROOT_PAGE_MARGIN \}\}/,
  "the notice and the filter use the same left and right inset");
console.log("Home Access Key notice copy, placement, dismissal, Settings entry and semantic theme checks passed");
