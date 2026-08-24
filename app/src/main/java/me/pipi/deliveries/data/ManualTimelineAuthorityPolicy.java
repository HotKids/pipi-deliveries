package me.pipi.deliveries.data;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import me.pipi.deliveries.model.ExpressQueryResult;

/** Selects one successful manual-query timeline without changing shipment ownership. */
public final class ManualTimelineAuthorityPolicy {
    private static final String PROVIDER_INTERFACE5 = "interface5";
    private static final String PROVIDER_INTERFACE6 = "interface6";
    private static final String PROVIDER_KUAIDI100 = "kuaidi100";

    /** One provider's persisted manual-query sidecar. */
    public static final class Candidate {
        public final String provider;
        public final ExpressQueryResult result;
        public final long successAt;
        public final boolean complete;

        public Candidate(
                String provider, ExpressQueryResult result, long successAt, boolean complete) {
            this.provider = normalizeProvider(provider);
            this.result = result;
            this.successAt = successAt;
            this.complete = complete;
        }
    }

    private ManualTimelineAuthorityPolicy() {}

    /**
     * Selects the most recently successful provider sidecar. Query order is only a tie-breaker:
     * the selected account interface wins an equal-time tie over its Kuaidi100 fallback.
     */
    public static Candidate select(List<Candidate> candidates) {
        if (candidates == null || candidates.isEmpty()) return null;
        Map<String, Candidate> byProvider = new LinkedHashMap<>();
        for (Candidate candidate : candidates) {
            if (!isAuthoritative(candidate)) continue;
            Candidate cached = byProvider.get(candidate.provider);
            byProvider.put(candidate.provider,
                    cached == null ? candidate : mergeSameProvider(cached, candidate));
        }

        Candidate selected = null;
        for (Candidate candidate : byProvider.values()) {
            if (selected == null || compare(candidate, selected) < 0) selected = candidate;
        }
        return selected;
    }

    /** A failed, partial, timeless or placeholder-only response never becomes authority. */
    public static boolean isAuthoritative(Candidate candidate) {
        return candidate != null
                && !candidate.provider.isEmpty()
                && candidate.complete
                && candidate.successAt > 0L
                && Kuaidi100TimelinePolicy.hasTimedTracking(candidate.result);
    }

    /**
     * Incrementally merges only one provider's successful cache. An unsuccessful refresh leaves
     * the previous success timestamp and result untouched.
     */
    public static Candidate mergeSameProvider(Candidate cached, Candidate refreshed) {
        if (!isAuthoritative(cached)) return isAuthoritative(refreshed) ? refreshed : null;
        if (!isAuthoritative(refreshed)) return cached;
        if (!cached.provider.equals(refreshed.provider)) {
            throw new IllegalArgumentException("manual timeline providers must match");
        }

        Candidate older = cached.successAt <= refreshed.successAt ? cached : refreshed;
        Candidate newer = older == cached ? refreshed : cached;
        return new Candidate(
                newer.provider,
                Kuaidi100TimelinePolicy.merge(older.result, newer.result),
                newer.successAt,
                true);
    }

    private static int compare(Candidate left, Candidate right) {
        boolean leftCompleted = Kuaidi100TimelinePolicy.isCompletedTimedPackage(left.result);
        boolean rightCompleted = Kuaidi100TimelinePolicy.isCompletedTimedPackage(right.result);
        if (leftCompleted != rightCompleted) return leftCompleted ? -1 : 1;
        int newest = Long.compare(right.successAt, left.successAt);
        if (newest != 0) return newest;
        return Integer.compare(queryOrder(left.provider), queryOrder(right.provider));
    }

    private static int queryOrder(String provider) {
        if (PROVIDER_INTERFACE5.equals(provider) || PROVIDER_INTERFACE6.equals(provider)) {
            return 0;
        }
        if (PROVIDER_KUAIDI100.equals(provider)) return 1;
        return 2;
    }

    private static String normalizeProvider(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }
}
