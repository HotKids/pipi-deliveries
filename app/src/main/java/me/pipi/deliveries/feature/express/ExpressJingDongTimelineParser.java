package me.pipi.deliveries.feature.express;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

/** Single-response JD H5 packages, matching the iOS/Pipi projection contract. */
final class ExpressJingDongTimelineParser {
    private static final int MAX_CAPTURED_BODY_CHARS = 1_500_000;
    private static final String[] WAYBILL_KEYS = {
            "waybillCode", "waybillNo", "waybillNum", "waybillNumber",
            "expressNo", "expressCode", "logisticsNo", "logisticsCode", "mailNo"
    };
    private static final String[] TRACE_KEYS = {
            "traceList", "traces", "trackList", "tracks", "logisticsTraceList", "logisticsTracks"
    };

    static final class Packet {
        final ExpressQueryResult timeline;
        final boolean complete;
        final boolean throttled;

        Packet(ExpressQueryResult timeline, boolean complete, boolean throttled) {
            this.timeline = timeline;
            this.complete = complete;
            this.throttled = throttled;
        }
    }

    private ExpressJingDongTimelineParser() {}

    /** Polling also retries the exact expansion control as the viewport mounts its floor. */
    static String readScript() {
        return "(function(){" + probeScript() + ";return JSON.stringify({"
                + "q:window.__pipiJdUnionCaptures||[],k:window.__pipiJdRisk===1,"
                + "n:window.__pipiJdNetworkMaxTracks||0});})()";
    }

    static Packet parse(String payload, ExpressItem owner) {
        if (owner == null || owner.manuallyAdded
                || !"JingDong".equalsIgnoreCase(owner.sourceProvider)
                || payload == null || payload.length() > 4 * MAX_CAPTURED_BODY_CHARS) {
            return new Packet(null, false, false);
        }
        Object decoded = decode(payload);
        JSONObject root = decoded instanceof JSONObject ? (JSONObject) decoded : new JSONObject();
        boolean throttled = root.optBoolean("k", false);
        JSONArray queue = decoded instanceof JSONArray ? (JSONArray) decoded : root.optJSONArray("q");
        if (queue == null) queue = new JSONArray().put(root);
        ArrayList<Packet> network = new ArrayList<>();
        ArrayList<Packet> dom = new ArrayList<>();
        int networkTracks = Math.max(0, root.optInt("n", 0));
        Set<String> networkWaybills = new LinkedHashSet<>();
        for (int index = 0; index < queue.length(); index++) {
            Object value = decode(queue.opt(index));
            if (!(value instanceof JSONObject)) continue;
            JSONObject envelope = (JSONObject) value;
            boolean modal = "dom".equals(envelope.optString("source", ""));
            ExpressQueryResult result = singlePackage(envelope.opt("wholePayload"), owner);
            if (result == null) continue;
            int count = timedTracks(result);
            boolean proof = envelope.optBoolean("fullProgressRequestedAtStart", false);
            Packet packet = new Packet(result, count > 0 && (proof || (!modal && count >= 2)), throttled);
            (modal ? dom : network).add(packet);
            if (!modal) {
                networkTracks = Math.max(networkTracks, count);
                networkWaybills.add(normalize(result.waybill));
            }
        }
        Packet best = null;
        for (Packet packet : network) best = prefer(best, packet);
        for (Packet packet : dom) {
            if (!networkWaybills.isEmpty() && (networkWaybills.size() != 1
                    || !networkWaybills.contains(normalize(packet.timeline.waybill)))) continue;
            Packet bounded = timedTracks(packet.timeline) < networkTracks
                    ? new Packet(packet.timeline, false, throttled) : packet;
            best = prefer(best, bounded);
        }
        return best == null ? new Packet(null, false, throttled) : best;
    }

    private static Packet prefer(Packet current, Packet candidate) {
        if (current == null) return candidate;
        if (current.complete != candidate.complete) return candidate.complete ? candidate : current;
        if (current.complete) return timedTracks(candidate.timeline) > timedTracks(current.timeline)
                ? candidate : current;
        return Kuaidi100TimelinePolicy.latestTimedEventMillis(candidate.timeline)
                > Kuaidi100TimelinePolicy.latestTimedEventMillis(current.timeline) ? candidate : current;
    }

