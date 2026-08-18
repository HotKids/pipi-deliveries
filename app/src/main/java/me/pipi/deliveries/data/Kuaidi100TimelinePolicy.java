package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

/** Refresh lifetime and same-provider incremental-cache policy for local timelines. */
public final class Kuaidi100TimelinePolicy {
    static final long SIGNED_REFRESH_WINDOW_MS = 24L * 60L * 60L * 1000L;

    private Kuaidi100TimelinePolicy() {}

    /** A manual item becomes visible only after a provider supplies a genuine timeline node. */
    public static boolean hasRealTracking(ExpressQueryResult result) {
        if (result == null || ExpressStatusNormalizer.isProviderErrorDetail(
                result.latestDetail)) return false;
        return ExpressTimeline.latestMeaningful(result.tracksJson, result.semantic) != null;
    }

    /** Refresh on every open until an exact signed event is at least 24 hours old. */
    public static boolean shouldRefresh(
            ExpressItem item, ExpressQueryResult cached, long now) {
        boolean completed = item != null && item.semantic == StatusSemantic.COMPLETED;
        long signedAt = 0L;
        if (cached != null && cached.semantic == StatusSemantic.COMPLETED) {
            completed = true;
        }
        if (!completed) return true;
        signedAt = ExpressLifecycleTimes.signedAt(item, cached, now);
        if (signedAt <= 0L) return true;
        return now - signedAt < SIGNED_REFRESH_WINDOW_MS;
    }

    /** Keeps historical nodes and applies this refresh's additions or node revisions. */
    public static ExpressQueryResult merge(
            ExpressQueryResult cached, ExpressQueryResult refreshed) {
        if (cached == null) return refreshed;
        if (refreshed == null) return cached;
        boolean refreshedHeadline = newerOrUnknown(
                cached.latestTime, refreshed.latestTime);
        StatusSemantic semantic = refreshed.semantic == StatusSemantic.UNKNOWN
                ? cached.semantic : refreshed.semantic;
        if (cached.semantic == StatusSemantic.COMPLETED) semantic = StatusSemantic.COMPLETED;
        return new ExpressQueryResult(
                prefer(refreshed.waybill, cached.waybill),
                prefer(refreshed.courierCode, cached.courierCode),
                prefer(refreshed.companyName, cached.companyName),
                semantic,
                refreshedHeadline
                        ? prefer(refreshed.latestTime, cached.latestTime)
                        : cached.latestTime,
                refreshedHeadline
                        ? prefer(refreshed.latestDetail, cached.latestDetail)
                        : cached.latestDetail,
                ExpressTimeline.mergeJson(cached.tracksJson, refreshed.tracksJson),
                prefer(refreshed.detailUrl, cached.detailUrl),
                prefer(refreshed.phone, cached.phone),
                prefer(refreshed.timelineProvider, cached.timelineProvider));
    }

    private static boolean newerOrUnknown(String cachedTime, String refreshedTime) {
        long cached = ExpressSourcePolicy.parseEventTime(cachedTime);
        long refreshed = ExpressSourcePolicy.parseEventTime(refreshedTime);
        if (refreshed <= 0L) return cached <= 0L;
        return cached <= 0L || refreshed >= cached;
    }

    private static String prefer(String primary, String fallback) {
        return primary == null || primary.trim().isEmpty() ? fallback : primary;
    }
}
