package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {SyntheticSecretBox.class, ExpressDetailH5EligibilityTest.CaptureShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class ExpressDetailH5EligibilityTest {
    private ExpressDetailActivity activity;
    private ExpressRepository repository;
    private static final String PHONE = "13800001234";

    @Before public void setUp() {
        Context context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        repository.bindPhoneLocally("13800005678", "interface6");
        activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        CaptureShadow.calls = 0;
        CaptureShadow.phones = null;
    }

    @After public void tearDown() {
        ((ExecutorService) ReflectionHelpers.getField(activity, "worker")).shutdownNow();
    }

    @Test public void staleProjectedHistoryWithFeedPickupDoesNotReopenJdH5() {
        ExpressItem owner = order(true, "已揽收");
        assertFalse(ReflectionHelpers.callInstanceMethod(activity, "currentDetailComplete",
                ClassParameter.from(ExpressItem.class, owner)));
        refreshAutomatic(owner);
        assertEquals(0, CaptureShadow.calls);
    }

    @Test public void missingIdentityStillLoadsH5WithFeedPickup() {
        refreshAutomatic(order(false, "已揽收"));
        assertEquals(1, CaptureShadow.calls);
    }

    @Test public void missingFeedPickupStillAllowsHistoryH5() {
        refreshAutomatic(order(true, "运输节点"));
        assertEquals(1, CaptureShadow.calls);
    }

    @Test public void automaticPrimaryUsesTheInitiatingInterfacesBoundSuffix() {
        ExpressItem owner = ExpressInterfaceDetailPolicyTest.owner("INTERFACE5", "CaiNiao");
        ReflectionHelpers.callInstanceMethod(activity, "capturePrimaryKuaidi100",
                ClassParameter.from(ExpressItem.class, owner),
                ClassParameter.from(ExpressQueryCancellation.class, new ExpressQueryCancellation(1000L)));
        assertEquals(List.of("1234"), CaptureShadow.phones);
    }

    @Test public void manualDetailRechecksOldHistoryAgainstTheCurrentSignedClock() throws Exception {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.ROOT);
        format.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Shanghai"));
        long signedAt = System.currentTimeMillis() - 60_000L;
        for (boolean aligned : new boolean[]{false, true}) {
            String waybill = aligned ? "SFALIGNEDSTOP" : "SFSTALESTOP";
            String latest = format.format(new java.util.Date(signedAt));
            String historyAt = format.format(new java.util.Date(aligned ? signedAt : signedAt - 10 * 60 * 60_000L));
            ExpressQueryResult online = new ExpressQueryResult(waybill, "SF", "顺丰速运",
                    StatusSemantic.COMPLETED, ExpressTimeline.parseTime(latest), latest,
                    "Current status", "[{\"time\":\"" + latest + "\",\"context\":\"Current status\"}]",
                    "", PHONE, "v6_query", "", "", "")
                    .withManualStatusEvidence("已签收", true);
            ExpressQueryResult h5 = new ExpressQueryResult(waybill, "SF", "顺丰速运",
                    StatusSemantic.UNKNOWN, historyAt, "已揽收",
                    "[{\"time\":\"" + historyAt + "\",\"context\":\"已揽收\"}]",
                    "", PHONE, "k100_h5");
            ExpressItem owner = repository.saveManualQueryBatch(null, null, List.of(
                    new ManualQuerySuccess("v6_query", online, System.currentTimeMillis(), false),
                    new ManualQuerySuccess("k100_h5", h5, System.currentTimeMillis(), true)), PHONE, "interface5");
            assertNotNull(owner);
            assertTrue(owner.manuallyAdded);
            assertEquals(StatusSemantic.COMPLETED, owner.semantic);
            assertEquals("k100_h5", repository.manualDetailTimelineAuthority(owner).provider);

            activity.setTheme(R.style.AppTheme);
            ReflectionHelpers.setField(activity, "nativeProgress", new LinearProgressIndicator(activity));
            ReflectionHelpers.setField(activity, "item", owner);
            ReflectionHelpers.setField(activity, "localRefreshInFlight", false);
            ReflectionHelpers.setField(activity, "pullRefreshRequested", true);
            CaptureShadow.calls = 0;
            ReflectionHelpers.callInstanceMethod(activity, "refreshLocalTimelineInBackground",
                    ClassParameter.from(boolean.class, false));
            Future<?> task = ReflectionHelpers.getField(activity, "localRefreshTask");
            task.get(5, TimeUnit.SECONDS);
            assertFalse(ReflectionHelpers.getField(activity, "localRefreshFailed"));
            assertEquals("Only history aligned with the latest signed evidence can suppress H5",
                    aligned ? 0 : 1, CaptureShadow.calls);
        }
    }

    @Test public void staleQueryPickupCannotStopCainiaoFallbackAfterH5MissesPickup() {
        String waybill = "CNSTALEQUERY", latest = "2026-09-13 12:00:00";
        ExpressQueryResult feed = new ExpressQueryResult(waybill, "EMS", "EMS",
                StatusSemantic.TRANSIT, ExpressTimeline.parseTime(latest), latest,
                "Account event", "[{\"time\":\"" + latest + "\",\"context\":\"Account event\"}]",
                "", PHONE, "interface5", "", "", "CaiNiao");
        repository.saveInterface5(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        ExpressQueryResult stale = new ExpressQueryResult(waybill, "EMS", "EMS",
                StatusSemantic.TRANSIT, "2026-09-11 10:00:00", "已揽收",
                "[{\"time\":\"2026-09-11 10:00:00\",\"context\":\"已揽收\"}]",
                "", PHONE, "v5_query");
        repository.saveAccountTimeline(stale, "interface5");
        ExpressQueryResult h5 = new ExpressQueryResult(waybill, "EMS", "EMS",
                StatusSemantic.UNKNOWN, latest, "H5 event",
                "[{\"time\":\"" + latest + "\",\"context\":\"H5 event\"}]",
                "", PHONE, "cn_h5");
        assertTrue(repository.saveAutomaticDetailTimeline(owner,
                repository.captureManualQueryOwner(owner), h5, true));
        owner = repository.find(owner.rowId);
        assertFalse(ReflectionHelpers.callInstanceMethod(activity, "currentDetailComplete",
                ClassParameter.from(ExpressItem.class, owner)));
        assertFalse(ExpressDetailActivity.automaticSourcesHaveOrigin(repository, owner));
        assertTrue(repository.activateCainiaoManualFallback(owner, repository.captureManualQueryOwner(owner)));
    }

    private ExpressItem order(boolean projected, String detail) {
        String latest = "2026-09-13 12:00:00";
        String route = "https://jingfen.jd.com/item?fixture=1";
        String tracks = "[{\"time\":\"2026-09-11 10:00:00\",\"context\":\"" + detail + "\"}]";
        ExpressQueryResult feed = new ExpressQueryResult("ORDERH5TEST", "JD", "京东购物",
                StatusSemantic.TRANSIT, ExpressTimeline.parseTime(latest), latest,
                "Latest account event", tracks, route,
                PHONE, "interface5", "v5", route, "JingDong");
        repository.saveInterface5OrderSummary(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(feed.waybill, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveRecoveredOwnerRoute(owner,
                repository.captureManualQueryOwner(owner), feed));
        owner = repository.find(owner.rowId);
        assertFalse("source=" + owner.source + " owner=" + owner.stateOwner
                + " provider=" + owner.sourceProvider + " available=" + owner.routeCredentialAvailable
                + " routePresent=" + !owner.routeCredential.isEmpty(),
                ExpressDetailActivity.safeOrderH5Url(owner).isEmpty());
        if (projected) {
            assertTrue(repository.saveOrderProjection(owner, "interface5", "JDREALH5TEST", "京东快递"));
            owner = repository.find(owner.rowId);
        }
        return owner;
    }

    private void refreshAutomatic(ExpressItem owner) {
        ReflectionHelpers.callInstanceMethod(activity, "refreshAutomaticDetail",
                ClassParameter.from(ExpressRepository.class, repository),
                ClassParameter.from(ExpressItem.class, owner),
                ClassParameter.from(ExpressQueryCancellation.class, new ExpressQueryCancellation(1000L)),
                ClassParameter.from(boolean.class, true));
    }

    @Implements(ExpressAutomaticTimelineCapture.class)
    public static class CaptureShadow {
        static int calls;
        static List<String> phones;
        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider,
                ExpressQueryCancellation cancellation) {
            calls++;
            return null;
        }
        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider,
                List<String> candidates, ExpressQueryCancellation cancellation) {
            calls++;
            phones = List.copyOf(candidates);
            return null;
        }
    }
}
