package me.pipi.deliveries.network;

import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.data.ManualRoutePolicy;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ManualQuerySuccess;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/** Runs the enabled Android manual-query stages and selects their best result. */
public final class ManualQueryCoordinator {
    private ManualQueryCoordinator() {}

    /** Queries only the enabled local capabilities; there is no credentialed fallback. */
    public static Batch queryActivatedAndroid(
            Source local, boolean includeLocal,
            Source route, boolean includeRoute) throws Exception {
        return queryActivatedAndroid(
                local, includeLocal, route, includeRoute, System::currentTimeMillis);
    }

    static Batch queryActivatedAndroid(
            Source local, boolean includeLocal,
            Source route, boolean includeRoute, LongSupplier clock) throws Exception {
        ArrayList<ActivatedSource> freeSources = new ArrayList<>();
        if (includeLocal) {
            freeSources.add(new ActivatedSource("local", local, false));
        }
        if (includeRoute) {
            freeSources.add(new ActivatedSource("route", route, false));
        }
        ExecutorService executor = freeSources.isEmpty() ? null
                : Executors.newFixedThreadPool(freeSources.size(), runnable -> {
                    Thread thread = new Thread(runnable, "express-manual-adapter");
                    thread.setDaemon(true);
                    return thread;
                });
        ArrayList<Future<QueryOutcome>> futures = new ArrayList<>();
        for (ActivatedSource source : freeSources) {
            futures.add(executor.submit(() -> queryActivatedSource(source, clock)));
        }
        ArrayList<Success> successes = new ArrayList<>();
        ExpressQueryResult bestEffort = null;
        Exception lastFailure = null;
        try {
            for (Future<QueryOutcome> future : futures) {
                QueryOutcome outcome;
                try {
                    outcome = future.get();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw interrupted;
                } catch (ExecutionException failed) {
                    Throwable cause = failed.getCause();
                    if (cause instanceof Error) throw (Error) cause;
                    if (cause instanceof Exception) throw (Exception) cause;
                    throw new IllegalStateException("manual adapter failed", cause);
                }
                if (outcome.result != null && bestEffort == null) {
                    bestEffort = outcome.result;
                }
                if (outcome.success != null) successes.add(outcome.success);
                if (outcome.failure != null) {
                    lastFailure = outcome.failure;
                }
            }
        } finally {
            for (Future<QueryOutcome> future : futures) future.cancel(true);
            if (executor != null) executor.shutdownNow();
        }

        if (!successes.isEmpty()) return new Batch(successes, successes, bestEffort);
        if (bestEffort != null) return new Batch(successes, successes, bestEffort);
        if (lastFailure != null) throw lastFailure;
        return new Batch(successes, successes, null);
    }

    /**
     * Queries Picker first and stops the current chain when its incremental cache already contains
     * the order/pickup boundary. The optional local adapter is used only when that boundary is
     * still absent; source-owned SF/JD callers disable it.
     */
    public static Batch queryPickerFirst(
            Source picker,
            ManualTimelineAuthorityPolicy.Candidate cachedPicker,
            Source local,
            boolean includeLocal) throws Exception {
        return queryPickerFirst(
                picker, cachedPicker, local, includeLocal, null, System::currentTimeMillis);
    }

    public static Batch queryPickerFirst(
            Source picker,
            ManualTimelineAuthorityPolicy.Candidate cachedPicker,
            Source local,
            boolean includeLocal,
            Consumer<ExpressQueryResult> pickerPreview) throws Exception {
        return queryPickerFirst(
                picker, cachedPicker, local, includeLocal,
                pickerPreview, System::currentTimeMillis);
    }

    static Batch queryPickerFirst(
            Source picker,
            ManualTimelineAuthorityPolicy.Candidate cachedPicker,
            Source local,
            boolean includeLocal,
            LongSupplier clock) throws Exception {
        return queryPickerFirst(
                picker, cachedPicker, local, includeLocal, null, clock);
    }

