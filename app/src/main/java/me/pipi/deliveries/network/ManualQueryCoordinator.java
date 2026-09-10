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
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.function.Consumer;
import java.util.function.Function;
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
            freeSources.add(new ActivatedSource("local", local));
        }
        if (includeRoute) {
            freeSources.add(new ActivatedSource("route", route));
        }
        return queryActivatedSources(freeSources, clock);
    }

    private static Batch queryActivatedSources(
            List<ActivatedSource> freeSources, LongSupplier clock) throws Exception {
        return queryActivatedSources(freeSources, clock, null, false);
    }

    private static Batch queryActivatedSources(
            List<ActivatedSource> freeSources, LongSupplier clock,
            Consumer<Success> progress, boolean requireStructuredStatus) throws Exception {
        ExecutorService executor = freeSources.isEmpty() ? null
                : Executors.newFixedThreadPool(freeSources.size(), runnable -> {
                    Thread thread = new Thread(runnable, "express-manual-adapter");
                    thread.setDaemon(true);
                    return thread;
                });
        ArrayList<Future<QueryOutcome>> futures = new ArrayList<>();
        Map<Future<QueryOutcome>, Integer> sourceOrder = new HashMap<>();
        ArrayList<QueryOutcome> outcomes = new ArrayList<>(
                Collections.nCopies(freeSources.size(), null));
        ExecutorCompletionService<QueryOutcome> completed = executor == null ? null
                : new ExecutorCompletionService<>(executor);
        ArrayList<Success> successes = new ArrayList<>();
        ExpressQueryResult bestEffort = null;
        Exception lastFailure = null;
        try {
            for (ActivatedSource source : freeSources) {
                Future<QueryOutcome> future = completed.submit(
                        () -> queryActivatedSource(source, clock, requireStructuredStatus));
                sourceOrder.put(future, futures.size());
                futures.add(future);
            }
            for (int count = 0; count < futures.size(); count++) {
                QueryOutcome outcome;
                try {
                    Future<QueryOutcome> future = completed.take();
                    outcome = future.get();
                    outcomes.set(sourceOrder.get(future), outcome);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw interrupted;
                } catch (ExecutionException failed) {
                    Throwable cause = failed.getCause();
                    if (cause instanceof Error) throw (Error) cause;
                    if (cause instanceof Exception) throw (Exception) cause;
                    throw new IllegalStateException("manual adapter failed", cause);
                }
                if (progress != null && outcome.success != null
                        && Kuaidi100TimelinePolicy.hasTimedTracking(outcome.success.result)) {
                    progress.accept(outcome.success);
                }
            }
            // Completion order drives the preview; final arbitration retains query order.
            for (QueryOutcome outcome : outcomes) {
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

    public static Batch queryPickerFirst(
            Source picker,
            ManualTimelineAuthorityPolicy.Candidate cachedPicker,
            Source local,
            boolean includeLocal,
            Function<ExpressQueryResult, Source> primaryKuaidi100,
            Consumer<ExpressQueryResult> pickerPreview) throws Exception {
        return queryPickerFirst(picker, cachedPicker, local, includeLocal,
                primaryKuaidi100, pickerPreview, System::currentTimeMillis);
    }

    public static Batch queryPickerFirst(
            Source picker, ManualTimelineAuthorityPolicy.Candidate cachedPicker,
            Source local, boolean includeLocal,
            Function<ExpressQueryResult, Source> primaryKuaidi100,
            Consumer<ExpressQueryResult> preview, boolean requireStructuredStatus) throws Exception {
        return queryPickerFirst(picker, cachedPicker, local, includeLocal,
                primaryKuaidi100, preview, requireStructuredStatus, false, System::currentTimeMillis);
    }

    public static Batch queryPickerFirst(
            Source picker, ManualTimelineAuthorityPolicy.Candidate cachedPicker,
            Source local, boolean includeLocal,
            Function<ExpressQueryResult, Source> primaryKuaidi100,
            Consumer<ExpressQueryResult> preview, boolean requireStructuredStatus,
            boolean statusOnly) throws Exception {
        return queryPickerFirst(picker, cachedPicker, local, includeLocal,
                primaryKuaidi100, preview, requireStructuredStatus, statusOnly, System::currentTimeMillis);
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
        return queryPickerFirst(picker, cachedPicker, local, includeLocal,
                null, pickerPreview, clock);
    }

    static Batch queryPickerFirst(
            Source picker,
            ManualTimelineAuthorityPolicy.Candidate cachedPicker,
            Source local,
            boolean includeLocal,
            Function<ExpressQueryResult, Source> primaryKuaidi100,
            Consumer<ExpressQueryResult> pickerPreview,
            LongSupplier clock) throws Exception {
        return queryPickerFirst(picker, cachedPicker, local, includeLocal,
                primaryKuaidi100, pickerPreview, false, false, clock);
    }

    private static Batch queryPickerFirst(
            Source picker, ManualTimelineAuthorityPolicy.Candidate cachedPicker,
            Source local, boolean includeLocal,
            Function<ExpressQueryResult, Source> primaryKuaidi100,
            Consumer<ExpressQueryResult> pickerPreview, boolean requireStructuredStatus,
            boolean statusOnly, LongSupplier clock) throws Exception {
        ArrayList<Success> newSuccesses = new ArrayList<>();
        ArrayList<Success> selectionSuccesses = new ArrayList<>();
        ExpressQueryResult bestEffort = null;
        Exception lastFailure = null;

        QueryOutcome pickerOutcome = queryActivatedSource(
                new ActivatedSource(TimelineSlot.V6_QUERY, picker), clock, requireStructuredStatus);
        if (pickerOutcome.result != null) bestEffort = pickerOutcome.result;
        if (pickerOutcome.success != null) {
            newSuccesses.add(pickerOutcome.success);
        }
        ManualTimelineAuthorityPolicy.Candidate effectivePicker = cachedPicker;
        if (pickerOutcome.success != null
                && (Kuaidi100TimelinePolicy.hasTimedTracking(pickerOutcome.success.result)
                || requireStructuredStatus
                && ManualTimelineAuthorityPolicy.hasStructuredStatus(pickerOutcome.success.result))) {
            ManualTimelineAuthorityPolicy.Candidate refreshed =
                    new ManualTimelineAuthorityPolicy.Candidate(
                            pickerOutcome.success.provider,
                            pickerOutcome.success.result,
                            pickerOutcome.success.successAt,
                            pickerOutcome.success.complete);
            effectivePicker = ManualTimelineAuthorityPolicy.mergeSameProvider(
                    cachedPicker, refreshed);
            if (pickerPreview != null && effectivePicker != null
                    && Kuaidi100TimelinePolicy.hasTimedTracking(effectivePicker.result)) {
                pickerPreview.accept(effectivePicker.result);
            }
        }
        if (effectivePicker != null
                && (ManualTimelineAuthorityPolicy.isAuthoritative(effectivePicker)
                || requireStructuredStatus
                && ManualTimelineAuthorityPolicy.hasStructuredStatus(effectivePicker.result))) {
            selectionSuccesses.add(success(effectivePicker));
        }
        if (pickerOutcome.failure != null) lastFailure = pickerOutcome.failure;

        // Only the refreshed same-provider Picker history can close its stage before primary
        // providers start. An existing cache never skips the Picker refresh itself.
        if (effectivePicker != null && (statusOnly
                ? ManualTimelineAuthorityPolicy.hasStructuredStatus(effectivePicker.result)
                : Kuaidi100TimelinePolicy.hasTimelineStart(effectivePicker.result)
                && (!requireStructuredStatus
                || ManualTimelineAuthorityPolicy.hasStructuredStatus(effectivePicker.result)))) {
            return new Batch(newSuccesses, selectionSuccesses, bestEffort);
        }
        ArrayList<ActivatedSource> primarySources = new ArrayList<>();
        if (includeLocal && local != null) {
            primarySources.add(new ActivatedSource(TimelineSlot.V4_QUERY, local));
        }
        if (primaryKuaidi100 != null) {
            Source kuaidi100 = primaryKuaidi100.apply(pickerOutcome.result);
            if (kuaidi100 != null) {
                primarySources.add(new ActivatedSource(TimelineSlot.K100_H5, kuaidi100));
            }
        }
        if (!primarySources.isEmpty()) {
            try {
                ArrayList<Success> available = new ArrayList<>(selectionSuccesses);
                ExpressQueryResult[] displayed = {effectivePicker == null ? null : effectivePicker.result};
                Batch primary = queryActivatedSources(primarySources, clock, success -> {
                    available.add(success);
                    ExpressQueryResult selected = new Batch(available, available, null).selected(true, true);
                    if (pickerPreview != null && selected != null && selected != displayed[0]) {
                        displayed[0] = selected;
                        pickerPreview.accept(selected);
                    }
                }, requireStructuredStatus);
                if (bestEffort == null) bestEffort = primary.bestEffort;
                newSuccesses.addAll(primary.successes);
                selectionSuccesses.addAll(primary.selectionSuccesses);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw interrupted;
            } catch (Exception failure) {
                lastFailure = failure;
            }
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
            ActivatedSource source, LongSupplier clock, boolean requireStructuredStatus) throws Exception {
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
                    || requireStructuredStatus && ManualTimelineAuthorityPolicy.hasStructuredStatus(result)
                    || !ManualRoutePolicy.meizuKuaidi100Url(provider, result).isEmpty()) {
                success = new Success(
                        provider, result, Math.max(1L, clock.getAsLong()), false);
            }
            return new QueryOutcome(result, success, null);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw interrupted;
        } catch (Exception failure) {
            ExpressLog.line("", source.provider, "manual", "failed",
                    "reason", failure.getClass().getSimpleName(),
                    "elapsedMs", System.currentTimeMillis() - startedAt);
            return new QueryOutcome(null, null, failure);
        }
    }

    private static final class QueryOutcome {
        final ExpressQueryResult result;
        final Success success;
        final Exception failure;

        QueryOutcome(
                ExpressQueryResult result,
                Success success, Exception failure) {
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
            return selected(detail, false);
        }

        private ExpressQueryResult selected(boolean detail, boolean preview) {
            ArrayList<ManualTimelineAuthorityPolicy.Candidate> candidates = new ArrayList<>();
            for (Success success : selectionSuccesses) {
                candidates.add(new ManualTimelineAuthorityPolicy.Candidate(
                        success.provider, success.result, success.successAt, success.complete));
            }
            ManualTimelineAuthorityPolicy.Candidate selected =
                    detail ? ManualTimelineAuthorityPolicy.selectDetail(candidates)
                            : ManualTimelineAuthorityPolicy.select(candidates);
            ExpressQueryResult result = selected == null ? bestEffort : selected.result;
            return preview ? ManualTimelineAuthorityPolicy.presentationResult(result, candidates) : result;
        }
    }

    private static final class ActivatedSource {
        final String provider;
        final Source query;

        ActivatedSource(String provider, Source query) {
            this.provider = provider;
            this.query = query;
        }
    }

    @FunctionalInterface
    public interface Source {
        ExpressQueryResult query() throws Exception;
    }
}
