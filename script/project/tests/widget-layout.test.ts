import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mediumWidgetLayout,
  mediumWidgetPlacement,
  smallWidgetEmptyLayout,
  smallWidgetLayout,
} from "../widget/layout";
import {
  EMPTY_WIDGET_ACCENT,
  EMPTY_WIDGET_TEXT_COLOR,
  emptyWidgetBackground,
} from "../widget/palette";

const smallest = smallWidgetLayout(141);
assert.equal(smallest.outerPadding, 12);
assert.equal(smallest.headerSpacing, 4);
assert.equal(smallest.statusFont, 22);
assert.equal(smallest.detailFont, 12);
assert.equal(smallest.pillHeight, 40);
assert.equal(smallest.pillFont, 14);
assert.equal(smallest.pillIconFont, 13);
assert.equal(smallest.pillSpacing, 4);
assert.equal(smallest.pillHorizontalPadding, 5);
assert.ok(
  smallest.outerPadding * 2
    + smallest.iconSize
    + smallest.headerSpacing
    + 84 * 0.9
    <= 141,
  "compact header must fit the widest four-character status",
);
assert.ok(
  smallest.outerPadding * 2
    + smallest.pillHorizontalPadding * 2
    + smallest.pillIconFont + 3
    + smallest.pillSpacing
    + 85
    <= 141,
  "compact pill must fit a three-digit shipment total",
);

const regularSmall = smallWidgetLayout(158);
assert.equal(regularSmall.outerPadding, 14);
assert.equal(regularSmall.headerSpacing, 8);
assert.equal(regularSmall.pillHeight, smallest.pillHeight);
assert.equal(regularSmall.pillFont, 14);
assert.equal(regularSmall.pillIconFont, 14);
assert.equal(regularSmall.pillSpacing, 6);
assert.equal(regularSmall.pillHorizontalPadding, 11);

const compactEmpty = smallWidgetEmptyLayout(141, 148);
assert.equal(compactEmpty.padding, 12);
assert.equal(compactEmpty.searchSize, 24);
assert.equal(compactEmpty.searchFont, 18);
assert.equal(compactEmpty.vehicleSize, 68);
assert.equal(compactEmpty.labelFont, 16);
assert.equal(compactEmpty.contentSpacing, 4);
assert.equal(compactEmpty.headerHeight, 24);
assert.equal(compactEmpty.contentHeight, 100);
assert.equal(compactEmpty.contentCenterY, 86);
assert.equal(
  compactEmpty.contentCenterY,
  compactEmpty.padding
    + compactEmpty.headerHeight
    + compactEmpty.contentHeight / 2,
  "small empty content must center below its reserved search header",
);

const regularEmpty = smallWidgetEmptyLayout(158, 155);
assert.equal(regularEmpty.padding, 14);
assert.equal(regularEmpty.searchSize, 24);
assert.equal(regularEmpty.searchFont, 18);
assert.equal(regularEmpty.vehicleSize, 68);
assert.equal(regularEmpty.labelFont, 16);
assert.equal(regularEmpty.contentSpacing, 4);
assert.equal(regularEmpty.headerHeight, 24);
assert.equal(regularEmpty.contentHeight, 103);
assert.equal(regularEmpty.contentCenterY, 89.5);

assert.equal(EMPTY_WIDGET_ACCENT, "#3482FF");
assert.deepEqual(EMPTY_WIDGET_TEXT_COLOR, {
  light: "rgba(0, 0, 0, 0.3)",
  dark: "rgba(255, 255, 255, 0.3)",
});
const emptyBackground = emptyWidgetBackground();
assert.deepEqual(emptyBackground.light.startPoint, { x: 0, y: 1 });
assert.deepEqual(emptyBackground.light.endPoint, { x: 1, y: 0 });
assert.deepEqual(emptyBackground.dark.startPoint, { x: 0, y: 1 });
assert.deepEqual(emptyBackground.dark.endPoint, { x: 1, y: 0 });
assert.deepEqual(
  emptyBackground.light.gradient.map((stop) => stop.location),
  [0, 0.55, 1],
);

