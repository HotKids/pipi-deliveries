package me.pipi.deliveries.background;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.os.Looper;
import androidx.work.impl.utils.futures.SettableFuture;
import androidx.work.Data;
import androidx.work.NetworkType;
import androidx.work.Operation;
import androidx.work.WorkerParameters;
import com.google.common.util.concurrent.ListenableFuture;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import kotlin.coroutines.EmptyCoroutineContext;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.StatusSemantic;
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

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = ExpressWidgetRefreshWorkerTest.EnqueueShadow.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class ExpressWidgetRefreshWorkerTest {
    private Context context;

    @Implements(value = ExpressScheduler.class, isInAndroidSdk = false)
    public static class EnqueueShadow {
        static SettableFuture<Operation.State.SUCCESS> future;
        static CountDownLatch requested;
        @Implementation protected static ListenableFuture<Operation.State.SUCCESS> requestWidgetRefresh(Context context) {
            requested.countDown();
            return future;
        }
    }

    @Before public void reset() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        EnqueueShadow.future = SettableFuture.create();
        EnqueueShadow.requested = new CountDownLatch(1);
    }

    @Test public void requestCanRunOfflineAndUsesOnlyTheLocalWorker() {
        androidx.work.impl.model.WorkSpec spec = ExpressScheduler.widgetRefreshRequest().getWorkSpec();
        assertEquals(NetworkType.NOT_REQUIRED, spec.constraints.getRequiredNetworkType());
        assertEquals(ExpressWidgetRefreshWorker.class.getName(), spec.workerClassName);
    }

    @Test public void broadcastFinishesAfterEnqueueWithoutOpeningExpressDatabase() throws Exception {
        CountDownLatch finished = new CountDownLatch(1);
        ExpressScheduler.handoffWidgetRefresh(context, finished::countDown);
        assertTrue(EnqueueShadow.requested.await(2, TimeUnit.SECONDS));
        assertEquals(1L, finished.getCount());
        assertFalse(context.getDatabasePath(ExpressDatabase.DATABASE).exists());
        EnqueueShadow.future.set(Operation.SUCCESS);
        assertTrue(finished.await(2, TimeUnit.SECONDS));
        assertFalse(context.getDatabasePath(ExpressDatabase.DATABASE).exists());
        assertEquals(androidx.work.ListenableWorker.Result.success(), runWorker());
        assertTrue(context.getDatabasePath(ExpressDatabase.DATABASE).exists());
    }

    @Test public void failedAndTimedOutEnqueueFinishTheBroadcastOnlyOnce() throws Exception {
        AtomicInteger finished = new AtomicInteger();
        ExpressScheduler.handoffWidgetRefresh(context, finished::incrementAndGet);
        assertTrue(EnqueueShadow.requested.await(2, TimeUnit.SECONDS));
        Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(
                ExpressScheduler.BROADCAST_HANDOFF_TIMEOUT_MS));
        assertEquals(1, finished.get());
        EnqueueShadow.future.setException(new IllegalStateException("Synthetic enqueue failure"));
        assertEquals(1, finished.get());
        assertFalse(context.getDatabasePath(ExpressDatabase.DATABASE).exists());
    }

    @Test public void workerUpgradesSchemaAndAnchorsLegacySignedRowsBeforePresentation() throws Exception {
        ExpressDatabase helper = new ExpressDatabase(context);
        SQLiteDatabase db = helper.getWritableDatabase();
        ContentValues row = new ContentValues();
        row.put("mailNo", "SFWIDGETUPGRADE");
        row.put("fromCp", "V4");
        row.put("stateOwner", "V4");
        row.put("data3", "manual");
        row.put("logsiticsStatus", StatusSemantic.COMPLETED.storageCode);
        row.put("statusEventTime", System.currentTimeMillis() - 60_000L);
        row.put("updatedAt", System.currentTimeMillis());
        long id = db.insertOrThrow(ExpressDatabase.EXPRESS_TABLE, null, row);
        db.setVersion(ExpressDatabase.VERSION - 1);
        helper.close();
        assertEquals(androidx.work.ListenableWorker.Result.success(), runWorker());
        helper = new ExpressDatabase(context);
        db = helper.getReadableDatabase();
        assertEquals(ExpressDatabase.VERSION, db.getVersion());
        try (Cursor cursor = db.rawQuery("SELECT signedRetainedAt FROM server_express WHERE _id=?",
                new String[]{Long.toString(id)})) {
            assertTrue(cursor.moveToFirst());
            assertTrue(cursor.getLong(0) > 0L);
        }
        helper.close();
    }

    private androidx.work.ListenableWorker.Result runWorker() throws Exception {
        WorkerParameters parameters = new WorkerParameters(UUID.randomUUID(), Data.EMPTY,
                List.of(), new WorkerParameters.RuntimeExtras(), 0, 0, Runnable::run,
                EmptyCoroutineContext.INSTANCE, null, null, null, null);
        java.util.concurrent.ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            return worker.submit(() -> new ExpressWidgetRefreshWorker(context, parameters).doWork())
                    .get(3L, TimeUnit.SECONDS);
        } finally { worker.shutdownNow(); }
    }
}
