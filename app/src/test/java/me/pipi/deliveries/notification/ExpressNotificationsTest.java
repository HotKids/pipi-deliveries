package me.pipi.deliveries.notification;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertNull;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressNotificationsTest {
    /** 与 Pipi 同口径：文案变了但事件没变，不是新通知——已签收的件不得被重新通知（2026-09-05）。 */
    @Test
    public void rewrittenHeadlineWithoutANewerEventDoesNotRepostASignedParcel() {
        long signedAt = 1_788_500_000_000L;
        org.junit.Assert.assertFalse(ExpressNotifications.shouldPostUpdate(
                StatusSemantic.COMPLETED, "极兔速递 6736 · 已签收", "已签收", signedAt,
                StatusSemantic.COMPLETED, "极兔速递 6736 · 已签收",
                "您的快件已由本人签收，感谢使用极兔速递", signedAt));
        org.junit.Assert.assertFalse(ExpressNotifications.shouldPostUpdate(
                StatusSemantic.TRANSIT, "顺丰速运 5900 · 运输中", "快件已到达深圳", signedAt,
                StatusSemantic.TRANSIT, "顺丰速运 5900 · 运输中", "快件已到达深圳", signedAt));
    }

    @Test
    public void statusTransitionOrNewerEventStillNotifies() {
        long t = 1_788_500_000_000L;
        org.junit.Assert.assertTrue(ExpressNotifications.shouldPostUpdate(
                StatusSemantic.TRANSIT, "顺丰速运 5900 · 运输中", "运输中", t,
                StatusSemantic.COMPLETED, "顺丰速运 5900 · 已签收", "已签收", t));
        org.junit.Assert.assertTrue(ExpressNotifications.shouldPostUpdate(
                StatusSemantic.TRANSIT, "顺丰速运 5900 · 运输中", "快件已到达深圳", t,
                StatusSemantic.TRANSIT, "顺丰速运 5900 · 运输中", "快件已到达广州", t + 60_000L));
        org.junit.Assert.assertFalse(ExpressNotifications.shouldPostUpdate(
                StatusSemantic.TRANSIT, "顺丰速运 5900 · 运输中", "快件已到达深圳", t,
                StatusSemantic.TRANSIT, "顺丰速运 5900 · 运输中", "快件已到达广州", t - 60_000L));
    }

    @Test
    public void everyVisibleShipmentStateOwnsItsSystemChannel() {
        assertEquals(ExpressNotifications.CHANNEL_PICKED,
                ExpressNotifications.channelId(StatusSemantic.PICKED));
        assertEquals(ExpressNotifications.CHANNEL_DELIVERY,
                ExpressNotifications.channelId(StatusSemantic.DELIVERY));
        assertEquals(ExpressNotifications.CHANNEL_WAITING_PICKUP,
                ExpressNotifications.channelId(StatusSemantic.WAITING_PICKUP));
        assertEquals(ExpressNotifications.CHANNEL_DANGER,
                ExpressNotifications.channelId(StatusSemantic.DANGER));
        assertEquals(ExpressNotifications.CHANNEL_CANCELLED,
                ExpressNotifications.channelId(StatusSemantic.CANCELLED));
        assertEquals(ExpressNotifications.CHANNEL_ORDERED,
                ExpressNotifications.channelId(StatusSemantic.ORDERED));
        assertEquals(ExpressNotifications.CHANNEL_SHIPPED,
                ExpressNotifications.channelId(StatusSemantic.SHIPPED));
        assertEquals(ExpressNotifications.CHANNEL_TRANSIT,
                ExpressNotifications.channelId(StatusSemantic.TRANSIT));
        assertEquals(ExpressNotifications.CHANNEL_COMPLETED,
                ExpressNotifications.channelId(StatusSemantic.COMPLETED));
    }

    @Test
    public void unknownStateDoesNotLeakIntoAnUnrelatedChannel() {
        assertNull(ExpressNotifications.channelId(StatusSemantic.UNKNOWN));
        assertNull(ExpressNotifications.channelId(null));
    }

    /**
     * 用户定 2026-09-25（方案 B）：订单投影后并进已有运单行的那一轮只看展示状态。Pixel 上已签收的圆通运单行并进
     * 同样已签收的京东订单，事件更新、文案变了，照原规则会通知，这一轮不通知；状态真的变了照常通知；冻结京东件照旧。
     */
    @Test
    public void theMergeRoundNotifiesOnlyAShownStatusChange() {
        ExpressItem signedParcel = parcel(StatusSemantic.COMPLETED, "INTERFACE5", "CaiNiao", "",
                "您的快件已签收，签收人：家门口", 1_789_560_318_000L);
        ExpressItem signedOrder = parcel(StatusSemantic.COMPLETED, "I5-JD", "JingDong", "YT1234567897051",
                "您的包裹已送货上门，放至家门口", 1_789_819_522_000L);
        assertTrue("the ordinary rule takes the newer event", ExpressNotifications.shouldPostUpdate(
                signedParcel, signedOrder));
        assertFalse(ExpressNotifications.shouldPostStatusChange(signedParcel, signedOrder));
        assertTrue(ExpressNotifications.shouldPostStatusChange(parcel(StatusSemantic.DELIVERY,
                "INTERFACE5", "CaiNiao", "", "快递员正在派送", 1_789_500_000_000L), signedOrder));
        assertFalse("a frozen JD row stays frozen", ExpressNotifications.shouldPostStatusChange(
                parcel(StatusSemantic.COMPLETED, "INTERFACE5", "JingDong", "", "您的快件已签收",
                        1_789_560_318_000L),
                parcel(StatusSemantic.DELIVERY, "I5-JD", "JingDong", "YT1234567897051",
                        "快递员正在派送", 1_789_819_522_000L)));
        assertFalse(ExpressNotifications.shouldPostStatusChange(null, signedOrder));
        assertFalse(ExpressNotifications.shouldPostStatusChange(signedParcel, null));
    }

    private static ExpressItem parcel(StatusSemantic semantic, String owner, String sourceProvider,
            String projectedWaybill, String detail, long eventAt) {
        String waybill = owner.equals("I5-JD") ? "3630448013820579" : "YT1234567897051";
        return new ExpressItem(1L, "", waybill, "YTO", "圆通速递", semantic, semantic.label, detail,
                "2026-09-19 20:05:22", "[]", "", owner, "", eventAt, eventAt, owner, "", "v5", "",
                false, projectedWaybill, projectedWaybill.isEmpty() ? "" : "圆通速递", "[]",
                sourceProvider);
    }

    /** 上一版没有事件时间时，同状态的全量重写不是新事件（Fold7 2026-09-05 15:30 六票已签收件）。 */
    @Test
    public void unknownPreviousEventTimeIsNotANewerEvent() {
        assertFalse(ExpressNotifications.shouldPostUpdate(
                StatusSemantic.COMPLETED, "中通快递 0238 · 已签收", "已签收", 0L,
                StatusSemantic.COMPLETED, "中通快递 0238 · 已签收",
                "您的快件已送达，签收人：家门口", 1788234629000L));
        assertTrue(ExpressNotifications.shouldPostUpdate(
                StatusSemantic.TRANSIT, "中通快递 0238 · 运输中", "运输中", 0L,
                StatusSemantic.COMPLETED, "中通快递 0238 · 已签收",
                "您的快件已送达，签收人：家门口", 1788234629000L));
    }

    /** Audit R7 (user 2026-09-25): a signed notification carries the shared teal accent too. */
    @org.junit.Test
    public void aSignedNotificationUsesTheSharedTealAccent() {
        org.junit.Assert.assertEquals(0xFF0F9D8A,
                ExpressNotifications.statusColor(me.pipi.deliveries.model.StatusSemantic.COMPLETED));
        org.junit.Assert.assertEquals(0xFF757575,
                ExpressNotifications.statusColor(me.pipi.deliveries.model.StatusSemantic.UNKNOWN));
    }
}
