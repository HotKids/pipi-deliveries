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
// 官方电话走系统拨号；打不开按三端统一表提示（AGENTS §11 第 16 行）。
assert.ok(detailPage.includes("await dialPhone(hotline)"));
assert.ok(detailPage.includes("Safari.openURL(`tel:${phone}`)"));
assert.ok(detailPage.includes("EXPRESS_TOAST_COPY.dialUnavailable"));
assert.equal(detailPage.includes("link: `tel:${hotline}`"), false);
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
  /props\.refreshOnAppear === "manual_submit" &&[\s\S]*?props\.manualPreview\?\.roundComplete === false[\s\S]*?await continueManualShipmentPreview\(props\.manualPreview, \{\s*signal: controller\.signal,\s*onPreview:/,
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
  /useState\([\s\S]*?props\.refreshOnAppear === "manual_submit"[\s\S]*?loadingManualDetail[\s\S]*?完整轨迹加载中/,
  "only a just-submitted manual query may show the initial detail-loading hint",
);
assert.match(
  detailPage,
  /const hasUsableDetail =[\s\S]*?selectShipmentDetailTimeline\(\s*result\.shipment,?\s*\)\.tracks\.some[\s\S]*?props\.refreshOnAppear === "manual_submit"[\s\S]*?manualDetailRefreshToast\(\s*result\.refreshed,\s*hasUsableDetail,?\s*\)/,
  "a manual-detail page must report success only when background enrichment committed usable tracks",
);
// 详情下拉的结果只能从共享文案表取（AGENTS §11）：页面不再写自由文案。
assert.ok(detailPage.includes("detailPullToast(result.refreshed, hasUsableDetail)"));
assert.ok(detailPage.includes("EXPRESS_TOAST_COPY.detailRefreshFailed"));
assert.equal(detailPage.includes("暂未获取到可用轨迹"), false);
assert.equal(detailPage.includes("当前轨迹已是最新"), false);
assert.equal(
  detailPage.includes("result.feedback"),
  false,
  "provider-specific background feedback must not override the page-level result",
);
// AGENTS §11 (2026-09-03): unified express toasts travel as a typed key and render only through
// the shared copy table, so the wording stays byte-identical with Pipi and Lite.
assert.ok(
  detailPage.includes("EXPRESS_TOAST_COPY[result.expressToast]"),
  "unified express toasts must render from the shared copy table by key",
);
assert.equal(
  detailPage.includes("轨迹更新失败，已显示本地缓存"),
  false,
  "a usable cached timeline must not produce a failure toast",
);
assert.match(
  detailPage,
  /catch \(error\)[\s\S]*?const errorDetails = diagnosticErrorDetails\(error\)[\s\S]*?if \(errorDetails\.errorCategory === "removed"\) return[\s\S]*?writeDiagnostic\("detail\.refresh\.ui_failed"[\s\S]*?errorDetails[\s\S]*?if \(forceManualRefresh \|\| !displayTracks\.length\)[\s\S]*?setNotice\(EXPRESS_TOAST_COPY\.detailRefreshFailed\)/,
  "a pre-dispatch detail failure must remain diagnosable instead of disappearing behind the toast",
);
assert.match(
  detailPage,
  /<Section[\s\S]*?header=\{[\s\S]*?物流信息来自[\s\S]*?\}[\s\S]*?footer=\{\(/,
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

// AGENTS §11: the detail sheet reads the same carrier identity the list, widget and notifications
// read, and repairProjectedShipmentCarrier maintains. A package-local carrier is a snapshot of the
// grab, so reading it here resurrects the leaked JD order-stage carrier the D-6 repair removed.
assert.equal(
  detailPage.includes("usesKuaidi100Detail"),
  false,
  "the detail header must not switch carrier presentation by timeline provider",
);
assert.equal(
  /detailTimeline\.(courierCode|companyName)/.test(detailPage),
  false,
  "the selected detail package must not own carrier presentation",
);
assert.match(
  detailPage,
  /courierHotline\(\s*shipment\.identity\.courierCode,\s*shipment\.identity\.companyName,?\s*\)/,
  "the hotline must resolve from the maintained identity carrier",
);
assert.match(
  detailPage,
  /courierCode=\{shipment\.identity\.courierCode\}\s*companyName=\{shipment\.identity\.companyName\}\s*accountOrder=\{Boolean\(\s*unprojectedAccountOrder\(shipment\),?\s*\)\}/,
  "the detail icon must match ShipmentRow's identity-only carrier and account-order inputs",
);

// AGENTS §11: `detailEffectiveTrackCount` is one counted number across the client — sync.ts and
// Pipi's ExpressDetailTimelinePolicy.timedTrackCount both count timed nodes — while the rendered
// list keeps every row the source returned (AGENTS §9), so the two must not be the same expression.
assert.match(
  detailPage,
  /const effectiveTrackCount = timedTracks\(detailTimeline\.tracks\)\.length;/,
  "the logged detail track count must come from timedTracks, like sync.ts and Pipi",
);
assert.match(
  detailPage,
  /detailEffectiveTrackCount: effectiveTrackCount,\s*result: effectiveTrackCount === 0\s*\?\s*"no_result"/,
  "the no_result gate must read the same counted number as the logged count",
);
assert.equal(
  detailPage.includes("detailEffectiveTrackCount: displayTracks.length"),
  false,
  "the display list keeps untimed rows and must never be the counted number",
);
assert.match(
  detailPage,
  /const selectionSignature = \[[\s\S]*?String\(displayTracks\.length\),\s*String\(effectiveTrackCount\),/,
  "the re-emit signature must notice a counted number that changed on its own",
);
assert.match(
  detailPage,
  /\{time\.time \|\| "--:--"\}/,
  "untimed source rows must still render (AGENTS §9)",
);

console.log("detail page interaction contract tests passed");
