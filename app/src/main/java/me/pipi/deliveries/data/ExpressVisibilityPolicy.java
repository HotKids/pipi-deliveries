package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

/** Time-based visibility rules shared by the app list and its local detail cache. */
final class ExpressVisibilityPolicy {
    static final long SIGNED_VISIBLE_MS = 7L * 24L * 60L * 60L * 1000L;
    static final long CANCELLED_VISIBLE_MS = 4L * 60L * 60L * 1000L;

    private ExpressVisibilityPolicy() {}

    static boolean isExpired(ExpressItem item, long now) {
        if (item == null) return false;
        if (item.semantic == StatusSemantic.COMPLETED) {
            long signedAt = ExpressLifecycleTimes.signedAt(item, null, now);
            return signedAt > 0L && now - signedAt >= SIGNED_VISIBLE_MS;
        }
        if (item.semantic == StatusSemantic.CANCELLED) {
            long cancelledAt = ExpressLifecycleTimes.eventAt(item, now);
            return cancelledAt > 0L && now - cancelledAt >= CANCELLED_VISIBLE_MS;
        }
        return false;
    }
}
