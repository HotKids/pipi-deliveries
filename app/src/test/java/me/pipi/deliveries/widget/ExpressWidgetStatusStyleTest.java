package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import me.pipi.deliveries.R;
import me.pipi.deliveries.feature.express.ExpressStatusColors;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressWidgetStatusStyleTest {
    /** Owner 2026-11-27 (修改 24, Material): light non-capsule text pair. */
    @Test
    public void widgetStatusColoursComeFromTheSharedTable() {
        assertEquals(0xFFD32F2F, foreground(StatusSemantic.DANGER));
        assertEquals(0xFF558B2F, foreground(StatusSemantic.WAITING_PICKUP));
        assertEquals(0xFF2E7D32, foreground(StatusSemantic.DELIVERY));
        assertEquals(0xFFEF6C00, foreground(StatusSemantic.COMPLETED));
        assertEquals(0xFF1565C0, foreground(StatusSemantic.TRANSIT));
        assertEquals(0xFF0277BD, foreground(StatusSemantic.PICKED));
        assertEquals(0xFF455A64, foreground(StatusSemantic.ORDERED));
        assertEquals(0xFF00838F, foreground(StatusSemantic.SHIPPED));
        assertEquals(0xFF757575, foreground(StatusSemantic.CANCELLED));
        assertEquals(0xFF9E9E9E, foreground(StatusSemantic.UNKNOWN));
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
