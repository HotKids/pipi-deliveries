package me.pipi.deliveries.data;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

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
        Candidate online = byProvider.get(PROVIDER_MEIZU);
        if (online != null) return online;

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
        return selectDetailDecision(candidates, feedLatestEventMillis, preferredProvider).candidate;
    }

    /** The diagnostic reason is produced by the same branch that selects the package. */
    public static final class DetailDecision {
        public final Candidate candidate;
        public final String reason;
        public DetailDecision(Candidate candidate, String reason) {
            this.candidate = candidate;
            this.reason = reason;
        }
    }

    public static DetailDecision selectDetailDecision(
            List<Candidate> candidates, long feedLatestEventMillis, String preferredProvider) {
        Map<String, Candidate> byProvider = new LinkedHashMap<>();
        if (candidates != null) for (Candidate candidate : candidates) {
            if (!isAuthoritative(candidate)) continue;
            Candidate cached = byProvider.get(candidate.provider);
            byProvider.put(candidate.provider,
                    cached == null ? candidate : mergeSameProvider(cached, candidate));
        }
        Candidate best = selectBestDetail(byProvider, feedLatestEventMillis);
        if (best == null) return new DetailDecision(null, "source_policy");
        Candidate preferred = byProvider.get(normalizeProvider(preferredProvider));
        if (preferred != null && preferred != best) {
            return rankingComplete(preferred, byProvider, feedLatestEventMillis)
                    || !rankingComplete(best, byProvider, feedLatestEventMillis)
                    ? new DetailDecision(preferred, "sticky_history")
                    : new DetailDecision(best, "complete_replaces_partial");
        }
        Candidate runner = null;
        for (Candidate candidate : byProvider.values()) {
            if (candidate == best) continue;
            if (runner == null || compare(candidate, runner, byProvider, feedLatestEventMillis) < 0) {
                runner = candidate;
            }
        }
        String reason = runner == null ? "only_eligible_history"
                : rankingComplete(best, byProvider, feedLatestEventMillis)
                        != rankingComplete(runner, byProvider, feedLatestEventMillis) ? "complete_history"
                : Kuaidi100TimelinePolicy.timedTrackCount(best.result)
                        != Kuaidi100TimelinePolicy.timedTrackCount(runner.result) ? "track_coverage"
                : isEffectivelyComplete(best) != isEffectivelyComplete(runner) ? "capture_complete"
                : candidateTier(best) != candidateTier(runner) ? "source_tier" : "provider_order";
        return new DetailDecision(best, reason);
    }

    /** Ranks the owner and eligible sidecars together before applying account freshness and stickiness. */
    static DetailDecision selectAutomaticDetailDecision(List<Candidate> candidates,
            ExpressQueryResult source, ExpressQueryResult accountStatus,
            long referenceEventMillis, String preferredProvider) {
        Map<String, Candidate> byProvider = new LinkedHashMap<>();
        Candidate feed = new Candidate(PREFERRED_FEED, source, 1L, false);
        if (isAuthoritative(feed)) byProvider.put(feed.provider, feed);
        if (candidates != null) for (Candidate candidate : candidates) {
            if (!isAuthoritative(candidate)) continue;
            Candidate cached = byProvider.get(candidate.provider);
            byProvider.put(candidate.provider, cached == null ? candidate : mergeSameProvider(cached, candidate));
        }
        java.util.ArrayList<Candidate> ranked = new java.util.ArrayList<>(byProvider.values());
        Map<Candidate, Boolean> complete = new java.util.IdentityHashMap<>();
        for (Candidate candidate : ranked) {
            complete.put(candidate, detailTimelineComplete(automaticPresentationResult(
                    candidate.result, accountStatus, ranked), referenceEventMillis));
        }
        boolean hasHistory = ranked.stream().anyMatch(candidate -> candidate != feed
                && Kuaidi100TimelinePolicy.timedTrackCount(candidate.result) >= SOURCE_TIMELINE_MIN_TRACKS);
        if (hasHistory && Boolean.FALSE.equals(complete.get(feed))
                && Kuaidi100TimelinePolicy.timedTrackCount(source) < SOURCE_TIMELINE_MIN_TRACKS) {
            ranked.remove(feed);
        }
        ranked.sort((left, right) -> compareDetailQuality(left, right, complete.get(left), complete.get(right)));
        if (ranked.isEmpty()) return new DetailDecision(null, "no_eligible_history");
        long newestAccountAt = 0L;
        for (Candidate candidate : ranked) if (isAccountHistory(candidate)) {
            newestAccountAt = Math.max(newestAccountAt, Kuaidi100TimelinePolicy.latestTimedEventMillis(candidate.result));
        }
        boolean accountAdvances = newestAccountAt > 0L;
        for (Candidate candidate : ranked) {
            long at = Kuaidi100TimelinePolicy.latestTimedEventMillis(candidate.result);
            if (at <= 0L || !isAccountHistory(candidate) && (at >= newestAccountAt || complete.get(candidate))) {
                accountAdvances = false;
            }
        }
        boolean narrowed = false;
        if (accountAdvances) {
            long newest = newestAccountAt;
            narrowed = ranked.removeIf(candidate -> !isAccountHistory(candidate)
                    || Kuaidi100TimelinePolicy.latestTimedEventMillis(candidate.result) != newest);
        }
        Candidate winner = ranked.get(0);
        Candidate preferred = byProvider.get(normalizeProvider(preferredProvider));
        String reason;
        if (preferred != null && ranked.contains(preferred) && preferred != winner) {
            if (complete.get(preferred) || !complete.get(winner)) {
                winner = preferred;
                reason = "sticky_history";
            } else reason = "complete_replaces_partial";
        } else {
            Candidate runner = ranked.size() > 1 ? ranked.get(1) : null;
            reason = narrowed ? "newer_account_history" : runner == null ? "only_eligible_history"
                    : complete.get(winner) != complete.get(runner) ? "complete_history"
                    : Kuaidi100TimelinePolicy.timedTrackCount(winner.result)
                            != Kuaidi100TimelinePolicy.timedTrackCount(runner.result) ? "track_coverage"
                    : isEffectivelyComplete(winner) != isEffectivelyComplete(runner) ? "capture_complete"
                    : candidateTier(winner, complete.get(winner)) != candidateTier(runner, complete.get(runner))
                            ? "source_tier" : "provider_order";
        }
        return new DetailDecision(winner == feed ? null : winner, reason);
    }

    static ExpressQueryResult automaticPresentationResult(ExpressQueryResult history,
            ExpressQueryResult accountStatus, List<Candidate> candidates) {
        if (history == null) return null;
        if (accountStatus == null || accountStatus.semantic == StatusSemantic.UNKNOWN) {
            return presentationResult(history, candidates);
        }
        return new ExpressQueryResult(history.waybill, history.courierCode, history.companyName,
                accountStatus.semantic, accountStatus.statusEventTime, history.latestTime, history.latestDetail,
                WorkerStatusProjection.attach(history.tracksJson, accountStatus.workerStatus),
                history.detailUrl, history.phone, history.timelineProvider,
                history.routeInterface, history.routeCredential, history.sourceProvider, history.carrierNormalization)
                .withManualStatusEvidence(accountStatus.statusDescription, accountStatus.structuredStatusEvidence);
    }

    private static boolean isAccountHistory(Candidate candidate) {
        return PREFERRED_FEED.equals(candidate.provider) || TimelineSlot.isAccount(candidate.provider);
    }

    private static Candidate selectBestDetail(Map<String, Candidate> byProvider) {
        return selectBestDetail(byProvider, 0L);
    }

    private static Candidate selectBestDetail(
            Map<String, Candidate> byProvider, long feedLatestEventMillis) {
        Candidate selected = null;
        for (Candidate candidate : byProvider.values()) {
            if (selected == null
                    || compare(candidate, selected, byProvider, feedLatestEventMillis) < 0) {
                selected = candidate;
            }
        }
        return selected;
    }

    /** History may lag the account reference by at most 30 minutes. */
    public static final long DETAIL_COMPLETE_SKEW_MS = 30L * 60_000L;

    /** feed 攒出历史（≥2 条有效节点）才算轨迹；只有一条时它是状态摘要。 */
    public static final int SOURCE_TIMELINE_MIN_TRACKS = 2;

    /** Ranking requires known, compatible status, trusted completion, pickup and clock alignment. */
    public static boolean detailTimelineComplete(
            ExpressQueryResult result, long feedLatestEventMillis) {
        return detailTimelineIncompleteReason(result, feedLatestEventMillis) == null;
    }

    public static String detailTimelineIncompleteReason(ExpressQueryResult result, long feedLatestEventMillis) {
        if (result == null || result.semantic == StatusSemantic.UNKNOWN) return "missing_status";
        if (result.semantic == StatusSemantic.COMPLETED
                && ExpressLifecycleTimes.signedEvidenceAt(null, result, System.currentTimeMillis()) <= 0L) {
            return "missing_source_time";
        }
        for (StatusSemantic semantic : ExpressTimeline.latestTrackStatuses(result.tracksJson, result.timelineProvider)) {
            if (semantic != StatusSemantic.UNKNOWN && semantic != result.semantic) return "status_mismatch";
        }
        if (!Kuaidi100TimelinePolicy.hasPickupEvidence(result)) return "missing_pickup";
        if (feedLatestEventMillis <= 0L) return null;
        long latest = Kuaidi100TimelinePolicy.latestTimedEventMillis(result);
        if (latest <= 0L) return "missing_source_time";
        return feedLatestEventMillis - latest <= DETAIL_COMPLETE_SKEW_MS ? null : "time_mismatch";
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
        return selectOverSource(candidate, sourcePackage, preferredProvider, referenceEventMillis).candidate != null;
    }

    public static DetailDecision selectOverSource(Candidate candidate, ExpressQueryResult sourcePackage,
            String preferredProvider, long referenceEventMillis) {
        if (!isAuthoritative(candidate)) return new DetailDecision(null, "source_policy");
        if (sourcePackage == null || !Kuaidi100TimelinePolicy.hasTimedTracking(sourcePackage)) {
            return new DetailDecision(candidate, "only_eligible_history");
        }
        boolean sourceComplete = detailTimelineComplete(sourcePackage, referenceEventMillis);
        boolean candidateComplete = detailTimelineComplete(candidate.result, referenceEventMillis);
        String preferred = preferredProvider == null ? "" : preferredProvider.trim();
        if (PREFERRED_FEED.equals(preferred)) {
            return candidateComplete && !sourceComplete
                    ? new DetailDecision(candidate, "complete_replaces_partial")
                    : new DetailDecision(null, "sticky_history");
        }
        if (!preferred.isEmpty() && normalizeProvider(preferred).equals(candidate.provider)) {
            return sourceComplete && !candidateComplete
                    ? new DetailDecision(null, "complete_replaces_partial")
                    : new DetailDecision(candidate, "sticky_history");
        }
        if (sourceComplete != candidateComplete) {
            return new DetailDecision(candidateComplete ? candidate : null, "complete_history");
        }
        int sourceTracks = Kuaidi100TimelinePolicy.timedTrackCount(sourcePackage);
        int candidateTracks = Kuaidi100TimelinePolicy.timedTrackCount(candidate.result);
        if (sourceTracks != candidateTracks) {
            return new DetailDecision(candidateTracks > sourceTracks ? candidate : null, "track_coverage");
        }
        int tier = Integer.compare(sourceTier(sourceComplete, sourceTracks), candidateTier(candidate));
        return new DetailDecision(tier > 0 ? candidate : null, tier != 0 ? "source_tier" : "provider_order");
    }

    private static int sourceTier(boolean sourceComplete, int sourceTracks) {
        if (sourceComplete) return TIER_SOURCE_COMPLETE;
        return sourceTracks >= SOURCE_TIMELINE_MIN_TRACKS
                ? TIER_SOURCE_INCREMENT : TIER_SOURCE_SUMMARY_ONLY;
    }

    private static int candidateTier(Candidate candidate) {
        return candidateTier(candidate, detailTimelineComplete(candidate.result, 0L));
    }

    private static int candidateTier(Candidate candidate, boolean complete) {
        if (isAccountHistory(candidate)) return sourceTier(complete, Kuaidi100TimelinePolicy.timedTrackCount(candidate.result));
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
    private static boolean rankingComplete(Candidate candidate, Map<String, Candidate> candidates,
            long referenceEventMillis) {
        return detailTimelineComplete(presentationResult(candidate.result,
                new java.util.ArrayList<>(candidates.values())), referenceEventMillis);
    }

    private static int compare(Candidate left, Candidate right,
            Map<String, Candidate> candidates, long feedLatestEventMillis) {
        return compareDetailQuality(left, right,
                rankingComplete(left, candidates, feedLatestEventMillis),
                rankingComplete(right, candidates, feedLatestEventMillis));
    }

    /** Shared quality ordering accepts completeness evidence without invoking status selection. */
    private static int compareDetailQuality(Candidate left, Candidate right,
            boolean leftComplete, boolean rightComplete) {
        int completeness = Boolean.compare(rightComplete, leftComplete);
        if (completeness != 0) return completeness;
        int coverage = Integer.compare(
                Kuaidi100TimelinePolicy.timedTrackCount(right.result),
                Kuaidi100TimelinePolicy.timedTrackCount(left.result));
        if (coverage != 0) return coverage;
        int declared = Boolean.compare(
                isEffectivelyComplete(right), isEffectivelyComplete(left));
        if (declared != 0) return declared;
        int tier = Integer.compare(candidateTier(left, leftComplete), candidateTier(right, rightComplete));
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
        Map<StatusSemantic, Candidate> bySemantic = new LinkedHashMap<>();
        // Select subtypes before comparing event clocks across semantics to avoid cyclic comparisons.
        for (Candidate candidate : candidates) {
            if (!hasStructuredStatus(candidate)) continue;
            Candidate current = bySemantic.get(candidate.result.semantic);
            int priority = current == null ? 0 : Integer.compare(
                    WorkerStatusProjection.priority(candidate.result), WorkerStatusProjection.priority(current.result));
            if (current == null || priority > 0
                    || priority == 0 && compareStatusTimeAndQuality(candidate, current) < 0) {
                bySemantic.put(candidate.result.semantic, candidate);
            }
        }
        Candidate selected = null;
        for (Candidate candidate : bySemantic.values()) {
            boolean candidateSigned = preserveSigned && candidate.result.semantic == StatusSemantic.COMPLETED;
            boolean selectedSigned = selected != null && preserveSigned
                    && selected.result.semantic == StatusSemantic.COMPLETED;
            if (selected == null || candidateSigned && !selectedSigned
                    || candidateSigned == selectedSigned && compareStatusTimeAndQuality(candidate, selected) < 0) {
                selected = candidate;
            }
        }
        return selected;
    }

    private static int compareStatusTimeAndQuality(Candidate left, Candidate right) {
        int time = Long.compare(right.result.statusEventTime, left.result.statusEventTime);
        if (time != 0) return time;
        return compareDetailQuality(left, right,
                detailTimelineComplete(left.result, 0L), detailTimelineComplete(right.result, 0L));
    }

    /** Transient presentation may borrow a structured pair without changing either source cache. */
    public static ExpressQueryResult presentationResult(
            ExpressQueryResult selected, List<Candidate> candidates) {
        if (selected == null) return null;
        java.util.ArrayList<Candidate> sameWaybill = new java.util.ArrayList<>();
        String waybill = ExpressSourcePolicy.normalizeWaybill(selected.waybill);
        for (Candidate candidate : candidates) {
            if (candidate != null && candidate.result != null && waybill.equals(
                    ExpressSourcePolicy.normalizeWaybill(candidate.result.waybill))) sameWaybill.add(candidate);
        }
        if (selected.structuredStatusEvidence && selected.semantic != StatusSemantic.UNKNOWN) {
            sameWaybill.removeIf(candidate -> candidate.result.semantic != selected.semantic);
        }
        Candidate donor = selectStructuredStatus(sameWaybill);
        if (donor == null || selected.structuredStatusEvidence
                && selected.semantic != StatusSemantic.UNKNOWN
                && !(donor.result.semantic == selected.semantic
                && WorkerStatusProjection.priority(donor.result) > WorkerStatusProjection.priority(selected))) return selected;
        return new ExpressQueryResult(selected.waybill, selected.courierCode, selected.companyName,
                donor.result.semantic, donor.result.statusEventTime, selected.latestTime,
                selected.latestDetail, WorkerStatusProjection.attach(selected.tracksJson, donor.result.workerStatus),
                selected.detailUrl, selected.phone,
                selected.timelineProvider, selected.routeInterface, selected.routeCredential,
                selected.sourceProvider, selected.carrierNormalization)
                .withCarrierIdentityEvidence(selected.carrierIdentityEvidence)
                .withManualStatusEvidence(donor.result.statusDescription, donor.result.structuredStatusEvidence);
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

    public static long latestEventTime(ExpressQueryResult result) {
        if (result == null) return 0L;
        return Math.max(Kuaidi100TimelinePolicy.latestTimedEventMillis(result),
                hasStructuredStatus(result) ? result.statusEventTime : 0L);
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

    /** 链上次序（表格 2026-09-05）：online → moto → K100 H5 → 付费的快递鸟。Lite 没有接 OPPO。 */
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
