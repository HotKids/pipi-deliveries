package me.pipi.deliveries.data;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * 用户定 2026-10-02「三端统一改成结构化优先」（Pipi 2026-10-01「结构化优先」）：起点 / 揽收闸门里，节点有真实
 * 结构化状态时由状态定；揽收、下单、终点文案只认没有结构化状态的节点。占位投影（structured=false、code 为空）
 * 不算结构化状态。起点词表本身不变。夹具是合成数据，形状照 Pixel 尾号 7407 那一类：配了 TRANSPORT 的
 * 「您的快件已揽收完成」。
 */
public final class StructuredStartFirstTest {
    private static final String PROVIDER = "k100_h5";

    @Test
    public void aTransportNodeSayingPickedUpIsNoStart() throws Exception {
        JSONArray tracks = new JSONArray()
                .put(node("您的快件已揽收完成", "TRANSPORT", "运输中", placeholder()));
        assertFalse(Kuaidi100TimelinePolicy.containsTimelineStart(tracks, PROVIDER, false));
        assertFalse(Kuaidi100TimelinePolicy.containsTimelineStart(tracks, PROVIDER, true));
        assertFalse(Kuaidi100TimelinePolicy.containsTimelineOrigin(tracks, PROVIDER));
    }

    @Test
    public void orderAndCompletionWordsOnAStructuredNodeAreNoStartEither() throws Exception {
        JSONArray ordered = new JSONArray()
                .put(node("您提交了订单，请等待第三方卖家系统确认", "TRANSPORT", "运输中", null));
        assertFalse(Kuaidi100TimelinePolicy.containsTimelineStart(ordered, PROVIDER, true));
        JSONArray completed = new JSONArray()
                .put(node("订单已完成配送，感谢您选择京东购物", "TRANSPORT", "运输中", null));
        assertFalse(Kuaidi100TimelinePolicy.containsTimelineStart(completed, PROVIDER, true));
    }

    @Test
    public void textOnlyNodesStillCount() throws Exception {
        assertTrue(Kuaidi100TimelinePolicy.containsTimelineStart(new JSONArray()
                .put(node("您的快件已揽收完成", null, null, null)), PROVIDER, false));
        // A no-enum placeholder is no structured status: the words still decide.
        assertTrue(Kuaidi100TimelinePolicy.containsTimelineStart(new JSONArray()
                .put(node("您的快件已揽收完成", null, null, placeholder())), PROVIDER, false));
        assertTrue(Kuaidi100TimelinePolicy.containsTimelineStart(new JSONArray()
                .put(node("您提交了订单，请等待第三方卖家系统确认", null, null, null)),
                PROVIDER, true));
        assertTrue(Kuaidi100TimelinePolicy.containsTimelineStart(new JSONArray()
                .put(node("订单已完成配送，感谢您选择京东购物", null, null, null)), PROVIDER, true));
    }

    @Test
    public void aStructuredPickupStillCounts() throws Exception {
        assertTrue(Kuaidi100TimelinePolicy.containsTimelineStart(new JSONArray()
                .put(node("快件离开【测试转运中心】", "ACCEPT", "已揽件", null)), PROVIDER, false));
        JSONObject projected = node("快件离开【测试转运中心】", null, null,
                new JSONObject().put("version", 1).put("scope", "SHIPMENT")
                        .put("semantic", "PICKED").put("code", "ACCEPT").put("text", "已揽件")
                        .put("priority", 0).put("eventAtMs", 1_790_000_000_000L)
                        .put("structured", true));
        assertTrue(Kuaidi100TimelinePolicy.containsTimelineStart(
                new JSONArray().put(projected), PROVIDER, false));
    }

    private static JSONObject placeholder() throws Exception {
        return new JSONObject().put("version", 1).put("scope", "SHIPMENT")
                .put("semantic", "UNKNOWN").put("code", "").put("text", "暂无状态")
                .put("priority", 0).put("eventAtMs", 0L).put("structured", false);
    }

    private static JSONObject node(String context, String raw, String description,
            JSONObject projection) throws Exception {
        JSONObject node = new JSONObject().put("time", "2026-09-27 08:00:52").put("context", context);
        if (raw != null) node.put("logisticsStatus", raw);
        if (description != null) node.put("logisticsStatusDesc", description);
        if (projection != null) node.put("normalizedStatus", projection);
        return node;
    }
}
