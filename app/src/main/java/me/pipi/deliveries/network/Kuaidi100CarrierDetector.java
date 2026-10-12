package me.pipi.deliveries.network;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.IOException;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;

/** Free, keyless carrier recognition performed directly by the Android client. */
final class Kuaidi100CarrierDetector {
    static final String ENDPOINT = "https://www.kuaidi100.com/autonumber/autoComNum";
    /**
     * 公开识别接口按 UA 判客户端：平台 Dalvik UA 会被 301，识别永远失败，行上没有内置承运商就
     * 一直显示「快递」（用户 2026-09-08 报）。Worker 侧 2026-09-03 就加了浏览器 UA，三个客户端的
     * 直连调用一直没跟上；三端同字。
     */
    static final String PUBLIC_USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    interface Transport {
        HttpClient.Response post(String url, ExpressQueryCancellation cancellation)
                throws Exception;
    }

    private final Transport transport;

    Kuaidi100CarrierDetector() {
        this((url, cancellation) -> cancellation == null
                ? HttpClient.postForm(url, "", false,
                        java.util.Collections.singletonMap("User-Agent", PUBLIC_USER_AGENT))
                : HttpClient.postForm(url, "", false, cancellation,
                        java.util.Collections.singletonMap("User-Agent", PUBLIC_USER_AGENT)));
    }

    Kuaidi100CarrierDetector(Transport transport) {
        if (transport == null) throw new IllegalArgumentException("transport is required");
        this.transport = transport;
    }

    /** One autoComNum candidate: its Kuaidi100 code and, when the answer carries one, its name. */
    static final class Candidate {
        final String code;
        final String name;

        Candidate(String code, String name) {
            this.code = clean(code);
            this.name = clean(name);
        }
    }

    List<String> detectCandidates(
            String waybill, ExpressQueryCancellation cancellation) throws Exception {
        List<String> codes = new ArrayList<>();
        for (Candidate candidate : detectNamedCandidates(waybill, cancellation)) {
            codes.add(candidate.code);
        }
        return codes;
    }

    List<Candidate> detectNamedCandidates(
            String waybill, ExpressQueryCancellation cancellation) throws Exception {
        String number = clean(waybill);
        if (number.length() < 6) return new ArrayList<>();
        if (cancellation != null) cancellation.throwIfCancelled();
        HttpClient.Response response;
        try {
            response = transport.post(requestUrl(number), cancellation);
        } catch (InterruptedException interrupted) {
            throw interrupted;
        } catch (IOException networkFailure) {
            if (cancellation != null) cancellation.throwIfCancelled();
            throw GatewayHttpErrors.networkFailure(networkFailure);
        }
        if (cancellation != null) cancellation.throwIfCancelled();
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "暂时无法识别承运商");
        }
        return parseNamedCandidates(response.utf8());
    }

    static String requestUrl(String waybill) {
        try {
            return ENDPOINT + "?text=" + URLEncoder.encode(clean(waybill), "UTF-8");
        } catch (UnsupportedEncodingException impossible) {
            throw new AssertionError("UTF-8 is unavailable", impossible);
        }
    }

    /**
     * Kuaidi100's "no match" answer is {@code {"result":false,"returnCode":"201"}}, the code written
     * as a string or as the number 201: it reads as unrecognized (the paid stage decides; user
     * decision 2026-09-26, 其余裁决 5).
     */
    private static boolean isNoMatch(JSONObject object) {
        if (!Boolean.FALSE.equals(object.opt("result"))) return false;
        Object code = object.opt("returnCode");
        if (code instanceof String) return "201".equals(((String) code).trim());
        return code instanceof Number && ((Number) code).doubleValue() == 201d;
    }

    /**
     * Audit C3 (user 2026-09-25): one reading with the Worker and Pipi, shared fixture
     * k100-autocomnum-responses.v1.json. A bare array or an {@code auto} list gives the candidates;
     * the no-match answer gives none (the paid stage decides); any other body — not JSON, HTML, an
     * object without {@code auto} — is a retryable failure that never reaches the paid stage.
     */
    static List<String> parseCandidates(String body) {
        ArrayList<String> codes = new ArrayList<>();
        for (Candidate candidate : parseNamedCandidates(body)) codes.add(candidate.code);
        return codes;
    }

    /**
     * {@link #parseCandidates} with each candidate's name, read from {@code name}, {@code comName} or
     * {@code companyName} as iOS parseKuaidi100CarrierCandidates reads it (其余裁决 29: an off-table
     * carrier is shown by the name Kuaidi100 gives).
     */
    static List<Candidate> parseNamedCandidates(String body) {
        ArrayList<Candidate> candidates = new ArrayList<>();
        JSONArray values;
        try {
            Object root = new JSONTokener(body == null ? "" : body).nextValue();
            if (root instanceof JSONArray) {
                values = (JSONArray) root;
            } else if (root instanceof JSONObject) {
                JSONObject object = (JSONObject) root;
                values = object.optJSONArray("auto");
                if (values == null && isNoMatch(object)) return candidates;
            } else {
                values = null;
            }
        } catch (Throwable invalid) {
            throw new IllegalArgumentException("invalid public carrier response", invalid);
        }
        if (values == null) throw new IllegalArgumentException("invalid public carrier response");
        ArrayList<String> seen = new ArrayList<>();
        for (int index = 0; index < values.length() && candidates.size() < 16; index++) {
            JSONObject value = values.optJSONObject(index);
            String code = value == null ? "" : clean(value.optString("comCode", ""));
            if (!code.matches("^[A-Za-z0-9_-]{1,32}$") || seen.contains(code)) {
                continue;
            }
            seen.add(code);
            candidates.add(new Candidate(code, firstText(value, "name", "comName", "companyName")));
        }
        return candidates;
    }

    private static String firstText(JSONObject value, String... keys) {
        for (String key : keys) {
            Object raw = value.opt(key);
            if (raw instanceof String && !((String) raw).trim().isEmpty()) return ((String) raw).trim();
        }
        return "";
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
