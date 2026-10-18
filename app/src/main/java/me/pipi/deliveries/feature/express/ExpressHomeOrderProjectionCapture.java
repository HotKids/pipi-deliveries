package me.pipi.deliveries.feature.express;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.background.AccountCarrierRecognition;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressLog;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Uses the detail capture to project one interface 5 order while home is in the foreground, or
 * off-window at the end of a background sync round (user decision 2026-09-24,
 * {@link ExpressBackgroundOrderProjection}). Both run this same gate, cooldown, lease and commit.
 */
final class ExpressHomeOrderProjectionCapture {
    static final long CAPTURE_TIMEOUT_MS = 20_000L;
    /**
     * Audit R10 (user 2026-09-25): Home's lines name their trigger and flow as iOS names its Home
     * projection (sync.ts STORED_PROJECTION_TRIGGER, flow {@code home-projection-…}).
     */
    static final String HOME_TRIGGER = "home_projection";

    static String homeFlowId() {
        return ExpressLog.newFlowId("home-projection");
    }

    interface Callback {
        void onFinished(ExpressHomeOrderProjectionCapture capture, boolean saved);
    }

    /** Home; null when the capture runs off-window for a background round. */
    private final Activity host;
    /** The host itself, or the application context when there is no host. */
    private final Context context;
    private final Handler main;
    private final ExpressItem source;
    private final Callback callback;
    /** Home's flow; null off-window, whose lines keep their existing trigger=background only. */
    private final String flowId;
    private ExpressAutomaticTimelineCapture automaticCapture;
    private ExpressQueryCancellation cancellation;
    private ExecutorService worker;
    private int runningWorkers;
    private boolean cleanupFinished;
    private ExpressOrderProjectionRetryStore.AttemptToken attempt;
    private volatile boolean finished;
    private volatile boolean throttled;
    /** This capture opened its union page (and claimed the order's cooldown for it). */
    private volatile boolean pageClaimed;
    /** The page brought a package (with nodes, complete or partial). */
    private volatile boolean packageReceived;
    /** The page answered with JD risk control (HTTP 403 or its throttle text). */
    private volatile boolean riskControlAnswer;

    ExpressHomeOrderProjectionCapture(Activity host, ExpressItem source, Callback callback) {
        this(host, source, callback, homeFlowId());
    }

    /** Home's capture inside the flow of the Home pass that chose it. */
    ExpressHomeOrderProjectionCapture(Activity host, ExpressItem source, Callback callback,
            String flowId) {
        this(host, host, source, callback, flowId);
    }

    /** The same capture without an Activity: callbacks on the main looper, page laid out off-window. */
    static ExpressHomeOrderProjectionCapture offWindow(
            Context context, ExpressItem source, Callback callback) {
        return new ExpressHomeOrderProjectionCapture(
                null, context.getApplicationContext(), source, callback, null);
    }

    private ExpressHomeOrderProjectionCapture(
            Activity host, Context context, ExpressItem source, Callback callback, String flowId) {
        this.host = host;
        this.context = context;
        this.main = host == null ? new Handler(Looper.getMainLooper()) : null;
        this.source = source;
        this.callback = callback;
        this.flowId = host == null ? null : flowId;
    }

    static boolean needsProjection(ExpressItem item) {
        return needsProjection(item, false);
    }

    /**
     * {@code onScreen}（用户 2026-09-25 同意）：首页在屏幕上时，已完成、还没运单号的订单也取一次号——真实
     * 运单号出来了就不该再停在「京东购物 + 订单号」，同一个包裹另有一行运单时取号后并成一行（Pixel：0579 与
     * YT3763429197051）。只有首页传 true；后台轮次照旧只认揽收。与 iOS jingDongOrderPastPickup 的
     * includeCompleted 同口径。
     */
    static boolean needsProjection(ExpressItem item, boolean onScreen) {
        return ExpressDetailActivity.usesInterface5Automatic(item)
                && item.rowId > 0L && item.isAccountOrder()
                && item.projectedWaybill.isEmpty() &&
                // AGENTS §9「谁需要自己取运单号」：文案取号只给京东件。
                (item.isJingDongSource()
                        && ExpressOrderTextIdentity.fromTracksJson(item.tracksJson, item.waybill) != null
                    || item.routeCredentialAvailable && !item.routeCredential.isEmpty()
                        && (Kuaidi100TimelinePolicy.hasPickupEvidence(new ExpressQueryResult(
                                item.waybill, item.courierCode, item.companyName,
                                StatusSemantic.UNKNOWN, item.latestTime, item.latestDetail,
                                item.tracksJson, "", item.phone, TimelineSlot.V5_QUERY,
                                "", "", item.sourceProvider))
                            || structurallyPastPickup(item, onScreen)));
    }

