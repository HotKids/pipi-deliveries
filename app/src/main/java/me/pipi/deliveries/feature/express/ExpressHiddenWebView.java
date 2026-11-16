package me.pipi.deliveries.feature.express;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.util.DisplayMetrics;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.WebView;
import android.widget.FrameLayout;

/**
 * Shared hidden WebView creation, viewport attachment, timer activation, and teardown for
 * express H5 trace/order captures ({@code jd_h5}, {@code k100_h5}/{@code jt_h5}, {@code cn_h5}, PDD).
 */
final class ExpressHiddenWebView {
    static final float CAPTURE_ALPHA = 0.01f;

    private ExpressHiddenWebView() {}

    static Activity foregroundHost() {
        Activity host = ExpressForegroundHost.current();
        if (host != null && (host.isFinishing() || host.isDestroyed())) {
            return null;
        }
        return host;
    }

    static WebView create(Context context, Activity host) {
        WebView webView = new PassiveWebView(host != null ? host : context);
        // Views with alpha=0 are not drawn, causing Chromium to throttle rAF and timers to 1s.
        webView.setAlpha(CAPTURE_ALPHA);
        webView.setClickable(false);
        webView.setFocusable(false);
        webView.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        return webView;
    }

    static boolean attachToActivityContent(Activity host, WebView webView) {
        ViewGroup content = host == null || host.isFinishing() || host.isDestroyed()
                ? null : host.findViewById(android.R.id.content);
        if (content == null) return false;
        content.addView(webView, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        return true;
    }

    static void giveViewport(Context context, WebView webView, Activity host) {
        if (attachToActivityContent(host, webView)) {
            return;
        }
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        int width = metrics != null && metrics.widthPixels > 0 ? metrics.widthPixels : 1080;
        int height = metrics != null && metrics.heightPixels > 0 ? metrics.heightPixels : 1920;
        webView.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
        webView.layout(0, 0, width, height);
    }

    static void resumeAndLoad(WebView webView, String url) {
        webView.onResume();
        webView.resumeTimers();
        webView.loadUrl(url);
    }

    static void activateAndLoad(Context context, WebView webView, Activity host, String url) {
        giveViewport(context, webView, host);
        resumeAndLoad(webView, url);
    }

    static void detach(WebView webView) {
        if (webView == null) return;
        ViewParent parent = webView.getParent();
        if (parent instanceof ViewGroup) {
            ((ViewGroup) parent).removeView(webView);
        }
    }

    /** A transparent capture surface that never takes touches away from the hosting activity. */
    static final class PassiveWebView extends WebView {
        PassiveWebView(Context context) {
            super(context);
        }

        @Override
        public boolean dispatchTouchEvent(MotionEvent event) {
            return false;
        }

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean onTouchEvent(MotionEvent event) {
            return false;
        }
    }
}
