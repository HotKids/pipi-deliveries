package me.pipi.deliveries.feature.express;

import android.app.Activity;
import android.util.Log;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressLog;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Uses the detail capture to project one interface 5 order while home is in the foreground. */
final class ExpressHomeOrderProjectionCapture {
    private static final long CAPTURE_TIMEOUT_MS = 20_000L;

    interface Callback {
        void onFinished(ExpressHomeOrderProjectionCapture capture, boolean saved);
    }

    private final Activity host;
    private final ExpressItem source;
    private final Callback callback;
    private ExpressAutomaticTimelineCapture automaticCapture;
    private ExpressQueryCancellation cancellation;
    private ExecutorService worker;
    private ExpressOrderProjectionRetryStore.AttemptToken attempt;
    private volatile boolean finished;

    ExpressHomeOrderProjectionCapture(Activity host, ExpressItem source, Callback callback) {
        this.host = host;
        this.source = source;
        this.callback = callback;
    }

    static boolean needsProjection(ExpressItem item) {
        return ExpressDetailActivity.usesInterface5Automatic(item)
                && item.rowId > 0L && item.isAccountOrder()
                && item.projectedWaybill.isEmpty() && item.routeCredentialAvailable
                && !item.routeCredential.isEmpty();
    }

    boolean start() {
        if (finished || !needsProjection(source)
                || host.isFinishing() || host.isDestroyed()) return false;
        String detailUrl = ExpressDetailActivity.safeOrderH5Url(source);
        if (detailUrl.isEmpty()) {
            ExpressLog.line("v5", "jd_h5", "jingdong", "skipped",
                    "tail", ExpressLog.tail(source.waybill), "reason", "untrusted_route");
            return false;
        }
        ExpressRepository repository = ExpressRepository.get(host);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(source);
        if (claim == null) {
            ExpressLog.line("v5", "jd_h5", "jingdong", "skipped",
                    "tail", ExpressLog.tail(source.waybill), "reason", "owner_claim_missing");
            return false;
        }
        attempt = ExpressOrderProjectionRetryStore.acquireAttempt(source);
        if (attempt == null) return false;
        cancellation = new ExpressQueryCancellation(CAPTURE_TIMEOUT_MS + 10_000L);
        String generation = repository.bindingGeneration(source.phone, "interface5");
        worker = Executors.newSingleThreadExecutor();
        worker.execute(() -> {
            boolean accountDetailGaveTimeline = false;
            try (ExpressQueryCancellation stage = cancellation.child(10_000L)) {
                ExpressQueryResult query = new ExpressDiscoveryClient().refreshKnown(
                        host.getApplicationContext(), source, true, stage);
                cancellation.throwIfCancelled();
                accountDetailGaveTimeline = Kuaidi100TimelinePolicy.hasTimedTracking(query);
                if (query != null && repository.ownsManualQuery(source, claim)) {
                    repository.saveRecoveredOwnerRoute(source, claim, query);
                    repository.saveInterface5Query(query, source, generation);
                }
            } catch (Exception failure) {
                ExpressLog.line("v5", "v5_query", "jingdong", "failed",
                        "tail", ExpressLog.tail(source.waybill),
                        "error", failure.getClass().getSimpleName());
            }
            boolean hasTimeline = accountDetailGaveTimeline;
            host.runOnUiThread(() -> {
                if (finished) return;
                if (cancellation.isCancelled() || host.isFinishing() || host.isDestroyed()
                        || !repository.ownsManualQuery(source, claim)
                        || !generation.equals(repository.bindingGeneration(source.phone, "interface5"))) {
                    complete(false);
                    return;
                }
                ExpressItem current = repository.find(source.rowId);
                if (ExpressDetailActivity.automaticDetailComplete(repository, current)) {
                    ExpressLog.line("v5", "jd_h5", "jingdong", "skipped",
                            "tail", ExpressLog.tail(source.waybill), "reason", "pickup_or_complete_cache");
                    complete(false);
                    return;
                }
                if (!ExpressDetailActivity.allowsJingDongCapture(current, hasTimeline)) {
                    ExpressLog.line("v5", "jd_h5", "jingdong", "skipped",
                            "tail", ExpressLog.tail(source.waybill),
                            "reason", hasTimeline ? "account_query_timeline" : "already_projected");
                    complete(current != null && !current.projectedWaybill.isEmpty());
                    return;
                }
                startH5(repository, current, claim, detailUrl);
            });
        });
        return true;
    }

    private void startH5(ExpressRepository repository, ExpressItem current,
            ExpressRepository.ManualQueryOwnerClaim claim, String detailUrl) {
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(host);
        if (retries.beginTimelineAttempt(current, System.currentTimeMillis(), attempt) == null) {
            complete(false);
            return;
        }
        ExpressLog.line("v5", "jd_h5", "jingdong", "started",
                "tail", ExpressLog.tail(source.waybill));
        String refreshedUrl = ExpressDetailActivity.safeOrderH5Url(current);
        automaticCapture = new ExpressAutomaticTimelineCapture(host, current,
                refreshedUrl.isEmpty() ? detailUrl : refreshedUrl,
                TimelineSlot.JD_H5, cancellation, result -> {
                    if (finished) return;
                    boolean saved = false;
                    try {
                        if (!cancellation.isCancelled() && !host.isFinishing() && !host.isDestroyed()) {
                            if (result != null && result.throttled) new ExpressOrderProjectionRetryStore(host)
                                    .recordTimelineRateLimit(source, System.currentTimeMillis());
                            if (result != null && result.timeline != null)
                                saved = repository.saveAutomaticDetailTimeline(
                                        current, claim, result.timeline, result.complete);
                        }
                    } catch (RuntimeException failure) {
                        Log.w("ExpressOrderProjection", "Home detail capture could not be saved: "
                                + failure.getClass().getSimpleName());
                    } finally {
                        ExpressLog.line("v5", "jd_h5", "jingdong", saved ? "succeeded" : "failed",
                                "tail", ExpressLog.tail(source.waybill), "saved", saved,
                                "resultPresent", result != null && result.timeline != null,
                                "complete", result != null && result.complete);
                        complete(saved);
                    }
                });
        automaticCapture.start();
    }

    void cancel() {
        if (finished) return;
        finished = true;
        if (cancellation != null) cancellation.cancel();
        if (worker != null) worker.shutdownNow();
        if (automaticCapture != null) automaticCapture.cancel();
        automaticCapture = null;
        ExpressOrderProjectionRetryStore.releaseAttempt(attempt);
        attempt = null;
    }

    private void complete(boolean saved) {
        if (finished) return;
        cancel();
        if (callback != null) callback.onFinished(this, saved);
    }
}
