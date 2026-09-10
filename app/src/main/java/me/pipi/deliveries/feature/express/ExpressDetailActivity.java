package me.pipi.deliveries.feature.express;

import me.pipi.deliveries.data.TimelineSlot;
import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.content.res.AppCompatResources;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.color.MaterialColors;
import com.google.android.material.progressindicator.LinearProgressIndicator;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import me.pipi.deliveries.R;
import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.data.ManualRoutePolicy;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.CainiaoRoute;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressLog;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressSubscriptionClient;
import me.pipi.deliveries.network.ManualQueryCoordinator;
import me.pipi.deliveries.network.ManualQueryRoutingPolicy;

/** Renders cached timeline authorities and performs only user-triggered detail enrichment. */
public final class ExpressDetailActivity extends AppCompatActivity {
    private static final String ORDER_LOG_TAG = "ExpressOrderProjection";
    private static final String MANUAL_LOG_TAG = "ExpressManualTimeline";
    public static final String EXTRA_ROW_ID = "express_row_id";
    private static final String EXTRA_MANUAL_QUERY = "first_manual_query";
    private static final String EXTRA_MANUAL_COURIER_HINT = "manual_courier_hint";
    static final int RESULT_PHONE_TAIL_REQUIRED = RESULT_FIRST_USER;
    static final String EXTRA_RETRY_WAYBILL = "retry_waybill";
    static final String EXTRA_RETRY_COURIER = "retry_courier";
    static final String EXTRA_RETRY_MISMATCH = "retry_mismatch";
    private static final String EXTRA_PREVIEW = "express_preview";
    private static final String EXTRA_PERSIST_PREVIEW = "persist_express_preview";
    private static final String EXTRA_TRANSIENT_PICKER_PREVIEW =
            "transient_picker_preview";
    private static final String EXTRA_WAYBILL = "preview_waybill";
    private static final String EXTRA_COURIER = "preview_courier";
    private static final String EXTRA_COMPANY = "preview_company";
    private static final String EXTRA_STATUS = "preview_status";
    private static final String EXTRA_STATUS_EVENT_TIME = "preview_status_event_time";
    private static final String EXTRA_TIME = "preview_time";
    private static final String EXTRA_DETAIL = "preview_detail";
    private static final String EXTRA_TRACKS = "preview_tracks";
    private static final String EXTRA_URL = "preview_url";
    private static final String EXTRA_PHONE = "preview_phone";
    private static final String EXTRA_TIMELINE_PROVIDER = "preview_timeline_provider";
    private static final String EXTRA_ROUTE_INTERFACE = "preview_route_interface";
    private static final String EXTRA_ROUTE_CREDENTIAL = "preview_route_credential";
    private static final String EXTRA_PREVIEW_BINDING_SOURCE = "preview_binding_source";
    private static final String LOGO_SELECTOR =
            "body.mcn > .container > .cp-info.physical-border > .cp-info_thumb > img";
    private static final String LOGO_WRAPPER_SELECTOR =
            "body.mcn > .container > .cp-info.physical-border > .cp-info_thumb";
    private static final String LOGO_STYLE_ID = "__deliveries_courier_logo_style";
    private static final int ORANGE = 0xFFFF8000;
    private static final int BLUE = 0xFF1E85E5;
    private static final int GRAY = 0xFF9B9B9B;
    private static final int LIGHT_GRAY = 0xFFB0B0B3;
    private static final int LINE = 0x33888888;
    // 三端同预算（用户定 2026-09-05）：详情页手动刷新 15 秒（iOS DETAIL_MANUAL_REFRESH_BUDGET_MS 同值）。
    private static final long LOCAL_REFRESH_TIMEOUT_MS = 15_000L;
    static final long ORDER_CAPTURE_TIMEOUT_MS = 20_000L;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private WebView webView;
    private boolean webNativeFallbackStarted;
    private ExpressKuaidi100TimelineCapture kuaidi100Capture;
    private ExpressQueryCancellation directRouteCancellation;
    private LinearLayout timeline;
    private boolean timelineLoadingPlaceholder;
    private LinearProgressIndicator nativeProgress;
    private SwipeRefreshLayout detailSwipe;
    private TextView statusView;
    private TextView waybillView;
    private LinearLayout hotlineRow;
    private TextView hotlineView;
    private ExpressItem item;
    private ExpressQueryResult previewResult;
    private String previewPhone = "";
    private String previewBindingSource = "interface6";
    private boolean previewPersisted;
    private boolean persistPreviewOnFinish;
    private boolean localRefreshInFlight;
    private int localRefreshGeneration;
    private Runnable localRefreshTimeout;
    private Future<?> localRefreshTask;
    private ExpressQueryCancellation localRefreshCancellation;
    private ExpressRepository.ManualTimelinePollClaim localRefreshClaim;
    private AtomicInteger localRefreshTaskState;
    private boolean restartLocalRefreshOnStart;
    private ExpressQueryCancellation firstManualQueryCancellation;
    private Future<?> firstManualQueryTask;
    private boolean firstManualQueryInFlight;

    static Intent manualQueryIntent(Context context, String waybill, String phone,
            String courierHint, String bindingSource) {
        ExpressQueryResult empty = new ExpressQueryResult(waybill, courierHint, "",
                StatusSemantic.UNKNOWN, "", "", "[]", "", phone, TimelineSlot.V6_QUERY);
        return previewIntent(context, empty, phone, bindingSource)
                .putExtra(EXTRA_MANUAL_QUERY, true)
                .putExtra(EXTRA_MANUAL_COURIER_HINT, courierHint)
                .putExtra(EXTRA_PERSIST_PREVIEW, false)
                .putExtra(EXTRA_TRANSIENT_PICKER_PREVIEW, true);
    }


    public static Intent previewIntent(Context context, ExpressQueryResult result) {
        return previewIntent(context, result, "");
    }

    public static Intent previewIntent(
            Context context, ExpressQueryResult result, String phone) {
        return previewIntent(context, result, phone, "interface6");
    }

    public static Intent previewIntent(
            Context context, ExpressQueryResult result, String phone, String bindingSource) {
        StatusSemantic semantic = result == null || result.semantic == null
                ? StatusSemantic.UNKNOWN : result.semantic;
        return new Intent(context, ExpressDetailActivity.class)
                .putExtra(EXTRA_PREVIEW, true)
                .putExtra(EXTRA_PERSIST_PREVIEW, true)
                .putExtra(EXTRA_WAYBILL, result == null ? "" : result.waybill)
                .putExtra(EXTRA_COURIER, result == null ? "" : result.courierCode)
                .putExtra(EXTRA_COMPANY, result == null ? "" : result.companyName)
                .putExtra(EXTRA_STATUS, semantic.storageCode)
                .putExtra(EXTRA_STATUS_EVENT_TIME,
                        result == null ? 0L : result.statusEventTime)
                .putExtra(EXTRA_TIME, result == null ? "" : result.latestTime)
                .putExtra(EXTRA_DETAIL, result == null ? "" : result.latestDetail)
                .putExtra(EXTRA_TRACKS, result == null ? "[]" : result.tracksJson)
                .putExtra(EXTRA_URL, result == null ? "" : result.detailUrl)
                .putExtra(EXTRA_TIMELINE_PROVIDER,
                        result == null ? "" : result.timelineProvider)
                .putExtra(EXTRA_ROUTE_INTERFACE,
                        result == null ? "" : result.routeInterface)
                .putExtra(EXTRA_ROUTE_CREDENTIAL,
                        result == null ? "" : result.routeCredential)
                .putExtra(EXTRA_PHONE, phone == null ? "" : phone.trim())
                .putExtra(EXTRA_PREVIEW_BINDING_SOURCE,
                        "interface5".equalsIgnoreCase(bindingSource)
                                ? "interface5" : "interface6");
    }

    static Intent persistedPreviewIntent(
            Context context, ExpressQueryResult result, String phone, String bindingSource) {
        return previewIntent(context, result, phone, bindingSource)
                .putExtra(EXTRA_PERSIST_PREVIEW, false)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    static Intent transientPickerPreviewIntent(
            Context context, ExpressQueryResult result, String phone, String bindingSource) {
        return previewIntent(context, result, phone, bindingSource)
                .putExtra(EXTRA_PERSIST_PREVIEW, false)
                .putExtra(EXTRA_TRANSIENT_PICKER_PREVIEW, true)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (getIntent().getBooleanExtra(EXTRA_PREVIEW, false)) {
            persistPreviewOnFinish = getIntent().getBooleanExtra(
                    EXTRA_PERSIST_PREVIEW, false);
            previewResult = previewResult(getIntent());
            previewPhone = getIntent().getStringExtra(EXTRA_PHONE);
            if (previewPhone == null) previewPhone = "";
            previewBindingSource = "interface5".equalsIgnoreCase(
                    getIntent().getStringExtra(EXTRA_PREVIEW_BINDING_SOURCE))
                    ? "interface5" : "interface6";
            item = previewItem(previewResult);
        } else {
            item = ExpressRepository.get(this).find(
                    getIntent().getLongExtra(EXTRA_ROW_ID, 0L));
        }
        if (item == null) {
            finish();
            return;
        }
        boolean transientPickerPreview = getIntent().getBooleanExtra(
                EXTRA_TRANSIENT_PICKER_PREVIEW, false);
        String cainiaoUrl = transientPickerPreview ? "" : safeCainiaoUrl(item);
        // 只打尾号和分支判定，不落完整单号：对照「这一行为什么开了哪一页」。
        me.pipi.deliveries.network.ExpressLog.line(
                detailLogInterface(item), "detail",
                me.pipi.deliveries.network.ExpressLog.source(item.sourceProvider, item.manuallyAdded),
                "started",
                "tail", tailOf(item.displayWaybill()),
                "accountOrder", item.isAccountOrder(),
                "projected", !item.projectedWaybill.isEmpty(),
                "preview", previewResult != null,
                "transient", transientPickerPreview,
                "cainiao", !cainiaoUrl.isEmpty());
        if (!transientPickerPreview && usesInterface5Automatic(item)) {
            showNativeDetail();
            if (!item.semantic.terminal()) refreshLocalTimeline(false);
        } else if (!transientPickerPreview && usesDirectAutomaticH5(item)) {
            String route = cainiaoUrl;
            if (route.isEmpty()) recoverDirectAutomaticRoute();
            else showCainiaoWebDetail(route);
        } else {
                // Native history precedes K100 capture and its visible webpage fallback.
                me.pipi.deliveries.network.ExpressLog.line(
                        detailLogInterface(item), "detail", "", "selected",
                        "tail", tailOf(item.displayWaybill()), "branch", "native");
                showNativeDetail();
                if (getIntent().getBooleanExtra(EXTRA_MANUAL_QUERY, false)) {
                    startFirstManualQuery();
                } else if (previewResult != null) {
                    ensureKuaidi100Presentation(previewResult, "preview");
                }
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { navigateBack(); }
        });
    }

    @Override protected void onStop() {
        cancelFirstManualQuery();
        if (directRouteCancellation != null) directRouteCancellation.cancel();
        directRouteCancellation = null;
        if (localRefreshInFlight) {
            cancelLocalTimelineRefresh(localRefreshGeneration, !isFinishing());
        } else {
            setLocalRefreshProgressVisible(false);
        }
        if (detailSwipe != null) detailSwipe.setRefreshing(false);
        super.onStop();
    }

    @Override protected void onStart() {
        super.onStart();
        if (usesDirectAutomaticH5(item) && webView == null && directRouteCancellation == null)
            recoverDirectAutomaticRoute();
        if (restartLocalRefreshOnStart) {
            restartLocalRefreshOnStart = false;
            restartLocalTimelineRefreshIfNeeded();
        }
    }

