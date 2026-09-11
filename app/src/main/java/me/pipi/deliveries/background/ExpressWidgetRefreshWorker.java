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
            return Result.success();
        } catch (RuntimeException failure) {
            Log.w("ExpressWidgetRefresh", "Local widget refresh failed: " + failure.getClass().getSimpleName());
            return getRunAttemptCount() < 3 ? Result.retry() : Result.failure();
        }
    }
}
