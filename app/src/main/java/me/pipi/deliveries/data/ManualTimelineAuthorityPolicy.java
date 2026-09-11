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
    private static final String PROVIDER_MOTO = TimelineSlot.V4_QUERY;
    private static final String PROVIDER_MEIZU = TimelineSlot.V6_QUERY;
    private static final String PROVIDER_KDNIAO = TimelineSlot.KDNIAO;
    private static final String PROVIDER_KUAIDI100 = TimelineSlot.K100_H5;
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
            if (TimelineSlot.isAutomaticH5(candidate.provider)) continue;
            Candidate cached = byProvider.get(candidate.provider);
            byProvider.put(candidate.provider,
                    cached == null ? candidate : mergeSameProvider(cached, candidate));
        }

        // Meizu remains the status and polling authority. SF display uses detail selection separately.
        Candidate picker = byProvider.get(PROVIDER_MEIZU);
        if (picker != null) return picker;

        return selectBestDetail(byProvider);
    }

    /**
     * 用户定 2026-09-05：手动件的首页头条/状态跟详情同一套选包，不再由 Meizu 独占；共享手动
     * 时间线的自动件（顺丰等）照旧 Meizu 先。
     */
    public static Candidate selectForOwner(List<Candidate> candidates, boolean manuallyAdded) {
        return selectForOwner(candidates, manuallyAdded, "");
    }

    public static Candidate selectForOwner(
            List<Candidate> candidates, boolean manuallyAdded, String preferredProvider) {
        return manuallyAdded ? selectDetail(candidates, 0L, preferredProvider) : select(candidates);
    }

    /** 粘性选包里「行自己的 feed 包」的名字（用户定 2026-09-05 晚）。 */
    public static final String PREFERRED_FEED = "feed";

    /** Selects the fullest whole provider package for the detail timeline. */
    public static Candidate selectDetail(List<Candidate> candidates) {
        return selectDetail(candidates, 0L);
    }

    public static Candidate selectDetail(List<Candidate> candidates, long feedLatestEventMillis) {
        return selectDetail(candidates, feedLatestEventMillis, "");
    }

    /**
     * 粘性选包（用户定 2026-09-05 晚，三端同口径）：上一轮详情页显示过的包还在（没被判串包、没被
     * 清掉）就默认还显示它；只有它自己不完整、而别的包已完整时才换。排序本身不变：完整判据 →
     * 节点数 → 自报 complete → 层级 → 次序。
     */
    public static Candidate selectDetail(
            List<Candidate> candidates, long feedLatestEventMillis, String preferredProvider) {
        if (candidates == null || candidates.isEmpty()) return null;
        Map<String, Candidate> byProvider = new LinkedHashMap<>();
        for (Candidate candidate : candidates) {
            if (!isAuthoritative(candidate)) continue;
            Candidate cached = byProvider.get(candidate.provider);
            byProvider.put(candidate.provider,
                    cached == null ? candidate : mergeSameProvider(cached, candidate));
        }
        Candidate best = selectBestDetail(byProvider, feedLatestEventMillis);
        Candidate preferred = byProvider.get(normalizeProvider(preferredProvider));
        if (preferred == null || best == null || preferred == best) return best;
        return detailTimelineComplete(preferred.result, feedLatestEventMillis)
                || !detailTimelineComplete(best.result, feedLatestEventMillis)
                ? preferred : best;
    }

    private static Candidate selectBestDetail(Map<String, Candidate> byProvider) {
        return selectBestDetail(byProvider, 0L);
    }

    private static Candidate selectBestDetail(
            Map<String, Candidate> byProvider, long feedLatestEventMillis) {
        Candidate selected = null;
        for (Candidate candidate : byProvider.values()) {
            if (selected == null
                    || compare(candidate, selected, feedLatestEventMillis) < 0) {
                selected = candidate;
            }
        }
        return selected;
    }

    /** 详情完整判据的容差；三端同值（用户定 2026-09-04：前后 30 分钟）。 */
    public static final long DETAIL_COMPLETE_SKEW_MS = 30L * 60_000L;

    /** feed 攒出历史（≥2 条有效节点）才算轨迹；只有一条时它是状态摘要。 */
    public static final int SOURCE_TIMELINE_MIN_TRACKS = 2;

    /**
     * 详情完整的判据（用户定 2026-09-04，三端同口径）：
     * {@code |该包最新节点时间 − feed 最新节点时间| ≤ 30 分钟} <strong>且</strong>轨迹里有揽收。
     * 没有 feed（纯手动件）或 feed 没有有效时间节点时，只看有没有揽收。
     */
    public static boolean detailTimelineComplete(
            ExpressQueryResult result, long feedLatestEventMillis) {
        if (!Kuaidi100TimelinePolicy.hasPickupEvidence(result)) return false;
        if (feedLatestEventMillis <= 0L) return true;
        long latest = Kuaidi100TimelinePolicy.latestTimedEventMillis(result);
        if (latest <= 0L) return false;
        return Math.abs(latest - feedLatestEventMillis) <= DETAIL_COMPLETE_SKEW_MS;
    }

    /**
     * feed 与选中的手动包谁上详情页（用户定 2026-09-04，三端同口径）：
     * 完整判据 → 有效节点数 → 层级。层级里只有一条节点的 feed 是<strong>状态摘要不是轨迹</strong>，
     * 排在手动包之后；付费的快递鸟排在 feed 增量之后。
     */
    public static boolean detailOutranksSource(
            Candidate candidate, ExpressQueryResult sourcePackage) {
        return detailOutranksSource(candidate, sourcePackage, "");
    }

    public static boolean detailOutranksSource(
            Candidate candidate, ExpressQueryResult sourcePackage, String preferredProvider) {
        return detailOutranksSource(candidate, sourcePackage, preferredProvider,
                Kuaidi100TimelinePolicy.latestTimedEventMillis(sourcePackage));
    }

    public static boolean detailOutranksSource(Candidate candidate,
            ExpressQueryResult sourcePackage, String preferredProvider, long referenceEventMillis) {
        if (!isAuthoritative(candidate)) return false;
        if (sourcePackage == null
                || !Kuaidi100TimelinePolicy.hasTimedTracking(sourcePackage)) return true;
        boolean sourceComplete = detailTimelineComplete(sourcePackage, referenceEventMillis);
        boolean candidateComplete = detailTimelineComplete(candidate.result, referenceEventMillis);
        // 粘性选包（用户定 2026-09-05 晚）：上一轮显示的是 feed 就还是 feed，显示的是这个手动包就
        // 还是它；只有留下的那个不完整、对方已完整时才换。
        String preferred = preferredProvider == null ? "" : preferredProvider.trim();
        if (PREFERRED_FEED.equals(preferred)) return candidateComplete && !sourceComplete;
        if (!preferred.isEmpty() && normalizeProvider(preferred).equals(candidate.provider)) {
            return !(sourceComplete && !candidateComplete);
        }
        if (sourceComplete != candidateComplete) return candidateComplete;
        int sourceTracks = Kuaidi100TimelinePolicy.timedTrackCount(sourcePackage);
        int candidateTracks = Kuaidi100TimelinePolicy.timedTrackCount(candidate.result);
        if (sourceTracks != candidateTracks) return candidateTracks > sourceTracks;
        return sourceTier(sourceComplete, sourceTracks) > candidateTier(candidate);
    }

    private static int sourceTier(boolean sourceComplete, int sourceTracks) {
        if (sourceComplete) return TIER_SOURCE_COMPLETE;
        return sourceTracks >= SOURCE_TIMELINE_MIN_TRACKS
                ? TIER_SOURCE_INCREMENT : TIER_SOURCE_SUMMARY_ONLY;
    }

    private static int candidateTier(Candidate candidate) {
        return PROVIDER_KDNIAO.equals(normalizeProvider(candidate.provider))
                ? TIER_PAID_MANUAL : TIER_FREE_MANUAL;
    }

    /** 层级：接口完整轨迹 → feed 增量 → 免费手动包 → feed 摘要 → 付费手动包。 */
    static final int TIER_SOURCE_COMPLETE = 0;
    static final int TIER_SOURCE_INCREMENT = 1;
    static final int TIER_FREE_MANUAL = 2;
    static final int TIER_SOURCE_SUMMARY_ONLY = 3;
    static final int TIER_PAID_MANUAL = 4;

    /** A failed, timeless or placeholder-only response never becomes a selectable package. */
    public static boolean isAuthoritative(Candidate candidate) {
        return candidate != null
                && !candidate.provider.isEmpty()
                && candidate.successAt > 0L
                && Kuaidi100TimelinePolicy.hasTimedTracking(candidate.result);
    }

    public static boolean isShunFengManualCandidate(Candidate candidate) {
        return isAuthoritative(candidate)
                && (PROVIDER_MEIZU.equals(candidate.provider)
                || PROVIDER_KUAIDI100.equals(candidate.provider));
    }

    /**
     * Incrementally merges only one provider's successful cache. An unsuccessful refresh leaves
     * the previous success timestamp and result untouched.
     */
    public static Candidate mergeSameProvider(Candidate cached, Candidate refreshed) {
        if (!isAuthoritative(cached) && !hasStructuredStatus(cached)) {
            return isAuthoritative(refreshed) || hasStructuredStatus(refreshed) ? refreshed : null;
        }
        if (!isAuthoritative(refreshed) && !hasStructuredStatus(refreshed)) return cached;
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

    /**
     * 排序（用户定 2026-09-04，三端同口径）：<strong>完整判据 → 有效节点数 → 各家自报的
     * complete → 层级 → 既有链上次序</strong>。
     *
     * <p>自报的 complete 退到覆盖之后：它只表示「这次抓取把列表展开了」，2026-09-04 实测过一票
     * 22 条的完整包因为它输给 2 条的包，查到了却不显示。</p>
     */
    private static int compare(Candidate left, Candidate right, long feedLatestEventMillis) {
        int completeness = Boolean.compare(
                detailTimelineComplete(right.result, feedLatestEventMillis),
                detailTimelineComplete(left.result, feedLatestEventMillis));
        if (completeness != 0) return completeness;
        int coverage = Integer.compare(
                Kuaidi100TimelinePolicy.timedTrackCount(right.result),
                Kuaidi100TimelinePolicy.timedTrackCount(left.result));
        if (coverage != 0) return coverage;
        int declared = Boolean.compare(
                isEffectivelyComplete(right), isEffectivelyComplete(left));
        if (declared != 0) return declared;
        int tier = Integer.compare(candidateTier(left), candidateTier(right));
        if (tier != 0) return tier;
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
    /**
     * 用户定 2026-09-05：状态看来源**返回的结构化状态**，不看文案。展示包自己没有结构化状态时
     * （K100 页只有文案），用同一票别的包里事件时间最新的那个结构化状态；一个都没有才轮到文案。
     */
    static boolean hasStructuredStatus(Candidate candidate) {
        return candidate != null && !candidate.provider.isEmpty() && candidate.successAt > 0L
                && hasStructuredStatus(candidate.result);
    }

    public static boolean hasStructuredStatus(ExpressQueryResult result) {
        return result != null && result.structuredStatusEvidence && result.semantic != null
                && result.semantic != me.pipi.deliveries.model.StatusSemantic.UNKNOWN
                && !me.pipi.deliveries.model.ExpressStatusNormalizer.isProviderErrorDetail(result.latestDetail)
                && !ExpressTimeline.containsProviderError(result.tracksJson);
    }

    static Candidate selectStructuredStatus(List<Candidate> candidates) {
        return selectStructuredStatus(candidates, false);
    }

    static Candidate selectStructuredStatus(List<Candidate> candidates, boolean preserveSigned) {
        if (candidates == null || candidates.isEmpty()) return null;
        Candidate selected = null;
        for (Candidate candidate : candidates) {
            if (!hasStructuredStatus(candidate)) continue;
            boolean candidateSigned = preserveSigned
                    && candidate.result.semantic == me.pipi.deliveries.model.StatusSemantic.COMPLETED;
            boolean selectedSigned = selected != null && preserveSigned
                    && selected.result.semantic == me.pipi.deliveries.model.StatusSemantic.COMPLETED;
            if (selected == null || candidateSigned && !selectedSigned
                    || candidateSigned == selectedSigned
                    && (candidate.result.statusEventTime > selected.result.statusEventTime
                    || candidate.result.statusEventTime == selected.result.statusEventTime
                    && queryOrder(candidate.provider) < queryOrder(selected.provider))) {
                selected = candidate;
            }
        }
        return selected;
    }

    /** Transient presentation may borrow a structured pair without changing either source cache. */
    public static ExpressQueryResult presentationResult(
            ExpressQueryResult selected, List<Candidate> candidates) {
        if (selected == null || selected.structuredStatusEvidence
                && selected.semantic != me.pipi.deliveries.model.StatusSemantic.UNKNOWN) return selected;
        java.util.ArrayList<Candidate> sameWaybill = new java.util.ArrayList<>();
        String waybill = ExpressSourcePolicy.normalizeWaybill(selected.waybill);
        for (Candidate candidate : candidates) {
            if (candidate != null && candidate.result != null && waybill.equals(
                    ExpressSourcePolicy.normalizeWaybill(candidate.result.waybill))) sameWaybill.add(candidate);
        }
        Candidate donor = selectStructuredStatus(sameWaybill);
        if (donor == null) return selected;
        return new ExpressQueryResult(selected.waybill, selected.courierCode, selected.companyName,
                donor.result.semantic, donor.result.statusEventTime, selected.latestTime,
                selected.latestDetail, selected.tracksJson, selected.detailUrl, selected.phone,
                selected.timelineProvider, selected.routeInterface, selected.routeCredential,
                selected.sourceProvider, selected.carrierNormalization)
                .withCarrierIdentityEvidence(selected.carrierIdentityEvidence)
                .withManualStatusEvidence(selected.statusDescription, selected.structuredStatusEvidence);
    }

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
        return PROVIDER_KDNIAO.equals(normalized)
                || TimelineSlot.isAccount(normalized);
    }

    static boolean storedCompleteness(String provider, boolean stored) {
        String normalized = normalizeProvider(provider);
        if (PROVIDER_MOTO.equals(normalized) || PROVIDER_MEIZU.equals(normalized)) return false;
        return stored || completeByContract(normalized);
    }

    /** 链上次序（表格 2026-09-05）：picker → moto → K100 H5 → 付费的快递鸟。Lite 没有接 OPPO。 */
    private static int queryOrder(String provider) {
        if (PROVIDER_MEIZU.equals(provider)) return 0;
        if (PROVIDER_MOTO.equals(provider)) return 1;
        if (PROVIDER_KUAIDI100.equals(provider) || TimelineSlot.JT_H5.equals(provider)) return 2;
        if (PROVIDER_KDNIAO.equals(provider)) return 3;
        return 4;
    }

    private static String normalizeProvider(String value) {
        return TimelineSlot.normalize(value);
    }
}
