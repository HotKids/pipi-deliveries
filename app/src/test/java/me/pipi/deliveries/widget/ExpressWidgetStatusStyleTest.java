package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import me.pipi.deliveries.R;
import me.pipi.deliveries.feature.express.ExpressStatusColors;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressWidgetStatusStyleTest {
    /** Owner 2026-11-20 (修改 11), table 1.2-A light non-capsule text pair. */
    @Test
    public void widgetStatusColoursComeFromTheSharedTable() {
        assertEquals(0xFFF03A30, foreground(StatusSemantic.DANGER));
        assertEquals(0xFF6D8F00, foreground(StatusSemantic.WAITING_PICKUP));
        assertEquals(0xFF0E9F52, foreground(StatusSemantic.DELIVERY));
        assertEquals(0xFFD97E06, foreground(StatusSemantic.COMPLETED));
        assertEquals(0xFF0A6CFF, foreground(StatusSemantic.TRANSIT));
        assertEquals(0xFF0277BD, foreground(StatusSemantic.PICKED));
        assertEquals(0xFF5A6B80, foreground(StatusSemantic.ORDERED));
        assertEquals(0xFF0091B8, foreground(StatusSemantic.SHIPPED));
        assertEquals(0xFF6E767F, foreground(StatusSemantic.CANCELLED));
        assertEquals(0xFF9AA3AB, foreground(StatusSemantic.UNKNOWN));
        assertNotEquals(foreground(StatusSemantic.DELIVERY), foreground(StatusSemantic.COMPLETED));
    }

    @Test
    public void capsuleBackgroundFollowsTheDisplayedLabel() {
        assertEquals(R.drawable.widget_express_status_completed_bg, background(StatusSemantic.COMPLETED));
        assertEquals(R.drawable.widget_express_status_delivery_bg, background(StatusSemantic.DELIVERY));
        assertEquals(R.drawable.widget_express_status_picked_bg, background(StatusSemantic.PICKED));
        assertEquals(R.drawable.widget_express_status_cancelled_bg, background(StatusSemantic.CANCELLED));
    }

    private static int foreground(StatusSemantic semantic) {
        return ExpressStatusColors.accent(semantic, "", false);
    }

    private static int background(StatusSemantic semantic) {
        ExpressItem item = new ExpressItem(1, "", "ZTO1", "ZTO", "", semantic,
                "", "", "", "", "", "INTERFACE5", "");
        return ExpressStatusColors.widgetBadgeBackground(item);
    }
}
