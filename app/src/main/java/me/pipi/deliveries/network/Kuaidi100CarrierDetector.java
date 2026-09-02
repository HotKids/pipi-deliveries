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

    interface Transport {
        HttpClient.Response post(String url, ExpressQueryCancellation cancellation)
                throws Exception;
    }

    private final Transport transport;

    Kuaidi100CarrierDetector() {
        this((url, cancellation) -> cancellation == null
                ? HttpClient.postForm(url, "", false)
                : HttpClient.postForm(url, "", false, cancellation));
    }

    Kuaidi100CarrierDetector(Transport transport) {
        if (transport == null) throw new IllegalArgumentException("transport is required");
        this.transport = transport;
    }

    List<String> detectCandidates(
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
            throw GatewayHttpErrors.networkFailure();
        }
        if (cancellation != null) cancellation.throwIfCancelled();
        if (!response.successful()) {
            throw GatewayHttpErrors.forResponse(response, "暂时无法识别承运商");
        }
        return parseCandidates(response.utf8());
    }

    static String requestUrl(String waybill) {
        try {
            return ENDPOINT + "?text=" + URLEncoder.encode(clean(waybill), "UTF-8");
        } catch (UnsupportedEncodingException impossible) {
            throw new AssertionError("UTF-8 is unavailable", impossible);
        }
    }

    static List<String> parseCandidates(String body) {
        ArrayList<String> candidates = new ArrayList<>();
        try {
            Object root = new JSONTokener(body == null ? "" : body).nextValue();
            JSONArray values;
            if (root instanceof JSONArray) {
                values = (JSONArray) root;
            } else if (root instanceof JSONObject) {
                values = ((JSONObject) root).optJSONArray("auto");
            } else {
                return candidates;
            }
            if (values == null) return candidates;
            for (int index = 0; index < values.length() && candidates.size() < 16; index++) {
                JSONObject value = values.optJSONObject(index);
                String code = value == null ? "" : clean(value.optString("comCode", ""));
                if (!code.matches("^[A-Za-z0-9_-]{1,32}$") || candidates.contains(code)) {
                    continue;
                }
                candidates.add(code);
            }
        } catch (Throwable ignored) {
            // An invalid public-classifier body is equivalent to no recognized carrier.
        }
        return candidates;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
