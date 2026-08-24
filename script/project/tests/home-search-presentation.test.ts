import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const homeSource = await readFile(
  resolve(projectDir, "pages/HomePage.tsx"),
  "utf8",
);
const manualQuerySource = await readFile(
  resolve(projectDir, "services/manual-query.ts"),
  "utf8",
);

assert.match(homeSource, /detectManualCarrier/);
assert.match(
  homeSource,
  /const \[detectedCarrier, setDetectedCarrier\] = useState</,
);
assert.match(
  homeSource,
  /function scheduleCarrierDetection\(value: string\)[\s\S]*?detectManualCarrier\(normalized\)[\s\S]*?setDetectedCarrier/,
  "carrier detection must be driven independently from form submission",
);
assert.match(
  homeSource,
  /onChanged=\{\(value\) => \{[\s\S]*?scheduleCarrierDetection\(value\)[\s\S]*?\{detectedCarrier \? \([\s\S]*?<Button[\s\S]*?\{detectedCarrier\.companyName\}/,
  "typing must automatically resolve a carrier and expose it as the query action",
);
assert.doesNotMatch(homeSource, />\s*查询\s*<\/Text>/);
assert.doesNotMatch(homeSource, /自动识别|识别中…|无法识别/);
assert.match(homeSource, /submitLabel="search"/);
assert.match(
  homeSource,
  /onSubmit=\{\{[\s\S]*?triggers: "text"[\s\S]*?action: \(\) => \{[\s\S]*?void query\(\)/,
  "the keyboard search key must use the explicit text submit trigger",
);
assert.doesNotMatch(
  homeSource,
  /onSubmit=\{[\s\S]{0,180}?if \(canQuery\)/,
  "submission must not be dropped by a stale rendered canQuery value",
);
assert.match(
  homeSource,
  /prompt="请输入 4 位手机尾号"[\s\S]*?submitLabel="search"[\s\S]*?onSubmit=\{\{[\s\S]*?triggers: "text"/,
  "the inline phone-tail field must submit the same query from the keyboard",
);

assert.match(
  manualQuerySource,
  /export async function detectManualCarrier[\s\S]*?"\/api\/express\/classify"/,
  "carrier detection must reuse the canonical classify route",
);

console.log("home search carrier presentation tests passed");
