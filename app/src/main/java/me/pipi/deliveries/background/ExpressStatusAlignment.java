package me.pipi.deliveries.background;

import android.content.Context;
import android.util.Log;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressLog;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressSubscriptionClient;
import me.pipi.deliveries.network.ManualQueryCoordinator;

/**
 * Refreshes rows whose structured status, headline state or compared times disagree. Each persisted
 * set allows at most three real attempts, at the row's normal interval; only an advancing package or
 * node completes it. Web captures unavailable to this host never consume an attempt. SF's account
 * feed is a final headline fallback after the first attempt, and cannot freeze the row by itself.
 * JD presentation remains owned by its separate rules. See the October 8 alignment/freeze contracts.
 */
public final class ExpressStatusAlignment {
    static final String TRIGGER = "status_alignment";
    static final String EVENT = "detail.refresh.alignment";
    /** Where the sets were kept before the ledger; {@link ExpressRepository} migrates them once. */
    static final String PREFS = ExpressRepository.LEGACY_STATUS_ALIGNMENT_PREFS;
    /** The commits of one operation settle before the check reads the list. */
    static final long SETTLE_MILLIS = 3_000L;
    /** 三端预算（用户定 2026-09-05）：手动链每级 15 s. */
    static final long PICKER_BUDGET_MS = 15_000L;

    private static final String TAG = "ExpressStatusAlignment";
    /** Guards the in-process schedule only; never held while the repository is called. */
    private static final Object SCHEDULE_LOCK = new Object();
    private static final AtomicInteger ROUNDS = new AtomicInteger();
    private static volatile boolean liveChecks;
    private static ScheduledExecutorService executor;
    private static boolean scheduled;
    private static final Set<Long> ALIGNING = ConcurrentHashMap.newKeySet();

    private ExpressStatusAlignment() {}

    public static boolean notificationAlignmentInProgress(long rowId) {
        return ALIGNING.contains(rowId);
    }

    /** The requests a forced refresh may make in a host without an Activity. */
    interface Sources {
        ExpressQueryResult accountDetail(Context context, ExpressItem row) throws Exception;

        ExpressQueryResult picker(Context context, String waybill) throws Exception;
    }

    static final Sources NETWORK = new Sources() {
        @Override public ExpressQueryResult accountDetail(Context context, ExpressItem row)
                throws Exception {
            // The detail entry's forced per-parcel query: past the signature cache and this round's sync.
            try (ExpressQueryCancellation budget = new ExpressQueryCancellation(
                    ExpressDiscoveryClient.ACCOUNT_DETAIL_BUDGET_MS)) {
                return new ExpressDiscoveryClient().refreshKnown(context, row, true, budget);
            }
        }

        @Override public ExpressQueryResult picker(Context context, String waybill) throws Exception {
            try (ExpressQueryCancellation budget = new ExpressQueryCancellation(PICKER_BUDGET_MS)) {
                return new ExpressSubscriptionClient().queryManual(context, waybill, budget);
            }
        }
    };

    /** Any two of the three times, each present, more than five minutes apart (用户 2026-10-02「五分钟」). */
    static boolean outOfStep(long statusAt, long headlineAt, long detailAt) {
        long[] times = {statusAt, headlineAt, detailAt};
        for (int i = 0; i < times.length; i++) {
            for (int j = i + 1; j < times.length; j++) {
                if (times[i] > 0L && times[j] > 0L && Math.abs(times[i] - times[j])
                        > ExpressRepository.STATUS_ALIGNMENT_MILLIS) return true;
            }
        }
        return false;
    }

    /** Which side is out of step, for the log; the same order of checks as Pipi's ExpressStatusAlignment. */
    static String reason(long statusAt, long headlineAt, long detailAt) {
        long limit = ExpressRepository.STATUS_ALIGNMENT_MILLIS;
        if (headlineAt > 0L && statusAt - headlineAt > limit) return "status_ahead";
        if (headlineAt > 0L && headlineAt - statusAt > limit) return "headline_ahead";
        return "detail_behind";
    }

    static String times(long statusAt, long headlineAt, long detailAt) {
        return statusAt + "|" + headlineAt + "|" + detailAt;
    }

    /** Called once by the app process entrypoint; tests and other hosts never schedule in-process checks. */
    public static void enableLiveChecks() {
        liveChecks = true;
    }

