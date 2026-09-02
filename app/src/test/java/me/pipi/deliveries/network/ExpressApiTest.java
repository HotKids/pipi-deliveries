package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.ArrayList;
import java.util.List;
import java.text.SimpleDateFormat;
import java.util.Locale;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

public final class ExpressApiTest {
    @Test
    public void phoneCandidatesBecomeUniqueFourDigitTailsInOrder() {
        assertEquals(
                Arrays.asList("8098", "8000"),
                ExpressApi.phoneTails(Arrays.asList(
                        "13900008098", "****8098", "13800138000", "123")));
    }

    @Test
    public void missingPhoneDoesNotCreatePartialTail() {
        assertEquals(Collections.emptyList(),
                ExpressApi.phoneTails(Arrays.asList("", "86", "***")));
    }

    @Test
    public void v4PublicResponseKeepsTheWholeProviderTimeline() throws Exception {
        JSONObject root = new JSONObject().put("status", 0).put("data", new JSONObject()
                .put("cpCode", "ZTO")
                .put("logisticsStatus", "TRANSPORT")
                .put("logisticsStatusDesc", "运输中")
                .put("fullTraceDetail", new JSONArray()
                        .put(new JSONObject().put("time", "2026-08-17 09:00:00")
                                .put("desc", "快件已揽收"))
                        .put(new JSONObject().put("time", "2026-08-17 10:00:00")
                                .put("desc", "快件运输中"))));

        ExpressQueryResult result = ExpressApi.parseV4("TEST123456", "ZTO", root);

        assertEquals("v4", result.timelineProvider);
        assertEquals("ZTO", result.courierCode);
        assertEquals(StatusSemantic.TRANSIT, result.semantic);
        assertTrue(result.structuredStatusEvidence);
        assertEquals("运输中", result.statusDescription);
        assertEquals("快件运输中", result.latestDetail);
        assertEquals(2, new JSONArray(result.tracksJson).length());
    }

    @Test
    public void v4JdPrefixKeepsTheRawCpCodeAndProjectsOnlyTheDisplaySidecar()
            throws Exception {
        JSONObject root = new JSONObject().put("status", 0).put("data", new JSONObject()
                .put("cpCode", "JDVD")
                .put("cpName", "上游原始名称")
                .put("logisticsStatus", "TRANSPORT")
                .put("fullTraceDetail", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-01 12:00:00")
                        .put("desc", "京东快件运输中"))));

        ExpressQueryResult result = ExpressApi.parseV4("TESTJD123456", "JDVD", root);

