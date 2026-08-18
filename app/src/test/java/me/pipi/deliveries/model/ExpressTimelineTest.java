package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.List;

public final class ExpressTimelineTest {
    @Test
    public void parsesKuaidi100TracksNewestFirst() {
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                "[{\"time\":\"2026-08-14 10:00:00\",\"context\":\"已揽收\"},"
                        + "{\"time\":\"2026-08-15 11:00:00\",\"context\":\"运输中\"}]",
                "", "");

        assertEquals(2, tracks.size());
        assertEquals("运输中", tracks.get(0).detail);
        assertEquals("已揽收", tracks.get(1).detail);
    }

    @Test
    public void acceptsInterface5DescriptionAndFallback() {
        assertEquals("已到达驿站", ExpressTimeline.parse(
                "[{\"time\":\"2026-08-15 12:00:00\",\"desc\":\"已到达驿站\"}]",
                "", "").get(0).detail);
        assertEquals("暂无详细轨迹", ExpressTimeline.parse(
                "not-json", "2026-08-15 12:00:00", "暂无详细轨迹").get(0).detail);
    }

    @Test
    public void removesDuplicateLocalTimelineNodes() {
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                "[{\"time\":\"2026-08-15 12:00:00\",\"context\":\"已到达 驿站\"},"
                        + "{\"time\":\"2026-08-15 12:00:00\",\"desc\":\" 已到达  驿站 \"},"
                        + "{\"time\":\"2026-08-15 11:00:00\",\"context\":\"运输中\"}]",
                "", "");

        assertEquals(2, tracks.size());
        assertEquals("已到达 驿站", tracks.get(0).detail);
        assertEquals("运输中", tracks.get(1).detail);
    }

    @Test
    public void collapsesAdjacentProviderDuplicatesButKeepsLaterRepeatedEvents() {
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                "[{\"time\":\"2026-08-15 12:03:00\",\"context\":\"已到达网点\"},"
                        + "{\"time\":\"2026-08-15 12:00:00\",\"context\":\"已到达网点。\"},"
                        + "{\"time\":\"2026-08-15 11:00:00\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\",\"context\":\"已到达网点\"}]",
                "", "");

        assertEquals(3, tracks.size());
        assertEquals("2026-08-15 12:03:00", tracks.get(0).time);
        assertEquals("运输中", tracks.get(1).detail);
        assertEquals("已到达网点", tracks.get(2).detail);
    }

    @Test
    public void incrementalMergeKeepsHistoryAndUsesRefreshedNodeAtSameTime() {
        String merged = ExpressTimeline.mergeJson(
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"旧内容\"},"
                        + "{\"time\":\"2026-08-15 09:00:00\",\"context\":\"已揽收\"}]",
                "[{\"time\":\"2026-08-15 11:00:00\",\"context\":\"派送中\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\",\"context\":\"新内容\"}]");

        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(merged, "", "");
        assertEquals(3, tracks.size());
        assertEquals("派送中", tracks.get(0).detail);
        assertEquals("新内容", tracks.get(1).detail);
        assertEquals("已揽收", tracks.get(2).detail);
    }

    @Test
    public void incrementalMergeKeepsDifferentRefreshedNodesFromTheSameSecond() {
        String merged = ExpressTimeline.mergeJson(
                "[{\"time\":\"2026-08-15 09:00:00\",\"context\":\"已揽收\"}]",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"到达网点\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\","
                        + "\"context\":\"离开网点\"}]");

        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(merged, "", "");
        assertEquals(3, tracks.size());
        assertEquals("到达网点", tracks.get(0).detail);
        assertEquals("离开网点", tracks.get(1).detail);
        assertEquals("已揽收", tracks.get(2).detail);
    }

    @Test
    public void incrementalMergeReplacesTheWholeCachedBucketForARefreshedSecond() {
        String merged = ExpressTimeline.mergeJson(
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"旧到达内容\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\","
                        + "\"context\":\"旧离开内容\"},"
                        + "{\"time\":\"2026-08-15 09:00:00\",\"context\":\"已揽收\"}]",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"新到达内容\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\","
                        + "\"context\":\"新离开内容\"}]");

        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(merged, "", "");
        assertEquals(3, tracks.size());
        assertEquals("新到达内容", tracks.get(0).detail);
        assertEquals("新离开内容", tracks.get(1).detail);
        assertEquals("已揽收", tracks.get(2).detail);
    }

    @Test
    public void incrementalMergeDeduplicatesTimelessNodesByNormalizedDetail() {
        String merged = ExpressTimeline.mergeJson(
                "[{\"context\":\"等待揽收。\"},{\"context\":\"旧无时间节点\"}]",
                "[{\"context\":\"等待揽收\"},{\"context\":\"新无时间节点\"}]");

        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(merged, "", "");
        assertEquals(3, tracks.size());
        assertEquals("等待揽收", tracks.get(0).detail);
        assertEquals("旧无时间节点", tracks.get(1).detail);
        assertEquals("新无时间节点", tracks.get(2).detail);
    }

    @Test
    public void findsLatestRealEventBehindStateAndProviderPlaceholders() {
        ExpressTimeline.Track track = ExpressTimeline.latestMeaningful(
                "[{\"time\":\"2026-08-15 13:00:00\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-08-15 12:30:00\",\"context\":\"no result\"},"
                        + "{\"time\":\"2026-08-15 12:00:00\","
                        + "\"context\":\"快件到达杭州转运中心\"}]",
                StatusSemantic.TRANSIT);

        assertEquals("2026-08-15 12:00:00", track.time);
        assertEquals("快件到达杭州转运中心", track.detail);
    }
}
