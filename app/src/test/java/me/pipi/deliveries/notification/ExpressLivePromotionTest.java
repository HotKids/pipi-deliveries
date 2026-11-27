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
        assertEquals(1, live().extras.getInt("android.ongoingActivityNoti.style"));
        assertNotNull(live().extras.getParcelable("android.ongoingActivityNoti.expandedRemoteView"));
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

    @Test public void userSwipeOnReceiverCancelsSamsungProbeWithoutRepostOrFallbackPenalty() throws Exception {
        ReflectionHelpers.setStaticField(Build.class, "MANUFACTURER", "samsung");
        SamsungNowBarCompat.resetCacheForTest();
        context.getSharedPreferences("deliveries_systemui_compat", 0).edit().clear().commit();
        for (int id = 1; id <= 3; id++) {
            assertTrue(ExpressLiveNotifications.sync(context, List.of(item(id, StatusSemantic.DELIVERY))));
            Notification posted = live();
            assertNotNull(posted);
            android.content.Intent deleted = deletion();
            manager.cancel(ExpressLiveNotifications.LIVE_ID);
            new NotificationDismissedReceiver().onReceive(context, deleted);
            assertNull("User swipe must not repost generic live notification", live());
            assertFalse("User swipe must not trip SamsungNowBarCompat fallback",
                    SamsungNowBarCompat.useGenericFallback(context));
            ExpressLiveNotifications.restoreOnForeground(context);
        }
    }
}
