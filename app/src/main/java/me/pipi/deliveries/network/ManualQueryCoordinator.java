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
     * Queries Online first and stops only when its incremental history contains a start aligned
     * with the latest evidence. Source-owned SF/JD callers disable the optional local adapter.
     */
    public static Batch queryOnlineFirst(
            Source online,
            ManualTimelineAuthorityPolicy.Candidate cachedOnline,
            Source local,
            boolean includeLocal) throws Exception {
        return queryOnlineFirst(
                online, cachedOnline, local, includeLocal, null, System::currentTimeMillis);
    }

    public static Batch queryOnlineFirst(
            Source online,
            ManualTimelineAuthorityPolicy.Candidate cachedOnline,
            Source local,
            boolean includeLocal,
            Consumer<ExpressQueryResult> onlinePreview) throws Exception {
        return queryOnlineFirst(
                online, cachedOnline, local, includeLocal,
                onlinePreview, System::currentTimeMillis);
    }

    public static Batch queryOnlineFirst(
            Source online,
            ManualTimelineAuthorityPolicy.Candidate cachedOnline,
            Source local,
            boolean includeLocal,
            Function<ExpressQueryResult, Source> primaryKuaidi100,
            Consumer<ExpressQueryResult> onlinePreview) throws Exception {
        return queryOnlineFirst(online, cachedOnline, local, includeLocal,
                primaryKuaidi100, onlinePreview, System::currentTimeMillis);
    }

    public static Batch queryOnlineFirst(
            Source online, ManualTimelineAuthorityPolicy.Candidate cachedOnline,
            Source local, boolean includeLocal,
            Function<ExpressQueryResult, Source> primaryKuaidi100,
            Consumer<ExpressQueryResult> preview, boolean requireStructuredStatus) throws Exception {
        return queryOnlineFirst(online, cachedOnline, local, includeLocal,
                primaryKuaidi100, preview, requireStructuredStatus, false, System::currentTimeMillis);
    }

    public static Batch queryOnlineFirst(
            Source online, ManualTimelineAuthorityPolicy.Candidate cachedOnline,
            Source local, boolean includeLocal,
            Function<ExpressQueryResult, Source> primaryKuaidi100,
            Consumer<ExpressQueryResult> preview, boolean requireStructuredStatus,
            boolean statusOnly) throws Exception {
        return queryOnlineFirst(online, cachedOnline, local, includeLocal,
                primaryKuaidi100, preview, requireStructuredStatus, statusOnly, System::currentTimeMillis);
    }

    static Batch queryOnlineFirst(
            Source online,
            ManualTimelineAuthorityPolicy.Candidate cachedOnline,
            Source local,
            boolean includeLocal,
            LongSupplier clock) throws Exception {
        return queryOnlineFirst(
                online, cachedOnline, local, includeLocal, null, clock);
    }

    static Batch queryOnlineFirst(
            Source online,
            ManualTimelineAuthorityPolicy.Candidate cachedOnline,
            Source local,
            boolean includeLocal,
            Consumer<ExpressQueryResult> onlinePreview,
            LongSupplier clock) throws Exception {
        return queryOnlineFirst(online, cachedOnline, local, includeLocal,
                null, onlinePreview, clock);
    }

    static Batch queryOnlineFirst(
            Source online,
            ManualTimelineAuthorityPolicy.Candidate cachedOnline,
            Source local,
            boolean includeLocal,
            Function<ExpressQueryResult, Source> primaryKuaidi100,
            Consumer<ExpressQueryResult> onlinePreview,
            LongSupplier clock) throws Exception {
        return queryOnlineFirst(online, cachedOnline, local, includeLocal,
                primaryKuaidi100, onlinePreview, false, false, clock);
    }

    private static Batch queryOnlineFirst(
            Source online, ManualTimelineAuthorityPolicy.Candidate cachedOnline,
            Source local, boolean includeLocal,
            Function<ExpressQueryResult, Source> primaryKuaidi100,
            Consumer<ExpressQueryResult> onlinePreview, boolean requireStructuredStatus,
            boolean statusOnly, LongSupplier clock) throws Exception {
        ArrayList<Success> newSuccesses = new ArrayList<>();
        ArrayList<Success> selectionSuccesses = new ArrayList<>();
        ExpressQueryResult bestEffort = null;
        Exception lastFailure = null;

        QueryOutcome onlineOutcome = online == null ? new QueryOutcome(null, null, null)
                : queryActivatedSource(new ActivatedSource(TimelineSlot.V6_QUERY, online),
                        clock, requireStructuredStatus);
        if (onlineOutcome.result != null) bestEffort = onlineOutcome.result;
        if (onlineOutcome.success != null) {
            newSuccesses.add(onlineOutcome.success);
        }
        ManualTimelineAuthorityPolicy.Candidate effectiveOnline = cachedOnline;
        if (onlineOutcome.success != null
                && (Kuaidi100TimelinePolicy.hasTimedTracking(onlineOutcome.success.result)
                || requireStructuredStatus
                && ManualTimelineAuthorityPolicy.hasStructuredStatus(onlineOutcome.success.result))) {
            ManualTimelineAuthorityPolicy.Candidate refreshed =
                    new ManualTimelineAuthorityPolicy.Candidate(
                            onlineOutcome.success.provider,
                            onlineOutcome.success.result,
                            onlineOutcome.success.successAt,
                            onlineOutcome.success.complete);
            effectiveOnline = ManualTimelineAuthorityPolicy.mergeSameProvider(
                    cachedOnline, refreshed);
            if (onlinePreview != null && effectiveOnline != null
                    && Kuaidi100TimelinePolicy.hasTimedTracking(effectiveOnline.result)) {
                onlinePreview.accept(effectiveOnline.result);
            }
        }
        if (effectiveOnline != null
                && (ManualTimelineAuthorityPolicy.isAuthoritative(effectiveOnline)
                || requireStructuredStatus
                && ManualTimelineAuthorityPolicy.hasStructuredStatus(effectiveOnline.result))) {
            selectionSuccesses.add(success(effectiveOnline));
        }
        if (onlineOutcome.failure != null) lastFailure = onlineOutcome.failure;

        // Only the refreshed same-provider Online history can close its stage before primary
        // providers start. An existing cache never skips the Online refresh itself.
        if (online != null && effectiveOnline != null && (statusOnly
                ? ManualTimelineAuthorityPolicy.hasStructuredStatus(effectiveOnline.result)
                : ManualTimelineAuthorityPolicy.timelineStartAligned(effectiveOnline.result, 0L)
                && (!requireStructuredStatus
                || ManualTimelineAuthorityPolicy.hasStructuredStatus(effectiveOnline.result)))) {
            return new Batch(newSuccesses, selectionSuccesses, bestEffort);
        }
        ArrayList<ActivatedSource> primarySources = new ArrayList<>();
        if (includeLocal && local != null) {
            primarySources.add(new ActivatedSource(TimelineSlot.V4_QUERY, local));
        }
        if (primaryKuaidi100 != null) {
            Source kuaidi100 = primaryKuaidi100.apply(onlineOutcome.result != null
                    ? onlineOutcome.result : effectiveOnline == null ? null : effectiveOnline.result);
            if (kuaidi100 != null) {
                primarySources.add(new ActivatedSource(TimelineSlot.K100_H5, kuaidi100));
            }
        }
        if (!primarySources.isEmpty()) {
            try {
                ArrayList<Success> available = new ArrayList<>(selectionSuccesses);
                ExpressQueryResult[] displayed = {effectiveOnline == null ? null : effectiveOnline.result};
                Batch primary = queryActivatedSources(primarySources, clock, success -> {
                    available.add(success);
                    ExpressQueryResult selected = new Batch(available, available, null).selected(true, true);
                    if (onlinePreview != null && selected != null && selected != displayed[0]) {
                        displayed[0] = selected;
                        onlinePreview.accept(selected);
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
        long startedAt = System.currentTimeMillis();
        RowSource row = source.query instanceof RowSource ? (RowSource) source.query : null;
        if (row != null) return queryRowSource(source, row, clock, requireStructuredStatus);
        ExpressLog.line("", source.provider, "manual", "started");
        try {
            ExpressQueryResult result = source.query.query();
            ExpressLog.line("", source.provider, "manual",
                    result == null ? "failed" : "succeeded",
                    "tail", ExpressLog.tail(result == null ? "" : result.waybill),
                    "nodes", Kuaidi100TimelinePolicy.timedTrackCount(result),
                    "statusSemantic", result == null ? me.pipi.deliveries.model.StatusSemantic.UNKNOWN : result.semantic,
                    "statusEventAtMs", result == null ? 0L : result.statusEventTime,
                    "latestTrackAtMs", Kuaidi100TimelinePolicy.latestTimedEventMillis(result),
                    "latestEventAtMs", ManualTimelineAuthorityPolicy.latestEventTime(result),
                    "structuredStatus", result != null && result.structuredStatusEvidence,
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
            // 用户 2026-09-28：a query cut off mid-way still ends the stage it started.
            ExpressLog.line("", source.provider, "manual", "failed",
                    "elapsedMs", System.currentTimeMillis() - startedAt, "errorCategory", "cancelled");
            Thread.currentThread().interrupt();
            throw interrupted;
        } catch (Exception failure) {
            ExpressLog.line("", source.provider, "manual", "failed", ExpressLog.errorDetails(failure,
                    "elapsedMs", System.currentTimeMillis() - startedAt));
            return new QueryOutcome(null, null, failure);
        }
    }

    /**
     * A row's own query (用户 2026-09-28): its stage lines carry iOS's shipmentDiagnosticDetails for that
     * row and the slot it asks — the row's identity, how its detail is shown before the answer, and the
     * answer itself once there is one — and a query cut off mid-way still ends its stage as cancelled.
     */
    private static QueryOutcome queryRowSource(ActivatedSource source, RowSource row, LongSupplier clock,
            boolean requireStructuredStatus) throws Exception {
        long startedAt = System.currentTimeMillis();
        String level = row.requestProvider.isEmpty() ? source.provider : row.requestProvider;
        String skip = row.skipReason();
        if (!skip.isEmpty()) {
            // Not attempted: neither an answer nor an empty one (iOS refresh.stage.skipped cooldown).
            ExpressLog.line("", level, row.sourceProvider, "skipped",
                    append(row.fields(level, null), "reason", skip));
            return new QueryOutcome(null, null, null);
        }
        ExpressLog.line("", level, row.sourceProvider, "started", row.fields(level, null));
        try {
            ExpressQueryResult result = row.query();
            Object[] fields = row.fields(level, result);
            // The line's own result stays the stage outcome; the page exit is iOS's exitReason.
            ExpressLog.line("", level, row.sourceProvider, result == null ? "failed" : "succeeded",
                    append(fields, "durationMs", System.currentTimeMillis() - startedAt,
                            "exitReason", Kuaidi100TimelinePolicy.timedTrackCount(result) > 0
                                    ? "timed_tracks" : "no_timed_tracks"));
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
            ExpressLog.line("", level, row.sourceProvider, "failed", append(row.fields(level, null),
                    "durationMs", System.currentTimeMillis() - startedAt, "errorCategory", "cancelled"));
            Thread.currentThread().interrupt();
            throw interrupted;
        } catch (Exception failure) {
            ExpressLog.line("", level, row.sourceProvider, "failed", ExpressLog.errorDetails(failure,
                    append(row.fields(level, null), "durationMs", System.currentTimeMillis() - startedAt)));
            return new QueryOutcome(null, null, failure);
        }
    }

    private static Object[] append(Object[] fields, Object... more) {
        Object[] joined = java.util.Arrays.copyOf(fields, fields.length + more.length);
        System.arraycopy(more, 0, joined, fields.length, more.length);
        return joined;
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

        /** Stop decisions use accumulated evidence; only fresh successes are persisted. */
        public List<Success> accumulatedSuccesses() {
            return selectionSuccesses;
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

    /**
     * How a row's detail is shown when its stage line is written: iOS shipmentDiagnosticDetails's row
     * fields, read by the caller that owns the row. Diagnostics only.
     */
    public static final class RowDisplay {
        final boolean automatic;
        final String carrierCode;
        final String routeKind;
        final String displayTimelineProvider;
        final int displayedTrackCount;
        final long latestEventAtMs;
        final long latestTrackAtMs;
        final long feedEventAtMs;
        final long statusEventAtMs;
        final String statusSemantic;
        final boolean structuredStatus;

        public RowDisplay(boolean automatic, String carrierCode, String routeKind,
                String displayTimelineProvider, int displayedTrackCount, long latestEventAtMs,
                long latestTrackAtMs, long feedEventAtMs, long statusEventAtMs, String statusSemantic,
                boolean structuredStatus) {
            this.automatic = automatic;
            this.carrierCode = carrierCode == null ? "" : carrierCode;
            this.routeKind = routeKind == null || routeKind.isEmpty() ? "none" : routeKind;
            this.displayTimelineProvider = displayTimelineProvider == null ? "" : displayTimelineProvider;
            this.displayedTrackCount = displayedTrackCount;
            this.latestEventAtMs = latestEventAtMs;
            this.latestTrackAtMs = latestTrackAtMs;
            this.feedEventAtMs = feedEventAtMs;
            this.statusEventAtMs = statusEventAtMs;
            this.statusSemantic = statusSemantic == null ? "" : statusSemantic;
            this.structuredStatus = structuredStatus;
        }
    }

    /**
     * {@code query} run for one row: its stage lines carry the row's own {@code sourceProvider} (as
     * {@link ExpressLog#source} gives it), {@code waybillTail}, the slot it asks ({@code requestProvider},
     * also the line's level) and the row's display fields from {@code display}, instead of the generic
     * "manual".
     */
    public static Source forRow(Source query, String sourceProvider, String waybillTail, String requestProvider,
            java.util.function.Supplier<RowDisplay> display) {
        return forRow(query, sourceProvider, waybillTail, requestProvider, display, null);
    }

    /**
     * As above, with {@code skipReason} read just before the stage would start: a non-empty reason (the
     * row's cooldown, no route) skips the stage without starting it, as iOS logs a stage it does not
     * attempt, and answers what the query itself would have answered in that case (nothing).
     */
    public static Source forRow(Source query, String sourceProvider, String waybillTail, String requestProvider,
            java.util.function.Supplier<RowDisplay> display, java.util.function.Supplier<String> skipReason) {
        return new RowSource(query, sourceProvider, waybillTail, requestProvider, display, skipReason);
    }

    private static final class RowSource implements Source {
        private final Source query;
        final String sourceProvider;
        final String waybillTail;
        final String requestProvider;
        private final java.util.function.Supplier<RowDisplay> display;
        private final java.util.function.Supplier<String> skipReason;

        RowSource(Source query, String sourceProvider, String waybillTail, String requestProvider,
                java.util.function.Supplier<RowDisplay> display, java.util.function.Supplier<String> skipReason) {
            this.query = query;
            this.sourceProvider = sourceProvider == null ? "" : sourceProvider;
            this.waybillTail = waybillTail == null ? "" : waybillTail;
            this.requestProvider = requestProvider == null ? "" : requestProvider;
            this.display = display;
            this.skipReason = skipReason;
        }

        @Override public ExpressQueryResult query() throws Exception {
            return query.query();
        }

        /**
         * Why this stage will not run, or "" when it will. A check that throws runs the query, which meets
         * the same failure inside the stage and reports it there as before.
         */
        String skipReason() {
            try {
                String reason = skipReason == null ? null : skipReason.get();
                return reason == null ? "" : reason;
            } catch (RuntimeException unavailable) {
                return "";
            }
        }

        /**
         * iOS shipmentDiagnosticDetails(row, requestProvider, response): with no response the observed package
         * is the displayed one; with a response, the answer (its tracks, clocks and status).
         */
        Object[] fields(String provider, ExpressQueryResult response) {
            RowDisplay shown = null;
            try {
                shown = display == null ? null : display.get();
            } catch (RuntimeException ignored) { /* diagnostics only */ }
            java.util.ArrayList<Object> fields = new java.util.ArrayList<>();
            java.util.Collections.addAll(fields, "tail", waybillTail);
            if (shown != null) {
                java.util.Collections.addAll(fields, "automatic", shown.automatic, "carrierCode", shown.carrierCode,
                        "routeKind", shown.routeKind, "routePointerPresent", !"none".equals(shown.routeKind));
            }
            java.util.Collections.addAll(fields, "requestProvider", provider);
            if (shown != null) {
                java.util.Collections.addAll(fields, "displayTimelineProvider", shown.displayTimelineProvider);
            }
            if (response == null) {
                if (shown != null) {
                    java.util.Collections.addAll(fields, "effectiveTrackCount", shown.displayedTrackCount,
                            "selectionScope", "display", "displayedTrackCount", shown.displayedTrackCount,
                            "latestEventAtMs", shown.latestEventAtMs, "latestTrackAtMs", shown.latestTrackAtMs,
                            "feedEventAtMs", shown.feedEventAtMs, "statusEventAtMs", shown.statusEventAtMs,
                            "statusSemantic", shown.statusSemantic, "structuredStatus", shown.structuredStatus);
                }
            } else {
                java.util.Collections.addAll(fields,
                        "effectiveTrackCount", Kuaidi100TimelinePolicy.timedTrackCount(response),
                        "selectionScope", "query_response");
                if (shown != null) java.util.Collections.addAll(fields, "displayedTrackCount", shown.displayedTrackCount);
                java.util.Collections.addAll(fields,
                        "latestEventAtMs", ManualTimelineAuthorityPolicy.latestEventTime(response),
                        "latestTrackAtMs", Kuaidi100TimelinePolicy.latestTimedEventMillis(response),
                        "statusEventAtMs", response.statusEventTime, "statusSemantic", response.semantic,
                        "structuredStatus", response.structuredStatusEvidence);
            }
            return fields.toArray();
        }
    }
}
