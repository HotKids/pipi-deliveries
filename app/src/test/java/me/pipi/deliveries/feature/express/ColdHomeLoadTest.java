package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;

import android.app.Application;
import android.content.Context;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;
import me.pipi.deliveries.background.ExpressScheduler;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, application = Application.class, shadows = ColdHomeLoadTest.Scheduler.class)
public final class ColdHomeLoadTest {
    @Test public void theFirstLifecycleQueuesOneLocalReadAndReturningQueuesAnother() {
        ActivityController<ExpressListActivity> controller = Robolectric.buildActivity(ExpressListActivity.class);
        QueuedReads reads = new QueuedReads();
        ReflectionHelpers.setField(controller.get(), "databaseWorker", reads);
        controller.create().start();
        assertEquals("the initial read must not be discarded behind a duplicate scan", 1, reads.tasks.size());
        controller.stop().start();
        assertEquals("a later return still reloads persisted state", 2, reads.tasks.size());
        controller.stop().destroy();
    }

    @Implements(value = ExpressScheduler.class, isInAndroidSdk = false)
    public static class Scheduler {
        @Implementation public static void requestForeground(Context context) {}
    }

    private static final class QueuedReads extends AbstractExecutorService {
        final List<Runnable> tasks = new ArrayList<>();
        @Override public void execute(Runnable task) { tasks.add(task); }
        @Override public void shutdown() {}
        @Override public List<Runnable> shutdownNow() { return List.of(); }
        @Override public boolean isShutdown() { return false; }
        @Override public boolean isTerminated() { return false; }
        @Override public boolean awaitTermination(long timeout, TimeUnit unit) { return true; }
    }
}