const compactMedium = mediumWidgetLayout(148);
assert.equal(compactMedium.rowLimit, 3);
assert.equal(compactMedium.iconSize, 32);
assert.equal(compactMedium.headerHeight, 25);
assert.equal(compactMedium.itemSpacing, 2);
assert.equal(compactMedium.verticalPadding, 10);
assert.equal(compactMedium.horizontalPadding, 12);
assert.equal(compactMedium.emptyVehicleSize, 68);
assert.equal(compactMedium.emptyLabelFont, 16);
assert.equal(compactMedium.emptyContentSpacing, 4);
assert.equal(compactMedium.emptyContentHeight, 101);
assert.equal(compactMedium.emptyContentCenterY, 87.5);
assert.ok(
  Math.abs(
    compactMedium.horizontalPadding - compactMedium.verticalPadding * 1.2,
  ) < Number.EPSILON * 100,
);
assert.ok(
  compactMedium.verticalPadding * 2
    + compactMedium.headerHeight
    + compactMedium.rowHeight * compactMedium.rowLimit
    + compactMedium.itemSpacing * compactMedium.rowLimit
    <= 148,
);

const regularMedium = mediumWidgetLayout(155);
assert.equal(regularMedium.rowLimit, 3);
assert.equal(regularMedium.iconSize, 33);
assert.equal(regularMedium.itemSpacing, 2);
assert.equal(regularMedium.verticalPadding, 12);
assert.equal(regularMedium.horizontalPadding, 14.4);
assert.equal(regularMedium.emptyVehicleSize, 68);
assert.equal(regularMedium.emptyLabelFont, 16);
assert.equal(regularMedium.emptyContentSpacing, 4);
assert.equal(regularMedium.emptyContentHeight, 104);
assert.equal(regularMedium.emptyContentCenterY, 91);
assert.ok(
  Math.abs(
    regularMedium.horizontalPadding - regularMedium.verticalPadding * 1.2,
  ) < Number.EPSILON * 100,
);
assert.ok(
  regularMedium.verticalPadding * 2
    + regularMedium.headerHeight
    + regularMedium.rowHeight * regularMedium.rowLimit
    + regularMedium.itemSpacing * regularMedium.rowLimit
    <= 155,
);

const oneRowPlacement = mediumWidgetPlacement(155, 1);
const twoRowPlacement = mediumWidgetPlacement(155, 2);
const threeRowPlacement = mediumWidgetPlacement(155, 3);
const overflowPlacement = mediumWidgetPlacement(155, 4);

assert.equal(oneRowPlacement.rowCount, 1);
assert.equal(twoRowPlacement.rowCount, 2);
assert.equal(threeRowPlacement.rowCount, 3);
assert.equal(overflowPlacement.rowCount, 3);
assert.equal(oneRowPlacement.detailLineLimit, null);
assert.equal(twoRowPlacement.detailLineLimit, 2);
assert.equal(threeRowPlacement.detailLineLimit, 1);
assert.equal(oneRowPlacement.rowFrameAlignment, "center");
assert.equal(twoRowPlacement.rowFrameAlignment, "center");
assert.equal(threeRowPlacement.rowFrameAlignment, "bottom");
assert.ok(oneRowPlacement.rowHeight > twoRowPlacement.rowHeight);
assert.ok(twoRowPlacement.rowHeight > threeRowPlacement.rowHeight);
assert.equal(
  oneRowPlacement.rowTopOffsets[0],
  twoRowPlacement.rowTopOffsets[0],
);
assert.equal(
  twoRowPlacement.rowTopOffsets[0],
  threeRowPlacement.rowTopOffsets[0],
);
assert.equal(threeRowPlacement.rowTopOffsets[0], 39);
assert.ok(
  Math.abs((threeRowPlacement.rowTopOffsets[1] || 0) - 74.33333333333334)
    < Number.EPSILON * 100,
);
assert.ok(
  Math.abs((threeRowPlacement.rowTopOffsets[2] || 0) - 109.66666666666667)
    < Number.EPSILON * 100,
);
assert.equal(oneRowPlacement.bottomSpace, 0);
assert.equal(twoRowPlacement.bottomSpace, 0);
assert.equal(threeRowPlacement.bottomSpace, 0);

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const smallSource = await readFile(
  resolve(projectDir, "widget/SmallWidget.tsx"),
  "utf8",
);
const mediumSource = await readFile(
  resolve(projectDir, "widget/MediumWidget.tsx"),
  "utf8",
);
const lineArtSource = await readFile(
  resolve(projectDir, "widget/WidgetLineArt.tsx"),
  "utf8",
);
const emptyVehicleSource = await readFile(
  resolve(projectDir, "components/EmptyDeliveryVehicle.tsx"),
  "utf8",
);

