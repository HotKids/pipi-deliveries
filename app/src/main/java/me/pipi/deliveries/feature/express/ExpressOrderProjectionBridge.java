package me.pipi.deliveries.feature.express;

import android.webkit.WebView;

import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

import me.pipi.deliveries.data.ExpressOrderProjectionIdentity;
import me.pipi.deliveries.model.ExpressItem;

/** Receives a bounded, origin-scoped order identity projection from an isolated H5. */
final class ExpressOrderProjectionBridge {
    static final String JS_OBJECT_NAME = "deliveriesOrderProjection";
    static final int MAX_PAYLOAD_BYTES = 128 * 1024;

    private static final Set<String> ALLOWED_ORIGINS = new HashSet<>(Arrays.asList(
            "https://jd.com", "https://*.jd.com"));

    interface Receiver {
        void onProjection(WebView source, String payload);
    }

    private ExpressOrderProjectionBridge() {}

    static boolean install(WebView view, Receiver receiver) {
        if (view == null || receiver == null
                || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            return false;
        }
        try {
            WebViewCompat.addWebMessageListener(
                    view, JS_OBJECT_NAME, ALLOWED_ORIGINS,
                    (source, message, sourceOrigin, isMainFrame, replyProxy) -> {
                        boolean stringMessage = message != null
                                && message.getType() == WebMessageCompat.TYPE_STRING;
                        String payload = validatedPayload(
                                stringMessage,
                                stringMessage ? message.getData() : "",
                                sourceOrigin == null ? "" : sourceOrigin.toString(),
                                isMainFrame);
                        if (!payload.isEmpty()) receiver.onProjection(source, payload);
                    });
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    static String validatedPayload(
            boolean stringMessage, String payload, String sourceOrigin,
            boolean mainFrame) {
        if (!stringMessage || !mainFrame || payload == null || payload.isEmpty()
                || payload.length() > MAX_PAYLOAD_BYTES || !allowedOrigin(sourceOrigin)) {
            return "";
        }
        return payload.getBytes(StandardCharsets.UTF_8).length <= MAX_PAYLOAD_BYTES
                ? payload : "";
    }

    static Candidate candidate(String payload, String sourceIdentity) {
        if (payload == null || payload.isEmpty() || payload.length() > MAX_PAYLOAD_BYTES
                || payload.getBytes(StandardCharsets.UTF_8).length > MAX_PAYLOAD_BYTES) {
            return null;
        }
        try {
            JSONObject value = new JSONObject(payload);
            String waybill = value.optString("waybillCode", "").trim();
            if (!waybill.matches("^[A-Za-z0-9_-]{6,40}$")
                    || normalize(waybill).equals(normalize(sourceIdentity))) return null;
            String carrier = value.optString("carrierName", "").trim();
            if (carrier.length() > 64) carrier = carrier.substring(0, 64);
            return new Candidate(waybill, carrier);
        } catch (Throwable ignored) {
            return null;
        }
    }

    static boolean sameUnresolvedOwner(ExpressItem expected, ExpressItem current) {
        if (expected == null || current == null || !current.isAccountOrder()
                || !current.projectedWaybill.isEmpty()) return false;
        return ExpressOrderProjectionIdentity.matches(
                ExpressOrderProjectionIdentity.snapshot(expected), current);
    }

    private static boolean allowedOrigin(String sourceOrigin) {
        try {
            URI origin = URI.create(sourceOrigin == null ? "" : sourceOrigin);
            String host = origin.getHost() == null
                    ? "" : origin.getHost().toLowerCase(Locale.ROOT);
            boolean trustedHost = "jd.com".equals(host) || host.endsWith(".jd.com");
            return "https".equalsIgnoreCase(origin.getScheme()) && trustedHost
                    && origin.getUserInfo() == null
                    && (origin.getPort() == -1 || origin.getPort() == 443)
                    && (origin.getPath() == null || origin.getPath().isEmpty()
                    || "/".equals(origin.getPath()))
                    && origin.getQuery() == null && origin.getFragment() == null;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static String normalize(String value) {
        return value == null ? "" : value.toUpperCase(Locale.ROOT)
                .replaceAll("[^A-Z0-9]", "");
    }

    static final class Candidate {
        final String waybill;
        final String carrier;

        Candidate(String waybill, String carrier) {
            this.waybill = waybill;
            this.carrier = carrier;
        }
    }
}
