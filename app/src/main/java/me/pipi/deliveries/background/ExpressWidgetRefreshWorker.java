package me.pipi.deliveries.background;

import android.content.Context;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.widget.ExpressWidgetProvider;

/** Local widget reconciliation survives the broadcast without requiring a network. */
public final class ExpressWidgetRefreshWorker extends Worker {
    public ExpressWidgetRefreshWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull @Override public Result doWork() {
        try {
            ExpressRepository.get(getApplicationContext()).runPendingMigrations();
            ExpressWidgetProvider.refreshAll(getApplicationContext());
            String source = me.pipi.deliveries.network.ExpressAccountSource.bindingSource(getApplicationContext());
            if (!ExpressScheduler.hasRecentNetworkSuccess(getApplicationContext(), source, System.currentTimeMillis())) {
                ExpressScheduler.enqueueAutomatic(getApplicationContext(), "background", true)
                        .get(ExpressScheduler.BROADCAST_HANDOFF_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS);
            }
            return Result.success();
        } catch (Exception failure) {
            if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
            Log.w("ExpressWidgetRefresh", "Local widget refresh failed: " + failure.getClass().getSimpleName());
            return getRunAttemptCount() < 3 ? Result.retry() : Result.failure();
        }
    }
}
