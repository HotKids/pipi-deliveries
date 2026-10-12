package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * JD detail presentation (Pipi 1.4.0 prependOwnerOrderStage; user decision 2026-09-17, parity
 * backlog D-8): the selected fallback packet stays whole and only the owner feed's own nodes older
 * than its earliest timed node follow it.
 */
public class ExpressTimelineOrderStageTest {
    // Fold7 2026-09-03 JT4006839564547: Samsung owner had five nodes, KDNiao one (Pipi's case).
    private static final String OWNER = "[" + node("2026-09-03 17:54:53", "预计9月4日(周五)送达")
            + "," + node("2026-09-03 17:49:51", "【DK测试网点】已取件")
            + "," + node("2026-09-03 17:22:06", "待出库交付极兔速递，运单号为JT4006839564547")
            + "," + node("2026-09-03 14:49:46", "最快9月3日发货")
            + "," + node("2026-09-03 14:49:42", "您的订单已进入第三方卖家仓库，准备出库")
            + ",{\"context\":\"无时间节点\"}]";
    private static final String FALLBACK = "[" + node("2026-09-03 17:48:37", "【DK测试网点】的测试员已取件") + "]";

    @Test public void ownerOrderStageFollowsTheFallbackPacketNewestFirstWithoutInterleaving() throws Exception {
        JSONArray rows = new JSONArray(ExpressTimeline.appendOwnerOrderStage(FALLBACK, OWNER));
        assertEquals(4, rows.length());
        assertEquals("2026-09-03 17:48:37", rows.getJSONObject(0).getString("time"));
        assertEquals("2026-09-03 17:22:06", rows.getJSONObject(1).getString("time"));
        assertEquals("2026-09-03 14:49:46", rows.getJSONObject(2).getString("time"));
        assertEquals("2026-09-03 14:49:42", rows.getJSONObject(3).getString("time"));
        // Forecast wording is display-only and stays in the order stage (user decision 2026-09-04).
        assertEquals("最快9月3日发货", rows.getJSONObject(2).getString("context"));
        // The sheet parses newest-first, so the appended rows land behind the packet's own row.
        assertEquals(4, ExpressTimeline.parse(rows.toString(), "", "").size());
        assertEquals("【DK测试网点】的测试员已取件", ExpressTimeline.parse(rows.toString(), "", "").get(0).detail);
    }

    @Test public void packetWithoutTimedNodesOrOwnerWithoutEarlierNodesStaysUnchanged() {
        String untimed = "[{\"context\":\"无时间\"}]";
        assertSame(untimed, ExpressTimeline.appendOwnerOrderStage(untimed, OWNER));
        assertSame(FALLBACK, ExpressTimeline.appendOwnerOrderStage(FALLBACK,
                "[" + node("2026-09-03 17:49:51", "后来的节点") + "]"));
        assertSame(FALLBACK, ExpressTimeline.appendOwnerOrderStage(FALLBACK, "[]"));
        assertSame(FALLBACK, ExpressTimeline.appendOwnerOrderStage(FALLBACK, ""));
        String earlyPacket = "[" + node("2026-09-03 17:48:37", "运输中") + "," + node("2026-09-03 14:00:00", "已揽收") + "]";
        assertSame(earlyPacket, ExpressTimeline.appendOwnerOrderStage(earlyPacket, OWNER));
    }

    @Test public void onlyTheFeedsOwnRowsDonate() throws Exception {
        String owner = "[" + node("2026-09-03 14:20:00", "联合页嫁接节点", "jingdong_h5")
                + "," + node("2026-09-03 14:10:00", "别的包的节点", "kdniao")
                + "," + node("2026-09-03 14:05:00", "接口 5 自己的节点", "interface5")
                + "," + node("2026-09-03 14:00:00", "无标记节点") + "]";
        JSONArray rows = new JSONArray(ExpressTimeline.appendOwnerOrderStage(FALLBACK, owner));
        assertEquals(3, rows.length());
        assertEquals("接口 5 自己的节点", rows.getJSONObject(1).getString("context"));
        assertEquals("无标记节点", rows.getJSONObject(2).getString("context"));
        assertFalse(rows.toString().contains("联合页嫁接节点"));
        assertFalse(rows.toString().contains("别的包的节点"));
    }

    @Test public void workerStatusWrapperKeepsItsStatusAndGrowsInsideData() throws Exception {
        String wrapped = "{\"data\":" + FALLBACK + ",\"normalizedStatus\":{\"semantic\":\"TRANSIT\"}}";
        JSONObject root = new JSONObject(ExpressTimeline.appendOwnerOrderStage(wrapped, OWNER));
        assertEquals("TRANSIT", root.getJSONObject("normalizedStatus").getString("semantic"));
        assertEquals(4, root.getJSONArray("data").length());
        assertTrue(root.getJSONArray("data").getJSONObject(3).getString("context").contains("第三方卖家仓库"));
        String unknown = "{\"traces\":" + FALLBACK + "}";
        assertSame(unknown, ExpressTimeline.appendOwnerOrderStage(unknown, OWNER));
    }

    private static String node(String time, String context) {
        return "{\"time\":\"" + time + "\",\"context\":\"" + context + "\"}";
    }

    private static String node(String time, String context, String source) {
        return "{\"time\":\"" + time + "\",\"context\":\"" + context + "\",\"_pipiStatusSource\":\"" + source + "\"}";
    }
}
