package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

/**
 * Audit R7 (user 2026-09-25): the list uses the shared status colour table
 * (docs/EXPRESS_THREE_CLIENT_PARITY_20260901.md, 2026-09-05 night), UNKNOWN in the same grey
 * #757575 as CANCELLED instead of the theme colour.
 */
public final class ListStatusColourTest {
    @Test public void everyStateTakesItsColourFromTheSharedTable() {
        assertEquals(0xFFD43D3D, colour(StatusSemantic.DANGER));
        assertEquals(0xFFE65B17, colour(StatusSemantic.WAITING_PICKUP));
        assertEquals(0xFF1A8A4A, colour(StatusSemantic.DELIVERY));
        assertEquals(0xFF0F9D8A, colour(StatusSemantic.COMPLETED));
        assertEquals(0xFF3275D6, colour(StatusSemantic.PICKED));
        assertEquals(0xFF3275D6, colour(StatusSemantic.TRANSIT));
        assertEquals(0xFFFBC02D, colour(StatusSemantic.ORDERED));
        assertEquals(0xFFFBC02D, colour(StatusSemantic.SHIPPED));
        assertEquals(0xFF757575, colour(StatusSemantic.CANCELLED));
        assertEquals(0xFF757575, colour(StatusSemantic.UNKNOWN));
    }

    private static int colour(StatusSemantic semantic) {
        return ExpressListActivity.statusColor(new ExpressItem(1L, "", "YT7000000000001", "YTO",
                "圆通速递", semantic, semantic.label, "", "", "[]", "", "INTERFACE5", ""));
    }
}
