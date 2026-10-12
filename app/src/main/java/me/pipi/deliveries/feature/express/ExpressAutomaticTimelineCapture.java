package me.pipi.deliveries.feature.express;

import android.app.Activity;
import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.*;
import android.widget.FrameLayout;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.*;
import java.util.concurrent.*;
import me.pipi.deliveries.data.*;
import me.pipi.deliveries.model.*;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressAccountSource;

/** One finite page load for one automatic provider package; never combines page responses. */
final class ExpressAutomaticTimelineCapture {
    interface Callback { void complete(Result result); }
    static final class Result {
        final ExpressQueryResult timeline;
        final boolean complete;
        final boolean throttled;
        final boolean phoneRequired;
        /**
         * JD only（用户 2026-09-25 同意，方案 A，三端同一口径）：页面加载完、有真实视口、不是风控，到超时什么带物流的
         * 东西都没抓到（没有带节点的包、没有网络节点、没有运单号），union 请求也没有出错（要么没回，要么都是 2xx）
         * ——一个空壳。
         */
        final boolean emptyPage;
        /** JD only: something logistics-bearing was captured: a packet with tracks, network nodes or a waybill. */
        final boolean logisticsSeen;
        Result(ExpressQueryResult timeline, boolean complete, boolean throttled) {
            this(timeline, complete, throttled, false);
        }
        Result(ExpressQueryResult timeline, boolean complete, boolean throttled, boolean phoneRequired) {
            this(timeline, complete, throttled, phoneRequired, false, false);
        }
        Result(ExpressQueryResult timeline, boolean complete, boolean throttled, boolean phoneRequired,
                boolean emptyPage, boolean logisticsSeen) {
            this.timeline = timeline;
            this.complete = complete;
            this.throttled = throttled;
            this.phoneRequired = phoneRequired;
            this.emptyPage = emptyPage;
            this.logisticsSeen = logisticsSeen;
        }
    }
    private final Activity host;
    /** Application context of an off-window page; null whenever an Activity hosts the page. */
    private final Context offWindowContext;
    private final Handler offWindowHandler;
    private final ExpressItem owner;
    private final String route;
    private final String provider;
    private final ExpressQueryCancellation cancellation;
    private final Callback callback;
    private final ExpressKuaidi100TimelineCapture.Diagnostics k100Diagnostics;
    private List<String> phones;
    private WebView view;
    private boolean finished;
    private Result best;
    /** JD only: the page state the latest readable poll reported. */
    private ExpressJingDongTimelineParser.PageState pageState;
    /** JD only: some poll saw something logistics-bearing (a packet with tracks, network nodes, a waybill). */
    private boolean logisticsSeen;
    private final Runnable poll = this::poll;
    private final Runnable timeout = () -> finish(best, "timeout");

    ExpressAutomaticTimelineCapture(Activity host, ExpressItem owner, String route,
            String provider, ExpressQueryCancellation cancellation, Callback callback) {
        this(host, null, owner, route, provider, cancellation, callback);
    }

    /**
     * 后台京东订单投影专用（用户定 2026-09-24：Lite 只为这一条放开「后台不开页」）：没有 Activity，页面用应用
     * Context 在主线程建，离屏按屏幕尺寸排版（Pipi JingDongH5Client PassiveWebView 同法）。只有 jd_h5 能这样开，
     * 京东历史、菜鸟 H5、快递100 页、手动链照旧只在前台。
     */
    static ExpressAutomaticTimelineCapture offWindow(Context context, ExpressItem owner, String route,
            ExpressQueryCancellation cancellation, Callback callback) {
        return new ExpressAutomaticTimelineCapture(null, context.getApplicationContext(), owner, route,
                TimelineSlot.JD_H5, cancellation, callback);
    }

    private ExpressAutomaticTimelineCapture(Activity host, Context offWindowContext, ExpressItem owner,
            String route, String provider, ExpressQueryCancellation cancellation, Callback callback) {
        this.host = host;
        this.offWindowContext = host == null ? offWindowContext : null;
        this.offWindowHandler = this.offWindowContext == null ? null : new Handler(Looper.getMainLooper());
        this.owner = owner;
        this.route = route;
        this.provider = provider;
        this.cancellation = cancellation;
        this.callback = callback;
        this.k100Diagnostics = TimelineSlot.K100_H5.equals(provider) || TimelineSlot.JT_H5.equals(provider)
                ? new ExpressKuaidi100TimelineCapture.Diagnostics() : null;
        if (k100Diagnostics != null) k100Diagnostics.provider = provider;
        this.phones = ExpressKuaidi100TimelineCapture.phoneCandidates(
                owner == null ? "" : owner.phone, Collections.emptyList());
    }

