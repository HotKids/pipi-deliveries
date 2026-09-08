package me.pipi.deliveries.widget;

/** Row-count and density rules from Pipi's all-in-one express card. */
final class ExpressWidgetRowPolicy {
    static final int WIDE_ROW_LIMIT = 3;
    static final float DEFAULT_ROW_CONTENT_HEIGHT_DP = 42f;
    private static final float CARD_VERTICAL_PADDING_DP = 28f;
    private static final float HEADER_HEIGHT_DP = 30f;
    /** 详情 13sp 一行大约 17dp（含行距），多行时按它扩内容高度。 */
    private static final float DETAIL_LINE_HEIGHT_DP = 17f;
    private static final int MAX_DETAIL_LINES = 6;

    private ExpressWidgetRowPolicy() {}

    static RowLayout calculate(
            int itemCount, float hostHeightDp, float density, float rowContentHeightDp) {
        float safeDensity = density > 0f ? density : 1f;
        float safeContentHeightDp = Math.max(
                DEFAULT_ROW_CONTENT_HEIGHT_DP, rowContentHeightDp);
        int contentHeightPx = ceilPx(safeContentHeightDp, safeDensity);
        int hostHeightPx = floorPx(Math.max(0f, hostHeightDp), safeDensity);
        int fixedHeightPx = ceilPx(CARD_VERTICAL_PADDING_DP, safeDensity)
                + ceilPx(HEADER_HEIGHT_DP, safeDensity);
        int viewportHeightPx = Math.max(contentHeightPx, hostHeightPx - fixedHeightPx);

        int cappedItems = Math.max(0, Math.min(itemCount, WIDE_ROW_LIMIT));
        if (cappedItems == 0) {
            return new RowLayout(0, viewportHeightPx, 0, 0, 1);
        }
        int rowsThatFit = Math.max(1, viewportHeightPx / contentHeightPx);
        int visibleRows = Math.min(cappedItems, rowsThatFit);
        int fittedHeightPx = viewportHeightPx / visibleRows;
        // 对齐 iOS mediumWidgetPlacement（用户定 2026-09-05）：行数不足时行高平分整个视口，
        // 1 行时详情尽量放完整的最新一条轨迹，2 行时各给 2 行，3 行时各 1 行。
        int rowHeightPx = Math.max(contentHeightPx, fittedHeightPx);
        int lineHeightPx = ceilPx(DETAIL_LINE_HEIGHT_DP, safeDensity);
        int extraLinesThatFit = Math.max(0, (rowHeightPx - contentHeightPx) / lineHeightPx);
        int detailMaxLines = visibleRows <= 1
                ? Math.min(MAX_DETAIL_LINES, 1 + extraLinesThatFit)
                : visibleRows == 2 ? Math.min(2, 1 + extraLinesThatFit) : 1;
        int contentWithLinesPx = contentHeightPx + (detailMaxLines - 1) * lineHeightPx;
        int verticalPaddingPx = Math.max(0, (rowHeightPx - contentWithLinesPx) / 2);
        return new RowLayout(visibleRows, viewportHeightPx,
                rowHeightPx, verticalPaddingPx, detailMaxLines);
    }

    private static int floorPx(float dp, float density) {
        return (int) Math.floor(dp * density + 0.001f);
    }

    private static int ceilPx(float dp, float density) {
        return (int) Math.ceil(dp * density - 0.001f);
    }

    static final class RowLayout {
        final int visibleRows;
        final int viewportHeightPx;
        final int rowHeightPx;
        final int verticalPaddingPx;
        /** 详情文案最多几行：1 行时尽量放完整轨迹，2 行时各 2 行，3 行时各 1 行（对齐 iOS mediumWidgetPlacement）。 */
        final int detailMaxLines;

        private RowLayout(int visibleRows, int viewportHeightPx,
                int rowHeightPx, int verticalPaddingPx, int detailMaxLines) {
            this.visibleRows = visibleRows;
            this.viewportHeightPx = viewportHeightPx;
            this.rowHeightPx = rowHeightPx;
            this.verticalPaddingPx = verticalPaddingPx;
            this.detailMaxLines = Math.max(1, detailMaxLines);
        }
    }
}
