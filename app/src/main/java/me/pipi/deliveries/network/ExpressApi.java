package me.pipi.deliveries.network;

import android.content.Context;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Public v4 and Kuaidi100 adapter backed only by Pipi's unified express gateway. */
public final class ExpressApi {
    public static final String PROVIDER_V4 = "v4";
    public static final String PROVIDER_KUAIDI100 = "kuaidi100";

    private final ExpressGatewayTransport gateway;

    public ExpressApi(Context context) {
        this(new ExpressGatewayClient(context));
    }

    ExpressApi(ExpressGatewayTransport gateway) {
        if (gateway == null) throw new IllegalArgumentException("gateway is required");
        this.gateway = gateway;
    }

    public static final class QueryException extends Exception {
        private enum Kind { OTHER, PHONE_REQUIRED, PHONE_MISMATCH }

        private final Kind kind;

        public QueryException(String message) {
            this(Kind.OTHER, message);
        }

        private QueryException(Kind kind, String message) {
            super(message);
            this.kind = kind == null ? Kind.OTHER : kind;
        }

        public static QueryException phoneTailRequired(String message) {
            return new QueryException(Kind.PHONE_REQUIRED, message);
        }

        public boolean needsPhoneTail() {
            return kind == Kind.PHONE_REQUIRED || kind == Kind.PHONE_MISMATCH;
        }

        public boolean phoneTailMismatch() {
            return kind == Kind.PHONE_MISMATCH;
        }
    }

    public String detect(String waybill) throws Exception {
        List<String> candidates = detectCandidates(waybill);
        return candidates.isEmpty() ? "" : candidates.get(0);
    }

    private List<String> detectCandidates(String waybill) throws Exception {
        JSONObject payload = new JSONObject().put("waybill", clean(waybill));
        HttpClient.Response response = gateway.post("/api/express/classify", payload);
        if (!response.successful()) throw new QueryException("暂时无法识别承运商");
        JSONObject root = new JSONObject(response.utf8());
        JSONArray values = root.optJSONArray("auto");
        ArrayList<String> candidates = new ArrayList<>();
        if (values == null) return candidates;
        for (int index = 0; index < values.length(); index++) {
            JSONObject value = values.optJSONObject(index);
            String code = value == null ? "" : clean(value.optString("comCode", ""));
            if (!code.isEmpty() && !candidates.contains(code)) candidates.add(code);
        }
        return candidates;
    }

    public ExpressQueryResult query(String waybill, String courierHint, String phone)
            throws Exception {
        return queryWithPhones(waybill, courierHint, Collections.singletonList(phone));
    }

    /** K100-only lookup retained for K100-owned automatic refresh and headline fallback. */
    public ExpressQueryResult queryWithPhones(
            String waybill, String courierHint, List<String> phones) throws Exception {
        return queryResolved(waybill, courierHint, phones, false, false);
    }

    /** Matches Pipi manual/detail priority: v4 public timeline first, then K100. */
    public ExpressQueryResult queryPreferredWithPhones(
            String waybill, String courierHint, List<String> phones) throws Exception {
        return queryResolved(waybill, courierHint, phones, true, false);
    }

    /**
     * Uses a carrier already returned by the free classifier without sending the same waybill to
     * that route for a second time. The timeline priority remains v4 first, then K100.
     */
    public ExpressQueryResult queryPreferredKnownCarrierWithPhones(
            String waybill, String courierHint, List<String> phones) throws Exception {
        return queryResolved(waybill, courierHint, phones, true, true);
    }

    public static String listSource(ExpressQueryResult result) {
        return result != null && PROVIDER_V4.equalsIgnoreCase(result.timelineProvider)
                ? "V4" : "KD-100";
    }

