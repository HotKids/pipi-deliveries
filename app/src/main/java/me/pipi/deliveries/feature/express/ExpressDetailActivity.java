package me.pipi.deliveries.feature.express;

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
    private static final long LOCAL_REFRESH_TIMEOUT_MS = 10_000L;
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
        if (!cainiaoUrl.isEmpty()) {
            showCainiaoWebDetail(cainiaoUrl);
        } else {
            String jingDongUrl = transientPickerPreview ? "" : safeOrderH5Url(item);
            if (!jingDongUrl.isEmpty()) {
                showJingDongWebDetail(jingDongUrl);
            } else {
                String kuaidi100Url = transientPickerPreview ? "" : kuaidi100FallbackUrl();
                if (kuaidi100Url.isEmpty()) showNativeDetail();
                else showKuaidi100WebDetail(kuaidi100Url);
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
        detailSwipe.setColorSchemeColors(
                MaterialColors.getColor(detailSwipe,
                        androidx.appcompat.R.attr.colorPrimary));
        detailSwipe.setOnRefreshListener(() -> refreshLocalTimeline(false));
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
            if (renderManualTimelineAuthority(repository, true)) return;
            String timelineWaybill = item.displayWaybill();
            String accountSource = accountTimelineSource(item);
            String accountWaybill = accountTimelineWaybill(item);
            boolean v4Owner = v4TimelineOwnsItem(item);
            ExpressQueryResult accountTimeline = accountSource.isEmpty()
                    ? null : repository.accountTimeline(accountWaybill, accountSource);
            boolean accountTimelineUsable = accountTimelineUsable(item, accountTimeline);
            ExpressQueryResult publicTimeline = v4Owner
                    ? repository.v4Timeline(timelineWaybill) : null;
            boolean publicTimelineUsable =
                    Kuaidi100TimelinePolicy.hasRealTracking(publicTimeline);
            String itemProvider = !accountSource.isEmpty()
                    ? accountSource : v4Owner ? "v4" : "kuaidi100";
            ExpressQueryResult initial = itemResult(
                    item, accountSource.isEmpty() ? timelineWaybill : accountWaybill,
                    itemProvider);
            boolean initialUsable = Kuaidi100TimelinePolicy.hasRealTracking(initial);
            boolean persistAccountInitial = false;
            boolean persistPublicInitial = false;
            boolean persistLocalInitial = false;
            if (!accountTimelineUsable && !accountSource.isEmpty() && initialUsable
                    && !item.isInterface5ProjectedOrder()) {
                accountTimeline = initial;
                accountTimelineUsable = true;
                persistAccountInitial = true;
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
            persistInitialTimelineAsync(repository, initial, accountSource,
                    persistAccountInitial, persistPublicInitial, persistLocalInitial);
        }
    }

    private void persistInitialTimelineAsync(
            ExpressRepository repository, ExpressQueryResult initial, String accountSource,
            boolean persistAccount, boolean persistPublic, boolean persistLocal) {
        if (!persistAccount && !persistPublic && !persistLocal) return;
        try {
            worker.execute(() -> {
                try {
                    if (persistAccount) repository.saveAccountTimeline(initial, accountSource);
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
        if (renderManualTimelineAuthority(repository, false)) return;
        String waybill = item.displayWaybill();
        String accountSource = accountTimelineSource(item);
        ExpressQueryResult accountTimeline = accountSource.isEmpty()
                ? null : repository.accountTimeline(accountTimelineWaybill(item), accountSource);
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
                !accountSource.isEmpty() ? accountSource : v4Owner ? "v4" : "kuaidi100");
        ExpressQueryResult ownerTimeline = !accountSource.isEmpty()
                ? accountTimeline : v4Owner ? publicTimeline : initial;
        boolean refreshDue = needsManualSupplement(item, ownerTimeline, cached);
        if (cachedUsable) {
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
                && "meizu".equalsIgnoreCase(previewResult.timelineProvider)) {
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

    private void fallbackJingDongWebDetail(WebView failed, ProgressBar progress) {
        fallbackWebDetail(failed, progress, true);
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
            return;
        }
        refreshLocalTimeline(showProgress, null);
    }

    private void refreshLocalTimeline(
            boolean showProgress, ExpressRepository.ManualTimelinePollClaim claim) {
        if (localRefreshInFlight || !canRefreshLocalTimeline(item)) {
            ExpressRepository.get(this).releaseManualTimelinePoll(claim);
            if (detailSwipe != null) detailSwipe.setRefreshing(false);
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
                                                requestItem, "meizu"),
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
                            String fallbackUrl = kuaidi100FallbackUrl();
                            if (!fallbackUrl.isEmpty()) {
                                showKuaidi100WebDetail(fallbackUrl);
                                return;
                            }
                            ImageView icon = findViewById(R.id.detail_icon);
                            if (icon != null) icon.setImageResource(item.displayIconResource());
                            renderHeader(item.displayCourierCode(), item.displayCompany(),
                                    item.displayWaybill(), item.displayStatus(), item.semantic);
                            ExpressQueryResult detail = refreshedDetail == null
                                    ? null : refreshedDetail.result;
                            renderTimeline(ExpressTimeline.parse(
                                    detail == null ? item.tracksJson : detail.tracksJson,
                                    detail == null ? item.latestTime : detail.latestTime,
                                    detail == null ? item.latestDetail : detail.latestDetail));
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
                                            requestItem, "meizu"),
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
                        String fallbackUrl = kuaidi100FallbackUrl();
                        if (!fallbackUrl.isEmpty()) {
                            showKuaidi100WebDetail(fallbackUrl);
                            return;
                        }
                        ImageView icon = findViewById(R.id.detail_icon);
                        if (icon != null) icon.setImageResource(item.displayIconResource());
                        renderHeader(item.displayCourierCode(), item.displayCompany(),
                                item.displayWaybill(), item.displayStatus(), item.semantic);
                        ExpressQueryResult detail = refreshedDetail == null
                                ? null : refreshedDetail.result;
                        renderTimeline(ExpressTimeline.parse(
                                detail == null ? item.tracksJson : detail.tracksJson,
                                detail == null ? item.latestTime : detail.latestTime,
                                detail == null ? item.latestDetail : detail.latestDetail));
                    });
                } catch (InterruptedException cancelled) {
                    Thread.currentThread().interrupt();
                } catch (Throwable failure) {
                    // Keep the cached local timeline visible when every enabled source fails.
                    Log.w(MANUAL_LOG_TAG, "Refresh failed rowId="
                            + requestItem.rowId
                            + " error=" + failure.getClass().getSimpleName());
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
        localRefreshTimeout = () -> cancelLocalTimelineRefresh(generation, false);
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
                Toast.makeText(this, "无法打开拨号界面", Toast.LENGTH_SHORT).show();
            }
        });
    }

    private void copyWaybill(String waybill) {
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        if (clipboard == null) return;
        clipboard.setPrimaryClip(ClipData.newPlainText(
                getString(R.string.copy_waybill), waybill));
        Toast.makeText(this, R.string.waybill_copied, Toast.LENGTH_SHORT).show();
    }

    private void renderTimeline(List<ExpressTimeline.Track> tracks) {
        timelineLoadingPlaceholder = false;
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

    private int statusColor(StatusSemantic semantic) {
        switch (semantic == null ? StatusSemantic.UNKNOWN : semantic) {
            case DANGER: return Color.rgb(212, 61, 61);
            case WAITING_PICKUP: return Color.rgb(230, 91, 23);
            case DELIVERY: return Color.rgb(26, 138, 74);
            case PICKED:
            case TRANSIT: return Color.rgb(50, 117, 214);
            case ORDERED:
            case SHIPPED: return Color.rgb(251, 192, 45);
            case COMPLETED:
                return MaterialColors.getColor(statusView,
                        com.google.android.material.R.attr.colorOnSurface);
            default: return Color.rgb(117, 117, 117);
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
        String source = "interface5".equals(result.timelineProvider)
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
        if (value.isAccountOrder() && !value.isInterface5ProjectedOrder()) return "";
        String owner = value.stateOwner.isEmpty() ? value.source : value.stateOwner;
        if (value.usesInterface5AccountTimeline()) return "interface5";
        if ("INTERFACE6".equalsIgnoreCase(owner)) {
            return "interface6";
        }
        return "";
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
                || !value.projectedWaybill.isEmpty());
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
        if (preview != null && "meizu".equalsIgnoreCase(preview.timelineProvider)) {
            return true;
        }
        return item != null && (item.manuallyAdded || item.isShunFengSource()
                || (afterJingDongFailure && allowsJingDongRoute(item)));
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
                            ExpressQueryResult cached = repository.accountTimeline(
                                    item.displayWaybill(),
                                    ExpressAccountSource.bindingSourceForOwner(owner));
                            boolean cachedUsable =
                                    Kuaidi100TimelinePolicy.hasRealTracking(cached);
                            if (timeline != null && cachedUsable) {
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
                + "var text=String(label&&label.textContent||'').replace(/\\s+/g,'');"
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
