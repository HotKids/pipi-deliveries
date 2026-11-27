package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ListStatusColourTest {
    /** Owner 2026-11-27 (修改 24, Material): the list shows the light non-capsule text pair as it is. */
    @Test public void everyStateTakesItsColourFromTheSharedTable() {
        assertEquals(0xFFD32F2F, colour(StatusSemantic.DANGER));
        assertEquals(0xFF558B2F, colour(StatusSemantic.WAITING_PICKUP));
        assertEquals(0xFF2E7D32, colour(StatusSemantic.DELIVERY));
        assertEquals(0xFFEF6C00, colour(StatusSemantic.COMPLETED));
        assertEquals(0xFF0277BD, colour(StatusSemantic.PICKED));
        assertEquals(0xFF1565C0, colour(StatusSemantic.TRANSIT));
        assertEquals(0xFF455A64, colour(StatusSemantic.ORDERED));
        assertEquals(0xFF00838F, colour(StatusSemantic.SHIPPED));
        assertEquals(0xFF757575, colour(StatusSemantic.CANCELLED));
        assertEquals(0xFF9E9E9E, colour(StatusSemantic.UNKNOWN));
    }

    @Test public void darkAndSubtypeLabelsTakeTheirOwnPair() {
        assertEquals(0xFFA5D6A7, ExpressStatusColors.accent(StatusSemantic.DELIVERY, "派送中", true));
        assertEquals(0xFF00695C, ExpressStatusColors.accent(StatusSemantic.DELIVERY, "待派送", false));
        assertEquals(0xFF80CBC4, ExpressStatusColors.accent(StatusSemantic.DELIVERY, "待派送", true));
        assertEquals(0xFFE64A19, ExpressStatusColors.accent(StatusSemantic.COMPLETED, "已完成", false));
        assertEquals(0xFFFFAB91, ExpressStatusColors.accent(StatusSemantic.COMPLETED, "已完成", true));
        assertEquals(0xFFBDBDBD, ExpressStatusColors.accent(StatusSemantic.UNKNOWN, "", true));
        assertEquals(ExpressStatusColors.accent(StatusSemantic.TRANSIT, "运输中", true),
                ExpressStatusColors.accent(StatusSemantic.TRANSIT, "清关中", true));
    }

    private static int colour(StatusSemantic semantic) {
        ExpressItem item = new ExpressItem(1L, "", "YT7000000000001", "YTO",
                "圆通速递", semantic, semantic.label, "", "", "[]", "", "INTERFACE5", "");
        return ExpressStatusColors.accent(item.semantic, item.displayStatus(), false);
    }
}
