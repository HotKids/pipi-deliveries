package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class ExpressWidgetRowPolicyTest {
    @Test
    public void allInOneCardRemainsStaticAtThreeRows() {
        ExpressWidgetRowPolicy.RowLayout layout =
                ExpressWidgetRowPolicy.calculate(8, 200f, 1f, 42f);

        assertEquals(3, layout.visibleRows);
        assertEquals(142, layout.viewportHeightPx);
        assertEquals(47, layout.rowHeightPx);
        assertEquals(2, layout.verticalPaddingPx);
        assertTrue(layout.rowHeightPx * layout.visibleRows <= layout.viewportHeightPx);
    }

    /** 对齐 iOS mediumWidgetPlacement（用户定 2026-09-05）：行数不足时平分视口，1 行放完整轨迹、2 行各 2 行。 */
    @Test
    public void sparseRowsFillTheViewportAndGrowTheDetailLines() {
        ExpressWidgetRowPolicy.RowLayout one =
                ExpressWidgetRowPolicy.calculate(1, 400f, 3f, 42f);
        ExpressWidgetRowPolicy.RowLayout two =
                ExpressWidgetRowPolicy.calculate(2, 400f, 3f, 42f);
        ExpressWidgetRowPolicy.RowLayout three =
                ExpressWidgetRowPolicy.calculate(8, 200f, 1f, 42f);

        assertEquals(one.viewportHeightPx, one.rowHeightPx);
        assertEquals(6, one.detailMaxLines);
        assertEquals(two.viewportHeightPx / 2, two.rowHeightPx);
        assertEquals(2, two.detailMaxLines);
        assertEquals(1, three.detailMaxLines);
        assertTrue(one.verticalPaddingPx * 2 + 126 + 5 * 51 <= one.rowHeightPx);
    }

    @Test
    public void shortHostsReduceRowsInsteadOfClipping() {
        ExpressWidgetRowPolicy.RowLayout layout =
                ExpressWidgetRowPolicy.calculate(3, 130f, 1f, 42f);

        assertEquals(1, layout.visibleRows);
        assertTrue(layout.rowHeightPx <= layout.viewportHeightPx);
    }
}
