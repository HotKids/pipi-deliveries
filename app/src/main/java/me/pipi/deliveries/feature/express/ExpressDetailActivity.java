package me.pipi.deliveries.feature.express;

import android.annotation.SuppressLint;
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
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.google.android.material.appbar.MaterialToolbar;
import com.google.android.material.color.MaterialColors;
import com.google.android.material.progressindicator.LinearProgressIndicator;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import me.pipi.deliveries.R;
import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.CainiaoRoute;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressAccountSource;

/** Cainiao uses its credentialed H5; every other provider uses Pipi's local timeline. */
public final class ExpressDetailActivity extends AppCompatActivity {
    private static final String ORDER_LOG_TAG = "ExpressOrderProjection";
    public static final String EXTRA_ROW_ID = "express_row_id";
    private static final String EXTRA_PREVIEW = "express_preview";
    private static final String EXTRA_PERSIST_PREVIEW = "persist_express_preview";
    private static final String EXTRA_WAYBILL = "preview_waybill";
    private static final String EXTRA_COURIER = "preview_courier";
    private static final String EXTRA_COMPANY = "preview_company";
    private static final String EXTRA_STATUS = "preview_status";
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

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private WebView webView;
    private WebView orderCaptureWebView;
    private LinearLayout timeline;
    private LinearProgressIndicator nativeProgress;
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
        String cainiaoUrl = safeCainiaoUrl(item);
        if (!cainiaoUrl.isEmpty() && !item.isAccountOrder()) {
            showWebDetail(cainiaoUrl, false);
        } else {
            showNativeDetail();
            startOrderProjectionCaptureIfDue();
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { navigateBack(); }
        });
    }

    @Override protected void onStop() {
        if (orderCaptureWebView != null) {
            disposeOrderCapture(orderCaptureWebView);
        }
        super.onStop();
    }

    private void showNativeDetail() {
        setContentView(R.layout.activity_express_detail);
        MaterialToolbar toolbar = findViewById(R.id.detail_toolbar);
        toolbar.setNavigationOnClickListener(view -> finish());
        ImageView icon = findViewById(R.id.detail_icon);
        icon.setImageResource(item.displayIconResource());
        statusView = findViewById(R.id.detail_status);
        waybillView = findViewById(R.id.detail_waybill);
        timeline = findViewById(R.id.timeline);
        nativeProgress = findViewById(R.id.detail_progress);
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
            String timelineWaybill = item.displayWaybill();
            String accountSource = accountTimelineSource(item);
            boolean v4Owner = v4TimelineOwnsItem(item);
            ExpressQueryResult accountTimeline = accountSource.isEmpty()
                    ? null : repository.accountTimeline(timelineWaybill, accountSource);
            boolean accountTimelineUsable =
                    Kuaidi100TimelinePolicy.hasRealTracking(accountTimeline);
            ExpressQueryResult publicTimeline = v4Owner
                    ? repository.v4Timeline(timelineWaybill) : null;
            boolean publicTimelineUsable =
                    Kuaidi100TimelinePolicy.hasRealTracking(publicTimeline);
            String itemProvider = !accountSource.isEmpty()
                    ? accountSource : v4Owner ? "v4" : "kuaidi100";
            ExpressQueryResult initial = itemResult(item, timelineWaybill, itemProvider);
            boolean initialUsable = Kuaidi100TimelinePolicy.hasRealTracking(initial);
            if (!accountTimelineUsable && !accountSource.isEmpty() && initialUsable) {
                accountTimeline = repository.saveAccountTimeline(initial, accountSource);
                accountTimelineUsable =
                        Kuaidi100TimelinePolicy.hasRealTracking(accountTimeline);
            }
            if (!publicTimelineUsable && v4Owner && initialUsable) {
                publicTimeline = repository.saveV4Timeline(initial);
                publicTimelineUsable =
                        Kuaidi100TimelinePolicy.hasRealTracking(publicTimeline);
            }
            ExpressQueryResult kuaidi100Timeline = repository.kuaidi100Timeline(timelineWaybill);
            if (kuaidi100Timeline == null && accountSource.isEmpty() && !v4Owner
                    && localTimelineOwnsItem(item) && initialUsable) {
                kuaidi100Timeline = repository.saveKuaidi100Timeline(initial);
            }
            ExpressQueryResult cached = preferredDetailTimeline(
                    accountTimeline, publicTimeline, kuaidi100Timeline);
            renderTimeline(cached == null
                    ? java.util.Collections.emptyList()
                    : ExpressTimeline.parse(
                            cached.tracksJson, cached.latestTime, cached.latestDetail));
            if (!accountTimelineUsable && !publicTimelineUsable
                    && (!Kuaidi100TimelinePolicy.hasRealTracking(cached)
                    || Kuaidi100TimelinePolicy.shouldRefresh(
                    item, cached, System.currentTimeMillis()))) {
                refreshLocalTimeline();
            }
        }
    }

    private void showWebDetail(String detailUrl, boolean captureOrderProjection) {
        setContentView(R.layout.activity_express_web);
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
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                super.onPageStarted(view, url, icon);
                if (captureOrderProjection) injectOrderProjectionProbe(view);
            }

            @Override public boolean shouldOverrideUrlLoading(
                    WebView view, WebResourceRequest request) {
                return request == null
                        || !allowedWebUrl(request.getUrl(), captureOrderProjection);
            }

            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (captureOrderProjection) {
                    injectOrderProjectionProbe(view);
                    inspectOrderProjectionDom(view);
                    revealWebView(view, progress);
                } else {
                    decorateCainiaoPage(view, url, localLogo,
                            pageSurface, () -> revealWebView(view, progress));
                }
            }

            @Override public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                if (captureOrderProjection) {
                    injectOrderProjectionProbe(view);
                    revealWebView(view, progress);
                } else {
                    decorateCainiaoPage(view, url, localLogo,
                            pageSurface, () -> revealWebView(view, progress));
                }
            }

            @Override public void onReceivedError(
                    WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request == null || request.isForMainFrame()) {
                    revealWebView(view, progress);
                }
            }

            @Override public void onReceivedHttpError(
                    WebView view, WebResourceRequest request, WebResourceResponse response) {
                super.onReceivedHttpError(view, request, response);
                if (request == null || request.isForMainFrame()) {
                    revealWebView(view, progress);
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
        if (captureOrderProjection) {
            webView.postDelayed(() -> injectOrderProjectionProbe(webView), 80L);
            webView.postDelayed(() -> injectOrderProjectionProbe(webView), 350L);
        }
        webView.postDelayed(() -> {
            if (!isFinishing() && !isDestroyed()) revealWebView(webView, progress);
        }, 12_000L);
    }

    private static void revealWebView(WebView view, ProgressBar progress) {
        if (view != null) view.setVisibility(View.VISIBLE);
        if (progress != null) progress.setVisibility(View.GONE);
    }

    private void startOrderProjectionCapture(String detailUrl) {
        if (detailUrl == null || detailUrl.isEmpty() || orderCaptureWebView != null) return;
        WebView capture = new WebView(this);
        orderCaptureWebView = capture;
        capture.setAlpha(0f);
        capture.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        configureWebView(capture);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(capture, true);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // This must run before the page's own scripts. onPageStarted/evaluateJavascript is
            // already too late for a fast getUnionActivity request and was the reason some rows
            // never received their real waybill.
            WebViewCompat.addDocumentStartJavaScript(
                    capture,
                    orderProjectionProbeScript(),
                    new java.util.HashSet<>(java.util.Arrays.asList(
                            "https://jd.com", "https://*.jd.com")));
            Log.i(ORDER_LOG_TAG, "Installed document-start identity capture");
        } else {
            Log.w(ORDER_LOG_TAG, "Document-start capture unsupported; using DOM fallback");
        }
        capture.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(
                    WebView view, String url, android.graphics.Bitmap icon) {
                super.onPageStarted(view, url, icon);
                logOrderCapturePage("started", url);
                injectOrderProjectionProbe(view);
            }

            @Override public boolean shouldOverrideUrlLoading(
                    WebView view, WebResourceRequest request) {
                return request == null || !allowedOrderHost(request.getUrl());
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
        capture.postDelayed(() -> injectOrderProjectionProbe(capture), 80L);
        capture.postDelayed(() -> injectOrderProjectionProbe(capture), 350L);
        for (long delay : new long[]{1_000L, 3_000L, 6_000L, 10_000L, 16_000L}) {
            capture.postDelayed(() -> inspectOrderProjectionDom(capture), delay);
        }
        capture.postDelayed(() -> {
            if (capture == orderCaptureWebView) {
                Log.w(ORDER_LOG_TAG, "Identity capture timed out without a waybill");
                disposeOrderCapture(capture);
            }
        }, 20_000L);
    }

    private void startOrderProjectionCaptureIfDue() {
        if (item == null || orderCaptureWebView != null
                || !item.isAccountOrder() || !item.projectedWaybill.isEmpty()) return;
        String detailUrl = safeOrderH5Url(item);
        if (!detailUrl.isEmpty()) startOrderProjectionCapture(detailUrl);
    }

    private static void logOrderCapturePage(String phase, String url) {
        Uri page = Uri.parse(url == null ? "" : url);
        String host = page.getHost();
        Log.d(ORDER_LOG_TAG, phase + " page host=" + (host == null ? "" : host));
    }

    private void disposeOrderCapture(WebView capture) {
        if (capture == null || capture != orderCaptureWebView) return;
        orderCaptureWebView = null;
        capture.stopLoading();
        capture.loadUrl("about:blank");
        capture.clearHistory();
        ViewGroup parent = (ViewGroup) capture.getParent();
        if (parent != null) parent.removeView(capture);
        capture.destroy();
    }

    private boolean handleRenderProcessGone(
            WebView crashed, ProgressBar progress, boolean closeDetail,
            RenderProcessGoneDetail detail) {
        Log.w(ORDER_LOG_TAG, "WebView renderer exited; crashed="
                + (detail != null && detail.didCrash()));
        if (crashed == webView) webView = null;
        if (crashed == orderCaptureWebView) orderCaptureWebView = null;
        if (progress != null) progress.setVisibility(View.GONE);
        ViewGroup parent = crashed == null ? null : (ViewGroup) crashed.getParent();
        if (parent != null) parent.removeView(crashed);
        if (crashed != null) crashed.destroy();
        if (closeDetail && !isFinishing() && !isDestroyed()) {
            Toast.makeText(this, R.string.web_detail_unavailable, Toast.LENGTH_SHORT).show();
            finish();
        }
        return true;
    }

    private void refreshLocalTimeline() {
        nativeProgress.setVisibility(View.VISIBLE);
        worker.execute(() -> {
            try {
                ExpressRepository repository = ExpressRepository.get(this);
                String timelineWaybill = item.displayWaybill();
                String courierHint = item.projectedWaybill.isEmpty()
                        ? item.courierCode
                        : CarrierRegistry.queryCode("", item.projectedCompanyName);
                String owner = item.stateOwner.isEmpty() ? item.source : item.stateOwner;
                String bindingSource = ExpressAccountSource.bindingSourceForOwner(owner);
                ExpressQueryResult refreshed = new ExpressApi(
                        getApplicationContext()).queryWithPhones(
                        timelineWaybill, courierHint,
                        repository.phoneCandidates(item.phone, bindingSource));
                boolean interface5Fallback = interface5Kuaidi100OwnsItem(item);
                ExpressQueryResult merged;
                if (interface5Fallback) {
                    repository.saveManualKuaidi100(refreshed, item.phone, "interface5");
                    merged = repository.kuaidi100Timeline(refreshed.waybill);
                } else {
                    merged = repository.saveKuaidi100Timeline(refreshed);
                }
                ExpressQueryResult selected = merged == null ? refreshed : merged;
                ExpressItem projectedItem = null;
                if (!item.projectedWaybill.isEmpty()) {
                    String projectedCompany = CarrierRegistry.displayName(
                            selected.courierCode, selected.companyName);
                    if (!projectedCompany.isEmpty()
                            && repository.saveOrderProjection(
                            item.waybill, bindingSource, selected.waybill,
                            projectedCompany, "[]")) {
                        projectedItem = repository.find(item.rowId);
                    }
                }
                if (localTimelineOwnsItem(item)) {
                    if (!interface5Fallback) {
                        repository.saveQuery(
                                selected, item.phone, ExpressApi.listSource(selected));
                    }
                }
                ExpressItem refreshedProjection = projectedItem;
                runOnUiThread(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    if (refreshedProjection != null) {
                        item = refreshedProjection;
                        ImageView icon = findViewById(R.id.detail_icon);
                        if (icon != null) icon.setImageResource(item.displayIconResource());
                        renderHeader(item.displayCourierCode(), item.displayCompany(),
                                item.displayWaybill(), selected.semantic.label,
                                selected.semantic);
                    } else if (localTimelineOwnsItem(item)) {
                        renderHeader(selected.courierCode, CarrierRegistry.displayName(
                                        selected.courierCode, selected.companyName),
                                selected.waybill,
                                selected.semantic.label, selected.semantic);
                    }
                    if (merged != null) renderTimeline(ExpressTimeline.parse(
                            merged.tracksJson, merged.latestTime, merged.latestDetail));
                });
            } catch (Throwable ignored) {
                // Keep the cached local timeline visible when K100 is temporarily unavailable.
            } finally {
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed() && nativeProgress != null) {
                        nativeProgress.setVisibility(View.GONE);
                    }
                });
            }
        });
    }

    private void renderHeader(
            String courierCode, String company, String waybill,
            String status, StatusSemantic semantic) {
        statusView.setText(status);
        statusView.setTextColor(statusColor(semantic));
        waybillView.setText(getString(R.string.express_company_waybill, company, waybill));
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

    private void renderTimeline(List<ExpressTimeline.Track> tracks) {
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
        worker.shutdownNow();
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.clearHistory();
            webView.destroy();
        }
        if (orderCaptureWebView != null) disposeOrderCapture(orderCaptureWebView);
        super.onDestroy();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView target) {
        WebSettings settings = target.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        if (Build.VERSION.SDK_INT >= 33) settings.setAlgorithmicDarkeningAllowed(true);
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
                intent.getStringExtra(EXTRA_TIME),
                intent.getStringExtra(EXTRA_DETAIL),
                intent.getStringExtra(EXTRA_TRACKS),
                intent.getStringExtra(EXTRA_URL), "",
                intent.getStringExtra(EXTRA_TIMELINE_PROVIDER),
                intent.getStringExtra(EXTRA_ROUTE_INTERFACE),
                intent.getStringExtra(EXTRA_ROUTE_CREDENTIAL));
    }

    private static ExpressItem previewItem(ExpressQueryResult result) {
        String source = "interface5".equals(result.timelineProvider)
                ? "INTERFACE5" : "INTERFACE6";
        return new ExpressItem(
                0L, "", result.waybill, result.courierCode, result.companyName,
                result.semantic, result.semantic.label, result.latestDetail,
                result.latestTime, result.tracksJson, "", source,
                result.detailUrl, 0L, 0L, source, source,
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
        String owner = value.stateOwner.isEmpty() ? value.source : value.stateOwner;
        if ("INTERFACE5".equalsIgnoreCase(owner)
                || ("I5-JD".equalsIgnoreCase(owner)
                && value.projectedWaybill.isEmpty())) {
            return "interface5";
        }
        if ("INTERFACE6".equalsIgnoreCase(owner)
                || ("I6-JD".equalsIgnoreCase(owner)
                && value.projectedWaybill.isEmpty())) {
            return "interface6";
        }
        return "";
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
                value.latestTime, value.latestDetail, value.tracksJson,
                "", value.phone, provider);
    }

    /** A manual query is committed only after its transient detail screen is closed. */
    @Override public void finish() {
        if (persistPreviewOnFinish && !previewPersisted
                && previewResult != null && !previewResult.waybill.isEmpty()) {
            previewPersisted = true;
            ExpressRepository repository = ExpressRepository.get(this);
            if (Kuaidi100TimelinePolicy.hasRealTracking(previewResult)) {
                if ("interface5".equals(previewResult.timelineProvider)) {
                    repository.saveInterface5(previewResult, previewPhone);
                } else if ("interface6".equals(previewResult.timelineProvider)) {
                    repository.saveInterface6(previewResult, previewPhone);
                } else if ("interface5".equals(previewBindingSource)
                        && "kuaidi100".equals(previewResult.timelineProvider)) {
                    repository.saveManualKuaidi100(
                            previewResult, previewPhone, previewBindingSource);
                } else {
                    repository.saveQuery(
                            previewResult, previewPhone, ExpressApi.listSource(previewResult));
                }
                // An explicitly deleted or signed-seven-day-expired waybill is not retained again
                // merely because it was inspected through manual search.
                if (repository.findByWaybill(
                        previewResult.waybill, previewBindingSource) != null
                        && !"interface5".equals(previewResult.timelineProvider)
                        && !"interface6".equals(previewResult.timelineProvider)
                        && !("interface5".equals(previewBindingSource)
                        && "kuaidi100".equals(previewResult.timelineProvider))) {
                    if ("v4".equals(previewResult.timelineProvider)) {
                        repository.saveV4Timeline(previewResult);
                    } else {
                        repository.saveKuaidi100Timeline(previewResult);
                    }
                }
            } else if (repository.enqueuePendingManual(
                    previewResult, previewPhone, previewBindingSource)) {
                ExpressScheduler.ensureScheduled(this);
            }
        }
        super.finish();
    }

    static String safeCainiaoUrl(ExpressItem item) {
        if (item == null) return "";
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
        if (item == null || !item.isAccountOrder() || !item.routeCredentialAvailable) return "";
        String route = item.routeCredential;
        if (route.isEmpty()) return "";
        Uri candidate = Uri.parse(route);
        return allowedOrderHost(candidate) ? candidate.toString() : "";
    }

    private static boolean allowed(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        String host = uri.getHost();
        return trustedHost(host, "cainiao.com") || trustedHost(host, "taobao.com");
    }

    private static boolean allowedWebUrl(Uri uri, boolean orderProjection) {
        return orderProjection ? allowedOrderHost(uri) : allowed(uri);
    }

    private static boolean allowedOrderHost(Uri uri) {
        if (uri == null || !"https".equalsIgnoreCase(uri.getScheme())) return false;
        return trustedHost(uri.getHost(), "jd.com");
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
            acceptOrderProjectionOnMainThread(view, projectionJson);
        });
    }

    private void acceptOrderProjectionOnMainThread(WebView source, String projectionJson) {
        WebView capture = orderCaptureWebView;
        if (capture == null || source != capture || item == null || !item.isAccountOrder()) return;
        Uri page = Uri.parse(capture.getUrl() == null ? "" : capture.getUrl());
        if (!allowedOrderHost(page)) return;
        try {
                org.json.JSONObject projection = new org.json.JSONObject(projectionJson);
                String waybill = projection.optString("waybillCode", "").trim();
                if (!waybill.matches("^[A-Za-z0-9_-]{6,40}$")
                        || normalizeIdentity(waybill).equals(normalizeIdentity(item.waybill))) {
                    Log.d(ORDER_LOG_TAG, "Projection did not contain a distinct waybill");
                    return;
                }
                String company = projection.optString("carrierName", "").trim();
                if (company.length() > 64) company = company.substring(0, 64);
                if (company.isEmpty()) {
                    CarrierRegistry.Carrier inferred = CarrierRegistry.guessByWaybill(waybill);
                    if (inferred != null) company = inferred.companyName;
                }
                ExpressRepository repository = ExpressRepository.get(ExpressDetailActivity.this);
                String owner = item.stateOwner.isEmpty() ? item.source : item.stateOwner;
                boolean saved = repository.saveOrderProjection(
                        item.waybill, ExpressAccountSource.bindingSourceForOwner(owner),
                        waybill, company, "[]");
                if (saved) {
                    Log.i(ORDER_LOG_TAG, "Captured display identity from isolated H5");
                    if (isFinishing() || isDestroyed()) return;
                    ExpressItem refreshed = repository.find(item.rowId);
                    if (refreshed != null) {
                        item = refreshed;
                        ImageView icon = findViewById(R.id.detail_icon);
                        if (icon != null) icon.setImageResource(item.displayIconResource());
                        renderHeader(item.displayCourierCode(), item.displayCompany(),
                                item.displayWaybill(),
                                item.displayStatus(), item.semantic);
                        ExpressQueryResult cached = repository.kuaidi100Timeline(
                                item.displayWaybill());
                        renderTimeline(cached == null
                                ? java.util.Collections.emptyList()
                                : ExpressTimeline.parse(cached.tracksJson,
                                cached.latestTime, cached.latestDetail));
                        if (!Kuaidi100TimelinePolicy.hasRealTracking(cached)
                                || Kuaidi100TimelinePolicy.shouldRefresh(
                                item, cached, System.currentTimeMillis())) {
                            refreshLocalTimeline();
                        }
                    }
                    disposeOrderCapture(capture);
                } else {
                    // A deleted display waybill is tombstoned and must not be captured again.
                    disposeOrderCapture(capture);
                }
        } catch (Throwable failure) {
            // Never log the page payload, signed URL, order id or waybill.
            Log.w(ORDER_LOG_TAG, "Identity projection could not be applied: "
                    + failure.getClass().getSimpleName());
        }
    }

    private static String normalizeIdentity(String value) {
        return value == null ? "" : value.toUpperCase(Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
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
                + "q.push(value);if(q.length>4)q.splice(0,q.length-4);}catch(e){}}"
                + "function project(root){try{root=decode(root)||root;"
                + "if(root&&typeof root.data==='string')root.data=decode(root.data)||root.data;"
                + "var info=root&&root.data&&root.data.floors&&"
                + "root.data.floors[0]&&root.data.floors[0].element&&"
                + "root.data.floors[0].element.info;if(!info)return;"
                + "var traces=Array.isArray(info.traceList)?info.traceList:[];"
                + "var way=String(info.waybillCode||'').trim();"
                + "if(!way){for(var i=0;i<traces.length;i++){way=String(traces[i].waybillCode||'').trim();if(way)break;}}"
                + "if(!way)return;var carrier=String(info.expressName||info.carrierName||"
                + "info.companyName||info.expressCompany||'').trim();"
                + "if(!carrier){for(var j=0;j<traces.length;j++){var trace=traces[j]||{};"
                + "carrier=String(trace.expressName||trace.carrierName||trace.companyName||"
                + "trace.expressCompany||trace.cpName||'').trim();if(carrier)break;}}"
                + "enqueue({waybillCode:way,carrierName:carrier});"
                + "}catch(e){}}"
                + "function requestText(value){try{if(typeof value==='string')return value;"
                + "return value&&value.url?String(value.url):String(value||'');}catch(e){return '';}}"
                + "function relevant(url,body){var text=requestText(url)+'&'+String(body||'');"
                + "try{text=decodeURIComponent(text);}catch(e){}"
                + "return text.indexOf('getUnionActivity')>=0;}"
                + "var originalFetch=window.fetch;if(originalFetch){window.fetch=function(){"
                + "var args=arguments;return originalFetch.apply(this,args).then(function(response){"
                + "try{var url=(response&&response.url)||args[0];var body=args[1]&&args[1].body;"
                + "if(relevant(url,body)){response.clone().text().then(project).catch(function(){});}}catch(e){}return response;});};}"
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
