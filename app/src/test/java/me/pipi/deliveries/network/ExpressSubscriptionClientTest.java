package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressQueryResult;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class ExpressSubscriptionClientTest {
    @Test
    public void manualResponseDerivesHeadlineFromTimelineArray() throws Exception {
        JSONObject result = new JSONObject()
                .put("nu", "TEST123456")
                .put("com", "ZTO")
                .put("name", "中通快递")
                .put("status", "3")
                .put("data", new JSONArray()
                        .put(new JSONObject()
                                .put("time", "2026-08-22 09:00:00")
                                .put("context", "快件已揽收"))
                        .put(new JSONObject()
                                .put("time", "2026-08-22 10:00:00")
                                .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "TEST123456");

        assertEquals("2026-08-22 10:00:00", parsed.latestTime);
        assertEquals("快件运输中", parsed.latestDetail);
        assertTrue(Kuaidi100TimelinePolicy.hasRealTracking(parsed));
    }

    @Test
    public void accountMetadataNeverBecomesALocalTimeline() throws Exception {
        JSONObject account = new JSONObject()
                .put("mailNo", "TEST654321")
                .put("cpCode", "ZTO")
                .put("cpName", "中通快递")
                .put("logsiticsStatus", "TRANSPORT")
                .put("logisticsStatusDesc", "运输中")
                .put("lastLogisticDetail", "快件运输中")
                .put("logisticsGmtModified", "2026-08-24 09:00:00")
                .put("packageDyn", new JSONObject()
                        .put("secretKey", "must-not-be-a-track")
                        .put("estimate", "今天送达"));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseExpress(
                account, "", "");

        assertEquals("[]", parsed.tracksJson);
        assertEquals(false, Kuaidi100TimelinePolicy.hasRealTracking(parsed));
    }
}
