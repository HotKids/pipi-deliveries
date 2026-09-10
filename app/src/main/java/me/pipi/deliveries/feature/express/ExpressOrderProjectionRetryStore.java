package me.pipi.deliveries.feature.express;

import android.content.Context;

import java.util.HashMap;
import java.util.Map;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.data.ExpressOrderProjectionIdentity;

/** Persists a bounded retry delay for an unresolved account-order H5 projection. */
final class ExpressOrderProjectionRetryStore {
    static final long FAILURE_COOLDOWN_MS = 60L * 60L * 1000L;

    private static final Map<String, AttemptToken> ACTIVE_ATTEMPTS = new HashMap<>();
    private final android.content.SharedPreferences timelineCooldown;

    ExpressOrderProjectionRetryStore(Context context) {
        Context application = context.getApplicationContext();
        timelineCooldown = application.getSharedPreferences("express_jd_h5_cooldown", 0);
    }

    AttemptToken beginAttempt(ExpressItem item, long now) {
        return ExpressHomeOrderProjectionCapture.needsProjection(item)
                ? beginTimelineAttempt(item, now) : null;
    }

    AttemptToken beginTimelineAttempt(ExpressItem item, long now) {
        return beginTimelineAttempt(item, now, null);
    }

    /** Home holds an order lease while querying; only an actual H5 load starts its cooldown. */
    AttemptToken beginTimelineAttempt(ExpressItem item, long now, AttemptToken pendingQuery) {
        if (!ExpressDetailActivity.usesInterface5Automatic(item) || !item.isAccountOrder()) return null;
        String identity = stableIdentity(item);
        if (identity.isEmpty()) return null;
        synchronized (ACTIVE_ATTEMPTS) {
            if (pendingQuery == null ? ACTIVE_ATTEMPTS.containsKey(identity)
                    : ACTIVE_ATTEMPTS.get(identity) != pendingQuery) return null;
            String key = timelineKey(item);
            long until = timelineCooldown.getLong(key, 0L);
            if (until > now && until - now <= FAILURE_COOLDOWN_MS) return null;
            if (!timelineCooldown.edit().putLong(key, now + 10L * 60_000L).commit()) return null;
            return pendingQuery == null ? acquireAttemptLocked(identity) : pendingQuery;
        }
    }

    void recordTimelineRateLimit(ExpressItem item, long now) {
        synchronized (ACTIVE_ATTEMPTS) {
            String key = timelineKey(item);
            long until = Math.max(timelineCooldown.getLong(key, 0L), now + FAILURE_COOLDOWN_MS);
            if (!timelineCooldown.edit().putLong(key, until).commit())
                throw new IllegalStateException("JD cooldown persistence failed");
        }
    }

    private static String timelineKey(ExpressItem item) {
        try {
            byte[] bytes = java.security.MessageDigest.getInstance("SHA-256").digest(
                    item.waybill.trim().toUpperCase(java.util.Locale.ROOT)
                            .getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder key = new StringBuilder();
            for (byte value : bytes) key.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            return key.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static AttemptToken acquireAttempt(ExpressItem item) {
        String identity = stableIdentity(item);
        if (identity.isEmpty()) return null;
        synchronized (ACTIVE_ATTEMPTS) {
            if (ACTIVE_ATTEMPTS.containsKey(identity)) return null;
            return acquireAttemptLocked(identity);
        }
    }

    private static AttemptToken acquireAttemptLocked(String identity) {
        AttemptToken token = new AttemptToken(identity);
        ACTIVE_ATTEMPTS.put(identity, token);
        return token;
    }

    void endAttempt(AttemptToken token) {
        releaseAttempt(token);
    }

    static boolean releaseAttempt(AttemptToken token) {
        if (token == null || token.identity.isEmpty()) return false;
        synchronized (ACTIVE_ATTEMPTS) {
            if (ACTIVE_ATTEMPTS.get(token.identity) != token) return false;
            ACTIVE_ATTEMPTS.remove(token.identity);
            return true;
        }
    }

    static final class AttemptToken {
        final String identity;

        AttemptToken(String identity) {
            this.identity = identity == null ? "" : identity;
        }
    }

    static String stableIdentity(ExpressItem item) {
        return ExpressOrderProjectionIdentity.stableIdentity(item);
    }

    static String routeFingerprint(ExpressItem item) {
        return ExpressOrderProjectionIdentity.routeFingerprint(item);
    }
}