    /**
     * A repository commit invalidated the list. In the app process a check follows once the store settles,
     * unless a WorkManager round is running (that round checks when it ends).
     */
    public static void listChanged(Context context) {
        if (!liveChecks || context == null) return;
        Context app = context.getApplicationContext() == null ? context : context.getApplicationContext();
        synchronized (SCHEDULE_LOCK) {
            if (scheduled) return;
            scheduled = true;
            if (executor == null) {
                executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
                    Thread thread = new Thread(runnable, "express-status-alignment");
                    thread.setDaemon(true);
                    return thread;
                });
            }
            executor.schedule(() -> runScheduled(app), SETTLE_MILLIS, TimeUnit.MILLISECONDS);
        }
    }

    private static void runScheduled(Context context) {
        synchronized (SCHEDULE_LOCK) {
            scheduled = false;
        }
        if (ROUNDS.get() > 0) return;
        try {
            check(context, ExpressRepository.get(context),
                    ExpressAccountSource.bindingSource(context), () -> false, NETWORK);
        } catch (RuntimeException failure) {
            Log.w(TAG, "Status alignment check failed: " + failure.getClass().getSimpleName());
        }
    }

    static void roundStarted() {
        ROUNDS.incrementAndGet();
    }

    static void roundFinished() {
        ROUNDS.updateAndGet(count -> Math.max(0, count - 1));
    }

    /** The end of a committed WorkManager round: its list data has settled. Never fails the round. */
    static void afterRound(Context context, BooleanSupplier stopped) {
        try {
            check(context, ExpressRepository.get(context),
                    ExpressAccountSource.bindingSource(context), stopped, NETWORK);
        } catch (RuntimeException failure) {
            Log.w(TAG, "Status alignment check failed: " + failure.getClass().getSimpleName());
        }
    }

    /** Checks visible rows and starts the next eligible attempt for an unfinished alignment set. */
    static int check(Context context, ExpressRepository repository, String bindingSource,
            BooleanSupplier stopped, Sources sources) {
        int forced = 0;
        for (ExpressRepository.StatusAlignmentProbe probe : repository.statusAlignmentProbes(bindingSource)) {
            long detailAt = probe.comparedDetailAt();
            boolean semanticMismatch = probe.headlineSemantic != StatusSemantic.UNKNOWN
                    && probe.headlineSemantic != probe.row.semantic;
            boolean coarseSf = probe.headlineCoarse || probe.detailCoarse;
            if (!outOfStep(probe.statusAt, probe.headlineAt, detailAt) && !semanticMismatch && !coarseSf) continue;
            if (stopped.getAsBoolean() || Thread.currentThread().isInterrupted()) break;
            // 优化 3: a signed-frozen row is not checked: nothing is recorded or logged for it.
            if (signedFrozen(repository, probe)) continue;
            if (!runsAccountDetail(probe.row) && !runsPicker(probe.row)) continue;
            String set = ExpressRepository.alignmentTimes(probe);
            if (!repository.statusAlignmentDue(probe.row, set, System.currentTimeMillis())) continue;
            Attempt attempt = new Attempt(repository, probe.row, set);
            try { refresh(context, repository, probe, bindingSource, sources, attempt); }
            finally { attempt.finish(); }
            if (attempt.started) forced++;
        }
        return forced;
    }

    /**
     * The interface 5 per-parcel account detail, for the rows whose detail entry queries it (interface 5
     * automatic rows other than SF, whose Picker leads).
     */
    static boolean runsAccountDetail(ExpressItem row) {
        return row != null && !row.manuallyAdded
                && "interface5".equals(ExpressAccountSource.bindingSourceForOwner(
                        row.stateOwner.isEmpty() ? row.source : row.stateOwner))
                && !"ShunFeng".equalsIgnoreCase(row.sourceProvider);
    }

    /**
     * The list round's Picker partition ({@link ExpressSyncEngine}) without its owner-history gate: SF rows and
     * interface 5 automatic rows with a real waybill (except the Cainiao and JD sources, which the list round
     * never sends to the Picker), and manual rows from the local timeline sources.
     */
    static boolean runsPicker(ExpressItem row) {
        return sharedPicker(row) || localPicker(row);
    }

    private static boolean sharedPicker(ExpressItem row) {
        return row != null && !(ExpressSyncEngine.isInterface5Owned(row)
                && (row.isCainiaoSource() || row.isJingDongSource()))
                && ExpressRepository.automaticListQueryPartition(row);
    }

    private static boolean localPicker(ExpressItem row) {
        return row != null && !ExpressSyncEngine.isAccountOwned(row)
                && ExpressSyncEngine.isLocalTimelineSource(row.source);
    }

    /** Persistence precedes the first actual query; a blocked lease does not consume an attempt. */
    private static final class Attempt {
        final ExpressRepository repository;
        final ExpressItem row;
        final String times;
        Map<String, Long> before;
        boolean started;

        Attempt(ExpressRepository repository, ExpressItem row, String times) {
            this.repository = repository;
            this.row = row;
            this.times = times;
        }

        boolean start() {
            if (started) return true;
            Map<String, Long> evidence = repository.statusAlignmentEvidence(row);
            if (!repository.beginStatusAlignment(row, times, System.currentTimeMillis())) return false;
            before = evidence;
            started = true;
            ALIGNING.add(row.rowId);
            return true;
        }

        void finish() {
            if (!started) return;
            try { repository.finishStatusAlignment(row, times, before); }
            finally { ALIGNING.remove(row.rowId); }
            repository.replayStatusAlignmentNotification(row);
        }
    }

    private static void refresh(Context context, ExpressRepository repository,
            ExpressRepository.StatusAlignmentProbe probe, String bindingSource, Sources sources, Attempt attempt) {
        ExpressItem row = probe.row;
        boolean accountDetail = runsAccountDetail(row);
        boolean picker = runsPicker(row);
        try (ExpressLog.Scope ignored = ExpressLog.detailScope(ExpressLog.newFlowId("detail"), TRIGGER,
                interfaceOf(row))) {
            ExpressLog.write(EVENT, "waybillTail", ExpressLog.tail(row.displayWaybill()),
                    "sourceProvider", ExpressLog.source(row.sourceProvider, row.manuallyAdded),
                    "automatic", !row.manuallyAdded,
                    "alignmentReason", reason(probe.statusAt, probe.headlineAt, probe.comparedDetailAt()),
                    "statusEventAtMs", probe.statusAt, "headlineAtMs", probe.headlineAt,
                    "detailLatestTrackAtMs", probe.detailAt,
                    "detailCompared", !probe.detailFromWebCapture,
                    "headlineSemantic", probe.headlineSemantic.name(),
                    "accountDetail", accountDetail, "picker", picker);
            if (accountDetail) refreshAccountDetail(context, repository, row, sources, attempt);
            if (picker && !Thread.currentThread().isInterrupted()) {
                refreshPicker(context, repository, row, bindingSource, sources, attempt);
            }
        }
    }

    /** A failed read freezes nothing: the row is checked as before. */
    private static boolean signedFrozen(ExpressRepository repository, ExpressRepository.StatusAlignmentProbe probe) {
        try {
            return repository.signedFrozen(probe);
        } catch (RuntimeException failure) {
            Log.w(TAG, "Signed freeze read failed: " + failure.getClass().getSimpleName());
            return false;
        }
    }

    private static String interfaceOf(ExpressItem row) {
        return row.manuallyAdded ? "" : "interface5".equals(ExpressAccountSource.bindingSourceForOwner(
                row.stateOwner.isEmpty() ? row.source : row.stateOwner)) ? "v5" : "v6";
    }

    private static ExpressItem sameRow(ExpressRepository repository, ExpressItem row) {
        ExpressItem current = repository.find(row.rowId);
        return current != null && current.waybill.equals(row.waybill)
                && current.stateOwner.equals(row.stateOwner)
                && current.sourceProvider.equals(row.sourceProvider) ? current : null;
    }

    private static void refreshAccountDetail(Context context, ExpressRepository repository,
            ExpressItem row, Sources sources, Attempt attempt) {
        try {
            ExpressItem current = sameRow(repository, row);
            if (current == null) return;
            String generation = repository.bindingGeneration(current.phone, "interface5");
            if (!attempt.start()) return;
            ExpressQueryResult refreshed = sources.accountDetail(context, current);
            if (refreshed == null || ExpressStatusNormalizer.isProviderErrorDetail(refreshed.latestDetail)) return;
            // A waybill the reply's order text names is held for the next round's recognition (T23): null
            // saves the reply without projecting it.
            repository.saveInterface5Query(refreshed, current, generation, null);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (Exception failure) {
            ExpressLog.write("refresh.stage.failed", ExpressLog.errorDetails(failure, "stage", TRIGGER,
                    "requestProvider", TimelineSlot.V5_QUERY, "waybillTail", ExpressLog.tail(row.displayWaybill())));
        }
    }

    private static void refreshPicker(Context context, ExpressRepository repository,
            ExpressItem row, String bindingSource, Sources sources, Attempt attempt) {
        ExpressItem owner = sameRow(repository, row);
        if (owner == null) return;
        ExpressRepository.ManualTimelinePollClaim claim =
                repository.claimStatusAlignmentManualTimelinePoll(owner, System.currentTimeMillis());
        if (claim == null) {
            ExpressLog.line("", TimelineSlot.V6_QUERY, "", "skipped",
                    "tail", ExpressLog.tail(owner.displayWaybill()), "reason", "refresh_claim_unavailable");
            return;
        }
        try {
            ExpressRepository.ManualQueryOwnerClaim ownerClaim = repository.captureManualQueryOwner(owner);
            if (ownerClaim == null) return;
            ManualTimelineAuthorityPolicy.Candidate cached =
                    repository.manualTimelineCandidate(owner, TimelineSlot.V6_QUERY);
            ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryOnlineFirst(
                    () -> attempt.start() ? sources.picker(context, owner.displayWaybill()) : null,
                    cached, null, false, null, null, owner.semantic == StatusSemantic.UNKNOWN);
            repository.saveClaimedManualQueryBatch(owner, ownerClaim, batch.successes,
                    owner.phone, bindingSource, sharedPicker(owner), claim, null);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        } catch (Exception failure) {
            ExpressLog.write("refresh.stage.failed", ExpressLog.errorDetails(failure, "stage", TRIGGER,
                    "requestProvider", TimelineSlot.V6_QUERY, "waybillTail", ExpressLog.tail(owner.displayWaybill())));
        } finally {
            repository.releaseManualTimelinePoll(claim);
        }
    }
}
