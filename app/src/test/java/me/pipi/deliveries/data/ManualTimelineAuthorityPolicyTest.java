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
    public void onlyCompleteSuccessfulTimedTimelineCanBecomeAuthority() {
        ExpressQueryResult valid = result(
                "interface5", "2026-08-24 10:00:00", "快件已揽收");

        assertFalse(ManualTimelineAuthorityPolicy.isAuthoritative(
                new Candidate("interface5", valid, 0L, true)));
        assertFalse(ManualTimelineAuthorityPolicy.isAuthoritative(
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
    public void newestSuccessfulProviderWinsRegardlessOfQueryOrder() {
        Candidate primary = candidate("interface5", 100L, "10:00:00", "已揽收");
        Candidate fallback = candidate(
                "kuaidi100", 200L, "11:00:00", "快件已到达杭州转运中心");

        assertSame(fallback, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(primary, fallback)));
    }

    @Test
    public void completedAuthorityBeatsLaterSuccessfulNonterminalProvider() {
        Candidate completed = explicitCandidate(
                "interface5", 100L, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "已签收");
        Candidate laterTransit = explicitCandidate(
                "kuaidi100", 200L, StatusSemantic.TRANSIT,
                "2026-08-24 13:00:00", "快件到达转运中心");

        assertSame(completed, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(completed, laterTransit)));
        assertSame(completed, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(laterTransit, completed)));
    }

    @Test
    public void sameProviderNonterminalRefreshMergesHistoryWithoutChangingCompletedHeader() {
        Candidate completed = explicitCandidate(
                "kuaidi100", 100L, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "已签收");
        Candidate laterTransit = explicitCandidate(
                "kuaidi100", 200L, StatusSemantic.TRANSIT,
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
    }

    @Test
    public void newerCompletedAuthorityCanReplaceOlderCompletedProvider() {
        Candidate olderCompleted = explicitCandidate(
                "interface5", 100L, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "已签收");
        Candidate newerCompleted = explicitCandidate(
                "kuaidi100", 200L, StatusSemantic.COMPLETED,
                "2026-08-24 12:05:00", "本人签收");

        assertSame(newerCompleted, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(olderCompleted, newerCompleted)));
    }

    @Test
    public void selectedInterfaceWinsEqualSuccessTimeTieOverKuaidi100() {
        Candidate fallback = candidate(
                "kuaidi100", 200L, "11:00:00", "快件已到达杭州转运中心");
        Candidate interface5 = candidate("interface5", 200L, "10:00:00", "已揽收");
        Candidate interface6 = candidate(
                "interface6", 200L, "10:30:00", "商家已将快件交付承运商");

        assertSame(interface5, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(fallback, interface5)));
        assertSame(interface6, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(fallback, interface6)));
    }

    @Test
    public void failedLatestAttemptCannotDisplaceEarlierSuccess() {
        Candidate successful = candidate("interface5", 100L, "10:00:00", "已揽收");
        Candidate empty = new Candidate(
                "kuaidi100", resultWithTracks("kuaidi100", StatusSemantic.UNKNOWN,
                "", "", "[]"), 300L, true);
        Candidate incomplete = new Candidate(
                "interface5", result("interface5", "2026-08-24 12:00:00", "派送中"),
                400L, false);

        assertSame(successful, ManualTimelineAuthorityPolicy.select(
                Arrays.asList(empty, successful, incomplete)));
        assertSame(successful,
                ManualTimelineAuthorityPolicy.mergeSameProvider(successful, incomplete));
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
        return new Candidate(provider,
                result(provider, "2026-08-24 " + time, detail), successAt, true);
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
        long eventTime = ExpressSourcePolicy.parseEventTime(time);
        ExpressQueryResult result = new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", semantic, eventTime,
                time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail + "\"}]",
                "", "", provider, "", "", "");
        return new Candidate(provider, result, successAt, true);
    }
}
