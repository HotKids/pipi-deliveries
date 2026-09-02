package me.pipi.deliveries.network;

import android.content.Context;

import me.pipi.deliveries.BuildConfig;

import org.json.JSONObject;

import java.io.IOException;
import java.net.URI;
import java.util.Map;

/** Fixed-route transport authenticated by Android hardware-backed request signatures. */
final class ExpressGatewayClient implements ExpressGatewayTransport {
    private static final String GATEWAY_URL = clean(BuildConfig.EXPRESS_GATEWAY_URL);

    private final GatewaySessionSigner signer;

    ExpressGatewayClient(Context context) {
        if (context == null) throw new IllegalArgumentException("context is required");
        signer = new GatewaySessionSigner(context.getApplicationContext(), GATEWAY_URL);
    }

    @Override public boolean configured() {
        return isTrustedGatewayUrl(GATEWAY_URL);
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
        try {
            return send(route, body, cancellation, false);
        } catch (GatewaySessionSigner.RejectedSession rejected) {
            if (cancellation != null) cancellation.throwIfCancelled();
            signer.invalidate(rejected.session);
            return send(route, body, cancellation, true);
        } catch (IOException networkFailure) {
            if (cancellation != null) cancellation.throwIfCancelled();
            throw GatewayHttpErrors.networkFailure();
        }
    }

    private HttpClient.Response send(
            String route, String body, ExpressQueryCancellation cancellation,
            boolean afterReenrollment) throws Exception {
        GatewaySessionSigner.SignedHeaders signed = signer.headers(route, body, cancellation);
        HttpClient.Response response = postJson(route, body, signed.values, cancellation);
        if (response.status == 401 && !afterReenrollment) {
            throw new GatewaySessionSigner.RejectedSession(signed.session);
        }
        return response;
    }

    private HttpClient.Response postJson(
            String route, String body, Map<String, String> headers,
            ExpressQueryCancellation cancellation) throws Exception {
        String url = stripTrailingSlash(GATEWAY_URL) + route;
        return cancellation == null
                ? HttpClient.postJson(url, body, headers, false)
                : HttpClient.postJson(url, body, headers, false, cancellation);
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
