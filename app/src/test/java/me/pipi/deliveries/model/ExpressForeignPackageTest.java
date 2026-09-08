package me.pipi.deliveries.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** AGENTS §9 / R-29 (2026-09-03): provider packages older than the order's first feed node are foreign. */
public final class ExpressForeignPackageTest {
    @Test public void packagesOlderThanTheAccountFeedAnchorAreForeign() throws Exception {
        String account = new JSONArray()
                .put(new JSONObject().put("time", "2026-09-03 17:49:51").put("context", "已取件"))
                .put(new JSONObject().put("time", "2026-09-03 14:49:35")
                        .put("context", "您提交了订单，请等待第三方卖家系统确认"))
                .toString();
        String foreignEms = new JSONArray()
                .put(new JSONObject().put("time", "2025-11-18 15:03:04")
                        .put("context", "您的快件已代收【物业代收】"))
                .put(new JSONObject().put("time", "2025-11-17 09:00:00").put("context", "快件正在派送中"))
                .toString();
        String genuine = new JSONArray()
                .put(new JSONObject().put("time", "2026-09-03 17:48:37").put("context", "已取件"))
                .put(new JSONObject().put("time", "2026-09-02 20:00:00").put("context", "仓内备货"))
                .toString();

        long anchor = ExpressTimeline.foreignPackageAnchorMillis(account);
        assertTrue(anchor > 0L);
        assertTrue(ExpressTimeline.isForeignPackage(account, foreignEms));
        assertFalse(ExpressTimeline.isForeignPackage(account, genuine));
        assertFalse(ExpressTimeline.isForeignPackage("[]", foreignEms));
        assertFalse(ExpressTimeline.isForeignPackage(
                "[{\"context\":\"无时间\"}]", foreignEms));
        assertEquals(0L, ExpressTimeline.foreignPackageAnchorMillis("not json"));
        assertFalse(ExpressTimeline.isForeignPackage(account, "[]"));

        // 用户 2026-09-08 报（三端同改）：签收之后 feed 往往只剩最新那一条节点，它是终点不是
        // 起点。拿它当锚，这一票自己从揽收开始的历史整包被判成别人的包裹丢掉，列表和详情就成了
        // 「暂无物流动态」。一条带时间的节点是状态摘要，不是历史，不足以当锚。
        String signedSummary = new JSONArray()
                .put(new JSONObject().put("time", "2026-09-06 18:20:00")
                        .put("context", "您的快件已签收"))
                .put(new JSONObject().put("time", "2026-09-06 09:00:00")
                        .put("context", "快件正在派送中"))
                .toString();
        assertEquals(0L, ExpressTimeline.foreignPackageAnchorMillis(signedSummary));
        assertFalse(ExpressTimeline.isForeignPackage(signedSummary, genuine));
        assertFalse(ExpressTimeline.isForeignPackage(signedSummary, foreignEms));
    }
}
