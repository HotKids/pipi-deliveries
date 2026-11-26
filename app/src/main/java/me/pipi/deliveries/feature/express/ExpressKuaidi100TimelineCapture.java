package me.pipi.deliveries.feature.express;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.ManualRoutePolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.network.ExpressLog;

/**
 * Captures the existing H5 primary stage using the fixed K100 page or the official JT page.
 * Each parser verifies its own host and parcel identity within the eight-second budget.
 */
final class ExpressKuaidi100TimelineCapture {
    private static final String TAG = "ExpressK100Capture";
    /** 与 iOS / Pipi 那一级同值：8 秒。 */
    static final long CAPTURE_TIMEOUT_MS = ExpressCarrierH5CaptureCore.CAPTURE_TIMEOUT_MS;
    private static final long POLL_INTERVAL_MS = 300L;
    static final int MAX_TRACKS = ExpressCarrierH5CaptureCore.MAX_TRACKS;
    static final String SAFARI_MOBILE_USER_AGENT =
            ExpressCarrierH5CaptureCore.SAFARI_MOBILE_USER_AGENT;

    interface Callback {
        /** {@code tracksJson} 为空串表示这一级没有结果（超时、页面出错、抓不到节点）。 */
        void onFinished(ExpressKuaidi100TimelineCapture capture, String tracksJson);
    }

    private final Activity host;
    private final String route;
    private final String waybill;
    private final String phone;
    private List<String> phones;
    private final boolean jtPage;
    private boolean phoneRequired;
    private boolean phoneMismatch;
    private final Callback callback;
    private final ArrayList<Runnable> delayed = new ArrayList<>();
    private WebView webView;
    private String cachedPollScript;
    private boolean finished;
    private final Diagnostics diagnostics = new Diagnostics();
    private String exitReason = "cancelled";

    ExpressKuaidi100TimelineCapture(Activity host, String route, String waybill,
                                    String phone, Callback callback) {
        this.host = host;
        this.route = route == null ? "" : route.trim();
        this.waybill = waybill;
        this.phone = phone;
        this.phones = phoneCandidates(phone, Collections.emptyList());
        this.jtPage = !this.route.isEmpty()
                && this.route.equals(ManualRoutePolicy.primaryH5Url(waybill, "JTSD"));
        this.diagnostics.provider = jtPage ? TimelineSlot.JT_H5 : TimelineSlot.K100_H5;
        this.callback = callback;
    }

    static boolean isAllowedCaptureResource(String value) {
        return ExpressCarrierH5CaptureCore.isAllowedKuaidi100Resource(value);
    }

    static WebResourceResponse emptyCaptureResponse() {
        return ExpressCarrierH5CaptureCore.emptyCaptureResponse();
    }

    /**
     * Shared hidden WebView host setup used by both manual ({@link ExpressKuaidi100TimelineCapture})
     * and automatic ({@link ExpressAutomaticTimelineCapture}) H5 timeline loaders.
     */
    static WebView createConfiguredWebView(
            Context context, Activity host, boolean carrierUa, boolean installK100Probe, String waybill) {
        WebView capture = ExpressHiddenWebView.create(context, host);
        ExpressDetailActivity.configureWebView(capture);
        WebSettings settings = capture.getSettings();
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (carrierUa) {
            try {
                settings.setUserAgentString(SAFARI_MOBILE_USER_AGENT);
            } catch (Throwable ignored) {
                // Keep default UA when WebSettings rejects custom UA in test stubs.
            }
        }
        if (installK100Probe) {
            ExpressCarrierH5CaptureCore.installKuaidi100DocumentStartProbe(capture, waybill);
        }
        return capture;
    }

    static boolean mountAndLoad(
            Context offWindowContext, Activity host, WebView capture, String url) {
        if (host != null) {
            if (!ExpressHiddenWebView.attachToActivityContent(host, capture)) {
                return false;
            }
        } else {
            ExpressHiddenWebView.giveViewport(offWindowContext, capture, null);
        }
        ExpressHiddenWebView.resumeAndLoad(capture, url);
        return true;
    }

    static void tearDownWebView(
            WebView closing, Handler offWindowHandler, List<Runnable> callbacks, boolean rendererGone) {
        if (closing == null) return;
        if (callbacks != null) {
            for (Runnable action : callbacks) {
                closing.removeCallbacks(action);
                if (offWindowHandler != null) offWindowHandler.removeCallbacks(action);
            }
        }
        if (!rendererGone) {
            try { closing.stopLoading(); } catch (Throwable ignored) { }
            try { closing.setWebViewClient(new WebViewClient()); } catch (Throwable ignored) { }
            try { closing.loadUrl("about:blank"); } catch (Throwable ignored) { }
        }
        try {
            ExpressHiddenWebView.detach(closing);
        } catch (Throwable ignored) { }
        try { closing.destroy(); } catch (Throwable ignored) { }
    }

