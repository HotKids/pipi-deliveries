package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;

import org.json.JSONArray;
import org.json.JSONObject;
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
        assertEquals(4, tracks.size());
        assertEquals("派送中", tracks.get(0).detail);
        assertEquals("新内容", tracks.get(1).detail);
        assertEquals("旧内容", tracks.get(2).detail);
        assertEquals("已揽收", tracks.get(3).detail);
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
    public void incrementalMergeKeepsDistinctProviderEventsFromARefreshedSecond() {
        String merged = ExpressTimeline.mergeJson(
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"旧到达内容\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\","
                        + "\"context\":\"旧离开内容\"},"
                        + "{\"time\":\"2026-08-15 09:00:00\",\"context\":\"已揽收\"}]",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"新到达内容\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\","
                        + "\"context\":\"新离开内容\"}]");

        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(merged, "", "");
        assertEquals(5, tracks.size());
        assertEquals("新到达内容", tracks.get(0).detail);
        assertEquals("新离开内容", tracks.get(1).detail);
        assertEquals("旧到达内容", tracks.get(2).detail);
        assertEquals("旧离开内容", tracks.get(3).detail);
        assertEquals("已揽收", tracks.get(4).detail);
    }

    @Test
    public void incrementalMergeDeduplicatesTimelessNodesByNormalizedDetail() {
        String merged = ExpressTimeline.mergeJson(
                "[{\"context\":\"等待揽收。\"},{\"context\":\"旧无时间节点\"}]",
                "[{\"context\":\"等待揽收\"},{\"context\":\"新无时间节点\"}]");

        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(merged, "", "");
        assertEquals(3, tracks.size());
        assertEquals("等待揽收", tracks.get(0).detail);
        assertEquals("新无时间节点", tracks.get(1).detail);
        assertEquals("旧无时间节点", tracks.get(2).detail);
    }

    @Test
    public void incrementalMergePreservesProviderStatusMetadata() throws Exception {
        String merged = ExpressTimeline.mergeJson(
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"快件已到合作点\",\"status\":\"投柜\","
                        + "\"statusCode\":501,\"_pipiStatusSource\":\"kuaidi100\"}]",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"快件已到合作点\"}]");

        JSONArray rows = new JSONArray(merged);
        assertEquals(1, rows.length());
        JSONObject row = rows.getJSONObject(0);
        assertEquals(501, row.getInt("statusCode"));
        assertEquals("投柜", row.getString("status"));
        assertEquals("kuaidi100", row.getString("_pipiStatusSource"));
    }

    @Test
    public void incrementalMergeBoundsHistoryAndRetainsEarliestStartBoundary() throws Exception {
        JSONArray cached = new JSONArray();
        for (int index = 0; index < 170; index++) {
            cached.put(new JSONObject()
                    .put("time", String.format("2026-08-%02d %02d:%02d:00",
                            31 - (index / 24), index % 24, index % 60))
                    .put("context", index == 169 ? "快件已下单" : "运输节点 " + index));
        }

        JSONArray merged = new JSONArray(ExpressTimeline.mergeJson(
                cached.toString(),
                "[{\"time\":\"2026-09-01 12:00:00\",\"context\":\"快件已签收\"}]"));

        assertEquals(156, merged.length());
        boolean hasOrdered = false;
        boolean hasDelivered = false;
        for (int index = 0; index < merged.length(); index++) {
            String detail = merged.getJSONObject(index).optString("context");
            hasOrdered |= detail.contains("已下单");
            hasDelivered |= detail.contains("已签收");
        }
        assertEquals(true, hasOrdered);
        assertEquals(true, hasDelivered);
    }

    @Test
    public void compactionUsesProviderAwareStructuredStartEvidence() throws Exception {
        JSONArray cached = new JSONArray();
        for (int index = 0; index < 170; index++) {
            JSONObject value = new JSONObject()
                    .put("time", String.format("2026-08-%02d %02d:%02d:00",
                            31 - (index / 24), index % 24, index % 60))
                    .put("context", "运输节点 " + index);
            if (index == 169) {
                value.put("statusCode", 102)
                        .put("_pipiStatusSource", "meizu");
            }
            cached.put(value);
        }

        JSONArray merged = new JSONArray(ExpressTimeline.mergeJson(
                cached.toString(), "[]"));

        assertEquals(156, merged.length());
        boolean hasPickerOrdered = false;
        for (int index = 0; index < merged.length(); index++) {
            JSONObject value = merged.getJSONObject(index);
            hasPickerOrdered |= value.optInt("statusCode") == 102
                    && "meizu".equals(value.optString("_pipiStatusSource"));
        }
        assertEquals(true, hasPickerOrdered);
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

    @Test
    public void providerErrorsAreRemovedFromLegacyReadsAndIncrementalMerges() {
        String cached = "[{\"time\":\"2026-09-02 10:45:00\","
                + "\"context\":\"验证码错误，请重试\"}]";
        String valid = "[{\"time\":\"2026-09-02 10:46:00\","
                + "\"context\":\"快件运输中\"}]";

        assertEquals(0, ExpressTimeline.parse(cached, "", "").size());
        String merged = ExpressTimeline.mergeJson(cached, valid);
        assertEquals(1, ExpressTimeline.parse(merged, "", "").size());
        assertEquals(false, merged.contains("验证码错误"));
    }
}
