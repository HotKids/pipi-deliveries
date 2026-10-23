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
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.content.res.AppCompatResources;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat;
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
import me.pipi.deliveries.background.AccountCarrierRecognition;
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
    private static final String EXTRA_TRANSIENT_ONLINE_PREVIEW =
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
    private static final int LINE = 0x33888888;
    // 三端同预算（用户定 2026-09-05）：详情页手动刷新 15 秒（iOS DETAIL_MANUAL_REFRESH_BUDGET_MS 同值）。
    private static final long LOCAL_REFRESH_TIMEOUT_MS = 15_000L;
    static final long ORDER_CAPTURE_TIMEOUT_MS = 20_000L;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    /**
     * 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒。一次详情刷新（进详情或下拉）按一次操作一份 30 秒：不属于
     * 同步轮的用户操作每次各一份，用户 2026-09-27 识别 30 秒细则答「这样做」（Lite 详情刷新里的识别从最多 60 秒降到
     * 30 秒）。这次刷新里的识别——订单投影前、v5_query 文案、京粉页、行的补识别——共用一份预算，这次操作的
     * cancellation 就是它的身份，下一次操作重新算。
     */
    private final java.util.Map<ExpressQueryCancellation, AccountCarrierRecognition.Budget> recognitionBudgets =
            java.util.Collections.synchronizedMap(new java.util.WeakHashMap<>());
    private ExpressKuaidi100TimelineCapture kuaidi100Capture;
    private ExpressQueryCancellation presentationCancellation;
    private LinearLayout timeline;
    private boolean timelineLoadingPlaceholder;
    private LinearProgressIndicator nativeProgress;
    private SwipeRefreshLayout detailSwipe;
    private TextView statusView;
    private TextView waybillView;
    private LinearLayout hotlineRow;
    private TextView hotlineView;
    private ExpressItem item;
    private DetailState detailState;
    private Future<?> initialDetailTask;
    private int initialDetailGeneration;
    private boolean initialDetailShown;
    private boolean detailStarted;

    private static final class DetailState {
        final ExpressItem owner;
        final ExpressItem routeOwner;
        final ExpressRepository.ManualQueryOwnerClaim ownerClaim;
        final ManualTimelineAuthorityPolicy.Candidate selected;
        /** The row's own feed as the sheet shows it (attached order stage appended). */
        final ExpressQueryResult source;
        /** The selected packet as the sheet shows it (JD order stage appended); never persisted. */
        final ExpressQueryResult displayed;
        final ExpressQueryResult account;
        final ExpressQueryResult publicTimeline;
        final ExpressQueryResult kuaidi100;
        final List<String> phones;
        /** Feeds of hidden projected orders attached to this row's waybill (ownership decision 2). */
        final List<String> attachedOrderFeeds;

        DetailState(ExpressRepository repository, ExpressItem owner, String bindingSource) {
            this.owner = owner;
            ownerClaim = repository.captureManualQueryOwner(owner);
            ExpressItem persisted = owner.rowId > 0L ? owner
                    : repository.findByWaybill(owner.displayWaybill(), bindingSource);
            routeOwner = persisted == null ? owner : persisted;
            selected = repository.manualDetailTimelineAuthority(owner);
            ExpressQueryResult ownSource = repository.automaticSourceTimeline(owner);
            attachedOrderFeeds = repository.attachedOrderFeeds(owner);
            source = ManualTimelineAuthorityPolicy.withAttachedOrderStage(
                    ownSource, attachedOrderFeeds);
            displayed = ManualTimelineAuthorityPolicy.withAttachedOrderStage(
                    ManualTimelineAuthorityPolicy.withOwnerOrderStage(owner, ownSource, selected),
                    attachedOrderFeeds);
            String accountSource = accountTimelineSource(owner);
            account = accountSource.isEmpty() ? null : accountTimelineFor(
                    repository, owner, accountTimelineWaybill(owner), accountSource);
            publicTimeline = v4TimelineOwnsItem(owner)
                    ? repository.v4Timeline(owner.displayWaybill()) : null;
            kuaidi100 = repository.kuaidi100Timeline(owner.displayWaybill());
            phones = repository.phoneCandidates("", bindingSource);
        }

        /** The same attached order stage for a package drawn from the other detail caches. */
        String withAttachedOrderStage(String tracksJson) {
            return ExpressTimeline.appendAttachedOrderStage(tracksJson, attachedOrderFeeds);
        }
    }

    private ExpressQueryResult previewResult;
    private String previewPhone = "";
    private String previewBindingSource = "interface6";
    private boolean previewPersisted;
    private boolean previewSaveInFlight;
    private boolean persistPreviewOnFinish;
    private boolean localRefreshInFlight;
    private boolean localRefreshIsPull;
    private boolean pendingDetailPull;
    private int localRefreshGeneration;
    private Runnable localRefreshTimeout;
    private Future<?> localRefreshTask;
    private ExpressQueryCancellation localRefreshCancellation;
    private AtomicInteger localRefreshTaskState;
    private boolean restartLocalRefreshOnStart;
    /** Set only while onStart restarts a refresh that onStop cancelled. */
    private boolean localRefreshRestart;
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
                .putExtra(EXTRA_TRANSIENT_ONLINE_PREVIEW, true);
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

    static Intent transientOnlinePreviewIntent(
            Context context, ExpressQueryResult result, String phone, String bindingSource) {
        return previewIntent(context, result, phone, bindingSource)
                .putExtra(EXTRA_PERSIST_PREVIEW, false)
                .putExtra(EXTRA_TRANSIENT_ONLINE_PREVIEW, true)
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
        }
    }

    private void loadInitialDetail() {
        int generation = ++initialDetailGeneration;
        long rowId = getIntent().getLongExtra(EXTRA_ROW_ID, 0L);
        ExpressItem preview = item;
        String bindingSource = ExpressAccountSource.bindingSource(this);
        initialDetailTask = worker.submit(() -> {
            try {
                ExpressRepository repository = ExpressRepository.get(getApplicationContext());
                ExpressItem owner = preview == null ? repository.find(rowId) : preview;
                DetailState snapshot = owner == null ? null
                        : new DetailState(repository, owner, bindingSource);
                runOnUiThread(() -> {
                    if (!initialDetailIsCurrent(generation)) return;
                    initialDetailTask = null;
                    if (!bindingSource.equals(ExpressAccountSource.bindingSource(this))) {
                        finish();
                        return;
                    }
                    item = owner;
                    detailState = snapshot;
                    initialDetailShown = true;
                    showInitialDetail();
                });
            } catch (RuntimeException failure) {
                runOnUiThread(() -> {
                    if (!initialDetailIsCurrent(generation)) return;
                    initialDetailTask = null;
                    // 「本地快递数据读取失败」只在列表加载失败时弹（审计 R8，用户 2026-09-25 默认 #13）。
                    finish();
                });
            }
        });
    }

    private boolean initialDetailIsCurrent(int generation) {
        return detailStarted && generation == initialDetailGeneration
                && !isFinishing() && !isDestroyed();
    }

    private void cancelInitialDetailLoad() {
        initialDetailGeneration++;
        if (initialDetailTask != null) initialDetailTask.cancel(true);
        initialDetailTask = null;
    }

    private void showInitialDetail() {
        if (item == null) {
            finish();
            return;
        }
        boolean transientOnlinePreview = getIntent().getBooleanExtra(
                EXTRA_TRANSIENT_ONLINE_PREVIEW, false);
        String cainiaoUrl = transientOnlinePreview ? "" : safeCainiaoUrl(item);
        // 只打尾号和分支判定，不落完整单号：对照「这一行为什么开了哪一页」。
        me.pipi.deliveries.network.ExpressLog.line(
                detailLogInterface(item), "detail",
                me.pipi.deliveries.network.ExpressLog.source(item.sourceProvider, item.manuallyAdded),
                "started",
                "tail", tailOf(item.displayWaybill()),
                "accountOrder", item.isAccountOrder(),
                "projected", !item.projectedWaybill.isEmpty(),
                "preview", previewResult != null,
                "transient", transientOnlinePreview,
                "cainiao", !cainiaoUrl.isEmpty());
        if (!transientOnlinePreview && usesNativeAutomaticDetail(item)) {
            showNativeDetail();
            if (!item.semantic.terminal()) refreshLocalTimeline(false);
        } else {
                // Entry displays the cached package; an explicit pull owns later H5 capture.
                me.pipi.deliveries.network.ExpressLog.line(
                        detailLogInterface(item), "detail", "", "selected",
                        "tail", tailOf(item.displayWaybill()), "branch", "native");
                showNativeDetail();
                if (getIntent().getBooleanExtra(EXTRA_MANUAL_QUERY, false)) {
                    startFirstManualQuery();
                }
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { finish(); }
        });
    }

    @Override protected void onStop() {
        detailStarted = false;
        cancelInitialDetailLoad();
        cancelFirstManualQuery();
        if (presentationCancellation != null) presentationCancellation.cancel();
        presentationCancellation = null;
        if (kuaidi100Capture != null) kuaidi100Capture.cancel();
        kuaidi100Capture = null;
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
        detailStarted = true;
        if (!initialDetailShown && initialDetailTask == null) loadInitialDetail();
        if (restartLocalRefreshOnStart) {
            restartLocalRefreshOnStart = false;
            // 用户 2026-09-28：the refresh this restart runs is not the user's pull; it is logged
            // with the foreground trigger (the word iOS / Pipi / Lite use for a return to the app).
            localRefreshRestart = true;
            try {
                restartLocalTimelineRefreshIfNeeded();
            } finally {
                localRefreshRestart = false;
            }
        }
    }

    private void startFirstManualQuery() {
        if (firstManualQueryInFlight || previewResult == null) return;
        String waybill = previewResult.waybill;
        String bindingSource = previewBindingSource;
        String suppliedPhone = previewPhone;
        ExpressQueryCancellation cancellation = new ExpressQueryCancellation(2L * LOCAL_REFRESH_TIMEOUT_MS);
        firstManualQueryCancellation = cancellation;
        firstManualQueryInFlight = true;
        manualPhoneTailRequired = false;
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
            ExpressRepository.ManualTimelinePollClaim pollClaim = null;
            try {
                ExpressRepository repository = ExpressRepository.get(this);
                ExpressItem existing = repository.findByWaybill(waybill, bindingSource);
                ExpressRepository.ManualQueryOwnerClaim ownerClaim = existing == null
                        ? null : repository.captureManualQueryOwner(existing);
                if (existing != null) {
                    pollClaim = repository.claimForegroundManualTimelinePoll(
                            existing, System.currentTimeMillis(), false);
                    if (pollClaim == null) {
                        DetailState snapshot = new DetailState(repository, existing, bindingSource);
                        runOnUiThread(() -> {
                            if (!firstManualQueryIsCurrent(cancellation)) return;
                            finishFirstManualQuery();
                            item = existing;
                            detailState = snapshot;
                            previewResult = null;
                            showNativeDetail();
                        });
                        return;
                    }
                }
                courierHint.set(ExpressListActivity.manualQueryRawCarrierHint(
                        courierHint.get(), existing == null ? "" : existing.courierCode));
                ExpressApi manualApi = new ExpressApi(getApplicationContext());
                ExpressSubscriptionClient meizuApi = new ExpressSubscriptionClient();
                ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryOnlineFirst(
                        () -> {
                            try (ExpressQueryCancellation stage = cancellation.child(LOCAL_REFRESH_TIMEOUT_MS)) {
                                try {
                                    return meizuApi.queryManual(getApplicationContext(), waybill, stage);
                                } catch (InterruptedException stopped) {
                                    cancellation.throwIfCancelled();
                                    if (!stage.isCancelled()) throw stopped;
                                    throw new java.net.SocketTimeoutException("Online stage timed out");
                                }
                            }
                        },
                        existing == null ? null : repository.manualTimelineCandidate(
                                existing, TimelineSlot.V6_QUERY),
                        null, ManualQueryRoutingPolicy.includesMoto(existing), onlineResult -> {
                            String code = onlineResult != null && !onlineResult.courierCode.isEmpty()
                                    ? onlineResult.courierCode : courierHint.get();
                            ExpressQueryResult identity = new ExpressQueryResult(waybill, code, "",
                                    StatusSemantic.UNKNOWN, "", "", "[]");
                            String savedPhone = !suppliedPhone.isEmpty() ? suppliedPhone
                                    : existing == null ? "" : existing.phone;
                            return () -> {
                                try (ExpressQueryCancellation stage = cancellation.child(LOCAL_REFRESH_TIMEOUT_MS)) {
                                    return captureKuaidi100ForAddChain(waybill,
                                            ManualRoutePolicy.primaryH5Url(waybill, code), identity,
                                            savedPhone, stage);
                                }
                            };
                        },
                        partial -> publishFirstManualPreview(partial, cancellation), true);
                cancellation.throwIfCancelled();
                ExpressQueryResult selected = firstManualResult(batch.successes, batch.detailSelected());
                if (selected == null) throw new ExpressApi.NoTrackException();
                String phone = !suppliedPhone.isEmpty() ? suppliedPhone
                        : existing != null && !existing.phone.isEmpty() ? existing.phone : selected.phone;
                List<ManualQuerySuccess> writes = new ArrayList<>(batch.successes);
                String route = kuaidi100AddCaptureRoute(waybill, selected.courierCode, batch.accumulatedSuccesses());
                if (!route.isEmpty()) {
                    ExpressQueryResult captured = captureKuaidi100ForAddChain(
                            waybill, route, selected, phone, cancellation);
                    cancellation.throwIfCancelled();
                    if (captured != null) {
                        writes.add(new ManualQuerySuccess(
                                captured.timelineProvider, captured, System.currentTimeMillis(), timelineComplete(captured)));
                        selected = firstManualResult(writes, selected);
                        publishFirstManualPreview(selected, cancellation);
                    }
                }
                cancellation.throwIfCancelled();
                ExpressQueryResult result = selected;
                ExpressItem stored = repository.saveClaimedManualQueryBatch(
                        existing, ownerClaim, writes, phone, bindingSource,
                        false, pollClaim, cancellation);
                if (stored == null) throw new IllegalStateException("Manual query owner changed");
                // T23 entry G（用户 2026-09-26）：手动件承运商还没对上就在这一轮补识别（内置表 → 快递100 免费 → 付费），
                // 识别不出的之后各轮继续补；待定期间不推送。
                if (AccountCarrierRecognition.needsRecognition(stored)) {
                    // Its own short stage: a slow recognition never turns a saved add into a timeout.
                    try (ExpressQueryCancellation stage = cancellation.child(5_000L)) {
                        if (AccountCarrierRecognition.recognize(repository, stored,
                                carrierRecognizer(stored, stage))) {
                            ExpressItem recognized = repository.find(stored.rowId);
                            if (recognized != null) stored = recognized;
                        }
                    } catch (InterruptedException cutOff) {
                        // The row is saved; a later round recognises its carrier. The stage's own cut-off
                        // is not the add's: only the add's cancellation below may end it.
                        Thread.interrupted();
                    }
                }
                ExpressItem saved = stored;
                if (!Kuaidi100TimelinePolicy.hasTimedTracking(result)
                        && repository.enqueuePendingManual(result, phone, bindingSource)) {
                    ExpressScheduler.ensureScheduled(getApplicationContext());
                }
                cancellation.throwIfCancelled();
                DetailState savedState = new DetailState(repository, saved, bindingSource);
                boolean phoneTailToast = manualPhoneTailRequired && phoneTailToastDue(saved);
                runOnUiThread(() -> {
                    if (!firstManualQueryIsCurrent(cancellation)) return;
                    finishFirstManualQuery();
                    renderFirstManualResult(result);
                    item = saved;
                    detailState = savedState;
                    setResult(RESULT_OK);
                    Toast.makeText(this, phoneTailToast ? ExpressToastCopy.MANUAL_PHONE_TAIL_REQUIRED
                            : Kuaidi100TimelinePolicy.hasRealTracking(result)
                            ? ExpressToastCopy.MANUAL_QUERY_SUCCEEDED
                            : ExpressToastCopy.MANUAL_QUERY_NO_TRACK, Toast.LENGTH_SHORT).show();
                });
            } catch (Exception failure) {
                runOnUiThread(() -> failFirstManualQuery(
                        failure, waybill, courierHint.get(), cancellation));
            } finally {
                ExpressRepository.get(this).releaseManualTimelinePoll(pollClaim);
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
            Toast.makeText(this, ExpressToastCopy.MANUAL_PHONE_TAIL_REQUIRED, Toast.LENGTH_SHORT).show();
            setResult(RESULT_PHONE_TAIL_REQUIRED, new Intent()
                    .putExtra(EXTRA_RETRY_WAYBILL, waybill)
                    .putExtra(EXTRA_RETRY_COURIER, courierHint)
                    .putExtra(EXTRA_RETRY_MISMATCH,
                            ((ExpressApi.QueryException) failure).phoneTailMismatch()));
            finish();
            return;
        }
        String phone = previewPhone;
        String bindingSource = previewBindingSource;
        worker.execute(() -> {
            boolean queued = false;
            try {
                queued = ExpressRepository.get(this).enqueuePendingManual(waybill, phone, bindingSource);
                if (queued) ExpressScheduler.ensureScheduled(getApplicationContext());
            } catch (RuntimeException persistenceFailure) {
                Log.w(MANUAL_LOG_TAG, "Pending manual query could not be saved: "
                        + persistenceFailure.getClass().getSimpleName());
            }
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                Toast.makeText(this, failure instanceof ExpressApi.NoTrackException
                        ? ExpressToastCopy.MANUAL_QUERY_NO_TRACK
                        : ExpressToastCopy.MANUAL_QUERY_FAILED, Toast.LENGTH_SHORT).show();
                if (!Kuaidi100TimelinePolicy.hasTimedTracking(previewResult)) finish();
            });
        });
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

    /** The add chain keeps fetching when a historical start trails newer shipment evidence. */
    static String kuaidi100AddCaptureRoute(
            String waybill, List<? extends ManualQuerySuccess> successes) {
        return kuaidi100AddCaptureRoute(waybill, "", successes);
    }

    static String kuaidi100AddCaptureRoute(
            String waybill, String courierCode, List<? extends ManualQuerySuccess> successes) {
        if (successes == null) return "";
        if (ManualTimelineAuthorityPolicy.timelineStartAligned(successes, waybill)) return "";
        return ManualRoutePolicy.primaryH5Url(waybill, courierCode);
    }

    /** 在工作线程里同步等隐藏 WebView 抓完（最多 8 秒 + 1 秒），抓到就组成 K100 槽的包。 */
    private ExpressQueryResult captureKuaidi100ForAddChain(
            String waybill, String route, ExpressQueryResult selected, String phone,
            ExpressQueryCancellation cancellation) throws InterruptedException, ExpressApi.QueryException {
        String provider = ManualRoutePolicy.primaryH5Provider(selected.courierCode);
        List<String> boundPhones = ExpressRepository.get(this).phoneCandidates("", previewBindingSource);
        List<String> phones = ExpressKuaidi100TimelineCapture.phoneCandidates(phone, boundPhones);
        long now = System.currentTimeMillis();
        String tail = waybill.length() <= 4 ? waybill : waybill.substring(waybill.length() - 4);
        if (!ExpressKuaidi100CaptureCooldown.due(this, provider, waybill, phones, now)) {
            ExpressLog.line("", provider, "manual", "skipped",
                    "tail", tail, "reason", "cooldown");
            return null;
        }
        ExpressKuaidi100CaptureCooldown.record(this, provider, waybill, phones, now);
        ExpressLog.line("", provider, "manual", "started", "tail", tail, "reason", "add_chain");
        java.util.concurrent.CountDownLatch finished = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicReference<String> tracks =
                new java.util.concurrent.atomic.AtomicReference<>("");
        java.util.concurrent.atomic.AtomicBoolean phoneRequired = new java.util.concurrent.atomic.AtomicBoolean();
        runOnUiThread(() -> {
            if (isFinishing() || isDestroyed() || cancellation.isCancelled()) {
                finished.countDown();
                return;
            }
            ExpressKuaidi100TimelineCapture capture = new ExpressKuaidi100TimelineCapture(
                    this, route, waybill, phone, (done, tracksJson) -> {
                        if (addChainCapture == done) addChainCapture = null;
                        tracks.set(tracksJson == null ? "" : tracksJson);
                        phoneRequired.set(done.needsPhoneTail());
                        finished.countDown();
                    });
            capture.usePhoneCandidates(boundPhones);
            addChainCapture = capture;
            if (!capture.start()) {
                addChainCapture = null;
                finished.countDown();
            }
        });
        boolean completed;
        try {
            long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(
                    ExpressKuaidi100TimelineCapture.CAPTURE_TIMEOUT_MS + 1_000L);
            do {
                cancellation.throwIfCancelled();
                completed = finished.await(50L, java.util.concurrent.TimeUnit.MILLISECONDS);
            } while (!completed && System.nanoTime() < deadline);
        } catch (InterruptedException interrupted) {
            runOnUiThread(this::cancelAddChainCapture);
            throw interrupted;
        }
        if (!completed) runOnUiThread(this::cancelAddChainCapture);
        if (phoneRequired.get()) {
            manualPhoneTailRequired = true;
            throw ExpressApi.QueryException.phoneTailRequired(ExpressToastCopy.MANUAL_PHONE_TAIL_REQUIRED);
        }
        ExpressQueryResult captured = ExpressDetailActivity.kuaidi100CapturedResult(
                waybill, selected.courierCode, selected.companyName, phone, tracks.get());
        int nodes = Kuaidi100TimelinePolicy.timedTrackCount(captured);
        if (nodes == 0) {
            ExpressLog.line("", provider, "manual", "failed",
                    "tail", tail, "reason", "no_tracks",
                    "elapsedMs", System.currentTimeMillis() - now);
            return null;
        }
        ExpressLog.line("", provider, "manual", "succeeded",
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
            DetailState snapshot = detailState;
            if (renderInterface5AccountTimeline(snapshot)) {
                if (item.semantic == StatusSemantic.UNKNOWN || allowsJingDongCapture(item)) refreshLocalTimeline(false);
                return;
            }
            if (renderManualTimelineAuthority(snapshot, true)) {
                refreshLocalTimeline(false);
                return;
            }
            String timelineWaybill = item.displayWaybill();
            String accountSource = accountTimelineSource(item);
            String accountWaybill = accountTimelineWaybill(item);
            boolean v4Owner = v4TimelineOwnsItem(item);
            ExpressQueryResult accountTimeline = accountSource.isEmpty()
                    ? null : snapshot.account;
            boolean accountTimelineUsable = accountTimelineUsable(item, accountTimeline);
            ExpressQueryResult publicTimeline = v4Owner
                    ? snapshot.publicTimeline : null;
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
            ExpressQueryResult kuaidi100Timeline = snapshot.kuaidi100;
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
                renderTimeline(ExpressTimeline.parse(snapshot.withAttachedOrderStage(
                        cached.tracksJson), cached.latestTime, cached.latestDetail));
            } else if (presentation == InitialTimelinePresentation.LOADING) {
                renderTimelineLoading();
            } else {
                renderTimeline(java.util.Collections.emptyList());
            }
            persistInitialTimelineAsync(ExpressRepository.get(this), initial,
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
        DetailState snapshot = detailState;
        if (renderInterface5AccountTimeline(snapshot)) {
            if (item.semantic == StatusSemantic.UNKNOWN || allowsJingDongCapture(item)) refreshLocalTimeline(false);
            return;
        }
        if (renderManualTimelineAuthority(snapshot, false)) return;
        String waybill = item.displayWaybill();
        String accountSource = accountTimelineSource(item);
        ExpressQueryResult accountTimeline = accountSource.isEmpty()
                ? null : snapshot.account;
        boolean accountTimelineUsable = accountTimelineUsable(item, accountTimeline);
        boolean v4Owner = v4TimelineOwnsItem(item);
        ExpressQueryResult publicTimeline = v4Owner
                ? snapshot.publicTimeline : null;
        boolean publicTimelineUsable =
                Kuaidi100TimelinePolicy.hasRealTracking(publicTimeline);
        ExpressQueryResult cached = preferredDetailTimeline(
                accountTimelineUsable ? accountTimeline : null,
                publicTimeline, snapshot.kuaidi100);
        boolean cachedUsable = Kuaidi100TimelinePolicy.hasRealTracking(cached);
        ExpressQueryResult initial = itemResult(
                item, accountSource.isEmpty() ? waybill : accountTimelineWaybill(item),
                !accountSource.isEmpty() ? TimelineSlot.forBindingSource(accountSource)
                        : v4Owner ? TimelineSlot.V4_QUERY : TimelineSlot.K100_H5);
        ExpressQueryResult ownerTimeline = !accountSource.isEmpty()
                ? accountTimeline : v4Owner ? publicTimeline : initial;
        boolean refreshDue = allowsJingDongCapture(item) || needsManualSupplement(item, ownerTimeline, cached);
        if (cachedUsable) {
            rememberDisplayedProvider(cached.timelineProvider);
            renderTimeline(ExpressTimeline.parse(snapshot.withAttachedOrderStage(
                    cached.tracksJson), cached.latestTime, cached.latestDetail));
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
            DetailState snapshot, boolean force) {
        boolean sharedSource = usesSharedManualTimeline(item);
        if (!sharedSource && !manualTimelineOwnsDetail(item)) return false;
        ManualTimelineAuthorityPolicy.Candidate detailAuthority =
                snapshot.selected;
        ExpressQueryResult detailResult = snapshot.displayed;
        rememberDisplayedProvider(detailAuthority == null
                ? ManualTimelineAuthorityPolicy.PREFERRED_FEED : detailAuthority.provider);
        renderTimeline(ExpressTimeline.parse(
                detailResult == null ? snapshot.withAttachedOrderStage(item.tracksJson)
                        : detailResult.tracksJson,
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

    /** 「完整轨迹」= 有带时间的节点，且到了起点（揽收或下单，与 needsManualSupplement 同判据）。 */
    static boolean timelineComplete(ExpressQueryResult result) {
        return Kuaidi100TimelinePolicy.hasTimedTracking(result)
                && Kuaidi100TimelinePolicy.hasTimelineStart(result);
    }

    /** 抓到的节点只是轨迹，状态仍按结构化来源（online / v4_query）给，与三端「状态看结构化」一致。 */
    static ExpressQueryResult kuaidi100CapturedResult(ExpressItem owner, String tracksJson) {
        if (owner == null) return null;
        return kuaidi100CapturedResult(
                owner.displayWaybill(), owner.displayCourierCode(), owner.displayCompany(),
                owner.phone, tracksJson);
    }

    /** 加件链也用这一份：行还没建时按 online/v4 给的承运商身份组包。 */
    static ExpressQueryResult kuaidi100CapturedResult(
            String waybill, String courierCode, String companyName, String phone,
            String tracksJson) {
        if (waybill == null || waybill.isEmpty() || tracksJson == null || tracksJson.isEmpty()) {
            return null;
        }
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(tracksJson, "", "");
        if (tracks.isEmpty()) return null;
        ExpressTimeline.Track latest = tracks.get(0);
        String provider = ManualRoutePolicy.primaryH5Provider(courierCode);
        ExpressTimeline.Track evidence = TimelineSlot.JT_H5.equals(provider)
                ? ExpressTimeline.latestJtStatusEvidence(tracksJson) : null;
        return new ExpressQueryResult(
                waybill, courierCode == null ? "" : courierCode,
                companyName == null ? "" : companyName,
                evidence == null ? StatusSemantic.UNKNOWN : evidence.semantic,
                evidence == null ? 0L : evidence.epochMillis, latest.time, latest.detail, tracksJson,
                "", phone == null ? "" : phone, provider, "", "", "")
                .withManualStatusEvidence("", evidence != null);
    }

    private void refreshLocalTimeline(boolean showProgress) {
        if (item == null || !canRefreshLocalTimeline(item)) {
            if (detailSwipe != null) detailSwipe.setRefreshing(false);
            announcePullRefreshOutcome();
            return;
        }
        refreshLocalTimelineInBackground(showProgress);
    }

    /**
     * A JD web capture more than five minutes behind structured status may query its v5 account
     * on detail entry. The row ledger shares the alignment's ordinary interval and three-attempt
     * cap; failures and empty responses remain retryable, and only an advancing slot completes the set.
     */
    static boolean claimWebLagEntryQuery(ExpressRepository repository, ExpressItem owner) {
        if (owner == null || !allowsJingDongCapture(owner)) return false;
        ExpressRepository.StatusAlignmentProbe probe = repository.statusAlignmentProbe(owner);
        if (probe == null || !probe.detailFromWebCapture || probe.statusAt <= 0L || probe.detailAt <= 0L
                || probe.statusAt - probe.detailAt <= ExpressRepository.STATUS_ALIGNMENT_MILLIS) return false;
        return repository.beginStatusAlignment(owner,
                probe.statusAt + "|" + probe.headlineAt + "|" + probe.detailAt,
                System.currentTimeMillis());
    }

    /** 详情页显示的那一包，与 DetailState 同一口径。 */
    static ExpressQueryResult detailShown(ExpressRepository repository, ExpressItem owner) {
        if (owner == null) return null;
        ManualTimelineAuthorityPolicy.Candidate selected = repository.manualDetailTimelineAuthority(owner);
        ExpressQueryResult source = repository.automaticSourceTimeline(owner);
        return ManualTimelineAuthorityPolicy.withAttachedOrderStage(selected == null ? source
                : ManualTimelineAuthorityPolicy.withOwnerOrderStage(owner, source, selected),
                repository.attachedOrderFeeds(owner));
    }

    /** Complete history cannot suppress an active JD entry query or SF's manual refresh. */
    static boolean shouldSkipCompleteCache(ExpressItem value, boolean complete) {
        return value != null && !(allowsJingDongCapture(value)
                && value.isAccountOrder() && value.projectedWaybill.isEmpty())
                && value.semantic != StatusSemantic.UNKNOWN && complete
                && (!allowsJingDongCapture(value) || value.semantic.terminal())
                && (!value.isShunFengSource() || value.semantic.terminal());
    }

    /** Keeps a complete selected package authoritative even when account query history is partial. */
    private boolean currentDetailComplete(ExpressItem value) {
        try {
            ExpressRepository repository = ExpressRepository.get(this);
            ExpressQueryResult account = repository.automaticSourceTimeline(value);
            return currentDetailComplete(value, account, repository.manualDetailTimelineAuthority(value));
        } catch (RuntimeException failure) {
            return false;
        }
    }

    public static boolean currentDetailComplete(ExpressItem value, ExpressQueryResult account,
            ManualTimelineAuthorityPolicy.Candidate selected) {
        if (value == null || value.isShunFengSource() && !value.semantic.terminal()) return false;
        ExpressQueryResult detail = selected == null ? account : selected.result;
        if (detail == null) return false;
        // 用户 2026-09-27：留作第一条签收的评价只是临时轨迹，完整、完整缓存、进详情的 v5 查询和签收缺口都不算它。
        detail = ExpressRepository.withoutShoppingReviews(value, detail);
        long reference = value.manuallyAdded && value.semantic != StatusSemantic.COMPLETED ? 0L
                : Math.max(value.statusEventTime, ExpressTimeline.parseTime(value.latestTime));
        ExpressQueryResult presented = new ExpressQueryResult(detail.waybill, detail.courierCode,
                detail.companyName, value.semantic, value.statusEventTime, detail.latestTime,
                detail.latestDetail, me.pipi.deliveries.model.WorkerStatusProjection.attach(detail.tracksJson,
                        me.pipi.deliveries.model.WorkerStatusProjection.cached(value.tracksJson)),
                detail.detailUrl, detail.phone,
                detail.timelineProvider, detail.routeInterface, detail.routeCredential,
                detail.sourceProvider, detail.carrierNormalization)
                .withManualStatusEvidence(value.statusDescription, detail.structuredStatusEvidence);
        if (reference <= 0L && !value.semantic.terminal()) return false;
        return ManualTimelineAuthorityPolicy.detailTimelineComplete(presented, reference);
    }

    /**
     * 用户 2026-09-26（其余裁决 20，三端同口径：iOS sync.ts 的 !shipmentDetailComplete、Pipi
     * ExpressPoller.showsPhoneTailToast）：页面要了手机尾号，这一轮落盘后详情仍不完整才弹提示；完整与否就是
     * {@link #currentDetailComplete}。
     */
    static boolean phoneTailToastDue(ExpressItem settled, ExpressQueryResult account,
            ManualTimelineAuthorityPolicy.Candidate selected) {
        return !currentDetailComplete(settled, account, selected);
    }

    private boolean phoneTailToastDue(ExpressItem settled) {
        if (settled == null) return true;
        try {
            ExpressRepository repository = ExpressRepository.get(this);
            return phoneTailToastDue(settled, repository.automaticSourceTimeline(settled),
                    repository.manualDetailTimelineAuthority(settled));
        } catch (RuntimeException failure) {
            return true;
        }
    }

    /** 下拉结果只弹一次：有新轨迹 / 已是最新 / 没有可用轨迹 / 抛错且页面上没轨迹可看。 */
    private boolean pullRefreshRequested;
    private boolean detailEntryObserved;
    private String pullRefreshBaseline = "";
    private volatile boolean localRefreshFailed;
    private volatile long localRefreshRiskControlUntil;
    private volatile boolean localRefreshJoinedOrderAttempt;
    private volatile boolean localRefreshSharedOrderOutcome;
    private volatile boolean manualPhoneTailRequired;
    private String renderedTimelineSignature = "";

    private void announcePullRefreshOutcome() {
        if (manualPhoneTailRequired && !pullRefreshRequested && item != null && item.manuallyAdded) {
            manualPhoneTailRequired = false;
            Toast.makeText(this, ExpressToastCopy.MANUAL_PHONE_TAIL_REQUIRED, Toast.LENGTH_SHORT).show();
            return;
        }
        if (!pullRefreshRequested) return;
        pullRefreshRequested = false;
        String now = renderedTimelineSignature;
        long remainingRiskControl = localRefreshRiskControlUntil - System.currentTimeMillis();
        String copy = remainingRiskControl > 0L
                ? ExpressToastCopy.jdRiskControlRemaining(remainingRiskControl)
                : manualPhoneTailRequired ? ExpressToastCopy.MANUAL_PHONE_TAIL_REQUIRED : localRefreshFailed
                ? (now.isEmpty() ? ExpressToastCopy.DETAIL_REFRESH_FAILED : "")
                : localRefreshSharedOrderOutcome && now.equals(pullRefreshBaseline) ? ""
                : now.isEmpty() ? ExpressToastCopy.DETAIL_NO_TRACK
                : now.equals(pullRefreshBaseline) ? ExpressToastCopy.DETAIL_UP_TO_DATE
                : ExpressToastCopy.DETAIL_REFRESHED;
        manualPhoneTailRequired = false;
        localRefreshRiskControlUntil = 0L;
        localRefreshJoinedOrderAttempt = false;
        localRefreshSharedOrderOutcome = false;
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

    private void refreshLocalTimelineInBackground(boolean showProgress) {
        if (localRefreshInFlight) {
            // JD pulls share an in-flight page; a gesture must not queue a surprise retry after it ends.
            boolean sharesJdCapture = false;
            if (pullRefreshRequested && !localRefreshIsPull && item != null && allowsJingDongCapture(item)) {
                ExpressOrderProjectionRetryStore.AttemptToken active =
                        ExpressOrderProjectionRetryStore.activeAttempt(item);
                sharesJdCapture = active != null && active.claimedUntil > 0L;
            }
            localRefreshSharedOrderOutcome |= sharesJdCapture;
            pendingDetailPull |= pullRefreshRequested && !localRefreshIsPull && !sharesJdCapture;
            return;
        }
        if (!canRefreshLocalTimeline(item)) {
            if (detailSwipe != null) detailSwipe.setRefreshing(false);
            pullRefreshRequested = false;
            return;
        }
        if (!pullRefreshRequested) {
            if (detailEntryObserved || !usesNativeAutomaticDetail(item) || item.isShunFengSource()) {
                setLocalRefreshProgressVisible(false);
                return;
            }
            detailEntryObserved = true;
        }
        localRefreshInFlight = true;
        manualPhoneTailRequired = false;
        localRefreshRiskControlUntil = 0L;
        localRefreshJoinedOrderAttempt = false;
        localRefreshSharedOrderOutcome = false;
        int generation = ++localRefreshGeneration;
        ExpressItem requestItem = item;
        boolean detailPull = pullRefreshRequested;
        boolean explicitDetailPull = detailPull && !localRefreshRestart;
        String refreshTrigger = localRefreshRestart ? "foreground" : detailPull ? "detail_pull" : "detail_open";
        localRefreshIsPull = detailPull;
        ExpressQueryCancellation cancellation =
                new ExpressQueryCancellation(localRefreshBudgetMillis(requestItem));
        localRefreshCancellation = cancellation;
        AtomicInteger taskState = new AtomicInteger(0);
        localRefreshTaskState = taskState;
        setLocalRefreshProgressVisible(showProgress);
        try {
            localRefreshTask = worker.submit(() -> {
                if (!taskState.compareAndSet(0, 1)) return;
                ExpressRepository.ManualTimelinePollClaim claim = null;
                // The scope closes in finally, so the end event below keeps this flow's identity.
                ExpressLog.Scope diagnostics = ExpressLog.detailScope(
                        ExpressLog.newFlowId("detail"), refreshTrigger, detailLogInterface(requestItem));
                DetailRefreshEnd end = new DetailRefreshEnd(diagnostics, requestItem);
                try {
                    ExpressLog.write("detail.refresh.started", "waybillTail", tailOf(requestItem.displayWaybill()));
                    ExpressRepository repository = ExpressRepository.get(this);
                    cancellation.throwIfCancelled();
                    ExpressItem refreshedItem = repository.find(requestItem.rowId);
                    if (refreshedItem == null || !refreshedItem.waybill.equals(requestItem.waybill)
                            || !refreshedItem.stateOwner.equals(requestItem.stateOwner)
                            || !refreshedItem.sourceProvider.equals(requestItem.sourceProvider)) {
                        end.gate(refreshedItem == null ? "removed" : "state_changed");
                        return;
                    }
                    end.baseline(repository);
                    if (AccountCarrierRecognition.needsRecognition(refreshedItem)) {
                        AccountCarrierRecognition.recognize(repository, refreshedItem,
                                carrierRecognizer(refreshedItem, cancellation));
                        refreshedItem = repository.find(requestItem.rowId);
                        if (refreshedItem == null) {
                            end.gate("removed");
                            return;
                        }
                    }
                    ExpressItem cacheOwner = refreshedItem;
                    // An explicit pull can repair missing history without changing shared signed
                    // freezing or headline/status alignment. Complete history still stops the pull.
                    if (signedFrozen(repository, cacheOwner)
                            && (!detailPull || currentDetailComplete(cacheOwner))) {
                        end.gate(ExpressRepository.SIGNED_FROZEN);
                        renderRefreshedDetail(generation, refreshedItem);
                        return;
                    }
                    // A lagging JD web capture cannot be repaired by a background host. Detail entry
                    // retries its account query under the shared cap; an unchanged response stays unfinished.
                    boolean completeCache = shouldSkipCompleteCache(cacheOwner, currentDetailComplete(cacheOwner));
                    boolean webLagQuery = completeCache && !detailPull && claimWebLagEntryQuery(repository, cacheOwner);
                    if (completeCache && !webLagQuery) {
                        end.gate("complete_cache");
                        renderRefreshedDetail(generation, refreshedItem);
                        return;
                    }
                    if (usesNativeAutomaticDetail(requestItem)) {
                        ExpressRepository.StatusAlignmentProbe entryProbe = webLagQuery
                                ? repository.statusAlignmentProbe(cacheOwner) : null;
                        java.util.Map<String, Long> before = webLagQuery
                                ? repository.statusAlignmentEvidence(cacheOwner) : java.util.Collections.emptyMap();
                        try {
                            refreshedItem = refreshAutomaticDetail(repository, refreshedItem, cancellation,
                                    detailPull, explicitDetailPull);
                        } finally {
                            if (entryProbe != null) repository.finishStatusAlignment(cacheOwner,
                                    entryProbe.statusAt + "|" + entryProbe.headlineAt + "|" + entryProbe.detailAt, before);
                        }
                        if (refreshedItem == null) {
                            end.gate("state_changed");
                            return;
                        }
                        if (localRefreshJoinedOrderAttempt) {
                            renderRefreshedDetail(generation, refreshedItem);
                            return;
                        }
                        if (AccountCarrierRecognition.needsRecognition(refreshedItem)) {
                            AccountCarrierRecognition.recognize(repository, refreshedItem,
                                    carrierRecognizer(refreshedItem, cancellation));
                            refreshedItem = repository.find(requestItem.rowId);
                            if (refreshedItem == null) {
                                end.gate("removed");
                                return;
                            }
                        }
                    }
                    if (!detailPull) {
                        renderRefreshedDetail(generation, refreshedItem);
                        return;
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
                            && automaticSourcesHaveOrigin(repository, queryOwner)) {
                        renderRefreshedDetail(generation, queryOwner);
                        return;
                    }
                    cancellation.throwIfCancelled();
                    ExpressRepository.ManualQueryOwnerClaim ownerClaim = repository.captureManualQueryOwner(queryOwner);
                    if (ownerClaim == null) {
                        end.gate("state_changed");
                        return;
                    }
                    repository.activateCainiaoManualFallback(queryOwner, ownerClaim);
                    claim = repository.claimForegroundManualTimelinePoll(
                            queryOwner, System.currentTimeMillis(), detailPull);
                    if (claim == null) {
                        end.gate("refresh_claim_unavailable");
                        renderRefreshedDetail(generation, queryOwner);
                        return;
                    }
                    cancellation.throwIfCancelled();
                    ManualQueryCoordinator.Batch manualBatch = ManualQueryCoordinator.queryOnlineFirst(
                            null,
                            repository.manualTimelineCandidate(queryOwner, TimelineSlot.V6_QUERY),
                            null,
                            ManualQueryRoutingPolicy.includesMoto(queryOwner),
                            allowsPrimaryKuaidi100(queryOwner) && !currentDetailComplete(queryOwner)
                                    ? onlineResult -> ManualQueryCoordinator.forRow(() -> capturePrimaryKuaidi100(
                                    queryOwner, cancellation),
                                    ExpressLog.source(queryOwner.sourceProvider, queryOwner.manuallyAdded),
                                    ExpressLog.tail(queryOwner.displayWaybill()),
                                    ManualRoutePolicy.primaryH5Provider(queryOwner.displayCourierCode()),
                                    () -> stageDisplay(queryOwner),
                                    () -> primaryKuaidi100SkipReason(queryOwner)) : null,
                            null, queryOwner.semantic == StatusSemantic.UNKNOWN,
                            queryOwner.semantic == StatusSemantic.UNKNOWN && currentDetailComplete(queryOwner));
                    cancellation.throwIfCancelled();
                    ArrayList<ManualQuerySuccess> successes =
                            new ArrayList<>(manualBatch.successes);
                    for (int index = 0; index < successes.size(); index++) {
                        ManualQuerySuccess success = successes.get(index);
                        if (TimelineSlot.K100_H5.equals(TimelineSlot.normalize(success.provider))
                                || TimelineSlot.JT_H5.equals(TimelineSlot.normalize(success.provider))) {
                            successes.set(index, new ManualQuerySuccess(
                                    success.provider, success.result, success.successAt,
                                    timelineComplete(success.result)));
                        }
                    }
                    repository.saveClaimedManualQueryBatch(queryOwner, ownerClaim, successes,
                            queryOwner.phone, ExpressAccountSource.bindingSourceForOwner(
                                    queryOwner.stateOwner.isEmpty() ? queryOwner.source : queryOwner.stateOwner),
                            true, claim, cancellation);
                    if (manualPhoneTailRequired
                            && !phoneTailToastDue(repository.find(queryOwner.rowId))) {
                        manualPhoneTailRequired = false;
                    }
                    renderRefreshedDetail(generation, queryOwner);
                } catch (InterruptedException cancelled) {
                    end.interrupted();
                    Thread.currentThread().interrupt();
                } catch (Throwable failure) {
                    end.failed(failure);
                    // Keep the cached local timeline visible when every enabled source fails.
                    localRefreshFailed = true;
                    Log.w(MANUAL_LOG_TAG, "Refresh failed rowId="
                            + requestItem.rowId
                            + " error=" + failure.getClass().getSimpleName());
                    renderRefreshedDetail(generation, requestItem);
                } finally {
                    end.completed(ExpressRepository.get(this));
                    diagnostics.close();
                    ExpressRepository.get(this).releaseManualTimelinePoll(claim);
                    runOnUiThread(() -> finishLocalTimelineRefresh(generation));
                }
            });
            scheduleLocalRefreshTimeout(generation);
        } catch (RejectedExecutionException rejected) {
            cancellation.cancel();
            finishLocalTimelineRefresh(generation);
        }
    }

    /** {@link ExpressRepository#signedFrozen(ExpressItem)}; a failed read freezes nothing (the refresh goes on). */
    private static boolean signedFrozen(ExpressRepository repository, ExpressItem owner) {
        try {
            return repository.signedFrozen(owner);
        } catch (RuntimeException failure) {
            Log.w(MANUAL_LOG_TAG, "Signed freeze read failed: " + failure.getClass().getSimpleName());
            return false;
        }
    }

    private void renderRefreshedDetail(int generation, ExpressItem expected) {
        ExpressRepository repository = ExpressRepository.get(this);
        ExpressItem current = repository.find(expected.rowId);
        if (current == null) return;
        DetailState snapshot = new DetailState(repository, current, ExpressAccountSource.bindingSource(this));
        runOnUiThread(() -> {
            if (generation != localRefreshGeneration || isFinishing() || isDestroyed()
                    || current == null || item == null || item.rowId != expected.rowId
                    || !current.stateOwner.equals(expected.stateOwner)
                    || !current.sourceProvider.equals(expected.sourceProvider)) return;
            item = current;
            detailState = snapshot;
            ((ImageView) findViewById(R.id.detail_icon)).setImageResource(item.displayIconResource());
            renderHeader(item.displayCourierCode(), item.displayCompany(), item.displayWaybill(),
                    item.displayStatus(), item.semantic);
            ManualTimelineAuthorityPolicy.Candidate selected = snapshot.selected;
            ExpressQueryResult detail = selected == null ? snapshot.source : snapshot.displayed;
            rememberDisplayedProvider(selected == null
                    ? ManualTimelineAuthorityPolicy.PREFERRED_FEED : selected.provider);
            renderTimeline(ExpressTimeline.parse(detail == null
                    ? snapshot.withAttachedOrderStage(item.tracksJson) : detail.tracksJson,
                    detail == null ? item.latestTime : detail.latestTime,
                    detail == null ? item.latestDetail : detail.latestDetail));

        });
    }

    static boolean automaticSourcesHaveOrigin(ExpressRepository repository, ExpressItem owner) {
        if (owner == null || owner.manuallyAdded || "ShunFeng".equalsIgnoreCase(owner.sourceProvider)) return false;
        if (Kuaidi100TimelinePolicy.hasPickupEvidence(repository.automaticSourceTimeline(owner))) return true;
        String provider = owner.isCainiaoSource() ? TimelineSlot.CN_H5 : TimelineSlot.JD_H5;
        ManualTimelineAuthorityPolicy.Candidate h5 = repository.manualTimelineCandidate(owner, provider);
        // 用户采纳 2026-09-24：光有揽收节点的缓存 H5 包不能挡手动链，还得详情选包自己也判它完整。Pixel 上 Pipi 实测
        // （三端同逻辑）的顺丰承运京东单：jd_h5 有「顺丰速运 已收取快件」却停在 16:16、列表已到 17:21，选包不显示它，
        // K100 又因为它从不跑，历史永远补不全。
        return h5 != null && Kuaidi100TimelinePolicy.hasTimedTracking(h5.result)
                && Kuaidi100TimelinePolicy.hasPickupEvidence(h5.result)
                && repository.detailRanksPackageComplete(owner, provider);
    }

    private ExpressItem refreshAutomaticDetail(ExpressRepository repository, ExpressItem expected,
            ExpressQueryCancellation cancellation, boolean detailPull, boolean explicitDetailPull) throws Exception {
        if (allowsJingDongCapture(expected) && expected.isAccountOrder()
                && expected.projectedWaybill.isEmpty()) {
            // T23（用户 2026-09-26，其余裁决 28）：已经知道的运单号（feed 文案、已存 v5_query 文案、暂存的京粉页）
            // 先识别承运商，对上才投影；对不上这一票保持原样、不推送。
            ExpressRepository.PendingProjection pending = repository.pendingProjection(expected);
            if (pending != null && AccountCarrierRecognition.projectPending(repository, expected,
                    pending, carrierRecognizer(expected, cancellation), cancellation)) {
                expected = repository.find(expected.rowId);
                if (expected == null) return null;
            }
        }
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(expected);
        if (claim == null) return null;
        String bindingSource = ExpressAccountSource.bindingSourceForOwner(
                expected.stateOwner.isEmpty() ? expected.source : expected.stateOwner);
        String bindingGeneration = repository.bindingGeneration(expected.phone, bindingSource);
        if (!detailPull && usesInterface5Automatic(expected)
                && !"ShunFeng".equalsIgnoreCase(expected.sourceProvider)) {
            try (ExpressQueryCancellation stage = cancellation.child(10_000L)) {
                ExpressQueryResult query = new ExpressDiscoveryClient().refreshKnown(
                        getApplicationContext(), expected, true, stage);
                cancellation.throwIfCancelled();
                if (query != null) {
                    repository.saveRecoveredOwnerRoute(expected, claim, query);
                    // T23 entry E: the waybill the reply's text names projects only with its carrier; a
                    // recognition cut off by the budget still saves the reply, unprojected.
                    String textCarrier;
                    try {
                        textCarrier = AccountCarrierRecognition.queryTextCarrier(
                                expected, query, carrierRecognizer(expected, cancellation));
                    } catch (InterruptedException cutOff) {
                        textCarrier = null;
                    }
                    boolean committed = repository.saveInterface5Query(
                            query, expected, bindingGeneration, textCarrier);
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
        if (!detailPull && !usesInterface5Automatic(expected) && expected.isCainiaoSource()
                && safeCainiaoUrl(expected).isEmpty()) {
            // Interface 6 can recover only its own route through its established account adapter.
            for (ExpressQueryResult response : new ExpressSubscriptionClient().query(
                    getApplicationContext(), cancellation)) {
                cancellation.throwIfCancelled();
                if (repository.saveRecoveredOwnerRoute(expected, claim, response)) break;
            }
        }
        if (!repository.ownsManualQuery(expected, claim)) return null;
        ExpressItem owner = repository.find(expected.rowId);
        if (owner == null) return null;
        if (!detailPull && (!owner.isAccountOrder() || !owner.projectedWaybill.isEmpty())) return owner;
        if ((!owner.isAccountOrder() || !owner.projectedWaybill.isEmpty())
                && currentDetailComplete(owner)) {
            logAutomaticH5Decision(owner, "skipped", "pickup_or_complete_cache");
            return owner;
        }
        ExpressQueryResult feed = repository.automaticSourceTimeline(owner);
        boolean missingIdentity = owner.isAccountOrder() && owner.projectedWaybill.isEmpty();
        // 走到这里详情已判为不完整（完整的在上面按缓存返回了）。
        boolean signedHistoryGap = detailPull && signedJingDongHistoryGap(owner, feed,
                repository.manualTimelineCandidate(owner, TimelineSlot.JD_H5), false,
                repository.signedUnionPageUsed(owner));
        if (!missingIdentity && !signedHistoryGap && Kuaidi100TimelinePolicy.hasPickupEvidence(feed)) {
            logAutomaticH5Decision(owner, "skipped", "feed_pickup");
            return owner;
        }
        boolean cainiao = owner.isCainiaoSource();
        boolean jingDong = "JingDong".equalsIgnoreCase(owner.sourceProvider);
        if (jingDong && !allowsJingDongCapture(owner)) return owner;
        if (missingIdentity && repository.pendingProjection(owner) != null) {
            // T23: this order already knows its waybill and only waits for the carrier; no page for it.
            logAutomaticH5Decision(owner, "skipped", "carrier_pending");
            return owner;
        }
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
        // 用户 2026-09-25 同意（方案 A）：进详情取号不再重开京粉页已确认是空壳的已完成订单；用户下拉照旧。
        if (retries != null && !detailPull && retries.pageConfirmedEmpty(owner)) {
            logAutomaticH5Decision(owner, "skipped", "empty_order_page");
            return owner;
        }
        long attemptAt = System.currentTimeMillis();
        ExpressOrderProjectionRetryStore.TimelineAttempt attempt = jingDong && explicitDetailPull
                ? retries.beginOrJoinTimelineAttempt(owner, attemptAt) : null;
        ExpressOrderProjectionRetryStore.AttemptToken token = !jingDong ? null : attempt != null
                ? attempt.token : retries.beginTimelineAttempt(owner, attemptAt);
        if (attempt != null && attempt.joined) {
            logAutomaticH5Decision(owner, "skipped", "active_attempt");
            localRefreshJoinedOrderAttempt = true;
            localRefreshSharedOrderOutcome = true;
            try { token.awaitCompletion(cancellation); }
            catch (InterruptedException interrupted) {
                localRefreshFailed = true;
                throw interrupted;
            }
            long settledAt = System.currentTimeMillis();
            long riskRemaining = retries.riskControlRemainingMillis(owner, settledAt);
            if (riskRemaining > 0L) localRefreshRiskControlUntil = settledAt + riskRemaining;
            return repository.find(expected.rowId);
        }
        if (jingDong && token == null) {
            String reason = retries.timelineSkipReason(owner, attemptAt);
            if (reason != null) logAutomaticH5Decision(owner, "skipped", reason);
            if ((explicitDetailPull || localRefreshSharedOrderOutcome) && "risk_control_cooldown".equals(reason)) {
                localRefreshRiskControlUntil = attemptAt + retries.riskControlRemainingMillis(owner, attemptAt);
            }
            return repository.find(expected.rowId);
        }
        logAutomaticH5Decision(owner, "started",
                signedHistoryGap ? "signed_history_gap" : "source_history_incomplete");
        try {
            ExpressAutomaticTimelineCapture.Result result;
            try {
                result = ExpressAutomaticTimelineCapture.capture(this,
                        owner, route, cainiao ? TimelineSlot.CN_H5 : TimelineSlot.JD_H5, cancellation);
            } catch (InterruptedException cancelled) {
                // 用户 2026-09-28：a capture cut off by the page stopping (or the refresh's deadline) still
                // ends its stage; the order's cooldown was claimed before the page opened and stays spent.
                logAutomaticH5Decision(owner, "failed", "cancelled");
                throw cancelled;
            }
            logAutomaticH5Decision(owner, result != null && result.timeline != null ? "succeeded" : "failed",
                    result != null && result.timeline != null ? "timeline_received" : "no_result");
            cancellation.throwIfCancelled();
            if (result != null && result.throttled && retries != null) {
                long riskControlAt = System.currentTimeMillis();
                retries.recordTimelineRateLimit(owner, riskControlAt);
                if (explicitDetailPull || localRefreshSharedOrderOutcome) {
                    localRefreshRiskControlUntil = riskControlAt
                            + retries.riskControlRemainingMillis(owner, riskControlAt);
                } else runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) Toast.makeText(this,
                            ExpressToastCopy.JD_RISK_CONTROL, Toast.LENGTH_SHORT).show();
                });
            }
            if (retries != null) retries.recordPage(owner, result, System.currentTimeMillis());
            // 优化 1（用户 2026-10-03「这轮就统一」）：已签收的行，京粉页有了回答就用掉这一代（完成时间 T）的那一次。
            if (jingDong && unionPageAnswered(result)) repository.recordSignedUnionPage(owner);
            if (result != null && result.timeline != null) {
                // T23 entry F: the page's waybill projects only with a matched carrier; otherwise it is
                // held (row unchanged, no further page) until a later round matches it.
                if (!AccountCarrierRecognition.savePageCapture(repository, expected, claim,
                        result.timeline, result.complete, carrierRecognizer(expected, cancellation),
                        cancellation)) return null;
            }
        } finally { if (retries != null) retries.endAttempt(token); }
        return repository.find(expected.rowId);
    }

    /**
     * Recognition for one row; 京东 is skipped on a JD-platform row's non-JD waybill (R-20, T23 ②). It
     * waits no longer than what is left of this operation's recognition budget (see
     * {@link #recognitionBudgets}); once that is spent the row stays held and the operation goes on.
     */
    private AccountCarrierRecognition.Recognizer carrierRecognizer(
            ExpressItem owner, ExpressQueryCancellation cancellation) {
        // 优化 5: the paid level carries this row's reuse anchor.
        ExpressApi api = new ExpressApi(getApplicationContext())
                .forParcel(AccountCarrierRecognition.parcelAnchor(ExpressRepository.get(this), owner));
        AccountCarrierRecognition.Budget budget = recognitionBudgets.computeIfAbsent(
                cancellation, ignored -> new AccountCarrierRecognition.Budget());
        return AccountCarrierRecognition.bounded(budget, waybill -> api.recognizeCarrier(waybill,
                cancellation, AccountCarrierRecognition.excludesJd(owner, waybill)));
    }

    /**
     * A detail refresh's end event (user 2026-09-28, iOS / Pipi names and meanings):
     * {@code detail.refresh.committed} when what the page shows changed, {@code detail.refresh.skipped}
     * with the reason when it did not (iOS's removed / state_changed / complete_cache / unchanged /
     * query_failed / empty_response / not_attempted, Pipi's refresh_claim_unavailable, and
     * {@code interrupted} for a cancelled flow as Pipi), and {@code detail.refresh.failed} with the
     * failure's category when the flow threw. Logging never changes the refresh itself.
     */
    static final class DetailRefreshEnd {
        private final ExpressLog.Scope scope;
        private final ExpressItem owner;
        private final long startedAt = System.currentTimeMillis();
        private ExpressRepository.DetailPresentation before;
        private String gate;
        private boolean ended;

        DetailRefreshEnd(ExpressLog.Scope scope, ExpressItem owner) {
            this.scope = scope;
            this.owner = owner;
        }

        void baseline(ExpressRepository repository) {
            try {
                before = repository.detailPresentation(owner);
            } catch (RuntimeException ignored) { /* diagnostics only */ }
        }

        /** Why the flow stopped early; the end event still reports a change made before it stopped. */
        void gate(String reason) {
            if (gate == null) gate = reason;
        }

        void interrupted() {
            skipped("interrupted");
        }

        void failed(Throwable failure) {
            if (ended) return;
            ended = true;
            ExpressLog.write("detail.refresh.failed", ExpressLog.errorDetails(failure,
                    "waybillTail", ExpressLog.tail(owner.displayWaybill()), "result", "failed",
                    "persisted", false, "durationMs", System.currentTimeMillis() - startedAt));
        }

        void completed(ExpressRepository repository) {
            if (ended) return;
            try {
                ExpressRepository.DetailPresentation after = before == null ? null
                        : repository.detailPresentation(owner);
                if (after != null && after.differsFrom(before)) {
                    ended = true;
                    ExpressLog.write("detail.refresh.committed",
                            "waybillTail", ExpressLog.tail(owner.displayWaybill()), "result", "committed",
                            "persisted", true, "durationMs", System.currentTimeMillis() - startedAt,
                            "detailTimelineProvider", after.provider,
                            "detailEffectiveTrackCount", after.effectiveTrackCount);
                    return;
                }
                if (gate == null && before != null && after == null) {
                    gate = repository.find(owner.rowId) == null ? "removed" : "state_changed";
                }
            } catch (RuntimeException ignored) { /* diagnostics only */ }
            skipped(gate != null ? gate : scope.unchangedReason());
        }

        private void skipped(String reason) {
            if (ended) return;
            ended = true;
            ExpressLog.write("detail.refresh.skipped",
                    "waybillTail", ExpressLog.tail(owner.displayWaybill()), "result", reason,
                    "skipReason", reason, "persisted", false,
                    "durationMs", System.currentTimeMillis() - startedAt);
        }
    }

    /**
     * The row's fields a provider stage line carries (用户 2026-09-28; iOS shipmentDiagnosticDetails): whether it
     * is automatic, its carrier, its route kind (a trusted same-owner Cainiao route, a Meizu web route, or none —
     * iOS ShipmentRoute), how its detail is shown now, its feed clock and its presented status.
     */
    private ManualQueryCoordinator.RowDisplay stageDisplay(ExpressItem owner) {
        ExpressRepository repository = ExpressRepository.get(this);
        ExpressItem row = repository.find(owner.rowId);
        if (row == null) return null;
        ExpressRepository.DetailPresentation shown = repository.detailPresentation(owner);
        ExpressQueryResult feed = row.manuallyAdded ? null : repository.automaticSourceTimeline(owner);
        me.pipi.deliveries.model.WorkerStatusProjection status =
                me.pipi.deliveries.model.WorkerStatusProjection.cached(row.tracksJson);
        String routeKind = !safeCainiaoUrl(row).isEmpty() ? "cainiao"
                : !repository.meizuManualDetailUrl(owner).isEmpty() ? "web" : "none";
        return new ManualQueryCoordinator.RowDisplay(!row.manuallyAdded,
                row.displayCourierCode().toUpperCase(java.util.Locale.ROOT), routeKind,
                shown == null ? "" : shown.provider, shown == null ? 0 : shown.effectiveTrackCount,
                shown == null ? 0L : shown.latestEventAtMs, shown == null ? 0L : shown.latestTrackAtMs,
                feed == null ? 0L : Math.max(feed.statusEventTime, Kuaidi100TimelinePolicy.latestTimedEventMillis(feed)),
                row.statusEventTime, String.valueOf(row.semantic), status != null && status.structured);
    }

    private void logAutomaticH5Decision(ExpressItem owner, String event, String reason) {
        ExpressLog.line(detailLogInterface(owner), owner.isCainiaoSource() ? "cn_h5" : "jd_h5",
                ExpressLog.source(owner.sourceProvider, false), event,
                "tail", ExpressLog.tail(owner.displayWaybill()), "reason", reason);
    }

    /**
     * Why the primary H5 page will not be opened for this row ({@code invalid_waybill}, {@code cooldown}),
     * or "" when it will: the same checks {@link #capturePrimaryKuaidi100} makes before opening it, read
     * without side effects so the stage is logged as skipped rather than as an empty answer.
     */
    private String primaryKuaidi100SkipReason(ExpressItem owner) {
        String route = ManualRoutePolicy.primaryH5Url(owner.displayWaybill(), owner.displayCourierCode());
        if (route.isEmpty()) return "invalid_waybill";
        return ExpressKuaidi100CaptureCooldown.due(this,
                ManualRoutePolicy.primaryH5Provider(owner.displayCourierCode()), owner.displayWaybill(),
                primaryKuaidi100Phones(owner), System.currentTimeMillis()) ? "" : "cooldown";
    }

    private List<String> primaryKuaidi100Phones(ExpressItem owner) {
        return ExpressKuaidi100TimelineCapture.phoneCandidates(owner.phone,
                ExpressRepository.get(this).phoneCandidates("", owner.manuallyAdded ? ""
                        : ExpressAccountSource.bindingSourceForOwner(
                                owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner)));
    }

    private ExpressQueryResult capturePrimaryKuaidi100(
            ExpressItem owner, ExpressQueryCancellation cancellation) throws InterruptedException {
        String provider = ManualRoutePolicy.primaryH5Provider(owner.displayCourierCode());
        List<String> phones = primaryKuaidi100Phones(owner);
        String route = ManualRoutePolicy.primaryH5Url(owner.displayWaybill(), owner.displayCourierCode());
        if (route.isEmpty()) {
            ExpressLog.line("", provider, "", "skipped",
                    "tail", ExpressLog.tail(owner.displayWaybill()), "reason", "invalid_waybill");
            return null;
        }
        if (!ExpressKuaidi100CaptureCooldown.due(this, provider, owner.displayWaybill(), phones,
                System.currentTimeMillis())) {
            ExpressLog.line("", provider, "", "skipped",
                    "tail", ExpressLog.tail(owner.displayWaybill()), "reason", "cooldown");
            return null;
        }
        ExpressKuaidi100CaptureCooldown.record(this, provider, owner.displayWaybill(), phones, System.currentTimeMillis());
        ExpressAutomaticTimelineCapture.Result result = ExpressAutomaticTimelineCapture.capture(this,
                owner, route, provider, phones, cancellation);
        if (owner.manuallyAdded && result != null && result.phoneRequired) manualPhoneTailRequired = true;
        return result == null ? null : result.timeline;
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
                + (usesNativeAutomaticDetail(owner) ? 10_000L + ORDER_CAPTURE_TIMEOUT_MS : 0L);
    }

    private void finishLocalTimelineRefresh(int generation) {
        if (generation != localRefreshGeneration) return;
        localRefreshInFlight = false;
        localRefreshTask = null;
        localRefreshCancellation = null;
        localRefreshTaskState = null;
        clearLocalRefreshTimeout();
        if (pendingDetailPull) {
            pendingDetailPull = false;
            refreshLocalTimelineInBackground(true);
            return;
        }
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
        pendingDetailPull = false;
        restartLocalRefreshOnStart |= restartOnStart;
        ExpressQueryCancellation cancellation = localRefreshCancellation;
        Future<?> task = localRefreshTask;
        AtomicInteger taskState = localRefreshTaskState;
        localRefreshCancellation = null;
        localRefreshTask = null;
        localRefreshTaskState = null;
        clearLocalRefreshTimeout();
        setLocalRefreshProgressVisible(false);
        if (detailSwipe != null) detailSwipe.setRefreshing(false);
        if (!restartOnStart && timelineLoadingPlaceholder) {
            renderTimeline(java.util.Collections.emptyList());
        }
        if (cancellation != null) cancellation.cancel();
        if (taskState != null) taskState.compareAndSet(0, 2);
        if (task != null) task.cancel(true);
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
        statusView.setTextColor(ExpressStatusColors.textOn(statusColor(semantic),
                com.google.android.material.color.MaterialColors.getColor(statusView,
                        com.google.android.material.R.attr.colorSurface)));
        ExpressSenderBadge.apply(findViewById(R.id.detail_sender),
                item != null && item.sender, statusColor(semantic));
        // 其余裁决 35：承运商为空时统一写「快递」；热线仍按原来的承运商名查。
        waybillView.setText(getString(R.string.express_company_waybill,
                ExpressItem.carrierLabel(company), waybill));
        waybillView.setOnClickListener(view -> copyWaybill(waybill));
        ViewCompat.replaceAccessibilityAction(waybillView,
                AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_CLICK,
                getString(R.string.copy_waybill), null);
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
        ViewCompat.replaceAccessibilityAction(hotlineView,
                AccessibilityNodeInfoCompat.AccessibilityActionCompat.ACTION_CLICK,
                getString(R.string.call_carrier), null);
    }

    private void copyWaybill(String waybill) {
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        if (clipboard == null) {
            Toast.makeText(this, ExpressToastCopy.COPY_FAILED, Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            clipboard.setPrimaryClip(ClipData.newPlainText(
                    getString(R.string.copy_waybill), waybill));
        } catch (RuntimeException unavailable) {
            Toast.makeText(this, ExpressToastCopy.COPY_FAILED, Toast.LENGTH_SHORT).show();
            return;
        }
        Toast.makeText(this, ExpressToastCopy.WAYBILL_COPIED, Toast.LENGTH_SHORT).show();
    }

    /** 粘性选包（用户定 2026-09-05 晚）：记住这次详情页显示的是哪个包，下一轮默认还显示它。 */
    private void rememberDisplayedProvider(String provider) {
        if (item == null || previewResult != null || provider == null
                || provider.trim().isEmpty()) return;
        ExpressItem displayed = item;
        worker.execute(() -> ExpressRepository.get(this).rememberDetailSelection(displayed, provider));
    }

    private void renderTimeline(List<ExpressTimeline.Track> tracks) {
        timelineLoadingPlaceholder = false;
        renderedTimelineSignature = timelineSignature(tracks);
        timeline.removeAllViews();
        if (tracks.isEmpty()) {
            TextView empty = textView(R.string.no_logistics, 14f, secondaryTextColor());
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
        TextView loading = textView(textResource, 14f, secondaryTextColor());
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
        int secondary = secondaryTextColor();
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
        TextView time = textView(clock, 15f, latest ? primary : secondary);
        time.setIncludeFontPadding(false);
        timeColumn.addView(time);
        TextView day = textView(date, 10.5f, secondary);
        day.setPadding(0, dp(2), 0, 0);
        timeColumn.addView(day);
        row.addView(timeColumn, new LinearLayout.LayoutParams(
                dp(66), ViewGroup.LayoutParams.WRAP_CONTENT));
        row.addView(buildIndicator(latest, last), new LinearLayout.LayoutParams(
                dp(28), ViewGroup.LayoutParams.MATCH_PARENT));
        TextView detail = textView(track.displayDetail, 15.5f, latest ? primary : secondary);
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

    private int secondaryTextColor() {
        return MaterialColors.getColor(timeline,
                com.google.android.material.R.attr.colorOnSurfaceVariant);
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
        detailStarted = false;
        cancelInitialDetailLoad();
        cancelFirstManualQuery();
        if (presentationCancellation != null) presentationCancellation.cancel();
        presentationCancellation = null;
        restartLocalRefreshOnStart = false;
        if (localRefreshInFlight) {
            cancelLocalTimelineRefresh(localRefreshGeneration, false);
        } else {
            localRefreshGeneration++;
            clearLocalRefreshTimeout();
            setLocalRefreshProgressVisible(false);
        }
        worker.shutdown();
        if (kuaidi100Capture != null) {
            kuaidi100Capture.cancel();
            kuaidi100Capture = null;
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
    private boolean renderInterface5AccountTimeline(DetailState snapshot) {
        if (!usesInterface5Automatic(item)) return false;
        ManualTimelineAuthorityPolicy.Candidate selected = snapshot.selected;
        ExpressQueryResult detail = selected == null ? snapshot.source : snapshot.displayed;
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
        ExpressQueryResult byDisplay = repository.accountTimeline(item, waybill, source);
        if (item == null || !item.isAccountOrder()
                || Kuaidi100TimelinePolicy.hasTimedTracking(byDisplay)) return byDisplay;
        String orderId = item.waybill == null ? "" : item.waybill.trim();
        if (orderId.isEmpty() || orderId.equalsIgnoreCase(waybill)) return byDisplay;
        ExpressQueryResult byOrder = repository.accountTimeline(item, orderId, source);
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

    static boolean usesNativeAutomaticDetail(ExpressItem value) {
        return usesInterface5Automatic(value)
                || value != null && !value.manuallyAdded && value.isCainiaoSource();
    }

    static boolean canRefreshLocalTimeline(ExpressItem value) {
        return value != null
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
        if (previewSaveInFlight) return;
        if (persistPreviewOnFinish && !previewPersisted
                && previewResult != null && !previewResult.waybill.isEmpty()) {
            previewSaveInFlight = true;
            ExpressQueryResult result = previewResult;
            String phone = previewPhone;
            String bindingSource = previewBindingSource;
            worker.execute(() -> {
                try {
                    ExpressRepository repository = ExpressRepository.get(getApplicationContext());
                    if (Kuaidi100TimelinePolicy.hasTimedTracking(result)) {
                        repository.saveManualQueryResult(result, phone, bindingSource);
                    } else if (repository.enqueuePendingManual(result, phone, bindingSource)) {
                        ExpressScheduler.ensureScheduled(getApplicationContext());
                    }
                    runOnUiThread(() -> {
                        previewSaveInFlight = false;
                        previewPersisted = true;
                        ExpressDetailActivity.super.finish();
                    });
                } catch (RuntimeException failure) {
                    runOnUiThread(() -> {
                        previewSaveInFlight = false;
                        if (!isDestroyed()) Toast.makeText(this,
                                ExpressToastCopy.MANUAL_QUERY_FAILED, Toast.LENGTH_SHORT).show();
                    });
                }
            });
            return;
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

    static boolean allowsJingDongCapture(ExpressItem item) {
        return allowsJingDongRoute(item);
    }

    /**
     * 京东件签收那一条常是被拦掉的评价文案（或者根本没有节点），feed 虽然早有揽收，显示的历史却停在
     * 「派送中」，签收节点只在京粉页里。已签收（结构化、带完成时间）、已有真实运单号且详情判为不完整时，
     * 详情下拉放行一次京粉页；手动链照旧被揽收挡住。Pipi ExpressPoller.signedJdHistoryGap
     * 是用户 2026-09-24 定的，这里与 iOS jingDongSignedHistoryGap 按三端同口径跟上。
     *
     * <p>一次完成只放行一次：京东的完成包可能在真正签收几天后才到（自动确认收货），京粉页里最新的签收节点离完成
     * 时间太远，详情一直判不完整；已经有一个在完成时间当时或之后抓的京粉页包（successAt ≥ 完成时间）时，再抓也
     * 不会有更新的节点，就不再放行（2026-09-24）。</p>
     *
     * <p>优化 1（用户 2026-10-03「这轮就统一」）：这一次记在这一行持久化的签收后台账里，按完成时间 T 分代
     * （{@code usedForCompletion}，{@link ExpressRepository#signedUnionPageUsed}）。页面有了回答就算用掉——带节点的包、只抓到
     * 部分包、没有节点的空壳都算；网络失败、超时、风控与冷却跳过不算。</p>
     */
    public static boolean signedJingDongHistoryGap(ExpressItem owner, ExpressQueryResult feed,
            ManualTimelineAuthorityPolicy.Candidate unionPage, boolean detailComplete) {
        return signedJingDongHistoryGap(owner, feed, unionPage, detailComplete, false);
    }

    public static boolean signedJingDongHistoryGap(ExpressItem owner, ExpressQueryResult feed,
            ManualTimelineAuthorityPolicy.Candidate unionPage, boolean detailComplete,
            boolean usedForCompletion) {
        if (owner == null || detailComplete || usedForCompletion || owner.manuallyAdded
                || !owner.isJingDongSource()
                || owner.semantic != StatusSemantic.COMPLETED || owner.statusEventTime <= 0L
                || owner.isAccountOrder() && owner.projectedWaybill.isEmpty()) return false;
        if (unionPage != null && unionPage.successAt >= owner.statusEventTime) return false;
        me.pipi.deliveries.model.WorkerStatusProjection projected =
                me.pipi.deliveries.model.WorkerStatusProjection.cached(owner.tracksJson);
        return projected != null && projected.structured
                && projected.matches(owner.semantic, owner.statusEventTime)
                && Kuaidi100TimelinePolicy.hasPickupEvidence(feed);
    }

    /**
     * 优化 1：京粉页这一次有了回答——抓到带节点的包（完整或只抓到部分），或者页面完整加载、什么物流都没有的空壳（与空壳记号
     * {@code ExpressOrderProjectionRetryStore.recordPage} 同一口径），或者见到了带物流的东西。风控、加载失败、没加载完就超时、
     * 被取消都不是回答（被取消的抓取调用方根本走不到这里）。
     */
    static boolean unionPageAnswered(ExpressAutomaticTimelineCapture.Result result) {
        return result != null && !result.throttled
                && (result.timeline != null || result.emptyPage || result.logisticsSeen);
    }

    static boolean allowsPrimaryKuaidi100(ExpressItem item) {
        return canRefreshLocalTimeline(item)
                && (!item.isAccountOrder() || !item.projectedWaybill.isEmpty());
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
