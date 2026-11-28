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

    @Test public void liteExpandedCardPreservesFullColorLogoAndRecoversFromDeadProcessDrop() throws Exception {
        ReflectionHelpers.setStaticField(Build.class, "MANUFACTURER", "samsung");
        SamsungNowBarCompat.resetCacheForTest();
        context.getSharedPreferences("deliveries_systemui_compat", 0).edit().clear().commit();
        long[] fakeNow = {1_800_000_000_000L};
        PromotedNotificationPublisher.setClockForTest(() -> fakeNow[0]);
        try {
            assertTrue(ExpressLiveNotifications.sync(context, List.of(item(1, StatusSemantic.DELIVERY))));
            Notification posted = live();
            assertNotNull(posted);
            assertEquals(1, posted.extras.getInt("android.ongoingActivityNoti.style"));
            android.widget.RemoteViews rv = posted.extras.getParcelable(
                    "android.ongoingActivityNoti.expandedRemoteView", android.widget.RemoteViews.class);
            assertNotNull(rv);
            android.view.View root = rv.apply(context, new android.widget.FrameLayout(context));
            android.widget.ImageView icon = root.findViewById(me.pipi.deliveries.R.id.express_now_bar_icon);
            assertNotNull(icon);
            assertNull("Full-color carrier icon must stay untinted", icon.getImageTintList());

            // Simulate monochrome fallback binding in light mode -> dark high-contrast tint!
            android.widget.RemoteViews monoRv = new android.widget.RemoteViews(
                    context.getPackageName(), me.pipi.deliveries.R.layout.express_live_now_bar_expanded);
            SamsungNowBarCompat.bindExpandedIcon(
                    context, monoRv, me.pipi.deliveries.R.id.express_now_bar_icon,
                    android.R.drawable.ic_dialog_info, true);
            android.view.View monoRoot = monoRv.apply(context, new android.widget.FrameLayout(context));
            android.widget.ImageView monoIcon = monoRoot.findViewById(me.pipi.deliveries.R.id.express_now_bar_icon);
            assertEquals(SamsungNowBarCompat.EXPANDED_MONOCHROME_LIGHT_INK,
                    monoIcon.getImageTintList().getDefaultColor());

            // Simulate process death before 1.2s probe while SystemUI removes style=1:
            assertNotNull(SamsungNowBarCompat.readPendingNowBarProbe(context, "express.live"));
            java.lang.reflect.Field probesField =
                    PromotedNotificationPublisher.class.getDeclaredField("PROBES");
            probesField.setAccessible(true);
            ((java.util.Map<?, ?>) probesField.get(null)).clear();
            manager.cancel(ExpressLiveNotifications.LIVE_ID);
            fakeNow[0] += 2_000L;

            PromotedNotificationPublisher.reconcilePendingNowBarProbes(context);
            assertFalse(SamsungNowBarCompat.shouldTryNowBarTemplate(context, "express.live"));
            assertTrue(ExpressLiveNotifications.sync(context, List.of(item(2, StatusSemantic.DELIVERY))));
            Notification downgraded = live();
            assertNotNull(downgraded);
            assertFalse(downgraded.extras.containsKey("android.ongoingActivityNoti.style"));
            assertTrue(downgraded.extras.getBoolean("android.requestPromotedOngoing"));
        } finally {
            PromotedNotificationPublisher.setClockForTest(null);
        }
    }
}