    private static int timedTracks(ExpressQueryResult timeline) {
        return timeline == null ? 0 : ExpressTimeline.parse(timeline.tracksJson, "", "").size();
    }

    private static ExpressQueryResult singlePackage(Object payload, ExpressItem owner) {
        if (payload instanceof String && ((String) payload).length() > MAX_CAPTURED_BODY_CHARS) return null;
        Object root = decode(payload);
        ArrayList<JSONObject> records = new ArrayList<>();
        visit(root, 0, records, Collections.newSetFromMap(new IdentityHashMap<>()));
        String excluded = owner.isAccountOrder() ? normalize(owner.waybill) : "";
        Set<String> allIdentities = new LinkedHashSet<>();
        for (JSONObject record : records) {
            allIdentities.addAll(identities(record, tracks(record), excluded));
            if (allIdentities.size() > 1) return null;
        }
        if (allIdentities.size() != 1) return null;
        String returned = allIdentities.iterator().next();
        String expected = normalize(owner.projectedWaybill);
        if (expected.isEmpty() && !owner.isAccountOrder()) expected = normalize(owner.waybill);
        if ((!expected.isEmpty() && !expected.equals(returned)) || returned.equals(excluded)) return null;
        ExpressQueryResult identityOnly = null;
        for (JSONObject record : records) {
            JSONArray input = tracks(record);
            Set<String> names = identities(record, input, excluded);
            if (names.size() != 1 || !names.contains(returned)) continue;
            String company = first(record, "expressName", "carrierName", "companyName",
                    "expressCompany", "expressCompanyName", "logisticsCompanyName", "logisticsCompany", "cpName");
            JSONArray output = new JSONArray();
            for (int index = 0; index < input.length() && index < 500; index++) {
                JSONObject row = input.optJSONObject(index);
                if (row == null) continue;
                String detail = first(row, "desc", "context", "description", "detail", "operateMessage");
                String time = first(row, "time", "date", "ftime", "operateTime");
                if (detail.isEmpty() || !Kuaidi100TimelinePolicy.isValidTrack(time, detail)) continue;
                if (company.isEmpty()) company = first(row, "expressName", "carrierName", "companyName",
                        "expressCompany", "expressCompanyName", "logisticsCompanyName", "logisticsCompany", "cpName");
                try {
                    output.put(new JSONObject().put("time", time).put("context", detail)
                            .put("_pipiStatusSource", "jingdong_h5"));
                } catch (org.json.JSONException ignored) { return null; }
            }
            String code = first(record, "cpCode", "companyCode", "carrierCode");
            CarrierRegistry.Carrier carrier = CarrierRegistry.resolveCpCode(code);
            if (carrier == null) carrier = CarrierRegistry.resolveName(company);
            String normalizedTracks = ExpressTimeline.mergeJson("[]", output.toString());
            List<ExpressTimeline.Track> normalized = ExpressTimeline.parse(normalizedTracks, "", "");
            ExpressTimeline.Track latest = normalized.isEmpty() ? null : normalized.get(0);
            // H5 contributes shipment identity and tracks, never the owner's shipment status.
            ExpressQueryResult result = new ExpressQueryResult(returned,
                    carrier == null ? code : carrier.standardCode,
                    carrier == null ? company : carrier.companyName,
                    StatusSemantic.UNKNOWN, 0L, latest == null ? "" : latest.time,
                    latest == null ? "" : latest.detail, normalizedTracks,
                    "", "", "jd_h5", "", "", "JingDong")
                    .withProjectedCarrierEvidence(company);
            if (!normalized.isEmpty()) return result;
            if (identityOnly == null) identityOnly = result;
        }
        return identityOnly;
    }

    private static Set<String> identities(JSONObject row, JSONArray tracks, String excluded) {
        LinkedHashSet<String> result = new LinkedHashSet<>();
        addIdentities(result, row, excluded);
        for (int index = 0; index < tracks.length(); index++) addIdentities(result, tracks.optJSONObject(index), excluded);
        return result;
    }

    private static void addIdentities(Set<String> output, JSONObject row, String excluded) {
        if (row == null) return;
        for (String key : WAYBILL_KEYS) {
            String value = normalize(first(row, key));
            if (value.length() >= 6 && value.length() <= 48 && !value.equals(excluded)) output.add(value);
        }
    }

