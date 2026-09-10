package me.pipi.deliveries.feature.express;

import android.app.Activity;
import android.net.Uri;
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

/** One finite page load for one automatic provider package; never combines page responses. */
final class ExpressAutomaticTimelineCapture {
    interface Callback { void complete(Result result); }
    static final class Result {
        final ExpressQueryResult timeline;
        final boolean complete;
        final boolean throttled;
        Result(ExpressQueryResult timeline, boolean complete, boolean throttled) {
            this.timeline = timeline;
            this.complete = complete;
            this.throttled = throttled;
        }
    }
    private final Activity host;
    private final ExpressItem owner;
    private final String route;
    private final String provider;
    private final ExpressQueryCancellation cancellation;
    private final Callback callback;
    private final ExpressKuaidi100TimelineCapture.Diagnostics k100Diagnostics;
    private WebView view;
    private boolean finished;
    private Result best;
    private final Runnable poll = this::poll;
    private final Runnable timeout = () -> finish(best, "timeout");

    ExpressAutomaticTimelineCapture(Activity host, ExpressItem owner, String route,
            String provider, ExpressQueryCancellation cancellation, Callback callback) {
        this.host = host;
        this.owner = owner;
        this.route = route;
        this.provider = provider;
        this.cancellation = cancellation;
        this.callback = callback;
        this.k100Diagnostics = TimelineSlot.K100_H5.equals(provider)
                ? new ExpressKuaidi100TimelineCapture.Diagnostics() : null;
    }

    static Result capture(Activity host, ExpressItem owner, String route, String provider,
            ExpressQueryCancellation cancellation) throws InterruptedException {
        CountDownLatch done = new CountDownLatch(1);
        Result[] result = new Result[1];
        ExpressAutomaticTimelineCapture capture = new ExpressAutomaticTimelineCapture(
                host, owner, route, provider, cancellation, value -> {
                    result[0] = value;
                    done.countDown();
                });
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
        if (TimelineSlot.K100_H5.equals(provider)) {
            return !ManualRoutePolicy.safeKuaidi100Url(url).isEmpty();
        }
        return CainiaoRoute.isTrustedResolvedUrl(url);
    }

    void start() {
        if (finished) return;
        if (host.isFinishing() || host.isDestroyed() || cancellation.isCancelled()
                || !trusted(route)) { finish(null, "not_started"); return; }
        try {
            view = new WebView(host);
            view.setAlpha(0.01f);
            view.setClickable(false);
            view.setFocusable(false);
            view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            ExpressDetailActivity.configureWebView(view);
            view.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
            if (TimelineSlot.K100_H5.equals(provider)) view.getSettings().setUserAgentString(
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
            ViewGroup root = host.findViewById(android.R.id.content);
            if (root == null) { finish(null, "content_missing"); return; }
            root.addView(view, 0, new FrameLayout.LayoutParams(-1, -1));
            view.onResume();
            view.resumeTimers();
            view.loadUrl(route);
            view.postDelayed(poll, 250L);
            view.postDelayed(timeout, TimelineSlot.JD_H5.equals(provider) ? 20_000L : 8_000L);
        } catch (RuntimeException failed) {
            finish(null, "start_failed");
        }
    }

    private void poll() {
        WebView current = view;
        if (finished || current == null) return;
        if (cancellation.isCancelled() || host.isFinishing() || host.isDestroyed()) {
            finish(null, "cancelled_or_host_closed"); return;
        }
        if (!trusted(current.getUrl())) { current.postDelayed(poll, 250L); return; }
        String script = TimelineSlot.JD_H5.equals(provider)
                ? ExpressJingDongTimelineParser.readScript()
                : TimelineSlot.CN_H5.equals(provider) ? ExpressCainiaoTimelineParser.readScript()
                : ExpressKuaidi100TimelineCapture.extractionScript(
                        owner == null ? "" : owner.displayWaybill(),
                        owner == null || k100Diagnostics.phoneVerificationAttempted ? "" : owner.phone);
        try {
            if (k100Diagnostics != null) k100Diagnostics.evaluations++;
            current.evaluateJavascript(script, payload -> {
                if (finished || current != view || cancellation.isCancelled()) return;
                if (k100Diagnostics != null) k100Diagnostics.accept(payload);
                Result candidate;
                if (TimelineSlot.JD_H5.equals(provider)) {
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
                current.postDelayed(poll, 250L);
            });
        } catch (RuntimeException failed) {
            if (k100Diagnostics != null) k100Diagnostics.evaluationFailures++;
            finish(best, "evaluation_failed");
        }
    }

    void cancel() { finish(null, "cancelled"); }

    private void finish(Result result, String reason) {
        if (finished) return;
        finished = true;
        if (k100Diagnostics != null) k100Diagnostics.finish(reason);
        WebView closing = view;
        view = null;
        if (closing != null) {
            closing.removeCallbacks(poll);
            closing.removeCallbacks(timeout);
            try { closing.stopLoading(); } catch (RuntimeException ignored) { }
            ViewGroup parent = (ViewGroup) closing.getParent();
            if (parent != null) parent.removeView(closing);
            try { closing.destroy(); } catch (RuntimeException ignored) { }
        }
        callback.complete(result);
    }
}
