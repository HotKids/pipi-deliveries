package me.pipi.deliveries.feature.express;

import android.app.Activity;
import android.graphics.Bitmap;
import android.net.Uri;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.network.ExpressAccountSource;

/** Extracts one missing carrier waybill while the home screen is in the foreground. */
final class ExpressHomeOrderProjectionCapture {
    private static final String TAG = "ExpressOrderProjection";
    private static final long CAPTURE_TIMEOUT_MS = 20_000L;

    interface Callback {
        void onFinished(ExpressHomeOrderProjectionCapture capture, boolean saved);
    }

    private final Activity host;
    private final ExpressItem source;
    private final String bindingSource;
    private final Callback callback;
    private final ArrayList<Runnable> delayed = new ArrayList<>();
    private WebView webView;
    private boolean finished;

    ExpressHomeOrderProjectionCapture(
            Activity host, ExpressItem source, Callback callback) {
        this.host = host;
        this.source = source;
        String owner = source == null || source.stateOwner.isEmpty()
                ? source == null ? "" : source.source : source.stateOwner;
        this.bindingSource = ExpressAccountSource.bindingSourceForOwner(owner);
        this.callback = callback;
    }

    static boolean needsProjection(ExpressItem item) {
        return item != null && item.rowId > 0L && item.isAccountOrder()
                && item.projectedWaybill.isEmpty() && item.routeCredentialAvailable
                && !item.routeCredential.isEmpty();
    }

    boolean start() {
        if (finished || !needsProjection(source)
                || host.isFinishing() || host.isDestroyed()) return false;
        String detailUrl = ExpressDetailActivity.safeOrderH5Url(source);
        if (detailUrl.isEmpty()) return false;
        try {
            WebView capture = new WebView(host);
            webView = capture;
            capture.setAlpha(0f);
            capture.setClickable(false);
            capture.setFocusable(false);
            capture.setImportantForAccessibility(
                    View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            ExpressDetailActivity.configureWebView(capture);
            CookieManager.getInstance().setAcceptCookie(true);
            CookieManager.getInstance().setAcceptThirdPartyCookies(capture, true);
            ExpressOrderProjectionBridge.install(
                    capture, (sourceView, payload) -> accept(sourceView, payload, true));
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                WebViewCompat.addDocumentStartJavaScript(
                        capture,
                        ExpressDetailActivity.orderProjectionProbeScript(),
                        new HashSet<>(Arrays.asList(
                                "https://jd.com", "https://*.jd.com")));
            }
            capture.setWebViewClient(new WebViewClient() {
                @Override public void onPageStarted(
                        WebView view, String url, Bitmap icon) {
                    super.onPageStarted(view, url, icon);
                    inject(view);
                }

                @Override public boolean shouldOverrideUrlLoading(
                        WebView view, WebResourceRequest request) {
                    return request == null
                            || !ExpressDetailActivity.allowedOrderHost(request.getUrl());
                }

                @Override public void onPageCommitVisible(WebView view, String url) {
                    super.onPageCommitVisible(view, url);
                    inject(view);
                }

                @Override public void onPageFinished(WebView view, String url) {
                    super.onPageFinished(view, url);
                    inject(view);
                    inspect(view);
                }

                @Override public void onReceivedError(
                        WebView view, WebResourceRequest request, WebResourceError error) {
                    super.onReceivedError(view, request, error);
                    if (request == null || request.isForMainFrame()) complete(false);
                }

                @Override public void onReceivedHttpError(
                        WebView view, WebResourceRequest request,
                        WebResourceResponse response) {
                    super.onReceivedHttpError(view, request, response);
                    if (request == null || request.isForMainFrame()) complete(false);
                }

                @Override public boolean onRenderProcessGone(
                        WebView view, RenderProcessGoneDetail detail) {
                    Log.w(TAG, "Home identity capture renderer exited");
                    completeAfterRendererExit();
                    return true;
                }
            });
            FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(1, 1);
            params.gravity = Gravity.TOP | Gravity.START;
            host.addContentView(capture, params);
            capture.loadUrl(detailUrl);
            post(() -> inject(capture), 80L);
            post(() -> inject(capture), 350L);
            for (long delay : new long[]{1_000L, 3_000L, 6_000L, 10_000L, 16_000L}) {
                post(() -> inspect(capture), delay);
            }
            post(() -> complete(false), CAPTURE_TIMEOUT_MS);
            return true;
        } catch (Throwable failure) {
            Log.w(TAG, "Home identity capture could not start: "
                    + failure.getClass().getSimpleName());
            dispose(false);
            return false;
        }
    }

