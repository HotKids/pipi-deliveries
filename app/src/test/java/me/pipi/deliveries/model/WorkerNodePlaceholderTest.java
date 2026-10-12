package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.List;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * 用户定 2026-10-01（「两边都改」）三端同一读法：节点上 structured=false、code 为空的 Worker 投影只是说
 * 「这个节点没有枚举」，不算节点的状态，节点自己的原始枚举照旧作数；Worker 认出字段却不认识取值（code
 * 非空）时仍是权威的 UNKNOWN。Lite 现有的接口 5 / 6 节点下面没有被它挡住的原始枚举，这里只锁住读法。
 */
public final class WorkerNodePlaceholderTest {
    @Test
    public void aNoEnumPlaceholderIsAbsent() throws Exception {
        JSONObject node = node("1", placeholder());
        assertNotNull(WorkerStatusProjection.read(node));
        assertNull(WorkerStatusProjection.nodeEvidence(node));
        JSONObject explicit = node("1", placeholder().put("code", "FUTURE_WIRE_ENUM"));
        assertNotNull(WorkerStatusProjection.nodeEvidence(explicit));
    }

    @Test
    public void theStartGateReadsTheNodesOwnEnumUnderAPlaceholder() throws Exception {
        JSONArray tracks = new JSONArray().put(node("1", placeholder()));
        assertTrue(Kuaidi100TimelinePolicy.containsTimelineStart(tracks, "k100_h5", false));
        JSONArray explicit = new JSONArray().put(node("1",
                placeholder().put("code", "FUTURE_WIRE_ENUM")));
        assertFalse(Kuaidi100TimelinePolicy.containsTimelineStart(explicit, "k100_h5", false));
    }

    @Test
    public void theLatestStatusesReadTheNodesOwnEnumUnderAPlaceholder() throws Exception {
        String tracks = new JSONArray().put(node("3", placeholder())).toString();
        assertEquals(List.of(StatusSemantic.COMPLETED),
                ExpressTimeline.latestTrackStatuses(tracks, "k100_h5"));
        String explicit = new JSONArray().put(node("3",
                placeholder().put("code", "FUTURE_WIRE_ENUM"))).toString();
        assertEquals(List.of(StatusSemantic.UNKNOWN),
                ExpressTimeline.latestTrackStatuses(explicit, "k100_h5"));
    }

    private static JSONObject placeholder() throws Exception {
        return new JSONObject().put("version", 1).put("scope", "SHIPMENT")
                .put("semantic", "UNKNOWN").put("code", "").put("text", "暂无状态")
                .put("priority", 0).put("eventAtMs", 0L).put("structured", false);
    }

    /** A node whose text names no start or status, so only its own enum can decide. */
    private static JSONObject node(String statusCode, JSONObject projection) throws Exception {
        return new JSONObject().put("time", "2026-09-30 10:00:00")
                .put("context", "快件离开【测试转运中心】")
                .put("statusCode", statusCode)
                .put("normalizedStatus", projection);
    }
}
