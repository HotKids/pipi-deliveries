package me.pipi.deliveries.notification;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

public final class ExpressNotificationsTest {
    @Test
    public void ordinaryTitleMatchesPipiCarrierSuffixAndStatusFormat() {
        ExpressItem item = new ExpressItem(
                1L, "", "79000000000001", "ZTO", "中通快递",
                StatusSemantic.WAITING_PICKUP, "待取件", "已到达驿站", "",
                "[]", "", "INTERFACE5", "");

        assertEquals("中通快递 0001 · 待取件",
                ExpressNotifications.notificationTitle(item));
    }

    @Test
    public void statusChangePostsEvenWhenLatestDetailIsUnchanged() {
        ExpressItem previous = item(StatusSemantic.TRANSIT, "运输中", "快件正在运输");
        ExpressItem current = item(StatusSemantic.DELIVERY, "派送中", "快件正在运输");

        assertTrue(ExpressNotifications.shouldPostUpdate(previous, current));
    }

    @Test
    public void unchangedStatusAndDetailDoesNotPostAgain() {
        ExpressItem previous = item(StatusSemantic.TRANSIT, "运输中", "快件正在运输");
        ExpressItem current = item(StatusSemantic.TRANSIT, "运输中", "快件正在运输");

        assertFalse(ExpressNotifications.shouldPostUpdate(previous, current));
    }

    private static ExpressItem item(
            StatusSemantic semantic, String status, String detail) {
        return new ExpressItem(
                1L, "", "79000000000001", "ZTO", "中通快递",
                semantic, status, detail, "", "[]", "", "INTERFACE5", "");
    }
}
