package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;

/** Recovers a trustworthy signed timestamp even when an OEM omits statusEventTime. */
final class ExpressLifecycleTimes {
    private static final long FUTURE_TOLERANCE_MS = 5L * 60L * 1000L;

    private ExpressLifecycleTimes() {}

    static long signedAt(ExpressItem item, ExpressQueryResult cached, long now) {
        if (item != null && item.signedRetainedAt > 0L) return item.signedRetainedAt;
        return signedEvidenceAt(item, cached, now);
    }

    static long signedEvidenceAt(ExpressItem item, ExpressQueryResult cached, long now) {
        long signedAt = valid(item == null ? 0L : item.statusEventTime, now);
        // A newer headline or sidecar must not replace the owner's structured signature.
        if (signedAt > 0L) return signedAt;
        if (cached != null) {
            signedAt = valid(cached.statusEventTime, now);
            if (signedAt > 0L) return signedAt;
        }
        if (item != null) {
            signedAt = newer(signedTrackTime(item.tracksJson, now),
                    signedSummaryTime(item.latestDetail, item.latestTime, now));
        }
        if (cached != null) {
            signedAt = newer(signedAt, signedTrackTime(cached.tracksJson, now));
            signedAt = newer(signedAt,
                    signedSummaryTime(cached.latestDetail, cached.latestTime, now));
        }
        return signedAt;
    }

    static long eventAt(ExpressItem item, long now) {
        if (item == null) return 0L;
        long eventAt = valid(item.statusEventTime, now);
        if (eventAt > 0L) return eventAt;
        return valid(item.updatedAt, now);
    }

    private static long signedTrackTime(String tracksJson, long now) {
        long result = 0L;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(tracksJson, "", "")) {
            result = newer(result, signedSummaryTime(track.detail, track.time, now));
        }
        return result;
    }

    private static long signedSummaryTime(String detail, String time, long now) {
        String text = detail.replaceAll("\\s+", "");
        if (!(text.contains("签收") || text.contains("妥投")
                || text.contains("配送完成") || text.contains("订单已完成"))) return 0L;
        return valid(ExpressSourcePolicy.parseEventTime(time), now);
    }

    private static long valid(long value, long now) {
        return value > 0L && value <= now + FUTURE_TOLERANCE_MS ? value : 0L;
    }

    private static long newer(long left, long right) {
        return Math.max(left, right);
    }
}
