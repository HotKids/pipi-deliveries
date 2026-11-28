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
        assertNull("Expanded Now Bar uses full existing Live Activity without expandedRemoteView",
                live().extras.getParcelable("android.ongoingActivityNoti.expandedRemoteView"));
        assertFalse("primaryInfo is unset so expanded Now Bar shows android.title",
                live().extras.containsKey("android.ongoingActivityNoti.primaryInfo"));
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
            assertNull("Lite Now Bar leaves expandedRemoteView unset so expansion renders full Live Activity",
                    posted.extras.getParcelable("android.ongoingActivityNoti.expandedRemoteView"));
            assertFalse(posted.extras.containsKey("android.ongoingActivityNoti.primaryInfo"));
            assertEquals("派送中 1 件",
                    posted.extras.getCharSequence("android.ongoingActivityNoti.nowbarPrimaryInfo").toString());
            String expectedTail = item(1, StatusSemantic.DELIVERY).displayWaybill();
            expectedTail = expectedTail.length() <= 4
                    ? expectedTail : expectedTail.substring(expectedTail.length() - 4);
            assertEquals(item(1, StatusSemantic.DELIVERY).displayCarrierLabel() + " " + expectedTail,
                    posted.extras.getCharSequence("android.ongoingActivityNoti.nowbarSecondaryInfo").toString());
            assertEquals(posted.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString(),
                    posted.extras.getCharSequence("android.ongoingActivityNoti.secondaryInfo").toString());

            // Verify collapsed Now Bar lines have zero emoji while standard Live Activity retains emojis!
            assertTrue("Standard Lite live notification must retain emojis on WAITING_PICKUP",
                    ExpressLiveNotifications.sync(context, List.of(item(1, StatusSemantic.WAITING_PICKUP)))
                            && live().extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString().contains("📦"));
            Notification waitingPosted = live();
            assertEquals("待取件 1 件",
                    waitingPosted.extras.getCharSequence("android.ongoingActivityNoti.nowbarPrimaryInfo").toString());
            assertEquals(waitingPosted.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString(),
                    waitingPosted.extras.getCharSequence("android.ongoingActivityNoti.secondaryInfo").toString());
            for (String extraKey : new String[] {
                    "android.ongoingActivityNoti.nowbarPrimaryInfo",
                    "android.ongoingActivityNoti.nowbarSecondaryInfo",
                    "android.ongoingActivityNoti.chipExpandedText"}) {
                CharSequence v = waitingPosted.extras.getCharSequence(extraKey);
                if (v != null) {
                    assertEquals("Lite Now Bar extra must have zero emoji: " + extraKey,
                            v.toString(), SamsungNowBarCompat.stripNowBarEmoji(v));
                }
            }
            // Case 19: JD account order without waybill omits tail!
            me.pipi.deliveries.model.ExpressItem jdOrderNoWaybill =
                    new me.pipi.deliveries.model.ExpressItem(
                            99L, "13800000000", "JD_ORDER_30999888", "", "",
                            StatusSemantic.DELIVERY, "派送中", "您的订单正在配送", "2026-11-28 10:00:00",
                            "[]", "", "I5-JD", "");
            assertEquals("京东购物", ExpressLiveNotifications.nowBarSecondary(jdOrderNoWaybill));

            // Re-post delivery for the pending probe check below:
            context.getSharedPreferences("deliveries_systemui_compat", 0).edit().clear().commit();
            PromotedNotificationPublisher.setClockForTest(null);
            PromotedNotificationPublisher.setClockForTest(() -> fakeNow[0]);
            assertTrue(ExpressLiveNotifications.sync(context, List.of(item(1, StatusSemantic.DELIVERY))));

            // Simulate monochrome fallback binding in both light mode AND dark mode (P6-7)!
            android.widget.RemoteViews monoRv = new android.widget.RemoteViews(
                    context.getPackageName(), me.pipi.deliveries.R.layout.express_live_now_bar_expanded);
            SamsungNowBarCompat.bindExpandedIcon(
                    context, monoRv, me.pipi.deliveries.R.id.express_now_bar_icon,
                    android.R.drawable.ic_dialog_info, true);
            android.view.View monoLightRoot = monoRv.apply(context, new android.widget.FrameLayout(context));
            android.widget.ImageView monoLightIcon = monoLightRoot.findViewById(
                    me.pipi.deliveries.R.id.express_now_bar_icon);
            assertEquals(SamsungNowBarCompat.EXPANDED_MONOCHROME_LIGHT_INK,
                    monoLightIcon.getImageTintList().getDefaultColor());
            android.content.res.Configuration nightCfg =
                    new android.content.res.Configuration(context.getResources().getConfiguration());
            nightCfg.uiMode = (nightCfg.uiMode & ~android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                    | android.content.res.Configuration.UI_MODE_NIGHT_YES;
            android.content.Context nightCtx = context.createConfigurationContext(nightCfg);
            android.view.View monoDarkRoot = monoRv.apply(nightCtx, new android.widget.FrameLayout(nightCtx));
            android.widget.ImageView monoDarkIcon = monoDarkRoot.findViewById(
                    me.pipi.deliveries.R.id.express_now_bar_icon);
            assertEquals(SamsungNowBarCompat.EXPANDED_MONOCHROME_DARK_INK,
                    monoDarkIcon.getImageTintList().getDefaultColor());

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
