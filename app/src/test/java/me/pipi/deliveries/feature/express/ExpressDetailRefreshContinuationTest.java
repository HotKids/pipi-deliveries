package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {SyntheticSecretBox.class, JingDongEmptyOrderPageTest.QueryShadow.class,
                JingDongEmptyOrderPageTest.CaptureShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class ExpressDetailRefreshContinuationTest {
    private ExpressDetailActivity activity;
    private QueuedExecutor worker;
    private ExpressRepository repository;

    @Before public void setUp() {
        activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        activity.setTheme(R.style.AppTheme);
        worker = new QueuedExecutor();
        ReflectionHelpers.setField(activity, "worker", worker);
        ReflectionHelpers.setField(activity, "item",
                ExpressInterfaceDetailPolicyTest.owner("INTERFACE5", "CaiNiao"));
        ReflectionHelpers.setField(activity, "nativeProgress", new LinearProgressIndicator(activity));
        ReflectionHelpers.setField(activity, "detailEntryObserved", true);
    }

    @After public void tearDown() {
        worker.shutdownNow();
        if (repository != null) {
            ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
            ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
            activity.deleteDatabase(ExpressDatabase.DATABASE);
        }
    }

    @Test public void pullWaitsForEntryThenStartsOneDistinctHistoryOperation() {
        ReflectionHelpers.setField(activity, "localRefreshInFlight", true);
        ReflectionHelpers.setField(activity, "localRefreshGeneration", 1);
        pull();
        pull();
        assertTrue(ReflectionHelpers.getField(activity, "pullRefreshRequested"));
        assertEquals(0, worker.tasks.size());
        finish(1);
        assertEquals(1, worker.tasks.size());
        assertTrue(ReflectionHelpers.getField(activity, "localRefreshInFlight"));
        assertTrue(ReflectionHelpers.getField(activity, "pullRefreshRequested"));
    }

    @Test public void equivalentPullsShareTheActiveHistoryOperation() {
        pull();
        pull();
        assertEquals(1, worker.tasks.size());
        finish(1);
        assertEquals(1, worker.tasks.size());
        assertFalse(ReflectionHelpers.getField(activity, "localRefreshInFlight"));
    }

    @Test public void anUnprojectedJingDongQueryQueuesOneExplicitHistoryPull() {
        ReflectionHelpers.setField(activity, "item", jingDongOrder(""));
        ReflectionHelpers.setField(activity, "localRefreshInFlight", true);
        ReflectionHelpers.setField(activity, "localRefreshGeneration", 1);
        pull();
        pull();
        assertTrue(ReflectionHelpers.getField(activity, "pendingDetailPull"));
        finish(1);
        assertEquals(1, worker.tasks.size());
        assertTrue(ReflectionHelpers.getField(activity, "localRefreshInFlight"));
    }

    @Test public void aProjectedJingDongEntryStillQueuesItsDistinctHistoryPull() {
        ReflectionHelpers.setField(activity, "item", jingDongOrder("JD123456789"));
        ReflectionHelpers.setField(activity, "localRefreshInFlight", true);
        ReflectionHelpers.setField(activity, "localRefreshGeneration", 1);
        pull();
        assertTrue(ReflectionHelpers.getField(activity, "pendingDetailPull"));
        finish(1);
        assertEquals(1, worker.tasks.size());
    }

    @Test public void aPullQueuedBeforeCaptureRetriesAfterAnOrdinaryCaptureFailure() throws Exception {
        assertQueuedPullAfterCapture(false);
    }

    @Test public void aPullQueuedBeforeCaptureCannotBypassItsLaterRiskControl() throws Exception {
        assertQueuedPullAfterCapture(true);
    }

    private void assertQueuedPullAfterCapture(boolean riskControl) throws Exception {
        ExpressItem owner = persistedJingDongOrder();
        ReflectionHelpers.setField(activity, "item", owner);
        activity.setContentView(R.layout.activity_express_detail);
        ReflectionHelpers.setField(activity, "statusView", activity.findViewById(R.id.detail_status));
        ReflectionHelpers.setField(activity, "waybillView", activity.findViewById(R.id.detail_waybill));
        ReflectionHelpers.setField(activity, "hotlineView", activity.findViewById(R.id.detail_hotline_value));
        ReflectionHelpers.setField(activity, "hotlineRow", activity.findViewById(R.id.detail_hotline));
        ReflectionHelpers.setField(activity, "timeline", activity.findViewById(R.id.timeline));
        ReflectionHelpers.setField(activity, "detailEntryObserved", false);
        JingDongEmptyOrderPageTest.QueryShadow.calls = 0;
        JingDongEmptyOrderPageTest.CaptureShadow.pages = 0;
        JingDongEmptyOrderPageTest.CaptureShadow.result = riskControl
                ? new ExpressAutomaticTimelineCapture.Result(null, false, true, false, false, false)
                : null;

        ReflectionHelpers.callInstanceMethod(activity, "refreshLocalTimelineInBackground",
                ClassParameter.from(boolean.class, false));
        assertEquals(1, worker.tasks.size());
        assertNull(ExpressOrderProjectionRetryStore.activeAttempt(owner));
        pull();
        pull();
        assertTrue(ReflectionHelpers.getField(activity, "pendingDetailPull"));

        // The entry's real worker claims and completes its page only after both gestures arrived.
        worker.tasks.remove(0).run();
        assertEquals(1, JingDongEmptyOrderPageTest.QueryShadow.calls);
        assertEquals(1, JingDongEmptyOrderPageTest.CaptureShadow.pages);
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(activity);
        long now = System.currentTimeMillis();
        assertNull(ExpressOrderProjectionRetryStore.activeAttempt(owner));
        assertFalse(retries.timelineAttemptDue(owner, now));
        assertEquals(riskControl ? "risk_control_cooldown" : "cooldown",
                retries.timelineSkipReason(owner, now));
        assertEquals("repeated gestures queue one explicit continuation", 2,
                (int) ReflectionHelpers.getField(activity, "localRefreshGeneration"));
        assertTrue(ReflectionHelpers.getField(activity, "localRefreshInFlight"));

        int remainingTasks = 10;
        while (!worker.tasks.isEmpty()) {
            assertTrue("the continuation and display persistence must finish", remainingTasks-- > 0);
            worker.tasks.remove(0).run();
        }
        assertEquals("only ordinary capture failure permits the queued explicit pull to open a page",
                riskControl ? 1 : 2, JingDongEmptyOrderPageTest.CaptureShadow.pages);
        assertEquals("a history pull does not repeat the account query", 1,
                JingDongEmptyOrderPageTest.QueryShadow.calls);
        assertFalse("the queued worker must reach its capture policy without an unexpected failure",
                ReflectionHelpers.getField(activity, "localRefreshFailed"));
        assertFalse(ReflectionHelpers.getField(activity, "localRefreshInFlight"));
        assertFalse(ReflectionHelpers.getField(activity, "pendingDetailPull"));
        assertFalse(ReflectionHelpers.getField(activity, "pullRefreshRequested"));
        assertNull(ExpressOrderProjectionRetryStore.activeAttempt(owner));
        assertNotNull(repository.find(owner.rowId));
    }

    private ExpressItem persistedJingDongOrder() throws Exception {
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        activity.deleteDatabase(ExpressDatabase.DATABASE);
        activity.getSharedPreferences("express_jd_h5_cooldown", 0).edit().clear().commit();
        activity.getSharedPreferences("express_jd_h5_empty_page", 0).edit().clear().commit();
        repository = ExpressRepository.get(activity);
        String phone = "13800000052";
        String orderId = "350000000052";
        String route = "https://jingfen.jd.com/item?fixture=52";
        String time = at("2026-09-20 10:00:00");
        long eventAt = ExpressTimeline.parseTime(time);
        StatusSemantic semantic = StatusSemantic.TRANSIT;
        String detail = "Synthetic order in transit";
        repository.bindPhoneLocally(phone, "interface5");
        ExpressQueryResult feed = new ExpressQueryResult(orderId, "JDKD", "京东商品快递",
                semantic, eventAt, time, detail,
                new JSONArray().put(new JSONObject().put("time", time).put("context", detail)).toString(),
                route, phone, "interface5", "v5", route, "JingDong")
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject()
                        .put("normalizedStatus", new JSONObject().put("version", 1)
                                .put("scope", "ORDER").put("semantic", semantic.name())
                                .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                                .put("eventAtMs", eventAt).put("structured", true))));
        repository.saveInterface5OrderSummary(feed, phone);
        ExpressItem owner = repository.findByWaybill(orderId, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveRecoveredOwnerRoute(owner, repository.captureManualQueryOwner(owner), feed));
        owner = repository.find(owner.rowId);
        assertTrue(owner.isAccountOrder());
        assertTrue(owner.projectedWaybill.isEmpty());
        assertFalse(ExpressDetailActivity.safeOrderH5Url(owner).isEmpty());
        return owner;
    }

    @Test public void aSamePageJingDongJoinDoesNotEndTheEntryOperation() {
        ReflectionHelpers.setField(activity, "item", jingDongOrder(""));
        ReflectionHelpers.setField(activity, "localRefreshInFlight", true);
        pull();
        assertFalse(ReflectionHelpers.getField(activity, "localRefreshJoinedOrderAttempt"));
    }

    @Test public void anUnprojectedJingDongEntrySharesAnActualH5Capture() {
        assertActualCaptureShared("");
    }

    @Test public void aProjectedJingDongEntrySharesAnActualH5Capture() {
        assertActualCaptureShared("JD123456789");
    }

    private void assertActualCaptureShared(String waybill) {
        me.pipi.deliveries.model.ExpressItem owner = jingDongOrder(waybill);
        ReflectionHelpers.setField(activity, "item", owner);
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(activity);
        ExpressOrderProjectionRetryStore.AttemptToken capture =
                retries.beginTimelineAttempt(owner, System.currentTimeMillis());
        assertNotNull(capture);
        try {
            ReflectionHelpers.setField(activity, "localRefreshInFlight", true);
            ReflectionHelpers.setField(activity, "localRefreshGeneration", 1);
            pull();
            assertFalse(ReflectionHelpers.getField(activity, "pendingDetailPull"));
            finish(1);
            assertEquals(0, worker.tasks.size());
        } finally { retries.endAttempt(capture); }
    }

    @Test public void aProjectedJingDongQueryLeaseDoesNotReplaceTheHistoryPull() {
        me.pipi.deliveries.model.ExpressItem owner = jingDongOrder("JD123456789");
        ReflectionHelpers.setField(activity, "item", owner);
        ExpressOrderProjectionRetryStore.AttemptToken query = ExpressOrderProjectionRetryStore.acquireAttempt(owner);
        assertNotNull(query);
        try {
            ReflectionHelpers.setField(activity, "localRefreshInFlight", true);
            pull();
            assertTrue(ReflectionHelpers.getField(activity, "pendingDetailPull"));
        } finally { ExpressOrderProjectionRetryStore.releaseAttempt(query); }
    }

    @Test public void cancellationFencesThePendingPullContinuation() {
        ReflectionHelpers.setField(activity, "localRefreshInFlight", true);
        ReflectionHelpers.setField(activity, "localRefreshGeneration", 1);
        pull();
        ReflectionHelpers.callInstanceMethod(activity, "cancelLocalTimelineRefresh",
                ClassParameter.from(int.class, 1), ClassParameter.from(boolean.class, false));
        finish(1);
        assertEquals(0, worker.tasks.size());
        assertFalse(ReflectionHelpers.getField(activity, "localRefreshInFlight"));
    }

    private void pull() {
        ReflectionHelpers.setField(activity, "pullRefreshRequested", true);
        ReflectionHelpers.callInstanceMethod(activity, "refreshLocalTimelineInBackground",
                ClassParameter.from(boolean.class, true));
    }

    private static me.pipi.deliveries.model.ExpressItem jingDongOrder(String projectedWaybill) {
        return new me.pipi.deliveries.model.ExpressItem(10L, "", "JDORDER10", "JD", "京东购物",
                me.pipi.deliveries.model.StatusSemantic.TRANSIT, "运输中", "已揽收", "2026-09-09 10:00:00",
                "[]", "", "I5-JD", "", 1L, 2L, "I5-JD", "", "v5", "https://jingfen.jd.com/item?fixture=10", true,
                projectedWaybill, "", "[]", "JingDong");
    }

    private void finish(int generation) {
        ReflectionHelpers.callInstanceMethod(activity, "finishLocalTimelineRefresh",
                ClassParameter.from(int.class, generation));
    }

    private static final class QueuedExecutor extends AbstractExecutorService {
        final List<Runnable> tasks = new ArrayList<>();
        private boolean stopped;
        @Override public void execute(Runnable task) { tasks.add(task); }
        @Override public void shutdown() { stopped = true; }
        @Override public List<Runnable> shutdownNow() { stopped = true; return tasks; }
        @Override public boolean isShutdown() { return stopped; }
        @Override public boolean isTerminated() { return stopped; }
        @Override public boolean awaitTermination(long timeout, TimeUnit unit) { return stopped; }
    }
}
