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
        // A cancelled or periodic worker may finish while a newer pull is running.
        // Attempts, successes, and successful account-list persistence.
        int[] summary = {0, 0, 0};
        try {
            CarrierAuthority.refreshIfDue(getApplicationContext());
            ExpressRepository repository = ExpressRepository.get(getApplicationContext());
            repository.runPendingMigrations();
            repository.pruneExpiredShipmentsIfDue();
            ExpressSyncEngine.syncAll(getApplicationContext(), summary);
            return Result.success();
        } catch (Throwable failure) {
            if (summary[0] == 0) summary[0] = 1;
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
                    .setPackage(context.getPackageName())
                    .putExtra(ExpressRepository.EXTRA_SYNC_WORK_ID, getId().toString())
                    .putExtra(ExpressRepository.EXTRA_SYNC_ATTEMPTED, summary[0])
                    .putExtra(ExpressRepository.EXTRA_SYNC_SUCCEEDED, summary[1])
                    .putExtra(ExpressRepository.EXTRA_SYNC_ACCOUNT_LIST_UPDATED, summary[2] == 1)
                    .putExtra(ExpressRepository.EXTRA_SYNC_FAILED,
                            Math.max(0, summary[0] - summary[1])));
        }
    }
}
