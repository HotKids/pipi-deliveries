package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import me.pipi.deliveries.R;
import me.pipi.deliveries.feature.express.ExpressStatusColors;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressWidgetStatusStyleTest {
    /** Owner 2026-11-27 (修改 29, five-family): light non-capsule text pair + dedicated 清关中 badge. */
    @Test
    public void widgetStatusColoursComeFromTheSharedTable() {
        assertEquals(0xFFC62828, foreground(StatusSemantic.DANGER));
        assertEquals(0xFFBF360C, foreground(StatusSemantic.WAITING_PICKUP));
        assertEquals(0xFFE65100, foreground(StatusSemantic.DELIVERY));
        assertEquals(0xFF607D8B, foreground(StatusSemantic.COMPLETED));
        assertEquals(0xFF00796B, foreground(StatusSemantic.TRANSIT));
        assertEquals(0xFF1565C0, foreground(StatusSemantic.PICKED));
        assertEquals(0xFF00838F, foreground(StatusSemantic.ORDERED));
        assertEquals(0xFF0277BD, foreground(StatusSemantic.SHIPPED));
        assertEquals(0xFF7E3A3A, foreground(StatusSemantic.CANCELLED));
        assertEquals(0xFF757575, foreground(StatusSemantic.UNKNOWN));
        assertNotEquals(foreground(StatusSemantic.DELIVERY), foreground(StatusSemantic.COMPLETED));
    }

    @Test
    public void capsuleBackgroundFollowsTheDisplayedLabel() {
        assertEquals(R.drawable.widget_express_status_completed_bg, background(StatusSemantic.COMPLETED));
        assertEquals(R.drawable.widget_express_status_delivery_bg, background(StatusSemantic.DELIVERY));
        assertEquals(R.drawable.widget_express_status_picked_bg, background(StatusSemantic.PICKED));
        assertEquals(R.drawable.widget_express_status_cancelled_bg, background(StatusSemantic.CANCELLED));
        String customsTracks = "{\"tracks\":[],\"normalizedStatus\":{\"version\":1,\"scope\":\"SHIPMENT\","
                + "\"semantic\":\"TRANSIT\",\"code\":\"CUSTOMS_CLEARANCE\",\"text\":\"清关中\","
                + "\"priority\":1,\"eventAtMs\":0,\"structured\":true}}";
        ExpressItem customs = new ExpressItem(2, "", "ZTO2", "ZTO", "", StatusSemantic.TRANSIT,
                "清关中", "", "", customsTracks, "", "INTERFACE5", "");
        assertEquals("清关中", customs.displayStatus());
        assertEquals(R.drawable.widget_express_status_customs_bg, ExpressStatusColors.widgetBadgeBackground(customs));
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
