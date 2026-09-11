package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Application;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ManualQueryCoordinator;
import org.junit.Test;
import org.junit.Before;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = ExpressKuaidi100PrimaryTest.CaptureShadow.class)
public class ExpressKuaidi100PrimaryTest {
    @Before public void resetCapture() {
        CaptureShadow.routes.clear();
        CaptureShadow.expectedProvider = TimelineSlot.K100_H5;
    }

    @Implements(value = ExpressAutomaticTimelineCapture.class, isInAndroidSdk = false)
    public static class CaptureShadow {
        static final List<String> routes = new ArrayList<>();
        static String expectedProvider = TimelineSlot.K100_H5;
        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider,
                List<String> phones, ExpressQueryCancellation cancellation) {
            assertEquals(expectedProvider, provider);
            routes.add(route);
            ExpressQueryResult result = new ExpressQueryResult(owner.displayWaybill(), "SF", "顺丰速运",
                    StatusSemantic.TRANSIT, "2026-09-10 10:00:00", "运输中",
                    "[{\"time\":\"2026-09-10 10:00:00\",\"context\":\"运输中\"},"
                            + "{\"time\":\"2026-09-09 10:00:00\",\"context\":\"已揽收\"}]",
                    "", "", provider);
            return new ExpressAutomaticTimelineCapture.Result(result, true, false);
        }
    }

    @Test public void jtOccupiesTheSamePrimaryStageAndKeepsItsProvider() throws Exception {
        ExpressDetailActivity activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        CaptureShadow.expectedProvider = TimelineSlot.JT_H5;
        ExpressItem owner = new ExpressItem(1L, "1234", "JTTEST123456", "JTSD", "Synthetic carrier",
                StatusSemantic.TRANSIT, "", "", "", "[]", "", "INTERFACE5", "");
        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryPickerFirst(
                () -> { throw new IllegalStateException("Synthetic Picker failure"); },
                null, null, false, ignored -> () -> capture(activity, owner), null);
        assertEquals(TimelineSlot.JT_H5, batch.detailSelected().timelineProvider);
        assertEquals(List.of("https://jtsd.jtexpress.com.cn/pipi#/pages/checkGoods/sendDetail?waybillNo=JTTEST123456&isFrom=serach"),
                CaptureShadow.routes);
    }

    @Test public void zeroOrFailedPickerStillReachesTheExistingK100StageWithoutAnyRoute() throws Exception {
        ExpressDetailActivity activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        for (boolean failed : new boolean[]{false, true}) {
            ExpressItem owner = owner(failed ? " sf-test-4272 " : " sf-test-4271 ");
            ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryPickerFirst(
                    () -> {
                        if (failed) throw new IllegalStateException("Synthetic Picker failure");
                        return null;
                    }, null, null, false,
                    ignored -> () -> capture(activity, owner), null);
            assertEquals(TimelineSlot.K100_H5, batch.detailSelected().timelineProvider);
        }
        assertEquals(List.of("https://m.kuaidi100.com/app/query/?nu=SFTEST4271",
                "https://m.kuaidi100.com/app/query/?nu=SFTEST4272"), CaptureShadow.routes);
        assertNull(capture(activity, owner(" sf-test-4271 ")));
        assertEquals(2, CaptureShadow.routes.size());
    }

    @Test public void existingDetailK100EntryDoesNotRequireTheCachedPickerUrl() throws Exception {
        ExpressDetailActivity activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        java.lang.reflect.Field item = ExpressDetailActivity.class.getDeclaredField("item");
        item.setAccessible(true);
        item.set(activity, owner(" sf-test-4273 "));
        Method method = ExpressDetailActivity.class.getDeclaredMethod("kuaidi100FallbackUrl");
        method.setAccessible(true);
        assertEquals("https://m.kuaidi100.com/app/query/?nu=SFTEST4273", method.invoke(activity));
    }

    @Test public void primaryEarlyExitReportsReasonWithoutLoadingOrChangingCooldown() throws Exception {
        ExpressDetailActivity activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        android.content.SharedPreferences preferences = activity.getSharedPreferences(
                "express_k100_capture_cooldown", 0);
        CaptureShadow.routes.clear();
        org.robolectric.shadows.ShadowLog.clear();
        java.util.Map<String, ?> beforeInvalid = preferences.getAll();
        assertNull(capture(activity, owner("---")));
        assertEquals(beforeInvalid, preferences.getAll());
        List<org.robolectric.shadows.ShadowLog.LogItem> invalid =
                org.robolectric.shadows.ShadowLog.getLogsForTag(
                        me.pipi.deliveries.network.ExpressLog.TAG);
        assertEquals(1, invalid.size());
        assertEquals("level=k100_h5 event=skipped tail=--- reason=invalid_waybill", invalid.get(0).msg);

        org.robolectric.shadows.ShadowLog.clear();
        ExpressItem owner = owner("SFTEST4274");
        ExpressKuaidi100CaptureCooldown.record(activity, owner.displayWaybill(), System.currentTimeMillis());
        java.util.Map<String, ?> beforeCooldown = preferences.getAll();
        assertNull(capture(activity, owner));
        assertEquals(beforeCooldown, preferences.getAll());
        List<org.robolectric.shadows.ShadowLog.LogItem> cooldown =
                org.robolectric.shadows.ShadowLog.getLogsForTag(
                        me.pipi.deliveries.network.ExpressLog.TAG);
        assertEquals(1, cooldown.size());
        assertEquals("level=k100_h5 event=skipped tail=4274 reason=cooldown", cooldown.get(0).msg);
        assertFalse(cooldown.get(0).msg.contains(owner.displayWaybill()));
        assertFalse(cooldown.get(0).msg.contains("http"));
        assertTrue(CaptureShadow.routes.isEmpty());
    }

    private static ExpressQueryResult capture(ExpressDetailActivity activity, ExpressItem owner)
            throws Exception {
        Method method = ExpressDetailActivity.class.getDeclaredMethod("capturePrimaryKuaidi100",
                ExpressItem.class, ExpressQueryCancellation.class);
        method.setAccessible(true);
        return (ExpressQueryResult) method.invoke(activity, owner, new ExpressQueryCancellation(5000L));
    }

    private static ExpressItem owner(String waybill) {
        return new ExpressItem(1L, "", waybill, "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "运输中", "原接口轨迹", "2026-09-09 10:00:00", "[]", "", "INTERFACE5", "",
                1L, 2L, "INTERFACE5", "", "", "", false, "", "", "[]", "ShunFeng", false, "", 0L);
    }
}