    private void startFirstManualQuery() {
        if (firstManualQueryInFlight || previewResult == null) return;
        String waybill = previewResult.waybill;
        String bindingSource = previewBindingSource;
        String suppliedPhone = previewPhone;
        ExpressQueryCancellation cancellation = new ExpressQueryCancellation(LOCAL_REFRESH_TIMEOUT_MS);
        firstManualQueryCancellation = cancellation;
        firstManualQueryInFlight = true;
        detailSwipe.setEnabled(false);
        if (Kuaidi100TimelinePolicy.hasTimedTracking(previewResult)) {
            renderFirstManualResult(previewResult);
        } else {
            renderTimelineLoading();
            setLocalRefreshProgressVisible(true);
        }
        firstManualQueryTask = worker.submit(() -> {
            AtomicReference<String> courierHint = new AtomicReference<>(
                    getIntent().getStringExtra(EXTRA_MANUAL_COURIER_HINT));
            try {
                ExpressRepository repository = ExpressRepository.get(this);
                ExpressItem existing = repository.findByWaybill(waybill, bindingSource);
                ExpressRepository.ManualQueryOwnerClaim ownerClaim = existing == null
                        ? null : repository.captureManualQueryOwner(existing);
                courierHint.set(ExpressListActivity.manualQueryRawCarrierHint(
                        courierHint.get(), existing == null ? "" : existing.courierCode));
                ExpressApi manualApi = new ExpressApi(getApplicationContext());
                ExpressSubscriptionClient meizuApi = new ExpressSubscriptionClient();
                ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryPickerFirst(
                        () -> meizuApi.queryManual(getApplicationContext(), waybill, cancellation),
                        existing == null ? null : repository.manualTimelineCandidate(
                                existing, TimelineSlot.V6_QUERY),
                        () -> {
                            if (courierHint.get().isEmpty()) {
                                courierHint.set(manualApi.detect(waybill, cancellation));
                            }
                            return manualApi.queryMoto(waybill, courierHint.get(), cancellation);
                        }, ManualQueryRoutingPolicy.includesMoto(existing), null,
                        partial -> publishFirstManualPreview(partial, cancellation), true);
                cancellation.throwIfCancelled();
                ExpressQueryResult selected = firstManualResult(batch.successes, batch.detailSelected());
                if (selected == null) throw new IllegalStateException("暂无轨迹");
                String phone = !selected.phone.isEmpty() ? selected.phone
                        : !suppliedPhone.isEmpty() ? suppliedPhone
                        : existing == null ? "" : existing.phone;
                List<ManualQuerySuccess> writes = new ArrayList<>(batch.successes);
                String route = kuaidi100AddCaptureRoute(waybill, batch.successes);
                if (!route.isEmpty()) {
                    ExpressQueryResult captured = captureKuaidi100ForAddChain(
                            waybill, route, selected, phone, cancellation);
                    cancellation.throwIfCancelled();
                    if (captured != null) {
                        writes.add(new ManualQuerySuccess(
                                TimelineSlot.K100_H5, captured, System.currentTimeMillis(), false));
                        selected = firstManualResult(writes, selected);
                        publishFirstManualPreview(selected, cancellation);
                    }
                }
                cancellation.throwIfCancelled();
                ExpressQueryResult result = selected;
                // The UI owner serializes leaving the page with the single durable commit.
                runOnUiThread(() -> {
                    if (!firstManualQueryIsCurrent(cancellation)) {
                        if (cancellation.isCancelled()) failFirstManualQuery(
                                new InterruptedException("Manual query expired"),
                                waybill, courierHint.get(), cancellation);
                        return;
                    }
                    try {
                        ExpressItem saved = repository.saveManualQueryBatch(
                                existing, ownerClaim, writes, phone, bindingSource);
                        if (!Kuaidi100TimelinePolicy.hasTimedTracking(result)
                                && repository.enqueuePendingManual(result, phone, bindingSource)) {
                            ExpressScheduler.ensureScheduled(this);
                        }
                        finishFirstManualQuery();
                        renderFirstManualResult(result);
                        if (saved != null) item = saved;
                        setResult(RESULT_OK);
                        Toast.makeText(this, Kuaidi100TimelinePolicy.hasRealTracking(result)
                                ? ExpressToastCopy.MANUAL_QUERY_SUCCEEDED
                                : ExpressToastCopy.MANUAL_QUERY_NO_TRACK, Toast.LENGTH_SHORT).show();
                    } catch (RuntimeException failure) {
                        failFirstManualQuery(failure, waybill, courierHint.get(), cancellation);
                    }
                });
            } catch (Exception failure) {
                runOnUiThread(() -> failFirstManualQuery(
                        failure, waybill, courierHint.get(), cancellation));
            }
        });
    }

    private boolean firstManualQueryIsCurrent(ExpressQueryCancellation cancellation) {
        return firstManualQueryInFlight && firstManualQueryCancellation == cancellation
                && !cancellation.isCancelled() && !isFinishing() && !isDestroyed()
                && previewBindingSource.equals(ExpressAccountSource.bindingSource(this));
    }

    private void publishFirstManualPreview(
            ExpressQueryResult result, ExpressQueryCancellation cancellation) {
        if (!Kuaidi100TimelinePolicy.hasTimedTracking(result)) return;
        runOnUiThread(() -> {
            if (firstManualQueryIsCurrent(cancellation)) renderFirstManualResult(result);
        });
    }

    static ExpressQueryResult firstManualResult(
            List<? extends ManualQuerySuccess> successes, ExpressQueryResult fallback) {
        ArrayList<ManualTimelineAuthorityPolicy.Candidate> candidates = new ArrayList<>();
        for (ManualQuerySuccess success : successes) {
            candidates.add(new ManualTimelineAuthorityPolicy.Candidate(
                    success.provider, success.result, success.successAt, success.complete));
        }
        ManualTimelineAuthorityPolicy.Candidate selected = ManualTimelineAuthorityPolicy.selectDetail(candidates);
        return ManualTimelineAuthorityPolicy.presentationResult(
                selected == null ? fallback : selected.result, candidates);
    }

    private void renderFirstManualResult(ExpressQueryResult result) {
        previewResult = result;
        item = previewItem(result);
        renderHeader(item.displayCourierCode(), item.displayCompany(), item.displayWaybill(),
                item.displayStatus(), item.semantic);
        renderTimeline(ExpressTimeline.parse(result.tracksJson, result.latestTime, result.latestDetail));
        boolean loading = firstManualQueryInFlight
                && !ManualTimelineAuthorityPolicy.detailTimelineComplete(result, 0L);
        setLocalRefreshProgressVisible(loading);
        if (loading) appendTimelineLoading(R.string.loading_complete_logistics);
    }

    private void failFirstManualQuery(Exception failure, String waybill,
            String courierHint, ExpressQueryCancellation cancellation) {
        if (firstManualQueryCancellation != cancellation || !firstManualQueryInFlight
                || isFinishing() || isDestroyed()) return;
        if (cancellation.isCancelled()) {
            finishFirstManualQuery();
            renderFirstManualResult(previewResult);
            Toast.makeText(this, ExpressToastCopy.MANUAL_QUERY_TIMEOUT, Toast.LENGTH_SHORT).show();
            return;
        }
        finishFirstManualQuery();
        renderFirstManualResult(previewResult);
        if (failure instanceof ExpressApi.QueryException
                && ((ExpressApi.QueryException) failure).needsPhoneTail()) {
            setResult(RESULT_PHONE_TAIL_REQUIRED, new Intent()
                    .putExtra(EXTRA_RETRY_WAYBILL, waybill)
                    .putExtra(EXTRA_RETRY_COURIER, courierHint)
                    .putExtra(EXTRA_RETRY_MISMATCH,
                            ((ExpressApi.QueryException) failure).phoneTailMismatch()));
            finish();
            return;
        }
        if (ExpressRepository.get(this).enqueuePendingManual(waybill, previewPhone, previewBindingSource)) {
            ExpressScheduler.ensureScheduled(this);
        }
        Toast.makeText(this, "暂无轨迹".equals(failure.getMessage())
                ? ExpressToastCopy.MANUAL_QUERY_NO_TRACK
                : ExpressToastCopy.MANUAL_QUERY_FAILED, Toast.LENGTH_SHORT).show();
        if (!Kuaidi100TimelinePolicy.hasTimedTracking(previewResult)) finish();
    }

    private void finishFirstManualQuery() {
        firstManualQueryInFlight = false;
        firstManualQueryCancellation = null;
        firstManualQueryTask = null;
        if (detailSwipe != null) {
            detailSwipe.setRefreshing(false);
            detailSwipe.setEnabled(true);
        }
        setLocalRefreshProgressVisible(false);
    }

    private void cancelFirstManualQuery() {
        if (!firstManualQueryInFlight) return;
        firstManualQueryCancellation.cancel();
        if (firstManualQueryTask != null) firstManualQueryTask.cancel(true);
        cancelAddChainCapture();
        finishFirstManualQuery();
        if (previewResult != null && timeline != null) renderFirstManualResult(previewResult);
    }

    private ExpressKuaidi100TimelineCapture addChainCapture;

    /** The existing add-chain stage opens the actual waybill only while start evidence is absent. */
    static String kuaidi100AddCaptureRoute(
            String waybill, List<? extends ManualQuerySuccess> successes) {
        if (successes == null) return "";
        for (ManualQuerySuccess success : successes) {
            if (success == null || success.result == null) continue;
            if (Kuaidi100TimelinePolicy.hasTimelineStart(success.result)) return "";
        }
        return ManualRoutePolicy.kuaidi100QueryUrl(waybill);
    }

