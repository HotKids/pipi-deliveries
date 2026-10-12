package me.pipi.deliveries.feature.express;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressLog;

/**
 * 后台同步轮次提交成功后，把接口 5 京东订单行投影成真实运单号（用户定 2026-09-24：Lite 只为这一条放开
 * 「后台不开页」）。每一单走的就是首页那一个 {@link ExpressHomeOrderProjectionCapture}：同一道
 * needsProjection 门、同一个京粉页冷却与租约、同一次强制 v5_query 找回路由、同一条提交与通知暂存，只是
 * 没有 Activity，页面在离屏里排版。京东历史、菜鸟 H5、快递100 页、手动链照旧只在前台。
 *
 * <p>下面这些边界是实现时自选的，不是用户定的：每轮最多开 {@link #MAX_CAPTURES_PER_ROUND} 次京粉页、逐单
 * 进行；最久没开过的单先开；一次风控回应就结束这一轮；首页可见时整轮留给首页；同一进程同时只跑一轮。</p>
 */
public final class ExpressBackgroundOrderProjection {
    static final int MAX_CAPTURES_PER_ROUND = 2;
    /** Home's attempt lives 30 s (10 s forced v5_query, then the page); its commit gets 10 s more. */
    static final long CAPTURE_WAIT_MS = ExpressHomeOrderProjectionCapture.CAPTURE_TIMEOUT_MS + 20_000L;
    /** WorkManager stops a worker at ten minutes; the last minute stays for widgets and the broadcast. */
    static final long WORK_BUDGET_MS = 9L * 60_000L;
    private static final long WAIT_SLICE_MS = 250L;
    private static final AtomicBoolean ROUND_ACTIVE = new AtomicBoolean();

    private ExpressBackgroundOrderProjection() {}

    /**
     * Runs at the end of a background sync round that committed. Never throws: the round's own
     * result stands whatever happens here.
     *
     * @param workStartedAtNanos {@link System#nanoTime()} when the worker started
     * @param stopped the worker's stop signal
     */
    public static void afterCommittedRound(
            Context context, long workStartedAtNanos, BooleanSupplier stopped) {
        try {
            run(context, MAX_CAPTURES_PER_ROUND, CAPTURE_WAIT_MS,
                    workStartedAtNanos + TimeUnit.MILLISECONDS.toNanos(WORK_BUDGET_MS), stopped);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException failure) {
            Log.w("ExpressOrderProjection", "Background projection failed: "
                    + failure.getClass().getSimpleName());
        }
    }

    /** Projects due orders one at a time off the main thread; returns how many were committed. */
    static int run(Context context, int cap, long captureWaitMs, long deadlineNanos,
            BooleanSupplier stopped) throws InterruptedException {
        Context application = context.getApplicationContext();
        String bindingSource = ExpressAccountSource.bindingSource(application);
        if (!"interface5".equals(bindingSource)) return 0;
        ExpressRepository repository = ExpressRepository.get(application);
        List<ExpressItem> due = dueCandidates(
                repository.listVisibleAsStored(bindingSource),
                new ExpressOrderProjectionRetryStore(application), System.currentTimeMillis());
        // T23（用户 2026-09-26）：已经知道运单号、只差承运商的订单不开页；这一轮的同步已经给它补过识别。
        due.removeIf(row -> repository.pendingProjection(row) != null);
        if (due.isEmpty()) return 0;
        if (ExpressListActivity.homeVisible()) {
            skipped("home_visible", null);
            return 0;
        }
        if (!ROUND_ACTIVE.compareAndSet(false, true)) return 0;
        try {
            int started = 0;
            int saved = 0;
            boolean riskControl = false;
            for (ExpressItem candidate : due) {
                String stop = stopReason(riskControl, started, cap, stopped,
                        captureWaitMs, deadlineNanos);
                if (stop != null) {
                    skipped(stop, null);
                    break;
                }
                Attempt attempt = capture(application, candidate, captureWaitMs, stopped);
                if (attempt.started) started++;
                if (attempt.saved) saved++;
                if (attempt.cut) {
                    skipped("deadline_exhausted", candidate);
                    break;
                }
                riskControl = attempt.throttled;
            }
            return saved;
        } finally {
            ROUND_ACTIVE.set(false);
        }
    }

