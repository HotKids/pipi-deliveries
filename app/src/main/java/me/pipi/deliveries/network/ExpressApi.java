package me.pipi.deliveries.network;

import android.content.Context;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** Public timeline and carrier-recognition adapters. */
public final class ExpressApi {
    public static final String PROVIDER_V4 = "v4";
    public static final String PROVIDER_KUAIDI100 = "kuaidi100";

    private final ExpressGatewayTransport gateway;
    private final CarrierRecognitionCoordinator carrierRecognition;

    public ExpressApi(Context context) {
        if (context == null) throw new IllegalArgumentException("context is required");
        gateway = new ExpressGatewayClient(context);
        carrierRecognition = CarrierRecognitionCoordinator.create(context);
    }

    ExpressApi(
            ExpressGatewayTransport gateway,
            Kuaidi100CarrierDetector carrierDetector) {
        if (gateway == null) throw new IllegalArgumentException("gateway is required");
        if (carrierDetector == null) {
            throw new IllegalArgumentException("carrierDetector is required");
        }
        this.gateway = gateway;
        carrierRecognition = new CarrierRecognitionCoordinator(
                carrierDetector, gateway, CarrierRecognitionCoordinator.transientState(),
                System::currentTimeMillis);
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

        public static QueryException phoneTailMismatch(String message) {
            return new QueryException(Kind.PHONE_MISMATCH, message);
        }

        public boolean needsPhoneTail() {
            return kind == Kind.PHONE_REQUIRED || kind == Kind.PHONE_MISMATCH;
        }

        public boolean phoneTailMismatch() {
            return kind == Kind.PHONE_MISMATCH;
        }
    }

    public String detect(String waybill) throws Exception {
        return detect(waybill, null);
    }

    public String detect(String waybill, ExpressQueryCancellation cancellation)
            throws Exception {
        List<me.pipi.deliveries.model.CarrierNormalization> candidates =
                detectCandidates(waybill, cancellation);
        return candidates.isEmpty() ? "" : candidates.get(0).kuaidi100Code;
    }

    private List<me.pipi.deliveries.model.CarrierNormalization> detectCandidates(
            String waybill, ExpressQueryCancellation cancellation) throws Exception {
        checkCancellation(cancellation);
        try {
            return carrierRecognition.recognize(waybill, cancellation).candidates;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw interrupted;
        } catch (Exception failure) {
            String message = failure.getMessage();
            throw new QueryException(message == null || message.trim().isEmpty()
                    ? "暂时无法识别承运商" : message);
        }
    }

    /** Executes only the activated public timeline adapter. */
    public ExpressQueryResult queryMoto(
            String waybill, String courierHint,
            ExpressQueryCancellation cancellation) throws Exception {
        checkCancellation(cancellation);
        String number = clean(waybill);
        if (number.length() < 6) throw new QueryException("请输入有效的快递单号");
        if (!gateway.configured()) throw new QueryException("快递查询服务尚未配置");
        // Only the source's raw carrier may select this upstream adapter.
        String rawCpCode = clean(courierHint);
        CarrierRegistry.Carrier hinted = CarrierRegistry.resolveCpCode(rawCpCode);
        if (hinted == null) {
            hinted = CarrierRegistry.resolveKuaidi100Code(rawCpCode);
        }
        if (!supportsV4(hinted)) throw new QueryException("公开物流查询暂无轨迹");
        return executeV4(number, rawCpCode, cancellation)
                .withCarrierNormalization(localNormalization(hinted));
    }

    private static me.pipi.deliveries.model.CarrierNormalization localNormalization(
            CarrierRegistry.Carrier carrier) {
        return new me.pipi.deliveries.model.CarrierNormalization(
                carrier.standardCode, carrier.companyName,
                carrier.kuaidi100Code, true, "");
    }

    private ExpressQueryResult executeV4(
            String number, String rawCpCode, ExpressQueryCancellation cancellation)
            throws Exception {
        checkCancellation(cancellation);
        JSONObject payload = new JSONObject()
                .put("waybill", number)
                .put("companyCode", rawCpCode);
        HttpClient.Response response = gateway.post(
                "/api/express/timeline/public", payload, cancellation);
        checkCancellation(cancellation);
        if (!response.successful()) {
            throw responseFailure(response, "公开物流查询失败");
        }
        JSONObject root = GatewayHttpErrors.parseObject(response, "公开物流查询失败");
        if (root.optInt("status", -1) != 0 || root.optJSONObject("data") == null) {
            String message = GatewayHttpErrors.safeMessage(root.toString());
            throw new QueryException(message.isEmpty() ? "公开物流查询失败" : message);
        }
        return parseV4(number, rawCpCode, root);
    }

    private static void checkCancellation(ExpressQueryCancellation cancellation)
            throws InterruptedException {
        if (cancellation != null) cancellation.throwIfCancelled();
    }

    private static QueryException responseFailure(
            HttpClient.Response response, String fallback) {
        return new QueryException(
                GatewayHttpErrors.forResponse(response, fallback).getMessage());
    }

    static boolean supportsV4(CarrierRegistry.Carrier carrier) {
        return carrier != null && !carrier.standardCode.isEmpty()
                && !"SF".equals(carrier.standardCode);
    }

