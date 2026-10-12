package me.pipi.deliveries.background;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import androidx.work.Data;
import androidx.work.ListenableWorker;
import androidx.work.WorkInfo;
import androidx.work.WorkerParameters;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import kotlin.coroutines.EmptyCoroutineContext;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.feature.express.ExpressBackgroundOrderProjection;
import me.pipi.deliveries.network.CarrierAuthority;
import me.pipi.deliveries.network.ExpressAccountSource;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;

/** 用户定 2026-09-24：后台轮次提交成功之后才开京东订单投影，且带着 worker 的起点时刻与停止信号。 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class, shadows = {
        ExpressSyncWorkerProjectionTest.Round.class,
        ExpressSyncWorkerProjectionTest.Authority.class,
        ExpressSyncWorkerProjectionTest.Projection.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class ExpressSyncWorkerProjectionTest {
    private Application context;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String prefs : new String[]{"deliveries_repository_migrations", "express_network_success"}) {
            context.getSharedPreferences(prefs, 0).edit().clear().commit();
        }
        Round.fail = false;
        Round.calls.set(0);
        Projection.workStarts.clear();
        Projection.stopSignals.clear();
        Projection.announcedBefore.clear();
    }

    @After public void tearDown() {
        ExpressRepository repository =
                ReflectionHelpers.getStaticField(ExpressRepository.class, "instance");
        if (repository != null) {
            ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        }
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aCommittedRoundHandsItsClockAndStopSignalToTheOrderProjection()
            throws Exception {
        ExpressSyncWorker worker = worker(Data.EMPTY);
        long before = System.nanoTime();

        assertEquals(ListenableWorker.Result.success(), run(worker));

        assertEquals(1, Round.calls.get());
        assertEquals(1, Projection.stopSignals.size());
        assertTrue("the time budget counts from the worker's start",
                Projection.workStarts.get(0) - before >= 0L);
        assertEquals("the pages run before the round announces it finished",
                List.of(false), Projection.announcedBefore);
        assertTrue(Shadows.shadowOf(context).getBroadcastIntents().stream().anyMatch(intent ->
                ExpressRepository.ACTION_SYNC_FINISHED.equals(intent.getAction())));
        BooleanSupplier stopped = Projection.stopSignals.get(0);
        assertFalse(stopped.getAsBoolean());
        worker.stop(WorkInfo.STOP_REASON_CANCELLED_BY_APP);
        assertTrue("WorkManager's stop reaches the capture", stopped.getAsBoolean());
    }

    @Test public void aFailedRoundNeverOpensAPage() throws Exception {
        Round.fail = true;

        assertEquals(ListenableWorker.Result.retry(), run(worker(Data.EMPTY)));

        assertEquals(1, Round.calls.get());
        assertTrue(Projection.stopSignals.isEmpty());
    }

    @Test public void aRecentWidgetCheckRunsNoRoundAndOpensNoPage() throws Exception {
        ExpressScheduler.recordNetworkSuccess(context, ExpressAccountSource.bindingSource(context));

        assertEquals(ListenableWorker.Result.success(), run(worker(new Data.Builder()
                .putBoolean(ExpressScheduler.WIDGET_RECENT_CHECK, true).build())));

        assertEquals(0, Round.calls.get());
        assertTrue(Projection.stopSignals.isEmpty());
    }

    private ExpressSyncWorker worker(Data input) {
        return new ExpressSyncWorker(context, new WorkerParameters(UUID.randomUUID(), input,
                List.of(), new WorkerParameters.RuntimeExtras(), 0, 0, Runnable::run,
                EmptyCoroutineContext.INSTANCE, null, null, null, null));
    }

    private static ListenableWorker.Result run(ExpressSyncWorker worker) throws Exception {
        ExecutorService thread = Executors.newSingleThreadExecutor();
        try {
            return thread.submit(worker::doWork).get(10L, TimeUnit.SECONDS);
        } finally { thread.shutdownNow(); }
    }

    @Implements(className = "me.pipi.deliveries.background.ExpressSyncEngine", isInAndroidSdk = false)
    public static class Round {
        static volatile boolean fail;
        static final AtomicInteger calls = new AtomicInteger();

        @Implementation protected static void syncAll(
                Context context, int[] network, boolean userPull, String trigger) {
            calls.incrementAndGet();
            network[0] = 1;
            if (fail) throw new IllegalStateException("All delivery sources failed");
            network[1] = 1;
            network[2] = 1;
        }
    }

    @Implements(value = CarrierAuthority.class, isInAndroidSdk = false)
    public static class Authority {
        @Implementation protected static boolean refreshIfDue(Context context) {
            return false;
        }
    }

    @Implements(value = ExpressBackgroundOrderProjection.class, isInAndroidSdk = false)
    public static class Projection {
        static final List<Long> workStarts = new CopyOnWriteArrayList<>();
        static final List<BooleanSupplier> stopSignals = new CopyOnWriteArrayList<>();
        static final List<Boolean> announcedBefore = new CopyOnWriteArrayList<>();

        @Implementation protected static void afterCommittedRound(
                Context context, long workStartedAtNanos, BooleanSupplier stopped) {
            workStarts.add(workStartedAtNanos);
            stopSignals.add(stopped);
            announcedBefore.add(Shadows.shadowOf((Application) context.getApplicationContext())
                    .getBroadcastIntents().stream().anyMatch(intent ->
                            ExpressRepository.ACTION_SYNC_FINISHED.equals(intent.getAction())));
        }
    }
}