    /** Why the next due order waits for a later round, or null when it may start now. */
    private static String stopReason(boolean riskControl, int started, int cap,
            BooleanSupplier stopped, long captureWaitMs, long deadlineNanos) {
        if (riskControl) return "risk_control";
        if (started >= cap) return "round_cap";
        // Start only what can finish before the worker's own limit.
        if (stopped.getAsBoolean() || System.nanoTime()
                + TimeUnit.MILLISECONDS.toNanos(captureWaitMs) - deadlineNanos > 0L) {
            return "deadline_exhausted";
        }
        return ExpressListActivity.homeVisible() ? "home_visible" : null;
    }

    /**
     * Home's gate, without rows whose feed text already names the waybill (the round applies those
     * itself, never through the page), without cooling orders and without completed orders whose
     * union page is confirmed empty (user decision 2026-09-25); the order opened longest ago first.
     */
    static List<ExpressItem> dueCandidates(List<ExpressItem> rows,
            ExpressOrderProjectionRetryStore retries, long now) {
        ArrayList<ExpressItem> due = new ArrayList<>();
        Map<ExpressItem, Long> cooldownUntil = new IdentityHashMap<>();
        for (ExpressItem row : rows) {
            if (!ExpressHomeOrderProjectionCapture.needsProjection(row)
                    || ExpressOrderTextIdentity.fromTracksJson(row.tracksJson, row.waybill) != null
                    || !retries.timelineAttemptDue(row, now)
                    || retries.pageConfirmedEmpty(row)) continue;
            due.add(row);
            cooldownUntil.put(row, retries.timelineCooldownUntil(row));
        }
        due.sort(Comparator.comparingLong(cooldownUntil::get));
        return due;
    }

    /** One Home capture without a host: started and called back on the main thread like Home's. */
    private static Attempt capture(Context context, ExpressItem candidate, long waitMs,
            BooleanSupplier stopped) throws InterruptedException {
        Handler main = new Handler(Looper.getMainLooper());
        CountDownLatch finished = new CountDownLatch(1);
        AtomicBoolean started = new AtomicBoolean();
        AtomicBoolean saved = new AtomicBoolean();
        AtomicReference<ExpressHomeOrderProjectionCapture> running = new AtomicReference<>();
        if (!main.post(() -> {
            ExpressHomeOrderProjectionCapture capture = ExpressHomeOrderProjectionCapture.offWindow(
                    context, candidate, (done, committed) -> {
                        saved.set(committed);
                        finished.countDown();
                    });
            running.set(capture);
            if (capture.start()) started.set(true);
            else finished.countDown();
        })) return new Attempt(false, false, false, false);
        long until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMs);
        try {
            while (!finished.await(WAIT_SLICE_MS, TimeUnit.MILLISECONDS)) {
                if (stopped.getAsBoolean() || System.nanoTime() - until >= 0L) {
                    cancel(main, running);
                    return new Attempt(started.get(), false, false, true);
                }
            }
        } catch (InterruptedException interrupted) {
            cancel(main, running);
            throw interrupted;
        }
        ExpressHomeOrderProjectionCapture capture = running.get();
        return new Attempt(started.get(), saved.get(),
                capture != null && capture.throttled(), false);
    }

    /** Home's own cancel: tears the page down on the main thread and releases the order lease. */
    private static void cancel(Handler main,
            AtomicReference<ExpressHomeOrderProjectionCapture> running) {
        main.post(() -> {
            ExpressHomeOrderProjectionCapture capture = running.get();
            if (capture != null) capture.cancel();
        });
    }

    private static void skipped(String reason, ExpressItem candidate) {
        ExpressLog.line("v5", "jd_h5", "jingdong", "skipped",
                "tail", candidate == null ? null : ExpressLog.tail(candidate.waybill),
                "reason", reason, "trigger", "background");
    }

    private static final class Attempt {
        final boolean started;
        final boolean saved;
        final boolean throttled;
        final boolean cut;

        Attempt(boolean started, boolean saved, boolean throttled, boolean cut) {
            this.started = started;
            this.saved = saved;
            this.throttled = throttled;
            this.cut = cut;
        }
    }
}