    /**
     * 首页投影问的是「承运商揽收了没有、京粉页上有没有运单号」。京东列表经常只给最新一条（「您的订单
     * 正在派送中」），feed 里没有揽收字样，结构化状态却已经是派送中——只认文字节点时这类单首页永远
     * 投影不出来，只能靠详情页下拉（2026-09-24）。已下单、已发货不算揽收；已签收的单照旧只认文字
     * 节点，免得一次刷新给所有老单都开一遍京粉页——只有首页在屏幕上时例外（{@code includeCompleted}，
     * 用户 2026-09-25 同意，见 {@link #needsProjection(ExpressItem, boolean)}）。
     *
     * <p>只看 feed 自己的结构化状态（与 iOS jingDongOrderPastPickup 同口径）：未投影订单的 semantic 把
     * 「已揽收」压成了「已下单」，所以比的是 sourceSemantic。审计 L8（用户 2026-09-25 采纳）：读的是存盘那一行
     * 降级前的 Worker 状态（{@link ExpressItem#sourceStatusStructured}），v5_query 接管了展示状态也不影响它；
     * v5_query 自己的状态照旧不算。</p>
     */
    static boolean structurallyPastPickup(ExpressItem item) {
        return structurallyPastPickup(item, false);
    }

    static boolean structurallyPastPickup(ExpressItem item, boolean includeCompleted) {
        if (!item.sourceStatusStructured) return false;
        switch (item.sourceSemantic) {
            case PICKED:
            case TRANSIT:
            case DELIVERY:
            case WAITING_PICKUP:
                return true;
            case COMPLETED:
                return includeCompleted;
            default:
                return false;
        }
    }