    /** 在工作线程里同步等隐藏 WebView 抓完（最多 8 秒 + 1 秒），抓到就组成 K100 槽的包。 */
    private ExpressQueryResult captureKuaidi100ForAddChain(
            String waybill, String route, ExpressQueryResult selected, String phone,
            ExpressQueryCancellation cancellation) throws InterruptedException {
        long now = System.currentTimeMillis();
        String tail = waybill.length() <= 4 ? waybill : waybill.substring(waybill.length() - 4);
        if (!ExpressKuaidi100CaptureCooldown.due(this, waybill, now)) {
            ExpressLog.line("", "k100_h5", "manual", "skipped",
                    "tail", tail, "reason", "cooldown");
            return null;
        }
        ExpressKuaidi100CaptureCooldown.record(this, waybill, now);
        ExpressLog.line("", "k100_h5", "manual", "started", "tail", tail, "reason", "add_chain");
        java.util.concurrent.CountDownLatch finished = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<String> tracks =
                new java.util.concurrent.atomic.AtomicReference<>("");
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed() || cancellation.isCancelled()) {
                finished.countDown();
                return;
            }
            ExpressKuaidi100TimelineCapture capture = new ExpressKuaidi100TimelineCapture(
                    this, route, waybill, phone, (done, tracksJson) -> {
                        if (addChainCapture == done) addChainCapture = null;
                        tracks.set(tracksJson == null ? "" : tracksJson);
                        finished.countDown();
                    });
            addChainCapture = capture;
            if (!capture.start()) {
                addChainCapture = null;
                finished.countDown();
            }
        });
        boolean completed;
        try {
            completed = finished.await(
                    ExpressKuaidi100TimelineCapture.CAPTURE_TIMEOUT_MS + 1_000L,
                    java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            runOnUiThread(this::cancelAddChainCapture);
            throw interrupted;
        }
        if (!completed) runOnUiThread(this::cancelAddChainCapture);
        ExpressQueryResult captured = ExpressDetailActivity.kuaidi100CapturedResult(
                waybill, selected.courierCode, selected.companyName, phone, tracks.get());
        int nodes = Kuaidi100TimelinePolicy.timedTrackCount(captured);
        if (nodes == 0) {
            ExpressLog.line("", "k100_h5", "manual", "failed",
                    "tail", tail, "reason", "no_tracks",
                    "elapsedMs", System.currentTimeMillis() - now);
            return null;
        }
        ExpressLog.line("", "k100_h5", "manual", "succeeded",
                "tail", tail, "nodes", nodes,
                "start", Kuaidi100TimelinePolicy.hasTimelineStart(captured),
                "elapsedMs", System.currentTimeMillis() - now);
        return captured;
    }

    private void cancelAddChainCapture() {
        if (addChainCapture != null) {
            addChainCapture.cancel();
            addChainCapture = null;
        }
    }


    private void showNativeDetail() {
        setContentView(R.layout.activity_express_detail);
        applySystemBarInsets(findViewById(R.id.express_detail_root));
        MaterialToolbar toolbar = findViewById(R.id.detail_toolbar);
        toolbar.setNavigationOnClickListener(view -> finish());
        ImageView icon = findViewById(R.id.detail_icon);
        icon.setImageResource(item.displayIconResource());
        statusView = findViewById(R.id.detail_status);
        waybillView = findViewById(R.id.detail_waybill);
        timeline = findViewById(R.id.timeline);
        nativeProgress = findViewById(R.id.detail_progress);
        detailSwipe = findViewById(R.id.detail_swipe);
        ExpressPullRefreshStyle.apply(detailSwipe);
        detailSwipe.setOnRefreshListener(() -> {
            if (getIntent().getBooleanExtra(EXTRA_MANUAL_QUERY, false) && item.rowId == 0L) {
                startFirstManualQuery();
                return;
            }
            // 下拉结果 toast（AGENTS §11 统一表）：按这次手势前后页面上的轨迹判定。
            pullRefreshRequested = true;
            localRefreshFailed = false;
            pullRefreshBaseline = renderedTimelineSignature;
            refreshLocalTimeline(false);
        });
        hotlineRow = findViewById(R.id.detail_hotline);
        hotlineView = findViewById(R.id.detail_hotline_value);
        renderHeader(item.displayCourierCode(), item.displayCompany(), item.displayWaybill(),
                item.displayStatus(), item.semantic);
        if (previewResult != null) {
            renderTimeline(ExpressTimeline.parse(
                    previewResult.tracksJson,
                    previewResult.latestTime,
                    previewResult.latestDetail));
        } else {
            ExpressRepository repository = ExpressRepository.get(this);
            if (renderInterface5AccountTimeline(repository)) {
                if (item.semantic == StatusSemantic.UNKNOWN) refreshLocalTimeline(false);
                return;
            }
            if (renderManualTimelineAuthority(repository, true)) {
                // 进详情先跑一次 Meizu 增量（已完整时 refreshLocalTimeline 自己按 complete_cache 跳过），
                // 跑完由 ensureKuaidi100Presentation 决定要不要抓 K100 页、要不要开网页。
                refreshLocalTimeline(false);
                return;
            }
            String timelineWaybill = item.displayWaybill();
            String accountSource = accountTimelineSource(item);
            String accountWaybill = accountTimelineWaybill(item);
            boolean v4Owner = v4TimelineOwnsItem(item);
            ExpressQueryResult accountTimeline = accountSource.isEmpty()
                    ? null : accountTimelineFor(repository, item, accountWaybill, accountSource);
            boolean accountTimelineUsable = accountTimelineUsable(item, accountTimeline);
            ExpressQueryResult publicTimeline = v4Owner
                    ? repository.v4Timeline(timelineWaybill) : null;
            boolean publicTimelineUsable =
                    Kuaidi100TimelinePolicy.hasRealTracking(publicTimeline);
            String itemProvider = !accountSource.isEmpty()
                    ? TimelineSlot.forBindingSource(accountSource)
                    : v4Owner ? TimelineSlot.V4_QUERY : TimelineSlot.K100_H5;
            ExpressQueryResult initial = itemResult(
                    item, accountSource.isEmpty() ? timelineWaybill : accountWaybill,
                    itemProvider);
            boolean initialUsable = Kuaidi100TimelinePolicy.hasRealTracking(initial);
            boolean persistPublicInitial = false;
            boolean persistLocalInitial = false;
            if (!accountTimelineUsable && !accountSource.isEmpty() && initialUsable
                    && !item.isInterface5ProjectedOrder()) {
                // 行上自己的节点（feed）只拿来展示，不写进账号 sidecar——那张表只装 query 包
                //（用户定 2026-09-05 晚：feed 增量与 query 独立，不拼接）。
                accountTimeline = initial;
                accountTimelineUsable = true;
            }
            if (!publicTimelineUsable && v4Owner && initialUsable) {
                publicTimeline = initial;
                publicTimelineUsable = true;
                persistPublicInitial = true;
            }
            ExpressQueryResult kuaidi100Timeline = repository.kuaidi100Timeline(timelineWaybill);
            if (kuaidi100Timeline == null && accountSource.isEmpty() && !v4Owner
                    && localTimelineOwnsItem(item) && initialUsable) {
                kuaidi100Timeline = initial;
                persistLocalInitial = true;
            }
            ExpressQueryResult cached = preferredDetailTimeline(
                    accountTimelineUsable ? accountTimeline : null,
                    publicTimeline, kuaidi100Timeline);
            boolean cachedUsable = Kuaidi100TimelinePolicy.hasRealTracking(cached);
            InitialTimelinePresentation presentation = initialTimelinePresentation(
                    cachedUsable, false);
            if (presentation == InitialTimelinePresentation.TRACKS) {
                renderTimeline(ExpressTimeline.parse(
                        cached.tracksJson, cached.latestTime, cached.latestDetail));
            } else if (presentation == InitialTimelinePresentation.LOADING) {
                renderTimelineLoading();
            } else {
                renderTimeline(java.util.Collections.emptyList());
            }
            persistInitialTimelineAsync(repository, initial,
                    persistPublicInitial, persistLocalInitial);
        }
    }

    private void persistInitialTimelineAsync(
            ExpressRepository repository, ExpressQueryResult initial,
            boolean persistPublic, boolean persistLocal) {
        if (!persistPublic && !persistLocal) return;
        try {
            worker.execute(() -> {
                try {
                    if (persistPublic) repository.saveV4Timeline(initial);
                    if (persistLocal) repository.saveKuaidi100Timeline(initial);
                } catch (Throwable ignored) {
                    // The already rendered owner timeline remains available for a later retry.
                }
            });
        } catch (RejectedExecutionException ignored) {
            // Activity teardown may reject this best-effort cache write.
        }
    }

    private void restartLocalTimelineRefreshIfNeeded() {
        if (previewResult != null || nativeProgress == null || item == null
                || !canRefreshLocalTimeline(item)) return;
        ExpressRepository repository = ExpressRepository.get(this);
        if (renderInterface5AccountTimeline(repository)) {
            if (item.semantic == StatusSemantic.UNKNOWN) refreshLocalTimeline(false);
            return;
        }
        if (renderManualTimelineAuthority(repository, false)) return;
        String waybill = item.displayWaybill();
        String accountSource = accountTimelineSource(item);
        ExpressQueryResult accountTimeline = accountSource.isEmpty()
                ? null : accountTimelineFor(
                        repository, item, accountTimelineWaybill(item), accountSource);
        boolean accountTimelineUsable = accountTimelineUsable(item, accountTimeline);
        boolean v4Owner = v4TimelineOwnsItem(item);
        ExpressQueryResult publicTimeline = v4Owner
                ? repository.v4Timeline(waybill) : null;
        boolean publicTimelineUsable =
                Kuaidi100TimelinePolicy.hasRealTracking(publicTimeline);
        ExpressQueryResult cached = preferredDetailTimeline(
                accountTimelineUsable ? accountTimeline : null,
                publicTimeline, repository.kuaidi100Timeline(waybill));
        boolean cachedUsable = Kuaidi100TimelinePolicy.hasRealTracking(cached);
        ExpressQueryResult initial = itemResult(
                item, accountSource.isEmpty() ? waybill : accountTimelineWaybill(item),
                !accountSource.isEmpty() ? TimelineSlot.forBindingSource(accountSource)
                        : v4Owner ? TimelineSlot.V4_QUERY : TimelineSlot.K100_H5);
        ExpressQueryResult ownerTimeline = !accountSource.isEmpty()
                ? accountTimeline : v4Owner ? publicTimeline : initial;
        boolean refreshDue = needsManualSupplement(item, ownerTimeline, cached);
        if (cachedUsable) {
            rememberDisplayedProvider(cached.timelineProvider);
            renderTimeline(ExpressTimeline.parse(
                    cached.tracksJson, cached.latestTime, cached.latestDetail));
        } else if (refreshDue) {
            renderTimelineLoading();
        } else {
            renderTimeline(java.util.Collections.emptyList());
        }
        if (refreshDue) {
            refreshLocalTimeline(!cachedUsable);
        }
    }

    /** Keeps detail rendering on the same selected manual package as every other surface. */
    private boolean renderManualTimelineAuthority(
            ExpressRepository repository, boolean force) {
        boolean sharedSource = usesSharedManualTimeline(item);
        if (!sharedSource && !manualTimelineOwnsDetail(item)) return false;
        ManualTimelineAuthorityPolicy.Candidate detailAuthority =
                repository.manualDetailTimelineAuthority(item);
        ExpressQueryResult detailResult = detailAuthority == null
                ? null : detailAuthority.result;
        rememberDisplayedProvider(detailAuthority == null
                ? ManualTimelineAuthorityPolicy.PREFERRED_FEED : detailAuthority.provider);
        renderTimeline(ExpressTimeline.parse(
                detailResult == null ? item.tracksJson : detailResult.tracksJson,
                detailResult == null ? item.latestTime : detailResult.latestTime,
                detailResult == null ? item.latestDetail : detailResult.latestDetail));
        return true;
    }

    static boolean manualTimelineOwnsDetail(ExpressItem value) {
        return value != null && value.hasManualTimelineAuthority();
    }

    static boolean usesSharedManualTimeline(ExpressItem value) {
        return canRefreshLocalTimeline(value) && value.usesSourceManualTakeover()
                && (!value.isAccountOrder() || !value.projectedWaybill.isEmpty());
    }

    /** Reuse the fixed K100 page and this parcel's saved phone when its local history is incomplete. */
    private void ensureKuaidi100Presentation(ExpressQueryResult localDetail, String reason) {
        if (item == null || usesInterface5Automatic(item)
                || isFinishing() || isDestroyed() || webView != null) return;
        String route = kuaidi100FallbackUrl();
        if (route.isEmpty()) return;
        String tail = tailOf(item.displayWaybill());
        if (timelineComplete(localDetail)) {
            me.pipi.deliveries.network.ExpressLog.line(
                    "", "k100_h5", "manual", "skipped",
                    "tail", tail, "reason", "local_complete");
            return;
        }
        if (kuaidi100Capture != null) return;
        ExpressItem target = item;
        long startedAt = System.currentTimeMillis();
        // K100 结果页同一运单 30 分钟一次是快递100 上游自己的限制（iOS/Pipi 那一级同一冷却）；
        // 冷却内不再抓，直接按兜底开网页。
        if (!ExpressKuaidi100CaptureCooldown.due(this, target.displayWaybill(), startedAt)) {
            me.pipi.deliveries.network.ExpressLog.line(
                    "", "k100_h5", "manual", "skipped", "tail", tail, "reason", "cooldown");
            showKuaidi100WebDetail(route);
            return;
        }
        ExpressKuaidi100CaptureCooldown.record(this, target.displayWaybill(), startedAt);
        me.pipi.deliveries.network.ExpressLog.line(
                "", "k100_h5", "manual", "started", "tail", tail, "reason", reason);
        ExpressKuaidi100TimelineCapture capture = new ExpressKuaidi100TimelineCapture(
                this, route, target.displayWaybill(), target.phone, (finished, tracksJson) -> {
                    if (kuaidi100Capture != finished) return;
                    kuaidi100Capture = null;
                    if (isFinishing() || isDestroyed() || item == null
                            || item.rowId != target.rowId || webView != null) return;
                    long elapsed = System.currentTimeMillis() - startedAt;
                    ExpressQueryResult captured = kuaidi100CapturedResult(target, tracksJson);
                    int nodes = Kuaidi100TimelinePolicy.timedTrackCount(captured);
                    if (nodes == 0) {
                        me.pipi.deliveries.network.ExpressLog.line(
                                "", "k100_h5", "manual", "failed",
                                "tail", tail, "reason", "no_tracks", "elapsedMs", elapsed);
                        showKuaidi100WebDetail(route);
                        return;
                    }
                    boolean complete = timelineComplete(captured);
                    if (complete) {
                        me.pipi.deliveries.network.ExpressLog.line(
                                "", "k100_h5", "manual", "succeeded",
                                "tail", tail, "nodes", nodes, "elapsedMs", elapsed);
                    } else {
                        // 抓到了却没到起点：记最早一条的前几个字，对照页面到底缺的是哪一段
                        // （Fold7 2026-09-05 EMS：页 20 条 vs v4_query 22 条，少的正是收寄那两条）。
                        me.pipi.deliveries.network.ExpressLog.line(
                                "", "k100_h5", "manual", "failed",
                                "tail", tail, "reason", "incomplete",
                                "nodes", nodes, "elapsedMs", elapsed,
                                "earliest", earliestTrackHead(captured));
                    }
                    persistKuaidi100Capture(target, captured, complete);
                    if (!complete) showKuaidi100WebDetail(route);
                });
        kuaidi100Capture = capture;
        if (!capture.start()) {
            kuaidi100Capture = null;
            me.pipi.deliveries.network.ExpressLog.line(
                    "", "k100_h5", "manual", "failed",
                    "tail", tail, "reason", "capture_unavailable");
            showKuaidi100WebDetail(route);
        }
    }

    /** 抓到的节点按本件的 K100 槽落库；完整时再按详情权威重新渲染。 */
    private void persistKuaidi100Capture(
            ExpressItem target, ExpressQueryResult captured, boolean complete) {
        String owner = target.stateOwner.isEmpty() ? target.source : target.stateOwner;
        String bindingSource = ExpressAccountSource.bindingSourceForOwner(owner);
        try {
            worker.execute(() -> {
                ExpressRepository repository = ExpressRepository.get(this);
                try {
                    repository.saveOwnerManualTimeline(
                            target, captured, target.phone, bindingSource, System.currentTimeMillis(), complete);
                } catch (Throwable failure) {
                    Log.w(MANUAL_LOG_TAG, "K100 capture persist failed rowId="
                            + target.rowId + " error=" + failure.getClass().getSimpleName());
                }
                if (!complete) return;
                ExpressItem refreshedOwner = repository.find(target.rowId);
                ManualTimelineAuthorityPolicy.Candidate authority = refreshedOwner == null
                        ? null : repository.manualDetailTimelineAuthority(refreshedOwner);
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed() || item == null
                            || item.rowId != target.rowId || webView != null
                            || statusView == null) return;
                    if (refreshedOwner != null) item = refreshedOwner;
                    ImageView icon = findViewById(R.id.detail_icon);
                    if (icon != null) icon.setImageResource(item.displayIconResource());
                    renderHeader(item.displayCourierCode(), item.displayCompany(),
                            item.displayWaybill(), item.displayStatus(), item.semantic);
                    ExpressQueryResult detail = authority == null ? captured : authority.result;
                    rememberDisplayedProvider(
                            authority == null ? TimelineSlot.K100_H5 : authority.provider);
                    renderTimeline(ExpressTimeline.parse(
                            detail.tracksJson, detail.latestTime, detail.latestDetail));
                });
            });
        } catch (RejectedExecutionException ignored) {
        }
    }

    /** 最早一条节点的前 24 个字（只用于日志对照，不落单号/手机号之外的东西）。 */
    private static String earliestTrackHead(ExpressQueryResult result) {
        if (result == null) return "";
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(result.tracksJson, "", "");
        if (tracks.isEmpty()) return "";
        ExpressTimeline.Track earliest = tracks.get(tracks.size() - 1);
        String detail = earliest.detail == null ? "" : earliest.detail.replaceAll("\\s+", " ");
        return earliest.time + " " + detail.substring(0, Math.min(detail.length(), 24));
    }

    /** 「完整轨迹」= 有带时间的节点，且到了起点（揽收或下单，与 needsManualSupplement 同判据）。 */
    static boolean timelineComplete(ExpressQueryResult result) {
        return Kuaidi100TimelinePolicy.hasTimedTracking(result)
                && Kuaidi100TimelinePolicy.hasTimelineStart(result);
    }

    /** 抓到的节点只是轨迹，状态仍按结构化来源（picker / v4_query）给，与三端「状态看结构化」一致。 */
    static ExpressQueryResult kuaidi100CapturedResult(ExpressItem owner, String tracksJson) {
        if (owner == null) return null;
        return kuaidi100CapturedResult(
                owner.displayWaybill(), owner.displayCourierCode(), owner.displayCompany(),
                owner.phone, tracksJson);
    }

    /** 加件链也用这一份：行还没建时按 picker/v4 给的承运商身份组包。 */
    static ExpressQueryResult kuaidi100CapturedResult(
            String waybill, String courierCode, String companyName, String phone,
            String tracksJson) {
        if (waybill == null || waybill.isEmpty() || tracksJson == null || tracksJson.isEmpty()) {
            return null;
        }
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(tracksJson, "", "");
        if (tracks.isEmpty()) return null;
        ExpressTimeline.Track latest = tracks.get(0);
        return new ExpressQueryResult(
                waybill, courierCode == null ? "" : courierCode,
                companyName == null ? "" : companyName,
                StatusSemantic.UNKNOWN, latest.time, latest.detail, tracksJson,
                "", phone == null ? "" : phone, TimelineSlot.K100_H5, "", "", "");
    }

    private String kuaidi100FallbackUrl() {
        ExpressRepository repository = ExpressRepository.get(this);
        ExpressItem owner = item;
        if (previewResult != null) {
            ExpressItem persisted = repository.findByWaybill(
                    previewResult.waybill, previewBindingSource);
            if (persisted != null) owner = persisted;
        }
        if (!allowsKuaidi100Route(owner, previewResult)) return "";
        return ManualRoutePolicy.kuaidi100QueryUrl(owner == null
                ? previewResult == null ? "" : previewResult.waybill : owner.displayWaybill());
    }

    private void showCainiaoWebDetail(String detailUrl) {
        setContentView(R.layout.activity_express_web);
        applySystemBarInsets(findViewById(R.id.express_web_root));
        MaterialToolbar toolbar = findViewById(R.id.web_toolbar);
        toolbar.setTitle(item.displayCompany());
        toolbar.setNavigationOnClickListener(view -> navigateBack());
        ProgressBar progress = findViewById(R.id.web_progress);
        webView = findViewById(R.id.web_view);
        configureWebView(webView);
        int pageSurface = MaterialColors.getColor(webView,
                com.google.android.material.R.attr.colorSurface);
        webView.setBackgroundColor(pageSurface);
        // Keep the provider page hidden until its white/translucent roots have been replaced
        // with this activity's Material dynamic surface. This avoids both a white flash in dark
        // mode and an untinted white page when wallpaper colors are active in light mode.
        webView.setVisibility(View.INVISIBLE);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        String localLogo = courierLogoDataUri(item);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(
                    WebView view, WebResourceRequest request) {
                boolean blocked = request == null || !allowed(request.getUrl());
                if (blocked && (request == null || request.isForMainFrame())) {
                    fallbackWebDetailToNative(view, progress);
                }
                return blocked;
            }

            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                revealCainiaoPageOrFallback(
                        view, url, localLogo, pageSurface, progress);
            }

            @Override public void onReceivedError(
                    WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request == null || request.isForMainFrame()) {
                    fallbackWebDetailToNative(view, progress);
                }
            }

            @Override public void onReceivedHttpError(
                    WebView view, WebResourceRequest request, WebResourceResponse response) {
                super.onReceivedHttpError(view, request, response);
                if (request == null || request.isForMainFrame()) {
                    fallbackWebDetailToNative(view, progress);
                }
            }

            @Override public boolean onRenderProcessGone(
                    WebView view, RenderProcessGoneDetail detail) {
                return handleRenderProcessGone(view, progress, true, detail);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });
        webView.loadUrl(detailUrl);
        webView.postDelayed(() -> {
            if (isCurrentDetailWebView(webView)
                    && webView.getVisibility() != View.VISIBLE) {
                fallbackWebDetailToNative(webView, progress);
            }
        }, 12_000L);
    }

    /** Opens Picker's K100 route without treating it as a source-owned route atom. */
    private void showKuaidi100WebDetail(String detailUrl) {
        pullRefreshRequested = false;
        setContentView(R.layout.activity_express_web);
        applySystemBarInsets(findViewById(R.id.express_web_root));
        MaterialToolbar toolbar = findViewById(R.id.web_toolbar);
        toolbar.setTitle(item.displayCompany());
        toolbar.setNavigationOnClickListener(view -> navigateBack());
        ProgressBar progress = findViewById(R.id.web_progress);
        webView = findViewById(R.id.web_view);
        configureWebView(webView);
        int pageSurface = MaterialColors.getColor(webView,
                com.google.android.material.R.attr.colorSurface);
        webView.setBackgroundColor(pageSurface);
        webView.setVisibility(View.INVISIBLE);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(
                    WebView view, WebResourceRequest request) {
                boolean blocked = request == null
                        || safeKuaidi100Url(request.getUrl().toString()).isEmpty();
                if (blocked && (request == null || request.isForMainFrame())) {
                    fallbackWebDetailToNative(view, progress);
                }
                return blocked;
            }

            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                revealWebView(view, progress);
            }

            @Override public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                revealWebView(view, progress);
            }

            @Override public void onReceivedError(
                    WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request == null || request.isForMainFrame()) {
                    fallbackWebDetailToNative(view, progress);
                }
            }

            @Override public void onReceivedHttpError(
                    WebView view, WebResourceRequest request, WebResourceResponse response) {
                super.onReceivedHttpError(view, request, response);
                if (request == null || request.isForMainFrame()) {
                    fallbackWebDetailToNative(view, progress);
                }
            }

            @Override public boolean onRenderProcessGone(
                    WebView view, RenderProcessGoneDetail detail) {
                return handleRenderProcessGone(view, progress, true, detail);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });
        webView.loadUrl(detailUrl);
        webView.postDelayed(() -> {
            if (isCurrentDetailWebView(webView)
                    && webView.getVisibility() != View.VISIBLE) {
                fallbackWebDetailToNative(webView, progress);
            }
        }, 12_000L);
    }

    private void revealCainiaoPageOrFallback(
            WebView view, String url, String localLogo,
            int pageSurface, ProgressBar progress) {
        if (!isCurrentDetailWebView(view)) return;
        view.evaluateJavascript(
                "(function(){var b=document.body;if(!b)return false;"
                        + "var t=(b.innerText||'').trim();"
                        + "return t.length>0||!!b.querySelector('img,svg,canvas,video');})()",
                value -> {
                    if (!isCurrentDetailWebView(view)) return;
                    if (!"true".equals(value)) {
                        fallbackWebDetailToNative(view, progress);
                        return;
                    }
                    decorateCainiaoPage(view, url, localLogo,
                            pageSurface, () -> revealWebView(view, progress));
                });
    }

    private static void revealWebView(WebView view, ProgressBar progress) {
        if (view != null) view.setVisibility(View.VISIBLE);
        if (progress != null) progress.setVisibility(View.GONE);
    }

    /** A provider H5 is presentation-only; failure must preserve the local owner package. */
    private void fallbackWebDetailToNative(WebView failed, ProgressBar progress) {
        if (failed == null || failed != webView || webNativeFallbackStarted
                || isFinishing() || isDestroyed()) return;
        if (usesDirectAutomaticH5(item)) {
            webNativeFallbackStarted = true;
            if (progress != null) progress.setVisibility(View.GONE);
            Toast.makeText(this, ExpressToastCopy.H5_UNAVAILABLE, Toast.LENGTH_SHORT).show();
            finish();
            return;
        }
        fallbackWebDetail(failed, progress);
    }

    private void fallbackWebDetail(
            WebView failed, ProgressBar progress) {
        if (webNativeFallbackStarted || failed == null || failed != webView
                || isFinishing() || isDestroyed()) return;
        webNativeFallbackStarted = true;
        webView = null;
        if (progress != null) progress.setVisibility(View.GONE);
        failed.stopLoading();
        ViewGroup parent = (ViewGroup) failed.getParent();
        if (parent != null) parent.removeView(failed);
        failed.destroy();
        showNativeDetail();
    }

    private boolean handleRenderProcessGone(
            WebView crashed, ProgressBar progress, boolean closeDetail,
            RenderProcessGoneDetail detail) {
        Log.w(ORDER_LOG_TAG, "WebView renderer exited; crashed="
                + (detail != null && detail.didCrash()));
        boolean detailWeb = crashed == webView;
        if (closeDetail && detailWeb && !isFinishing() && !isDestroyed()) {
            fallbackWebDetailToNative(crashed, progress);
            return true;
        }
        if (detailWeb) webView = null;
        if (progress != null) progress.setVisibility(View.GONE);
        ViewGroup parent = crashed == null ? null : (ViewGroup) crashed.getParent();
        if (parent != null) parent.removeView(crashed);
        if (crashed != null) crashed.destroy();
        return true;
    }

    private void refreshLocalTimeline(boolean showProgress) {
        if (item == null || !canRefreshLocalTimeline(item)) {
            if (detailSwipe != null) detailSwipe.setRefreshing(false);
            announcePullRefreshOutcome();
            return;
        }
        // Complete history freezes refresh except while a ShunFeng parcel is still active.
        if (shouldSkipCompleteCache(item, currentDetailComplete(item))) {
            me.pipi.deliveries.network.ExpressLog.line(
                    detailLogInterface(item), "detail", "", "skipped",
                    "tail", tailOf(item.displayWaybill()), "reason", "complete_cache");
            if (detailSwipe != null) detailSwipe.setRefreshing(false);
            announcePullRefreshOutcome();
            return;
        }
        refreshLocalTimeline(showProgress, null);
    }

    /** SF's unchanged coarse feed cannot prove an active parcel has no newer events. */
    static boolean shouldSkipCompleteCache(ExpressItem value, boolean complete) {
        return value != null && value.semantic != StatusSemantic.UNKNOWN && complete
                && (!value.isShunFengSource() || value.semantic.terminal());
    }

    /** Keeps a complete selected package authoritative even when account query history is partial. */
    private boolean currentDetailComplete(ExpressItem value) {
        try {
            ExpressRepository repository = ExpressRepository.get(this);
            if (automaticDetailComplete(repository, value)) return true;
            ExpressQueryResult account = prefersAccountTimeline(value)
                    ? accountTimelineFor(repository, value, value.displayWaybill(), "interface5") : null;
            return currentDetailComplete(value, account, repository.manualDetailTimelineAuthority(value));
        } catch (RuntimeException failure) {
            return false;
        }
    }

    static boolean currentDetailComplete(ExpressItem value, ExpressQueryResult account,
            ManualTimelineAuthorityPolicy.Candidate selected) {
        if (value.isShunFengSource() && !value.semantic.terminal()
                && !ManualTimelineAuthorityPolicy.isShunFengManualCandidate(selected)) return false;
        if (prefersAccountTimeline(value) && Kuaidi100TimelinePolicy.hasTimedTracking(account)
                && Kuaidi100TimelinePolicy.hasPickupEvidence(account)) return true;
        if (selected == null) return false;
        long feedLatest = value.manuallyAdded ? 0L
                : Kuaidi100TimelinePolicy.latestTimedEventMillis(itemResult(
                        value, value.displayWaybill(), TimelineSlot.K100_H5));
        // Without a feed time baseline, an in-transit manual parcel remains refreshable.
        if (feedLatest <= 0L) {
            return value.semantic != null && value.semantic.terminal()
                    && Kuaidi100TimelinePolicy.hasPickupEvidence(selected.result);
        }
        return ManualTimelineAuthorityPolicy.detailTimelineComplete(selected.result, feedLatest);
    }

    /** 下拉结果只弹一次：有新轨迹 / 已是最新 / 没有可用轨迹 / 抛错且页面上没轨迹可看。 */
    private boolean pullRefreshRequested;
    private String pullRefreshBaseline = "";
    private volatile boolean localRefreshFailed;
    private String renderedTimelineSignature = "";

    private void announcePullRefreshOutcome() {
        if (!pullRefreshRequested) return;
        pullRefreshRequested = false;
        String now = renderedTimelineSignature;
        String copy = localRefreshFailed
                ? (now.isEmpty() ? ExpressToastCopy.DETAIL_REFRESH_FAILED : "")
                : now.isEmpty() ? ExpressToastCopy.DETAIL_NO_TRACK
                : now.equals(pullRefreshBaseline) ? ExpressToastCopy.DETAIL_UP_TO_DATE
                : ExpressToastCopy.DETAIL_REFRESHED;
        if (!copy.isEmpty()) Toast.makeText(this, copy, Toast.LENGTH_SHORT).show();
    }

    private static String timelineSignature(List<ExpressTimeline.Track> tracks) {
        if (tracks == null || tracks.isEmpty()) return "";
        StringBuilder out = new StringBuilder();
        for (ExpressTimeline.Track track : tracks) {
            out.append(track.time).append('|').append(track.detail).append('\n');
        }
        return out.toString();
    }

    private void refreshLocalTimeline(
            boolean showProgress, ExpressRepository.ManualTimelinePollClaim claim) {
        if (localRefreshInFlight || !canRefreshLocalTimeline(item)) {
            ExpressRepository.get(this).releaseManualTimelinePoll(claim);
            if (detailSwipe != null) detailSwipe.setRefreshing(false);
            // 已有一轮在跑：这次手势并入它，不重复弹。
            pullRefreshRequested = false;
            return;
        }
        localRefreshInFlight = true;
        int generation = ++localRefreshGeneration;
        ExpressItem requestItem = item;
        ExpressQueryCancellation cancellation =
                new ExpressQueryCancellation(localRefreshBudgetMillis(requestItem));
        localRefreshCancellation = cancellation;
        localRefreshClaim = claim;
        AtomicInteger taskState = new AtomicInteger(0);
        localRefreshTaskState = taskState;
        setLocalRefreshProgressVisible(showProgress);
        try {
            localRefreshTask = worker.submit(() -> {
                if (!taskState.compareAndSet(0, 1)) return;
                try {
                    ExpressRepository repository = ExpressRepository.get(this);
                    ExpressItem refreshedItem = requestItem;
                    if (usesInterface5Automatic(requestItem)) {
                        refreshedItem = refreshAutomaticDetail(repository, requestItem, cancellation);
                        if (refreshedItem == null) return;
                    }
                    final ExpressItem queryOwner = refreshedItem;
                    ExpressQueryResult feed = repository.automaticSourceTimeline(queryOwner);
                    if (!queryOwner.manuallyAdded && !usesSharedManualTimeline(queryOwner)
                            && !needsManualSupplement(queryOwner, feed, null)) {
                        renderRefreshedDetail(generation, queryOwner);
                        return;
                    }
                    if (queryOwner.isAccountOrder() && queryOwner.projectedWaybill.isEmpty()) {
                        renderRefreshedDetail(generation, queryOwner);
                        return;
                    }
                    if (queryOwner.semantic != StatusSemantic.UNKNOWN
                            && automaticDetailComplete(repository, queryOwner)) {
                        renderRefreshedDetail(generation, queryOwner);
                        return;
                    }
                    ExpressRepository.ManualQueryOwnerClaim ownerClaim = repository.captureManualQueryOwner(queryOwner);
                    ExpressApi manualApi = new ExpressApi(getApplicationContext());
                    ExpressSubscriptionClient picker = new ExpressSubscriptionClient();
                    ManualQueryCoordinator.Batch manualBatch = ManualQueryCoordinator.queryPickerFirst(
                            () -> {
                                try (ExpressQueryCancellation stage = cancellation.child(LOCAL_REFRESH_TIMEOUT_MS)) {
                                    return picker.queryManual(getApplicationContext(), queryOwner.displayWaybill(), stage);
                                } catch (InterruptedException stageTimeout) {
                                    cancellation.throwIfCancelled();
                                    throw new java.net.SocketTimeoutException("Picker stage timed out");
                                }
                            },
                            repository.manualTimelineCandidate(queryOwner, TimelineSlot.V6_QUERY),
                            () -> {
                                try (ExpressQueryCancellation stage = cancellation.child(LOCAL_REFRESH_TIMEOUT_MS)) {
                                    return manualApi.queryMoto(queryOwner.displayWaybill(),
                                            queryOwner.projectedWaybill.isEmpty() ? queryOwner.courierCode : "", stage);
                                } catch (InterruptedException stageTimeout) {
                                    cancellation.throwIfCancelled();
                                    throw new java.net.SocketTimeoutException("Primary stage timed out");
                                }
                            },
                            ManualQueryRoutingPolicy.includesMoto(queryOwner),
                            allowsPrimaryKuaidi100(queryOwner) && !currentDetailComplete(queryOwner)
                                    ? pickerResult -> () -> capturePrimaryKuaidi100(
                                    queryOwner, cancellation) : null,
                            null, queryOwner.semantic == StatusSemantic.UNKNOWN,
                            queryOwner.semantic == StatusSemantic.UNKNOWN && currentDetailComplete(queryOwner));
                    cancellation.throwIfCancelled();
                    ArrayList<ManualQuerySuccess> successes =
                            new ArrayList<>(manualBatch.successes);
                    for (int index = 0; index < successes.size(); index++) {
                        ManualQuerySuccess success = successes.get(index);
                        if (TimelineSlot.K100_H5.equals(TimelineSlot.normalize(success.provider))) {
                            successes.set(index, new ManualQuerySuccess(
                                    success.provider, success.result, success.successAt,
                                    timelineComplete(success.result)));
                        }
                    }
                    repository.saveOwnerManualQueryBatch(queryOwner, ownerClaim, successes,
                            queryOwner.phone, ExpressAccountSource.bindingSourceForOwner(
                                    queryOwner.stateOwner.isEmpty() ? queryOwner.source : queryOwner.stateOwner));
                    renderRefreshedDetail(generation, queryOwner);
                } catch (InterruptedException cancelled) {
                    Thread.currentThread().interrupt();
                } catch (Throwable failure) {
                    // Keep the cached local timeline visible when every enabled source fails.
                    localRefreshFailed = true;
                    Log.w(MANUAL_LOG_TAG, "Refresh failed rowId="
                            + requestItem.rowId
                            + " error=" + failure.getClass().getSimpleName());
                    runOnUiThread(() -> {
                        if (generation != localRefreshGeneration || item == null
                                || item.rowId != requestItem.rowId) return;
                        ManualTimelineAuthorityPolicy.Candidate current =
                                ExpressRepository.get(this).manualDetailTimelineAuthority(item);
                        ensureKuaidi100Presentation(
                                current == null ? null : current.result,
                                "after_manual_refresh_failed");
                    });
                } finally {
                    ExpressRepository.get(this).releaseManualTimelinePoll(claim);
                    runOnUiThread(() -> finishLocalTimelineRefresh(generation));
                }
            });
            scheduleLocalRefreshTimeout(generation);
        } catch (RejectedExecutionException rejected) {
            cancellation.cancel();
            repositoryReleaseManualClaim(claim);
            finishLocalTimelineRefresh(generation);
        }
    }

    private void renderRefreshedDetail(int generation, ExpressItem expected) {
        ExpressRepository repository = ExpressRepository.get(this);
        runOnUiThread(() -> {
            ExpressItem current = repository.find(expected.rowId);
            if (generation != localRefreshGeneration || isFinishing() || isDestroyed()
                    || current == null || item == null || item.rowId != expected.rowId
                    || !current.stateOwner.equals(expected.stateOwner)
                    || !current.sourceProvider.equals(expected.sourceProvider)) return;
            item = current;
            renderHeader(item.displayCourierCode(), item.displayCompany(), item.displayWaybill(),
                    item.displayStatus(), item.semantic);
            ManualTimelineAuthorityPolicy.Candidate selected = repository.manualDetailTimelineAuthority(item);
            ExpressQueryResult detail = selected == null ? repository.automaticSourceTimeline(item) : selected.result;
            rememberDisplayedProvider(selected == null
                    ? ManualTimelineAuthorityPolicy.PREFERRED_FEED : selected.provider);
            renderTimeline(ExpressTimeline.parse(detail == null ? item.tracksJson : detail.tracksJson,
                    detail == null ? item.latestTime : detail.latestTime,
                    detail == null ? item.latestDetail : detail.latestDetail));
            if (!usesInterface5Automatic(item)) ensureKuaidi100Presentation(detail, "after_manual_refresh");
        });
    }

    static boolean automaticDetailComplete(ExpressRepository repository, ExpressItem owner) {
        if (owner == null || owner.manuallyAdded || "ShunFeng".equalsIgnoreCase(owner.sourceProvider)) return false;
        if (Kuaidi100TimelinePolicy.hasPickupEvidence(repository.automaticSourceTimeline(owner))) return true;
        ExpressQueryResult query = accountTimelineFor(repository, owner, owner.displayWaybill(), "interface5");
        if (usesInterface5Automatic(owner) && Kuaidi100TimelinePolicy.hasPickupEvidence(query)) return true;
        String provider = owner.isCainiaoSource() ? TimelineSlot.CN_H5 : TimelineSlot.JD_H5;
        ManualTimelineAuthorityPolicy.Candidate h5 = repository.manualTimelineCandidate(owner, provider);
        return h5 != null && Kuaidi100TimelinePolicy.hasTimedTracking(h5.result)
                && (TimelineSlot.CN_H5.equals(provider)
                        ? Kuaidi100TimelinePolicy.hasPickupEvidence(h5.result) : h5.complete);
    }

    private ExpressItem refreshAutomaticDetail(ExpressRepository repository, ExpressItem expected,
            ExpressQueryCancellation cancellation) throws Exception {
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(expected);
        if (claim == null) return null;
        String bindingGeneration = repository.bindingGeneration(expected.phone, "interface5");
        boolean accountDetailGaveTimeline = false;
        if (!"ShunFeng".equalsIgnoreCase(expected.sourceProvider)) {
            try (ExpressQueryCancellation stage = cancellation.child(10_000L)) {
                ExpressQueryResult query = new ExpressDiscoveryClient().refreshKnown(
                        getApplicationContext(), expected, true, stage);
                cancellation.throwIfCancelled();
                if (query != null) {
                    accountDetailGaveTimeline = Kuaidi100TimelinePolicy.hasTimedTracking(query);
                    repository.saveRecoveredOwnerRoute(expected, claim, query);
                    boolean committed = repository.saveInterface5Query(query, expected, bindingGeneration);
                    if (committed) {
                        ExpressItem current = repository.find(expected.rowId);
                        if (current == null || !current.waybill.equals(expected.waybill)
                                || !current.stateOwner.equals(expected.stateOwner)
                                || !current.sourceProvider.equals(expected.sourceProvider)
                                || !bindingGeneration.equals(repository.bindingGeneration(expected.phone, "interface5"))) return null;
                        expected = current;
                        claim = repository.captureManualQueryOwner(current);
                    }
                }
            } catch (InterruptedException stageTimeout) {
                cancellation.throwIfCancelled();
                localRefreshFailed = true;
            }
            catch (Exception unavailable) {
                cancellation.throwIfCancelled();
                localRefreshFailed = true;
            }
        }
        if (!repository.ownsManualQuery(expected, claim)) return null;
        ExpressItem owner = repository.find(expected.rowId);
        if (owner == null) return null;
        if (automaticDetailComplete(repository, owner)) {
            logAutomaticH5Decision(owner, "skipped", "pickup_or_complete_cache");
            return owner;
        }
        ExpressQueryResult feed = repository.automaticSourceTimeline(owner);
        boolean cainiao = owner.isCainiaoSource();
        boolean jingDong = "JingDong".equalsIgnoreCase(owner.sourceProvider);
        if (jingDong && !allowsJingDongCapture(owner, accountDetailGaveTimeline)) return owner;
        if ((!cainiao && !jingDong) || (cainiao && (feed == null || feed.semantic == StatusSemantic.UNKNOWN))) {
            logAutomaticH5Decision(owner, "skipped", "source_status_missing");
            return owner;
        }
        String route = cainiao ? safeCainiaoUrl(owner) : safeOrderH5Url(owner);
        if (route.isEmpty()) {
            logAutomaticH5Decision(owner, "skipped", "trusted_route_missing");
            return owner;
        }
        ExpressOrderProjectionRetryStore retries = jingDong ? new ExpressOrderProjectionRetryStore(this) : null;
        ExpressOrderProjectionRetryStore.AttemptToken token = jingDong
                ? retries.beginTimelineAttempt(owner, System.currentTimeMillis()) : null;
        if (jingDong && token == null) return owner;
        logAutomaticH5Decision(owner, "started", "source_history_incomplete");
        try {
            ExpressAutomaticTimelineCapture.Result result = ExpressAutomaticTimelineCapture.capture(this,
                    owner, route, cainiao ? TimelineSlot.CN_H5 : TimelineSlot.JD_H5, cancellation);
            logAutomaticH5Decision(owner, result != null && result.timeline != null ? "succeeded" : "failed",
                    result != null && result.timeline != null ? "timeline_received" : "no_result");
            cancellation.throwIfCancelled();
            if (result != null && result.throttled && retries != null) {
                retries.recordTimelineRateLimit(owner, System.currentTimeMillis());
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) Toast.makeText(this,
                            "操作过于频繁，请稍候再试", Toast.LENGTH_SHORT).show();
                });
            }
            if (result != null && result.timeline != null) {
                if (!repository.saveAutomaticDetailTimeline(expected, claim, result.timeline, result.complete)) return null;
            }
        } finally { if (retries != null) retries.endAttempt(token); }
        return repository.find(expected.rowId);
    }

    private static void logAutomaticH5Decision(ExpressItem owner, String event, String reason) {
        ExpressLog.line("v5", owner.isCainiaoSource() ? "cn_h5" : "jd_h5",
                ExpressLog.source(owner.sourceProvider, false), event,
                "tail", ExpressLog.tail(owner.displayWaybill()), "reason", reason);
    }

    private ExpressQueryResult capturePrimaryKuaidi100(
            ExpressItem owner, ExpressQueryCancellation cancellation) throws InterruptedException {
        String route = ManualRoutePolicy.kuaidi100QueryUrl(owner.displayWaybill());
        if (route.isEmpty()) {
            ExpressLog.line("", TimelineSlot.K100_H5, "", "skipped",
                    "tail", ExpressLog.tail(owner.displayWaybill()), "reason", "invalid_waybill");
            return null;
        }
        if (!ExpressKuaidi100CaptureCooldown.due(this, owner.displayWaybill(),
                System.currentTimeMillis())) {
            ExpressLog.line("", TimelineSlot.K100_H5, "", "skipped",
                    "tail", ExpressLog.tail(owner.displayWaybill()), "reason", "cooldown");
            return null;
        }
        ExpressKuaidi100CaptureCooldown.record(this, owner.displayWaybill(), System.currentTimeMillis());
        ExpressAutomaticTimelineCapture.Result result = ExpressAutomaticTimelineCapture.capture(this,
                owner, route, TimelineSlot.K100_H5, cancellation);
        return result == null ? null : result.timeline;
    }

    private void recoverDirectAutomaticRoute() {
        ExpressItem expected = item;
        ExpressRepository repository = ExpressRepository.get(this);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(expected);
        FrameLayout loading = new FrameLayout(this);
        ProgressBar progress = new ProgressBar(this);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(-2, -2, android.view.Gravity.CENTER);
        loading.addView(progress, params);
        setContentView(loading);
        ExpressQueryCancellation cancellation = new ExpressQueryCancellation(25_000L);
        directRouteCancellation = cancellation;
        worker.execute(() -> {
            ExpressItem current = null;
            try {
                for (ExpressQueryResult result : new ExpressSubscriptionClient().query(getApplicationContext(), cancellation)) {
                    cancellation.throwIfCancelled();
                    if (repository.saveRecoveredOwnerRoute(expected, claim, result)) break;
                }
                if (repository.ownsManualQuery(expected, claim)) current = repository.find(expected.rowId);
            } catch (Exception unavailable) { /* The direct H5 surface reports one explicit failure. */ }
            final ExpressItem recovered = current;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed() || directRouteCancellation != cancellation) return;
                directRouteCancellation = null;
                String route = recovered == null ? "" : safeCainiaoUrl(recovered);
                if (route.isEmpty()) {
                    Toast.makeText(this, ExpressToastCopy.H5_UNAVAILABLE, Toast.LENGTH_SHORT).show();
                    finish();
                } else {
                    item = recovered;
                    showCainiaoWebDetail(route);
                }
            });
        });
    }

    private void scheduleLocalRefreshTimeout(int generation) {
        clearLocalRefreshTimeout();
        localRefreshTimeout = () -> {
            localRefreshFailed = true;
            cancelLocalTimelineRefresh(generation, false);
            announcePullRefreshOutcome();
        };
        nativeProgress.postDelayed(localRefreshTimeout, localRefreshBudgetMillis(item));
    }

    static long localRefreshBudgetMillis(ExpressItem owner) {
        return 2L * LOCAL_REFRESH_TIMEOUT_MS
                + (usesInterface5Automatic(owner) ? 10_000L + ORDER_CAPTURE_TIMEOUT_MS : 0L);
    }

    private void finishLocalTimelineRefresh(int generation) {
        if (generation != localRefreshGeneration) return;
        localRefreshInFlight = false;
        localRefreshTask = null;
        localRefreshCancellation = null;
        localRefreshClaim = null;
        localRefreshTaskState = null;
        clearLocalRefreshTimeout();
        setLocalRefreshProgressVisible(false);
        if (detailSwipe != null) detailSwipe.setRefreshing(false);
        if (timelineLoadingPlaceholder) {
            renderTimeline(java.util.Collections.emptyList());
        }
        announcePullRefreshOutcome();
    }

    private void cancelLocalTimelineRefresh(int generation, boolean restartOnStart) {
        if (!localRefreshInFlight || generation != localRefreshGeneration) return;
        localRefreshGeneration++;
        localRefreshInFlight = false;
        restartLocalRefreshOnStart |= restartOnStart;
        ExpressQueryCancellation cancellation = localRefreshCancellation;
        Future<?> task = localRefreshTask;
        ExpressRepository.ManualTimelinePollClaim claim = localRefreshClaim;
        AtomicInteger taskState = localRefreshTaskState;
        localRefreshCancellation = null;
        localRefreshTask = null;
        localRefreshClaim = null;
        localRefreshTaskState = null;
        clearLocalRefreshTimeout();
        setLocalRefreshProgressVisible(false);
        if (detailSwipe != null) detailSwipe.setRefreshing(false);
        if (!restartOnStart && timelineLoadingPlaceholder) {
            renderTimeline(java.util.Collections.emptyList());
        }
        if (cancellation != null) cancellation.cancel();
        if (taskState != null && taskState.compareAndSet(0, 2)) {
            repositoryReleaseManualClaim(claim);
        }
        if (task != null) task.cancel(true);
    }

    private void repositoryReleaseManualClaim(
            ExpressRepository.ManualTimelinePollClaim claim) {
        if (claim != null) ExpressRepository.get(this).releaseManualTimelinePoll(claim);
    }

    private void clearLocalRefreshTimeout() {
        if (localRefreshTimeout != null && nativeProgress != null) {
            nativeProgress.removeCallbacks(localRefreshTimeout);
        }
        localRefreshTimeout = null;
    }

    private void setLocalRefreshProgressVisible(boolean visible) {
        if (nativeProgress != null) {
            nativeProgress.setVisibility(visible ? View.VISIBLE : View.GONE);
        }
    }

    private void renderHeader(
            String courierCode, String company, String waybill,
            String status, StatusSemantic semantic) {
        statusView.setText(status);
        statusView.setTextColor(statusColor(semantic));
        waybillView.setText(getString(R.string.express_company_waybill, company, waybill));
        waybillView.setOnClickListener(view -> copyWaybill(waybill));
        String hotline = CarrierRegistry.hotline(courierCode, company);
        hotlineRow.setVisibility(hotline.isEmpty() ? View.GONE : View.VISIBLE);
        hotlineView.setText(hotline);
        hotlineView.setTextColor(BLUE);
        hotlineView.setOnClickListener(hotline.isEmpty() ? null : view -> {
            try {
                startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + hotline)));
            } catch (Throwable ignored) {
                Toast.makeText(this, ExpressToastCopy.DIAL_UNAVAILABLE, Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void copyWaybill(String waybill) {
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        if (clipboard == null) return;
        clipboard.setPrimaryClip(ClipData.newPlainText(
                getString(R.string.copy_waybill), waybill));
        Toast.makeText(this, ExpressToastCopy.WAYBILL_COPIED, Toast.LENGTH_SHORT).show();
    }

    /** 粘性选包（用户定 2026-09-05 晚）：记住这次详情页显示的是哪个包，下一轮默认还显示它。 */
    private void rememberDisplayedProvider(String provider) {
        if (item == null || previewResult != null || provider == null
                || provider.trim().isEmpty()) return;
        ExpressRepository.get(this).rememberDetailSelection(item, provider);
    }

    private void renderTimeline(List<ExpressTimeline.Track> tracks) {
        timelineLoadingPlaceholder = false;
        renderedTimelineSignature = timelineSignature(tracks);
        timeline.removeAllViews();
        if (tracks.isEmpty()) {
            TextView empty = textView(R.string.no_logistics, 14f, GRAY);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(0, dp(28), 0, dp(28));
            timeline.addView(empty, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            return;
        }
        for (int index = 0; index < tracks.size(); index++) {
            timeline.addView(buildTrackRow(
                    tracks.get(index), index == 0, index == tracks.size() - 1));
        }
    }

    private void renderTimelineLoading() {
        timelineLoadingPlaceholder = true;
        timeline.removeAllViews();
        appendTimelineLoading(R.string.loading_logistics);
    }

    private void appendTimelineLoading(int textResource) {
        TextView loading = textView(textResource, 14f, GRAY);
        loading.setGravity(Gravity.CENTER);
        loading.setPadding(0, dp(28), 0, dp(28));
        timeline.addView(loading, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    static InitialTimelinePresentation initialTimelinePresentation(
            boolean cachedUsable, boolean refreshDue) {
        if (cachedUsable) return InitialTimelinePresentation.TRACKS;
        return refreshDue ? InitialTimelinePresentation.LOADING
                : InitialTimelinePresentation.EMPTY;
    }

    enum InitialTimelinePresentation {
        TRACKS,
        LOADING,
        EMPTY
    }

    private View buildTrackRow(ExpressTimeline.Track track, boolean latest, boolean last) {
        int primary = MaterialColors.getColor(timeline,
                com.google.android.material.R.attr.colorOnSurface);
        String date = "";
        String clock = track.time;
        int separator = clock.indexOf(' ');
        if (separator > 0) {
            date = clock.substring(0, separator);
            clock = clock.length() >= separator + 6
                    ? clock.substring(separator + 1, separator + 6)
                    : clock.substring(separator + 1);
        }

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout timeColumn = new LinearLayout(this);
        timeColumn.setOrientation(LinearLayout.VERTICAL);
        timeColumn.setGravity(Gravity.START);
        TextView time = textView(clock, 15f, latest ? primary : GRAY);
        time.setIncludeFontPadding(false);
        timeColumn.addView(time);
        TextView day = textView(date, 10.5f, LIGHT_GRAY);
        day.setPadding(0, dp(2), 0, 0);
        timeColumn.addView(day);
        row.addView(timeColumn, new LinearLayout.LayoutParams(
                dp(66), ViewGroup.LayoutParams.WRAP_CONTENT));
        row.addView(buildIndicator(latest, last), new LinearLayout.LayoutParams(
                dp(28), ViewGroup.LayoutParams.MATCH_PARENT));
        TextView detail = textView(track.detail, 15.5f, latest ? primary : GRAY);
        ExpressTrackPhoneLinks.apply(detail, BLUE);
        detail.setLineSpacing(0, 1.15f);
        detail.setPadding(dp(10), 0, 0, dp(22));
        row.addView(detail, new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    private View buildIndicator(boolean latest, boolean last) {
        FrameLayout indicator = new FrameLayout(this);
        int centerY = dp(10);
        if (!latest) addLine(indicator, 0, centerY, LINE);
        addLine(indicator, centerY, ViewGroup.LayoutParams.MATCH_PARENT, LINE);
        View dot = new TimelineDot(this, latest, last);
        FrameLayout.LayoutParams dotParams = new FrameLayout.LayoutParams(dp(14), dp(14));
        dotParams.gravity = Gravity.CENTER_HORIZONTAL;
        dotParams.topMargin = centerY - dp(7);
        indicator.addView(dot, dotParams);
        return indicator;
    }

    private void addLine(FrameLayout parent, int top, int height, int color) {
        View line = new View(this);
        line.setBackgroundColor(color);
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(dp(1), height);
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.topMargin = top;
        parent.addView(line, params);
    }

    private TextView textView(int textRes, float size, int color) {
        return textView(getString(textRes), size, color);
    }

    private TextView textView(String text, float size, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    /** 三端同一张状态色表（用户定 2026-09-05）：与列表页、Pipi、iOS statusTint 同表。 */
    private int statusColor(StatusSemantic semantic) {
        switch (semantic == null ? StatusSemantic.UNKNOWN : semantic) {
            case DANGER: return ExpressStatusColors.DANGER;
            case WAITING_PICKUP: return ExpressStatusColors.WAITING_PICKUP;
            case DELIVERY: return ExpressStatusColors.DELIVERY;
            case COMPLETED: return ExpressStatusColors.COMPLETED;
            case PICKED:
            case TRANSIT: return ExpressStatusColors.TRANSIT;
            case ORDERED:
            case SHIPPED: return ExpressStatusColors.ORDERED;
            default: return ExpressStatusColors.NEUTRAL;
        }
    }

    private static final class TimelineDot extends View {
        private final boolean latest;
        private final boolean last;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Drawable chevron;

        TimelineDot(Context context, boolean latest, boolean last) {
            super(context);
            this.latest = latest;
            this.last = last;
            chevron = AppCompatResources.getDrawable(context, R.drawable.ic_symbol_expand_less);
        }

        @Override protected void onDraw(Canvas canvas) {
            float width = getWidth();
            float height = getHeight();
            float radius = Math.min(width, height) / 2f;
            float density = getResources().getDisplayMetrics().density;
            paint.setColor(latest ? ORANGE : 0xFFC4C4C8);
            if (latest || !last) {
                paint.setStyle(Paint.Style.FILL);
                canvas.drawCircle(width / 2f, height / 2f, radius, paint);
            } else {
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(1.2f * density);
                canvas.drawCircle(width / 2f, height / 2f,
                        radius - 1.2f * density, paint);
            }
            if ((!latest && !last) || chevron == null) return;
            int inset = Math.round(Math.min(width, height) * .20f);
            chevron.setBounds(inset, inset,
                    Math.round(width) - inset, Math.round(height) - inset);
            chevron.setTint(latest ? Color.WHITE : 0xFFC4C4C8);
            chevron.draw(canvas);
        }
    }

    @Override protected void onDestroy() {
        cancelFirstManualQuery();
        restartLocalRefreshOnStart = false;
        if (localRefreshInFlight) {
            cancelLocalTimelineRefresh(localRefreshGeneration, false);
        } else {
            localRefreshGeneration++;
            clearLocalRefreshTimeout();
            setLocalRefreshProgressVisible(false);
        }
        worker.shutdownNow();
        if (kuaidi100Capture != null) {
            kuaidi100Capture.cancel();
            kuaidi100Capture = null;
        }
        if (webView != null) {
            WebView closing = webView;
            webView = null;
            closing.stopLoading();
            closing.loadUrl("about:blank");
            closing.clearHistory();
            ViewGroup parent = (ViewGroup) closing.getParent();
            if (parent != null) parent.removeView(closing);
            closing.destroy();
        }
        super.onDestroy();
    }

    @SuppressLint("SetJavaScriptEnabled")
    static void configureWebView(WebView target) {
        WebSettings settings = target.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        if (Build.VERSION.SDK_INT >= 33) settings.setAlgorithmicDarkeningAllowed(true);
    }

    static void applySystemBarInsets(View root) {
        if (root == null) return;
        int initialLeft = root.getPaddingLeft();
        int initialTop = root.getPaddingTop();
        int initialRight = root.getPaddingRight();
        int initialBottom = root.getPaddingBottom();
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(
                    initialLeft + bars.left,
                    initialTop + bars.top,
                    initialRight + bars.right,
                    initialBottom + bars.bottom);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(root);
    }

    private void decorateCainiaoPage(
            WebView view, String url, String localLogo,
            int pageSurface, Runnable complete) {
        if (!isCurrentDetailWebView(view)) return;
        if (!allowed(Uri.parse(url))) {
            if (complete != null) complete.run();
            return;
        }
        Runnable applyLogo = () -> {
            if (!isCurrentDetailWebView(view)) return;
            if (!localLogo.isEmpty()) {
                view.evaluateJavascript(courierLogoScript(localLogo), null);
            }
            if (complete != null) complete.run();
        };
        view.evaluateJavascript(pageSurfaceScript(pageSurface), unused -> {
            if (isCurrentDetailWebView(view)) applyLogo.run();
        });
        view.postDelayed(() -> {
            if (isCurrentDetailWebView(view)) {
                view.evaluateJavascript(pageSurfaceScript(pageSurface), null);
                if (!localLogo.isEmpty()) {
                    view.evaluateJavascript(courierLogoScript(localLogo), null);
                }
            }
        }, 500L);
    }

    private boolean isCurrentDetailWebView(WebView view) {
        return view != null && view == webView && !isFinishing() && !isDestroyed();
    }

    private void navigateBack() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else finish();
    }

    private static ExpressQueryResult previewResult(Intent intent) {
        StatusSemantic semantic = StatusSemantic.fromStored(
                intent.getStringExtra(EXTRA_STATUS), "");
        return new ExpressQueryResult(
                intent.getStringExtra(EXTRA_WAYBILL),
                intent.getStringExtra(EXTRA_COURIER),
                intent.getStringExtra(EXTRA_COMPANY),
                semantic,
                intent.getLongExtra(EXTRA_STATUS_EVENT_TIME, 0L),
                intent.getStringExtra(EXTRA_TIME),
                intent.getStringExtra(EXTRA_DETAIL),
                intent.getStringExtra(EXTRA_TRACKS),
                intent.getStringExtra(EXTRA_URL), "",
                intent.getStringExtra(EXTRA_TIMELINE_PROVIDER),
                intent.getStringExtra(EXTRA_ROUTE_INTERFACE),
                intent.getStringExtra(EXTRA_ROUTE_CREDENTIAL), "");
    }

    private static ExpressItem previewItem(ExpressQueryResult result) {
        String source = TimelineSlot.V5_QUERY.equals(
                TimelineSlot.normalize(result.timelineProvider))
                ? "INTERFACE5" : "INTERFACE6";
        return new ExpressItem(
                0L, "", result.waybill, result.courierCode, result.companyName,
                result.semantic, result.semantic.label, result.latestDetail,
                result.latestTime, result.tracksJson, "", source,
                result.detailUrl, result.statusEventTime, 0L, source, source,
                result.routeInterface, result.routeCredential);
    }

    private static boolean localTimelineOwnsItem(ExpressItem value) {
        return value != null && ("KD-100".equalsIgnoreCase(value.source)
                || "KD-100".equalsIgnoreCase(value.stateOwner)
                || "I5-K100".equalsIgnoreCase(value.source)
                || "I5-K100".equalsIgnoreCase(value.stateOwner)
                || "V4".equalsIgnoreCase(value.source)
                || "V4".equalsIgnoreCase(value.stateOwner));
    }

    private static boolean interface5Kuaidi100OwnsItem(ExpressItem value) {
        return value != null && ("I5-K100".equalsIgnoreCase(value.source)
                || "I5-K100".equalsIgnoreCase(value.stateOwner));
    }

    private static boolean v4TimelineOwnsItem(ExpressItem value) {
        return value != null && ("V4".equalsIgnoreCase(value.source)
                || "V4".equalsIgnoreCase(value.stateOwner));
    }

    static String accountTimelineSource(ExpressItem value) {
        if (value == null) return "";
        // An unprojected order id is not a carrier identity. Once interface 5 supplies the real
        // waybill, its independent account sidecar may own that carrier timeline ahead of K100.
        // 接口 5 的京东订单按订单号就有账号时间线（按件详情），不必等投影出运单号（2026-09-05）。
        if (value.isAccountOrder() && !value.isInterface5ProjectedOrder()
                && !prefersAccountTimeline(value)) return "";
        String owner = value.stateOwner.isEmpty() ? value.source : value.stateOwner;
        if (value.usesInterface5AccountTimeline()) return "interface5";
        if ("INTERFACE6".equalsIgnoreCase(owner)) {
            return "interface6";
        }
        return "";
    }

    /** 行归属的接口：v5 / v6，手动件为空。 */
    /** 统一用词：手动件/预览项不带 interface（它们不归任何账号接口）。 */
    private String detailLogInterface(ExpressItem value) {
        return value == null || value.manuallyAdded || previewResult != null
                ? "" : detailInterface(value);
    }

    private static String detailInterface(ExpressItem value) {
        if (value == null || value.manuallyAdded) return "";
        String owner = value.stateOwner.isEmpty() ? value.source : value.stateOwner;
        return "interface5".equalsIgnoreCase(
                ExpressAccountSource.bindingSourceForOwner(owner)) ? "v5" : "v6";
    }

    private static String tailOf(String value) {
        String clean = value == null ? "" : value.trim();
        return clean.length() <= 4 ? clean : clean.substring(clean.length() - 4);
    }

    /**
     * 接口 5 京东订单的缓存优先渲染：账号时间线（按件详情，按订单号/投影运单号）可用就直接画，
     * 压过手动 authority——之前手动链留下的一条 Meizu 包会把全量轨迹盖掉，进页只剩签收那一条。
     */
    private boolean renderInterface5AccountTimeline(ExpressRepository repository) {
        if (!usesInterface5Automatic(item)) return false;
        ManualTimelineAuthorityPolicy.Candidate selected = repository.manualDetailTimelineAuthority(item);
        ExpressQueryResult detail = selected == null ? repository.automaticSourceTimeline(item) : selected.result;
        if (detail == null) return false;
        rememberDisplayedProvider(selected == null ? ManualTimelineAuthorityPolicy.PREFERRED_FEED : selected.provider);
        renderTimeline(ExpressTimeline.parse(detail.tracksJson, detail.latestTime, detail.latestDetail));
        return true;
    }

    /**
     * 接口 5 按件详情按**订单号**落库，详情页按投影运单号读（accountTimelineWaybill）。已投影的
     * 订单在运单号键下读不到时，回头按订单号读——否则拉回来的全量轨迹存着却显示不出来，详情只剩
     * feed 摘要一条（2026-09-05 Fold7 实测）。
     */
    static ExpressQueryResult accountTimelineFor(
            ExpressRepository repository, ExpressItem item, String waybill, String source) {
        ExpressQueryResult byDisplay = repository.accountTimeline(waybill, source);
        if (item == null || !item.isAccountOrder()
                || Kuaidi100TimelinePolicy.hasTimedTracking(byDisplay)) return byDisplay;
        String orderId = item.waybill == null ? "" : item.waybill.trim();
        if (orderId.isEmpty() || orderId.equalsIgnoreCase(waybill)) return byDisplay;
        ExpressQueryResult byOrder = repository.accountTimeline(orderId, source);
        return Kuaidi100TimelinePolicy.hasTimedTracking(byOrder) ? byOrder : byDisplay;
    }

    static String accountTimelineWaybill(ExpressItem value) {
        return value == null ? "" : value.displayWaybill();
    }

    static boolean accountTimelineUsable(
            ExpressItem value, ExpressQueryResult accountTimeline) {
        return value != null && value.isInterface5ProjectedOrder()
                ? Kuaidi100TimelinePolicy.hasTimedTracking(accountTimeline)
                : Kuaidi100TimelinePolicy.hasRealTracking(accountTimeline);
    }

    static boolean usesInterface5Automatic(ExpressItem value) {
        return value != null && !value.manuallyAdded && "interface5".equals(
                ExpressAccountSource.bindingSourceForOwner(
                        value.stateOwner.isEmpty() ? value.source : value.stateOwner));
    }

    static boolean usesDirectAutomaticH5(ExpressItem value) {
        return value != null && !value.manuallyAdded && !usesInterface5Automatic(value)
                && value.isCainiaoSource();
    }

    static boolean canRefreshLocalTimeline(ExpressItem value) {
        return value != null && !usesDirectAutomaticH5(value)
                && (!"JingDong".equalsIgnoreCase(value.sourceProvider) || usesInterface5Automatic(value))
                && (!value.isAccountOrder() || usesInterface5Automatic(value));
    }

    static boolean prefersAccountTimeline(ExpressItem value) {
        return usesInterface5Automatic(value) && value.isAccountOrder();
    }

    static boolean needsManualSupplement(ExpressItem value,
            ExpressQueryResult ownerTimeline, ExpressQueryResult selectedManualTimeline) {
        if (value == null || !canRefreshLocalTimeline(value)) return false;
        if (value.manuallyAdded || "ShunFeng".equalsIgnoreCase(value.sourceProvider)
                || value.semantic == StatusSemantic.UNKNOWN) return true;
        if (value.isCainiaoSource() && (ownerTimeline == null
                || ownerTimeline.semantic == StatusSemantic.UNKNOWN)) return false;
        return !Kuaidi100TimelinePolicy.hasPickupEvidence(ownerTimeline);
    }

    static ExpressQueryResult preferredDetailTimeline(
            ExpressQueryResult accountTimeline,
            ExpressQueryResult publicTimeline,
            ExpressQueryResult kuaidi100Timeline) {
        if (Kuaidi100TimelinePolicy.hasRealTracking(accountTimeline)) return accountTimeline;
        if (Kuaidi100TimelinePolicy.hasRealTracking(publicTimeline)) return publicTimeline;
        return kuaidi100Timeline;
    }

    private static ExpressQueryResult itemResult(
            ExpressItem value, String waybill, String provider) {
        return new ExpressQueryResult(
                waybill, value.courierCode, value.companyName, value.semantic,
                value.statusEventTime, value.latestTime, value.latestDetail, value.tracksJson,
                "", value.phone, provider, "", "", value.sourceProvider,
                value.carrierNormalization);
    }

    /** A manual query is committed only after its transient detail screen is closed. */
    @Override public void finish() {
        cancelFirstManualQuery();
        if (persistPreviewOnFinish && !previewPersisted
                && previewResult != null && !previewResult.waybill.isEmpty()) {
            previewPersisted = true;
            ExpressRepository repository = ExpressRepository.get(this);
            if (Kuaidi100TimelinePolicy.hasTimedTracking(previewResult)) {
                repository.saveManualQueryResult(
                        previewResult, previewPhone, previewBindingSource);
            } else if (repository.enqueuePendingManual(
                    previewResult, previewPhone, previewBindingSource)) {
                ExpressScheduler.ensureScheduled(this);
            }
        }
        super.finish();
    }

    static String safeCainiaoUrl(ExpressItem item) {
        if (!allowsCainiaoRoute(item)) return "";
        String route = item.routeCredentialAvailable
                && CainiaoRoute.isLegacyCredentialedUrl(item.routeCredential)
                ? item.routeCredential : item.detailUrl;
        if (route.isEmpty()) return "";
        Uri candidate = Uri.parse(route);
        return CainiaoRoute.isTrustedResolvedUrl(route)
                && allowed(candidate) && hasCainiaoCredential(candidate)
                ? candidate.toString() : "";
    }

    static String safeOrderH5Url(ExpressItem item) {
        if (!allowsJingDongRoute(item) || !item.routeCredentialAvailable) return "";
        String route = item.routeCredential;
        if (route.isEmpty()) return "";
        Uri candidate = Uri.parse(route);
        return allowedOrderHost(candidate) ? candidate.toString() : "";
    }

    static String safeKuaidi100Url(String route) {
        return ManualRoutePolicy.safeKuaidi100Url(route);
    }

    static boolean allowsCainiaoRoute(ExpressItem item) {
        return item != null && "CaiNiao".equalsIgnoreCase(item.sourceProvider);
    }

    static boolean allowsJingDongRoute(ExpressItem item) {
        return usesInterface5Automatic(item)
                && "JingDong".equalsIgnoreCase(item.sourceProvider);
    }

    static boolean allowsJingDongCapture(ExpressItem item, boolean accountDetailGaveTimeline) {
        return allowsJingDongRoute(item) && item.projectedWaybill.isEmpty()
                && !accountDetailGaveTimeline;
    }

    static boolean allowsPrimaryKuaidi100(ExpressItem item) {
        return usesInterface5Automatic(item)
                && !"JingDong".equalsIgnoreCase(item.sourceProvider);
    }

    static boolean allowsKuaidi100Route(
            ExpressItem item, ExpressQueryResult preview) {
        if (preview != null && TimelineSlot.V6_QUERY.equals(
                TimelineSlot.normalize(preview.timelineProvider))) {
            return true;
        }
        return item != null && (item.manuallyAdded || item.isShunFengSource());
    }

    private static boolean allowed(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        String host = uri.getHost();
        return trustedHost(host, "cainiao.com") || trustedHost(host, "taobao.com");
    }

    static boolean allowedOrderHost(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        return trustedHost(uri.getHost(), "jd.com");
    }

    static String normalizeIdentity(String value) {
        return value == null ? "" : value.toUpperCase(Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
    }

    private static boolean hasCainiaoCredential(Uri uri) {
        for (String name : uri.getQueryParameterNames()) {
            if (!"secretKey".equalsIgnoreCase(name)) continue;
            String secret = uri.getQueryParameter(name);
            return secret != null && !secret.trim().isEmpty();
        }
        return false;
    }

    private static boolean trustedHost(String host, String parent) {
        return host != null && (host.equals(parent) || host.endsWith("." + parent));
    }

    private String courierLogoDataUri(ExpressItem value) {
        int resource = CarrierRegistry.icon(value.courierCode, value.companyName);
        if (resource == R.drawable.ic_card_express_cp_default) return "";
        try (InputStream input = getResources().openRawResource(resource)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return "data:image/png;base64,"
                    + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        } catch (Throwable ignored) {
            return "";
        }
    }

    static String courierLogoScript(String dataUri) {
        return "(function(){try{"
                + "var selector='" + LOGO_SELECTOR + "';"
                + "var wrapperSelector='" + LOGO_WRAPPER_SELECTOR + "';"
                + "var styleId='" + LOGO_STYLE_ID + "';"
                + "var local='" + dataUri + "';"
                + "var token=(window.__deliveriesCourierLogoGeneration||0)+1;"
                + "window.__deliveriesCourierLogoGeneration=token;"
                + "function active(){return window.__deliveriesCourierLogoGeneration===token;}"
                + "function ensureStyle(){var style=document.getElementById(styleId);"
                + "if(!style){style=document.createElement('style');style.id=styleId;"
                + "style.textContent=wrapperSelector+'{border-color:transparent!important;}';"
                + "(document.head||document.documentElement).appendChild(style);}}"
                + "function patch(){if(!active())return;ensureStyle();"
                + "var image=document.querySelector(selector);if(!image)return;"
                + "image.removeAttribute('srcset');"
                + "if((image.getAttribute('src')||'')!==local)image.setAttribute('src',local);}"
                + "if(window.__deliveriesCourierLogoObserver)"
                + "window.__deliveriesCourierLogoObserver.disconnect();"
                + "var probe=new Image();probe.onload=function(){if(!active())return;patch();"
                + "if(!active())return;var observer=new MutationObserver(function(){"
                + "if(!active()){observer.disconnect();return;}patch();});"
                + "window.__deliveriesCourierLogoObserver=observer;"
                + "observer.observe(document.documentElement,{childList:true,subtree:true,"
                + "attributes:true,attributeFilter:['src','srcset']});};probe.src=local;"
                + "}catch(e){}})()";
    }

    static String pageSurfaceScript(int surfaceColor) {
        String color = String.format(Locale.US, "#%06X", surfaceColor & 0xFFFFFF);
        return "(function(){try{var c='" + color + "';function paint(){"
                + "var s=document.getElementById('__deliveries_surface_style');"
                + "if(!s){s=document.createElement('style');s.id='__deliveries_surface_style';"
                + "s.textContent='html,body,#app,#root{background-color:'+c+' !important;}';"
                + "(document.head||document.documentElement).appendChild(s);}"
                + "var nodes=[document.documentElement,document.body,"
                + "document.getElementById('app'),document.getElementById('root')];"
                + "if(document.body){for(var i=0;i<document.body.children.length;i++)"
                + "nodes.push(document.body.children[i]);}"
                + "nodes.forEach(function(e){if(e)e.style.setProperty('background-color',c,'important');});"
                + "document.querySelectorAll('div,section,main,article,header,footer,ul,li,.app,.page,.page-container,.main,.content,.layout').forEach(function(e){"
                + "var b=getComputedStyle(e).backgroundColor;var r=e.getBoundingClientRect();"
                + "if((b==='rgb(255, 255, 255)'||b==='rgba(0, 0, 0, 0)'||b==='transparent')"
                + "&&r.width>=window.innerWidth*.55)e.style.setProperty('background-color',c,'important');});"
                + "var m=document.querySelector('meta[name=theme-color]');"
                + "if(!m){m=document.createElement('meta');m.name='theme-color';document.head.appendChild(m);}m.content=c;}"
                + "paint();if(!window.__deliveriesSurfaceObserver){"
                + "window.__deliveriesSurfaceObserver=new MutationObserver(paint);"
                + "window.__deliveriesSurfaceObserver.observe(document.documentElement,"
                + "{childList:true,subtree:true,attributes:true,"
                + "attributeFilter:['class','src','hidden','aria-hidden']});}"
                + "}catch(e){}})()";
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
