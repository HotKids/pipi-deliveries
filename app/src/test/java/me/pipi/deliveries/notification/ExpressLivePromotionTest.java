package me.pipi.deliveries.notification;

import static org.junit.Assert.*;
import android.app.Notification;
import android.os.Build;
import java.util.List;
import me.pipi.deliveries.model.StatusSemantic;
import org.junit.Test;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

@Config(sdk = 36)
public class ExpressLivePromotionTest extends ExpressLiveNotificationsTest {
    @Test public void samsungAddsSemanticHintsAndLearnedFallbackKeepsPublicPromotion() {
        ReflectionHelpers.setStaticField(Build.class, "MANUFACTURER", "samsung");
        ExpressLiveNotifications.sync(context, List.of(item(1, StatusSemantic.DELIVERY)));
        assertTrue(live().extras.containsKey("android.ongoingActivityNoti.nowbarIcon"));
        assertFalse(live().extras.containsKey("android.ongoingActivityNoti.style"));
        assertEquals("派送中 1", live().extras.getCharSequence("android.shortCriticalText").toString());
        SamsungNowBarCompat.recordProbe(context, false);
        SamsungNowBarCompat.recordProbe(context, false);
        ExpressLiveNotifications.sync(context, List.of(item(1, StatusSemantic.DELIVERY)));
        Notification fallback = live();
        assertTrue(fallback.extras.getBoolean("android.requestPromotedOngoing"));
        for (String key : fallback.extras.keySet()) {
            assertFalse(key, key.startsWith("android.ongoingActivityNoti."));
            assertFalse(key, key.startsWith("android.sreminder."));
        }
        ExpressLiveNotifications.cancel(context);
        assertNull(live());
    }
}
