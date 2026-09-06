package me.pipi.deliveries.feature.express;

import android.app.Activity;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.ArrayList;

import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.ManualRoutePolicy;

/**
 * 在隐藏 WebView 里抓 picker 给的 K100 结果页，把页面里的轨迹取成本地节点（用户定 2026-09-05：
 * 手动件/顺丰件详情的优先级是 picker 增量 → K100 H5 本地抓取 → K100 H5 网页兜底）。
 * 抓法与 Pipi 的 Kuaidi100H5Client、iOS 的 web-timeline 同一套：只认快递100 自己的域名，先读
 * 页面状态对象（__INITIAL_STATE__ / Vue 实例）里的 time/context 字段，读不到再按 DOM 兜底；
 * 过滤函数文本、时间解析不出来的行和来源报错文案；抓到就停，8 秒没抓到按没有结果处理。
 */
final class ExpressKuaidi100TimelineCapture {
    private static final String TAG = "ExpressK100Capture";
    /** 与 iOS / Pipi 那一级同值：8 秒。 */
    static final long CAPTURE_TIMEOUT_MS = 8_000L;
    private static final long POLL_INTERVAL_MS = 300L;
    private static final int MAX_TRACKS = 100;
    /** Fold7 2026-09-05 验证过的组合（Pipi）：Safari 移动端 UA + alpha 0.01 + resumeTimers。 */
    static final String SAFARI_MOBILE_USER_AGENT =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15"
                    + " (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

    interface Callback {
        /** {@code tracksJson} 为空串表示这一级没有结果（超时、页面出错、抓不到节点）。 */
        void onFinished(ExpressKuaidi100TimelineCapture capture, String tracksJson);
    }

    private final Activity host;
    private final String route;
    private final Callback callback;
    private final ArrayList<Runnable> delayed = new ArrayList<>();
    private WebView webView;
    private boolean finished;

    ExpressKuaidi100TimelineCapture(Activity host, String route, Callback callback) {
        this.host = host;
        this.route = route == null ? "" : route.trim();
        this.callback = callback;
    }

