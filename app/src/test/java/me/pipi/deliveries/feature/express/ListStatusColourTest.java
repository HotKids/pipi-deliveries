package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ListStatusColourTest {
    /** Owner 2026-11-27 (修改 29, five-family): the list shows the light non-capsule text pair as it is. */
    @Test public void everyStateTakesItsColourFromTheSharedTable() {
        assertEquals(0xFFC62828, colour(StatusSemantic.DANGER));
        assertEquals(0xFFBF360C, colour(StatusSemantic.WAITING_PICKUP));
        assertEquals(0xFFE65100, colour(StatusSemantic.DELIVERY));
        assertEquals(0xFF546E7A, colour(StatusSemantic.COMPLETED));
        assertEquals(0xFF1565C0, colour(StatusSemantic.PICKED));
        assertEquals(0xFF00796B, colour(StatusSemantic.TRANSIT));
        assertEquals(0xFF00838F, colour(StatusSemantic.ORDERED));
        assertEquals(0xFF0277BD, colour(StatusSemantic.SHIPPED));
        assertEquals(0xFF7E3A3A, colour(StatusSemantic.CANCELLED));
        assertEquals(0xFF757575, colour(StatusSemantic.UNKNOWN));
    }

    @Test public void darkAndSubtypeLabelsTakeTheirOwnPair() {
        assertEquals(0xFFFFB74D, ExpressStatusColors.accent(StatusSemantic.DELIVERY, "派送中", true));
        assertEquals(0xFFFF6F00, ExpressStatusColors.accent(StatusSemantic.DELIVERY, "待派送", false));
        assertEquals(0xFFFFD54F, ExpressStatusColors.accent(StatusSemantic.DELIVERY, "待派送", true));
        assertEquals(0xFF455A64, ExpressStatusColors.accent(StatusSemantic.COMPLETED, "已完成", false));
        assertEquals(0xFF90A4AE, ExpressStatusColors.accent(StatusSemantic.COMPLETED, "已完成", true));
        assertEquals(0xFFE0E0E0, ExpressStatusColors.accent(StatusSemantic.UNKNOWN, "", true));
        assertEquals(0xFF00695C, ExpressStatusColors.accent(StatusSemantic.TRANSIT, "清关中", false));
        assertEquals(0xFF26A69A, ExpressStatusColors.accent(StatusSemantic.TRANSIT, "清关中", true));
        assertNotEquals(ExpressStatusColors.accent(StatusSemantic.TRANSIT, "运输中", false),
                ExpressStatusColors.accent(StatusSemantic.TRANSIT, "清关中", false));
        assertNotEquals(ExpressStatusColors.accent(StatusSemantic.TRANSIT, "运输中", true),
                ExpressStatusColors.accent(StatusSemantic.TRANSIT, "清关中", true));
    }

    private static int colour(StatusSemantic semantic) {
        ExpressItem item = new ExpressItem(1L, "", "YT7000000000001", "YTO",
                "圆通速递", semantic, semantic.label, "", "", "[]", "", "INTERFACE5", "");
        return ExpressStatusColors.accent(item.semantic, item.displayStatus(), false);
    }
}
