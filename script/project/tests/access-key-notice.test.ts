import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const home = readFileSync(new URL("../pages/HomePage.tsx", import.meta.url), "utf8");
const banner = home.slice(home.indexOf("{accessKeyRejected && !accessKeyNoticeDismissed"),
  home.indexOf("{shipments.length ? ("));
assert.ok(banner.includes("Access Key 已失效，请通过 TG Bot 重新获取。"));
assert.match(home, /useState\(gatewayAccessKeyRejected\)/);
assert.match(home, /return subscribeGatewayAccessKeyRejected\(setAccessKeyRejected\)/);
assert.match(home, /\[accessKeyNoticeDismissed, setAccessKeyNoticeDismissed\] = useState\(false\)/);
assert.match(banner, /action=\{\(\) => setAccessKeyNoticeDismissed\(true\)\}/);
assert.match(banner, /background="secondarySystemBackground"/);
assert.match(banner, /systemName="xmark"[\s\S]*?foregroundStyle="secondaryLabel"/);
assert.match(banner, /frame=\{\{ width: 48, height: 48 \}\}/);
assert.match(banner, /cornerRadius: 20/);
assert.equal((banner.match(/foregroundStyle="secondaryLabel"/g) ?? []).length, 2);
assert.doesNotMatch(banner, /Storage|Keychain|fetch|postGateway|refreshAllShipments|saveGatewayToken/,
  "dismissing the common Home banner adds neither a persistent setting nor network work");
assert.ok(home.indexOf("{accessKeyRejected &&") < home.indexOf("{shipments.length ? ("),
  "the notice sits above both populated and empty Home content");
console.log("Home Access Key notice copy, placement, dismissal and semantic theme checks passed");
