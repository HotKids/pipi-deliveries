package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

import java.util.List;

public final class Kuaidi100TimelinePolicyTest {
    private static final long NOW = 1_800_000_000_000L;

    @Test
    public void activeShipmentRefreshesOnEveryOpen() {
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.TRANSIT, NOW - 7L * 24L * 60L * 60L * 1000L),
                null, NOW));
    }

    @Test
    public void signedShipmentStopsAtTwentyFourHourBoundary() {
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED,
                        NOW - Kuaidi100TimelinePolicy.SIGNED_REFRESH_WINDOW_MS + 1L),
                null, NOW));
        assertFalse(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED,
                        NOW - Kuaidi100TimelinePolicy.SIGNED_REFRESH_WINDOW_MS),
                null, NOW));
    }

    @Test
    public void signedShipmentWithoutReliableTimeStillRefreshes() {
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED, 0L), null, NOW));
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED, NOW + 1L), null, NOW));
    }

    @Test
    public void signedKuaidi100CacheControlsLocalDetailLifetime() {
        ExpressQueryResult cached = result(StatusSemantic.COMPLETED,
                "2026-01-01 00:00:00", "已签收", "[]");
        long afterWindow = ExpressSourcePolicy.parseEventTime(cached.latestTime)
                + Kuaidi100TimelinePolicy.SIGNED_REFRESH_WINDOW_MS;
        assertFalse(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.TRANSIT, 0L), cached, afterWindow));
    }

    @Test
    public void signedTimelineRecoversMissingTopLevelEventTime() {
        String signedTime = "2026-01-01 00:00:00";
        ExpressQueryResult cached = result(StatusSemantic.COMPLETED,
                "", "已签收", "[{\"time\":\"" + signedTime
                        + "\",\"context\":\"快件已签收\"}]");
        long afterWindow = ExpressSourcePolicy.parseEventTime(signedTime)
                + Kuaidi100TimelinePolicy.SIGNED_REFRESH_WINDOW_MS;
        assertFalse(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED, 0L), cached, afterWindow));
    }

    @Test
    public void refreshIsMergedIncrementallyAndRevisesSameTimestamp() {
        ExpressQueryResult cached = result(StatusSemantic.TRANSIT,
                "2026-08-15 10:00:00", "运输中",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-08-15 09:00:00\",\"context\":\"已揽收\"}]");
        ExpressQueryResult refreshed = result(StatusSemantic.DELIVERY,
                "2026-08-15 11:00:00", "派送中",
                "[{\"time\":\"2026-08-15 11:00:00\",\"context\":\"派送中\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\",\"context\":\"到达转运中心\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.tracksJson, merged.latestTime, merged.latestDetail);

        assertEquals(StatusSemantic.DELIVERY, merged.semantic);
        assertEquals(4, tracks.size());
        assertEquals("派送中", tracks.get(0).detail);
        assertEquals("到达转运中心", tracks.get(1).detail);
        assertEquals("运输中", tracks.get(2).detail);
        assertEquals("已揽收", tracks.get(3).detail);
    }

    @Test
    public void refreshKeepsAllProviderScansFromTheSameSecond() {
        ExpressQueryResult cached = result(StatusSemantic.TRANSIT,
                "2026-08-15 10:00:00", "旧节点",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"旧节点\"},"
                        + "{\"time\":\"2026-08-15 09:00:00\",\"context\":\"已揽收\"}]");
        ExpressQueryResult refreshed = result(StatusSemantic.TRANSIT,
                "2026-08-15 10:00:00", "离开网点",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"到达网点\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\","
                        + "\"context\":\"离开网点\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.tracksJson, merged.latestTime, merged.latestDetail);

        assertEquals(4, tracks.size());
        assertEquals("到达网点", tracks.get(0).detail);
        assertEquals("离开网点", tracks.get(1).detail);
        assertEquals("旧节点", tracks.get(2).detail);
        assertEquals("已揽收", tracks.get(3).detail);
    }

    @Test
    public void completedTimedPackageFreezesHeaderButMergesLaterHistory() {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-15 12:00:00");
        long transitAt = ExpressSourcePolicy.parseEventTime("2026-08-15 13:00:00");
        ExpressQueryResult cached = result(
                StatusSemantic.COMPLETED, completedAt,
                "2026-08-15 12:00:00", "已签收",
                "[{\"time\":\"2026-08-15 12:00:00\","
                        + "\"context\":\"快件已签收\",\"statusCode\":\"3\"}]");
        ExpressQueryResult refreshed = result(
                StatusSemantic.TRANSIT, transitAt,
                "2026-08-15 13:00:00", "运输中",
                "[{\"time\":\"2026-08-15 13:00:00\","
                        + "\"context\":\"快件到达转运中心\",\"statusCode\":\"0\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.tracksJson, merged.latestTime, merged.latestDetail);

        assertEquals(StatusSemantic.COMPLETED, merged.semantic);
        assertEquals(completedAt, merged.statusEventTime);
        assertEquals("2026-08-15 12:00:00", merged.latestTime);
        assertEquals("已签收", merged.latestDetail);
        assertEquals(2, tracks.size());
        assertEquals("快件到达转运中心", tracks.get(0).detail);
        assertEquals("快件已签收", tracks.get(1).detail);
    }

    @Test
    public void completedTimedPackageRejectsEmptyCompletedRefresh() {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-15 12:00:00");
        ExpressQueryResult cached = result(
                StatusSemantic.COMPLETED, completedAt,
                "2026-08-15 12:00:00", "由本人签收",
                "[{\"time\":\"2026-08-15 12:00:00\","
                        + "\"context\":\"由本人签收\",\"statusCode\":\"3\"}]");
        ExpressQueryResult refreshed = result(
                StatusSemantic.COMPLETED, completedAt + 60_000L,
                "2026-08-15 12:01:00", "已签收", "[]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);

        assertEquals(completedAt, merged.statusEventTime);
        assertEquals("2026-08-15 12:00:00", merged.latestTime);
        assertEquals("由本人签收", merged.latestDetail);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.tracksJson, merged.latestTime, merged.latestDetail);
        assertEquals(1, tracks.size());
        assertEquals("由本人签收", tracks.get(0).detail);
    }

    @Test
    public void completedTimedPackageMergesOnlyValidCompletedHistory() {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-15 12:00:00");
        ExpressQueryResult cached = result(
                StatusSemantic.COMPLETED, completedAt,
                "2026-08-15 12:00:00", "由本人签收",
                "[{\"time\":\"2026-08-15 12:00:00\","
                        + "\"context\":\"由本人签收\",\"statusCode\":\"3\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\","
                        + "\"context\":\"派送中\",\"statusCode\":\"5\"}]");
        ExpressQueryResult refreshed = result(
                StatusSemantic.COMPLETED, completedAt + 60_000L,
                "2026-08-15 11:00:00", "已签收",
                "[{\"time\":\"2026-08-15 11:00:00\","
                        + "\"context\":\"放入丰巢柜\",\"statusCode\":\"501\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.tracksJson, merged.latestTime, merged.latestDetail);

        assertEquals(StatusSemantic.COMPLETED, merged.semantic);
        assertEquals(completedAt, merged.statusEventTime);
        assertEquals("2026-08-15 12:00:00", merged.latestTime);
        assertEquals("由本人签收", merged.latestDetail);
        assertEquals(3, tracks.size());
        assertEquals("由本人签收", tracks.get(0).detail);
        assertEquals("放入丰巢柜", tracks.get(1).detail);
        assertEquals("派送中", tracks.get(2).detail);
    }

    @Test
    public void orderCompletionTextDoesNotCreateALogisticsCompletionPackage() {
        ExpressQueryResult order = result(
                StatusSemantic.ORDERED,
                ExpressSourcePolicy.parseEventTime("2026-08-15 12:00:00"),
                "2026-08-15 12:00:00", "订单已完成",
                "[{\"time\":\"2026-08-15 12:00:00\","
                        + "\"context\":\"订单已完成\"}]");

        assertFalse(Kuaidi100TimelinePolicy.isCompletedTimedPackage(order));
    }

    @Test
    public void pendingManualItemNeedsARealTrackingNode() {
        assertFalse(Kuaidi100TimelinePolicy.hasRealTracking(result(
                StatusSemantic.UNKNOWN, "", "", "[]")));
        assertFalse(Kuaidi100TimelinePolicy.hasRealTracking(result(
                StatusSemantic.UNKNOWN, "", "暂无物流信息",
                "[{\"time\":\"\",\"context\":\"暂无物流信息\"}]")));
        assertTrue(Kuaidi100TimelinePolicy.hasRealTracking(result(
                StatusSemantic.PICKED, "2026-08-16 12:00:00", "快件已揽收",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"快件已揽收\"}]")));
    }

    @Test
    public void persistedManualAuthorityNeedsAParseableTimedNode() {
        assertFalse(Kuaidi100TimelinePolicy.hasTimedTracking(result(
                StatusSemantic.PICKED, "", "快件已揽收",
                "[{\"context\":\"快件已揽收\"}]")));
        assertFalse(Kuaidi100TimelinePolicy.hasTimedTracking(result(
                StatusSemantic.PICKED, "not-a-time", "快件已揽收",
                "[{\"time\":\"not-a-time\",\"context\":\"快件已揽收\"}]")));
        assertTrue(Kuaidi100TimelinePolicy.hasTimedTracking(result(
                StatusSemantic.TRANSIT, "2026-08-16 12:00:00", "运输中",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"运输中\"}]")));
        assertTrue(Kuaidi100TimelinePolicy.hasTimedTracking(result(
                StatusSemantic.PICKED, "2026-08-16 12:00:00", "快件已揽收",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"快件已揽收\"}]")));
    }

    private static ExpressItem item(StatusSemantic semantic, long eventTime) {
        return new ExpressItem(1L, "", "TEST123", "ZTO", "中通快递",
                semantic, semantic.label, "", "", "[]", "", "INTERFACE5", "",
                eventTime, eventTime, "INTERFACE5", "");
    }

    private static ExpressQueryResult result(
            StatusSemantic semantic, String time, String detail, String tracks) {
        return new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", semantic, time, detail, tracks);
    }

    private static ExpressQueryResult result(
            StatusSemantic semantic, long statusEventTime,
            String time, String detail, String tracks) {
        return new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", semantic, statusEventTime,
                time, detail, tracks, "", "", "kuaidi100", "", "", "");
    }
}