    boolean start() {
        if (finished || host == null || host.isFinishing() || host.isDestroyed()) return false;
        if (ManualRoutePolicy.safeKuaidi100Url(route).isEmpty()) return false;
        try {
            WebView capture = new WebView(host);
            webView = capture;
            // alpha=0 的 View 不会被绘制，Chromium 拿不到帧就停 rAF；留一点透明度让它真的被画出来。
            capture.setAlpha(0.01f);
            capture.setClickable(false);
            capture.setFocusable(false);
            capture.setImportantForAccessibility(
                    View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            ExpressDetailActivity.configureWebView(capture);
            WebSettings settings = capture.getSettings();
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            try {
                settings.setUserAgentString(SAFARI_MOBILE_USER_AGENT);
            } catch (Throwable ignored) {
                // UA 设不上就用默认值。
            }
            capture.setWebViewClient(new WebViewClient() {
                @Override public boolean shouldOverrideUrlLoading(
                        WebView view, WebResourceRequest request) {
                    return request == null || request.getUrl() == null
                            || ManualRoutePolicy.safeKuaidi100Url(
                            request.getUrl().toString()).isEmpty();
                }

                @Override public void onReceivedError(
                        WebView view, WebResourceRequest request, WebResourceError error) {
                    super.onReceivedError(view, request, error);
                    if (request == null || request.isForMainFrame()) complete("");
                }

                @Override public void onReceivedHttpError(
                        WebView view, WebResourceRequest request,
                        WebResourceResponse response) {
                    super.onReceivedHttpError(view, request, response);
                    if (request == null || request.isForMainFrame()) complete("");
                }

                @Override public boolean onRenderProcessGone(
                        WebView view, RenderProcessGoneDetail detail) {
                    Log.w(TAG, "K100 capture renderer exited");
                    finishAfterRendererExit();
                    return true;
                }
            });
            ViewGroup content = host.findViewById(android.R.id.content);
            if (content == null) {
                dispose(false);
                return false;
            }
            content.addView(capture, 0, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
            capture.onResume();
            capture.resumeTimers();
            capture.loadUrl(route);
            post(this::poll, POLL_INTERVAL_MS);
            post(() -> complete(""), CAPTURE_TIMEOUT_MS);
            return true;
        } catch (Throwable failure) {
            Log.w(TAG, "K100 capture could not start: " + failure.getClass().getSimpleName());
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
            target.evaluateJavascript(extractionScript(), value -> {
                if (finished || target != webView) return;
                String normalized = normalizedTracks(value);
                if (!normalized.isEmpty()) {
                    complete(normalized);
                    return;
                }
                post(this::poll, POLL_INTERVAL_MS);
            });
        } catch (Throwable failure) {
            complete("");
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

    private void complete(String tracksJson) {
        if (finished) return;
        dispose(false);
        if (callback != null) callback.onFinished(this, tracksJson == null ? "" : tracksJson);
    }

    private void finishAfterRendererExit() {
        if (finished) return;
        dispose(true);
        if (callback != null) callback.onFinished(this, "");
    }

    private void dispose(boolean rendererGone) {
        if (finished) return;
        finished = true;
        WebView closing = webView;
        webView = null;
        if (closing == null) return;
        for (Runnable action : delayed) closing.removeCallbacks(action);
        delayed.clear();
        if (!rendererGone) {
            try { closing.stopLoading(); } catch (Throwable ignored) { }
            try { closing.setWebViewClient(new WebViewClient()); } catch (Throwable ignored) { }
            try { closing.loadUrl("about:blank"); } catch (Throwable ignored) { }
        }
        try {
            ViewGroup parent = (ViewGroup) closing.getParent();
            if (parent != null) parent.removeView(closing);
        } catch (Throwable ignored) { }
        try { closing.destroy(); } catch (Throwable ignored) { }
    }

    /** 与 Pipi Kuaidi100H5Client.extractionScript 同一份脚本。 */
    static String extractionScript() {
        return "(function(){"
                + "var clean=function(v){return String(v==null?'':v).trim().replace(/\\s+/g,' ');};"
                // Vue 组件对象里 time/context 同名的常是过滤器函数；序列化出来就成了一条假节点。只收字符串/数字。
                + "var text=function(v){return (typeof v==='string'||typeof v==='number')?clean(v):'';};"
                + "var host=clean(location.hostname).toLowerCase();"
                + "if(host!=='kuaidi100.com'&&!/\\.kuaidi100\\.com$/.test(host))return JSON.stringify({tracks:[]});"
                + "var timeKeys=['time','ftime','timeText','datetime','date'];"
                + "var detailKeys=['context','desc','detail','remark','status','text'];"
                + "var tracks=[];var seenTrack={};"
                + "var append=function(item){if(!item||typeof item!=='object')return;"
                + "var timeText='';var detail='';var i;"
                + "for(i=0;i<timeKeys.length;i++){if(!timeText)timeText=text(item[timeKeys[i]]);}"
                + "for(i=0;i<detailKeys.length;i++){if(!detail)detail=text(item[detailKeys[i]]);}"
                + "if(!timeText||!detail||timeText===detail)return;"
                + "var key=timeText+'\\u0000'+detail;if(seenTrack[key])return;seenTrack[key]=1;"
                + "tracks.push({time:timeText,context:detail});};"
                + "var queue=[window.__INITIAL_STATE__,window.__NUXT__,window.__NEXT_DATA__];"
                + "var roots=document.querySelectorAll('body,#app,.container');"
                + "for(var r=0;r<roots.length;r++){if(roots[r]&&roots[r].__vue__)queue.push(roots[r].__vue__);}"
                + "var seen=[];"
                + "for(var index=0;index<queue.length&&index<800&&tracks.length<" + MAX_TRACKS + ";index++){"
                + "var value=queue[index];"
                + "if(!value||typeof value!=='object'||seen.indexOf(value)>=0)continue;seen.push(value);"
                + "if(Object.prototype.toString.call(value)==='[object Array]'){"
                + "for(var c=0;c<value.length;c++){append(value[c]);"
                + "if(value[c]&&typeof value[c]==='object')queue.push(value[c]);}continue;}"
                + "append(value);"
                + "for(var k in value){try{var child=value[k];"
                + "if(child&&typeof child==='object')queue.push(child);}catch(e){}}}"
                + "if(!tracks.length){"
                + "var selectors=['.result-list li','.result-list .item','.result-list .row',"
                + "'.trace-list li','.timeline li','.logistics li','[class*=trace] li'];"
                + "for(var s=0;s<selectors.length;s++){"
                + "var rows=document.querySelectorAll(selectors[s]);"
                + "for(var w=0;w<rows.length;w++){"
                + "var timeNode=rows[w].querySelector('time,.time,.date,[class*=time],[class*=date]');"
                + "var detailNode=rows[w].querySelector('.context,.desc,.text,.status,[class*=context],[class*=desc]');"
                + "var t=clean(timeNode&&timeNode.textContent);"
                + "var d=clean(detailNode&&detailNode.textContent);"
                + "if(t&&d)append({time:t,context:d});}"
                + "if(tracks.length)break;}}"
                + "return JSON.stringify({tracks:tracks.slice(0," + MAX_TRACKS + ")});})();";
    }

    /** evaluateJavascript 回来的是 JSON 编码的字符串，里面才是 {tracks:[...]}；两层都解。 */
    static String normalizedTracks(String payload) {
        try {
            Object decoded = new JSONTokener(payload == null ? "" : payload).nextValue();
            if (decoded instanceof String) {
                decoded = new JSONTokener((String) decoded).nextValue();
            }
            if (!(decoded instanceof JSONObject)) return "";
            JSONArray raw = ((JSONObject) decoded).optJSONArray("tracks");
            if (raw == null || raw.length() == 0) return "";
            JSONArray normalized = new JSONArray();
            for (int index = 0; index < raw.length(); index++) {
                JSONObject row = raw.optJSONObject(index);
                if (row == null) continue;
                String time = row.optString("time", "").trim();
                String detail = row.optString("context", "").trim();
                if (time.isEmpty() || detail.isEmpty()) continue;
                if (!Kuaidi100TimelinePolicy.isValidTrack(time, detail)) continue;
                normalized.put(new JSONObject().put("time", time).put("context", detail));
            }
            return normalized.length() == 0 ? "" : normalized.toString();
        } catch (Throwable ignored) {
            return "";
        }
    }
}