    void usePhoneCandidates(List<String> boundPhones) {
        phones = phoneCandidates(phone, boundPhones);
        cachedPollScript = null;
    }

    boolean needsPhoneTail() { return phoneRequired; }

    boolean isPhoneTailMismatch() { return phoneMismatch; }

    static List<String> phoneCandidates(String supplied, List<String> boundPhones) {
        return ExpressCarrierH5CaptureCore.phoneCandidates(supplied, boundPhones);
    }

    private String pollScript() {
        String script = cachedPollScript;
        if (script == null) {
            script = ExpressCarrierH5CaptureCore.pollScript(jtPage, waybill, phones);
            cachedPollScript = script;
        }
        return script;
    }

    boolean start() {
        if (finished) return false;
        if (host == null || host.isFinishing() || host.isDestroyed()) {
            diagnostics.finish("host_unavailable");
            return false;
        }
        if (ManualRoutePolicy.safePrimaryH5Url(route, waybill).isEmpty()) {
            diagnostics.finish("untrusted_route");
            return false;
        }
        try {
            WebView capture = createConfiguredWebView(host, host, true, !jtPage, waybill);
            webView = capture;
            cachedPollScript = ExpressCarrierH5CaptureCore.pollScript(jtPage, waybill, phones);
            capture.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(
                        WebView view, WebResourceRequest request) {
                    return request == null || request.getUrl() == null
                            || ManualRoutePolicy.safePrimaryH5Url(
                            request.getUrl().toString(), waybill).isEmpty();
                }

                @Override public WebResourceResponse shouldInterceptRequest(
                        WebView view, WebResourceRequest request) {
                    if (jtPage || request == null || request.getUrl() == null
                            || request.isForMainFrame()
                            || isAllowedCaptureResource(request.getUrl().toString())) {
                        return null;
                    }
                    return emptyCaptureResponse();
                }

                @Override public void onReceivedError(
                        WebView view, WebResourceRequest request, WebResourceError error) {
                    super.onReceivedError(view, request, error);
                    if (request == null || request.isForMainFrame()) {
                        diagnostics.errorCode = error == null ? null : error.getErrorCode();
                        complete("", "main_frame_error");
                    }
                }

                @Override public void onReceivedHttpError(
                        WebView view, WebResourceRequest request,
                        WebResourceResponse response) {
                    super.onReceivedHttpError(view, request, response);
                    if (request == null || request.isForMainFrame()) {
                        diagnostics.httpStatus = response == null ? null : response.getStatusCode();
                        complete("", "main_frame_http_error");
                    }
                }

                @Override public boolean onRenderProcessGone(
                        WebView view, RenderProcessGoneDetail detail) {
                    Log.w(TAG, "K100 capture renderer exited");
                    finishAfterRendererExit();
                    return true;
                }
            });
            if (!mountAndLoad(null, host, capture, route)) {
                exitReason = "content_missing";
                dispose(false);
                return false;
            }
            post(this::poll, POLL_INTERVAL_MS);
            post(() -> complete("", "timeout"), CAPTURE_TIMEOUT_MS);
            return true;
        } catch (Throwable failure) {
            Log.w(TAG, "K100 capture could not start: " + failure.getClass().getSimpleName());
            exitReason = "start_failed";
            dispose(false);
            return false;
        }
    }

    void cancel() {
        dispose(false);
    }

    private void poll() {
        WebView target = webView;
        if (finished || target == null) return;
        try {
            diagnostics.evaluations++;
            String slot = jtPage ? TimelineSlot.JT_H5 : TimelineSlot.K100_H5;
            target.evaluateJavascript(pollScript(), value -> {
                if (finished || target != webView) return;
                ExpressCarrierH5CaptureCore.PollFrame frame = decodeFrame(value, slot);
                diagnostics.accept(frame);
                phoneRequired = frame.isPhoneRequired() || !jtPage && phones.isEmpty()
                        && Boolean.TRUE.equals(diagnostics.checkCodeVisible);
                phoneMismatch = "PHONE_MISMATCH".equals(frame.failure)
                        || (phoneRequired && !phones.isEmpty() && diagnostics.phoneVerificationAttempted);
                if (phoneRequired) {
                    complete("", "phone_required");
                    return;
                }
                if (!frame.normalizedTracksJson.isEmpty()) {
                    complete(frame.normalizedTracksJson, "tracks");
                    return;
                }
                if (frame.isDeterministicTerminal()) {
                    complete("", frame.terminalReason());
                    return;
                }
                post(this::poll, POLL_INTERVAL_MS);
            });
        } catch (Throwable failure) {
            diagnostics.evaluationFailures++;
            complete("", "evaluation_failed");
        }
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

    private void complete(String tracksJson, String reason) {
        if (finished) return;
        exitReason = reason;
        dispose(false);
        if (callback != null) callback.onFinished(this, tracksJson == null ? "" : tracksJson);
    }

    private void finishAfterRendererExit() {
        if (finished) return;
        exitReason = "renderer_exit";
        dispose(true);
        if (callback != null) callback.onFinished(this, "");
    }

    private void dispose(boolean rendererGone) {
        if (finished) return;
        finished = true;
        diagnostics.finish(exitReason);
        WebView closing = webView;
        webView = null;
        if (closing == null) return;
        tearDownWebView(closing, null, delayed, rendererGone);
        delayed.clear();
    }

    static String extractionScript(String waybill, String phone) {
        return ExpressCarrierH5CaptureCore.kuaidi100ExtractionScript(waybill, phone);
    }

    static boolean phoneRequired(String payload) {
        return decodeFrame(payload, TimelineSlot.K100_H5).isPhoneRequired();
    }

    static String jtExtractionScript(String waybill, List<String> phones) {
        return ExpressCarrierH5CaptureCore.jtExtractionScript(waybill, phones);
    }

    static String extractionScript(String waybill, List<String> phones) {
        return ExpressCarrierH5CaptureCore.kuaidi100ExtractionScript(waybill, phones);
    }

    static String verificationScript(String waybill, String phone) {
        return ExpressCarrierH5CaptureCore.kuaidi100VerificationScript(waybill, phone);
    }

    static String verificationScript(String waybill, List<String> phones) {
        return ExpressCarrierH5CaptureCore.kuaidi100VerificationScript(waybill, phones);
    }

    static String extractionScript() {
        return ExpressCarrierH5CaptureCore.kuaidi100ExtractionScript();
    }

    static ExpressCarrierH5CaptureCore.PollFrame decodeFrame(String payload, String provider) {
        return ExpressCarrierH5CaptureCore.decodePollFrame(
                payload, provider, true, false, Kuaidi100TimelinePolicy::isValidTrack);
    }

    /** One scalar-only terminal record for either existing K100 loader. */
    static final class Diagnostics {
        String provider = TimelineSlot.K100_H5;
        int evaluations;
        int evaluationFailures;
        int validTracks;
        Boolean mainPresent;
        Boolean checkCodeVisible;
        boolean phoneVerificationAttempted;
        String readyState = "unknown";
        Integer errorCode;
        Integer httpStatus;
        private boolean emitted;

        void accept(String payload) {
            accept(decodeFrame(payload, provider));
        }

        void accept(ExpressCarrierH5CaptureCore.PollFrame frame) {
            if (frame == null || !frame.validFrame) {
                evaluationFailures++;
                return;
            }
            mainPresent = frame.mainPresent;
            checkCodeVisible = frame.checkCodeVisible;
            if (frame.phoneVerificationAttempted) phoneVerificationAttempted = true;
            readyState = frame.readyState;
            validTracks = frame.validTrackCount;
        }

        void finish(String reason) {
            if (emitted) return;
            emitted = true;
            ExpressLog.line("", provider, "", "capture_finished", "reason", reason,
                    "evaluations", evaluations, "evaluationFailures", evaluationFailures,
                    "mainPresent", mainPresent == null ? "unknown" : mainPresent,
                    "readyState", readyState,
                    "checkCodeVisible", checkCodeVisible == null ? "unknown" : checkCodeVisible,
                    "validTracks", validTracks,
                    "phoneVerificationAttempted", phoneVerificationAttempted,
                    "errorCode", errorCode == null ? "unknown" : errorCode,
                    "httpStatus", httpStatus == null ? "unknown" : httpStatus);
        }
    }

    static String normalizedTracks(String payload) {
        return normalizedTracks(payload, TimelineSlot.K100_H5);
    }

    static String normalizedTracks(String payload, String provider) {
        return decodeFrame(payload, provider).normalizedTracksJson;
    }
}
