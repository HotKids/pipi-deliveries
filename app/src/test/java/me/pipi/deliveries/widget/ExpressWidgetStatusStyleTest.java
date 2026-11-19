package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import me.pipi.deliveries.R;
import me.pipi.deliveries.feature.express.ExpressStatusColors;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressWidgetStatusStyleTest {
    @Test
    public void widgetStatusColoursComeFromTheSharedTable() {
        assertEquals(0xFFBA1A1A, foreground(StatusSemantic.DANGER));
        assertEquals(0xFF693B10, foreground(StatusSemantic.WAITING_PICKUP));
        assertEquals(0xFF7A491D, foreground(StatusSemantic.DELIVERY));
        assertEquals(0xFF005D2D, foreground(StatusSemantic.COMPLETED));
        assertEquals(0xFF004590, foreground(StatusSemantic.TRANSIT));
        assertEquals(0xFF004EA1, foreground(StatusSemantic.PICKED));
        assertEquals(0xFF0F61C1, foreground(StatusSemantic.ORDERED));
        assertEquals(0xFF0057B3, foreground(StatusSemantic.SHIPPED));
        assertEquals(0xFF63696A, foreground(StatusSemantic.CANCELLED));
        assertEquals(0xFF545B5C, foreground(StatusSemantic.UNKNOWN));
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
