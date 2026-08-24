package me.pipi.deliveries.network;

import android.content.Context;
import android.content.SharedPreferences;

import me.pipi.deliveries.BuildConfig;

import org.json.JSONObject;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.UUID;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** Signed, fixed-route transport to Pipi's credential-holding express gateway. */
final class ExpressGatewayClient implements ExpressGatewayTransport {
    private static final String GATEWAY_URL = clean(BuildConfig.EXPRESS_GATEWAY_URL);
    private static final String GATEWAY_TOKEN = clean(BuildConfig.EXPRESS_GATEWAY_TOKEN);
    // Preserve the existing installation identity so migration does not create another client.
    private static final String PREFS = "kuaidi100_proxy";
    private static final String CLIENT_ID = "client_id";

    private final String clientId;

    ExpressGatewayClient(Context context) {
        if (context == null) throw new IllegalArgumentException("context is required");
        clientId = installScopedClientId(context.getApplicationContext());
    }

    @Override public boolean configured() {
        return isTrustedGatewayUrl(GATEWAY_URL) && !GATEWAY_TOKEN.isEmpty();
    }

    @Override public HttpClient.Response post(String path, JSONObject payload) throws Exception {
        return post(path, payload, null);
    }

    @Override public HttpClient.Response post(
            String path, JSONObject payload, ExpressQueryCancellation cancellation)
            throws Exception {
        if (!configured()) throw new IllegalStateException("快递查询服务尚未配置");
        if (cancellation != null) cancellation.throwIfCancelled();
        String route = clean(path);
        if (!route.startsWith("/api/") || route.contains("?") || route.contains("#")) {
            throw new IllegalArgumentException("invalid gateway route");
        }
        String body = (payload == null ? new JSONObject() : payload).toString();
        long timestamp = System.currentTimeMillis() / 1000L;
        LinkedHashMap<String, String> headers = new LinkedHashMap<>();
        headers.put("X-Deliveries-Timestamp", String.valueOf(timestamp));
        headers.put("X-Deliveries-Client", clientId);
        headers.put("X-Deliveries-Signature", hmacSha256Hex(
                GATEWAY_TOKEN, canonicalRequest(timestamp, clientId, route, body)));
        try {
            String url = stripTrailingSlash(GATEWAY_URL) + route;
            return cancellation == null
                    ? HttpClient.postJson(url, body, headers, false)
                    : HttpClient.postJson(url, body, headers, false, cancellation);
        } catch (IOException networkFailure) {
            if (cancellation != null) cancellation.throwIfCancelled();
            // Do not surface DNS, TLS or timeout implementation text through the UI.
            throw GatewayHttpErrors.networkFailure();
        }
    }

    static String hmacSha256Hex(String key, String value) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] bytes = mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) output.append(String.format(Locale.US, "%02x", item & 0xff));
        return output.toString();
    }

    static String canonicalRequest(long timestamp, String clientId, String route, String body) {
        return timestamp + "\n" + clean(clientId) + "\n" + clean(route) + "\n"
                + (body == null ? "" : body);
    }

    static boolean isTrustedGatewayUrl(String value) {
        try {
            URI uri = URI.create(clean(value));
            return "https".equalsIgnoreCase(uri.getScheme())
                    && uri.getHost() != null && !uri.getHost().trim().isEmpty()
                    && uri.getUserInfo() == null
                    && uri.getQuery() == null
                    && uri.getFragment() == null;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static String installScopedClientId(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, 0);
        String existing = preferences.getString(CLIENT_ID, "");
        if (existing != null && existing.matches("[a-f0-9]{32}")) return existing;
        String generated = UUID.randomUUID().toString().replace("-", "");
        preferences.edit().putString(CLIENT_ID, generated).apply();
        return generated;
    }

    private static String stripTrailingSlash(String value) {
        String result = clean(value);
        while (result.endsWith("/")) result = result.substring(0, result.length() - 1);
        return result;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}

/** Narrow transport seam used to test request orchestration without Android or live credentials. */
interface ExpressGatewayTransport {
    boolean configured();

    HttpClient.Response post(String path, JSONObject payload) throws Exception;

    default HttpClient.Response post(
            String path, JSONObject payload, ExpressQueryCancellation cancellation)
            throws Exception {
        if (cancellation == null) return post(path, payload);
        cancellation.throwIfCancelled();
        HttpClient.Response response = post(path, payload);
        cancellation.throwIfCancelled();
        return response;
    }
}
