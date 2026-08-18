package me.pipi.deliveries.background;

import android.content.Context;
import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import me.pipi.deliveries.data.ExpressRepository;

/** Durable, network-constrained execution boundary for all delivery synchronization. */
public final class ExpressSyncWorker extends Worker {
    public ExpressSyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            ExpressRepository repository = ExpressRepository.get(getApplicationContext());
            repository.runPendingMigrations();
            repository.pruneExpiredShipmentsIfDue();
            ExpressSyncEngine.syncAll(getApplicationContext());
            return Result.success();
        } catch (Throwable failure) {
            return getRunAttemptCount() < 3 ? Result.retry() : Result.failure();
        } finally {
            getApplicationContext().sendBroadcast(new Intent(
                    ExpressRepository.ACTION_SYNC_FINISHED)
                    .setPackage(getApplicationContext().getPackageName()));
        }
    }
}