    private static JSONArray tracks(JSONObject value) {
        for (String key : TRACE_KEYS) {
            JSONArray result = value.optJSONArray(key);
            if (result != null) return result;
        }
        return new JSONArray();
    }

    private static void visit(Object input, int depth, ArrayList<JSONObject> records, Set<Object> seen) {
        if (depth > 8 || records.size() >= 5_000) return;
        Object value = decode(input);
        if (!(value instanceof JSONObject) && !(value instanceof JSONArray)) return;
        if (!seen.add(value)) return;
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) visit(array.opt(index), depth + 1, records, seen);
        } else {
            JSONObject object = (JSONObject) value;
            records.add(object);
            Iterator<String> keys = object.keys();
            while (keys.hasNext() && records.size() < 5_000) visit(object.opt(keys.next()), depth + 1, records, seen);
        }
    }

    private static Object decode(Object value) {
        for (int pass = 0; pass < 3 && value instanceof String; pass++) {
            try {
                Object next = new JSONTokener((String) value).nextValue();
                if (value.equals(next)) break;
                value = next;
            } catch (org.json.JSONException ignored) { break; }
        }
        return value;
    }

    private static String first(JSONObject row, String... keys) {
        if (row == null) return "";
        for (String key : keys) {
            Object value = row.opt(key);
            if (value instanceof String || value instanceof Number) {
                String text = String.valueOf(value).trim();
                if (!text.isEmpty()) return text;
            }
        }
        return "";
    }

    private static String normalize(String value) {
        return value == null ? "" : value.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
    }

    static String probeScript() {
        return "(function(){"
                + "if(!window.__pipiJdProbe){window.__pipiJdProbe=1;"
                + "var fid=function(v,re){var s=String(v||'');try{s=decodeURIComponent(s)}catch(e){}"
                + "var m=re.exec(s);return m?m[1]:''};"
                + "var hit=function(u,b){var f=fid(u,/[?&]functionId=([A-Za-z0-9_]+)/);"
                + "if(!f)f=fid(b,/(?:^|&)functionId=([A-Za-z0-9_]+)/);return f==='getUnionActivity'};"
                + "var risk=function(st,v){try{if(st===403||/刷新几遍还不行/.test(String(v||'')))"
                + "window.__pipiJdRisk=1}catch(e){}};"
                + "var keep=function(v,full,src){try{if(typeof v==='string'&&v.length>"
                + MAX_CAPTURED_BODY_CHARS + ")return;"
                + "var r=typeof v==='string'?JSON.parse(v):v;"
                + "if(r&&typeof r==='object'){"
                + "if(src!=='dom'){try{var inf=r.data&&r.data.floors&&r.data.floors[0]&&"
                + "r.data.floors[0].element&&r.data.floors[0].element.info;"
                + "var nt=inf&&Array.isArray(inf.traceList)?inf.traceList:[];"
                + "var nc=nt.filter(function(t){return t&&(t.operateTime||t.time||t.date||t.ftime)"
                + "&&(t.operateMessage||t.context||t.desc||t.description||t.detail)}).length;"
                + "window.__pipiJdNetworkMaxTracks=Math.max(window.__pipiJdNetworkMaxTracks||0,nc);"
                + "var w=inf&&String(inf.waybillCode||'').toUpperCase().replace(/[^A-Z0-9]/g,'');"
                + "if(w&&w.length>=6){window.__pipiJdUnionWaybill=w;"
                + "}}catch(e){}}"
                + "var next={wholePayload:JSON.stringify(r),"
                + "fullProgressRequestedAtStart:full===true||!!(full&&full.succeeded),"
                + "source:src==='dom'?'dom':'network'};"
                + "var q=window.__pipiJdUnionCaptures;"
                + "if(!Array.isArray(q))q=[];q.push(JSON.stringify(next));"
                + "while(q.length>4)q.shift();window.__pipiJdUnionCaptures=q}"
                + "}catch(e){}};"
                + "window.__pipiJdKeep=keep;"
                + "var f=window.fetch;if(f){"
                + "window.fetch=function(a,b){var u=a&&a.url||a;"
                + "var expandedAtStart=window.__pipiJdExpansionAttempt;"
                + "var pending=f.apply(this,arguments);return pending.then(function(r){"
                + "if(hit(u,b&&b.body)){var h=r&&r.headers&&r.headers.get;"
                + "var t=String(h&&h.call(r.headers,'content-type')||'');"
                + "var n=Number(h&&h.call(r.headers,'content-length'));"
                + "if((!t||/(json|javascript|text)/i.test(t))&&"
                + "(!Number.isFinite(n)||n<=" + MAX_CAPTURED_BODY_CHARS
                + "))r.clone().text().then(function(v){risk(r&&r.status,v);"
                + "keep(v,expandedAtStart)}).catch(function(){})}return r})}}"
                + "var o=XMLHttpRequest.prototype.open,s=XMLHttpRequest.prototype.send;"
                + "XMLHttpRequest.prototype.open=function(m,u){this.__pipiJdUrl=u;"
                + "return o.apply(this,arguments)};"
                + "XMLHttpRequest.prototype.send=function(b){"
                + "var expandedAtStart=window.__pipiJdExpansionAttempt;"
                + "if(hit(this.__pipiJdUrl,b)){this.addEventListener('load',function(){"
                + "var t=String(this.getResponseHeader&&"
                + "this.getResponseHeader('content-type')||'');"
                + "var n=Number(this.getResponseHeader&&this.getResponseHeader('content-length'));"
                + "if((!t||/(json|javascript|text)/i.test(t))&&"
                + "(!Number.isFinite(n)||n<=" + MAX_CAPTURED_BODY_CHARS
                + ")){risk(this.status,this.responseText);"
                + "keep(this.responseText,expandedAtStart)}})}"
                + "return s.apply(this,arguments)};}"
                + "var button=document.querySelector('.logistics-button');"
                + "var label=button&&button.querySelector('.logistics-button-text');"
                + "if(button&&String(label&&(label.innerText||label.textContent)||'')"
                + ".replace(/[\\s>›〉»]+$/,'').trim()"
                + "==='完整物流进度'&&!window.__pipiJdExpanded){"
                // A later successful click cannot validate requests started by a failed click.
                + "var attempt={succeeded:false};window.__pipiJdExpansionAttempt=attempt;"
                + "try{button.click();attempt.succeeded=true;window.__pipiJdExpanded=1}catch(e){"
                + "window.__pipiJdExpansionAttempt=null;window.__pipiJdExpanded=0}}"
                + "if(window.__pipiJdExpanded===1){try{"
                + "var items=document.querySelectorAll('.logistics-status-info.child-status');"
                + "var head=document.querySelector('.logistics-top-narrow');"
                + "var net=String(window.__pipiJdUnionWaybill||'');var ht=String(head&&head.innerText||'');"
                + "var toks=ht.replace(/复制/g,' ').match(/[A-Za-z0-9-]{8,48}/g)||[];var wb='';"
                + "for(var i=0;i<toks.length;i++){var t=toks[i].toUpperCase();if(!/\\d/.test(t))continue;"
                + "if(net&&t===net){wb=t;break}if(!wb)wb=t}"
                + "if(net&&wb&&wb!==net)wb='';"
                + "var cnm=ht.match(/[\\u4e00-\\u9fa5]{2,12}/);var cn=cnm?cnm[0]:'';"
                + "window.__pipiJdDom={i:items.length,h:!!head,w:!!wb,n:!!net};"
                + "if(wb&&items.length>(window.__pipiJdDomCount||0)){"
                + "var tl=[];for(var j=0;j<items.length&&j<500;j++){var it=items[j];"
                + "var q=function(c){var y=it.querySelector(c);return y?String(y.innerText||'').trim():''};"
                + "var tm=q('.status-time'),ms=q('.status-msg'),ds=q('.status-desc');"
                + "if(tm&&ms)tl.push({operateTime:tm,operateDesc:ds,operateMessage:ms,waybillCode:wb})}"
                + "window.__pipiJdDom.t=tl.length;"
                + "if(tl.length){window.__pipiJdDomCount=items.length;"
                // The modal mounts after document-start; each poll has a fresh local scope.
                + "window.__pipiJdKeep(JSON.stringify({data:{floors:[{element:{info:{waybillCode:wb,companyName:cn,"
                + "traceList:tl}}}]}}),true,'dom')}}}catch(e){}}"
                + "return JSON.stringify(window.__pipiJdUnionCaptures||[]);})()";
    }
}