for (const asset of [
  "empty-small-light.png",
  "empty-small-dark.png",
  "empty-medium-light.png",
  "empty-medium-dark.png",
]) {
  const image = await readFile(resolve(projectDir, "assets/widget", asset));
  assert.deepEqual(
    [...image.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${asset} must be a packaged PNG asset`,
  );
}

const vehicleAsset = await readFile(
  resolve(projectDir, "assets/widget/empty-delivery-vehicle.png"),
);
assert.deepEqual(
  [...vehicleAsset.subarray(0, 8)],
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "empty delivery vehicle must be a packaged PNG asset",
);
assert.equal(
  vehicleAsset[25],
  6,
  "empty delivery vehicle must use RGBA instead of a baked background",
);
assert.ok(vehicleAsset.readUInt32BE(16) >= 256);
assert.ok(vehicleAsset.readUInt32BE(20) >= 256);

assert.match(
  smallSource,
  /const background = row[\s\S]*?mediumWidgetBackground\([\s\S]*?: emptyWidgetBackground\(\);[\s\S]*?widgetBackground=\{background\}/,
  "small must keep its carrier/empty gradient inside one shared layered container",
);
assert.match(
  lineArtSource,
  /empty-\$\{props\.family\}-light\.png[\s\S]*?empty-\$\{props\.family\}-dark\.png[\s\S]*?opacity=\{0\.22\}/,
  "small widget must use the shared light/dark line art at 22% opacity",
);
assert.equal(
  smallSource.match(/<WidgetLineArt family="small" \/>/g)?.length,
  1,
  "small empty and populated states must share one line-art layer",
);
assert.match(
  smallSource,
  /const emptyLayout = smallWidgetEmptyLayout\(\s*props\.displayWidth,\s*props\.displayHeight,\s*\);/,
  "small empty placement must use the actual widget height",
);
assert.match(
  smallSource,
  /<Link url=\{props\.openSearchURL\}>\s*<VStack\s+spacing=\{0\}\s+padding=\{emptyLayout\.padding\}[\s\S]*?<HStack[\s\S]*?minHeight: emptyLayout\.headerHeight,[\s\S]*?maxHeight: emptyLayout\.headerHeight,[\s\S]*?<Image[\s\S]*?systemName="magnifyingglass"/,
  "small empty state must reserve a real top header for search",
);
assert.match(
  smallSource,
  /<ZStack[\s\S]*?minHeight: emptyLayout\.contentHeight,[\s\S]*?maxHeight: emptyLayout\.contentHeight,[\s\S]*?alignment: "center",[\s\S]*?<EmptyDeliveryStateGroup\s+vehicleSize=\{emptyLayout\.vehicleSize\}\s+spacing=\{emptyLayout\.contentSpacing\}\s+labelFont=\{emptyLayout\.labelFont\}\s*\/>/,
  "small group must be centered only in the body below the search header",
);
const smallPopulatedBranchStart = smallSource.indexOf("{row ? (");
const smallEmptyBranchStart = smallSource.indexOf(
  ") : (",
  smallPopulatedBranchStart,
);
assert.ok(
  smallPopulatedBranchStart >= 0 && smallEmptyBranchStart > smallPopulatedBranchStart,
);
const smallEmptyBranch = smallSource.slice(smallEmptyBranchStart);
assert.doesNotMatch(
  smallEmptyBranch,
  /labelBottomPadding|padding=\{\{\s*bottom:/,
  "small empty content must use frame alignment instead of spacer or bottom-padding offsets",
);
assert.match(
  smallSource,
  /font=\{layout\.statusFont\}[\s\S]*?lineLimit=\{1\}[\s\S]*?minScaleFactor=\{0\.9\}[\s\S]*?allowsTightening=\{true\}/,
  "compact populated status must remain complete after the larger outer padding",
);
assert.doesNotMatch(smallSource, /点击查询|empty-small-panel|EmptyParcelIcon/);

assert.match(
  mediumSource,
  /const background = leadingRow[\s\S]*?mediumWidgetBackground\([\s\S]*?: emptyWidgetBackground\(\);[\s\S]*?widgetBackground=\{background\}/,
  "medium must switch backgrounds inside one shared layered container",
);
assert.match(
  lineArtSource,
  /empty-\$\{props\.family\}-light\.png[\s\S]*?empty-\$\{props\.family\}-dark\.png[\s\S]*?opacity=\{0\.22\}/,
  "medium widget must use the shared light/dark line art at 22% opacity",
);
assert.equal(
  mediumSource.match(/<WidgetLineArt family="medium" \/>/g)?.length,
  1,
  "medium empty and populated states must share one line-art layer",
);
assert.match(
  mediumSource,
  /<Text font=\{15\} fontWeight="semibold">我的快递<\/Text>/,
  "medium empty and populated states must share the populated title",
);
assert.match(
  mediumSource,
  /<Text font=\{15\} fontWeight="semibold">\s*\{snapshot\.activeCount\}\s*<\/Text>/,
  "medium header count must come from the same snapshot in every state",
);
assert.match(
  mediumSource,
  /systemName="magnifyingglass"[\s\S]*?foregroundStyle=\{accent\}/,
  "medium search must use the same accent source as its gradient",
);
assert.equal(
  mediumSource.match(/systemName="magnifyingglass"/g)?.length,
  1,
  "medium must render one shared search control",
);
assert.match(
  mediumSource,
  /<ZStack[\s\S]*?minHeight: layout\.emptyContentHeight,[\s\S]*?maxHeight: layout\.emptyContentHeight,[\s\S]*?alignment: "center",[\s\S]*?<EmptyDeliveryStateGroup\s+vehicleSize=\{layout\.emptyVehicleSize\}\s+spacing=\{layout\.emptyContentSpacing\}\s+labelFont=\{layout\.emptyLabelFont\}\s*\/>/,
  "medium group must be centered only below the shared header",
);
assert.doesNotMatch(
  mediumSource,
  /快递动态|暂无快递，点击查询|empty-medium-panel|EmptyParcelIcon/,
);
assert.match(
  emptyVehicleSource,
  /empty-delivery-vehicle\.png[\s\S]*?renderingMode="original"[\s\S]*?resizable=\{true\}[\s\S]*?scaleToFit=\{true\}/,
  "vehicle artwork must preserve its colors and aspect ratio",
);
assert.match(
  mediumSource,
  /padding=\{\{\s*horizontal: layout\.horizontalPadding,\s*vertical: layout\.verticalPadding,/,
  "medium widget must apply the adaptive horizontal and vertical outer padding",
);
assert.equal(
  mediumSource.match(
    /padding=\{\{\s*horizontal: layout\.horizontalPadding,\s*vertical: layout\.verticalPadding,/g,
  )?.length,
  1,
  "medium empty and populated layouts must share one outer padding ratio",
);
assert.match(
  mediumSource,
  /snapshot\.rows\.slice\(0, placement\.rowCount\)/,
  "medium widget must keep the three-row layout limit",
);
assert.match(
  mediumSource,
  /<HStack\s+alignment="top"[\s\S]*?minHeight: props\.height,\s+maxHeight: props\.height,[\s\S]*?alignment: props\.frameAlignment,/,
  "medium rows must preserve top-aligned content inside the adaptive frame",
);
assert.match(
  mediumSource,
  /height=\{placement\.rowHeight\}/,
  "medium widget must apply the adaptive row height",
);
assert.match(
  mediumSource,
  /detailLineLimit=\{placement\.detailLineLimit\}/,
  "medium widget must apply the adaptive detail line policy",
);
assert.match(
  mediumSource,
  /frameAlignment=\{placement\.rowFrameAlignment\}/,
  "medium widget must bottom-align the full three-row layout",
);
assert.match(
  mediumSource,
  /props\.detailLineLimit == null \? \(\s*<Text font=\{13\} foregroundStyle="secondaryLabel">/,
  "the single-row branch must omit lineLimit so the latest detail can use all available height",
);
assert.doesNotMatch(
  mediumSource,
  /padding=\{\{ vertical: 2 \}\}/,
  "row frames already own the complete vertical budget",
);
const populatedBranchStart = mediumSource.indexOf("{leadingRow ? (");
const emptyBranchStart = mediumSource.indexOf(") : (", populatedBranchStart);
assert.ok(populatedBranchStart >= 0 && emptyBranchStart > populatedBranchStart);
assert.doesNotMatch(
  mediumSource.slice(populatedBranchStart, emptyBranchStart),
  /<Spacer \/>/,
  "the populated height budget must not add an uncounted trailing spacer",
);

console.log("widget responsive layout tests passed");