    static Batch queryPickerFirst(
            Source picker,
            ManualTimelineAuthorityPolicy.Candidate cachedPicker,
            Source local,
            boolean includeLocal,
            Consumer<ExpressQueryResult> pickerPreview,
            LongSupplier clock) throws Exception {
        ArrayList<Success> newSuccesses = new ArrayList<>();
        ArrayList<Success> selectionSuccesses = new ArrayList<>();
        ExpressQueryResult bestEffort = null;
        Exception lastFailure = null;

        // 用户定 2026-09-05：picker 与本地那一级并行（iOS 本来就是 Promise.all，Pipi 同步改）；
        // picker 只决定 K100 那一页。之前串行，picker 一超时整条链白等。
        ExecutorService localExecutor = null;
        java.util.concurrent.Future<QueryOutcome> localTask = null;
        if (includeLocal && local != null) {
            localExecutor = Executors.newSingleThreadExecutor(runnable -> {
                Thread thread = new Thread(runnable, "pipi-manual-local");
                thread.setDaemon(true);
                return thread;
            });
            localTask = localExecutor.submit(() -> queryActivatedSource(
                    new ActivatedSource(TimelineSlot.V4_QUERY, local, false), clock));
        }
        QueryOutcome pickerOutcome;
        try {
            pickerOutcome = queryActivatedSource(
                    new ActivatedSource(TimelineSlot.V6_PICKER, picker, false), clock);
        } catch (Exception failure) {
            if (localTask != null) localTask.cancel(true);
            if (localExecutor != null) localExecutor.shutdownNow();
            throw failure;
        }
        if (pickerOutcome.result != null) bestEffort = pickerOutcome.result;
        if (pickerOutcome.success != null) {
            newSuccesses.add(pickerOutcome.success);
        }
        ManualTimelineAuthorityPolicy.Candidate effectivePicker = cachedPicker;
        if (pickerOutcome.success != null
                && Kuaidi100TimelinePolicy.hasTimedTracking(
                pickerOutcome.success.result)) {
            ManualTimelineAuthorityPolicy.Candidate refreshed =
                    new ManualTimelineAuthorityPolicy.Candidate(
                            pickerOutcome.success.provider,
                            pickerOutcome.success.result,
                            pickerOutcome.success.successAt,
                            pickerOutcome.success.complete);
            effectivePicker = ManualTimelineAuthorityPolicy.mergeSameProvider(
                    cachedPicker, refreshed);
            if (pickerPreview != null && effectivePicker != null) {
                pickerPreview.accept(effectivePicker.result);
            }
        }
        if (effectivePicker != null
                && ManualTimelineAuthorityPolicy.isAuthoritative(effectivePicker)) {
            selectionSuccesses.add(success(effectivePicker));
        }
        if (pickerOutcome.failure != null) lastFailure = pickerOutcome.failure;

        if (localTask != null) {
            QueryOutcome localOutcome;
            try {
                localOutcome = localTask.get();
            } catch (InterruptedException interrupted) {
                localTask.cancel(true);
                localExecutor.shutdownNow();
                Thread.currentThread().interrupt();
                throw interrupted;
            } catch (ExecutionException failure) {
                localExecutor.shutdownNow();
                Throwable cause = failure.getCause();
                if (cause instanceof Exception) throw (Exception) cause;
                throw new IllegalStateException("local stage failed", cause);
            }
            localExecutor.shutdown();
            if (bestEffort == null && localOutcome.result != null) {
                bestEffort = localOutcome.result;
            }
            if (localOutcome.success != null) {
                newSuccesses.add(localOutcome.success);
                selectionSuccesses.add(localOutcome.success);
            }
            if (localOutcome.failure != null) lastFailure = localOutcome.failure;
        }

        if (!selectionSuccesses.isEmpty() || bestEffort != null) {
            return new Batch(newSuccesses, selectionSuccesses, bestEffort);
        }
        if (lastFailure != null) throw lastFailure;
        return new Batch(newSuccesses, selectionSuccesses, null);
    }

