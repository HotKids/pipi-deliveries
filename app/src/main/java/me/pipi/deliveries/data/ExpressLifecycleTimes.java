package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;

/** Recovers a trustworthy signed timestamp even when an OEM omits statusEventTime. */
final class ExpressLifecycleTimes {
    private static final long FUTURE_TOLERANCE_MS = 5L * 60L * 1000L;

    private ExpressLifecycleTimes() {}

    static long signedAt(ExpressItem item, ExpressQueryResult cached, long now) {
        long signedAt = valid(item == null ? 0L : item.statusEventTime, now);
        if (item != null) {
            signedAt = newer(signedAt,
                    valid(ExpressSourcePolicy.parseEventTime(item.latestTime), now));
            signedAt = newer(signedAt, signedTrackTime(item.tracksJson, now));
        }
        if (cached != null) {
            signedAt = newer(signedAt,
                    valid(ExpressSourcePolicy.parseEventTime(cached.latestTime), now));
            signedAt = newer(signedAt, signedTrackTime(cached.tracksJson, now));
        }
        if (signedAt > 0L) return signedAt;
        return valid(item == null ? 0L : item.updatedAt, now);
    }

    static long eventAt(ExpressItem item, long now) {
        if (item == null) return 0L;
        long eventAt = valid(item.statusEventTime, now);
        eventAt = newer(eventAt,
                valid(ExpressSourcePolicy.parseEventTime(item.latestTime), now));
        if (eventAt > 0L) return eventAt;
        return valid(item.updatedAt, now);
    }

    private static long signedTrackTime(String tracksJson, long now) {
        long result = 0L;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(tracksJson, "", "")) {
            String detail = track.detail.replaceAll("\\s+", "");
            if (!(detail.contains("签收") || detail.contains("妥投")
                    || detail.contains("配送完成"))) {
                continue;
            }
            result = newer(result,
                    valid(ExpressSourcePolicy.parseEventTime(track.time), now));
        }
        return result;
    }

    private static long valid(long value, long now) {
        return value > 0L && value <= now + FUTURE_TOLERANCE_MS ? value : 0L;
    }

    private static long newer(long left, long right) {
        return Math.max(left, right);
    }
}
