import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const detailPage = readFileSync(
  join(projectRoot, "pages/DetailPage.tsx"),
  "utf8",
);

assert.ok(detailPage.includes("const result = await copyText(waybill);"));
assert.equal(detailPage.includes("Required Permissions"), false);
assert.ok(detailPage.includes('systemName="doc.on.doc"'));
assert.ok(detailPage.includes("link: `tel:${hotline}`"));
assert.equal(detailPage.includes("<Link url={`tel:${hotline}`}>"), false);

const waybillRowStart = detailPage.indexOf(
  '<HStack\n              alignment="center"\n              spacing={0}\n              frame={{ maxWidth: "infinity", alignment: "leading" }}',
);
const waybillRowEnd = detailPage.indexOf("</HStack>", waybillRowStart);
assert.ok(waybillRowStart >= 0 && waybillRowEnd > waybillRowStart);
const waybillRow = detailPage.slice(waybillRowStart, waybillRowEnd);
assert.ok(
  waybillRow.includes(
    'frame={{ maxWidth: "infinity", alignment: "leading" }}',
  ),
  "the full waybill row must stay aligned with the leading shipment text",
);
const waybillValue = waybillRow.indexOf("{waybill}");
const waybillText = waybillRow.slice(
  waybillRow.lastIndexOf("<Text", waybillValue),
  waybillRow.indexOf("</Text>", waybillValue) + "</Text>".length,
);
assert.equal(
  waybillText.includes('maxWidth: "infinity"'),
  false,
  "the waybill text must keep its intrinsic width so copy follows immediately",
);
assert.ok(
  waybillRow.includes(
    '<Text font={15}>{shipment.identity.companyName}：</Text>',
  ),
);
assert.ok(waybillRow.includes('<HStack alignment="center" spacing={5}>'));
assert.ok(waybillRow.includes("{waybill}"));
assert.equal(
  waybillRow.includes("{shipment.identity.companyName}：{waybill}"),
  false,
  "the carrier label and waybill must use separate zero-spacing text nodes",
);
assert.ok(waybillRow.includes("action={copyWaybill}"));
assert.ok(waybillRow.includes("lineLimit={1}"));
assert.ok(waybillRow.includes("minScaleFactor={0.65}"));
assert.ok(waybillRow.includes("allowsTightening={true}"));
assert.ok(waybillRow.includes("layoutPriority={1}"));
assert.equal(waybillRow.includes("<Spacer />"), false);

console.log("detail page interaction contract tests passed");