        assertEquals("JDVD", result.courierCode);
        assertEquals("京东快递", result.companyName);
        assertEquals("JD", result.carrierNormalization.standardCode);
        assertEquals("京东快递", result.carrierNormalization.displayName);
    }

    @Test
    public void v4PublicTimelineExcludesSfExactlyLikePipi() {
        assertTrue(ExpressApi.supportsV4(CarrierRegistry.resolve("ZTO")));
        org.junit.Assert.assertFalse(
                ExpressApi.supportsV4(CarrierRegistry.resolve("SF")));
    }

    @Test
    public void secondLevelCarrierRecognitionRemainsPresentationOnly()
            throws Exception {
        List<String> timelinePaths = new ArrayList<>();
        ExpressGatewayTransport transport = new ExpressGatewayTransport() {
            @Override public boolean configured() { return true; }

            @Override public HttpClient.Response post(String path, JSONObject payload)
                    throws Exception {
                if ("/api/express/classify".equals(path)) {
                    assertTrue(payload.optBoolean("firstStageCompleted"));
                    assertEquals(2, payload.length());
                    return response(new JSONObject().put("auto", new JSONArray()
                            .put(new JSONObject().put("comCode", "SF")
                                    .put("name", "顺丰速运"))));
                }
                timelinePaths.add(path);
                return response(new JSONObject());
            }
        };
        ExpressApi api = new ExpressApi(transport, detector("UNLISTED"));

        assertEquals("shunfeng", api.detect("TEST123456"));
        try {
            api.queryMoto("TEST123456", "", null);
            org.junit.Assert.fail("Display recognition must not become a timeline parameter");
        } catch (ExpressApi.QueryException expected) {
            assertEquals("公开物流查询暂无轨迹", expected.getMessage());
        }
        assertTrue(timelinePaths.isEmpty());
    }

    @Test
    public void kuaidi100SummaryCompletionOverridesLatest501WithoutMutatingProviderNode()
            throws Exception {
        String time = "2026-08-24 12:34:56";
        String detail = "快件已到合作点，请及时领取";
        ExpressQueryResult result = ExpressApi.parse(
                "SFTEST501", "shunfeng",
                new JSONObject().put("state", "3").put("data", new JSONArray()
                        .put(new JSONObject().put("time", time)
                                .put("status", "投柜或站点签收")
                                .put("statusCode", 501)
                                .put("context", detail))));

        assertEquals(StatusSemantic.COMPLETED, result.semantic);
        assertEquals(time, result.latestTime);
        assertEquals(detail, result.latestDetail);
        assertEquals(new SimpleDateFormat(
                "yyyy-MM-dd HH:mm:ss", Locale.CHINA).parse(time).getTime(),
                result.statusEventTime);
        assertFalse(result.structuredStatusEvidence);
        JSONObject raw = new JSONArray(result.tracksJson).getJSONObject(0);
        assertEquals(501, raw.getInt("statusCode"));
        assertEquals("投柜或站点签收", raw.getString("status"));
        assertEquals("kuaidi100", raw.getString("_pipiStatusSource"));
    }

    @Test
    public void kuaidi100SummaryCompletionRequiresAValidTimedTrack() throws Exception {
        for (String time : new String[]{"", "not-a-time", "2026-08-24"}) {
            ExpressQueryResult result = ExpressApi.parse(
                    "SFTEST501", "shunfeng",
                    new JSONObject().put("state", "3").put("data", new JSONArray()
                            .put(new JSONObject().put("time", time)
                                    .put("statusCode", "501")
                                    .put("context", "快件已到合作点"))));

            assertEquals(time, StatusSemantic.UNKNOWN, result.semantic);
            assertEquals(time, 0L, result.statusEventTime);
            assertFalse(time, Kuaidi100TimelinePolicy.hasTimedTracking(result));
            assertEquals(time, "501", new JSONArray(result.tracksJson)
                    .getJSONObject(0).getString("statusCode"));
        }
    }

    @Test
    public void kuaidi100SummaryStateAloneIsNotStructuredStatusEvidence() throws Exception {
        ExpressQueryResult result = ExpressApi.parse(
                "SFTESTSUMMARY", "shunfeng",
                new JSONObject().put("state", "3").put("data", new JSONArray()
                        .put(new JSONObject()
                                .put("time", "2026-08-24 12:00:00")
                                .put("context", "已签收"))));

        assertEquals(StatusSemantic.COMPLETED, result.semantic);
        assertFalse(result.structuredStatusEvidence);
    }

    @Test
    public void publicStatusDescriptionCannotUpgradeAnUnknownEnumToStructuredEvidence()
            throws Exception {
        JSONObject root = new JSONObject().put("status", 0).put("data", new JSONObject()
                .put("cpCode", "ZTO")
                .put("logisticsStatus", "UNMAPPED")
                .put("logisticsStatusDesc", "运输中")
                .put("fullTraceDetail", new JSONArray().put(new JSONObject()
                        .put("time", "2026-08-24 12:00:00")
                        .put("desc", "运输中"))));

        ExpressQueryResult result = ExpressApi.parseV4("TEST123", "ZTO", root);

        assertEquals(StatusSemantic.TRANSIT, result.semantic);
        assertFalse(result.structuredStatusEvidence);
    }

    @Test
    public void statusOnlyNodeOwnsStateTimeWithoutStealingTheVisibleHeadline()
            throws Exception {
        String headlineTime = "2026-08-24 12:00:00";
        String statusTime = "2026-08-24 13:00:00";
        ExpressQueryResult result = ExpressApi.parse(
                "SFTEST501", "shunfeng",
                new JSONObject().put("state", "5").put("data", new JSONArray()
                        .put(new JSONObject().put("time", headlineTime)
                                .put("context", "快件正在运输"))
                        .put(new JSONObject().put("time", statusTime)
                                .put("statusCode", "501"))));

        assertEquals(StatusSemantic.WAITING_PICKUP, result.semantic);
        assertEquals(headlineTime, result.latestTime);
        assertEquals("快件正在运输", result.latestDetail);
        assertEquals(new SimpleDateFormat(
                "yyyy-MM-dd HH:mm:ss", Locale.CHINA).parse(statusTime).getTime(),
                result.statusEventTime);
        assertEquals(2, new JSONArray(result.tracksJson).length());
    }

    @Test
    public void conflictingNewestStatusCodesFailClosedRegardlessOfArrayOrder()
            throws Exception {
        JSONObject delivery = new JSONObject().put("time", "2026-08-24 13:00:00")
                .put("statusCode", "5").put("context", "正在派送");
        JSONObject pickup = new JSONObject().put("time", "2026-08-24 13:00:00")
                .put("statusCode", "501").put("context", "已到合作点");
        for (JSONArray tracks : new JSONArray[]{
                new JSONArray().put(delivery).put(pickup),
                new JSONArray().put(pickup).put(delivery)
        }) {
            ExpressQueryResult result = ExpressApi.parse(
                    "SFTEST501", "shunfeng",
                    new JSONObject().put("state", "5").put("data", tracks));
            assertEquals(StatusSemantic.UNKNOWN, result.semantic);
            assertEquals(0L, result.statusEventTime);
        }
    }

    @Test
    public void mappedAutoComNumCandidateRemainsPresentationOnly()
            throws Exception {
        List<String> timelinePaths = new ArrayList<>();
        ExpressApi api = new ExpressApi(transport((path, payload) -> {
            if ("/api/express/classify".equals(path)) {
                return response(new JSONObject().put("auto", new JSONArray()
                        .put(new JSONObject().put("comCode", "SF")
                                .put("name", "顺丰速运"))));
            }
            timelinePaths.add(path);
            return response(new JSONObject());
        }), detector("UNLISTED", "yunda"));

        assertEquals("yunda", api.detect("TEST123456"));
        try {
            api.queryMoto("TEST123456", "", null);
            org.junit.Assert.fail("Display recognition must not become a timeline parameter");
        } catch (ExpressApi.QueryException expected) {
            assertEquals("公开物流查询暂无轨迹", expected.getMessage());
        }
        assertTrue(timelinePaths.isEmpty());
    }

    @Test
    public void interruptedClassifierDoesNotContinueToTimeline() throws Exception {
        final boolean[] timelineCalled = {false};
        ExpressApi api = new ExpressApi(transport((path, payload) -> {
            timelineCalled[0] = true;
            return response(new JSONObject());
        }), new Kuaidi100CarrierDetector((url, cancellation) -> {
            throw new InterruptedException("cancelled");
        }));

        try {
            api.detect("TEST123456");
            org.junit.Assert.fail("Expected interruption");
        } catch (InterruptedException expected) {
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }
        assertFalse(timelineCalled[0]);
    }

    @Test
    public void disconnectFailureFromCancelledQueryDoesNotContinueAsANetworkError()
            throws Exception {
        List<String> urls = new ArrayList<>();
        ExpressQueryCancellation cancellation = new ExpressQueryCancellation(10_000L);
        ExpressApi api = new ExpressApi(transport((path, payload) -> {
            org.junit.Assert.fail("Timeline must not start after classifier cancellation");
            return response(new JSONObject());
        }), new Kuaidi100CarrierDetector((url, requestCancellation) -> {
            urls.add(url);
            cancellation.cancel();
            throw new java.io.IOException("connection closed by cancellation");
        }));

        try {
            api.detect("TEST123456", cancellation);
            org.junit.Assert.fail("Expected cancellation");
        } catch (InterruptedException expected) {
            // A disconnected finite call remains cancellation rather than a user-facing failure.
        }
        assertEquals(1, urls.size());
        assertTrue(urls.get(0).startsWith(Kuaidi100CarrierDetector.ENDPOINT + "?text="));
    }

    @Test
    public void classifierHttpFailureUsesTheSafeGatewayStatusMessage() throws Exception {
        ExpressApi api = new ExpressApi(
                transport((path, payload) -> response(new JSONObject())),
                new Kuaidi100CarrierDetector((url, cancellation) ->
                        response(429, new JSONObject())));

        try {
            api.detect("TEST123456");
            org.junit.Assert.fail("Expected rate-limit failure");
        } catch (ExpressApi.QueryException expected) {
            assertEquals("请求过于频繁，请稍后再试", expected.getMessage());
        }
    }

    @Test
    public void rawCarrierHintSelectsThePublicTimelineParameter() throws Exception {
        List<String> paths = new ArrayList<>();
        ExpressApi api = new ExpressApi(transport((path, payload) -> {
            paths.add(path);
            assertEquals("YD", payload.getString("companyCode"));
            return response(new JSONObject().put("status", 0)
                    .put("data", new JSONObject().put("cpCode", "YD")
                            .put("fullTraceDetail", new JSONArray())));
        }), new Kuaidi100CarrierDetector((url, cancellation) -> {
            throw new AssertionError("A mapped raw hint must not run recognition");
        }));

        ExpressQueryResult result = api.queryMoto("TEST123456", "YD", null);

        assertEquals(Collections.singletonList("/api/express/timeline/public"), paths);
        assertFalse(Kuaidi100TimelinePolicy.hasRealTracking(result));
    }

    @Test
    public void rawJdPrefixCarrierIsPassedVerbatimToThePublicTimeline() throws Exception {
        List<String> companyCodes = new ArrayList<>();
        ExpressApi api = new ExpressApi(transport((path, payload) -> {
            assertEquals("/api/express/timeline/public", path);
            companyCodes.add(payload.getString("companyCode"));
            return response(new JSONObject().put("status", 0)
                    .put("data", new JSONObject().put("cpCode", "JDLEX")
                            .put("cpName", "京东快递")
                            .put("fullTraceDetail", new JSONArray())));
        }), new Kuaidi100CarrierDetector((url, cancellation) -> {
            throw new AssertionError("A known raw cpCode must not run recognition");
        }));

        ExpressQueryResult result = api.queryMoto(
                "TESTJDLEX123456", "  JDLEX  ", null);

        assertEquals(Collections.singletonList("JDLEX"), companyCodes);
        assertEquals("JDLEX", result.courierCode);
        assertEquals("JD", result.carrierNormalization.standardCode);
    }

    @Test
    public void motoAdapterRequiresAResolvedCarrierHint() throws Exception {
        List<String> paths = new ArrayList<>();
        ExpressApi api = new ExpressApi(transport((path, payload) -> {
            paths.add(path);
            return response(new JSONObject());
        }), detector("zhongtong"));

        try {
            api.queryMoto("TEST123456", "", null);
            org.junit.Assert.fail("Recognition must not select the moto adapter");
        } catch (ExpressApi.QueryException expected) {
            assertEquals("公开物流查询暂无轨迹", expected.getMessage());
        }
        assertTrue(paths.isEmpty());
    }

    private static HttpClient.Response response(JSONObject body) {
        return response(200, body);
    }

    private static HttpClient.Response response(int status, JSONObject body) {
        return new HttpClient.Response(status,
                body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static ExpressGatewayTransport transport(Responder responder) {
        return new ExpressGatewayTransport() {
            @Override public boolean configured() { return true; }

            @Override public HttpClient.Response post(String path, JSONObject payload)
                    throws Exception {
                return responder.post(path, payload);
            }
        };
    }

    private static Kuaidi100CarrierDetector detector(String... codes) {
        return new Kuaidi100CarrierDetector((url, cancellation) -> {
            JSONArray values = new JSONArray();
            for (String code : codes) values.put(new JSONObject().put("comCode", code));
            return new HttpClient.Response(200,
                    values.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        });
    }

    @FunctionalInterface
    private interface Responder {
        HttpClient.Response post(String path, JSONObject payload) throws Exception;
    }
}
