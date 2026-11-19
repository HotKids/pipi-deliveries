import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../pages/HomePage.tsx", import.meta.url), "utf8");
const bannerStart = home.indexOf("const accessKeyNotice = showAccessKeyNotice");
const banner = home.slice(bannerStart, home.indexOf("\n  return (", bannerStart));
assert.match(home, /const showAccessKeyNotice = accessKeyRejected && !accessKeyNoticeDismissed;/);
assert.ok(banner.includes("Access Key 已失效，请通过 TG Bot 重新获取。"));
assert.match(home, /useState\(gatewayAccessKeyRejected\)/);
assert.match(home, /return subscribeGatewayAccessKeyRejected\(setAccessKeyRejected\)/);
assert.match(home, /\[accessKeyNoticeDismissed, setAccessKeyNoticeDismissed\] = useState\(false\)/);
assert.match(banner, /action=\{\(\) => setAccessKeyNoticeDismissed\(true\)\}/);
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
console.log("Home Access Key notice copy, placement, dismissal and semantic theme checks passed");
