package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

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
                .put("detailUrl", "https://m.kuaidi100.com/result.jsp?nu=TEST123456")
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
        assertEquals("meizu", parsed.timelineProvider);
        assertEquals("https://m.kuaidi100.com/result.jsp?nu=TEST123456",
                parsed.detailUrl);
        assertTrue(Kuaidi100TimelinePolicy.hasRealTracking(parsed));
        assertTrue(Kuaidi100TimelinePolicy.hasTimedTracking(parsed));
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

    @Test
    public void jdPrefixNormalizesDisplayWithoutRewritingMeizuCpCode() throws Exception {
        JSONObject result = new JSONObject()
                .put("nu", "JDTEST123456")
                .put("cpCode", "JDVD")
                .put("status", "2")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-01 12:00:00")
                        .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JDTEST123456");

        assertEquals("JDVD", parsed.courierCode);
        assertEquals("京东快递", parsed.companyName);
    }

    @Test(expected = IllegalStateException.class)
    public void meizuProviderErrorCannotBecomeABestEffortPreview() throws Exception {
        JSONObject result = new JSONObject()
                .put("mailNo", "JDTEST654321")
                .put("cpCode", "JD")
                .put("time", "2026-09-02 10:45:00")
                .put("message", "验证码错误，请重试");

        ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JDTEST654321");
    }

    @Test
    public void meizuMixedResponseKeepsRealSiblingAndDropsProviderError() throws Exception {
        JSONObject result = new JSONObject()
                .put("mailNo", "JDTEST777777")
                .put("cpCode", "JD")
                .put("data", new JSONArray()
                        .put(new JSONObject()
                                .put("time", "2026-09-02 10:45:00")
                                .put("message", "验证码错误，请重试"))
                        .put(new JSONObject()
                                .put("time", "2026-09-02 10:46:00")
                                .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JDTEST777777");

        assertEquals(1, new JSONArray(parsed.tracksJson).length());
        assertEquals("快件运输中", parsed.latestDetail);
        assertEquals(false, parsed.tracksJson.contains("验证码错误"));
    }

    @Test
    public void meizuRootErrorStatusCannotOwnARealSibling() throws Exception {
        JSONObject result = new JSONObject()
                .put("mailNo", "JDTEST888888")
                .put("cpCode", "JD")
                .put("time", "2026-09-02 10:45:00")
                .put("message", "验证码错误，请重试")
                .put("status", "SIGN")
                .put("stateName", "已签收")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-02 10:46:00")
                        .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JDTEST888888");

        assertEquals(StatusSemantic.UNKNOWN, parsed.semantic);
        assertEquals(false, parsed.structuredStatusEvidence);
        assertEquals("快件运输中", parsed.latestDetail);
        assertEquals(1, new JSONArray(parsed.tracksJson).length());
    }

    @Test(expected = IllegalStateException.class)
    public void meizuResponseCannotReturnAnotherWaybill() throws Exception {
        JSONObject result = new JSONObject()
                .put("mailNo", "JD-OTHER-654321")
                .put("cpCode", "JD")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-02 11:00:00")
                        .put("context", "快件运输中")));

        ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JD-EXPECTED-123456");
    }

    @Test
    public void meizuResponseAcceptsEquivalentNormalizedWaybill() throws Exception {
        JSONObject result = new JSONObject()
                .put("mailNo", "jd expected-123456")
                .put("cpCode", "JD")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-02 11:00:00")
                        .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JD-EXPECTED-123456");

        assertEquals("jd expected-123456", parsed.waybill);
    }

    @Test
    public void meizuResponseWithoutIdentityUsesRequestedWaybill() throws Exception {
        JSONObject result = new JSONObject()
                .put("cpCode", "JD")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-02 11:00:00")
                        .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JD-EXPECTED-123456");

        assertEquals("JD-EXPECTED-123456", parsed.waybill);
    }

    @Test(expected = IllegalStateException.class)
    public void meizuNestedResponseCannotDeclareAnotherWaybill() throws Exception {
        JSONObject result = new JSONObject()
                .put("cpCode", "JD")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("mailNo", "JD-OTHER-654321")
                        .put("time", "2026-09-02 11:00:00")
                        .put("context", "不应采用的轨迹")));

        ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JD-EXPECTED-123456");
    }
}