    private static Success success(ManualTimelineAuthorityPolicy.Candidate candidate) {
        return new Success(
                candidate.provider, candidate.result,
                candidate.successAt, candidate.complete);
    }

    private static QueryOutcome queryActivatedSource(
            ActivatedSource source, LongSupplier clock) throws Exception {
        // 与 Pipi 的 `manual level=… event=…` 同一套：每一级何时开始、几秒、几条节点，看 logcat 就够。
        long startedAt = System.currentTimeMillis();
        ExpressLog.line("", source.provider, "manual", "started");
        try {
            ExpressQueryResult result = source.query.query();
            ExpressLog.line("", source.provider, "manual",
                    result == null ? "failed" : "succeeded",
                    "tail", ExpressLog.tail(result == null ? "" : result.waybill),
                    "nodes", Kuaidi100TimelinePolicy.timedTrackCount(result),
                    "elapsedMs", System.currentTimeMillis() - startedAt);
            Success success = null;
            String provider = result == null || result.timelineProvider.isEmpty()
                    ? source.provider : result.timelineProvider;
            if (Kuaidi100TimelinePolicy.hasTimedTracking(result)
                    || !ManualRoutePolicy.meizuKuaidi100Url(provider, result).isEmpty()) {
                success = new Success(
                        provider, result, Math.max(1L, clock.getAsLong()), source.complete);
            }
            return new QueryOutcome(source.provider, result, success, null);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw interrupted;
        } catch (Exception failure) {
            ExpressLog.line("", source.provider, "manual", "failed",
                    "reason", failure.getClass().getSimpleName(),
                    "elapsedMs", System.currentTimeMillis() - startedAt);
            return new QueryOutcome(source.provider, null, null, failure);
        }
    }

    private static final class QueryOutcome {
        final String provider;
        final ExpressQueryResult result;
        final Success success;
        final Exception failure;

        QueryOutcome(
                String provider, ExpressQueryResult result,
                Success success, Exception failure) {
            this.provider = provider;
            this.result = result;
            this.success = success;
            this.failure = failure;
        }
    }

    public static final class Success extends ManualQuerySuccess {
        Success(
                String provider, ExpressQueryResult result, long successAt, boolean complete) {
            super(provider, result, successAt, complete);
        }
    }

    public static final class Batch {
        public final List<Success> successes;
        private final List<Success> selectionSuccesses;
        private final ExpressQueryResult bestEffort;

        Batch(
                List<Success> successes, List<Success> selectionSuccesses,
                ExpressQueryResult bestEffort) {
            this.successes = Collections.unmodifiableList(new ArrayList<>(successes));
            this.selectionSuccesses = Collections.unmodifiableList(
                    new ArrayList<>(selectionSuccesses));
            this.bestEffort = bestEffort;
        }

        public ExpressQueryResult selected() {
            return selected(false);
        }

        public ExpressQueryResult detailSelected() {
            return selected(true);
        }

        List<Success> selectionSuccessesForTesting() {
            return selectionSuccesses;
        }

        private ExpressQueryResult selected(boolean detail) {
            ArrayList<ManualTimelineAuthorityPolicy.Candidate> candidates = new ArrayList<>();
            for (Success success : selectionSuccesses) {
                candidates.add(new ManualTimelineAuthorityPolicy.Candidate(
                        success.provider, success.result, success.successAt, success.complete));
            }
            ManualTimelineAuthorityPolicy.Candidate selected =
                    detail ? ManualTimelineAuthorityPolicy.selectDetail(candidates)
                            : ManualTimelineAuthorityPolicy.select(candidates);
            return selected == null ? bestEffort : selected.result;
        }
    }

    private static final class ActivatedSource {
        final String provider;
        final Source query;
        final boolean complete;

        ActivatedSource(String provider, Source query, boolean complete) {
            this.provider = provider;
            this.query = query;
            this.complete = complete;
        }
    }

    @FunctionalInterface
    public interface Source {
        ExpressQueryResult query() throws Exception;
    }
}
