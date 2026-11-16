package me.pipi.deliveries.network;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.IOException;
import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Free, keyless carrier recognition performed directly by the Android client. */
final class Kuaidi100CarrierDetector {
    static final String ENDPOINT = "https://www.kuaidi100.com/autonumber/autoComNum";
    /**
     * 这个公开接口按 UA 判客户端：不带浏览器 UA 就回 301，加上 followRedirects(false) 等于识别
     * 永远失败，行上没有内置承运商就一直显示「快递」（用户 2026-09-08 报，S26U JDVB68579779751；
     * curl 实测同一单号带浏览器 UA 返回 auto=[{comCode:"jd"}]）。Worker 侧 2026-09-03 就改了
     * （KUAIDI100_PUBLIC_USER_AGENT），三个客户端的直连调用统一对齐浏览器 UA。
     */
    static final String PUBLIC_USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    interface HttpResponse {
        int status();
        boolean successful();
        String utf8();
    }

    interface Transport {
        HttpResponse post(String url, ExpressQueryCancellation cancellation) throws Exception;
    }

    interface SimpleTransport {
        HttpResponse post(String url) throws Exception;
    }

    static final class Response implements HttpResponse {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body == null ? "" : body;
        }

        Response(int status, byte[] body) {
            this(status, body == null ? "" : new String(body, StandardCharsets.UTF_8));
        }

        @Override public int status() {
            return status;
        }

        @Override public boolean successful() {
            return status >= 200 && status < 300;
        }

        @Override public String utf8() {
            return body;
        }
    }

    private final Transport transport;

    Kuaidi100CarrierDetector() {
        this(Kuaidi100CarrierTransport.defaultTransport(PUBLIC_USER_AGENT));
    }

    Kuaidi100CarrierDetector(Transport transport) {
        if (transport == null) throw new IllegalArgumentException("transport is required");
        this.transport = transport;
    }

    Kuaidi100CarrierDetector(SimpleTransport transport) {
        if (transport == null) throw new IllegalArgumentException("transport is required");
        this.transport = (url, cancellation) -> transport.post(url);
    }

    List<String> detectCandidates(String waybill) throws Exception {
        return codes(detectNamedCandidates(waybill));
    }

    List<String> detectCandidates(
            String waybill, ExpressQueryCancellation cancellation) throws Exception {
        return codes(detectNamedCandidates(waybill, cancellation));
    }

    /** The free answer's candidates with the name Kuaidi100 gives each one (跨端对齐裁决 #29). */
    List<Candidate> detectNamedCandidates(String waybill) throws Exception {
        return detectNamedCandidates(waybill, null);
    }

    List<Candidate> detectNamedCandidates(
            String waybill, ExpressQueryCancellation cancellation) throws Exception {
        String number = clean(waybill);
        if (!validWaybill(number)) return new ArrayList<>();
        if (cancellation != null) cancellation.throwIfCancelled();
        HttpResponse response;
        try {
            response = transport.post(requestUrl(number), cancellation);
        } catch (InterruptedException interrupted) {
            throw interrupted;
        } catch (IOException networkFailure) {
            if (cancellation != null) cancellation.throwIfCancelled();
            throw Kuaidi100CarrierTransport.networkFailure(networkFailure);
        }
        if (cancellation != null) cancellation.throwIfCancelled();
        if (response == null || !response.successful()) {
            throw Kuaidi100CarrierTransport.httpFailure(response);
        }
        return parseNamedCandidates(response.utf8());
    }

    /**
     * One free-recognition candidate. {@code name} is the carrier name Kuaidi100 attaches to it,
     * read from the same fields as iOS ({@code name}, {@code comName}, {@code companyName}); it is
     * only ever shown for an off-table carrier (用户 2026-09-26，跨端对齐裁决 #29) and never enters the
     * table, an icon or a protocol code.
     */
    static final class Candidate {
        final String code;
        final String name;

        Candidate(String code, String name) {
            this.code = clean(code);
            this.name = clean(name);
        }
    }

    static String requestUrl(String waybill) {
        try {
            return ENDPOINT + "?text=" + URLEncoder.encode(clean(waybill), "UTF-8");
        } catch (UnsupportedEncodingException impossible) {
            throw new AssertionError("UTF-8 is unavailable", impossible);
        }
    }

    /**
     * Kuaidi100's "no match" answer is returnCode 201, written as the string "201" or as the number
     * 201: both read as unrecognized (the paid stage decides), never as a retryable failure (user
     * decision 2026-09-26, 跨端对齐裁决 #5).
     */
    private static boolean isNoMatchReturnCode(Object value) {
        if (value instanceof String) return "201".equals(((String) value).trim());
        return value instanceof Number && ((Number) value).doubleValue() == 201d;
    }

    /**
     * Audit C3 (user 2026-09-25): one reading with the Worker and iOS, shared fixture
     * k100-autocomnum-responses.v1.json. A bare array or an {@code auto} list gives the candidates;
     * the no-match answer gives none (the paid stage decides); any other body — not JSON, HTML, an
     * object without {@code auto} — is a retryable failure that never reaches the paid stage.
     */
    static List<String> parseCandidates(String body) {
        return codes(parseNamedCandidates(body));
    }

    private static List<String> codes(List<Candidate> candidates) {
        ArrayList<String> codes = new ArrayList<>();
        if (candidates == null) return codes;
        for (Candidate candidate : candidates) codes.add(candidate.code);
        return codes;
    }

    private static String firstText(JSONObject value, String... keys) {
        if (value == null) return "";
        for (String key : keys) {
            Object field = value.opt(key);
            if (field instanceof String && !((String) field).trim().isEmpty()) {
                return ((String) field).trim();
            }
        }
        return "";
    }

    static List<Candidate> parseNamedCandidates(String body) {
        ArrayList<Candidate> candidates = new ArrayList<>();
        ArrayList<String> seen = new ArrayList<>();
        try {
            Object root = new JSONTokener(body == null ? "" : body).nextValue();
            JSONArray values;
            if (root instanceof JSONArray) {
                values = (JSONArray) root;
            } else if (root instanceof JSONObject) {
                JSONObject object = (JSONObject) root;
                values = object.optJSONArray("auto");
                if (values == null && Boolean.FALSE.equals(object.opt("result"))
                        && isNoMatchReturnCode(object.opt("returnCode"))) {
                    return candidates;
                }
            } else {
                throw new IllegalArgumentException("invalid public carrier response");
            }
            if (values == null) {
                throw new IllegalArgumentException("invalid public carrier response");
            }
            for (int index = 0; index < values.length() && candidates.size() < 16; index++) {
                JSONObject value = values.optJSONObject(index);
                String code = value == null ? "" : clean(value.optString("comCode", ""));
                if (!code.matches("^[A-Za-z0-9_-]{1,32}$") || seen.contains(code)) {
                    continue;
                }
                seen.add(code);
                candidates.add(new Candidate(code,
                        firstText(value, "name", "comName", "companyName")));
            }
        } catch (IllegalArgumentException failure) {
            throw failure;
        } catch (Throwable failure) {
            throw new IllegalArgumentException("invalid public carrier response", failure);
        }
        return candidates;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    static boolean validWaybill(String value) {
        if (value.length() < 5 || value.length() > 64) return false;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character <= 0x1f || character == 0x7f) return false;
        }
        return true;
    }
}
