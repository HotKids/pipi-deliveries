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

    @Test
    public void completePackagesUseLatestProviderEventNotQueryCompletionTime() {
        Candidate latestQuery = candidate(
                "kuaidi100", 300L, "10:00:00", "已揽收", true);
        Candidate latestEvent = candidate(
                "kdniao", 100L, "13:00:00", "快件到达转运中心", true);

        assertSame(latestEvent, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(latestQuery, latestEvent)));
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

    @Test
    public void pickerThenMotoThenOppoThenKdniaoThenKuaidi100BreakEqualEventTimeTies() {
        Candidate fallback = candidate(
                "kuaidi100", 100L, "11:00:00", "快件已到达杭州转运中心", false);
        Candidate moto = candidate("v4", 300L, "11:00:00", "已揽收", false);
        Candidate meizu = candidate(
                "meizu", 250L, "11:00:00", "魅族 Picker 轨迹", false);
        Candidate oppo = candidate(
                "oppo", 200L, "11:00:00", "商家已将快件交付承运商", false);
        Candidate kdniao = candidate(
                "kdniao", 150L, "11:00:00", "快递鸟完整轨迹", false);

        assertSame(meizu, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(fallback, kdniao, moto, meizu, oppo)));
        assertSame(meizu, ManualTimelineAuthorityPolicy.selectDetail(
                Arrays.asList(fallback, kdniao, moto, meizu, oppo)));
        assertSame(meizu, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(fallback, kdniao, meizu, oppo)));
        assertSame(oppo, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(fallback, kdniao, oppo)));
        assertSame(kdniao, ManualTimelineAuthorityPolicy.select(
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

        assertEquals("interface5", selected.provider);
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
        assertFalse(ManualTimelineAuthorityPolicy.completeByContract("oppo"));
        assertTrue(ManualTimelineAuthorityPolicy.completeByContract("kuaidi100"));
        assertTrue(ManualTimelineAuthorityPolicy.completeByContract("kdniao"));
        assertFalse(ManualTimelineAuthorityPolicy.storedCompleteness("v4", true));
        assertFalse(ManualTimelineAuthorityPolicy.storedCompleteness("meizu", true));
        assertFalse(ManualTimelineAuthorityPolicy.storedCompleteness("oppo", true));
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
}
