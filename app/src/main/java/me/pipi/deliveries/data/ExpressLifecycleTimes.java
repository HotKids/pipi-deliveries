package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.model.StatusSemantic;

/** Keeps list retention separate from the signed evidence used to freeze refreshes. */
final class ExpressLifecycleTimes {
    private static final long FUTURE_TOLERANCE_MS = 5L * 60L * 1000L;

    private ExpressLifecycleTimes() {}

    static long signedAt(ExpressItem item, ExpressQueryResult cached, long now) {
        // Retention uses the same packet timestamp as the list row, independently of status freezing.
        long displayedAt = ExpressSourcePolicy.parseEventTime(
                item != null ? item.latestTime : cached != null ? cached.latestTime : "");
        if (displayedAt > 0L && displayedAt <= now) return displayedAt;
        if (item != null && item.signedRetainedAt > 0L) return item.signedRetainedAt;
        return signedEvidenceAt(item, cached, now);
    }

    static long signedEvidenceAt(ExpressItem item, ExpressQueryResult cached, long now) {
        WorkerStatusProjection itemStatus = item == null ? null : WorkerStatusProjection.cached(item.tracksJson);
        if (itemStatus != null && !itemStatus.matches(item.semantic, item.statusEventTime)) itemStatus = null;
        long signedAt = itemStatus == null ? valid(item == null ? 0L : item.statusEventTime, now)
                : workerSignedAt(itemStatus, now);
        // A newer headline or sidecar must not replace the owner's structured signature.
        if (signedAt > 0L) return signedAt;
        if (cached != null) {
            signedAt = cached.workerStatus == null ? valid(cached.statusEventTime, now)
                    : workerSignedAt(cached.workerStatus, now);
            if (signedAt > 0L) return signedAt;
        }
        // No structured status time: no signed evidence. Text such as 签收 / 妥投 / 订单已完成 is not
        // guessed into one (audit D10, user 2026-09-25: 冻结要有依据，不靠猜; as on iOS and Pipi).
        return 0L;
    }

    private static long workerSignedAt(WorkerStatusProjection status, long now) {
        return status.structured && status.semantic == StatusSemantic.COMPLETED
                && status.eventAtMs > 0L && status.eventAtMs <= now ? status.eventAtMs : 0L;
    }

    /**
     * The four-hour cancelled window starts at the time the list row shows, like signed retention
     * (audit L14, user default of 2026-09-25); only an absent or invalid shown time falls back to the
     * structured status time. The observation time, which every sync moves, never starts it.
     */
    static long cancelledAt(ExpressItem item, long now) {
        return item == null ? 0L : cancelledAt(item.latestTime, item.statusEventTime, now);
    }

    static long cancelledAt(String displayedTime, long statusEventTime, long now) {
        long displayedAt = ExpressSourcePolicy.parseEventTime(displayedTime);
        if (displayedAt > 0L && displayedAt <= now) return displayedAt;
        return valid(statusEventTime, now);
    }

    private static long valid(long value, long now) {
        return value > 0L && value <= now + FUTURE_TOLERANCE_MS ? value : 0L;
    }
}
