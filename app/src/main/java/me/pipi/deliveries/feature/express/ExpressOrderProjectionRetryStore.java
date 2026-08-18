package me.pipi.deliveries.feature.express;

import android.content.Context;
import android.content.SharedPreferences;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.network.ExpressAccountSource;

/** Persists a bounded retry delay for an unresolved account-order H5 projection. */
final class ExpressOrderProjectionRetryStore {
    static final long FAILURE_COOLDOWN_MS = 6L * 60L * 60L * 1000L;

    private static final String PREFS = "express_order_projection_retries";
    private static final String FAILURE_AT_PREFIX = "failure_at.";
    private static final String ROUTE_PREFIX = "route.";

    private final SharedPreferences preferences;

    ExpressOrderProjectionRetryStore(Context context) {
        preferences = context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    boolean canAttempt(ExpressItem item, long now) {
        if (!ExpressHomeOrderProjectionCapture.needsProjection(item)) return false;
        String key = recordKey(item);
        long failedAt = preferences.getLong(FAILURE_AT_PREFIX + key, 0L);
        String failedRoute = preferences.getString(ROUTE_PREFIX + key, "");
        return shouldAttempt(failedAt, failedRoute, routeFingerprint(item), now);
    }

    void recordFailure(ExpressItem item, long now) {
        if (item == null) return;
        String key = recordKey(item);
        preferences.edit()
                .putLong(FAILURE_AT_PREFIX + key, now)
                .putString(ROUTE_PREFIX + key, routeFingerprint(item))
                .apply();
    }

    void clear(ExpressItem item) {
        if (item == null) return;
        String key = recordKey(item);
        preferences.edit()
                .remove(FAILURE_AT_PREFIX + key)
                .remove(ROUTE_PREFIX + key)
                .apply();
    }

    static boolean shouldAttempt(
            long failedAt, String failedRouteFingerprint,
            String currentRouteFingerprint, long now) {
        if (failedAt <= 0L || failedRouteFingerprint == null
                || !failedRouteFingerprint.equals(currentRouteFingerprint)) return true;
        // A wall-clock rollback must not turn a transient failure into a permanent block.
        if (now < failedAt) return true;
        return now - failedAt >= FAILURE_COOLDOWN_MS;
    }

    static String stableIdentity(ExpressItem item) {
        if (item == null) return "";
        String owner = item.stateOwner.isEmpty() ? item.source : item.stateOwner;
        String bindingSource = ExpressAccountSource.bindingSourceForOwner(owner);
        return bindingSource + ":" + ExpressDetailActivity.normalizeIdentity(item.waybill);
    }

    static String routeFingerprint(ExpressItem item) {
        if (item == null) return "";
        return sha256(stableIdentity(item) + "\n" + routeEndpoint(item));
    }

    private static String routeEndpoint(ExpressItem item) {
        String host = "";
        try {
            URI route = URI.create(item.routeCredential);
            host = route.getHost() == null ? "" : route.getHost().toLowerCase(Locale.ROOT);
        } catch (Throwable ignored) {
            // Invalid routes are cooled by interface until a usable endpoint replaces them.
        }
        // Query credentials may rotate at every sync. They must not bypass the cooldown.
        return item.routeInterface + ":" + host;
    }

    private static String recordKey(ExpressItem item) {
        return sha256(stableIdentity(item));
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                    (value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
            StringBuilder encoded = new StringBuilder(digest.length * 2);
            for (byte valueByte : digest) {
                encoded.append(String.format(Locale.ROOT, "%02x", valueByte & 0xff));
            }
            return encoded.toString();
        } catch (Exception failure) {
            throw new IllegalStateException("Cannot fingerprint projection retry", failure);
        }
    }
}
