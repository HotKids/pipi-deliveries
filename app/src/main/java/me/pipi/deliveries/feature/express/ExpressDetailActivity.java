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
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.color.MaterialColors;
import com.google.android.material.progressindicator.LinearProgressIndicator;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicInteger;

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
import me.pipi.deliveries.network.ExpressApi;
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
    static final long ORDER_CAPTURE_WAIT_TIMEOUT_MS = 25_000L;
    private static final int JINGDONG_FULL_PROGRESS_MAX_ATTEMPTS = 7;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private WebView webView;
    private boolean webNativeFallbackStarted;
    private int jingDongFullProgressAttempts;
    private boolean jingDongFullProgressExpanded;
    private boolean jingDongFullProgressAttemptInFlight;
    private String visibleJingDongDetailUrl = "";
    private WebView orderCaptureWebView;
    private ExpressKuaidi100TimelineCapture kuaidi100Capture;
    private ExpressOrderProjectionRetryStore orderProjectionRetries;
    private ExpressItem orderProjectionAttemptOwner;
    private ExpressOrderProjectionRetryStore.AttemptToken orderProjectionAttemptToken;
    private ExpressOrderProjectionRetryStore.WaitToken orderProjectionWaitToken;
    private Runnable orderProjectionWaitWakeup;
    private Runnable orderProjectionWaitTimeout;
    private int orderProjectionWaitGeneration;
    private final ExpressDelayedCallbackRegistry orderCaptureCallbacks =
            new ExpressDelayedCallbackRegistry();
    private boolean orderProjectionCaptureEnabled;
    private boolean detailIdentityProjectionAttempted;
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
        if (!cainiaoUrl.isEmpty()) {
            showCainiaoWebDetail(cainiaoUrl);
        } else {
            String jingDongUrl = transientPickerPreview ? "" : safeOrderH5Url(item);
            if (!jingDongUrl.isEmpty() && prefersAccountTimeline(item)) {
                // 用户定 2026-09-05：京东来源的详情**优先展示接口 5 按件详情拉回的轨迹**（订单号查
                // `/v2/query`，能拉全量），联合页只在那条什么都没给时兜底。进页先原生，随即主动拉。
                me.pipi.deliveries.network.ExpressLog.line(
                        detailLogInterface(item), "detail", "", "selected",
                        "tail", tailOf(item.displayWaybill()), "branch", "native_v5_first");
                unionPageFallbackUrl = jingDongUrl;
                showNativeDetail();
                // 缓存优先：已缓存的按件详情完整（有时间节点且有揽收）就不再打；不完整或没有才立刻
                // 拉一次。下拉刷新不受此限（用户定 2026-09-05）。
                ExpressQueryResult cachedAccount = accountTimelineFor(
                        ExpressRepository.get(this), item, item.displayWaybill(), "interface5");
                boolean cachedComplete = Kuaidi100TimelinePolicy.hasTimedTracking(cachedAccount)
                        && Kuaidi100TimelinePolicy.hasPickupEvidence(cachedAccount);
                me.pipi.deliveries.network.ExpressLog.line(
                        "v5", "v5_query", "", cachedComplete ? "skipped" : "started",
                        "tail", tailOf(item.displayWaybill()),
                        "reason", cachedComplete ? "complete_cache" : "incomplete_cache");
                if (!cachedComplete) refreshLocalTimeline(true);
            } else if (!jingDongUrl.isEmpty()) {
                showJingDongWebDetail(jingDongUrl);
            } else {
                // 手动查件提交后自动进的这次详情（transient picker 预览）同样要**直接打开
                // picker 返回的 K100 H5**——表格里手动件详情页就是这一页。预览关掉的是菜鸟/京东
                // 那种归属来源的路由，不是这一条：kuaidi100FallbackUrl() 本来就认 previewResult
                // 里 meizu 的 detailUrl。
                // 用户定 2026-09-05（傍晚）：手动件/顺丰件的详情不再一进来就开 K100 网页。优先级是
                // picker 增量 → K100 H5 本地抓取 → K100 H5 网页兜底，见 ensureKuaidi100Presentation。
                me.pipi.deliveries.network.ExpressLog.line(
                        detailLogInterface(item), "detail", "", "selected",
                        "tail", tailOf(item.displayWaybill()), "branch", "native");
                showNativeDetail();
                if (previewResult != null) {
                    ensureKuaidi100Presentation(previewResult, "preview");
                }
            }
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { navigateBack(); }
        });
    }

    @Override protected void onStop() {
        orderProjectionCaptureEnabled = false;
        cancelOrderProjectionWait();
        if (localRefreshInFlight) {
            cancelLocalTimelineRefresh(localRefreshGeneration, !isFinishing());
        } else {
            setLocalRefreshProgressVisible(false);
        }
        if (orderCaptureWebView != null) {
            disposeOrderCapture(orderCaptureWebView);
        }
        if (detailSwipe != null) detailSwipe.setRefreshing(false);
        super.onStop();
    }

    @Override protected void onStart() {
        super.onStart();
        orderProjectionCaptureEnabled = true;
        startOrderProjectionCaptureIfDue();
        if (restartLocalRefreshOnStart) {
            restartLocalRefreshOnStart = false;
            restartLocalTimelineRefreshIfNeeded();
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
            if (renderInterface5AccountTimeline(repository)) return;
            if (renderManualTimelineAuthority(repository, true)) {
                // 进详情先跑一次 picker 增量（已完整时 refreshLocalTimeline 自己按 complete_cache 跳过），
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
        if (renderInterface5AccountTimeline(repository)) return;
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
        return value != null && value.usesSourceManualTakeover()
                && (!value.isAccountOrder() || !value.projectedWaybill.isEmpty());
    }

    /**
     * 手动件 / 顺丰件详情的展示链（用户定 2026-09-05）：picker 增量 → K100 H5 本地抓取 → K100 H5 网页
     * 兜底。本地已有完整轨迹（有时间节点且到了起点）就停在原生详情；否则在隐藏 WebView 里抓 picker
     * 给的 K100 页，抓到完整轨迹就存进本件的 K100 槽并原生渲染；抓不到、或只抓到半截，才开网页。
     */
    private void ensureKuaidi100Presentation(ExpressQueryResult localDetail, String reason) {
        if (item == null || isFinishing() || isDestroyed() || webView != null) return;
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
                this, route, (finished, tracksJson) -> {
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
            ExpressItem target, ExpressQueryResult captured, boolean render) {
        String owner = target.stateOwner.isEmpty() ? target.source : target.stateOwner;
        String bindingSource = ExpressAccountSource.bindingSourceForOwner(owner);
        try {
            worker.execute(() -> {
                ExpressRepository repository = ExpressRepository.get(this);
                try {
                    repository.saveOwnerManualTimeline(
                            target, captured, target.phone, bindingSource);
                } catch (Throwable failure) {
                    Log.w(MANUAL_LOG_TAG, "K100 capture persist failed rowId="
                            + target.rowId + " error=" + failure.getClass().getSimpleName());
                }
                if (!render) return;
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
        return kuaidi100FallbackUrl(false);
    }

    private String kuaidi100FallbackUrl(boolean afterJingDongFailure) {
        ExpressRepository repository = ExpressRepository.get(this);
        ExpressItem owner = item;
        if (previewResult != null) {
            ExpressItem persisted = repository.findByWaybill(
                    previewResult.waybill, previewBindingSource);
            if (persisted != null) owner = persisted;
        }
        if (!allowsKuaidi100Route(owner, previewResult, afterJingDongFailure)) return "";
        String route = repository.meizuManualDetailUrl(owner);
        if (route.isEmpty() && previewResult != null
                && TimelineSlot.V6_PICKER.equals(
                TimelineSlot.normalize(previewResult.timelineProvider))) {
            route = previewResult.detailUrl;
        }
        return safeKuaidi100Url(route);
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

    /** Opens the shipment's original signed JD page without persisting its page timeline. */
    private void showJingDongWebDetail(String detailUrl) {
        pullRefreshRequested = false;
        visibleJingDongDetailUrl = detailUrl;
        setContentView(R.layout.activity_express_web);
        applySystemBarInsets(findViewById(R.id.express_web_root));
        MaterialToolbar toolbar = findViewById(R.id.web_toolbar);
        toolbar.setTitle(item.displayCompany());
        toolbar.setNavigationOnClickListener(view -> navigateBack());
        ProgressBar progress = findViewById(R.id.web_progress);
        webView = findViewById(R.id.web_view);
        jingDongFullProgressAttempts = 0;
        jingDongFullProgressExpanded = false;
        jingDongFullProgressAttemptInFlight = false;
        configureWebView(webView);
        if (item.isAccountOrder() && item.projectedWaybill.isEmpty()) {
            installOrderProjectionBridge(webView);
        }
        webView.getSettings().setSupportMultipleWindows(false);
        webView.getSettings().setJavaScriptCanOpenWindowsAutomatically(false);
        int pageSurface = MaterialColors.getColor(webView,
                com.google.android.material.R.attr.colorSurface);
        webView.setBackgroundColor(pageSurface);
        webView.setVisibility(View.INVISIBLE);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(
                    WebView view, String url, android.graphics.Bitmap icon) {
                super.onPageStarted(view, url, icon);
                Uri target = Uri.parse(url == null ? "" : url);
                if (isBlockedJingDongLogin(target)) {
                    view.stopLoading();
                    fallbackJingDongWebDetail(view, progress);
                    return;
                }
                injectOrderProjectionProbe(view);
            }

            @Override public boolean shouldOverrideUrlLoading(
                    WebView view, WebResourceRequest request) {
                if (request == null) return true;
                Uri target = request.getUrl();
                boolean blocked = shouldBlockJingDongNavigation(
                        target, request.isForMainFrame());
                if (blocked && request.isForMainFrame()) {
                    view.post(() -> fallbackJingDongWebDetail(view, progress));
                }
                return blocked;
            }

            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!isJingDongLogisticsPage(Uri.parse(url == null ? "" : url))) return;
                injectOrderProjectionProbe(view);
                inspectOrderProjectionDom(view);
                revealWebView(view, progress);
                startJingDongFullProgressExpansion(view);
            }

            @Override public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                if (!isJingDongLogisticsPage(Uri.parse(url == null ? "" : url))) return;
                injectOrderProjectionProbe(view);
                revealWebView(view, progress);
            }

            @Override public void onReceivedError(
                    WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request == null || request.isForMainFrame()) {
                    fallbackJingDongWebDetail(view, progress);
                }
            }

            @Override public void onReceivedHttpError(
                    WebView view, WebResourceRequest request, WebResourceResponse response) {
                super.onReceivedHttpError(view, request, response);
                if (request == null || request.isForMainFrame()) {
                    // Unified express toast (AGENTS §11): JD risk control answers 403.
                    if (response != null && response.getStatusCode() == 403) {
                        Toast.makeText(ExpressDetailActivity.this,
                                ExpressToastCopy.JD_RISK_CONTROL, Toast.LENGTH_LONG).show();
                    }
                    fallbackJingDongWebDetail(view, progress);
                }
            }

            @Override public boolean onRenderProcessGone(
                    WebView view, RenderProcessGoneDetail detail) {
                Log.w(ORDER_LOG_TAG, "JD WebView renderer exited; crashed="
                        + (detail != null && detail.didCrash()));
                fallbackJingDongWebDetail(view, progress);
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(
                    WebView view, boolean isDialog, boolean isUserGesture,
                    android.os.Message resultMsg) {
                return false;
            }

            @Override public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }
        });
        webView.loadUrl(detailUrl);
        webView.postDelayed(() -> {
            if (isCurrentDetailWebView(webView)
                    && webView.getVisibility() != View.VISIBLE) {
                fallbackJingDongWebDetail(webView, progress);
            }
        }, 12_000L);
    }

    /** Opens Picker's K100 route without treating it as a source-owned route atom. */
    private void showKuaidi100WebDetail(String detailUrl) {
        pullRefreshRequested = false;
        visibleJingDongDetailUrl = "";
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

    private void startJingDongFullProgressExpansion(WebView view) {
        if (!isCurrentDetailWebView(view) || jingDongFullProgressExpanded
                || jingDongFullProgressAttemptInFlight
                || jingDongFullProgressAttempts >= JINGDONG_FULL_PROGRESS_MAX_ATTEMPTS) {
            return;
        }
        Uri page = Uri.parse(view.getUrl() == null ? "" : view.getUrl());
        if (!isJingDongLogisticsPage(page)) return;
        jingDongFullProgressAttemptInFlight = true;
        jingDongFullProgressAttempts++;
        view.evaluateJavascript(jingDongFullProgressExpansionScript(), encoded -> {
            jingDongFullProgressAttemptInFlight = false;
            if (!isCurrentDetailWebView(view)) return;
            String result = decodeEvaluationString(encoded);
            if ("clicked".equals(result) || "already".equals(result)) {
                jingDongFullProgressExpanded = true;
                Log.i(ORDER_LOG_TAG, "JD full progress expanded");
                return;
            }
            if (jingDongFullProgressAttempts >= JINGDONG_FULL_PROGRESS_MAX_ATTEMPTS) {
                Log.i(ORDER_LOG_TAG, "JD full progress control unavailable");
                return;
            }
            long delayMillis = Math.min(
                    2_000L, 200L * (1L << Math.min(3, jingDongFullProgressAttempts - 1)));
            view.postDelayed(() -> startJingDongFullProgressExpansion(view), delayMillis);
        });
    }

    /**
     * 用户定 2026-09-05：京东来源的详情就是「feed 缓存 / 联合页」，联合页失败回**原生详情**，
     * 不再转去 K100 H5——那一页只属于手动件和顺丰（表格 Lite 一节）。原来 AGENTS §103 允许
     * 「页面失败时打开已持久化的可信 K100 URL」，实测极兔京东件因此每次都弹出快递100 页面。
     */
    private void fallbackJingDongWebDetail(WebView failed, ProgressBar progress) {
        fallbackWebDetail(failed, progress, false);
    }

    /** A provider H5 is presentation-only; failure must preserve the local owner package. */
    private void fallbackWebDetailToNative(WebView failed, ProgressBar progress) {
        fallbackWebDetail(failed, progress, false);
    }

    private void fallbackWebDetail(
            WebView failed, ProgressBar progress, boolean tryKuaidi100) {
        if (webNativeFallbackStarted || failed == null || failed != webView
                || isFinishing() || isDestroyed()) return;
        webNativeFallbackStarted = true;
        if (failed == orderCaptureWebView) {
            failOrderProjectionAttempt();
            disposeOrderCapture(failed);
        }
        visibleJingDongDetailUrl = "";
        webView = null;
        if (progress != null) progress.setVisibility(View.GONE);
        failed.stopLoading();
        ViewGroup parent = (ViewGroup) failed.getParent();
        if (parent != null) parent.removeView(failed);
        failed.destroy();
        String fallbackUrl = tryKuaidi100 ? kuaidi100FallbackUrl(true) : "";
        if (fallbackUrl.isEmpty()) {
            showNativeDetail();
        } else {
            webNativeFallbackStarted = false;
            showKuaidi100WebDetail(fallbackUrl);
        }
    }

    private boolean startOrderProjectionCapture(String detailUrl) {
        if (detailUrl == null || detailUrl.isEmpty() || orderCaptureWebView != null) return false;
        if (reuseVisibleOrderProjectionCapture(detailUrl)) return true;
        orderCaptureCallbacks.clear();
        WebView capture = new WebView(this);
        orderCaptureWebView = capture;
        capture.setAlpha(0f);
        capture.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        configureWebView(capture);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(capture, true);
        installOrderProjectionBridge(capture);
        capture.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(
                    WebView view, String url, android.graphics.Bitmap icon) {
                super.onPageStarted(view, url, icon);
                logOrderCapturePage("started", url);
                injectOrderProjectionProbe(view);
            }

            @Override public boolean shouldOverrideUrlLoading(
                    WebView view, WebResourceRequest request) {
                boolean blocked = request == null
                        || shouldBlockJingDongNavigation(
                                request.getUrl(), request.isForMainFrame());
                if (blocked && request != null && request.isForMainFrame()) {
                    view.post(() -> {
                        if (view != orderCaptureWebView) return;
                        failOrderProjectionAttempt();
                        disposeOrderCapture(view);
                    });
                }
                return blocked;
            }

            @Override public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                injectOrderProjectionProbe(view);
            }

            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                logOrderCapturePage("finished", url);
                injectOrderProjectionProbe(view);
                inspectOrderProjectionDom(view);
            }

            @Override public boolean onRenderProcessGone(
                    WebView view, RenderProcessGoneDetail detail) {
                return handleRenderProcessGone(view, null, false, detail);
            }
        });
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(1, 1);
        params.gravity = Gravity.TOP | Gravity.START;
        addContentView(capture, params);
        capture.loadUrl(detailUrl);
        scheduleOrderProjectionInspection(capture);
        return true;
    }

    private boolean reuseVisibleOrderProjectionCapture(String detailUrl) {
        WebView visible = webView;
        if (visible == null || !detailUrl.equals(visibleJingDongDetailUrl)
                || !isCurrentDetailWebView(visible)) return false;
        orderCaptureCallbacks.clear();
        orderCaptureWebView = visible;
        injectOrderProjectionProbe(visible);
        inspectOrderProjectionDom(visible);
        scheduleOrderProjectionInspection(visible);
        return true;
    }

    private void scheduleOrderProjectionInspection(WebView capture) {
        postOrderCapture(capture, () -> injectOrderProjectionProbe(capture), 80L);
        postOrderCapture(capture, () -> injectOrderProjectionProbe(capture), 350L);
        for (long delay : new long[]{1_000L, 3_000L, 6_000L, 10_000L, 16_000L}) {
            postOrderCapture(capture, () -> inspectOrderProjectionDom(capture), delay);
        }
        postOrderCapture(capture, () -> {
            if (capture == orderCaptureWebView) {
                Log.w(ORDER_LOG_TAG, "Identity capture timed out without a waybill");
                failOrderProjectionAttempt();
                disposeOrderCapture(capture);
            }
        }, ORDER_CAPTURE_TIMEOUT_MS);
    }

    private void installOrderProjectionBridge(WebView target) {
        ExpressOrderProjectionBridge.install(
                target, (sourceView, payload) ->
                        acceptOrderProjectionOnMainThread(sourceView, payload, true));
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // This must run before the page's own scripts. onPageStarted/evaluateJavascript is
            // already too late for a fast getUnionActivity request and was the reason some rows
            // never received their real waybill.
            WebViewCompat.addDocumentStartJavaScript(
                    target,
                    orderProjectionProbeScript(),
                    new java.util.HashSet<>(java.util.Arrays.asList(
                            "https://jd.com", "https://*.jd.com")));
            Log.i(ORDER_LOG_TAG, "Installed document-start identity capture");
        } else {
            Log.w(ORDER_LOG_TAG, "Document-start capture unsupported; using DOM fallback");
        }
    }

    private void startOrderProjectionCaptureIfDue() {
        if (!orderProjectionCaptureEnabled || item == null || orderCaptureWebView != null
                || detailIdentityProjectionAttempted
                || item.rowId <= 0L || !item.isAccountOrder()
                || !item.projectedWaybill.isEmpty()) return;
        ExpressItem expectedOwner = item;
        ExpressRepository repository = ExpressRepository.get(this);
        ExpressItem currentOwner = ExpressOrderProjectionRetryStore.currentUnresolvedOwner(
                expectedOwner, repository.find(expectedOwner.rowId));
        if (currentOwner == null) return;
        if (orderProjectionRetries == null) {
            orderProjectionRetries = new ExpressOrderProjectionRetryStore(this);
        }
        ExpressOrderProjectionRetryStore.AttemptToken token =
                orderProjectionRetries.beginAttempt(
                        currentOwner, System.currentTimeMillis(), true);
        if (token == null) {
            waitForOrderProjectionAttempt(currentOwner);
            return;
        }
        cancelOrderProjectionWait();
        orderProjectionAttemptOwner = currentOwner;
        orderProjectionAttemptToken = token;
        boolean attemptRetained = false;
        try {
            ExpressItem confirmedOwner = ExpressOrderProjectionRetryStore.currentUnresolvedOwner(
                    currentOwner, repository.find(currentOwner.rowId));
            if (confirmedOwner == null) return;
            String detailUrl = safeOrderH5Url(confirmedOwner);
            if (detailUrl.isEmpty()) return;
            item = confirmedOwner;
            orderProjectionAttemptOwner = confirmedOwner;
            attemptRetained = startOrderProjectionCapture(detailUrl);
            if (attemptRetained) detailIdentityProjectionAttempted = true;
        } catch (RuntimeException | Error failure) {
            failOrderProjectionAttempt();
            throw failure;
        } finally {
            if (!attemptRetained) releaseOrderProjectionAttempt();
        }
    }

    private void waitForOrderProjectionAttempt(ExpressItem expectedOwner) {
        cancelOrderProjectionWait();
        if (!orderProjectionCaptureEnabled || expectedOwner == null
                || orderProjectionRetries == null) return;
        View decor = getWindow().getDecorView();
        int generation = ++orderProjectionWaitGeneration;
        Runnable wakeup = () -> {
            if (generation != orderProjectionWaitGeneration) return;
            cancelOrderProjectionWait();
            if (orderProjectionCaptureEnabled && !isFinishing() && !isDestroyed()) {
                startOrderProjectionCaptureIfDue();
            }
        };
        orderProjectionWaitWakeup = wakeup;
        ExpressOrderProjectionRetryStore.WaitToken waitToken =
                ExpressOrderProjectionRetryStore.waitForAttemptRelease(
                        expectedOwner, () -> {
                            if (generation == orderProjectionWaitGeneration
                                    && orderProjectionCaptureEnabled
                                    && !isFinishing() && !isDestroyed()) {
                                decor.post(wakeup);
                            }
                        });
        if (waitToken == null) {
            decor.post(wakeup);
            return;
        }
        orderProjectionWaitToken = waitToken;
        Runnable timeout = () -> {
            if (generation != orderProjectionWaitGeneration) return;
            cancelOrderProjectionWait();
            if (orderProjectionCaptureEnabled && !isFinishing() && !isDestroyed()) {
                startOrderProjectionCaptureIfDue();
            }
        };
        orderProjectionWaitTimeout = timeout;
        decor.postDelayed(timeout, ORDER_CAPTURE_WAIT_TIMEOUT_MS);
    }

    private void cancelOrderProjectionWait() {
        orderProjectionWaitGeneration++;
        View decor = getWindow() == null ? null : getWindow().getDecorView();
        if (decor != null) {
            if (orderProjectionWaitWakeup != null) {
                decor.removeCallbacks(orderProjectionWaitWakeup);
            }
            if (orderProjectionWaitTimeout != null) {
                decor.removeCallbacks(orderProjectionWaitTimeout);
            }
        }
        orderProjectionWaitWakeup = null;
        orderProjectionWaitTimeout = null;
        ExpressOrderProjectionRetryStore.WaitToken waitToken = orderProjectionWaitToken;
        orderProjectionWaitToken = null;
        ExpressOrderProjectionRetryStore.cancelWait(waitToken);
    }

    private void postOrderCapture(WebView capture, Runnable action, long delayMillis) {
        if (capture == null || action == null) return;
        orderCaptureCallbacks.post(capture, () -> {
            if (capture == orderCaptureWebView && !isFinishing() && !isDestroyed()) {
                action.run();
            }
        }, delayMillis);
    }

    private static void logOrderCapturePage(String phase, String url) {
        Uri page = Uri.parse(url == null ? "" : url);
        String host = page.getHost();
        Log.d(ORDER_LOG_TAG, phase + " page host=" + (host == null ? "" : host));
    }

    private void disposeOrderCapture(WebView capture) {
        if (capture == null || capture != orderCaptureWebView) return;
        boolean visibleDetail = capture == webView;
        orderCaptureWebView = null;
        orderCaptureCallbacks.clear();
        try {
            if (!visibleDetail) {
                capture.stopLoading();
                capture.loadUrl("about:blank");
                capture.clearHistory();
                ViewGroup parent = (ViewGroup) capture.getParent();
                if (parent != null) parent.removeView(capture);
                capture.destroy();
            }
        } finally {
            releaseOrderProjectionAttempt();
        }
    }

    private void releaseOrderProjectionAttempt() {
        orderProjectionAttemptOwner = null;
        ExpressOrderProjectionRetryStore.AttemptToken token = orderProjectionAttemptToken;
        orderProjectionAttemptToken = null;
        if (token != null && orderProjectionRetries != null) {
            orderProjectionRetries.endAttempt(token);
        }
    }

    private void failOrderProjectionAttempt() {
        ExpressItem owner = orderProjectionAttemptOwner;
        orderProjectionAttemptOwner = null;
        ExpressOrderProjectionRetryStore.AttemptToken token = orderProjectionAttemptToken;
        orderProjectionAttemptToken = null;
        if (owner == null || token == null || orderProjectionRetries == null) return;
        ExpressRepository repository = ExpressRepository.get(this);
        ExpressItem current = repository.find(owner.rowId);
        ExpressItem unresolved = ExpressOrderProjectionRetryStore.currentUnresolvedOwner(
                owner, current);
        ExpressOrderProjectionRetryStore.completeAttempt(
                token, () -> {
                    if (unresolved == null) {
                        orderProjectionRetries.clear(owner);
                    } else {
                        orderProjectionRetries.recordFailure(
                                owner, System.currentTimeMillis());
                    }
                }, failure -> Log.w(
                        ORDER_LOG_TAG,
                        "Identity capture failure cooldown could not be saved",
                        failure));
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
        boolean orderCapture = crashed == orderCaptureWebView;
        if (orderCapture) {
            orderCaptureWebView = null;
            orderCaptureCallbacks.clear();
        }
        if (orderCapture) {
            failOrderProjectionAttempt();
        }
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
        // 用户定 2026-09-05：缓存里选中的详情包已完整（有揽收、与 feed 时间对齐）就不再重拉，
        // 任何一级都不跑；下拉只绕节流，不绕这道门（三端同一道门）。
        if (currentDetailComplete(item)) {
            me.pipi.deliveries.network.ExpressLog.line(
                    detailLogInterface(item), "detail", "", "skipped",
                    "tail", tailOf(item.displayWaybill()), "reason", "complete_cache");
            if (detailSwipe != null) detailSwipe.setRefreshing(false);
            announcePullRefreshOutcome();
            return;
        }
        refreshLocalTimeline(showProgress, null);
    }

    /** 当前行选中的详情包是否已按统一判据完整；账号订单看接口 5 按件详情，其余看手动权威包。 */
    private boolean currentDetailComplete(ExpressItem value) {
        try {
            ExpressRepository repository = ExpressRepository.get(this);
            if (prefersAccountTimeline(value)) {
                ExpressQueryResult account = accountTimelineFor(
                        repository, value, value.displayWaybill(), "interface5");
                return Kuaidi100TimelinePolicy.hasTimedTracking(account)
                        && Kuaidi100TimelinePolicy.hasPickupEvidence(account);
            }
            ManualTimelineAuthorityPolicy.Candidate selected =
                    repository.manualDetailTimelineAuthority(value);
            if (selected == null) return false;
            long feedLatest = value.manuallyAdded ? 0L
                    : Kuaidi100TimelinePolicy.latestTimedEventMillis(itemResult(
                            value, value.displayWaybill(), TimelineSlot.K100_H5));
            // 没有 feed 作时间基准（纯手动件）时判不了「到此为止」：只有终态才算完整，在途的照常刷。
            if (feedLatest <= 0L) {
                return value.semantic != null && value.semantic.terminal()
                        && Kuaidi100TimelinePolicy.hasPickupEvidence(selected.result);
            }
            return ManualTimelineAuthorityPolicy.detailTimelineComplete(
                    selected.result, feedLatest);
        } catch (RuntimeException failure) {
            return false;
        }
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
                new ExpressQueryCancellation(LOCAL_REFRESH_TIMEOUT_MS);
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
                    if (prefersAccountTimeline(requestItem)) {
                        // 第一级：接口 5 按件详情（订单号查 /v2/query），强制拉，不受 6 小时签名缓存
                        // 和「列表这轮已同步」的闸门约束。拿到可用轨迹就到此为止；没拿到、且行上
                        // 已投影出运单号，才继续下面的手动链；两者都没有就兜底联合页。
                        boolean usable = refreshInterface5OrderFromAccount(repository, requestItem);
                        ExpressItem refreshedOwner = repository.find(requestItem.rowId);
                        ExpressQueryResult account = refreshedOwner == null ? null
                                : accountTimelineFor(repository, refreshedOwner,
                                        refreshedOwner.displayWaybill(), "interface5");
                        boolean render = usable
                                && Kuaidi100TimelinePolicy.hasTimedTracking(account);
                        String unionUrl = unionPageFallbackUrl;
                        unionPageFallbackUrl = "";
                        runOnUiThread(() -> {
                            if (generation != localRefreshGeneration
                                    || isFinishing() || isDestroyed()
                                    || refreshedOwner == null || item == null
                                    || item.rowId != requestItem.rowId) return;
                            item = refreshedOwner;
                            if (render) {
                                ImageView icon = findViewById(R.id.detail_icon);
                                if (icon != null) {
                                    icon.setImageResource(item.displayIconResource());
                                }
                                renderHeader(item.displayCourierCode(), item.displayCompany(),
                                        item.displayWaybill(), item.displayStatus(),
                                        item.semantic);
                                rememberDisplayedProvider(TimelineSlot.V5_QUERY);
                                renderTimeline(ExpressTimeline.parse(
                                        account.tracksJson, account.latestTime,
                                        account.latestDetail));
                                return;
                            }
                            if (!unionUrl.isEmpty() && item.projectedWaybill.isEmpty()) {
                                me.pipi.deliveries.network.ExpressLog.line(
                                        detailInterface(item), "jd_h5", "jingdong", "started",
                                        "tail", tailOf(item.displayWaybill()),
                                        "reason", "v5_query_empty");
                                showJingDongWebDetail(unionUrl);
                            }
                        });
                        if (render || requestItem.projectedWaybill.isEmpty()) return;
                    }
                    ExpressRepository.ManualQueryOwnerClaim ownerClaim =
                            repository.captureManualQueryOwner(requestItem);
                    boolean projectedInterface5Order =
                            requestItem.isInterface5ProjectedOrder();
                    if (requestItem.manuallyAdded
                            || usesSharedManualTimeline(requestItem)
                            || projectedInterface5Order) {
                        String owner = requestItem.stateOwner.isEmpty()
                                ? requestItem.source : requestItem.stateOwner;
                        String bindingSource =
                                ExpressAccountSource.bindingSourceForOwner(owner);
                        String manualWaybill = requestItem.displayWaybill();
                        String manualCourierCode = projectedInterface5Order
                                ? "" : requestItem.courierCode;
                        Log.i(MANUAL_LOG_TAG, "Refresh start rowId="
                                + requestItem.rowId
                                + " owner=" + owner
                                + " provider=" + requestItem.sourceProvider
                                + " shared=" + usesSharedManualTimeline(requestItem)
                                + " projected=" + projectedInterface5Order);
                        ExpressApi manualApi = new ExpressApi(getApplicationContext());
                        ExpressSubscriptionClient meizuApi = new ExpressSubscriptionClient();
                        ManualQueryCoordinator.Batch manualBatch =
                                ManualQueryCoordinator.queryPickerFirst(
                                        () -> meizuApi.queryManual(
                                                getApplicationContext(), manualWaybill,
                                                cancellation),
                                        repository.manualTimelineCandidate(
                                                requestItem, TimelineSlot.V6_PICKER),
                                        () -> manualApi.queryMoto(
                                                manualWaybill, manualCourierCode, cancellation),
                                        ManualQueryRoutingPolicy.includesMoto(requestItem));
                        ExpressQueryResult refreshed = manualBatch.detailSelected();
                        cancellation.throwIfCancelled();
                        Log.i(MANUAL_LOG_TAG, "Refresh result rowId="
                                + requestItem.rowId
                                + " provider=" + (refreshed == null
                                ? "" : refreshed.timelineProvider)
                                + " timed="
                                + Kuaidi100TimelinePolicy.hasTimedTracking(refreshed));
                        repository.saveOwnerManualQueryBatch(
                                requestItem, ownerClaim, manualBatch.successes,
                                requestItem.phone, bindingSource);
                        ExpressItem refreshedOwner = repository.find(requestItem.rowId);
                        ManualTimelineAuthorityPolicy.Candidate refreshedDetail =
                                repository.manualDetailTimelineAuthority(requestItem);
                        runOnUiThread(() -> {
                            if (generation != localRefreshGeneration
                                    || isFinishing() || isDestroyed()
                                    || refreshedOwner == null || item == null
                                    || item.rowId != requestItem.rowId) return;
                            item = refreshedOwner;
                            ImageView icon = findViewById(R.id.detail_icon);
                            if (icon != null) icon.setImageResource(item.displayIconResource());
                            renderHeader(item.displayCourierCode(), item.displayCompany(),
                                    item.displayWaybill(), item.displayStatus(), item.semantic);
                            ExpressQueryResult detail = refreshedDetail == null
                                    ? null : refreshedDetail.result;
                            rememberDisplayedProvider(refreshedDetail == null
                                    ? ManualTimelineAuthorityPolicy.PREFERRED_FEED
                                    : refreshedDetail.provider);
                            renderTimeline(ExpressTimeline.parse(
                                    detail == null ? item.tracksJson : detail.tracksJson,
                                    detail == null ? item.latestTime : detail.latestTime,
                                    detail == null ? item.latestDetail : detail.latestDetail));
                        ensureKuaidi100Presentation(detail, "after_shared_manual_refresh");
                            ensureKuaidi100Presentation(detail, "after_manual_refresh");
                        });
                        return;
                    }
                    String timelineWaybill = requestItem.displayWaybill();
                    String courierHint = requestItem.projectedWaybill.isEmpty()
                            ? requestItem.courierCode : "";
                    String owner = requestItem.stateOwner.isEmpty()
                            ? requestItem.source : requestItem.stateOwner;
                    String bindingSource = ExpressAccountSource.bindingSourceForOwner(owner);
                    ExpressApi manualApi = new ExpressApi(getApplicationContext());
                    ExpressSubscriptionClient meizuApi = new ExpressSubscriptionClient();
                    ManualQueryCoordinator.Batch manualBatch =
                            ManualQueryCoordinator.queryPickerFirst(
                                    () -> meizuApi.queryManual(
                                            getApplicationContext(), timelineWaybill,
                                            cancellation),
                                    repository.manualTimelineCandidate(
                                            requestItem, TimelineSlot.V6_PICKER),
                                    () -> manualApi.queryMoto(
                                            timelineWaybill, courierHint, cancellation),
                                    ManualQueryRoutingPolicy.includesMoto(requestItem));
                    cancellation.throwIfCancelled();
                    repository.saveOwnerManualQueryBatch(
                            requestItem, ownerClaim, manualBatch.successes,
                            requestItem.phone, bindingSource);
                    ExpressItem refreshedOwner = repository.find(requestItem.rowId);
                    ManualTimelineAuthorityPolicy.Candidate refreshedDetail =
                            repository.manualDetailTimelineAuthority(requestItem);
                    runOnUiThread(() -> {
                        if (generation != localRefreshGeneration
                                || isFinishing() || isDestroyed()
                                || refreshedOwner == null || item == null
                                || item.rowId != requestItem.rowId
                                || !normalizeIdentity(item.displayWaybill()).equals(
                                normalizeIdentity(requestItem.displayWaybill()))) return;
                        item = refreshedOwner;
                        ImageView icon = findViewById(R.id.detail_icon);
                        if (icon != null) icon.setImageResource(item.displayIconResource());
                        renderHeader(item.displayCourierCode(), item.displayCompany(),
                                item.displayWaybill(), item.displayStatus(), item.semantic);
                        ExpressQueryResult detail = refreshedDetail == null
                                ? null : refreshedDetail.result;
                        rememberDisplayedProvider(refreshedDetail == null
                                ? ManualTimelineAuthorityPolicy.PREFERRED_FEED
                                : refreshedDetail.provider);
                        renderTimeline(ExpressTimeline.parse(
                                detail == null ? item.tracksJson : detail.tracksJson,
                                detail == null ? item.latestTime : detail.latestTime,
                                detail == null ? item.latestDetail : detail.latestDetail));
                    });
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

    private void scheduleLocalRefreshTimeout(int generation) {
        clearLocalRefreshTimeout();
        localRefreshTimeout = () -> {
            localRefreshFailed = true;
            cancelLocalTimelineRefresh(generation, false);
            announcePullRefreshOutcome();
        };
        nativeProgress.postDelayed(localRefreshTimeout, LOCAL_REFRESH_TIMEOUT_MS);
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
        TextView loading = textView(R.string.loading_logistics, 14f, GRAY);
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
        cancelOrderProjectionWait();
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
        if (orderCaptureWebView == webView) disposeOrderCapture(orderCaptureWebView);
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
        if (orderCaptureWebView != null) disposeOrderCapture(orderCaptureWebView);
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
     * 压过手动 authority——之前手动链留下的一条 picker 包会把全量轨迹盖掉，进页只剩签收那一条。
     */
    private boolean renderInterface5AccountTimeline(ExpressRepository repository) {
        if (!prefersAccountTimeline(item)) return false;
        ExpressQueryResult account = accountTimelineFor(
                repository, item, item.displayWaybill(), "interface5");
        if (!Kuaidi100TimelinePolicy.hasTimedTracking(account)) return false;
        rememberDisplayedProvider(TimelineSlot.V5_QUERY);
        renderTimeline(ExpressTimeline.parse(
                account.tracksJson, account.latestTime, account.latestDetail));
        return true;
    }

    /** 进页先原生时留下的联合页地址；接口 5 按件详情什么都没给时才用它兜底。 */
    private String unionPageFallbackUrl = "";

    /**
     * 强制拉一次接口 5 按件详情（`/v2/query`，京东行按订单号）并落库；返回这次是否拉到了有时间的
     * 轨迹。落库沿用同步引擎的路径（saveInterface5Order → 账号时间线按订单号 + 投影运单号双键）。
     */
    private boolean refreshInterface5OrderFromAccount(
            ExpressRepository repository, ExpressItem requestItem) {
        try {
            ExpressDiscoveryClient discovery = new ExpressDiscoveryClient();
            ExpressQueryResult refreshed = discovery.refreshKnown(
                    getApplicationContext(), requestItem, true);
            int nodes = refreshed == null ? 0
                    : ExpressTimeline.parse(refreshed.tracksJson, "", "").size();
            me.pipi.deliveries.network.ExpressLog.line(
                    "v5", "v5_query", "jingdong",
                    Kuaidi100TimelinePolicy.hasTimedTracking(refreshed) ? "succeeded" : "failed",
                    "tail", tailOf(requestItem.displayWaybill()), "nodes", nodes);
            if (refreshed == null
                    || me.pipi.deliveries.model.ExpressStatusNormalizer.isProviderErrorDetail(
                    refreshed.latestDetail)) return false;
            repository.saveInterface5Order(
                    refreshed, requestItem.phone,
                    repository.bindingGeneration(requestItem.phone, "interface5"));
            ExpressItem persisted = repository.findByWaybill(refreshed.waybill, "interface5");
            if (persisted != null) discovery.rememberKnownRefresh(getApplicationContext(), persisted);
            return Kuaidi100TimelinePolicy.hasTimedTracking(refreshed);
        } catch (Throwable failure) {
            Log.w(MANUAL_LOG_TAG, "Interface 5 order detail unavailable", failure);
            return false;
        }
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

    static boolean canRefreshLocalTimeline(ExpressItem value) {
        return value != null && (!value.isAccountOrder()
                || !value.projectedWaybill.isEmpty()
                || prefersAccountTimeline(value));
    }

    /** 接口 5 的京东订单：详情以按件详情（`/v2/query`，订单号）拉回的账号时间线为先。 */
    static boolean prefersAccountTimeline(ExpressItem value) {
        return value != null && !value.manuallyAdded && value.isAccountOrder()
                && value.usesInterface5AccountTimeline();
    }

    static boolean needsManualSupplement(
            ExpressItem value, ExpressQueryResult ownerTimeline,
            ExpressQueryResult selectedManualTimeline) {
        if (value == null || value.isCainiaoSource()) return false;
        // JD source completion freezes every display timeline. Background refresh may continue for
        // retention, but a detail supplement must not replace the frozen package.
        if (value.semantic == StatusSemantic.COMPLETED
                && "JingDong".equalsIgnoreCase(value.sourceProvider)) return false;
        if (Kuaidi100TimelinePolicy.hasTimelineStart(ownerTimeline)) return false;
        return !Kuaidi100TimelinePolicy.hasTimelineStart(selectedManualTimeline);
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
        return item != null && !item.manuallyAdded
                && "JingDong".equalsIgnoreCase(item.sourceProvider);
    }

    static boolean allowsKuaidi100Route(
            ExpressItem item, ExpressQueryResult preview) {
        return allowsKuaidi100Route(item, preview, false);
    }

    static boolean allowsKuaidi100Route(
            ExpressItem item, ExpressQueryResult preview, boolean afterJingDongFailure) {
        if (preview != null && TimelineSlot.V6_PICKER.equals(
                TimelineSlot.normalize(preview.timelineProvider))) {
            return true;
        }
        // 京东来源不走 K100 H5（用户定 2026-09-05）；afterJingDongFailure 保留形参只为兼容调用点。
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

    static boolean isBlockedJingDongLogin(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                && "plogin.m.jd.com".equalsIgnoreCase(uri.getHost());
    }

    static boolean shouldBlockJingDongNavigation(Uri uri, boolean mainFrame) {
        return !allowedOrderHost(uri) || (mainFrame && isBlockedJingDongLogin(uri));
    }

    static boolean isJingDongLogisticsPage(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                && "jingfen.jd.com".equalsIgnoreCase(uri.getHost())
                && "/item".equals(uri.getPath());
    }

    private void injectOrderProjectionProbe(WebView view) {
        if (view == null || view != orderCaptureWebView
                || item == null || !item.isAccountOrder()
                || isFinishing() || isDestroyed()) return;
        view.evaluateJavascript(orderProjectionProbeScript(), null);
    }

    private void inspectOrderProjectionDom(WebView view) {
        if (view == null || view != orderCaptureWebView
                || item == null || !item.isAccountOrder()
                || isFinishing() || isDestroyed()) return;
        view.evaluateJavascript(orderProjectionReadScript(), encoded -> {
            if (view != orderCaptureWebView || item == null || !item.isAccountOrder()
                    || isFinishing() || isDestroyed()) return;
            String projectionJson = decodeEvaluationString(encoded);
            if (projectionJson.isEmpty() || projectionJson.length() > 128 * 1024) return;
            acceptOrderProjectionOnMainThread(view, projectionJson, false);
        });
    }

    private void acceptOrderProjectionOnMainThread(
            WebView source, String projectionJson, boolean originValidated) {
        WebView capture = orderCaptureWebView;
        if (capture == null || source != capture || item == null || !item.isAccountOrder()) return;
        Uri page = Uri.parse(capture.getUrl() == null ? "" : capture.getUrl());
        if (isBlockedJingDongLogin(page)
                || (!originValidated && !allowedOrderHost(page))) return;
        try {
                ExpressItem expectedOwner = orderProjectionAttemptOwner;
                if (expectedOwner == null) return;
                ExpressOrderProjectionBridge.Candidate candidate =
                        ExpressOrderProjectionBridge.candidate(
                                projectionJson, expectedOwner.waybill);
                if (candidate == null) {
                    Log.d(ORDER_LOG_TAG, "Projection did not contain a distinct waybill");
                    return;
                }
                String waybill = candidate.waybill;
                String company = candidate.carrier;
                ExpressRepository repository = ExpressRepository.get(ExpressDetailActivity.this);
                ExpressItem currentOwner = repository.find(expectedOwner.rowId);
                if (!ExpressOrderProjectionBridge.sameUnresolvedOwner(
                        expectedOwner, currentOwner)) {
                    failOrderProjectionAttempt();
                    disposeOrderCapture(capture);
                    return;
                }
                String owner = currentOwner.stateOwner.isEmpty()
                        ? currentOwner.source : currentOwner.stateOwner;
                boolean saved = repository.saveOrderProjection(
                        expectedOwner, ExpressAccountSource.bindingSourceForOwner(owner),
                        waybill, company);
                if (saved) {
                    Log.i(ORDER_LOG_TAG, "Captured display identity from JD H5");
                    ExpressScheduler.requestNow(ExpressDetailActivity.this);
                    if (isFinishing() || isDestroyed()) return;
                    ExpressItem refreshed = repository.find(item.rowId);
                    if (refreshed != null) {
                        item = refreshed;
                        ImageView icon = findViewById(R.id.detail_icon);
                        if (icon != null) icon.setImageResource(item.displayIconResource());
                        if (statusView != null && waybillView != null
                                && hotlineRow != null && hotlineView != null) {
                            renderHeader(item.displayCourierCode(), item.displayCompany(),
                                    item.displayWaybill(),
                                    item.displayStatus(), item.semantic);
                            ExpressQueryResult cached = accountTimelineFor(
                                    repository, item, item.displayWaybill(),
                                    ExpressAccountSource.bindingSourceForOwner(owner));
                            boolean cachedUsable =
                                    Kuaidi100TimelinePolicy.hasRealTracking(cached);
                            if (timeline != null && cachedUsable) {
                                rememberDisplayedProvider(cached.timelineProvider);
                                renderTimeline(ExpressTimeline.parse(
                                        cached.tracksJson,
                                        cached.latestTime,
                                        cached.latestDetail));
                            } else if (timeline != null) {
                                renderTimeline(java.util.Collections.emptyList());
                            }
                        }
                    }
                    disposeOrderCapture(capture);
                } else {
                    failOrderProjectionAttempt();
                    disposeOrderCapture(capture);
                }
        } catch (Throwable failure) {
            // Never log the page payload, signed URL, order id or waybill.
            Log.w(ORDER_LOG_TAG, "Identity projection could not be applied: "
                    + failure.getClass().getSimpleName());
        }
    }

    static String normalizeIdentity(String value) {
        return value == null ? "" : value.toUpperCase(Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
    }

    static String jingDongFullProgressExpansionScript() {
        return "(function(){try{"
                + "if(window.__deliveriesFullProgressExpanded)return 'already';"
                + "var button=document.querySelector('.logistics-button');"
                + "if(!button||typeof button.click!=='function')return 'missing';"
                + "var label=button.querySelector('.logistics-button-text');"
                // The control's text node reads "完整物流进度 >"; the chevron is decoration.
                + "var text=String(label&&label.textContent||'').replace(/\\s+/g,'')"
                + ".replace(/[>›〉»]+$/,'');"
                + "if(text!=='完整物流进度')return 'missing';"
                + "button.click();window.__deliveriesFullProgressExpanded=true;"
                + "return 'clicked';}catch(e){return 'failed';}})()";
    }

    static String orderProjectionProbeScript() {
        return "(function(){try{"
                + "if(window.__deliveriesOrderProbeInstalled)return;"
                + "window.__deliveriesOrderProbeInstalled=true;"
                + "function decode(value){try{if(typeof value!=='string')return value;"
                + "var text=value.trim();if(!text)return null;"
                + "try{return JSON.parse(text);}catch(e){}"
                + "var start=text.indexOf('('),end=text.lastIndexOf(')');"
                + "if(start>0&&end>start)return JSON.parse(text.slice(start+1,end));"
                + "return null;}catch(e){return null;}}"
                + "function enqueue(value){try{var q=window.__deliveriesOrderProjections;"
                + "if(!Array.isArray(q))q=window.__deliveriesOrderProjections=[];"
                + "q.push(value);if(q.length>16)q.splice(0,q.length-16);}catch(e){}}"
                + "function emit(value){enqueue(value);try{var bridge=window."
                + "deliveriesOrderProjection;if(bridge&&typeof bridge.postMessage==='function')"
                + "bridge.postMessage(JSON.stringify(value));}catch(e){}}"
                + "function bounded(task){return new Promise(function(resolve){var done=false;"
                + "function finish(){if(done)return;done=true;clearTimeout(timer);resolve();}"
                + "var timer=setTimeout(finish,1500);Promise.resolve(task).then(finish,finish);});}"
                + "function project(root){try{root=decode(root)||root;"
                + "if(root&&typeof root.data==='string')root.data=decode(root.data)||root.data;"
                + "var info=root&&root.data&&root.data.floors&&"
                + "root.data.floors[0]&&root.data.floors[0].element&&"
                + "root.data.floors[0].element.info;if(!info)return;"
                + "var traces=Array.isArray(info.traceList)?info.traceList:[];"
                + "var carrier=String(info.expressName||info.carrierName||"
                + "info.companyName||info.expressCompany||'').trim();"
                + "if(!carrier){for(var j=0;j<traces.length;j++){var trace=traces[j]||{};"
                + "carrier=String(trace.expressName||trace.carrierName||trace.companyName||"
                + "trace.expressCompany||trace.cpName||'').trim();if(carrier)break;}}"
                + "var identities=[],seen={};function add(way,name){way=String(way||'').trim();if(!way)return;"
                + "var key=way.toUpperCase().replace(/[^A-Z0-9]/g,'');"
                + "if(seen[key])return;seen[key]=true;"
                + "identities.push({waybillCode:way,carrierName:String(name||carrier||'').trim()});}"
                + "add(info.waybillCode,carrier);for(var i=0;i<traces.length;i++){"
                + "var candidate=traces[i]||{};add(candidate.waybillCode,"
                + "candidate.expressName||candidate.carrierName||candidate.companyName||"
                + "candidate.expressCompany||candidate.cpName||carrier);}"
                + "if(identities.length)emit({identities:identities});"
                + "}catch(e){}}"
                + "function requestText(value){try{if(typeof value==='string')return value;"
                + "return value&&value.url?String(value.url):String(value||'');}catch(e){return '';}}"
                + "function relevant(url,body){var text=requestText(url)+'&'+String(body||'');"
                + "try{text=decodeURIComponent(text);}catch(e){}"
                + "return text.indexOf('getUnionActivity')>=0;}"
                + "var originalFetch=window.fetch;if(originalFetch){window.fetch=function(){"
                + "var args=arguments;return originalFetch.apply(this,args).then(function(response){"
                + "try{var url=(response&&response.url)||args[0];var body=args[1]&&args[1].body;"
                + "if(relevant(url,body)){return bounded(response.clone().text().then(project))"
                + ".then(function(){return response;});}}catch(e){}return response;});};}"
                + "var proto=window.XMLHttpRequest&&window.XMLHttpRequest.prototype;if(proto){"
                + "var open=proto.open,send=proto.send;proto.open=function(m,u){this.__deliveriesUrl=u;return open.apply(this,arguments);};"
                + "proto.send=function(body){if(relevant(this.__deliveriesUrl,body)){this.addEventListener('load',function(){"
                + "try{project(this.responseText);}catch(e){}});}return send.apply(this,arguments);};}"
                + "}catch(e){}})();";
    }

    static String orderProjectionReadScript() {
        return "(function(){try{var q=window.__deliveriesOrderProjections;"
                + "if(Array.isArray(q)&&q.length)return JSON.stringify(q.shift());"
                + "var text=(document.body&&document.body.innerText)||'';"
                + "var match=text.match(/(?:运单号|快递单号)\\s*[：:]?\\s*([A-Za-z0-9_-]{6,40})/);"
                + "if(match&&match[1])return JSON.stringify({waybillCode:match[1],carrierName:''});"
                + "return '';}catch(e){return '';}})();";
    }

    static String decodeEvaluationString(String encoded) {
        if (encoded == null || encoded.length() > 256 * 1024) return "";
        String envelope = encoded.trim();
        if (envelope.length() < 2 || envelope.charAt(0) != '"'
                || envelope.charAt(envelope.length() - 1) != '"') return "";
        try {
            Object value = new org.json.JSONTokener(envelope).nextValue();
            return value instanceof String ? ((String) value).trim() : "";
        } catch (Throwable ignored) {
            return "";
        }
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
