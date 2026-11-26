package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ListStatusColourTest {
    /** Owner 2026-11-20 (修改 11), table 1.2-A: the list shows the light non-capsule text pair as it is. */
    @Test public void everyStateTakesItsColourFromTheSharedTable() {
        assertEquals(0xFFF03A30, colour(StatusSemantic.DANGER));
        assertEquals(0xFF6D8F00, colour(StatusSemantic.WAITING_PICKUP));
        assertEquals(0xFF0E9F52, colour(StatusSemantic.DELIVERY));
        assertEquals(0xFFD97E06, colour(StatusSemantic.COMPLETED));
        assertEquals(0xFF0277BD, colour(StatusSemantic.PICKED));
        assertEquals(0xFF0A6CFF, colour(StatusSemantic.TRANSIT));
        assertEquals(0xFF5A6B80, colour(StatusSemantic.ORDERED));
        assertEquals(0xFF0091B8, colour(StatusSemantic.SHIPPED));
        assertEquals(0xFF6E767F, colour(StatusSemantic.CANCELLED));
        assertEquals(0xFF9AA3AB, colour(StatusSemantic.UNKNOWN));
    }

    @Test public void darkAndSubtypeLabelsTakeTheirOwnPair() {
        assertEquals(0xFF3FD68B, ExpressStatusColors.accent(StatusSemantic.DELIVERY, "派送中", true));
        assertEquals(0xFF00897B, ExpressStatusColors.accent(StatusSemantic.DELIVERY, "待派送", false));
        assertEquals(0xFF4FD8C8, ExpressStatusColors.accent(StatusSemantic.DELIVERY, "待派送", true));
        assertEquals(0xFFE56A00, ExpressStatusColors.accent(StatusSemantic.COMPLETED, "已完成", false));
        assertEquals(0xFFFFAD66, ExpressStatusColors.accent(StatusSemantic.COMPLETED, "已完成", true));
        assertEquals(0xFFC9D1D8, ExpressStatusColors.accent(StatusSemantic.UNKNOWN, "", true));
        assertEquals(ExpressStatusColors.accent(StatusSemantic.TRANSIT, "运输中", true),
                ExpressStatusColors.accent(StatusSemantic.TRANSIT, "清关中", true));
    }

    private static int colour(StatusSemantic semantic) {
        ExpressItem item = new ExpressItem(1L, "", "YT7000000000001", "YTO",
                "圆通速递", semantic, semantic.label, "", "", "[]", "", "INTERFACE5", "");
        return ExpressStatusColors.accent(item.semantic, item.displayStatus(), false);
    }
}