    static Result capture(Activity host, ExpressItem owner, String route, String provider,
            ExpressQueryCancellation cancellation) throws InterruptedException {
        List<String> phones = ExpressKuaidi100TimelineCapture.phoneCandidates(
                owner == null ? "" : owner.phone,
                ExpressRepository.get(host).phoneCandidates("", owner == null || owner.manuallyAdded ? ""
                        : ExpressAccountSource.bindingSourceForOwner(
                                owner.stateOwner.isEmpty() ? owner.source : owner.stateOwner)));
        return capture(host, owner, route, provider, phones, cancellation);
    }

    static Result capture(Activity host, ExpressItem owner, String route, String provider,
            List<String> phones, ExpressQueryCancellation cancellation) throws InterruptedException {
        CountDownLatch done = new CountDownLatch(1);
        Result[] result = new Result[1];
        ExpressAutomaticTimelineCapture capture = new ExpressAutomaticTimelineCapture(
                host, owner, route, provider, cancellation, value -> {
                    result[0] = value;
                    done.countDown();
                });
        capture.phones = ExpressKuaidi100TimelineCapture.phoneCandidates(
                owner == null ? "" : owner.phone, phones);
        host.runOnUiThread(capture::start);
        try {
            while (!done.await(250L, TimeUnit.MILLISECONDS)) cancellation.throwIfCancelled();
            cancellation.throwIfCancelled();
            return result[0];
        } finally {
            host.runOnUiThread(capture::cancel);
        }
    }

    private boolean trusted(String url) {
        if (url == null) return false;
        if (TimelineSlot.JD_H5.equals(provider)) {
            return ExpressDetailActivity.allowedOrderHost(Uri.parse(url));
        }
        if (TimelineSlot.K100_H5.equals(provider)) return !ManualRoutePolicy.safeKuaidi100Url(url).isEmpty();
        if (TimelineSlot.JT_H5.equals(provider) && owner != null) {
            return !ManualRoutePolicy.safePrimaryH5Url(url, owner.displayWaybill()).isEmpty();
        }
        return CainiaoRoute.isTrustedResolvedUrl(url);
    }

