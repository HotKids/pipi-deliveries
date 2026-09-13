package me.pipi.deliveries.background;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.work.Operation;
import com.google.common.util.concurrent.ListenableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

import androidx.work.Constraints;
import androidx.work.Data;
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
    static final String USER_PULL = "user_pull";
    static final String TRIGGER = "trigger";
    static final String WIDGET_RECENT_CHECK = "widget_recent_check";
    static final long WIDGET_RECENT_MS = 60_000L;
    private static final String NETWORK_SUCCESS = "express_network_success";

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
        return requestNow(context, false);
    }

    public static java.util.UUID requestPullRefresh(Context context) {
        return requestNow(context, true);
    }

    private static java.util.UUID requestNow(Context context, boolean userPull) {
        OneTimeWorkRequest request = immediateRequest(userPull);
        WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
                IMMEDIATE_WORK, ExistingWorkPolicy.REPLACE, request);
        return request.getId();
    }

    public static void requestForeground(Context context) {
        enqueueAutomatic(context, "foreground", false);
    }

    static ListenableFuture<Operation.State.SUCCESS> enqueueAutomatic(
            Context context, String trigger, boolean widgetRecentCheck) {
        return WorkManager.getInstance(context.getApplicationContext()).enqueueUniqueWork(
                IMMEDIATE_WORK, ExistingWorkPolicy.KEEP,
                immediateRequest(false, trigger, widgetRecentCheck)).getResult();
    }

    public static void recordNetworkSuccess(Context context, String bindingSource) {
        context.getSharedPreferences(NETWORK_SUCCESS, 0).edit()
                .putLong(bindingSource, System.currentTimeMillis()).commit();
    }

    static boolean hasRecentNetworkSuccess(Context context, String bindingSource, long now) {
        long success = context.getSharedPreferences(NETWORK_SUCCESS, 0).getLong(bindingSource, 0L);
        return success > 0L && now >= success && now - success < WIDGET_RECENT_MS;
    }

    static OneTimeWorkRequest immediateRequest(boolean userPull) {
        return immediateRequest(userPull, userPull ? "list_pull" : "background", false);
    }

    static OneTimeWorkRequest immediateRequest(boolean userPull, String trigger, boolean widgetRecentCheck) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        return new OneTimeWorkRequest.Builder(ExpressSyncWorker.class)
                .setConstraints(constraints)
                .setInputData(new Data.Builder().putBoolean(USER_PULL, userPull)
                        .putString(TRIGGER, trigger).putBoolean(WIDGET_RECENT_CHECK, widgetRecentCheck).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30L, TimeUnit.SECONDS)
                .build();
    }
}
