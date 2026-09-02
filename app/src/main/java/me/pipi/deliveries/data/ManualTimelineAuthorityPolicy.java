package me.pipi.deliveries.data;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;

/** Selects one successful manual-query timeline without changing shipment ownership. */
public final class ManualTimelineAuthorityPolicy {
    private static final String PROVIDER_MOTO = "v4";
    private static final String PROVIDER_MEIZU = "meizu";
    private static final String PROVIDER_OPPO = "oppo";
    private static final String PROVIDER_KDNIAO = "kdniao";
    private static final String PROVIDER_KUAIDI100 = "kuaidi100";
    private static final int KDNIAO_TERMINAL_MIN_TIMED_TRACKS = 2;

    /** One provider's persisted manual-query sidecar. */
    public static final class Candidate {
        public final String provider;
        public final ExpressQueryResult result;
        public final long successAt;
        public final boolean complete;
        public final boolean providerErrorMetadataInvalidated;

        public Candidate(
                String provider, ExpressQueryResult result, long successAt, boolean complete) {
            this(provider, result, successAt, complete, false);
        }

        Candidate(
                String provider, ExpressQueryResult result, long successAt, boolean complete,
                boolean providerErrorMetadataInvalidated) {
            this.provider = normalizeProvider(provider);
            this.result = result;
            this.successAt = successAt;
            this.complete = complete;
            this.providerErrorMetadataInvalidated = providerErrorMetadataInvalidated;
        }
    }

    private ManualTimelineAuthorityPolicy() {}

    /**
     * Selects one whole provider package. Complete packages beat partial packages and compare by
     * latest provider event before source order. Without a complete package, source order wins.
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

        // Picker owns Home and status as soon as it has a timed package. A fuller provider may
        // still be selected independently for detail through selectDetail().
        Candidate picker = byProvider.get(PROVIDER_MEIZU);
        if (picker != null) return picker;

        return selectBestDetail(byProvider);
    }

    /** Selects the fullest whole provider package for the detail timeline. */
    public static Candidate selectDetail(List<Candidate> candidates) {
        if (candidates == null || candidates.isEmpty()) return null;
        Map<String, Candidate> byProvider = new LinkedHashMap<>();
        for (Candidate candidate : candidates) {
            if (!isAuthoritative(candidate)) continue;
            Candidate cached = byProvider.get(candidate.provider);
            byProvider.put(candidate.provider,
                    cached == null ? candidate : mergeSameProvider(cached, candidate));
        }
        return selectBestDetail(byProvider);
    }

    private static Candidate selectBestDetail(Map<String, Candidate> byProvider) {
        Candidate selected = null;
        for (Candidate candidate : byProvider.values()) {
            if (selected == null || compare(candidate, selected) < 0) selected = candidate;
        }
        return selected;
    }

    /** A failed, timeless or placeholder-only response never becomes a selectable package. */
    public static boolean isAuthoritative(Candidate candidate) {
        return candidate != null
                && !candidate.provider.isEmpty()
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
                Kuaidi100TimelinePolicy.mergeManualProvider(older.result, newer.result),
                Math.max(cached.successAt, refreshed.successAt),
                cached.complete || refreshed.complete,
                newer.providerErrorMetadataInvalidated);
    }

    private static int compare(Candidate left, Candidate right) {
        boolean leftComplete = isEffectivelyComplete(left);
        boolean rightComplete = isEffectivelyComplete(right);
        int completeness = Boolean.compare(
                rightComplete, leftComplete);
        if (completeness != 0) return completeness;
        if (leftComplete && rightComplete) {
            int newest = Long.compare(
                    latestEventTime(right.result), latestEventTime(left.result));
            if (newest != 0) return newest;
        }
        return Integer.compare(queryOrder(left.provider), queryOrder(right.provider));
    }

    /** Applies response-shape guards without rewriting the persisted provider declaration. */
    public static boolean isEffectivelyComplete(Candidate candidate) {
        return candidate != null && isEffectivelyComplete(
                candidate.provider, candidate.result, candidate.complete);
    }

    static boolean isEffectivelyComplete(
            String provider, ExpressQueryResult result, boolean declaredComplete) {
        if (!declaredComplete || !Kuaidi100TimelinePolicy.hasTimedTracking(result)) return false;
        String normalized = normalizeProvider(provider);
        if (!PROVIDER_KDNIAO.equals(normalized)
                || result.semantic == null || !result.semantic.terminal()) return true;
        return timedTrackCount(result) >= KDNIAO_TERMINAL_MIN_TIMED_TRACKS;
    }

    private static int timedTrackCount(ExpressQueryResult result) {
        if (result == null) return 0;
        int count = 0;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "")) {
            if (ExpressSourcePolicy.parseEventTime(track.time) > 0L
                    && !ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) {
                count++;
            }
        }
        return count;
    }

    /** Returns a terminal status guard without changing the R-13 presentation-package order. */
    static Candidate selectStructuredTerminal(List<Candidate> candidates) {
        if (candidates == null || candidates.isEmpty()) return null;
        Candidate selected = null;
        for (Candidate candidate : candidates) {
            if (!isAuthoritative(candidate) || !isStructuredTerminal(candidate)) continue;
            if (selected == null
                    || latestEventTime(candidate.result) > latestEventTime(selected.result)
                    || latestEventTime(candidate.result) == latestEventTime(selected.result)
                    && queryOrder(candidate.provider) < queryOrder(selected.provider)) {
                selected = candidate;
            }
        }
        return selected;
    }

    private static boolean isStructuredTerminal(Candidate candidate) {
        return candidate != null && candidate.result != null
                && candidate.result.structuredStatusEvidence
                && candidate.result.semantic != null
                && candidate.result.semantic.terminal();
    }

    static long latestEventTime(ExpressQueryResult result) {
        if (result == null) return 0L;
        long latest = Math.max(result.statusEventTime,
                ExpressSourcePolicy.parseEventTime(result.latestTime));
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "")) {
            latest = Math.max(latest, ExpressSourcePolicy.parseEventTime(track.time));
        }
        return latest;
    }

    /** Returns the persisted provider declaration; effective completeness is checked separately. */
    public static boolean completeByContract(String provider) {
        String normalized = normalizeProvider(provider);
        return PROVIDER_KUAIDI100.equals(normalized)
                || PROVIDER_KDNIAO.equals(normalized)
                || "interface5".equals(normalized)
                || "interface6".equals(normalized);
    }

    static boolean storedCompleteness(String provider, boolean stored) {
        String normalized = normalizeProvider(provider);
        if (PROVIDER_MOTO.equals(normalized) || PROVIDER_MEIZU.equals(normalized)
                || PROVIDER_OPPO.equals(normalized)) return false;
        return stored || completeByContract(normalized);
    }

    private static int queryOrder(String provider) {
        if (PROVIDER_MEIZU.equals(provider)) return 0;
        if (PROVIDER_MOTO.equals(provider)) return 1;
        if (PROVIDER_OPPO.equals(provider)) return 2;
        if (PROVIDER_KDNIAO.equals(provider)) return 3;
        if (PROVIDER_KUAIDI100.equals(provider)) return 4;
        return 5;
    }

    private static String normalizeProvider(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }
}