    void start() {
        if (finished) return;
        if (hostClosed() || cancellation.isCancelled() || !trusted(route)
                // Without an Activity only the JD order page may open (never any other capture).
                || host == null && (offWindowContext == null || !TimelineSlot.JD_H5.equals(provider))) {
            finish(null, "not_started"); return;
        }
        try {
            view = new WebView(host != null ? host : offWindowContext);
            view.setAlpha(0.01f);
            view.setClickable(false);
            view.setFocusable(false);
            view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            ExpressDetailActivity.configureWebView(view);
            view.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
            if (k100Diagnostics != null) view.getSettings().setUserAgentString(
                    ExpressKuaidi100TimelineCapture.SAFARI_MOBILE_USER_AGENT);
            if (TimelineSlot.JD_H5.equals(provider)
                    && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(view,
                        ExpressJingDongTimelineParser.probeScript(),
                        new HashSet<>(Arrays.asList("https://jd.com", "https://*.jd.com")));
            }
            view.setWebViewClient(new WebViewClient() {
                @Override public void onPageStarted(WebView web, String url, android.graphics.Bitmap icon) {
                    if (TimelineSlot.JD_H5.equals(provider) && trusted(url))
                        web.evaluateJavascript(ExpressJingDongTimelineParser.probeScript(), null);
                }
                @Override public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
                    boolean blocked = request == null || !trusted(request.getUrl().toString());
                    if (blocked && (request == null || request.isForMainFrame())) finish(best, "untrusted_route");
                    return blocked;
                }
                /**
                 * 用户 2026-10-02 弹窗「Lite 也做，iOS 查文档能做就做（推荐）」：the hidden Kuaidi100 page (the detail
                 * pull's primary stage) loads only Kuaidi100's own files, as the add chain's capture does
                 * ({@link ExpressKuaidi100TimelineCapture#isAllowedCaptureResource}); the J&T, JD union and Cainiao
                 * pages are unchanged.
                 */
                @Override public WebResourceResponse shouldInterceptRequest(WebView web, WebResourceRequest request) {
                    if (!TimelineSlot.K100_H5.equals(provider) || request == null || request.getUrl() == null
                            || request.isForMainFrame()
                            || ExpressKuaidi100TimelineCapture.isAllowedCaptureResource(request.getUrl().toString())) {
                        return null;
                    }
                    return ExpressKuaidi100TimelineCapture.emptyCaptureResponse();
                }
                @Override public void onReceivedError(WebView web, WebResourceRequest request, WebResourceError error) {
                    if (request == null || request.isForMainFrame()) {
                        if (k100Diagnostics != null)
                            k100Diagnostics.errorCode = error == null ? null : error.getErrorCode();
                        finish(best, "main_frame_error");
                    }
                }
                @Override public void onReceivedHttpError(WebView web, WebResourceRequest request, WebResourceResponse response) {
                    if (request == null || request.isForMainFrame()) {
                        if (k100Diagnostics != null)
                            k100Diagnostics.httpStatus = response == null ? null : response.getStatusCode();
                        finish(new Result(best == null ? null : best.timeline, false,
                                TimelineSlot.JD_H5.equals(provider) && response != null
                                        && response.getStatusCode() == 403), "main_frame_http_error");
                    }
                }
                @Override public boolean onRenderProcessGone(WebView web, RenderProcessGoneDetail detail) {
                    finish(null, "renderer_exit");
                    return true;
                }
            });
            if (host != null) {
                ViewGroup root = host.findViewById(android.R.id.content);
                if (root == null) { finish(null, "content_missing"); return; }
                root.addView(view, 0, new FrameLayout.LayoutParams(-1, -1));
            } else {
                layOutOffWindow(view);
            }
            view.onResume();
            view.resumeTimers();
            view.loadUrl(route);
            later(view, poll, 250L);
            later(view, timeout, TimelineSlot.JD_H5.equals(provider) ? 20_000L : 8_000L);
        } catch (RuntimeException failed) {
            finish(null, "start_failed");
        }
    }

    private boolean hostClosed() {
        return host != null && (host.isFinishing() || host.isDestroyed());
    }

    /** No window, so the page gets a real viewport by being measured and laid out at display size. */
    private void layOutOffWindow(WebView target) {
        DisplayMetrics metrics = offWindowContext.getResources().getDisplayMetrics();
        int width = Math.max(1, metrics.widthPixels);
        int height = Math.max(1, metrics.heightPixels);
        target.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        target.layout(0, 0, width, height);
    }

    /** A view that never joins a window never runs View.postDelayed, so off-window uses the main looper. */
    private void later(WebView target, Runnable action, long delayMs) {
        if (offWindowHandler == null) target.postDelayed(action, delayMs);
        else offWindowHandler.postDelayed(action, delayMs);
    }

    private void poll() {
        WebView current = view;
        if (finished || current == null) return;
        if (cancellation.isCancelled() || hostClosed()) {
            finish(null, "cancelled_or_host_closed"); return;
        }
        if (!trusted(current.getUrl())) { later(current, poll, 250L); return; }
        String script = TimelineSlot.JD_H5.equals(provider)
                ? ExpressJingDongTimelineParser.readScript()
                : TimelineSlot.CN_H5.equals(provider) ? ExpressCainiaoTimelineParser.readScript()
                : TimelineSlot.JT_H5.equals(provider) ? ExpressKuaidi100TimelineCapture.jtExtractionScript(
                        owner.displayWaybill(), phones)
                : ExpressKuaidi100TimelineCapture.extractionScript(
                        owner == null ? "" : owner.displayWaybill(),
                        phones);
        try {
            if (k100Diagnostics != null) k100Diagnostics.evaluations++;
            current.evaluateJavascript(script, payload -> {
                if (finished || current != view || cancellation.isCancelled()) return;
                if (k100Diagnostics != null) k100Diagnostics.accept(payload);
                if (k100Diagnostics != null && (ExpressKuaidi100TimelineCapture.phoneRequired(payload)
                        || phones.isEmpty() && Boolean.TRUE.equals(k100Diagnostics.checkCodeVisible))) {
                    finish(new Result(null, false, false, true), "phone_required"); return;
                }
                Result candidate;
                if (TimelineSlot.JD_H5.equals(provider)) {
                    ExpressJingDongTimelineParser.PageState state =
                            ExpressJingDongTimelineParser.pageState(payload, owner);
                    if (state != null) {
                        pageState = state;
                        logisticsSeen |= state.logistics;
                    }
                    ExpressJingDongTimelineParser.Packet packet = ExpressJingDongTimelineParser.parse(payload, owner);
                    candidate = packet == null ? null : new Result(packet.timeline, packet.complete, packet.throttled);
                } else {
                    ExpressQueryResult parsed = TimelineSlot.CN_H5.equals(provider)
                            ? ExpressCainiaoTimelineParser.parse(payload, owner)
                            : ExpressDetailActivity.kuaidi100CapturedResult(owner,
                                    ExpressKuaidi100TimelineCapture.normalizedTracks(payload));
                    candidate = parsed == null ? null : new Result(parsed,
                            TimelineSlot.CN_H5.equals(provider)
                                    ? Kuaidi100TimelinePolicy.timedTrackCount(parsed) >= 2
                                    : ExpressDetailActivity.timelineComplete(parsed), false);
                }
                if (candidate != null) {
                    if (candidate.throttled || candidate.complete) { finish(candidate, "tracks"); return; }
                    if (candidate.timeline != null && (TimelineSlot.JD_H5.equals(provider)
                            || best == null || Kuaidi100TimelinePolicy.timedTrackCount(candidate.timeline)
                            > Kuaidi100TimelinePolicy.timedTrackCount(best.timeline))) best = candidate;
                    if (!TimelineSlot.JD_H5.equals(provider) && candidate.timeline != null) {
                        finish(candidate, "tracks"); return;
                    }
                }
                later(current, poll, 250L);
            });
        } catch (RuntimeException failed) {
            if (k100Diagnostics != null) k100Diagnostics.evaluationFailures++;
            finish(best, "evaluation_failed");
        }
    }

    void cancel() { finish(null, "cancelled"); }

    /**
     * 用户 2026-09-25 同意（方案 A，三端同一口径）：京粉页的结果带上抓没抓到物流。只有超时收尾、最后一次读到的状态是
     * 加载完、有视口、不是风控、union 请求没有出错，而且整次什么带物流的东西都没抓到，才是空壳；取消、加载失败、
     * 风控、union 请求出错都不算。union 请求发出去了、到超时还没回，也不算（用户 2026-09-26，其余裁决 4）。
     */
    private Result withPageEvidence(Result result, String reason) {
        boolean logistics = logisticsSeen || best != null || result != null && result.timeline != null;
        boolean emptyPage = "timeout".equals(reason) && !logistics
                && pageState != null && pageState.emptyShell()
                && (result == null || !result.throttled);
        if (!emptyPage && !logistics) return result;
        return result == null ? new Result(null, false, false, false, emptyPage, logistics)
                : new Result(result.timeline, result.complete, result.throttled, result.phoneRequired,
                        emptyPage, logistics);
    }

    private void finish(Result result, String reason) {
        if (finished) return;
        finished = true;
        if (TimelineSlot.JD_H5.equals(provider)) result = withPageEvidence(result, reason);
        if (k100Diagnostics != null) k100Diagnostics.finish(reason);
        WebView closing = view;
        view = null;
        if (closing != null) {
            closing.removeCallbacks(poll);
            closing.removeCallbacks(timeout);
            if (offWindowHandler != null) {
                offWindowHandler.removeCallbacks(poll);
                offWindowHandler.removeCallbacks(timeout);
            }
            try { closing.stopLoading(); } catch (RuntimeException ignored) { }
            ViewGroup parent = (ViewGroup) closing.getParent();
            if (parent != null) parent.removeView(closing);
            try { closing.destroy(); } catch (RuntimeException ignored) { }
        }
        callback.complete(result);
    }
}
