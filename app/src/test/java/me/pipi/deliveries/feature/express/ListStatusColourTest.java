package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ListStatusColourTest {
    @Test public void everyStateTakesItsColourFromTheSharedTable() {
        assertEquals(0xFFBA1A1A, colour(StatusSemantic.DANGER));
        assertEquals(0xFF693B10, colour(StatusSemantic.WAITING_PICKUP));
        assertEquals(0xFF7A491D, colour(StatusSemantic.DELIVERY));
        assertEquals(0xFF005D2D, colour(StatusSemantic.COMPLETED));
        assertEquals(0xFF004EA1, colour(StatusSemantic.PICKED));
        assertEquals(0xFF004590, colour(StatusSemantic.TRANSIT));
        assertEquals(0xFF0F61C1, colour(StatusSemantic.ORDERED));
        assertEquals(0xFF0057B3, colour(StatusSemantic.SHIPPED));
        assertEquals(0xFF63696A, colour(StatusSemantic.CANCELLED));
        assertEquals(0xFF545B5C, colour(StatusSemantic.UNKNOWN));
    }

    private static int colour(StatusSemantic semantic) {
        ExpressItem item = new ExpressItem(1L, "", "YT7000000000001", "YTO",
                "圆通速递", semantic, semantic.label, "", "", "[]", "", "INTERFACE5", "");
        return ExpressStatusColors.accent(item.semantic, item.displayStatus(), false);
    }
}
