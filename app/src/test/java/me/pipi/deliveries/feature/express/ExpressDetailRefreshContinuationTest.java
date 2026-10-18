package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import me.pipi.deliveries.R;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class)
public class ExpressDetailRefreshContinuationTest {
    private ExpressDetailActivity activity;
    private QueuedExecutor worker;

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

    @Test public void aJingDongPullSharesTheEntryCaptureWithoutQueuingAnotherAttempt() {
        ReflectionHelpers.setField(activity, "item", jingDongOrder(""));
        ReflectionHelpers.setField(activity, "localRefreshInFlight", true);
        ReflectionHelpers.setField(activity, "localRefreshGeneration", 1);
        pull();
        pull();
        assertFalse(ReflectionHelpers.getField(activity, "pendingDetailPull"));
        finish(1);
        assertEquals(0, worker.tasks.size());
        assertFalse(ReflectionHelpers.getField(activity, "localRefreshInFlight"));
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

    @Test public void aSamePageJingDongJoinDoesNotEndTheEntryOperation() {
        ReflectionHelpers.setField(activity, "item", jingDongOrder(""));
        ReflectionHelpers.setField(activity, "localRefreshInFlight", true);
        pull();
        assertFalse(ReflectionHelpers.getField(activity, "localRefreshJoinedOrderAttempt"));
    }

    @Test public void aProjectedJingDongEntrySharesAnActualH5Capture() {
        me.pipi.deliveries.model.ExpressItem owner = jingDongOrder("JD123456789");
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