    private ExpressQueryResult queryResolved(
            String waybill, String courierHint, List<String> phones, boolean preferV4,
            boolean carrierAlreadyDetected)
            throws Exception {
        String number = clean(waybill);
        if (number.length() < 6) throw new QueryException("请输入有效的快递单号");
        if (!gateway.configured()) throw new QueryException("快递查询服务尚未配置");

        CarrierRegistry.Carrier known = CarrierRegistry.resolve(courierHint, "");
        ArrayList<String> queryCodes = new ArrayList<>();
        String exactHint = clean(courierHint);
        if (carrierAlreadyDetected && !exactHint.isEmpty()) {
            String detectedCode = known == null ? exactHint : known.kuaidi100Code;
            if (!detectedCode.isEmpty()) queryCodes.add(detectedCode);
        } else {
            try {
                // Keep carrier recognition aligned with Pipi: the free K100 classifier is the
                // authority for every manual lookup. A stored/local hint is only a resilience
                // fallback when classification is unavailable or omits a viable provider.
                queryCodes.addAll(detectCandidates(number));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw interrupted;
            } catch (Exception ignored) {
                // A known carrier can still complete the lookup while classification is unavailable.
            }
        }
        if (known == null && queryCodes.isEmpty()) {
            known = CarrierRegistry.guessByWaybill(number);
        }
        if (known != null && !known.kuaidi100Code.isEmpty()
                && !queryCodes.contains(known.kuaidi100Code)) {
            queryCodes.add(known.kuaidi100Code);
        }
        if (queryCodes.isEmpty()) throw new QueryException("暂时无法识别承运商");

        QueryException lastFailure = null;
        QueryException phoneFailure = null;
        ExpressQueryResult noTrackFallback = null;
        for (String queryCode : queryCodes) {
            CarrierRegistry.Carrier carrier = CarrierRegistry.resolve(queryCode, "");
            if (preferV4 && supportsV4(carrier)) {
                try {
                    ExpressQueryResult publicResult = executeV4(number, carrier.standardCode);
                    if (Kuaidi100TimelinePolicy.hasRealTracking(publicResult)) {
                        return publicResult;
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw interrupted;
                } catch (Exception ignored) {
                    // Pipi treats v4 as a preferred provider, never as a terminal failure.
                }
            }

            try {
                ExpressQueryResult result = queryKuaidi100Candidate(
                        number, queryCode, carrier, phones);
                if (!Kuaidi100TimelinePolicy.hasRealTracking(result)
                        && queryCodes.size() > 1) {
                    noTrackFallback = result;
                    continue;
                }
                return result;
            } catch (QueryException failure) {
                lastFailure = failure;
                if (failure.needsPhoneTail()) phoneFailure = failure;
            }
        }
        if (phoneFailure != null) throw phoneFailure;
        if (noTrackFallback != null) return noTrackFallback;
        throw lastFailure == null
                ? new QueryException("查询失败，请稍后重试") : lastFailure;
    }

    private ExpressQueryResult queryKuaidi100Candidate(
            String number, String queryCode, CarrierRegistry.Carrier carrier,
            List<String> phones) throws Exception {
        List<String> tails = phoneTails(phones);
        boolean requiresKnownTail = carrier != null && carrier.requiresPhoneTail;
        QueryException lastFailure = null;
        if (!requiresKnownTail) {
            try {
                return executeKuaidi100(number, queryCode, "");
            } catch (QueryException failure) {
                if (!failure.needsPhoneTail()) throw failure;
                lastFailure = failure;
            }
        }
        if (tails.isEmpty()) {
            throw QueryException.phoneTailRequired("请输入手机尾号");
        }
        for (String tail : tails) {
            try {
                return executeKuaidi100(number, queryCode, tail);
            } catch (QueryException failure) {
                lastFailure = failure;
            }
        }
        throw lastFailure == null
                ? QueryException.phoneTailRequired("请输入手机尾号")
                : lastFailure;
    }

    private ExpressQueryResult executeKuaidi100(
            String number, String queryCode, String phoneTail) throws Exception {
        JSONObject payload = new JSONObject()
                .put("waybill", number)
                .put("companyCode", queryCode)
                .put("phone", phoneTail);
        HttpClient.Response response = gateway.post(
                "/api/express/timeline/preferred", payload);
        if (!response.successful()) throw new QueryException("查询失败，请稍后重试");
        JSONObject root = new JSONObject(response.utf8());
        if (explicitFailure(root) && (phoneRejected(root, phoneTail) || !noTrackYet(root))) {
            String message = root.optString("message", "查询失败，请稍后重试");
            if (phoneRejected(root, phoneTail)) {
                boolean supplied = !phoneTail.isEmpty();
                throw new QueryException(
                        supplied ? QueryException.Kind.PHONE_MISMATCH
                                : QueryException.Kind.PHONE_REQUIRED,
                        supplied ? "手机尾号错误，请重新输入" : "请输入手机尾号");
            }
            throw new QueryException(message.isEmpty() ? "查询失败，请稍后重试" : message);
        }
        ExpressQueryResult parsed = parse(number, queryCode, root);
        return new ExpressQueryResult(
                parsed.waybill, parsed.courierCode, parsed.companyName, parsed.semantic,
                parsed.latestTime, parsed.latestDetail, parsed.tracksJson,
                parsed.detailUrl, phoneTail, PROVIDER_KUAIDI100);
    }

    private ExpressQueryResult executeV4(String number, String standardCode) throws Exception {
        JSONObject payload = new JSONObject()
                .put("waybill", number)
                .put("companyCode", standardCode);
        HttpClient.Response response = gateway.post("/api/express/timeline/public", payload);
        if (!response.successful()) throw new QueryException("公开物流查询失败");
        JSONObject root = new JSONObject(response.utf8());
        if (root.optInt("status", -1) != 0 || root.optJSONObject("data") == null) {
            throw new QueryException("公开物流查询失败");
        }
        return parseV4(number, standardCode, root);
    }

    static boolean supportsV4(CarrierRegistry.Carrier carrier) {
        return carrier != null && !carrier.standardCode.isEmpty()
                && !"SF".equals(carrier.standardCode);
    }

    static ExpressQueryResult parseV4(String waybill, String codeHint, JSONObject root) {
        JSONObject data = root == null ? null : root.optJSONObject("data");
        if (data == null) data = new JSONObject();
        String responseCode = clean(data.optString("cpCode", ""));
        CarrierRegistry.Carrier carrier = CarrierRegistry.resolve(responseCode, "");
        if (carrier == null) carrier = CarrierRegistry.resolve(codeHint, "");
        String code = carrier == null
                ? (responseCode.isEmpty() ? clean(codeHint) : responseCode)
                : carrier.standardCode;
        StatusSemantic semantic = StatusSemantic.fromStored(
                data.optString("logisticsStatus", ""),
                data.optString("logisticsStatusDesc", ""));
        JSONArray source = data.optJSONArray("fullTraceDetail");
        JSONArray tracks = new JSONArray();
        JSONObject latest = null;
        long latestMillis = Long.MIN_VALUE;
        if (source != null) {
            for (int index = 0; index < source.length(); index++) {
                JSONObject trace = source.optJSONObject(index);
                if (trace == null) continue;
                String time = clean(trace.optString("time", ""));
                String detail = clean(trace.optString("desc", ""));
                if (time.isEmpty() || detail.isEmpty()) continue;
                JSONObject normalized = new JSONObject();
                try {
                    normalized.put("time", time);
                    normalized.put("context", detail);
                    normalized.put("_pipiStatusSource", PROVIDER_V4);
                    tracks.put(normalized);
                } catch (Throwable ignored) {
                    continue;
                }
                long millis = parseTime(time);
                if (latest == null || millis > latestMillis) {
                    latest = normalized;
                    latestMillis = millis;
                }
            }
        }
        return new ExpressQueryResult(
                waybill,
                code,
                CarrierRegistry.companyName(code, data.optString("cpName", "")),
                semantic,
                latest == null ? "" : latest.optString("time", ""),
                latest == null ? "" : latest.optString("context", ""),
                tracks.toString(), "", "", PROVIDER_V4);
    }

    static List<String> phoneTails(List<String> phones) {
        ArrayList<String> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        if (phones == null) return result;
        for (String phone : phones) {
            String tail = normalizePhone(phone);
            if (tail.length() == 4 && seen.add(tail)) result.add(tail);
        }
        return result;
    }

    static ExpressQueryResult parse(String waybill, String queryCode, JSONObject root) {
        JSONArray tracks = root.optJSONArray("data");
        if (tracks == null) tracks = new JSONArray();
        JSONObject latest = null;
        long latestMillis = Long.MIN_VALUE;
        for (int index = 0; index < tracks.length(); index++) {
            JSONObject candidate = tracks.optJSONObject(index);
            if (candidate == null) continue;
            long millis = parseTime(candidate.optString("time", ""));
            if (latest == null || millis > latestMillis) {
                latest = candidate;
                latestMillis = millis;
            }
        }
        String statusCode = latest == null ? "" : scalar(latest.opt("statusCode"));
        StatusSemantic semantic = StatusSemantic.fromKuaidi100(
                statusCode, root.optString("state", ""));
        String detail = latest == null ? "" : latest.optString("context", "");
        String time = latest == null ? "" : latest.optString("time", "");
        return new ExpressQueryResult(
                waybill,
                queryCode,
                CarrierRegistry.companyName(queryCode, root.optString("com", "")),
                semantic,
                time,
                detail,
                tracks.toString(), "", "", PROVIDER_KUAIDI100);
    }

    private static boolean explicitFailure(JSONObject root) {
        if (root.has("result") && !root.optBoolean("result", false)) return true;
        String code = root.optString("returnCode", "");
        return !code.isEmpty() && !"200".equals(code);
    }

    private static boolean noTrackYet(JSONObject root) {
        if (!"500".equals(root.optString("returnCode", ""))) return false;
        JSONArray data = root.optJSONArray("data");
        return data == null || data.length() == 0;
    }

    private static boolean phoneRejected(JSONObject root, String phoneTail) {
        String message = root.optString("message", "").toLowerCase(Locale.ROOT);
        return "408".equals(root.optString("returnCode", ""))
                || message.contains("手机") || message.contains("电话")
                || message.contains("尾号") || message.contains("phone");
    }

    private static long parseTime(String value) {
        SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA);
        parser.setLenient(false);
        ParsePosition position = new ParsePosition(0);
        Date date = parser.parse(value, position);
        return date == null || position.getIndex() != value.length() ? 0L : date.getTime();
    }

    private static String normalizePhone(String phone) {
        String digits = clean(phone).replaceAll("\\D", "");
        return digits.length() <= 4 ? digits : digits.substring(digits.length() - 4);
    }

    private static String scalar(Object value) {
        return value instanceof String || value instanceof Number
                ? String.valueOf(value).trim() : "";
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
