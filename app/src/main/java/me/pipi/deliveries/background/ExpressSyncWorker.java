package me.pipi.deliveries.background;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.feature.express.ExpressBackgroundOrderProjection;
import me.pipi.deliveries.network.CarrierAuthority;
import me.pipi.deliveries.widget.ExpressWidgetProvider;

/** Durable, network-constrained execution boundary for all delivery synchronization. */
public final class ExpressSyncWorker extends Worker {

    public ExpressSyncWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        long startedAtNanos = System.nanoTime();
        // A cancelled or periodic worker may finish while a newer pull is running.
        // Attempts, successes, and successful account-list persistence.
        int[] summary = {0, 0, 0};
        boolean retrying = false;
        boolean committed = false;
        ExpressRepository repository = null;
        long invalidationBeforeSync = 0L;
        ExpressStatusAlignment.roundStarted();
        try {
            if (getInputData().getBoolean(ExpressScheduler.WIDGET_RECENT_CHECK, false)
                    && ExpressScheduler.hasRecentNetworkSuccess(getApplicationContext(),
                    me.pipi.deliveries.network.ExpressAccountSource.bindingSource(getApplicationContext()), System.currentTimeMillis())) {
                me.pipi.deliveries.network.ExpressLog.write("widget.refresh.skipped", "skipReason", "recent_state");
                return Result.success();
            }
            // 优化 8-1: the process's first round is its start refresh; Home's first return right after it does not repeat it.
            ExpressScheduler.recordRoundStarted(android.os.SystemClock.elapsedRealtime());
            CarrierAuthority.refreshIfDue(getApplicationContext());
            repository = ExpressRepository.get(getApplicationContext());
            invalidationBeforeSync = repository.invalidationVersion();
            repository.runPendingMigrations();
            repository.pruneExpiredShipmentsIfDue();
            ExpressSyncEngine.syncAll(getApplicationContext(), summary,
                    getInputData().getBoolean(ExpressScheduler.USER_PULL, false),
                    getInputData().getString(ExpressScheduler.TRIGGER));
            // 用户定 2026-09-24：后台只有京东订单投影能开京粉页（离屏），且只在这一轮提交成功之后跑。
            ExpressBackgroundOrderProjection.afterCommittedRound(
                    getApplicationContext(), startedAtNanos, this::isStopped);
            committed = true;
            return Result.success();
        } catch (Throwable failure) {
            if (summary[0] == 0) summary[0] = 1;
            retrying = getRunAttemptCount() < 3;
            return retrying ? Result.retry() : Result.failure();
        } finally {
            Context context = getApplicationContext();
            try {
                if (repository == null || repository.invalidationVersion() == invalidationBeforeSync) {
                    try {
                        ExpressWidgetProvider.refreshAll(context);
                    } catch (RuntimeException failure) {
                        Log.w("ExpressSyncWorker", "Widget reconciliation failed", failure);
                    }
                }
                context.sendBroadcast(new Intent(
                        ExpressRepository.ACTION_SYNC_FINISHED)
                        .setPackage(context.getPackageName())
                        .putExtra(ExpressRepository.EXTRA_SYNC_WORK_ID, getId().toString())
                        .putExtra(ExpressRepository.EXTRA_SYNC_RETRYING, retrying)
                        .putExtra(ExpressRepository.EXTRA_SYNC_ATTEMPTED, summary[0])
                        .putExtra(ExpressRepository.EXTRA_SYNC_SUCCEEDED, summary[1])
                        .putExtra(ExpressRepository.EXTRA_SYNC_ACCOUNT_LIST_UPDATED, summary[2] == 1)
                        .putExtra(ExpressRepository.EXTRA_SYNC_FAILED,
                                Math.max(0, summary[0] - summary[1])));
                // 用户 2026-10-02「加一个限制 头条跟状态有一个更新时 另外（包含本地详情页）就要强制刷新跟上」：once
                // this round's list data has settled and its outcome is announced (a pull's toast does not wait for
                // it), each newly out-of-step row is refreshed once.
                if (committed) ExpressStatusAlignment.afterRound(context, this::isStopped);
            } finally {
                ExpressStatusAlignment.roundFinished();
            }
        }
    }
}
