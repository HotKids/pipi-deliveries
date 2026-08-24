package me.pipi.deliveries.widget;

/** Row-count and density rules from Pipi's all-in-one express card. */
final class ExpressWidgetRowPolicy {
    static final int WIDE_ROW_LIMIT = 3;
    static final float DEFAULT_ROW_CONTENT_HEIGHT_DP = 42f;
    private static final float CARD_VERTICAL_PADDING_DP = 28f;
    private static final float HEADER_HEIGHT_DP = 30f;
    private static final float NATURAL_ROW_HEIGHT_DP = 48f;

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
            return new RowLayout(0, viewportHeightPx, 0, 0);
        }
        int rowsThatFit = Math.max(1, viewportHeightPx / contentHeightPx);
        int visibleRows = Math.min(cappedItems, rowsThatFit);
        int fittedHeightPx = viewportHeightPx / visibleRows;
        int rowHeightPx;
        if (itemCount < WIDE_ROW_LIMIT) {
            int naturalHeightPx = floorPx(NATURAL_ROW_HEIGHT_DP, safeDensity);
            rowHeightPx = Math.max(contentHeightPx,
                    Math.min(naturalHeightPx, fittedHeightPx));
        } else {
            rowHeightPx = Math.max(contentHeightPx, fittedHeightPx);
        }
        int verticalPaddingPx = Math.max(0,
                (rowHeightPx - contentHeightPx) / 2);
        return new RowLayout(visibleRows, viewportHeightPx,
                rowHeightPx, verticalPaddingPx);
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

        private RowLayout(int visibleRows, int viewportHeightPx,
                int rowHeightPx, int verticalPaddingPx) {
            this.visibleRows = visibleRows;
            this.viewportHeightPx = viewportHeightPx;
            this.rowHeightPx = rowHeightPx;
            this.verticalPaddingPx = verticalPaddingPx;
        }
    }
}
