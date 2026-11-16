package me.pipi.deliveries.feature.express;

import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;

/**
 * Shared Kuaidi100 ({@code k100_h5}) and J&amp;T ({@code jt_h5}) hidden-WebView capture core:
 * sub-resource allowlist, {@code DOCUMENT_START_SCRIPT} XHR/fetch interception, cached poll JS
 * builders, and single-pass {@link PollFrame} JSON decoding.
 */
final class ExpressCarrierH5CaptureCore {
    static final long CAPTURE_TIMEOUT_MS = 8_000L;
    static final int MAX_TRACKS = 100;
    static final String SAFARI_MOBILE_USER_AGENT =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15"
                    + " (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    static final Set<String> K100_DOCUMENT_START_ORIGINS =
            Collections.singleton("https://m.kuaidi100.com");

    interface TrackValidator {
        boolean isValid(String normalizedTime, String detail);
    }

    /** Cached poll script entry so 250ms/300ms poll ticks reuse one immutable JS string. */
    private static final class CachedScript {
        final boolean jt;
        final String waybill;
        final List<String> phones;
        final String script;

        CachedScript(boolean jt, String waybill, List<String> phones, String script) {
            this.jt = jt;
            this.waybill = waybill;
            this.phones = phones;
            this.script = script;
        }

        boolean matches(boolean jt, String waybill, List<String> phones) {
            return this.jt == jt
                    && Objects.equals(this.waybill, waybill)
                    && Objects.equals(this.phones, phones);
        }
    }

    private static volatile CachedScript lastPollScript;
    private static volatile String lastCaptureWaybill;
    private static volatile String lastCaptureScript;

    private ExpressCarrierH5CaptureCore() {}

