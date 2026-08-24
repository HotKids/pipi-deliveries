import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(
  resolve(projectDir, "pages/PhoneBindingPage.tsx"),
  "utf8",
);

assert.match(source, /const inputRowHeight = 50;/);
assert.match(
  source,
  /title="手机号"[\s\S]*?frame=\{\{ minHeight: inputRowHeight, maxHeight: inputRowHeight, maxWidth: "infinity" \}\}[\s\S]*?overlay=\{\{[\s\S]*?alignment: "bottom"[\s\S]*?content: \([\s\S]*?<Divider[\s\S]*?frame=\{\{ minHeight: 1, maxHeight: 1, maxWidth: "infinity" \}\}[\s\S]*?\/>[\s\S]*?\)[\s\S]*?\}\}/,
  "the phone row must own a full-width one-point bottom divider without changing its height",
);
assert.match(
  source,
  /<HStack[\s\S]*?frame=\{\{ minHeight: inputRowHeight, maxHeight: inputRowHeight, maxWidth: "infinity" \}\}[\s\S]*?title="验证码"[\s\S]*?frame=\{\{ minHeight: inputRowHeight, maxHeight: inputRowHeight, maxWidth: "infinity" \}\}/,
  "the verification row and field must match the phone field height",
);
assert.match(
  source,
  /<HStack[\s\S]*?frame=\{\{ maxWidth: "infinity", alignment: "center" \}\}[\s\S]*?<Button[\s\S]*?action=\{bindPhone\}[\s\S]*?disabled=\{!canBind\}[\s\S]*?buttonStyle="borderedProminent"[\s\S]*?buttonBorderShape="capsule"[\s\S]*?<Text[\s\S]*?frame=\{\{ minWidth: 220, minHeight: 44 \}\}[\s\S]*?>[\s\S]*?\{binding \? "绑定中…" : "绑定"\}[\s\S]*?<\/Text>[\s\S]*?<\/Button>[\s\S]*?<\/HStack>/,
  "the primary capsule must use a stable wide label inside a full-width centered row, including while disabled",
);
assert.doesNotMatch(
  source,
  /title=\{binding \? "绑定中…" : "绑定"\}/,
  "the primary capsule width must come from its custom label, not an outer Button frame",
);
assert.match(
  source,
  /隐私声明：绑定的手机号仅用于查询快递，不作其他用途。/,
);
assert.doesNotMatch(source, /手机号仅用于验证并查询关联快递/);

console.log("phone binding layout tests passed");