    boolean start() {
        if (finished || !needsProjection(source, host != null) || hostClosed()) return false;
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(context);
        // 用户 2026-09-25 同意（方案 A）：京粉页已确认是空壳的已完成订单不再重开，v5_query 也不先发。
        if (retries.pageConfirmedEmpty(source)) {
            log("jd_h5", "skipped",
                    "tail", ExpressLog.tail(source.waybill), "reason", "empty_order_page");
            return false;
        }
        String detailUrl = ExpressDetailActivity.safeOrderH5Url(source);
        if (detailUrl.isEmpty()) {
            log("jd_h5", "skipped",
                    "tail", ExpressLog.tail(source.waybill), "reason", "untrusted_route");
            return false;
        }
        // 首页每次 onStart、每轮同步结束都会清空「这一批已试过」；京粉页一直没有运单号的单不能每次都先
        // 强制查一遍 v5，所以冷却（与详情共用的京粉页冷却）没到时 v5_query 和京粉页都不发。
        if (!retries.timelineAttemptDue(source, System.currentTimeMillis())) {
            log("jd_h5", "skipped",
                    "tail", ExpressLog.tail(source.waybill), "reason", "cooldown");
            return false;
        }
        attempt = ExpressOrderProjectionRetryStore.acquireAttempt(source);
        if (attempt == null) return false;
        cancellation = new ExpressQueryCancellation(CAPTURE_TIMEOUT_MS + 10_000L);
        worker = Executors.newSingleThreadExecutor();
        executeWorker(() -> {
            try {
                ExpressRepository repository = ExpressRepository.get(context);
                ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(source);
                if (claim == null || cancellation.isCancelled()) {
                    log("jd_h5", "skipped",
                            "tail", ExpressLog.tail(source.waybill), "reason", "owner_claim_missing");
                    onMain(() -> complete(false));
                    return;
                }
                ExpressApi api = new ExpressApi(context.getApplicationContext());
                // T23（用户 2026-09-26，其余裁决 28）：已经知道运单号、只差承运商的订单（已存 v5_query 的文案、暂存的
                // 京粉页）不再查 v5、不再开页，只补识别；对上才投影。
                ExpressRepository.PendingProjection known = repository.pendingProjection(source);
                if (known != null) {
                    boolean projected = false;
                    try {
                        projected = AccountCarrierRecognition.projectPending(repository, source, known,
                                recognizer(api, source), cancellation);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                    }
                    boolean committed = projected;
                    onMain(() -> complete(committed));
                    return;
                }
                String generation = repository.bindingGeneration(source.phone, "interface5");
                try (ExpressQueryCancellation stage = cancellation.child(10_000L)) {
                    ExpressQueryResult query = new ExpressDiscoveryClient().refreshKnown(
                            context.getApplicationContext(), source, true, stage);
                    cancellation.throwIfCancelled();
                    if (query != null && repository.ownsManualQuery(source, claim)) {
                        repository.saveRecoveredOwnerRoute(source, claim, query);
                        // T23 entry E: the waybill the reply's text names projects only with its carrier; a
                        // recognition cut off by the budget still saves the reply, unprojected.
                        String textCarrier;
                        try {
                            textCarrier = AccountCarrierRecognition.queryTextCarrier(
                                    source, query, recognizer(api, source));
                        } catch (InterruptedException cutOff) {
                            textCarrier = null;
                        }
                        repository.saveInterface5Query(query, source, generation, textCarrier);
                    }
                } catch (Exception failure) {
                    log("v5_query", "failed", ExpressLog.errorDetails(failure,
                            "tail", ExpressLog.tail(source.waybill)));
                }
                boolean owns = repository.ownsManualQuery(source, claim)
                        && generation.equals(repository.bindingGeneration(source.phone, "interface5"));
                ExpressItem current = owns ? repository.find(source.rowId) : null;
                boolean waybillKnown = current != null && repository.pendingProjection(current) != null;
                onMain(() -> {
                    if (finished) return;
                    if (cancellation.isCancelled() || hostClosed() || !owns) {
                        complete(false);
                        return;
                    }
                    if (waybillKnown) {
                        // The reply named the waybill but its carrier did not match: no page for it.
                        log("jd_h5", "skipped",
                                "tail", ExpressLog.tail(source.waybill), "reason", "carrier_pending");
                        complete(false);
                        return;
                    }
                    if (!ExpressDetailActivity.allowsJingDongCapture(current)) {
                        log("jd_h5", "skipped",
                                "tail", ExpressLog.tail(source.waybill),
                                "reason", "already_projected");
                        complete(current != null && !current.projectedWaybill.isEmpty());
                        return;
                    }
                    startH5(repository, current, claim, detailUrl);
                });
            } catch (RuntimeException failure) {
                Log.w("ExpressOrderProjection", "Home detail preparation failed: "
                        + failure.getClass().getSimpleName());
                onMain(() -> complete(false));
            }
        });
        return true;
    }

