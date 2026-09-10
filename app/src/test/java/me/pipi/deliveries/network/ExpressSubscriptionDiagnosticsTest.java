package me.pipi.deliveries.network;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Context;
import java.nio.charset.StandardCharsets;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowLog;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = ExpressSubscriptionDiagnosticsTest.SyntheticGateway.class)
public class ExpressSubscriptionDiagnosticsTest {
    private static HttpClient.Response response;
    private static JSONObject request;
    private static int requestCount;

    @Implements(ExpressGatewayClient.class)
    public static class SyntheticGateway {
        @Implementation protected void __constructor__(Context context) { }
        @Implementation protected HttpClient.Response post(String path, JSONObject payload,
                ExpressQueryCancellation cancellation) {
            assertEquals("/api/express/timeline/source", path);
            request = payload;
            requestCount++;
            return response;
        }
    }

    @Before public void clearLogs() { ShadowLog.clear(); requestCount = 0; }

    @Test public void automaticSourceLabelsAreOnlyFormattedAtTheLogBoundary() {
        String[][] cases = {{"CaiNiao", "cainiao"}, {"JingDong", "jingdong"},
                {"ShunFeng", "sfexpress"}, {"DouYin", "douyin"}};
        for (String[] entry : cases) {
            ShadowLog.clear();
            ExpressLog.line("v5", "v5_query", entry[0], "selected", "nodes", 1);
            String message = ShadowLog.getLogsForTag(ExpressLog.TAG).get(0).msg;
            assertEquals("interface=v5 level=v5_query source=" + entry[1]
                    + " event=selected nodes=1", message);
            assertEquals(entry[1], ExpressLog.source(entry[0], false));
            assertEquals("manual", ExpressLog.source(entry[0], true));
        }
        assertEquals("sfexpress", ExpressLog.source("sfexpress", false));
        assertEquals("", ExpressLog.source(null, false));
        assertEquals("existing-provider", ExpressLog.source("existing-provider", false));
    }

    @Test public void notificationAndRetentionLogsFormatSfWithoutChangingRawProvider() {
        ExpressItem item = new ExpressItem(
                1L, "", "SFSYNTHETIC4271", "SF", "SF", StatusSemantic.TRANSIT,
                "运输中", "Synthetic event", "2026-09-09 18:51:23", "[]", "", "INTERFACE5", "",
                1L, 2L, "INTERFACE5", "", "", "", true, "", "", "", "ShunFeng");
        ExpressQueryResult result = new ExpressQueryResult(
                "SFSYNTHETIC4271", "SF", "SF", StatusSemantic.TRANSIT,
                "2026-09-09 18:51:23", "Synthetic event", "[]", "", "", "", "", "", "ShunFeng");
        ExpressLog.notificationSkipped(item, "synthetic");
        ExpressLog.notificationDecided(item, item, false);
        ExpressLog.retentionRejected(result, "synthetic");
        assertEquals(3, ShadowLog.getLogsForTag(ExpressLog.TAG).size());
        for (org.robolectric.shadows.ShadowLog.LogItem entry : ShadowLog.getLogsForTag(ExpressLog.TAG)) {
            java.util.regex.Matcher source = java.util.regex.Pattern
                    .compile("source=(\\S+)").matcher(entry.msg);
            assertTrue(source.find());
            assertEquals("sfexpress", source.group(1));
        }
        assertEquals("ShunFeng", item.sourceProvider);
        assertEquals("ShunFeng", result.sourceProvider);
        assertTrue(item.isShunFengSource());
    }

    @Test public void rejectedManualResponseLogsOnlyBoundedMetadata() throws Exception {
        run(200, "{\"code\":503,\"value\":{\"secret\":\"withheld\"},"
                + "\"msg\":\"withheld-message\",\"redirect\":\"https://withheld.invalid\"}");
        String log = responseLog();
        assertTrue(log.contains("level=v6_query"));
        assertTrue(log.contains("mode=refresh"));
        assertTrue(log.contains("httpStatus=200"));
        assertTrue(log.contains("upstreamCode=503"));
        assertTrue(log.contains("valueKind=object"));
        assertTrue(log.contains("redirectPresent=true"));
        assertTrue(log.contains("tail=4271"));
        assertTrue(log.matches(".*durationMs=[0-9]+.*"));
        assertFalse(log.contains("withheld"));
        assertFalse(log.contains("SFSYNTHETIC"));
        assertEquals("refresh", request.getString("mode"));
        assertFalse(request.has("companyCode"));
    }

    @Test public void httpFailureAndNonIntegerCodeRemainDiagnosable() throws Exception {
        run(429, "{\"code\":\"withheld-code\",\"value\":null,\"redirect\":false}");
        String log = responseLog();
        assertTrue(log.contains("level=v6_query"));
        assertTrue(log.contains("mode=refresh"));
        assertTrue(log.contains("httpStatus=429"));
        assertTrue(log.contains("upstreamCode=unavailable"));
        assertTrue(log.contains("valueKind=null"));
        assertTrue(log.contains("redirectPresent=false"));
        assertFalse(log.contains("withheld"));
        assertEquals("refresh", request.getString("mode"));
        assertFalse(request.has("companyCode"));
    }

