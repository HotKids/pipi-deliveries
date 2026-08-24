export type SmallWidgetLayout = {
  outerPadding: number;
  headerSpacing: number;
  statusFont: number;
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
  searchSize: number;
  searchFont: number;
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
  rowHeight: number;
  iconSize: number;
  itemSpacing: number;
  emptyVehicleSize: number;
  emptyLabelFont: number;
  emptyContentSpacing: number;
  emptyContentHeight: number;
  emptyContentCenterY: number;
};

export type MediumWidgetPlacement = {
  rowCount: number;
  rowHeight: number;
  rowFrameAlignment: "center" | "bottom";
  detailLineLimit: number | null;
  rowTopOffsets: number[];
  bottomSpace: number;
};

export function smallWidgetLayout(width: number): SmallWidgetLayout {
  const compact = Number.isFinite(width) && width <= 148;
  return {
    outerPadding: compact ? 12 : 14,
    headerSpacing: compact ? 4 : 8,
    statusFont: compact ? 22 : 25,
    detailFont: compact ? 12 : 13,
    iconSize: compact ? 32 : 36,
    pillHeight: 40,
    pillFont: 14,
    pillIconFont: compact ? 13 : 14,
    pillSpacing: compact ? 4 : 6,
    pillHorizontalPadding: compact ? 5 : 11,
  };
}

export function smallWidgetEmptyLayout(
  width: number,
  height: number,
): SmallWidgetEmptyLayout {
  const compact = Number.isFinite(width) && width <= 148;
  const padding = compact ? 12 : 14;
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
    searchSize: 24,
    searchFont: 18,
    headerHeight,
    contentHeight,
    contentCenterY: padding + headerHeight + contentHeight / 2,
    vehicleSize: 68,
    labelFont: 16,
    contentSpacing: 4,
  };
}

export function mediumWidgetLayout(height: number): MediumWidgetLayout {
  const compact = Number.isFinite(height) && height < 155;
  const resolvedHeight = Number.isFinite(height) && height > 0
    ? height
    : compact ? 148 : 155;
  const verticalPadding = compact ? 10 : 12;
  const horizontalPadding = Number((verticalPadding * 1.2).toFixed(1));
  const headerHeight = 25;
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
    rowHeight,
    iconSize: compact ? 32 : 33,
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
