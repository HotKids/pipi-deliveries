package me.pipi.deliveries.background;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.work.Operation;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.BackoffPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/** WorkManager scheduler that survives process death, reboot and Doze deferral. */
public final class ExpressScheduler {
    private static final String PERIODIC_WORK = "deliveries_periodic_sync";
    private static final String IMMEDIATE_WORK = "deliveries_immediate_sync";

    private static final String WIDGET_WORK = "deliveries_local_widget_refresh";
    static final long BROADCAST_HANDOFF_TIMEOUT_MS = 8_000L;

    private ExpressScheduler() {}

    static OneTimeWorkRequest widgetRefreshRequest() {
        return new OneTimeWorkRequest.Builder(ExpressWidgetRefreshWorker.class).build();
    }

    static ListenableFuture<Operation.State.SUCCESS> requestWidgetRefresh(Context context) {
        return WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
                WIDGET_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, widgetRefreshRequest()).getResult();
    }

    /** The broadcast waits only for durable enqueue, never database migration or widget rendering. */
    public static void handoffWidgetRefresh(Context context, Runnable finished) {
        Handler main = new Handler(Looper.getMainLooper());
        AtomicBoolean completed = new AtomicBoolean();
        Runnable timeout = () -> {
            if (!completed.compareAndSet(false, true)) return;
            Log.w("ExpressWidgetRefresh", "Local widget enqueue timed out; persistence is unverified");
            finished.run();
        };
        Runnable finish = () -> {
            if (!completed.compareAndSet(false, true)) return;
            main.removeCallbacks(timeout);
            finished.run();
        };
        main.postDelayed(timeout, BROADCAST_HANDOFF_TIMEOUT_MS);
        new Thread(() -> {
            try {
                ListenableFuture<Operation.State.SUCCESS> enqueued = requestWidgetRefresh(context);
                enqueued.addListener(() -> {
                    try {
                        enqueued.get();
                    } catch (Exception failure) {
                        Log.w("ExpressWidgetRefresh", "Local widget enqueue failed: "
                                + failure.getClass().getSimpleName());
                    } finally { finish.run(); }
                }, Runnable::run);
            } catch (RuntimeException failure) {
                Log.w("ExpressWidgetRefresh", "Local widget enqueue failed: "
                        + failure.getClass().getSimpleName());
                finish.run();
            }
        }, "deliveries-widget-handoff").start();
    }

    public static void ensureScheduled(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                ExpressSyncWorker.class, 15L, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniquePeriodicWork(
                PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request);
    }

    public static java.util.UUID requestNow(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(ExpressSyncWorker.class)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30L, TimeUnit.SECONDS)
                .build();
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
                IMMEDIATE_WORK, ExistingWorkPolicy.REPLACE, request);
        return request.getId();
    }
}
