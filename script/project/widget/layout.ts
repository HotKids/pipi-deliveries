export type SmallWidgetLayout = {
  outerPadding: number;
  headerSpacing: number;
  statusFont: number;
  companyFont: number;
  identitySpacing: number;
  statusLineHeight: number;
  companyLineHeight: number;
  detailFont: number;
  iconSize: number;
  pillHeight: number;
  pillFont: number;
  pillIconFont: number;
  pillSpacing: number;
  pillHorizontalPadding: number;
};

export type SmallWidgetEmptyLayout = {
  padding: number;
  searchFont: number;
  searchWidth: number;
  searchHeight: number;
  searchTopPadding: number;
  searchTrailingPadding: number;
  headerHeight: number;
  contentHeight: number;
  contentCenterY: number;
  vehicleSize: number;
  labelFont: number;
  contentSpacing: number;
};

export type MediumWidgetLayout = {
  rowLimit: number;
  horizontalPadding: number;
  verticalPadding: number;
  headerHeight: number;
  searchFont: number;
  searchWidth: number;
  rowHeight: number;
  iconSize: number;
  detailFont: number;
  itemSpacing: number;
  emptyVehicleSize: number;
  emptyLabelFont: number;
  emptyContentSpacing: number;
  emptyContentHeight: number;
  emptyContentCenterY: number;
};

function populatedDetailFont(compact: boolean): number {
  return compact ? 12 : 13;
}

export type MediumWidgetPlacement = {
  rowCount: number;
  rowHeight: number;
  rowFrameAlignment: "center" | "bottom";
  detailLineLimit: number | null;
  rowTopOffsets: number[];
  bottomSpace: number;
};

type WidgetSearchLayout = {
  font: number;
  width: number;
  height: number;
  topPadding: number;
  trailingPadding: number;
};

function widgetSearchLayout(height: number): WidgetSearchLayout {
  const compact = Number.isFinite(height) && height < 155;
  const topPadding = compact ? 10 : 12;
  return {
    font: 18,
    width: 20,
    height: 25,
    topPadding,
    trailingPadding: Number((topPadding * 1.2).toFixed(1)),
  };
}

export function smallWidgetLayout(
  width: number,
  height: number,
): SmallWidgetLayout {
  const compactWidth = Number.isFinite(width) && width <= 148;
  const compact = compactWidth
    || (Number.isFinite(height) && height < 155);
  const iconSize = compact ? 38 : 42;
  const identitySpacing = 1;
  const statusLineHeight = iconSize * 0.6;
  return {
    outerPadding: compact ? 12 : 14,
    headerSpacing: compact ? 8 : 9,
    statusFont: 20,
    companyFont: 12,
    identitySpacing,
    statusLineHeight,
    companyLineHeight: iconSize - identitySpacing - statusLineHeight,
    detailFont: populatedDetailFont(compact),
    iconSize,
    pillHeight: 40,
    pillFont: 14,
    pillIconFont: compactWidth ? 13 : 14,
    pillSpacing: compactWidth ? 4 : 6,
    pillHorizontalPadding: compactWidth ? 5 : 11,
  };
}

export function smallWidgetEmptyLayout(
  width: number,
  height: number,
): SmallWidgetEmptyLayout {
  const compact = Number.isFinite(width) && width <= 148;
  const padding = compact ? 12 : 14;
  const search = widgetSearchLayout(height);
  const headerHeight = 24;
  const resolvedHeight = Number.isFinite(height) && height > 0
    ? height
    : compact ? 148 : 155;
  const contentHeight = Math.max(
    0,
    resolvedHeight - padding * 2 - headerHeight,
  );
  return {
    padding,
    searchFont: search.font,
    searchWidth: search.width,
    searchHeight: search.height,
    searchTopPadding: search.topPadding,
    searchTrailingPadding: search.trailingPadding,
    headerHeight,
    contentHeight,
    contentCenterY: padding + headerHeight + contentHeight / 2,
    vehicleSize: 68,
    labelFont: 16,
    contentSpacing: 4,
  };
}

export function mediumWidgetLayout(height: number): MediumWidgetLayout {
  const search = widgetSearchLayout(height);
  const compact = search.topPadding === 10;
  const resolvedHeight = Number.isFinite(height) && height > 0
    ? height
    : compact ? 148 : 155;
  const verticalPadding = search.topPadding;
  const horizontalPadding = search.trailingPadding;
  const headerHeight = search.height;
  const itemSpacing = 2;
  const rowLimit = 3;
  const rowHeight = (
    resolvedHeight
      - verticalPadding * 2
      - headerHeight
      - itemSpacing * rowLimit
  ) / rowLimit;
  const emptyContentHeight = Math.max(
    0,
    resolvedHeight - verticalPadding * 2 - headerHeight - itemSpacing,
  );
  return {
    rowLimit,
    horizontalPadding,
    verticalPadding,
    headerHeight,
    searchFont: search.font,
    searchWidth: search.width,
    rowHeight,
    iconSize: compact ? 32 : 33,
    detailFont: populatedDetailFont(compact),
    itemSpacing,
    emptyVehicleSize: 68,
    emptyLabelFont: 16,
    emptyContentSpacing: 4,
    emptyContentHeight,
    emptyContentCenterY: verticalPadding
      + headerHeight
      + itemSpacing
      + emptyContentHeight / 2,
  };
}

export function mediumWidgetPlacement(
  height: number,
  availableRows: number,
): MediumWidgetPlacement {
  const layout = mediumWidgetLayout(height);
  const finiteRows = Number.isFinite(availableRows)
    ? Math.max(0, Math.trunc(availableRows))
    : 0;
  const rowCount = Math.min(layout.rowLimit, finiteRows);
  const resolvedHeight = Number.isFinite(height) && height > 0 ? height : 155;
  const innerHeight = Math.max(0, resolvedHeight - layout.verticalPadding * 2);
  const availableRowHeight = Math.max(
    0,
    innerHeight - layout.headerHeight - layout.itemSpacing * rowCount,
  );
  const rowHeight = rowCount > 0
    ? Math.max(layout.rowHeight, availableRowHeight / rowCount)
    : layout.rowHeight;
  const firstRowTop = layout.verticalPadding
    + layout.headerHeight
    + layout.itemSpacing;
  const rowStride = rowHeight + layout.itemSpacing;
  const rowTopOffsets = Array.from(
    { length: rowCount },
    (_, index) => firstRowTop + index * rowStride,
  );
  const contentHeight = layout.headerHeight + rowCount * rowStride;
  return {
    rowCount,
    rowHeight,
    rowFrameAlignment: rowCount === layout.rowLimit ? "bottom" : "center",
    detailLineLimit: rowCount <= 1 ? null : rowCount === 2 ? 2 : 1,
    rowTopOffsets,
    bottomSpace: Math.max(0, innerHeight - contentHeight),
  };
}
