package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;

public final class Kuaidi100CarrierDetectorTest {
    @Test
    public void directRequestUsesTheFreeKeylessEndpoint() {
        String url = Kuaidi100CarrierDetector.requestUrl(" JDAP 123456 ");

        assertEquals(
                "https://www.kuaidi100.com/autonumber/autoComNum?text=JDAP+123456",
                url);
        assertFalse(url.contains("key="));
        assertFalse(url.contains("poll.kuaidi100.com"));
    }

    @Test
    public void parsesBothPublicResponseShapesAndPreservesCandidateOrder() throws Exception {
        JSONArray values = new JSONArray()
                .put(new JSONObject().put("comCode", "jd"))
                .put(new JSONObject().put("comCode", "shunfeng"))
                .put(new JSONObject().put("comCode", "jd"))
                .put(new JSONObject().put("comCode", "invalid code"));

        assertEquals(Arrays.asList("jd", "shunfeng"),
                Kuaidi100CarrierDetector.parseCandidates(values.toString()));
        assertEquals(Arrays.asList("jd", "shunfeng"),
                Kuaidi100CarrierDetector.parseCandidates(
                        new JSONObject().put("auto", values).toString()));
        assertEquals(Collections.emptyList(),
                Kuaidi100CarrierDetector.parseCandidates("not-json"));
    }

    @Test
    public void detectorCallsThePublicEndpointWithoutTouchingTheGateway() throws Exception {
        final String[] requestedUrl = {""};
        Kuaidi100CarrierDetector detector = new Kuaidi100CarrierDetector(
                (url, cancellation) -> {
                    requestedUrl[0] = url;
                    return new HttpClient.Response(200,
                            "[{\"comCode\":\"shunfeng\"}]"
                                    .getBytes(StandardCharsets.UTF_8));
                });

        assertEquals(Collections.singletonList("shunfeng"),
                detector.detectCandidates("SF1234567890", null));
        assertTrue(requestedUrl[0].startsWith(
                Kuaidi100CarrierDetector.ENDPOINT + "?text="));
    }
}
