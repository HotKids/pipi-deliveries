package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import me.pipi.deliveries.R;
import me.pipi.deliveries.feature.express.ExpressStatusColors;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressWidgetStatusStyleTest {
    /** 小组件状态色只来自三端同一张表；用户 2026-09-05 指出列表已改青色而小组件的已签收仍是绿。 */
    @Test
    public void widgetStatusColoursComeFromTheSharedTable() {
        assertEquals(ExpressStatusColors.DANGER, foreground(StatusSemantic.DANGER));
        assertEquals(ExpressStatusColors.WAITING_PICKUP, foreground(StatusSemantic.WAITING_PICKUP));
        assertEquals(ExpressStatusColors.DELIVERY, foreground(StatusSemantic.DELIVERY));
        assertEquals(ExpressStatusColors.COMPLETED, foreground(StatusSemantic.COMPLETED));
        assertEquals(ExpressStatusColors.TRANSIT, foreground(StatusSemantic.TRANSIT));
        assertEquals(ExpressStatusColors.TRANSIT, foreground(StatusSemantic.PICKED));
        assertEquals(ExpressStatusColors.ORDERED, foreground(StatusSemantic.ORDERED));
        assertEquals(ExpressStatusColors.ORDERED, foreground(StatusSemantic.SHIPPED));
        assertEquals(ExpressStatusColors.NEUTRAL, foreground(StatusSemantic.CANCELLED));
        assertEquals(ExpressStatusColors.NEUTRAL, foreground(StatusSemantic.UNKNOWN));
        assertNotEquals(foreground(StatusSemantic.DELIVERY), foreground(StatusSemantic.COMPLETED));
    }

    @Test
    public void capsuleBackgroundFollowsTheSameSemantic() {
        assertEquals(R.drawable.widget_express_status_completed_bg,
                ExpressWidgetProvider.StatusStyle.forSemantic(StatusSemantic.COMPLETED).background);
        assertEquals(R.drawable.widget_express_status_delivery_bg,
                ExpressWidgetProvider.StatusStyle.forSemantic(StatusSemantic.DELIVERY).background);
        assertEquals(R.drawable.widget_express_status_transit_bg,
                ExpressWidgetProvider.StatusStyle.forSemantic(StatusSemantic.PICKED).background);
        assertEquals(R.drawable.widget_express_status_neutral_bg,
                ExpressWidgetProvider.StatusStyle.forSemantic(StatusSemantic.CANCELLED).background);
    }

    private static int foreground(StatusSemantic semantic) {
        return ExpressWidgetProvider.StatusStyle.forSemantic(semantic).foreground;
    }
}
