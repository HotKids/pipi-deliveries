package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy.Candidate;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ManualTimelineAuthorityPolicyTest {
    @Test
    public void completeAndPartialTimedPackagesCanBecomeCandidates() {
        ExpressQueryResult valid = result(
                "interface5", "2026-08-24 10:00:00", "快件已揽收");

        assertFalse(ManualTimelineAuthorityPolicy.isAuthoritative(
                new Candidate("interface5", valid, 0L, true)));
        assertTrue(ManualTimelineAuthorityPolicy.isAuthoritative(
                new Candidate("interface5", valid, 100L, false)));
        assertFalse(ManualTimelineAuthorityPolicy.isAuthoritative(
                new Candidate("", valid, 100L, true)));
        assertFalse(ManualTimelineAuthorityPolicy.isAuthoritative(
                new Candidate("interface5", null, 100L, true)));
        assertTrue(ManualTimelineAuthorityPolicy.isAuthoritative(
                new Candidate(" INTERFACE5 ", valid, 100L, true)));
    }

    @Test
    public void timelessMalformedAndProviderErrorTracksAreRejected() {
        assertFalse(Kuaidi100TimelinePolicy.hasTimedTracking(resultWithTracks(
                "interface5", StatusSemantic.TRANSIT, "", "运输中",
                "[{\"context\":\"快件已揽收\"}]")));
        assertFalse(Kuaidi100TimelinePolicy.hasTimedTracking(resultWithTracks(
                "interface5", StatusSemantic.TRANSIT, "tomorrow", "快件已揽收",
                "[{\"time\":\"tomorrow\",\"context\":\"快件已揽收\"}]")));
        assertTrue(Kuaidi100TimelinePolicy.hasTimedTracking(resultWithTracks(
                "interface5", StatusSemantic.TRANSIT, "2026-08-24 10:00:00", "运输中",
                "[{\"time\":\"2026-08-24 10:00:00\",\"context\":\"运输中\"}]")));
        assertFalse(Kuaidi100TimelinePolicy.hasTimedTracking(resultWithTracks(
                "interface5", StatusSemantic.UNKNOWN, "2026-08-24 10:00:00", "no result",
                "[{\"time\":\"2026-08-24 10:00:00\",\"context\":\"no result\"}]")));
    }

    @Test
    public void realTimedNodeBehindPlaceholderIsAccepted() {
        ExpressQueryResult result = resultWithTracks(
                "interface5", StatusSemantic.TRANSIT,
                "2026-08-24 11:00:00", "运输中",
                "[{\"time\":\"2026-08-24 11:00:00\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"快件已到达转运中心\"}]");

        assertTrue(Kuaidi100TimelinePolicy.hasTimedTracking(result));
    }

    @Test
    public void completePackageBeatsNewerPartialPackage() {
        Candidate partial = candidate(
                "v4", 200L, "13:00:00", "快件已到达杭州转运中心", false);
        Candidate complete = candidate(
                "kuaidi100", 100L, "10:00:00", "已揽收", true);

        assertSame(complete, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(partial, complete)));
    }

    /**
     * 完整判据（揽收 + 与 feed 最新节点相差 ≤30 分钟）排在最前，压过「谁的事件更新」——后者是被
     * 这条判据取代的旧口径（用户定 2026-09-04，三端同口径）。
     */
    @Test
    public void packagesWithPickupEvidenceBeatNewerPackagesWithout() {
        Candidate withPickup = candidate(
                "kuaidi100", 300L, "10:00:00", "已揽收", true);
        Candidate newerWithoutPickup = candidate(
                "kdniao", 100L, "13:00:00", "快件到达转运中心", true);

        assertSame(withPickup, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(newerWithoutPickup, withPickup)));
        assertSame(withPickup, ManualTimelineAuthorityPolicy.selectDetail(
                Arrays.asList(newerWithoutPickup, withPickup)));
    }

    @Test
    public void sameProviderNonterminalRefreshMergesHistoryWithoutChangingCompletedHeader() {
        Candidate completed = explicitCandidate(
                "kdniao", 100L, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "已签收");
        Candidate laterTransit = explicitCandidate(
                "kdniao", 200L, StatusSemantic.TRANSIT,
                "2026-08-24 13:00:00", "快件到达转运中心");

        Candidate merged = ManualTimelineAuthorityPolicy.mergeSameProvider(
                completed, laterTransit);

        assertEquals(200L, merged.successAt);
        assertEquals(StatusSemantic.COMPLETED, merged.result.semantic);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.result.tracksJson, "", "");
        assertEquals(2, tracks.size());
        assertEquals("快件到达转运中心", tracks.get(0).detail);
        assertEquals("已签收", tracks.get(1).detail);
        assertTrue(ManualTimelineAuthorityPolicy.isEffectivelyComplete(merged));
    }

    @Test
    public void kdniaoTerminalNeedsTwoTimedNodesButKuaidi100DoesNot() {
        Candidate oneKdniaoNode = explicitCandidate(
                "kdniao", 100L, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "已签收", true, true);
        Candidate twoKdniaoNodes = new Candidate(
                "kdniao",
                resultWithTracks(
                        "kdniao", StatusSemantic.COMPLETED,
                        "2026-08-24 12:00:00", "已签收",
                        "[{\"time\":\"2026-08-24 12:00:00\",\"context\":\"已签收\"},"
                                + "{\"time\":\"2026-08-24 10:00:00\","
                                + "\"context\":\"已揽收\"}]"),
                100L, true);
        Candidate oneKuaidi100Node = explicitCandidate(
                "kuaidi100", 100L, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "已签收", true, true);

        assertTrue(oneKdniaoNode.complete);
        assertFalse(ManualTimelineAuthorityPolicy.isEffectivelyComplete(oneKdniaoNode));
        assertTrue(ManualTimelineAuthorityPolicy.isEffectivelyComplete(twoKdniaoNodes));
        assertTrue(ManualTimelineAuthorityPolicy.isEffectivelyComplete(oneKuaidi100Node));
        assertSame(oneKuaidi100Node, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(oneKdniaoNode, oneKuaidi100Node)));
    }

    @Test
    public void newerCompletedAuthorityCanReplaceOlderCompletedProvider() {
        Candidate olderCompleted = explicitCandidate(
                "v4", 100L, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "已签收", false);
        Candidate newerCompleted = new Candidate(
                "kdniao",
                resultWithTracks(
                        "kdniao", StatusSemantic.COMPLETED,
                        "2026-08-24 12:05:00", "本人签收",
                        "[{\"time\":\"2026-08-24 12:05:00\",\"context\":\"本人签收\"},"
                                + "{\"time\":\"2026-08-24 10:00:00\","
                                + "\"context\":\"已揽收\"}]"),
                200L, true);

        assertSame(newerCompleted, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(olderCompleted, newerCompleted)));
    }

    @Test
    public void terminalGuardDoesNotChangeR13PresentationPackageSelection() {
        Candidate completedPartial = explicitCandidate(
                "v4", 100L, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "已签收", false);
        Candidate laterCompleteTransit = explicitCandidate(
                "kuaidi100", 200L, StatusSemantic.TRANSIT,
                "2026-08-24 13:00:00", "快件再次运输", true);

        List<Candidate> candidates = Arrays.asList(laterCompleteTransit, completedPartial);

        assertSame(laterCompleteTransit, ManualTimelineAuthorityPolicy.select(candidates));
        assertSame(completedPartial,
                ManualTimelineAuthorityPolicy.selectStructuredTerminal(candidates));
    }

    @Test
    public void proseOnlyTerminalDoesNotTriggerCrossProviderTerminalProtection() {
        Candidate proseTerminal = explicitCandidate(
                "v4", 100L, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "已签收", false, false);
        Candidate structuredTransit = explicitCandidate(
                "kdniao", 200L, StatusSemantic.TRANSIT,
                "2026-08-24 13:00:00", "运输中", true, true);

        assertSame(structuredTransit, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(proseTerminal, structuredTransit)));
        assertNull(ManualTimelineAuthorityPolicy.selectStructuredTerminal(
                Collections.singletonList(proseTerminal)));
    }

    /**
     * 全并列时才回到链上次序：picker → moto → K100 H5 → 付费的快递鸟（表格 2026-09-05，Lite 没接
     * OPPO）。免费的快递100 排在付费的快递鸟之前——「只有前面几级都没有符合的数据时才调 kdniao」。
     */
    @Test
    public void pickerThenMotoThenKuaidi100ThenKdniaoBreakEqualTies() {
        Candidate fallback = candidate(
                "k100_h5", 100L, "11:00:00", "快件已到达杭州转运中心", false);
        Candidate moto = candidate("v4_query", 300L, "11:00:00", "快件运输中", false);
        Candidate meizu = candidate(
                "v6_picker", 250L, "11:00:00", "Picker 轨迹", false);
        Candidate kdniao = candidate(
                "kdniao", 150L, "11:00:00", "快递鸟轨迹", false);

        assertSame(meizu, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(fallback, kdniao, moto, meizu)));
        assertSame(meizu, ManualTimelineAuthorityPolicy.selectDetail(
                Arrays.asList(fallback, kdniao, moto, meizu)));
        assertSame(moto, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(fallback, kdniao, moto)));
        assertSame(fallback, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(fallback, kdniao)));
    }

    @Test
    public void noCompletePackageUsesQueryOrderBeforeEventFreshness() {
        Candidate olderPicker = candidate(
                "meizu", 100L, "10:00:00", "魅族 Picker 轨迹", false);
        Candidate newerMoto = candidate(
                "v4", 200L, "13:00:00", "快件到达转运中心", false);

        assertSame(olderPicker, ManualTimelineAuthorityPolicy.selectDetail(
                Arrays.asList(newerMoto, olderPicker)));
    }

    @Test
    public void failedLatestAttemptCannotDisplaceEarlierSuccess() {
        Candidate successful = candidate("interface5", 100L, "10:00:00", "已揽收");
        Candidate empty = new Candidate(
                "kuaidi100", resultWithTracks("kuaidi100", StatusSemantic.UNKNOWN,
                "", "", "[]"), 300L, true);

        assertSame(successful, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(empty, successful)));
    }

    @Test
    public void sameProviderSuccessesMergeIncrementallyAndKeepLatestSuccessTime() {
        Candidate cached = new Candidate(
                "interface5",
                resultWithTracks("interface5", StatusSemantic.PICKED,
                        "2026-08-24 10:00:00", "已揽收",
                        "[{\"time\":\"2026-08-24 10:00:00\","
                                + "\"context\":\"已揽收\"}]"),
                100L, true);
        Candidate refreshed = new Candidate(
                "INTERFACE5",
                resultWithTracks("interface5", StatusSemantic.TRANSIT,
                        "2026-08-24 11:00:00", "快件离开杭州转运中心",
                        "[{\"time\":\"2026-08-24 11:00:00\","
                                + "\"context\":\"快件离开杭州转运中心\"}]"),
                200L, true);

        Candidate selected = ManualTimelineAuthorityPolicy.select(
                Arrays.asList(refreshed, cached));
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                selected.result.tracksJson, "", "");

        assertEquals("v5_query", selected.provider);
        assertEquals(200L, selected.successAt);
        assertEquals(2, tracks.size());
        assertEquals("快件离开杭州转运中心", tracks.get(0).detail);
        assertEquals("已揽收", tracks.get(1).detail);
    }

    @Test
    public void sameProviderMergePreservesKnownCompleteness() {
        Candidate cachedComplete = candidate(
                "kuaidi100", 100L, "10:00:00", "已揽收", true);
        Candidate refreshedPartial = candidate(
                "kuaidi100", 200L, "11:00:00", "运输中", false);

        Candidate merged = ManualTimelineAuthorityPolicy.mergeSameProvider(
                cachedComplete, refreshedPartial);

        assertTrue(merged.complete);
        assertEquals(2, ExpressTimeline.parse(merged.result.tracksJson, "", "").size());
    }

    @Test
    public void completenessComesFromProviderContract() {
        assertFalse(ManualTimelineAuthorityPolicy.completeByContract("v4"));
        assertFalse(ManualTimelineAuthorityPolicy.completeByContract("meizu"));
        assertTrue(ManualTimelineAuthorityPolicy.completeByContract("kuaidi100"));
        assertTrue(ManualTimelineAuthorityPolicy.completeByContract("kdniao"));
        assertFalse(ManualTimelineAuthorityPolicy.storedCompleteness("v4", true));
        assertFalse(ManualTimelineAuthorityPolicy.storedCompleteness("meizu", true));
        assertTrue(ManualTimelineAuthorityPolicy.storedCompleteness("kuaidi100", false));
    }

    @Test
    public void providerCachesCannotBeMergedAcrossSources() {
        assertThrows(IllegalArgumentException.class, () ->
                ManualTimelineAuthorityPolicy.mergeSameProvider(
                        candidate("interface5", 100L, "10:00:00", "已揽收"),
                        candidate("kuaidi100", 200L, "11:00:00",
                                "快件已到达杭州转运中心")));
    }

    @Test
    public void noValidCandidateMeansNoManualAuthority() {
        assertNull(ManualTimelineAuthorityPolicy.select(null));
        assertNull(ManualTimelineAuthorityPolicy.select(Collections.emptyList()));
        assertNull(ManualTimelineAuthorityPolicy.select(Collections.singletonList(
                new Candidate("interface5", null, 100L, true))));
    }

    private static Candidate candidate(
            String provider, long successAt, String time, String detail) {
        return candidate(provider, successAt, time, detail, true);
    }

    private static Candidate candidate(
            String provider, long successAt, String time, String detail, boolean complete) {
        return new Candidate(provider,
                result(provider, "2026-08-24 " + time, detail), successAt, complete);
    }

    private static ExpressQueryResult result(
            String provider, String time, String detail) {
        return resultWithTracks(provider, StatusSemantic.TRANSIT, time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail + "\"}]");
    }

    private static ExpressQueryResult resultWithTracks(
            String provider, StatusSemantic semantic, String time,
            String detail, String tracks) {
        return new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", semantic, time, detail,
                tracks, "", "", provider);
    }

    private static Candidate explicitCandidate(
            String provider, long successAt, StatusSemantic semantic,
            String time, String detail) {
        return explicitCandidate(
                provider, successAt, semantic, time, detail, true,
                "v4".equals(provider) || "kdniao".equals(provider));
    }

    private static Candidate explicitCandidate(
            String provider, long successAt, StatusSemantic semantic,
            String time, String detail, boolean complete) {
        return explicitCandidate(
                provider, successAt, semantic, time, detail, complete,
                "v4".equals(provider) || "kdniao".equals(provider));
    }

    private static Candidate explicitCandidate(
            String provider, long successAt, StatusSemantic semantic,
            String time, String detail, boolean complete, boolean structured) {
        long eventTime = ExpressSourcePolicy.parseEventTime(time);
        ExpressQueryResult result = new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", semantic, eventTime,
                time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail + "\"}]",
                "", "", provider, "", "", "")
                .withManualStatusEvidence(semantic.label, structured);
        return new Candidate(provider, result, successAt, complete);
    }

    /** 粘性选包（用户定 2026-09-05 晚）：上一轮显示的包还在就还显示它，只有它不完整而对方完整才换。 */
    @Test
    public void stickySelectionKeepsThePreviouslyDisplayedPackageUnlessItIsTheOnlyIncompleteOne() {
        ExpressQueryResult pickerThree = new ExpressQueryResult(
                "SF123", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-09-05 12:00:00", "运输中",
                "[{\"time\":\"2026-09-05 12:00:00\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-09-05 10:00:00\",\"context\":\"已到达\"},"
                        + "{\"time\":\"2026-09-05 09:00:00\",\"context\":\"顺丰速运 已收取快件\"}]",
                "", "", "meizu");
        ExpressQueryResult k100Five = new ExpressQueryResult(
                "SF123", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-09-05 12:00:00", "运输中",
                "[{\"time\":\"2026-09-05 12:00:00\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-09-05 11:00:00\",\"context\":\"离开转运中心\"},"
                        + "{\"time\":\"2026-09-05 10:00:00\",\"context\":\"已到达\"},"
                        + "{\"time\":\"2026-09-05 09:30:00\",\"context\":\"快件已发出\"},"
                        + "{\"time\":\"2026-09-05 09:00:00\",\"context\":\"顺丰速运 已收取快件\"}]",
                "", "", "kuaidi100");
        List<ManualTimelineAuthorityPolicy.Candidate> candidates = Arrays.asList(
                new ManualTimelineAuthorityPolicy.Candidate("meizu", pickerThree, 1_000L, false),
                new ManualTimelineAuthorityPolicy.Candidate("kuaidi100", k100Five, 2_000L, true));
        // 两个都完整：排序取节点多的 K100……
        assertEquals("k100_h5",
                ManualTimelineAuthorityPolicy.selectDetail(candidates, 0L).provider);
        // ……但上一轮显示的是 picker 就还是 picker。
        assertEquals("v6_picker",
                ManualTimelineAuthorityPolicy.selectDetail(candidates, 0L, "meizu").provider);
        assertEquals("v6_picker",
                ManualTimelineAuthorityPolicy.selectDetail(candidates, 0L, "v6_picker").provider);
        // 上一轮的包不在了（被清掉 / 串包）：照常排序。
        assertEquals("k100_h5",
                ManualTimelineAuthorityPolicy.selectDetail(candidates, 0L, "kdniao").provider);
        // 上一轮显示的包不完整（没有揽收），对方完整：换。
        ExpressQueryResult pickerNoStart = new ExpressQueryResult(
                "SF123", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-09-05 12:00:00", "运输中",
                "[{\"time\":\"2026-09-05 12:00:00\",\"context\":\"运输中\"}]",
                "", "", "meizu");
        List<ManualTimelineAuthorityPolicy.Candidate> partial = Arrays.asList(
                new ManualTimelineAuthorityPolicy.Candidate("meizu", pickerNoStart, 1_000L, false),
                new ManualTimelineAuthorityPolicy.Candidate("kuaidi100", k100Five, 2_000L, true));
        assertEquals("k100_h5",
                ManualTimelineAuthorityPolicy.selectDetail(partial, 0L, "meizu").provider);
        // feed 与手动包之间同一规则：上一轮显示 feed 就留 feed，除非 feed 不完整而手动包完整。
        ManualTimelineAuthorityPolicy.Candidate k100 =
                new ManualTimelineAuthorityPolicy.Candidate("kuaidi100", k100Five, 2_000L, true);
        assertFalse(ManualTimelineAuthorityPolicy.detailOutranksSource(
                k100, pickerThree, ManualTimelineAuthorityPolicy.PREFERRED_FEED));
        assertTrue(ManualTimelineAuthorityPolicy.detailOutranksSource(
                k100, pickerNoStart, ManualTimelineAuthorityPolicy.PREFERRED_FEED));
        assertTrue(ManualTimelineAuthorityPolicy.detailOutranksSource(
                new ManualTimelineAuthorityPolicy.Candidate("meizu", pickerThree, 1_000L, false),
                k100Five, "meizu"));
    }

}
