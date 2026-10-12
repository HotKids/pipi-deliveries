package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.os.Looper;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.widget.Express2x2WidgetProvider;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = {ExpressDatabaseThreadingTest.RepositoryShadow.class, ColdHomeLoadTest.Scheduler.class})
public class ExpressDatabaseThreadingTest {
    @Implements(value = ExpressRepository.class, isInAndroidSdk = false)
    public static class RepositoryShadow {
        static CountDownLatch read;
        static volatile CountDownLatch release;
        static final AtomicBoolean mainThread = new AtomicBoolean();

        private static void recordRead() {
            if (Looper.myLooper() == Looper.getMainLooper()) mainThread.set(true);
            read.countDown();
        }

        @Implementation protected ExpressItem find(long rowId) {
            recordRead();
            CountDownLatch held = release;
            if (held != null && Looper.myLooper() != Looper.getMainLooper()) {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3L);
                while (held.getCount() != 0 && System.nanoTime() < deadline) {
                    try {
                        held.await(100L, TimeUnit.MILLISECONDS);
                    } catch (InterruptedException ignored) {
                        // Simulate an already-running SQLite read that cannot be interrupted.
                    }
                }
            }
            return null;
        }

        @Implementation protected ExpressItem findByWaybill(String waybill, String source) {
            recordRead();
            return null;
        }

        @Implementation protected List<ExpressItem> listVisible(String source) {
            recordRead();
            return Collections.emptyList();
        }

        @Implementation protected List<ExpressItem> listVisibleForHome(String source) {
            recordRead();
            return Collections.emptyList();
        }

        @Implementation protected List<String> phones(String source) {
            recordRead();
            return Collections.emptyList();
        }
    }

    @Before public void reset() {
        RepositoryShadow.read = new CountDownLatch(1);
        RepositoryShadow.release = null;
        RepositoryShadow.mainThread.set(false);
    }

    private void assertBackgroundRead() throws Exception {
        assertTrue(RepositoryShadow.read.await(3L, TimeUnit.SECONDS));
        assertFalse(RepositoryShadow.mainThread.get());
    }

    @Test public void listLoadsItsRowsAwayFromMainThread() throws Exception {
        ActivityController<ExpressListActivity> activity = Robolectric.buildActivity(ExpressListActivity.class);
        activity.get().setTheme(R.style.AppTheme);
        try {
            activity.create().start();
            assertBackgroundRead();
        } finally { activity.stop().destroy(); }
    }

    @Test public void managerLoadsItsPhonesAwayFromMainThread() throws Exception {
        ActivityController<ExpressManagerActivity> activity = Robolectric.buildActivity(ExpressManagerActivity.class);
        activity.get().setTheme(R.style.AppTheme);
        try {
            activity.create().start().resume();
            assertBackgroundRead();
        } finally { activity.pause().stop().destroy(); }
    }

    @Test public void detailLoadsItsOwnerAwayFromMainThread() throws Exception {
        ActivityController<ExpressDetailActivity> activity = Robolectric.buildActivity(
                ExpressDetailActivity.class, new Intent().putExtra(ExpressDetailActivity.EXTRA_ROW_ID, 1L));
        activity.get().setTheme(R.style.AppTheme);
        try {
            activity.create().start();
            assertBackgroundRead();
        } finally { activity.stop().destroy(); }
    }

    @Test public void previewLoadsItsTimelineStateAwayFromMainThread() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        ExpressQueryResult preview = new ExpressQueryResult("SYNTHETIC123456", "ZTO", "",
                StatusSemantic.UNKNOWN, "", "", "[]");
        ActivityController<ExpressDetailActivity> activity = Robolectric.buildActivity(
                ExpressDetailActivity.class, ExpressDetailActivity.transientOnlinePreviewIntent(
                        context, preview, "", ExpressAccountSource.bindingSource(context)));
        activity.get().setTheme(R.style.AppTheme);
        try {
            activity.create().start();
            assertBackgroundRead();
        } finally { activity.stop().destroy(); }
    }

    @Test public void stoppedInitialReadCannotFinishThePageAndRestartLoadsAgain() throws Exception {
        RepositoryShadow.release = new CountDownLatch(1);
        ActivityController<ExpressDetailActivity> activity = detailActivity();
        try {
            activity.create().start().resume();
            assertBackgroundRead();
            activity.pause().stop();
            RepositoryShadow.release.countDown();
            drainDetailWorker(activity.get());
            assertFalse(activity.get().isFinishing());

            RepositoryShadow.release = null;
            RepositoryShadow.read = new CountDownLatch(1);
            activity.start().resume();
            assertBackgroundRead();
            drainDetailWorker(activity.get());
            assertTrue(activity.get().isFinishing());
            activity.pause().stop();
        } finally {
            if (RepositoryShadow.release != null) RepositoryShadow.release.countDown();
            activity.destroy();
        }
    }

    @Test public void destroyedPageRejectsALateInitialRead() throws Exception {
        RepositoryShadow.release = new CountDownLatch(1);
        ActivityController<ExpressDetailActivity> activity = detailActivity();
        activity.create().start().resume();
        try {
            assertBackgroundRead();
            activity.pause().stop().destroy();
        } finally {
            RepositoryShadow.release.countDown();
        }
        java.util.concurrent.ExecutorService worker = detailWorker(activity.get());
        assertTrue(worker.awaitTermination(3L, TimeUnit.SECONDS));
        org.robolectric.Shadows.shadowOf(Looper.getMainLooper()).idle();
        assertFalse(activity.get().isFinishing());
    }

    private static ActivityController<ExpressDetailActivity> detailActivity() {
        ActivityController<ExpressDetailActivity> activity = Robolectric.buildActivity(
                ExpressDetailActivity.class, new Intent().putExtra(ExpressDetailActivity.EXTRA_ROW_ID, 1L));
        activity.get().setTheme(R.style.AppTheme);
        return activity;
    }

    private static java.util.concurrent.ExecutorService detailWorker(ExpressDetailActivity activity)
            throws Exception {
        java.lang.reflect.Field field = ExpressDetailActivity.class.getDeclaredField("worker");
        field.setAccessible(true);
        return (java.util.concurrent.ExecutorService) field.get(activity);
    }

    private static void drainDetailWorker(ExpressDetailActivity activity) throws Exception {
        detailWorker(activity).submit(() -> { }).get(3L, TimeUnit.SECONDS);
        org.robolectric.Shadows.shadowOf(Looper.getMainLooper()).idle();
    }

}
