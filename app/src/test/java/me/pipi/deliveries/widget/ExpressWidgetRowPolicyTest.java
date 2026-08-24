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

    @Test
    public void sparseRowsKeepPipiNaturalHeight() {
        ExpressWidgetRowPolicy.RowLayout one =
                ExpressWidgetRowPolicy.calculate(1, 400f, 3f, 42f);
        ExpressWidgetRowPolicy.RowLayout two =
                ExpressWidgetRowPolicy.calculate(2, 400f, 3f, 42f);

        assertEquals(144, one.rowHeightPx);
        assertEquals(144, two.rowHeightPx);
    }

    @Test
    public void shortHostsReduceRowsInsteadOfClipping() {
        ExpressWidgetRowPolicy.RowLayout layout =
                ExpressWidgetRowPolicy.calculate(3, 130f, 1f, 42f);

        assertEquals(1, layout.visibleRows);
        assertTrue(layout.rowHeightPx <= layout.viewportHeightPx);
    }
}