    static ExpressQueryResult parseV4(String waybill, String codeHint, JSONObject root) {
        JSONObject data = root == null ? null : root.optJSONObject("data");
        if (data == null) data = new JSONObject();
        String responseCode = clean(data.optString("cpCode", ""));
        CarrierRegistry.Carrier carrier = CarrierRegistry.resolveCpCode(responseCode);
        if (carrier == null) carrier = CarrierRegistry.resolve(codeHint);
        if (carrier == null) carrier = CarrierRegistry.resolveKuaidi100Code(codeHint);
        String code = responseCode.isEmpty() ? clean(codeHint) : responseCode;
        String rawStatus = scalar(data.opt("logisticsStatus"));
        StatusSemantic structuredSemantic = StatusSemantic.fromStored(rawStatus, "");
        StatusSemantic semantic = structuredSemantic == StatusSemantic.UNKNOWN
                ? StatusSemantic.fromStored(
                        "", data.optString("logisticsStatusDesc", ""))
                : structuredSemantic;
        boolean structuredStatus = !rawStatus.isEmpty()
                && structuredSemantic != StatusSemantic.UNKNOWN;
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
        ExpressQueryResult result = new ExpressQueryResult(
                waybill,
                code,
                carrier == null
                        ? CarrierRegistry.companyName(code, data.optString("cpName", ""))
                        : carrier.companyName,
                semantic,
                latest == null ? "" : latest.optString("time", ""),
                latest == null ? "" : latest.optString("context", ""),
                tracks.toString(), "", "", PROVIDER_V4)
                .withManualStatusEvidence(
                        data.optString("logisticsStatusDesc", ""), structuredStatus);
        return carrier == null
                ? result : result.withCarrierNormalization(localNormalization(carrier));
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
        JSONArray tracks = normalizedKuaidi100Tracks(root.optJSONArray("data"));
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
        EventStatusEvidence evidence = latestEventStatus(tracks);
        ExpressTimeline.Track latestTimed = latestUsableTimedTrack(tracks.toString());
        StatusSemantic summarySemantic = latestTimed == null
                ? StatusSemantic.UNKNOWN
                : StatusSemantic.fromKuaidi100SummaryState(root.optString("state", ""));
        StatusSemantic semantic = summarySemantic == StatusSemantic.UNKNOWN
                ? evidence.semantic : summarySemantic;
        String detail = latestTimed == null
                ? latest == null ? "" : latest.optString("context", "")
                : latestTimed.detail;
        String time = latestTimed == null
                ? latest == null ? "" : latest.optString("time", "")
                : latestTimed.time;
        long statusEventTime = semantic == StatusSemantic.UNKNOWN ? 0L
                : summarySemantic == StatusSemantic.UNKNOWN ? evidence.eventTime
                : Math.max(evidence.eventTime, parseTime(latestTimed.time));
        // K100 summary state and track statusCode are outside FINAL's closed R-12 enum set.
        boolean structuredStatus = false;
        return new ExpressQueryResult(
                waybill,
                queryCode,
                CarrierRegistry.companyNameFromKuaidi100Code(
                        queryCode, root.optString("com", "")),
                semantic, statusEventTime,
                time,
                detail,
                tracks.toString(), "", "", PROVIDER_KUAIDI100,
                "", "", "")
                .withManualStatusEvidence(root.optString("stateDesc", ""), structuredStatus);
    }

    private static JSONArray normalizedKuaidi100Tracks(JSONArray source) {
        JSONArray tracks = new JSONArray();
        if (source == null) return tracks;
        for (int index = 0; index < source.length(); index++) {
            JSONObject value = source.optJSONObject(index);
            if (value == null) continue;
            try {
                tracks.put(new JSONObject(value.toString())
                        .put("_pipiStatusSource", PROVIDER_KUAIDI100));
            } catch (Throwable ignored) {
                // One malformed optional node cannot invalidate the rest of the response.
            }
        }
        return tracks;
    }

    private static ExpressTimeline.Track latestUsableTimedTrack(String tracksJson) {
        for (ExpressTimeline.Track track : ExpressTimeline.parse(tracksJson, "", "")) {
            if (parseTime(track.time) > 0L
                    && !ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) return track;
        }
        return null;
    }

    /** Selects only the newest timed Kuaidi100 event status, failing closed on a tie. */
    private static EventStatusEvidence latestEventStatus(JSONArray tracks) {
        long newestTime = 0L;
        StatusSemantic newestSemantic = StatusSemantic.UNKNOWN;
        if (tracks == null) return EventStatusEvidence.NONE;
        for (int index = 0; index < tracks.length(); index++) {
            JSONObject event = tracks.optJSONObject(index);
            if (event == null || !(event.opt("time") instanceof String)
                    || !event.has("statusCode")) continue;
            long eventTime = parseTime((String) event.opt("time"));
            if (eventTime <= 0L) continue;
            StatusSemantic eventSemantic = StatusSemantic.fromKuaidi100EventCode(
                    scalar(event.opt("statusCode")));
            if (eventTime > newestTime) {
                newestTime = eventTime;
                newestSemantic = eventSemantic;
            } else if (eventTime == newestTime && eventSemantic != newestSemantic) {
                newestSemantic = StatusSemantic.UNKNOWN;
            }
        }
        return newestTime <= 0L
                ? EventStatusEvidence.NONE
                : new EventStatusEvidence(newestSemantic, newestTime);
    }

    private static final class EventStatusEvidence {
        static final EventStatusEvidence NONE =
                new EventStatusEvidence(StatusSemantic.UNKNOWN, 0L);
        final StatusSemantic semantic;
        final long eventTime;

        EventStatusEvidence(StatusSemantic semantic, long eventTime) {
            this.semantic = semantic == null ? StatusSemantic.UNKNOWN : semantic;
            this.eventTime = Math.max(0L, eventTime);
        }
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
