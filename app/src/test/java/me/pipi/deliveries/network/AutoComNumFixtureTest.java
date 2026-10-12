package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

import me.pipi.deliveries.SharedExpressFixtures;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Audit C3 (user 2026-09-25): the free autoComNum answer reads one way on every client, from the
 * Worker-generated fixture k100-autocomnum-responses.v1.json. recognized: the first candidate the
 * table maps; unrecognized: no such candidate, the paid stage decides; failure: retryable, counts
 * one network failure and never reaches the paid stage.
 */
public final class AutoComNumFixtureTest {
    private static final long NOW = 1_790_294_400_000L;

    @Test
    public void everySharedAutoComNumAnswerReadsAsTheFixtureSays() throws Exception {
        JSONArray cases = SharedExpressFixtures.load("k100-autocomnum-responses.v1.json")
                .getJSONArray("cases");
        assertTrue(cases.length() >= 12);
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            JSONObject response = value.getJSONObject("response");
            JSONObject expected = value.getJSONObject("expected");
            check(value.getString("name"), response.getInt("status"), response.getString("body"),
                    expected.getString("outcome"), expected.optString("standardCode", ""));
        }
    }

    /** 用户 2026-09-26（其余裁决 5）：returnCode 写成数字 201 也是「没识别出」，四端同（夹具也有这一例）。 */
    @Test
    public void aNumericReturnCode201IsUnrecognizedToo() throws Exception {
        check("numeric 201", 200, "{\"result\":false,\"returnCode\":201}", "unrecognized", "");
    }

    private static void check(String name, int status, String body, String outcome,
            String standardCode) throws Exception {
        AtomicInteger paid = new AtomicInteger();
        CarrierRecognitionCoordinator.Snapshot[] state = {CarrierRecognitionCoordinator.Snapshot.empty()};
        CarrierRecognitionCoordinator coordinator = new CarrierRecognitionCoordinator(
                new Kuaidi100CarrierDetector((url, cancellation) -> new HttpClient.Response(
                        status, body.getBytes(StandardCharsets.UTF_8))),
                new ExpressGatewayTransport() {
                    @Override public boolean configured() { return true; }
                    @Override public HttpClient.Response post(String path, JSONObject payload) {
                        paid.incrementAndGet();
                        return new HttpClient.Response(200, "{\"auto\":[]}"
                                .getBytes(StandardCharsets.UTF_8));
                    }
                },
                new CarrierRecognitionCoordinator.State() {
                    @Override public CarrierRecognitionCoordinator.Snapshot load(String identity) {
                        return state[0];
                    }
                    @Override public void save(String identity,
                            CarrierRecognitionCoordinator.Snapshot snapshot) {
                        state[0] = snapshot;
                    }
                }, () -> NOW);
        switch (outcome) {
            case "recognized": {
                CarrierRecognitionCoordinator.Outcome result = coordinator.recognize("JT4006839564547", null);
                assertEquals(name, standardCode, result.candidates.get(0).standardCode);
                assertEquals(name, 0, paid.get());
                break;
            }
            case "unrecognized": {
                CarrierRecognitionCoordinator.Outcome result = coordinator.recognize("JT4006839564547", null);
                assertEquals(name + ": the paid stage decides", 1, paid.get());
                assertTrue(name, result.candidates.isEmpty());
                assertEquals(name, 0, state[0].networkFailures);
                break;
            }
            case "failure": {
                try {
                    coordinator.recognize("JT4006839564547", null);
                    fail(name + ": a retryable failure");
                } catch (Exception expected) {
                    // The coordinator records the failure and rethrows it to its caller.
                }
                assertEquals(name + ": never reaches the paid stage", 0, paid.get());
                assertEquals(name, 1, state[0].networkFailures);
                assertFalse(name, state[0].terminal);
                assertEquals(name, NOW + CarrierRecognitionCoordinator.RETRY_DELAY_MS, state[0].retryAt);
                break;
            }
            default:
                fail("unknown outcome " + outcome);
        }
    }
}
