package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;
import android.app.Activity;
import android.content.Context;
import android.os.Looper;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.SQLiteMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {ExpressHomeOrderProjectionTest.QueryShadow.class,
                ExpressHomeOrderProjectionTest.CaptureShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressHomeOrderProjectionTest {
    private static final String ROUTE_A = "https://order.jd.com/detail?token=a";
    private static final String ROUTE_ROTATED = "https://order.jd.com/detail?token=b";
    private static final long NOW = 1_000_000L;
    private static final long TEN_MINUTES = 10L * 60L * 1000L;
    private ExpressOrderProjectionRetryStore retries;
    private Context context;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("express_jd_h5_cooldown", 0).edit().clear().commit();
        retries = new ExpressOrderProjectionRetryStore(context);
    }

    @Test public void onlyUnresolvedInterface5OrdersWithAnAvailableRouteAreEligible() {
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(
                order(1L, "I5-JD", "", true, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(2L, "I6-JD", "", true, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(3L, "I5-JD", "JDWAYBILL123", true, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(4L, "I5-JD", "", false, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(5L, "I5-JD", "", true, "")));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(normalShipment()));
    }

    @Test public void unpickedHomeOrdersWaitWhileDetailStillAllowsIdentityCapture() {
        for (String detail : new String[]{"已下单", "正在打包", "等待揽收", "预计明天送达"}) {
            ExpressItem item = orderWithIdentity(1L, "I5-JD", "JDORDER1", "", true,
                    ROUTE_A, "[{\"time\":\"2026-08-22 10:00:00\",\"context\":\"" + detail + "\"}]");
            assertFalse(detail, ExpressHomeOrderProjectionCapture.needsProjection(item));
            assertTrue(detail, ExpressDetailActivity.allowsJingDongCapture(item));
            assertNull(retries.beginAttempt(item, NOW));
        }
    }

    @Test public void textIdentityDoesNotRequirePickupOrAReadyH5Route() {
        ExpressItem item = orderWithIdentity(1L, "I5-JD", "JDORDER1", "", false, "",
                "[{\"time\":\"2026-08-22 10:00:00\",\"context\":\"待出库交付中通快递，运单号为 75600000001844\"}]");
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(item));
        assertEquals(item, ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(item), new HashSet<>()));
        assertTrue(context.getSharedPreferences("express_jd_h5_cooldown", 0).getAll().isEmpty());
    }

    @Test public void homeQueueIsFifoAndAttemptsEachRowOncePerBatch() {
        ExpressItem first = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressItem second = order(2L, "I5-JD", "", true, ROUTE_A);
        Set<String> attempted = new HashSet<>();
        assertEquals(first, ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(first, first, second), attempted));
        assertEquals(second, ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(first, first, second), attempted));
        assertNull(ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(first, first, second), attempted));
    }

    @Test public void releasingOrCancellingAnAttemptKeepsItsTenMinuteCooldown() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken first = retries.beginAttempt(item, NOW);
        assertNotNull(first);
        retries.endAttempt(first);
        assertNull(retries.beginAttempt(item, NOW + TEN_MINUTES - 1L));
        ExpressOrderProjectionRetryStore.AttemptToken next = retries.beginAttempt(item, NOW + TEN_MINUTES);
        assertNotNull(next);
        retries.endAttempt(next);
    }

    @Test public void detailAndHomeShareCooldownAndRouteChangesDoNotBypassIt() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken home = retries.beginAttempt(item, NOW);
        assertNotNull(home);
        retries.endAttempt(home);
        ExpressItem projected = order(1L, "I5-JD", "JDREAL123456", true, ROUTE_ROTATED);
        assertNull(retries.beginTimelineAttempt(projected, NOW + 1L));
        assertNull(retries.beginTimelineAttempt(
                order(1L, "I5-JD", "", true, "https://wqs.jd.com/other"), NOW + 1L));
        ExpressOrderProjectionRetryStore.AttemptToken detail =
                retries.beginTimelineAttempt(projected, NOW + TEN_MINUTES);
        assertNotNull(detail);
        retries.endAttempt(detail);
        assertNull(retries.beginAttempt(item, NOW + TEN_MINUTES + 1L));
    }

    @Test public void rateControlExtendsTheSameOrderToSixtyMinutes() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken token = retries.beginAttempt(item, NOW);
        assertNotNull(token);
        retries.recordTimelineRateLimit(item, NOW + 1_000L);
        retries.endAttempt(token);
        assertNull(retries.beginTimelineAttempt(item, NOW + TEN_MINUTES));
        long until = NOW + 1_000L + 60L * 60L * 1000L;
        assertNull(retries.beginTimelineAttempt(item, until - 1L));
        ExpressOrderProjectionRetryStore.AttemptToken next = retries.beginTimelineAttempt(item, until);
        assertNotNull(next);
        retries.endAttempt(next);
    }

    @Test public void anActiveAttemptAndAStaleReleaseCannotAllowASecondCapture() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken first = retries.beginAttempt(item, NOW);
        assertNotNull(first);
        assertNull(retries.beginTimelineAttempt(item, NOW + TEN_MINUTES));
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(first));
        ExpressOrderProjectionRetryStore.AttemptToken current =
                retries.beginTimelineAttempt(item, NOW + TEN_MINUTES);
        assertNotNull(current);
        assertFalse(ExpressOrderProjectionRetryStore.releaseAttempt(first));
        assertNull(ExpressOrderProjectionRetryStore.acquireAttempt(item));
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(current));
    }

    @Test public void feedTextProjectionCanAcquireTheLeaseWithoutOpeningH5() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken h5 = retries.beginAttempt(item, NOW);
        assertNotNull(h5);
        retries.endAttempt(h5);
        assertNull(retries.beginAttempt(item, NOW + 1L));
        ExpressOrderProjectionRetryStore.AttemptToken text =
                ExpressOrderProjectionRetryStore.acquireAttempt(item);
        assertNotNull(text);
        retries.endAttempt(text);
        assertNull(retries.beginAttempt(item, NOW + 2L));
    }

    @Test public void cooldownKeysContainOnlyTheOrderHash() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken token = retries.beginAttempt(item, NOW);
        assertNotNull(token);
        retries.endAttempt(token);
        Set<String> keys = context.getSharedPreferences("express_jd_h5_cooldown", 0).getAll().keySet();
        assertEquals(1, keys.size());
        assertTrue(keys.iterator().next().matches("[0-9a-f]{64}"));
    }

    @Test public void interface6CannotOpenTheAutomaticTimelineCapture() {
        ExpressItem unsupported = order(1L, "I6-JD", "", true, ROUTE_A);
        assertNull(retries.beginAttempt(unsupported, NOW));
        assertNull(retries.beginTimelineAttempt(unsupported, NOW));
    }

    @Test public void timedAccountQueryDoesNotBlockMissingIdentityH5() throws Exception {
        verifyHomeQuery(true, false);
    }

    @Test public void emptyAccountQueryStillAllowsH5AndOnlyThenStartsCooldown() throws Exception {
        verifyHomeQuery(false, false);
    }

    @Test public void closingHomeDuringAccountQueryDoesNotOpenH5OrConsumeCooldown() throws Exception {
        verifyHomeQuery(false, true);
    }

    private void verifyHomeQuery(boolean timed, boolean cancelDuringQuery) throws Exception {
        context.deleteDatabase(ExpressDatabase.DATABASE);
        java.lang.reflect.Field singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, null);
        ExpressRepository repository = ExpressRepository.get(context);
        String phone = "13800000001";
        repository.bindPhoneLocally(phone, "interface5");
        ExpressQueryResult feed = new ExpressQueryResult("JDORDERHOME001", "JD", "京东购物",
                StatusSemantic.TRANSIT, 0L, "2026-09-09 09:00:00", "已揽收",
                "[{\"time\":\"2026-09-09 09:00:00\",\"context\":\"已揽收\"}]", "", phone,
                "v5_query", "", "", "JingDong");
        repository.saveInterface5OrderSummary(feed, phone);
        ExpressItem stored = repository.findByWaybill(feed.waybill, "interface5");
        assertNotNull(stored);
        ExpressItem source = new ExpressItem(stored.rowId, phone, stored.waybill,
                stored.courierCode, stored.companyName, stored.semantic, stored.statusDescription,
                stored.latestDetail, stored.latestTime, stored.tracksJson, "", stored.source,
                "", 0L, stored.updatedAt, stored.stateOwner, "", "v5", ROUTE_A, true,
                "", "", "[]", "JingDong");
        QueryShadow.result = timed ? new ExpressQueryResult(source.waybill, "JD", "京东购物",
                StatusSemantic.TRANSIT, "2026-09-09 10:00:00", "Query event",
                "[{\"time\":\"2026-09-09 10:00:00\",\"context\":\"Query event\"}]",
                "", phone, "v5_query", "", "", "JingDong") : null;
        QueryShadow.calls = 0;
        QueryShadow.waiting = cancelDuringQuery ? new java.util.concurrent.CountDownLatch(1) : null;
        CaptureShadow.starts = 0;
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        boolean[] finished = {false};
        ExpressHomeOrderProjectionCapture capture = new ExpressHomeOrderProjectionCapture(
                activity, source, (ignored, saved) -> finished[0] = true);
        try {
            assertTrue(capture.start());
            long until = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(3);
            while (System.nanoTime() < until && !finished[0] && CaptureShadow.starts == 0) {
                Thread.sleep(10);
                Shadows.shadowOf(Looper.getMainLooper()).idle();
                if (cancelDuringQuery && QueryShadow.calls > 0) {
                    capture.cancel();
                    QueryShadow.waiting.countDown();
                    break;
                }
            }
            assertEquals("Home must query its account before opening H5", 1, QueryShadow.calls);
            assertEquals("An active unresolved identity permits H5 even with timed history",
                    cancelDuringQuery ? 0 : 1, CaptureShadow.starts);
            assertEquals(cancelDuringQuery,
                    context.getSharedPreferences("express_jd_h5_cooldown", 0).getAll().isEmpty());
            if (cancelDuringQuery) {
                ExpressOrderProjectionRetryStore.AttemptToken reopened =
                        ExpressOrderProjectionRetryStore.acquireAttempt(source);
                assertNotNull(reopened);
                retries.endAttempt(reopened);
            }
        } finally {
            capture.cancel();
            activity.finish();
            singleton.set(null, null);
            java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
            helper.setAccessible(true);
            ((ExpressDatabase) helper.get(repository)).close();
        }
    }

    @Implements(value = ExpressDiscoveryClient.class, isInAndroidSdk = false)
    public static class QueryShadow {
        static volatile int calls;
        static ExpressQueryResult result;
        static java.util.concurrent.CountDownLatch waiting;
        @Implementation protected ExpressQueryResult refreshKnown(Context ignored,
                ExpressItem owner, boolean force, ExpressQueryCancellation cancellation) throws InterruptedException {
            calls++;
            if (waiting != null) waiting.await(3, java.util.concurrent.TimeUnit.SECONDS);
            return result;
        }
    }

    @Implements(value = ExpressAutomaticTimelineCapture.class, isInAndroidSdk = false)
    public static class CaptureShadow {
        static volatile int starts;
        @Implementation protected void start() { starts++; }
        @Implementation protected void cancel() {}
    }

    private static ExpressItem order(
            long rowId, String owner, String projectedWaybill,
            boolean credentialAvailable, String credential) {
        return orderWithIdentity(rowId, owner, "JDORDER" + rowId, projectedWaybill,
                credentialAvailable, credential);
    }

    private static ExpressItem orderWithIdentity(
            long rowId, String owner, String orderId, String projectedWaybill,
            boolean credentialAvailable, String credential) {
        return orderWithIdentity(rowId, owner, orderId, projectedWaybill, credentialAvailable,
                credential, "[{\"time\":\"2026-08-22 10:00:00\",\"context\":\"已揽收\"}]");
    }

    private static ExpressItem orderWithIdentity(
            long rowId, String owner, String orderId, String projectedWaybill,
            boolean credentialAvailable, String credential, String tracks) {
        return new ExpressItem(
                rowId, "", orderId, "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单正在配送",
                "2026-08-22 10:00:00", tracks, "", owner, "",
                1L, 2L, owner, "", "v5", credential, credentialAvailable,
                projectedWaybill, "", "[]", "JingDong");
    }

    private static ExpressItem normalShipment() {
        return new ExpressItem(
                6L, "", "ZTO123456789", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "运输中", "已到达转运中心",
                "2026-08-22 10:00:00", "[]", "", "INTERFACE5", "",
                1L, 2L, "INTERFACE5", "", "v5", "route", true,
                "", "", "[]");
    }
}