    void cancel() {
        dispose(false);
    }

    ExpressItem sourceItem() {
        return source;
    }

    private void inject(WebView target) {
        if (!current(target)) return;
        try {
            target.evaluateJavascript(
                    ExpressDetailActivity.orderProjectionProbeScript(), null);
        } catch (Throwable failure) {
            complete(false);
        }
    }

    private void inspect(WebView target) {
        if (!current(target)) return;
        try {
            target.evaluateJavascript(
                    ExpressDetailActivity.orderProjectionReadScript(), encoded -> {
                        if (!current(target)) return;
                        String projection = ExpressDetailActivity.decodeEvaluationString(encoded);
                        if (projection.isEmpty() || projection.length() > 128 * 1024) return;
                        accept(target, projection, false);
                    });
        } catch (Throwable failure) {
            complete(false);
        }
    }

    private void accept(WebView target, String projectionJson, boolean originValidated) {
        if (!current(target)) return;
        String pageUrl = target.getUrl();
        if (!originValidated && (pageUrl == null
                || !ExpressDetailActivity.allowedOrderHost(Uri.parse(pageUrl)))) return;
        try {
            ExpressOrderProjectionBridge.Candidate candidate =
                    ExpressOrderProjectionBridge.candidate(projectionJson, source.waybill);
            if (candidate == null) return;
            String waybill = candidate.waybill;
            String company = candidate.carrier;
            if (company.isEmpty()) {
                CarrierRegistry.Carrier inferred = CarrierRegistry.guessByWaybill(waybill);
                if (inferred != null) company = inferred.companyName;
            }
            ExpressRepository repository = ExpressRepository.get(host);
            ExpressItem current = repository.find(source.rowId);
            if (!sameUnresolvedSource(current)) {
                complete(false);
                return;
            }
            boolean saved = repository.saveOrderProjection(
                    source, bindingSource, waybill, company);
            if (saved) Log.i(TAG, "Captured home display identity from isolated H5");
            complete(saved);
        } catch (Throwable failure) {
            Log.w(TAG, "Home identity projection could not be applied: "
                    + failure.getClass().getSimpleName());
        }
    }

    private boolean sameUnresolvedSource(ExpressItem current) {
        return needsProjection(current)
                && ExpressOrderProjectionBridge.sameUnresolvedOwner(source, current);
    }

    private boolean current(WebView target) {
        return !finished && target != null && target == webView
                && !host.isFinishing() && !host.isDestroyed();
    }

    private void post(Runnable action, long delayMillis) {
        WebView target = webView;
        if (target == null) return;
        Runnable guarded = () -> {
            if (!finished && target == webView) action.run();
        };
        delayed.add(guarded);
        target.postDelayed(guarded, delayMillis);
    }

    private void complete(boolean saved) {
        if (finished) return;
        dispose(false);
        if (callback != null) callback.onFinished(this, saved);
    }

    private void completeAfterRendererExit() {
        if (finished) return;
        dispose(true);
        if (callback != null) callback.onFinished(this, false);
    }

    private void dispose(boolean rendererGone) {
        if (finished) return;
        finished = true;
        WebView closing = webView;
        webView = null;
        if (closing != null) {
            for (Runnable action : delayed) closing.removeCallbacks(action);
            delayed.clear();
            if (!rendererGone) {
                try { closing.stopLoading(); } catch (Throwable ignored) {}
                try { closing.loadUrl("about:blank"); } catch (Throwable ignored) {}
                try { closing.clearHistory(); } catch (Throwable ignored) {}
            }
            try {
                ViewGroup parent = (ViewGroup) closing.getParent();
                if (parent != null) parent.removeView(closing);
            } catch (Throwable ignored) {}
            try { closing.destroy(); } catch (Throwable ignored) {}
        }
    }
}
