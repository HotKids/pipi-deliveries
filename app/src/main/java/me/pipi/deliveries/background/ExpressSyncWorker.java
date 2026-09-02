package me.pipi.deliveries.background;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.network.CarrierAuthority;
import me.pipi.deliveries.widget.ExpressWidgetProvider;

/** Durable, network-constrained execution boundary for all delivery synchronization. */
public final class ExpressSyncWorker extends Worker {
    private static final String TAG = "ExpressSyncWorker";

    public ExpressSyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            CarrierAuthority.refreshIfDue(getApplicationContext());
            ExpressRepository repository = ExpressRepository.get(getApplicationContext());
            repository.runPendingMigrations();
            repository.pruneExpiredShipmentsIfDue();
            ExpressSyncEngine.syncAll(getApplicationContext());
            return Result.success();
        } catch (Throwable failure) {
            return getRunAttemptCount() < 3 ? Result.retry() : Result.failure();
        } finally {
            Context context = getApplicationContext();
            try {
                ExpressWidgetProvider.refreshAll(context);
            } catch (RuntimeException failure) {
                // A launcher-specific widget failure must not suppress list reconciliation.
                Log.w(TAG, "Widget reconciliation failed", failure);
            }
            context.sendBroadcast(new Intent(
                    ExpressRepository.ACTION_SYNC_FINISHED)
                    .setPackage(context.getPackageName()));
        }
    }
}
