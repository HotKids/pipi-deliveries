package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import me.pipi.deliveries.data.CarrierRegistry;
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
        assertEquals("快件运输中", result.latestDetail);
        assertEquals(2, new JSONArray(result.tracksJson).length());
    }

    @Test
    public void v4PublicTimelineExcludesSfExactlyLikePipi() {
        assertTrue(ExpressApi.supportsV4(CarrierRegistry.resolve("ZTO", "")));
        org.junit.Assert.assertFalse(
                ExpressApi.supportsV4(CarrierRegistry.resolve("SF", "")));
    }

    @Test
    public void unknownCarrierRetriesWithSuppliedPhoneTailWhenGatewayRequiresIt()
            throws Exception {
        List<String> attemptedPhones = new ArrayList<>();
        ExpressGatewayTransport transport = new ExpressGatewayTransport() {
            @Override public boolean configured() { return true; }

            @Override public HttpClient.Response post(String path, JSONObject payload)
                    throws Exception {
                if ("/api/express/classify".equals(path)) {
                    return response(new JSONObject().put("auto", new JSONArray().put(
                            new JSONObject().put("comCode", "UNLISTED"))));
                }
                String phone = payload.optString("phone", "");
                attemptedPhones.add(phone);
                if (phone.isEmpty()) {
                    return response(new JSONObject()
                            .put("result", false)
                            .put("returnCode", "408"));
                }
                return response(new JSONObject()
                        .put("result", true)
                        .put("returnCode", "200")
                        .put("state", "3")
                        .put("data", new JSONArray().put(new JSONObject()
                                .put("time", "2026-08-22 12:00:00")
                                .put("context", "快件运输中"))));
            }
        };

        ExpressQueryResult result = new ExpressApi(transport).queryWithPhones(
                "TEST123456", "", Collections.singletonList("1515"));

        assertEquals(Arrays.asList("", "1515"), attemptedPhones);
        assertEquals("1515", result.phone);
        assertEquals("kuaidi100", result.timelineProvider);
    }

    @Test
    public void knownPhoneProtectedCarrierPromptsBeforeTimelineRequest() throws Exception {
        List<String> timelineCalls = new ArrayList<>();
        ExpressApi api = new ExpressApi(transport((path, payload) -> {
            if ("/api/express/classify".equals(path)) {
                return response(new JSONObject().put("auto", new JSONArray().put(
                        new JSONObject().put("comCode", "zhongtong"))));
            }
            timelineCalls.add(path);
            return response(new JSONObject());
        }));

        try {
            api.queryWithPhones("TEST123456", "", Collections.emptyList());
            org.junit.Assert.fail("Expected phone-tail request");
        } catch (ExpressApi.QueryException expected) {
            assertTrue(expected.needsPhoneTail());
        }
        assertTrue(timelineCalls.isEmpty());
    }

    @Test
    public void phoneCandidatesContinueAfterTheFirstTailIsRejected() throws Exception {
        List<String> attemptedPhones = new ArrayList<>();
        ExpressApi api = new ExpressApi(transport((path, payload) -> {
            if ("/api/express/classify".equals(path)) {
                return response(new JSONObject().put("auto", new JSONArray().put(
                        new JSONObject().put("comCode", "shunfeng"))));
            }
            String phone = payload.optString("phone", "");
            attemptedPhones.add(phone);
            if ("1111".equals(phone)) {
                return response(new JSONObject()
                        .put("result", false)
                        .put("returnCode", "408"));
            }
            return response(new JSONObject()
                    .put("result", true)
                    .put("returnCode", "200")
                    .put("state", "3")
                    .put("data", new JSONArray().put(new JSONObject()
                            .put("time", "2026-08-22 12:00:00")
                            .put("context", "快件运输中"))));
        }));

        ExpressQueryResult result = api.queryWithPhones(
                "SF1226181467773", "", Arrays.asList("1111", "1515"));

        assertEquals(Arrays.asList("1111", "1515"), attemptedPhones);
        assertEquals("1515", result.phone);
    }

    @Test
    public void phoneRequirementWinsOverAnotherCandidateWithNoTracks() throws Exception {
        ExpressApi api = new ExpressApi(transport((path, payload) -> {
            if ("/api/express/classify".equals(path)) {
                return response(new JSONObject().put("auto", new JSONArray()
                        .put(new JSONObject().put("comCode", "UNLISTED"))
                        .put(new JSONObject().put("comCode", "yunda"))));
            }
            if ("UNLISTED".equals(payload.optString("companyCode", ""))) {
                return response(new JSONObject()
                        .put("result", false)
                        .put("returnCode", "408"));
            }
            return response(new JSONObject()
                    .put("result", false)
                    .put("returnCode", "500")
                    .put("data", new JSONArray()));
        }));

        try {
            api.queryWithPhones("TEST123456", "", Collections.emptyList());
            org.junit.Assert.fail("Expected phone-tail request");
        } catch (ExpressApi.QueryException expected) {
            assertTrue(expected.needsPhoneTail());
        }
    }

    @Test
    public void interruptedClassifierDoesNotContinueToTimeline() throws Exception {
        final boolean[] timelineCalled = {false};
        ExpressApi api = new ExpressApi(transport((path, payload) -> {
            if ("/api/express/classify".equals(path)) {
                throw new InterruptedException("cancelled");
            }
            timelineCalled[0] = true;
            return response(new JSONObject());
        }));

        try {
            api.queryWithPhones("TEST123456", "ZTO", Collections.singletonList("1515"));
            org.junit.Assert.fail("Expected interruption");
        } catch (InterruptedException expected) {
            assertTrue(Thread.currentThread().isInterrupted());
        } finally {
            Thread.interrupted();
        }
        assertFalse(timelineCalled[0]);
    }

    private static HttpClient.Response response(JSONObject body) {
        return new HttpClient.Response(
                200, body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
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

    @FunctionalInterface
    private interface Responder {
        HttpClient.Response post(String path, JSONObject payload) throws Exception;
    }
}