    @Test public void absentFractionalAndOversizedCodesNeverLeakRawValues() throws Exception {
        for (String body : new String[]{"not-json", "{\"code\":1.5,\"data\":[]}",
                "{\"code\":1e100,\"data\":\"withheld-value\"}"}) {
            ShadowLog.clear();
            run(200, body);
            String log = responseLog();
            assertTrue(log.contains("upstreamCode=unavailable"));
            assertFalse(log.contains("withheld"));
            assertFalse(log.contains("not-json"));
        }
    }

    @Test public void parserRejectionsIdentifyTheExistingBranchWithoutPayloadValues() throws Exception {
        String[][] cases = {
                {"{\"mailNo\":\"OTHERWITHHELD\",\"cpCode\":\"SF\"}", "identity_mismatch"},
                {"{\"secret\":\"withheld-object\"}", "object_missing"},
                {"{\"mailNo\":\"SFSYNTHETIC4271\",\"cpCode\":\"SF\","
                        + "\"message\":\"查无结果\"}", "provider_error_empty"}
        };
        for (String[] entry : cases) {
            ShadowLog.clear();
            run(200, "{\"code\":200,\"value\":" + entry[0] + "}");
            String log = ShadowLog.getLogsForTag(ExpressLog.TAG).stream()
                    .map(item -> item.msg).filter(item -> item.contains("parseOutcome="))
                    .findFirst().orElse("");
            assertTrue(log, log.contains("parseOutcome=" + entry[1]));
            assertTrue(log.contains("level=v6_query"));
            assertTrue(log.contains("mode=refresh"));
            assertTrue(log.contains("tail=4271"));
            assertTrue(log.contains("nodes=0"));
            assertFalse(log.contains("withheld"));
            assertFalse(log.contains("WITHHELD"));
            assertFalse(log.contains("SFSYNTHETIC"));
            assertFalse(log.contains("查无结果"));
        }
    }

    @Test public void onlineUsesOneRequestAndKeepsScalarHistoryPartial()
            throws Exception {
        ShadowLog.clear();
        response = new HttpClient.Response(200, ("{\"code\":200,\"value\":{"
                + "\"mailNo\":\"SFSYNTHETIC4271\",\"cpCode\":\"SF\",\"cpName\":\"SF\","
                + "\"logsiticsStatus\":\"2\",\"logisticsStatusDesc\":\"运输中\","
                + "\"logisticsGmtModified\":\"2026-09-09 18:51:23\","
                + "\"lastLogisticDetail\":\"Synthetic latest event\"}}")
                .getBytes(StandardCharsets.UTF_8));
        ExpressSubscriptionClient client = new ExpressSubscriptionClient();
        ManualQueryCoordinator.Batch batch = ManualQueryCoordinator.queryPickerFirst(
                () -> client.queryManual(RuntimeEnvironment.getApplication(), "SFSYNTHETIC4271", null),
                null, null, false);
        assertEquals("v6", request.getString("interface"));
        assertEquals("refresh", request.getString("mode"));
        assertEquals(1, requestCount);
        assertEquals("SFSYNTHETIC4271", request.getString("waybill"));
        assertFalse(request.has("companyCode"));
        assertEquals(1, batch.successes.size());
        ManualQueryCoordinator.Success success = batch.successes.get(0);
        assertEquals(TimelineSlot.V6_QUERY, success.provider);
        assertFalse(success.complete);
        assertEquals(1, Kuaidi100TimelinePolicy.timedTrackCount(success.result));
        assertEquals("2026-09-09 18:51:23", success.result.latestTime);
        assertEquals(StatusSemantic.TRANSIT, success.result.semantic);
        assertTrue(success.result.structuredStatusEvidence);
        String log = responseLog();
        assertTrue(log, log.contains("level=v6_query"));
        assertFalse(log.contains("SFSYNTHETIC"));
    }

    private static void run(int status, String body) throws Exception {
        response = new HttpClient.Response(status, body.getBytes(StandardCharsets.UTF_8));
        ExpressSubscriptionClient client = new ExpressSubscriptionClient();
        try {
            client.queryManual(RuntimeEnvironment.getApplication(), "SFSYNTHETIC4271", null);
            fail("Synthetic response must remain rejected");
        } catch (IllegalStateException expected) { }
    }

    private static String responseLog() {
        return ShadowLog.getLogsForTag(ExpressLog.TAG).stream()
                .filter(entry -> entry.msg.contains("event=response"))
                .map(entry -> entry.msg).findFirst().orElse("");
    }
}
