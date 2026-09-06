package me.pipi.deliveries.notification;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertNull;

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
}
