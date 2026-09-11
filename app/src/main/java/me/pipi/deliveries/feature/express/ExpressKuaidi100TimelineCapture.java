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
import java.util.List;
import java.util.Collections;

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
    private final String waybill;
    private final String phone;
    private List<String> phones;
    private final boolean jtPage;
    private boolean phoneRequired;
    private final Callback callback;
    private final ArrayList<Runnable> delayed = new ArrayList<>();
    private WebView webView;
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

    void usePhoneCandidates(List<String> boundPhones) {
        phones = phoneCandidates(phone, boundPhones);
    }

    boolean needsPhoneTail() { return phoneRequired; }

    /** A supplied parcel suffix is authoritative; bound numbers are used only when absent. */
    static List<String> phoneCandidates(String supplied, List<String> boundPhones) {
        ArrayList<String> tails = new ArrayList<>();
        String explicit = phoneTail(supplied);
        if (!explicit.isEmpty()) { tails.add(explicit); return tails; }
        if (boundPhones != null) for (String candidate : boundPhones) {
            String tail = phoneTail(candidate);
            if (!tail.isEmpty() && !tails.contains(tail)) tails.add(tail);
        }
        return tails;
    }

    private static String phoneTail(String phone) {
        String saved = phone == null ? "" : phone.trim();
        String tail = saved.length() < 4 ? "" : saved.substring(saved.length() - 4);
        return tail.matches("[0-9]{4}") ? tail : "";
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
                            || ManualRoutePolicy.safePrimaryH5Url(
                            request.getUrl().toString(), waybill).isEmpty();
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
            ViewGroup content = host.findViewById(android.R.id.content);
            if (content == null) {
                exitReason = "content_missing";
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
            target.evaluateJavascript(jtPage ? jtExtractionScript(waybill, phones)
                    : extractionScript(waybill, phones), value -> {
                if (finished || target != webView) return;
                diagnostics.accept(value);
                phoneRequired = phoneRequired(value) || !jtPage && phones.isEmpty()
                        && Boolean.TRUE.equals(diagnostics.checkCodeVisible);
                if (phoneRequired) { complete("", "phone_required"); return; }
                String normalized = normalizedTracks(value);
                if (!normalized.isEmpty()) {
                    complete(normalized, "tracks");
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

    static String extractionScript(String waybill, String phone) {
        return verificationScript(waybill, phone) + extractionScript();
    }

    static boolean phoneRequired(String payload) {
        try {
            JSONObject value = decodedPayload(payload);
            return value != null && "phone_required".equals(value.optString("outcome"));
        } catch (org.json.JSONException ignored) { return false; }
    }

    /** Reads only the verified parcel DOM; verification uses the official visible input event. */
    static String jtExtractionScript(String waybill, List<String> phones) {
        String number = waybill == null ? "" : waybill.trim().toUpperCase(java.util.Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
        String candidates = new JSONArray(phoneCandidates("", phones)).toString();
        return "(function(){"
                + "var expected=" + JSONObject.quote(number) + ",tails=" + candidates + ";"
                + "var clean=function(v){return String(v==null?'':v).trim();};"
                + "var result={tracks:[],outcome:'pending',diagnostics:{mainPresent:false,readyState:document.readyState,checkCodeVisible:false,phoneVerificationAttempted:false}};"
                + "var finish=function(outcome){result.outcome=outcome;return JSON.stringify(result);};"
                + "if(location.protocol!=='https:'||location.hostname!=='jtsd.jtexpress.com.cn'||location.pathname!=='/pipi')return finish('untrusted_route');"
                + "var hash=location.hash||'',split=hash.indexOf('?');"
                + "if(split<0||hash.slice(0,split)!=='#/pages/checkGoods/sendDetail')return finish('untrusted_route');"
                + "var numbers=new URLSearchParams(hash.slice(split+1)).getAll('waybillNo');"
                + "if(!expected||numbers.length!==1||numbers[0]!==expected)return finish('identity_mismatch');"
                + "var state=window.__pipiJtH5||(window.__pipiJtH5={index:0,submitted:false});"
                + "result.diagnostics.phoneVerificationAttempted=state.submitted||state.index>0;"
                + "var popup=document.querySelector('.query-popup');"
                + "var input=popup&&popup.querySelector('input.uni-input-input');"
                + "var visible=!!(popup&&popup.getClientRects().length);"
                + "result.diagnostics.checkCodeVisible=visible;"
                + "if(visible&&input){"
                + "var toast=document.querySelector('.uni-toast__content');var message=clean(toast&&toast.getClientRects().length?toast.textContent:'');"
                + "var phoneWarning=/(手机|尾号|后四位|后4位)/.test(message)&&/(错误|不匹配|不正确|有误|验证失败)/.test(message);"
                + "if(state.waitingWarning){if(phoneWarning)return finish('pending');state.waitingWarning=false;}"
                + "if(state.submitted&&input.value===''){"
                + "if(phoneWarning){state.index++;state.submitted=false;if(state.index>=tails.length)return finish('phone_required');state.waitingWarning=true;return finish('pending');}"
                + "else if(message)return finish('provider_error');"
                + "}"
                + "if(!state.submitted){if(state.index>=tails.length)return finish('phone_required');"
                + "var setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;"
                + "setter.call(input,tails[state.index]);state.submitted=true;"
                + "input.dispatchEvent(new Event('input',{bubbles:true}));result.diagnostics.phoneVerificationAttempted=true;}"
                + "return finish('pending');}"
                + "var header=document.querySelector('.scft-left .cgsllt-right');"
                + "if(!header||clean(header.textContent)!==expected)return finish('identity_mismatch');"
                + "var rows=document.querySelectorAll('.scd-route .scdr-list');result.diagnostics.mainPresent=rows.length>0;"
                + "for(var i=0;i<rows.length&&i<" + MAX_TRACKS + ";i++){"
                + "var row=rows[i],time=row.querySelector('.scdrlr-time'),right=row.querySelector('.scdrl-right');"
                + "if(!time||!right)continue;var parts=[];"
                + "for(var j=0;j<right.children.length;j++){var child=right.children[j];if(!child.classList.contains('scdrlr-time'))parts.push(child.textContent||'');}"
                + "var status=row.querySelector('.scdrl-left'),detail=clean(parts.join('')),timeText=clean(time.textContent);"
                + "if(detail&&status&&clean(status.textContent))detail=clean(status.textContent)+' '+detail;"
                + "if(detail&&timeText)result.tracks.push({time:timeText,context:detail});}"
                + "return finish(result.tracks.length?'tracks':'no_result');})();";
    }

    static String extractionScript(String waybill, List<String> phones) {
        return verificationScript(waybill, phones) + extractionScript();
    }

    /** Submit only this parcel's saved suffix through the page's normal input and action. */
    static String verificationScript(String waybill, String phone) {
        String tail = phoneTail(phone);
        return tail.isEmpty() || waybill == null || waybill.trim().isEmpty() ? ""
                : verificationScript(waybill, Collections.singletonList(tail));
    }

    /** A fresh post-request challenge proves rejection; a pending or failed network request does not. */
    static String verificationScript(String waybill, List<String> phones) {
        String number = waybill == null ? "" : waybill.trim().toUpperCase(java.util.Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
        String candidates = new JSONArray(phoneCandidates("", phones)).toString();
        return "(function(){try{"
                + "var expected=" + JSONObject.quote(number) + ",tails=" + candidates + ";"
                + "if(location.protocol!=='https:'||location.hostname!=='m.kuaidi100.com'||location.pathname!=='/app/query/')return;"
                + "var numbers=new URL(location.href).searchParams.getAll('nu');"
                + "if(!expected||numbers.length!==1||numbers[0]!==expected)return;"
                + "var main=document.querySelector('#main'),vue=main&&main.__vue__;"
                + "if(!vue||typeof vue.num!=='string'||vue.num.toUpperCase().replace(/[^A-Z0-9]/g,'')!==expected)return;"
                + "if(!vue.checkCode||typeof vue.doCheckCode!=='function')return;"
                + "tails=tails.filter(function(v){return /^\\d{4}$/.test(v);});"
                + "var state=window.__pipiK100PhoneState||(window.__pipiK100PhoneState={index:0,submitted:false,started:false,outcome:'pending'});"
                + "if(state.outcome!=='pending')return;"
                + "if(state.submitted){if(vue.loading===true){state.started=true;return;}if(!state.started)return;"
                + "var error=vue.errors&&vue.errors.type;"
                + "if(error==='network'){state.outcome='provider_error';return;}"
                + "if(vue.loading===false&&vue.checkCode.show===true&&error===''){state.index++;state.submitted=false;state.started=false;}else return;}"
                + "if(vue.checkCode.show!==true)return;"
                + "if(state.index>=tails.length){state.outcome='phone_required';return;}"
                + "state.submitted=true;window.__pipiK100PhoneSubmitted=true;"
                + "vue.checkCode.value=tails[state.index];vue.doCheckCode();state.started=vue.loading===true;"
                + "}catch(e){}})();";
    }

    /** Existing track extraction stays independent of the private verification input. */
    static String extractionScript() {
        return "(function(){"
                + "var clean=function(v){return String(v==null?'':v).trim().replace(/\\s+/g,' ');};"
                // Vue 组件对象里 time/context 同名的常是过滤器函数；序列化出来就成了一条假节点。只收字符串/数字。
                + "var text=function(v){return (typeof v==='string'||typeof v==='number')?clean(v):'';};"
                + "var host=clean(location.hostname).toLowerCase();"
                + "if(host!=='kuaidi100.com'&&!/\\.kuaidi100\\.com$/.test(host))return JSON.stringify({tracks:[]});"
                + "var main=document.querySelector('#main'),privateCheck=main&&main.__vue__&&main.__vue__.checkCode;"
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
                + "var roots=document.querySelectorAll('body,#main,#app,.container');"
                + "for(var r=0;r<roots.length;r++){if(roots[r]&&roots[r].__vue__)queue.push(roots[r].__vue__);}"
                + "var seen=[];"
                + "for(var index=0;index<queue.length&&index<800&&tracks.length<" + MAX_TRACKS + ";index++){"
                + "var value=queue[index];"
                + "if(!value||value===privateCheck||typeof value!=='object'||seen.indexOf(value)>=0)continue;seen.push(value);"
                + "if(Object.prototype.toString.call(value)==='[object Array]'){"
                + "for(var c=0;c<value.length;c++){append(value[c]);"
                + "if(value[c]&&typeof value[c]==='object')queue.push(value[c]);}continue;}"
                + "append(value);"
                + "for(var k in value){if(k==='checkCode')continue;try{var child=value[k];"
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
                + "var diagnostics={mainPresent:null,readyState:'unknown',checkCodeVisible:null,"
                + "phoneVerificationAttempted:window.__pipiK100PhoneSubmitted===true};"
                + "try{diagnostics.mainPresent=!!main;"
                + "var ready=document.readyState;"
                + "if(ready==='loading'||ready==='interactive'||ready==='complete')diagnostics.readyState=ready;"
                + "var check=privateCheck;"
                + "if(check&&typeof check.show==='boolean')diagnostics.checkCodeVisible=check.show;}catch(e){}"
                + "return JSON.stringify({tracks:tracks.slice(0," + MAX_TRACKS + "),outcome:(window.__pipiK100PhoneState||{}).outcome||'pending',diagnostics:diagnostics});})();";
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
            try {
                JSONObject value = decodedPayload(payload);
                if (value == null || !(value.opt("tracks") instanceof JSONArray)) {
                    evaluationFailures++;
                    return;
                }
                JSONObject metadata = value.optJSONObject("diagnostics");
                Object main = metadata == null ? null : metadata.opt("mainPresent");
                Object check = metadata == null ? null : metadata.opt("checkCodeVisible");
                mainPresent = main instanceof Boolean ? (Boolean) main : null;
                checkCodeVisible = check instanceof Boolean ? (Boolean) check : null;
                if (metadata != null && Boolean.TRUE.equals(metadata.opt("phoneVerificationAttempted")))
                    phoneVerificationAttempted = true;
                String ready = metadata == null ? "" : metadata.optString("readyState", "");
                readyState = "loading".equals(ready) || "interactive".equals(ready)
                        || "complete".equals(ready) ? ready : "unknown";
                String tracks = normalizedTracks(payload);
                validTracks = tracks.isEmpty() ? 0 : new JSONArray(tracks).length();
            } catch (org.json.JSONException malformed) {
                evaluationFailures++;
            }
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

    private static JSONObject decodedPayload(String payload) throws org.json.JSONException {
        Object decoded = new JSONTokener(payload == null ? "" : payload).nextValue();
        if (decoded instanceof String) decoded = new JSONTokener((String) decoded).nextValue();
        return decoded instanceof JSONObject ? (JSONObject) decoded : null;
    }

    /** evaluateJavascript 回来的是 JSON 编码的字符串，里面才是 {tracks:[...]}；两层都解。 */
    static String normalizedTracks(String payload) {
        try {
            JSONObject decoded = decodedPayload(payload);
            if (decoded == null) return "";
            JSONArray raw = decoded.optJSONArray("tracks");
            if (raw == null || raw.length() == 0) return "";
            JSONArray normalized = new JSONArray();
            for (int index = 0; index < raw.length(); index++) {
                JSONObject row = raw.optJSONObject(index);
                if (row == null) continue;
                String time = row.optString("time", "").trim();
                if (time.matches("[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}")) time += ":00";
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
