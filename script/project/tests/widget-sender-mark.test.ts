import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { widgetIdentityText } from "../services/carrier-presentation";

// Owner 2026-11-20: an outgoing parcel's widgets carry a small gray 寄 tag. The 2×2, titled by its
// status, puts it after the status word; the 4×2 puts it after the waybill tail
// (「4×2 也改成灰色标签放尾号后面」), so its identity line no longer carries the plain-text 「 · 寄」.
const senderRow = { companyName: "顺丰速运", waybillSuffix: "0361", sender: true };
assert.equal(widgetIdentityText(senderRow), "顺丰速运 0361", "the 4×2 identity line stays 「承运商 尾号」");
assert.equal(widgetIdentityText({ ...senderRow, sender: false }), "顺丰速运 0361");
assert.equal(widgetIdentityText({ companyName: "顺丰速运", waybillSuffix: "0361" }), "顺丰速运 0361",
  "a snapshot saved before the flag existed reads as an incoming parcel");
assert.equal(widgetIdentityText({ ...senderRow, waybillSuffix: "" }), "顺丰速运");

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

// Shared neutral light-capsule tag across both sizes (owner 2026-11-27): 12%/22% gray fill and gray
// ink matching the status capsule style, 3-point continuous corners, stepped down 1pt, never compressed.
const tagSource = source("../widget/WidgetSenderTag.tsx");
const tag = tagSource.match(/export function WidgetSenderTag\(props: \{[\s\S]*?\}\) \{\s*const style = widgetSenderTagStyle\(props\.brandAccent\);\s*return \(\s*(<Text[\s\S]*?<\/Text>)\s*\);\s*\}/);
assert.ok(tag, "the shared tag always returns its Text");
assert.match(tag[1], /font=\{props\.font\}/);
assert.match(tag[1], /foregroundStyle=\{style\.foreground\}/);
assert.match(tag[1], /padding=\{\{ horizontal: 3\.5, vertical: props\.verticalPadding \}\}/);
assert.match(tag[1], /background=\{style\.background\}/);
assert.match(tag[1], /cornerRadius: 3,\s*style: "continuous"/);
assert.match(tag[1], /lineLimit=\{1\}/);
assert.match(tag[1], /fixedSize=\{\{ horizontal: true, vertical: true \}\}/);
assert.match(tag[1], /layoutPriority=\{1\}/);
assert.match(tag[1], />\s*寄\s*<\/Text>/);

// 2×2: the tag follows the status word stepped down 1pt below the carrier line; the identity line stays plain.
const small = source("../widget/SmallWidget.tsx");
assert.match(small,
  /\{row\.statusLabel\}\s*<\/Text>\s*\{row\.sender === true \? \(\s*<WidgetSenderTag font=\{layout\.companyFont - 1\} verticalPadding=\{1\} \/>\s*\) : null\}\s*<\/HStack>/,
  "the tag directly follows the status word");
assert.match(small, /<HStack alignment="center" spacing=\{4\}/, "4 points after the status word");
assert.doesNotMatch(small, /" · 寄"/, "the 2×2 does not use the plain-text mark");
assert.doesNotMatch(small, /SenderBadge/);
assert.doesNotMatch(small, /widgetIdentityText/);

// 4×2: the tag follows the waybill tail 4 points after it, stepped down 1pt (10pt / 1.5pt vertical)
// relative to the 11pt / 2pt status capsule while sharing its light-capsule style; the capsule keeps its 6-point gap.
const medium = source("../widget/MediumWidget.tsx");
const identity = medium.match(
  /<HStack spacing=\{6\} frame=\{\{ maxWidth: "infinity" \}\}>[\s\S]*?<HStack spacing=\{4\}>\s*<Text font=\{15\} fontWeight="semibold" monospacedDigit lineLimit=\{1\}>\s*\{widgetIdentityText\(props\.row\)\}\s*<\/Text>\s*\{props\.row\.sender === true \? \(\s*<WidgetSenderTag font=\{(\d+)\} verticalPadding=\{([0-9.]+)\} brandAccent=\{props\.brandAccent\} \/>\s*\) : null\}\s*<\/HStack>\s*(<Text[\s\S]*?<\/Text>)\s*<Spacer \/>\s*<\/HStack>/,
);
assert.ok(identity, "the tag follows the identity line and precedes the status capsule");
const [, tagFont, tagVerticalPadding, capsule] = identity;
assert.match(capsule, /\{withNote\(props\.row\.statusLabel, props\.row\.note\)\}/);
assert.equal(capsule.match(/font=\{(\d+)\}/)?.[1], "11");
assert.equal(tagFont, "10", "the tag steps down 1pt below the status capsule for optical balance");
assert.equal(tagVerticalPadding, "1.5");
assert.match(capsule, /cornerRadius: 3,/);
// The tag alone is protected (fixed size, priority inside the identity group). The capsule has no
// priority of its own, so an outgoing row shares the width between identity and capsule exactly
// like any other row; the owner moved the mark, not the truncation.
assert.doesNotMatch(capsule, /layoutPriority/, "the status capsule keeps its earlier sizing on every row");
const identityGroup = medium.match(/<HStack spacing=\{4\}>[\s\S]*?<\/HStack>/)?.[0] ?? "";
assert.doesNotMatch(identityGroup.replace(/<WidgetSenderTag[^>]*\/>/, ""), /layoutPriority|fixedSize/,
  "the identity text itself gains no priority");
assert.doesNotMatch(medium, /· 寄/, "the 4×2 no longer uses the plain-text mark");
assert.doesNotMatch(medium, /SenderBadge/);
console.log("Widget sender mark passed");
