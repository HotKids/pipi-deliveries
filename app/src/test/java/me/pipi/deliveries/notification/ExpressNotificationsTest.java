package me.pipi.deliveries.notification;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressNotificationsTest {
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
}
