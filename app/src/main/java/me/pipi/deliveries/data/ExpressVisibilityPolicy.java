package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

/** Time-based visibility rules shared by the app list and its local detail cache. */
final class ExpressVisibilityPolicy {
    static final long SIGNED_VISIBLE_MS = 14L * 24L * 60L * 60L * 1000L;
    static final long SIGNED_DELETE_MS = SIGNED_VISIBLE_MS + 7L * 24L * 60L * 60L * 1000L;
    static final long CANCELLED_VISIBLE_MS = 4L * 60L * 60L * 1000L;

    private ExpressVisibilityPolicy() {}

    static boolean isExpired(ExpressItem item, long now) {
        return expiredAfter(item, now, SIGNED_VISIBLE_MS);
    }

    static boolean isHiddenSigned(ExpressItem item, long now) {
        return item != null && item.semantic != StatusSemantic.CANCELLED
                && (item.signedRetainedAt > 0L || item.semantic == StatusSemantic.COMPLETED)
                && isExpired(item, now);
    }

    static boolean shouldDelete(ExpressItem item, long now) {
        return expiredAfter(item, now, SIGNED_DELETE_MS);
    }

    private static boolean expiredAfter(ExpressItem item, long now, long signedDuration) {
        if (item == null) return false;
        StatusSemantic lifecycleSemantic = item.semantic;
        if (lifecycleSemantic == StatusSemantic.CANCELLED) {
            long cancelledAt = ExpressLifecycleTimes.eventAt(item, now);
            return cancelledAt > 0L && now - cancelledAt >= CANCELLED_VISIBLE_MS;
        }
        if (item.signedRetainedAt > 0L || lifecycleSemantic == StatusSemantic.COMPLETED) {
            long signedAt = ExpressLifecycleTimes.signedAt(item, null, now);
            return signedAt > 0L && now - signedAt >= signedDuration;
        }
        return false;
    }

    /** New automatic discoveries remain cacheable until the signed deletion deadline. */
    static boolean isExpiredResult(ExpressQueryResult result, long now) {
        if (result == null) return false;
        if (result.semantic == StatusSemantic.COMPLETED) {
            long signedAt = ExpressLifecycleTimes.signedAt(null, result, now);
            return signedAt > 0L && now - signedAt >= SIGNED_DELETE_MS;
        }
        if (result.semantic == StatusSemantic.CANCELLED) {
            long cancelledAt = Math.max(
                    result.statusEventTime,
                    ExpressSourcePolicy.parseEventTime(result.latestTime));
            return cancelledAt > 0L && cancelledAt <= now
                    && now - cancelledAt >= CANCELLED_VISIBLE_MS;
        }
        return false;
    }
}