    static String normalizeWaybill(String waybill) {
        if (waybill == null) return "";
        String normalized = Normalizer.normalize(waybill, Normalizer.Form.NFKC)
                .trim()
                .toUpperCase(Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
        return normalized;
    }

    static String phoneTail(String phone) {
        String saved = phone == null ? "" : phone.trim();
        String tail = saved.length() < 4 ? "" : saved.substring(saved.length() - 4);
        return tail.matches("[0-9]{4}") ? tail : "";
    }

    static List<String> phoneCandidates(String supplied, List<String> boundPhones) {
        ArrayList<String> tails = new ArrayList<>();
        String explicit = phoneTail(supplied);
        if (!explicit.isEmpty()) {
            tails.add(explicit);
            return tails;
        }
        if (boundPhones != null) {
            for (String candidate : boundPhones) {
                String tail = phoneTail(candidate);
                if (!tail.isEmpty() && !tails.contains(tail)) tails.add(tail);
            }
        }
        return tails;
    }

    static boolean isAllowedKuaidi100Resource(String value) {
        String clean = value == null ? "" : value.trim();
        if (clean.isEmpty()) return false;
        try {
            URI uri = new URI(clean);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if ("data".equals(scheme) || "blob".equals(scheme)) return true;
            if (!"https".equals(scheme) && !"http".equals(scheme)) return false;
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            return "kuaidi100.com".equals(host) || host.endsWith(".kuaidi100.com");
        } catch (Throwable ignored) {
            return false;
        }
    }

    static WebResourceResponse emptyCaptureResponse() {
        return new WebResourceResponse("text/plain", "utf-8", 204, "No Content",
                Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    static void installKuaidi100DocumentStartProbe(WebView webView, String waybill) {
        if (webView == null) return;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(
                    webView,
                    kuaidi100CaptureScript(waybill),
                    K100_DOCUMENT_START_ORIGINS);
        }
    }

    /** Observe Kuaidi100's /query XHR & fetch before page scripts mutate or decorate rows. */
    static String kuaidi100CaptureScript(String waybill) {
        String number = normalizeWaybill(waybill);
        String cachedWaybill = lastCaptureWaybill;
        String cachedScript = lastCaptureScript;
        if (number.equals(cachedWaybill) && cachedScript != null) {
            return cachedScript;
        }
        String built = "(function(){if(window.__pipiK100ResponseProbe)return;"
                + "var expected=" + JSONObject.quote(number) + ";"
                + "var state=window.__pipiK100ResponseProbe={sequence:0,pending:false,response:null};"
                + "function requestNumber(input,body){try{var u=new URL(input,location.href);"
                + "if(u.protocol!=='https:'||u.origin!==location.origin||u.pathname!=='/query')return false;"
                + "var values=u.searchParams.getAll('postid');"
                + "if(typeof body==='string'||body&&typeof body.getAll==='function'){"
                + "var p=typeof body==='string'?new URLSearchParams(body):body;"
                + "values=values.concat(p.getAll('postid'));}"
                + "return values.length===1&&values[0]===expected&&expected!=='';}catch(e){return false;}}"
                + "function begin(){state.pending=true;state.response=null;return ++state.sequence;}"
                + "function accept(sequence,text,status){if(sequence!==state.sequence)return;state.pending=false;"
                + "try{if(status<200||status>=300||typeof text!=='string'||text.length>2097152)return;var r=JSON.parse(text);"
                + "if(!r||typeof r!=='object')return;"
                + "if(r.nu!=null&&String(r.nu).toUpperCase().replace(/[^A-Z0-9]/g,'')!==expected){"
                + "state.response={foreign:true};return;}"
                + "if(String(r.status)!=='200'||!Array.isArray(r.data))return;"
                + "state.response={rows:r.data,empty:r.data.length===0};}catch(e){}}"
                + "if(window.XMLHttpRequest){var open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;"
                + "XMLHttpRequest.prototype.open=function(method,url){this.__pipiK100Url=url;"
                + "this.__pipiK100Generation=(this.__pipiK100Generation||0)+1;"
                + "return open.apply(this,arguments);};"
                + "XMLHttpRequest.prototype.send=function(body){var x=this;"
                + "if(requestNumber(x.__pipiK100Url,body)){var sequence=begin(),generation=x.__pipiK100Generation;"
                + "x.addEventListener('loadend',function(){if(x.__pipiK100Generation!==generation)return;"
                + "try{accept(sequence,x.responseText,x.status);}catch(e){"
                + "if(sequence===state.sequence)state.pending=false;}});}return send.apply(this,arguments);};}"
                + "var fetch=window.fetch;if(fetch)window.fetch=function(input,options){"
                + "var matches=requestNumber(typeof input==='string'?input:input&&input.url,options&&options.body);"
                + "var sequence=matches?begin():0,p=fetch.apply(this,arguments);"
                + "if(matches)p.then(function(r){try{r.clone().text().then(function(t){accept(sequence,t,r.status);},"
                + "function(){if(sequence===state.sequence)state.pending=false;});}catch(e){"
                + "if(sequence===state.sequence)state.pending=false;}},"
                + "function(){if(sequence===state.sequence)state.pending=false;});return p;};})();";
        lastCaptureWaybill = number;
        lastCaptureScript = built;
        return built;
    }

    static String pollScript(boolean jt, String waybill, List<String> phones) {
        String number = normalizeWaybill(waybill);
        List<String> normalizedPhones = Collections.unmodifiableList(phoneCandidates("", phones));
        CachedScript cached = lastPollScript;
        if (cached != null && cached.matches(jt, number, normalizedPhones)) {
            return cached.script;
        }
        String built = jt
                ? buildJtExtractionScript(number, normalizedPhones)
                : buildKuaidi100VerificationScript(number, normalizedPhones)
                        + buildKuaidi100ExtractionScript(number);
        lastPollScript = new CachedScript(jt, number, normalizedPhones, built);
        return built;
    }

    static String kuaidi100VerificationScript(String waybill, String phone) {
        String tail = phoneTail(phone);
        String number = normalizeWaybill(waybill);
        return tail.isEmpty() || number.isEmpty()
                ? ""
                : buildKuaidi100VerificationScript(number, Collections.singletonList(tail));
    }

    static String kuaidi100VerificationScript(String waybill, List<String> phones) {
        String number = normalizeWaybill(waybill);
        if (number.isEmpty()) return "";
        return buildKuaidi100VerificationScript(number, phoneCandidates("", phones));
    }

    private static String buildKuaidi100VerificationScript(String number, List<String> tails) {
        if (number.isEmpty()) return "";
        String candidates = new JSONArray(tails).toString();
        return "(function(){try{"
                + "var expected=" + JSONObject.quote(number) + ",tails=" + candidates + ";"
                + "if(location.protocol!=='https:'||location.hostname!=='m.kuaidi100.com'||location.pathname!=='/app/query/')return;"
                + "var numbers=new URL(location.href).searchParams.getAll('nu');"
                + "if(!expected||numbers.length!==1||numbers[0]!==expected)return;"
                + "var main=document.querySelector('#main'),vue=main&&main.__vue__;"
                + "if(!vue||typeof vue.num!=='string'||vue.num.toUpperCase().replace(/[^A-Z0-9]/g,'')!==expected)return;"
                + "if(!vue.checkCode||typeof vue.doCheckCode!=='function')return;"
                + "tails=tails.filter(function(v){return /^\\d{4}$/.test(v);});"
                + "var state=window.__pipiK100PhoneState||(window.__pipiK100PhoneState={index:0,submitted:false,started:false,outcome:'pending',failure:''});"
                + "if(window.__pipiK100Failure||state.outcome!=='pending')return;"
                + "if(state.submitted){if(vue.loading===true){state.started=true;return;}if(!state.started)return;"
                + "var error=vue.errors&&vue.errors.type;"
                + "if(error==='network'){state.outcome='provider_error';state.failure='HTTP';window.__pipiK100Failure='HTTP';return;}"
                + "if(error!==''&&error!=null){if(typeof error==='string'){state.outcome='provider_error';state.failure='OTHER';window.__pipiK100Failure='OTHER';}return;}"
                + "if(vue.loading===false&&vue.checkCode.show===true){state.index++;state.submitted=false;state.started=false;"
                + "if(state.index>=tails.length){state.outcome='phone_required';state.failure=state.index>0?'PHONE_MISMATCH':'PHONE_REQUIRED';window.__pipiK100Failure=state.failure;return;}}"
                + "else return;}"
                + "if(vue.checkCode.show!==true)return;"
                + "if(state.index>=tails.length){state.outcome='phone_required';state.failure=state.index>0?'PHONE_MISMATCH':'PHONE_REQUIRED';window.__pipiK100Failure=state.failure;return;}"
                + "state.submitted=true;window.__pipiK100PhoneSubmitted=true;"
                + "vue.checkCode.value=tails[state.index];vue.doCheckCode();state.started=vue.loading===true;"
                + "}catch(e){}})();";
    }

    static String kuaidi100ExtractionScript() {
        return buildKuaidi100ExtractionScript("");
    }

    static String kuaidi100ExtractionScript(String waybill) {
        return buildKuaidi100ExtractionScript(normalizeWaybill(waybill));
    }

    static String kuaidi100ExtractionScript(String waybill, String phone) {
        return kuaidi100VerificationScript(waybill, phone)
                + buildKuaidi100ExtractionScript(normalizeWaybill(waybill));
    }

    static String kuaidi100ExtractionScript(String waybill, List<String> phones) {
        return pollScript(false, waybill, phones);
    }

    private static String buildKuaidi100ExtractionScript(String number) {
        return "(function(){"
                + "var clean=function(v){return String(v==null?'':v).trim().replace(/\\s+/g,' ');};"
                // Vue component methods/filters often share names like time/context; accept scalars only.
                + "var text=function(v){return (typeof v==='string'||typeof v==='number')?clean(v):'';};"
                + "var host=clean(location.hostname).toLowerCase();"
                + "if(host!=='kuaidi100.com'&&!/\\.kuaidi100\\.com$/.test(host))return JSON.stringify({tracks:[],outcome:'untrusted_route'});"
                + "var main=document.querySelector('#main'),privateCheck=main&&main.__vue__&&main.__vue__.checkCode;"
                + "var diagnostics={mainPresent:null,readyState:'unknown',checkCodeVisible:null,"
                + "phoneVerificationAttempted:window.__pipiK100PhoneSubmitted===true};"
                + "try{diagnostics.mainPresent=!!main;"
                + "var ready=document.readyState;"
                + "if(ready==='loading'||ready==='interactive'||ready==='complete')diagnostics.readyState=ready;"
                + "var check=privateCheck;"
                + "if(check&&typeof check.show==='boolean')diagnostics.checkCodeVisible=check.show;}catch(e){}"
                + "var expected=" + JSONObject.quote(number) + ",vue=main&&main.__vue__;"
                + "if(expected){try{var u=new URL(location.href),numbers=u.searchParams.getAll('nu');"
                + "if(u.protocol!=='https:'||u.hostname!=='m.kuaidi100.com'||u.pathname!=='/app/query/'"
                + "||numbers.length!==1||numbers[0]!==expected)"
                + "return JSON.stringify({tracks:[],noResult:false,failure:'',outcome:'identity_mismatch',diagnostics:diagnostics});"
                + "if(vue&&typeof vue.num==='string'){var pageNum=vue.num.toUpperCase().replace(/[^A-Z0-9]/g,'');"
                + "if(pageNum!==expected)return JSON.stringify({tracks:[],noResult:false,failure:'',"
                + "outcome:pageNum===''?'pending':'identity_mismatch',diagnostics:diagnostics});}"
                + "}catch(e){return JSON.stringify({tracks:[],noResult:false,failure:'',outcome:'identity_mismatch',diagnostics:diagnostics});}}"
                + "var probe=window.__pipiK100ResponseProbe,response=probe&&probe.response;"
                + "if(response&&response.foreign)return JSON.stringify({tracks:[],noResult:false,failure:'',outcome:'identity_mismatch',diagnostics:diagnostics});"
                + "var phoneState=window.__pipiK100PhoneState||{},failure=window.__pipiK100Failure||phoneState.failure||'';"
                + "if(probe&&probe.pending)return JSON.stringify({tracks:[],noResult:false,failure:failure,outcome:phoneState.outcome||'pending',diagnostics:diagnostics});"
                + "var timeKeys=['time','ftime','timeText','datetime','date'];"
                + "var detailKeys=['context','desc','detail','remark','status','text'];"
                + "var tracks=[];var seenTrack={};"
                + "var append=function(item){if(!item||typeof item!=='object'||!response&&item.type==='gift'"
                + "||tracks.length>=" + MAX_TRACKS + ")return;"
                + "var timeText='';var detail='';var i;"
                + "for(i=0;i<timeKeys.length;i++){if(!timeText)timeText=text(item[timeKeys[i]]);}"
                + "for(i=0;i<detailKeys.length;i++){if(!detail)detail=text(item[detailKeys[i]]);}"
                + "if(!timeText||!detail||timeText===detail)return;"
                + "var key=timeText+'\\u0000'+detail;if(seenTrack[key])return;seenTrack[key]=1;"
                + "tracks.push({time:timeText,context:detail});};"
                + "if(response){for(var raw=0;raw<response.rows.length&&tracks.length<" + MAX_TRACKS
                + ";raw++)append(response.rows[raw]);}"
                + "var queue=[window.__INITIAL_STATE__,window.__NUXT__,window.__NEXT_DATA__];"
                + "var roots=document.querySelectorAll('body,#main,#app,.container');"
                + "for(var r=0;r<roots.length&&r<800;r++){if(roots[r]&&roots[r].__vue__)queue.push(roots[r].__vue__);}"
                + "var seen=[];"
                + "for(var index=0;!response&&index<queue.length&&index<800&&tracks.length<" + MAX_TRACKS + ";index++){"
                + "var value=queue[index];"
                + "if(!value||value===privateCheck||typeof value!=='object'||seen.indexOf(value)>=0)continue;seen.push(value);"
                + "if(Object.prototype.toString.call(value)==='[object Array]'){"
                + "for(var c=0;c<value.length&&tracks.length<" + MAX_TRACKS + ";c++){append(value[c]);"
                + "if(queue.length<800&&value[c]&&typeof value[c]==='object')queue.push(value[c]);}continue;}"
                + "append(value);"
                + "for(var k in value){if(queue.length>=800)break;if(k==='checkCode')continue;try{var child=value[k];"
                + "if(child&&typeof child==='object')queue.push(child);}catch(e){}}}"
                + "if(!response&&!tracks.length){"
                + "var selectors=['.result-list li','.result-list .item','.result-list .row',"
                + "'.trace-list li','.timeline li','.logistics li','[class*=trace] li'];"
                + "for(var s=0;s<selectors.length;s++){"
                + "var rows=document.querySelectorAll(selectors[s]);"
                + "for(var w=0;w<rows.length&&tracks.length<" + MAX_TRACKS + ";w++){"
                + "var timeNode=rows[w].querySelector('time,.time,.date,[class*=time],[class*=date]');"
                + "var detailNode=rows[w].querySelector('.context,.desc,.text,.status,[class*=context],[class*=desc]');"
                + "var t=clean(timeNode&&timeNode.textContent);"
                + "var d=clean(detailNode&&detailNode.textContent);"
                + "if(t&&d)append({time:t,context:d});}"
                + "if(tracks.length)break;}}"
                + "var visibleTracks=privateCheck&&privateCheck.show===true?[]:tracks.slice(0," + MAX_TRACKS + ");"
                + "var noResult=!!(response&&response.empty);"
                + "var outcome=visibleTracks.length?'tracks':noResult?'no_result':phoneState.outcome&&phoneState.outcome!=='pending'?phoneState.outcome:"
                + "(failure==='HTTP'||failure==='OTHER')?'provider_error':failure?'phone_required':'pending';"
                + "return JSON.stringify({tracks:visibleTracks,noResult:noResult,failure:failure,outcome:outcome,diagnostics:diagnostics});})();";
    }

    static String jtExtractionScript(String waybill, List<String> phones) {
        return pollScript(true, waybill, phones);
    }

    private static String buildJtExtractionScript(String number, List<String> tails) {
        String candidates = new JSONArray(tails).toString();
        return "(function(){try{"
                + "const expected=" + JSONObject.quote(number) + ",phones=" + candidates + ";"
                + "const clean=v=>String(v==null?'':v).replace(/\\s+/g,' ').trim();"
                + "const norm=v=>String(v==null?'':v).normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g,'');"
                + "const out={tracks:[],failure:'',noResult:false,outcome:'pending',"
                + "diagnostics:{mainPresent:false,readyState:document.readyState||'unknown',checkCodeVisible:false,phoneVerificationAttempted:false}};"
                + "const finish=outcome=>{out.outcome=outcome;return JSON.stringify(out);};"
                + "const loc=location&&location.href?new URL(location.href):location;"
                + "const protocol=loc&&loc.protocol||'',hostname=clean(loc&&loc.hostname).toLowerCase(),pathname=loc&&loc.pathname||'';"
                + "if(protocol!=='https:'||hostname!=='jtsd.jtexpress.com.cn'||pathname!=='/pipi')return finish('untrusted_route');"
                + "const rawHash=String(loc&&loc.hash||''),hash=rawHash.startsWith('#')?rawHash.slice(1):rawHash;"
                + "const split=hash.indexOf('?'),routePath=split<0?hash:hash.slice(0,split);"
                + "if(split<0||routePath!=='/pages/checkGoods/sendDetail')return finish('untrusted_route');"
                + "const params=new URLSearchParams(hash.slice(split+1)),numbers=params.getAll('waybillNo');"
                + "if(!expected||numbers.length!==1||norm(numbers[0])!==expected)return finish('identity_mismatch');"
                + "const state=window.__pipiJtCapture||(window.__pipiJtCapture={next:0,submitted:false,waitingWarning:''});"
                + "out.diagnostics.phoneVerificationAttempted=state.submitted||state.next>0;"
                + "const popup=document.querySelector('.query-popup');"
                + "const visible=!!(popup&&(typeof popup.getClientRects!=='function'||popup.getClientRects().length>0));"
                + "out.diagnostics.checkCodeVisible=visible;"
                + "const input=visible?(typeof popup.querySelector==='function'?popup.querySelector('input.uni-input-input'):null)"
                + "||document.querySelector('.query-popup input.uni-input-input'):null;"
                + "if(visible){if(!input||input.maxLength!=null&&String(input.maxLength)!=='4')return finish('pending');"
                + "const toast=document.querySelector('.uni-toast__content');"
                + "const message=clean(toast&&(typeof toast.getClientRects!=='function'||toast.getClientRects().length>0)?toast.textContent:'');"
                + "if(state.waitingWarning){if(message===state.waitingWarning)return finish('pending');state.waitingWarning='';}"
                + "if(state.submitted&&input.value===''){"
                + "if(/(手机|尾号|后四位|后4位)/.test(message)&&/(错误|不匹配|不正确|有误|验证失败)/.test(message)){"
                + "if(state.next>=phones.length){out.failure=state.next>0?'PHONE_MISMATCH':'PHONE_REQUIRED';return finish('phone_required');}"
                + "state.submitted=false;state.waitingWarning=message;return finish('pending');"
                + "}else if(message){out.failure='OTHER';return finish('provider_error');}"
                + "return finish('pending');}"
                + "if(!state.submitted){if(state.next>=phones.length){out.failure=state.next>0?'PHONE_MISMATCH':'PHONE_REQUIRED';return finish('phone_required');}"
                + "const phone=phones[state.next++];if(!/^[0-9]{4}$/.test(phone))return finish('pending');"
                + "state.submitted=true;out.diagnostics.phoneVerificationAttempted=true;"
                + "const setter=typeof HTMLInputElement==='function'&&HTMLInputElement.prototype"
                + "?Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')&&Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set:null;"
                + "if(setter)setter.call(input,phone);else input.value=phone;"
                + "input.dispatchEvent(new Event('input',{bubbles:true}));}return finish('pending');}"
                + "if(document.querySelector('.empty-box .cgs-null')){out.noResult=true;return finish('no_result');}"
                + "const header=document.querySelector('.scft-left .cgsllt-right');"
                + "if(!header)return finish('pending');"
                + "const headerNo=norm(header.textContent);"
                + "if(!headerNo)return finish('pending');"
                + "if(headerNo!==expected)return finish('identity_mismatch');"
                + "const rows=document.querySelectorAll('.scd-route .scdr-list');"
                + "out.diagnostics.mainPresent=rows.length>0;"
                + "for(let i=0;i<rows.length&&i<" + MAX_TRACKS + ";i++){"
                + "const row=rows[i],time=row.querySelector('.scdrlr-time'),right=row.querySelector('.scdrl-right');"
                + "if(!time||!right)continue;const label=row.querySelector('.scdrl-left');"
                + "const parts=[];for(let j=0;j<right.children.length;j++){const child=right.children[j];"
                + "if(!child.classList||!child.classList.contains('scdrlr-time'))parts.push(clean(child.textContent));}"
                + "const displayText=parts.filter(Boolean).join(' '),labelText=clean(label&&label.textContent);"
                + "const context=[labelText,displayText].filter(Boolean).join(' '),timeText=clean(time.textContent);"
                + "if(timeText&&context){const track={time:timeText,context:context,displayContext:displayText};"
                + "if(label)track.jtStatusLabel=labelText;out.tracks.push(track);}}"
                + "return finish(out.tracks.length?'tracks':'pending');"
                + "}catch(e){return JSON.stringify({tracks:[],failure:'',noResult:false,outcome:'pending'});}})()";
    }

    /** Single-pass decoded representation of one {@code evaluateJavascript} poll result. */
    static final class PollFrame {
        final boolean validFrame;
        final String normalizedTracksJson;
        final int validTrackCount;
        final boolean noResult;
        final String failure;
        final String outcome;
        final Boolean mainPresent;
        final Boolean checkCodeVisible;
        final boolean phoneVerificationAttempted;
        final String readyState;

        private PollFrame(
                boolean validFrame,
                String normalizedTracksJson,
                int validTrackCount,
                boolean noResult,
                String failure,
                String outcome,
                Boolean mainPresent,
                Boolean checkCodeVisible,
                boolean phoneVerificationAttempted,
                String readyState) {
            this.validFrame = validFrame;
            this.normalizedTracksJson = normalizedTracksJson;
            this.validTrackCount = validTrackCount;
            this.noResult = noResult;
            this.failure = failure;
            this.outcome = outcome;
            this.mainPresent = mainPresent;
            this.checkCodeVisible = checkCodeVisible;
            this.phoneVerificationAttempted = phoneVerificationAttempted;
            this.readyState = readyState;
        }

        static PollFrame invalid() {
            return new PollFrame(false, "", 0, false, "", "", null, null, false, "unknown");
        }

        boolean isPhoneRequired() {
            return "phone_required".equals(outcome)
                    || "PHONE_REQUIRED".equals(failure)
                    || "PHONE_MISMATCH".equals(failure);
        }

        boolean isDeterministicTerminal() {
            return noResult
                    || "no_result".equals(outcome)
                    || "provider_error".equals(outcome)
                    || "identity_mismatch".equals(outcome)
                    || "untrusted_route".equals(outcome)
                    || "HTTP".equals(failure)
                    || "OTHER".equals(failure);
        }

        String terminalReason() {
            if (noResult || "no_result".equals(outcome)) return "no_result";
            if ("identity_mismatch".equals(outcome) || "untrusted_route".equals(outcome)) {
                return outcome;
            }
            return "provider_error";
        }
    }

    static PollFrame decodePollFrame(
            String payload,
            String statusSource,
             boolean padMinuteTimestamps,
            boolean alwaysWriteStatusSource,
            TrackValidator validator) {
        try {
            Object decoded = new JSONTokener(payload == null ? "" : payload).nextValue();
            if (decoded instanceof String) {
                decoded = new JSONTokener((String) decoded).nextValue();
            }
            if (!(decoded instanceof JSONObject)) return PollFrame.invalid();
            JSONObject root = (JSONObject) decoded;
            Object rawTracksObj = root.opt("tracks");
            boolean hasTracksArray = rawTracksObj instanceof JSONArray;
            JSONObject metadata = root.optJSONObject("diagnostics");
            Object main = metadata == null ? null : metadata.opt("mainPresent");
            Object check = metadata == null ? null : metadata.opt("checkCodeVisible");
            Boolean mainPresent = main instanceof Boolean ? (Boolean) main : null;
            Boolean checkCodeVisible = check instanceof Boolean ? (Boolean) check : null;
            boolean phoneAttempted = metadata != null
                    && Boolean.TRUE.equals(metadata.opt("phoneVerificationAttempted"));
            String ready = metadata == null ? "" : metadata.optString("readyState", "");
            String readyState = "loading".equals(ready) || "interactive".equals(ready)
                    || "complete".equals(ready) ? ready : "unknown";

            boolean noResult = root.optBoolean("noResult", false);
            String failure = root.optString("failure", "");
            String outcome = root.optString("outcome", "");

            String normalizedTracksJson = "";
            int validCount = 0;
            if (hasTracksArray) {
                JSONArray raw = (JSONArray) rawTracksObj;
                if (raw.length() > 0) {
                    boolean isJt = "jt_h5".equals(statusSource);
                    JSONArray normalized = new JSONArray();
                    for (int index = 0; index < raw.length(); index++) {
                        JSONObject row = raw.optJSONObject(index);
                        if (row == null) continue;
                        String time = row.optString("time", "").trim();
                        if (padMinuteTimestamps
                                && time.matches("[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}")) {
                            time += ":00";
                        }
                        String detail = row.optString("context", "").trim();
                        if (time.isEmpty() || detail.isEmpty()) continue;
                        if (validator != null && !validator.isValid(time, detail)) continue;
                        JSONObject node = new JSONObject()
                                .put("time", time)
                                .put("context", detail);
                        if (alwaysWriteStatusSource || isJt) {
                            node.put("_pipiStatusSource", statusSource);
                        }
                        if (isJt) {
                            for (String key : new String[]{"displayContext", "jtStatusLabel"}) {
                                if (row.opt(key) instanceof String) {
                                    node.put(key, ((String) row.opt(key)).trim());
                                }
                            }
                        }
                        normalized.put(node);
                    }
                    validCount = normalized.length();
                    if (validCount > 0) {
                        normalizedTracksJson = normalized.toString();
                    }
                }
            }
            return new PollFrame(
                    hasTracksArray,
                    normalizedTracksJson,
                    validCount,
                    noResult,
                    failure,
                    outcome,
                    mainPresent,
                    checkCodeVisible,
                    phoneAttempted,
                    readyState);
        } catch (JSONException | RuntimeException malformed) {
            return PollFrame.invalid();
        }
    }
}