    private void startH5(ExpressRepository repository, ExpressItem current,
            ExpressRepository.ManualQueryOwnerClaim claim, String detailUrl) {
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(context);
        if (retries.beginTimelineAttempt(current, System.currentTimeMillis(), attempt) == null) {
            complete(false);
            return;
        }
        pageClaimed = true;
        log("jd_h5", "started", "tail", ExpressLog.tail(source.waybill));
        String refreshedUrl = ExpressDetailActivity.safeOrderH5Url(current);
        String page = refreshedUrl.isEmpty() ? detailUrl : refreshedUrl;
        ExpressAutomaticTimelineCapture.Callback captured = result -> {
            if (finished) return;
            packageReceived = result != null && result.timeline != null;
            riskControlAnswer = result != null && result.throttled;
            // 用户采纳 2026-09-24：预算用完（强制 v5_query 吃掉了大半）或首页已关时页面才回话，也得收尾一次，
            // 否则首页一直挂着这一单的租约，下一单要等到 onStop。
            if (cancellation.isCancelled() || hostClosed()) {
                complete(false);
                return;
            }
            if (result != null && result.throttled) {
                throttled = true;
                new ExpressOrderProjectionRetryStore(context)
                        .recordTimelineRateLimit(source, System.currentTimeMillis());
            }
            retries.recordPage(current, result, System.currentTimeMillis());
            executeWorker(() -> {
                boolean saved = false;
                try {
                    if (result != null && result.timeline != null) {
                        ExpressApi api = new ExpressApi(context.getApplicationContext());
                        // T23 entry F: the page's waybill projects only with a matched carrier; otherwise
                        // it is held (row unchanged, no further page) until a later round matches it.
                        saved = AccountCarrierRecognition.savePageCapture(repository, current, claim,
                                result.timeline, result.complete, recognizer(api, current), cancellation);
                        ExpressItem projected = saved ? repository.find(current.rowId) : null;
                        if (AccountCarrierRecognition.needsRecognition(projected)) {
                            AccountCarrierRecognition.recognize(repository, projected,
                                    recognizer(api, projected, cancellation));
                        }
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                } catch (RuntimeException failure) {
                    Log.w("ExpressOrderProjection", "Home detail capture could not be saved: "
                            + failure.getClass().getSimpleName());
                } finally {
                    log("jd_h5", saved ? "succeeded" : "failed",
                            "tail", ExpressLog.tail(source.waybill), "saved", saved,
                            "resultPresent", result != null && result.timeline != null,
                            "complete", result != null && result.complete);
                    boolean committed = saved;
                    onMain(() -> complete(committed));
                }
            });
        };
        automaticCapture = host != null
                ? new ExpressAutomaticTimelineCapture(
                        host, current, page, TimelineSlot.JD_H5, cancellation, captured)
                : ExpressAutomaticTimelineCapture.offWindow(
                        context, current, page, cancellation, captured);
        automaticCapture.start();
    }

    private AccountCarrierRecognition.Recognizer recognizer(ExpressApi api, ExpressItem owner) {
        return recognizer(api, owner, cancellation);
    }

    private AccountCarrierRecognition.Recognizer recognizer(
            ExpressApi api, ExpressItem owner, ExpressQueryCancellation budget) {
        // 优化 5: the paid level carries this row's reuse anchor.
        ExpressApi parcel = api.forParcel(
                AccountCarrierRecognition.parcelAnchor(ExpressRepository.get(context), owner));
        return waybill -> parcel.recognizeCarrier(waybill, budget,
                AccountCarrierRecognition.excludesJd(owner, waybill));
    }

    /** Whether JD answered this attempt with risk control (HTTP 403 or its throttle text). */
    boolean throttled() {
        return throttled;
    }

    private boolean hostClosed() {
        return host != null && (host.isFinishing() || host.isDestroyed());
    }

    private void onMain(Runnable action) {
        if (host != null) host.runOnUiThread(action);
        else main.post(action);
    }

    /** Background lines say trigger=background; Home lines trigger=home_projection (audit R10). */
    private String trigger() {
        return host == null ? "background" : HOME_TRIGGER;
    }

    /** One capture line: Home's carry its flow and trigger; off-window ones their trigger. */
    private void log(String level, String outcome, Object... fields) {
        Object[] line = java.util.Arrays.copyOf(fields, fields.length + 4);
        line[fields.length] = "flowId";
        line[fields.length + 1] = flowId;
        line[fields.length + 2] = "trigger";
        line[fields.length + 3] = trigger();
        ExpressLog.line("v5", level, "jingdong", outcome, line);
    }

    private void executeWorker(Runnable action) {
        worker.execute(() -> {
            synchronized (this) {
                if (finished) return;
                runningWorkers++;
            }
            try { action.run(); }
            finally {
                synchronized (this) { runningWorkers--; }
                releaseSettledAttempt();
            }
        });
    }

    private synchronized void releaseSettledAttempt() {
        if (!cleanupFinished || runningWorkers != 0) return;
        ExpressOrderProjectionRetryStore.releaseAttempt(attempt);
        attempt = null;
    }

    void cancel() {
        synchronized (this) {
            if (finished) return;
            finished = true;
        }
        if (cancellation != null) cancellation.cancel();
        if (worker != null) worker.shutdownNow();
        if (automaticCapture != null) automaticCapture.cancel();
        automaticCapture = null;
        // 优化 6（用户 2026-10-03「离屏失败不占冷却（推荐）」）：an off-window page that brought no package and was not risk
        // control gives its ten minutes back, so Home can fetch at once; a package or risk control keeps today's cooldown,
        // and Home's own hosted page is unchanged.
        if (host == null && pageClaimed && !packageReceived && !riskControlAnswer && !throttled) {
            try {
                new ExpressOrderProjectionRetryStore(context).releaseTimelineCooldown(source, attempt);
            } catch (RuntimeException failure) {
                Log.w("ExpressOrderProjection", "Off-window cooldown could not be released: "
                        + failure.getClass().getSimpleName());
            }
        }
        synchronized (this) { cleanupFinished = true; }
        releaseSettledAttempt();
    }

    private void complete(boolean saved) {
        if (finished) return;
        cancel();
        if (callback != null) callback.onFinished(this, saved);
    }
}
