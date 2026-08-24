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
        return ExpressTimeline.latestMeaningful(result.tracksJson, result.semantic) != null
                || hasTimedTracking(result);
    }

    /** A successful cache write requires a real event paired with a parseable provider time. */
    public static boolean hasTimedTracking(ExpressQueryResult result) {
        if (result == null || ExpressStatusNormalizer.isProviderErrorDetail(
                result.latestDetail)) return false;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "")) {
            if (ExpressSourcePolicy.parseEventTime(track.time) > 0L
                    && !ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) {
                return true;
            }
        }
        return false;
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
        boolean frozenCompletedPresentation = isCompletedTimedPackage(cached);
        ExpressQueryResult presentation = frozenCompletedPresentation
                ? cached : selectedSameProviderPresentation(cached, refreshed);
        return new ExpressQueryResult(
                prefer(presentation.waybill,
                        prefer(refreshed.waybill, cached.waybill)),
                prefer(presentation.courierCode,
                        prefer(refreshed.courierCode, cached.courierCode)),
                prefer(presentation.companyName,
                        prefer(refreshed.companyName, cached.companyName)),
                presentation.semantic, effectiveStatusEventTime(presentation),
                presentation.latestTime,
                presentation.latestDetail,
                ExpressTimeline.mergeJson(cached.tracksJson, refreshed.tracksJson),
                prefer(refreshed.detailUrl, cached.detailUrl),
                prefer(refreshed.phone, cached.phone),
                prefer(refreshed.timelineProvider, cached.timelineProvider),
                prefer(refreshed.routeInterface, cached.routeInterface),
                prefer(refreshed.routeCredential, cached.routeCredential),
                prefer(refreshed.sourceProvider, cached.sourceProvider));
    }

    static boolean isCompletedTimedPackage(ExpressQueryResult result) {
        return result != null
                && result.semantic == StatusSemantic.COMPLETED
                && hasTimedTracking(result);
    }

    /** Selects one provider response as the whole visible header while tracks merge separately. */
    private static ExpressQueryResult selectedSameProviderPresentation(
            ExpressQueryResult cached, ExpressQueryResult refreshed) {
        if (cached.semantic == StatusSemantic.COMPLETED
                && refreshed.semantic != StatusSemantic.COMPLETED) return cached;
        if (refreshed.semantic == StatusSemantic.COMPLETED
                && cached.semantic != StatusSemantic.COMPLETED) return refreshed;
        if (refreshed.semantic == StatusSemantic.UNKNOWN) return cached;
        if (cached.semantic == StatusSemantic.UNKNOWN) return refreshed;
        long cachedEvent = effectiveStatusEventTime(cached);
        long refreshedEvent = effectiveStatusEventTime(refreshed);
        if (refreshedEvent <= 0L) return cachedEvent <= 0L ? refreshed : cached;
        if (cachedEvent <= 0L) return refreshed;
        return refreshedEvent >= cachedEvent ? refreshed : cached;
    }

    private static long effectiveStatusEventTime(ExpressQueryResult result) {
        if (result == null) return 0L;
        if (result.statusEventTime > 0L) return result.statusEventTime;
        return ExpressSourcePolicy.parseEventTime(result.latestTime);
    }

    private static String prefer(String primary, String fallback) {
        return primary == null || primary.trim().isEmpty() ? fallback : primary;
    }
}
