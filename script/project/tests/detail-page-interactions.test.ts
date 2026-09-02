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
    '<Text font={15}>{detailCompanyName}：</Text>',
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
assert.match(
  detailPage,
  /const refreshAbortRef = useRef<AbortController \| null>\(null\)/,
);
assert.match(
  detailPage,
  /return \(\) => \{[\s\S]*?refreshAbortRef\.current\?\.abort\(\)/,
  "leaving detail must cancel its hidden WebView and fallback work",
);
assert.match(
  detailPage,
  /const controller = new AbortController\(\)[\s\S]*?signal: controller\.signal/,
);
assert.match(
  detailPage,
  /props\.refreshOnAppear === "manual_submit" &&[\s\S]*?props\.manualPreview\?\.roundComplete === false[\s\S]*?await continueManualShipmentPreview\(props\.manualPreview, \{\s*signal: controller\.signal,?\s*\}\)/,
  "the just-submitted Picker preview must stay on the current detail page while its first round continues",
);
assert.match(
  detailPage,
  /forceManualRefresh \|\| props\.refreshOnAppear === "identity_projection"/,
  "an unprojected JD detail open must force one identity H5 retry",
);
assert.match(
  detailPage,
  /includeKdniaoFallback:[\s\S]*?forceManualRefresh \|\|[\s\S]*?props\.refreshOnAppear === "manual_submit" \|\|[\s\S]*?props\.refreshOnAppear === "detail_open"/,
  "an eligible ordinary automatic detail open must enable the final fallback",
);
assert.ok(detailPage.includes("selectShipmentDetailTimeline(shipment)"));
assert.ok(
  detailPage.includes("shipmentDetailPresentationStatus("),
  "manual details must derive status from the displayed timeline while automatic shipments keep source ownership",
);
assert.equal(
  detailPage.includes("timeline: detailTimeline"),
  false,
  "the selected detail timeline must not replace the source timeline for status presentation",
);
assert.ok(
  detailPage.includes("statusTint(presentationStatus.semantic)"),
  "the current-track indicator must use the same presentation status as the detail header",
);
assert.equal(
  detailPage.includes("statusTint(detailTimeline.semantic)"),
  false,
  "the detail track provider must not own status coloring",
);
assert.ok(detailPage.includes("轨迹不完整时，可尝试下拉刷新。"));
assert.match(
  detailPage,
  /useState\([\s\S]*?props\.refreshOnAppear === "manual_submit"[\s\S]*?loadingManualDetail[\s\S]*?轨迹详情正在加载中。/,
  "only a just-submitted manual query may show the initial detail-loading hint",
);
assert.match(
  detailPage,
  /const hasUsableDetail =[\s\S]*?selectShipmentDetailTimeline\(\s*result\.shipment,?\s*\)\.tracks\.some[\s\S]*?props\.refreshOnAppear === "manual_submit"[\s\S]*?manualDetailRefreshToast\(\s*result\.refreshed,\s*hasUsableDetail,?\s*\)/,
  "a manual-detail page must report success only when background enrichment committed usable tracks",
);
assert.ok(detailPage.includes("暂未获取到可用轨迹"));
assert.ok(detailPage.includes("当前轨迹已是最新"));
assert.equal(
  detailPage.includes("result.feedback"),
  false,
  "provider-specific background feedback must not override the page-level result",
);
assert.equal(
  detailPage.includes("轨迹更新失败，已显示本地缓存"),
  false,
  "a usable cached timeline must not produce a failure toast",
);
assert.match(
  detailPage,
  /catch \(error\)[\s\S]*?const errorDetails = diagnosticErrorDetails\(error\)[\s\S]*?if \(errorDetails\.errorCategory === "removed"\) return[\s\S]*?writeDiagnostic\("detail\.refresh\.ui_failed"[\s\S]*?errorDetails[\s\S]*?if \(!displayTracks\.length\)[\s\S]*?setNotice\("轨迹更新失败，请稍后重试"\)/,
  "a pre-dispatch detail failure must remain diagnosable instead of disappearing behind the toast",
);
assert.match(
  detailPage,
  /<Section[\s\S]*?header=\{<Text>物流轨迹<\/Text>\}[\s\S]*?footer=\{\(/,
  "the refresh hint must be the timeline section footer",
);
assert.equal(
  detailPage.includes('fill="separator"'),
  false,
  "the refresh hint must not add a separator",
);
assert.equal(
  detailPage.includes("<Rectangle"),
  false,
  "the refresh hint must not add its own card or line",
);

console.log("detail page interaction contract tests passed");
