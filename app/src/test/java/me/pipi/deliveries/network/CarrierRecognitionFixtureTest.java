package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

import me.pipi.deliveries.SharedExpressFixtures;
import me.pipi.deliveries.data.CarrierRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Audits C1 and C4 (user 2026-09-25), read from the Worker-generated shared fixtures:
 * carrier-classify-responses.v1.json is the Worker's real /api/express/classify answer for each
 * recognition state (comCode is a carrier standard code, never a Kuaidi100 code), and
 * carrier-recognition-state.v1.json is the per-waybill retry state machine every client keeps.
 */
public final class CarrierRecognitionFixtureTest {
    private static final String WAYBILL = "75627185960079";
    private static final String UNRECOGNIZED = "{\"auto\":[]}";

    @Test
    public void everyWorkerClassifyAnswerReadsAsTheFixtureSays() throws Exception {
        JSONObject fixture = SharedExpressFixtures.load("carrier-classify-responses.v1.json");
        long now = fixture.getLong("readingNowMs");
        JSONArray cases = fixture.getJSONArray("cases");
        assertTrue(cases.length() >= 20);
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            String name = value.getString("name");
            JSONObject response = value.getJSONObject("response");
            JSONObject reading = value.getJSONObject("reading");
            Machine machine = new Machine(now);
            machine.free = new HttpClient.Response(200, bytes(UNRECOGNIZED));
            machine.paid = new HttpClient.Response(response.getInt("status"),
                    bytes(response.get("body").toString()));
            switch (reading.getString("kind")) {
                case "success": {
                    CarrierRecognitionCoordinator.Outcome outcome = machine.recognize();
                    assertEquals(name, reading.getString("standardCode"),
                            outcome.candidates.get(0).standardCode);
                    CarrierRegistry.Carrier carrier = CarrierRegistry.resolve(
                            reading.getString("standardCode"));
                    assertEquals(name, carrier.companyName, outcome.candidates.get(0).displayName);
                    assertEquals(name, carrier.kuaidi100Code, outcome.candidates.get(0).kuaidi100Code);
                    break;
                }
                case "terminal": {
                    CarrierRecognitionCoordinator.Outcome outcome = machine.recognize();
                    assertTrue(name, outcome.terminal);
                    assertTrue(name, machine.snapshot.terminal);
                    assertEquals(name, 0, machine.snapshot.networkFailures);
                    break;
                }
                case "pending": {
                    CarrierRecognitionCoordinator.Outcome outcome = machine.recognize();
                    assertTrue(name, outcome.deferred);
                    assertEquals(name, Math.min(reading.getLong("retryAt"),
                            now + CarrierRecognitionCoordinator.RETRY_DELAY_MS),
                            machine.snapshot.retryAt);
                    assertEquals(name, 0, machine.snapshot.networkFailures);
                    break;
                }
                case "failure": {
                    machine.recognizeExpectingFailure(name);
                    assertEquals(name + ": 4xx included, a counted failure", 1,
                            machine.snapshot.networkFailures);
                    assertFalse(name, machine.snapshot.terminal);
                    break;
                }
                default:
                    fail("unknown reading " + reading);
            }
            assertEquals(name + ": every attempt starts with the free stage", 1, machine.freeCalls.get());
            assertEquals(name, 1, machine.paidCalls.get());
        }
    }

    @Test
    public void theRetryStateMachineFollowsEverySharedSequence() throws Exception {
        JSONObject fixture = SharedExpressFixtures.load("carrier-recognition-state.v1.json");
        JSONObject constants = fixture.getJSONObject("constants");
        assertEquals(constants.getLong("retryDelayMs"), CarrierRecognitionCoordinator.RETRY_DELAY_MS);
        assertEquals(constants.getInt("maxNetworkFailures"), CarrierRecognitionCoordinator.MAX_NETWORK_FAILURES);
        assertEquals(constants.getLong("terminalTtlMs"), CarrierRecognitionCoordinator.TERMINAL_TTL_MS);
        assertEquals(constants.getInt("maxTransientEntries"), CarrierRecognitionCoordinator.MAX_TRANSIENT_ENTRIES);
        JSONArray sequences = fixture.getJSONArray("sequences");
        assertTrue(sequences.length() >= 5);
        for (int index = 0; index < sequences.length(); index++) {
            JSONObject sequence = sequences.getJSONObject(index);
            Machine machine = new Machine(0L);
            JSONArray steps = sequence.getJSONArray("steps");
            for (int step = 0; step < steps.length(); step++) {
                JSONObject value = steps.getJSONObject(step);
                String name = sequence.getString("name") + " #" + step + " " + value.getString("event");
                machine.now = value.getLong("atMs");
                machine.stage(value.getString("event"));
                int requestsBefore = machine.freeCalls.get();
                try {
                    machine.recognize();
                } catch (Exception counted) {
                    // A counted failure is rethrown to the caller; the state is what matters here.
                }
                JSONObject expected = value.getJSONObject("expected");
                assertEquals(name + " request", expected.getBoolean("request"),
                        machine.freeCalls.get() > requestsBefore);
                CarrierRecognitionCoordinator.Snapshot state = machine.snapshot;
                String kind = state.success.present() ? "success"
                        : state.terminal ? "terminal" : state.retryAt > 0L ? "cooling" : "none";
                assertEquals(name + " state", expected.getString("state"), kind);
                assertEquals(name + " failures", expected.getInt("failures"), state.networkFailures);
                if (expected.has("untilMs")) {
                    assertEquals(name + " until", expected.getLong("untilMs"), state.retryAt);
                }
                if (expected.has("standardCode")) {
                    assertEquals(name, expected.getString("standardCode"), state.success.standardCode);
                }
            }
        }
    }

    /** One waybill's recognition memory with a scripted free (autoComNum) and paid (classify) stage. */
    private static final class Machine {
        long now;
        HttpClient.Response free;
        HttpClient.Response paid;
        boolean freeThrows;
        CarrierRecognitionCoordinator.Snapshot snapshot = CarrierRecognitionCoordinator.Snapshot.empty();
        final AtomicInteger freeCalls = new AtomicInteger();
        final AtomicInteger paidCalls = new AtomicInteger();
        private final CarrierRecognitionCoordinator coordinator;

        Machine(long start) {
            now = start;
            coordinator = new CarrierRecognitionCoordinator(
                    new Kuaidi100CarrierDetector((url, cancellation) -> {
                        freeCalls.incrementAndGet();
                        if (freeThrows) throw new IOException("synthetic network failure");
                        return free;
                    }),
                    new ExpressGatewayTransport() {
                        @Override public boolean configured() { return true; }
                        @Override public HttpClient.Response post(String path, JSONObject payload) {
                            paidCalls.incrementAndGet();
                            assertEquals("/api/express/classify", path);
                            return paid;
                        }
                    },
                    new CarrierRecognitionCoordinator.State() {
                        @Override public CarrierRecognitionCoordinator.Snapshot load(String identity) {
                            return snapshot;
                        }
                        @Override public void save(String identity,
                                CarrierRecognitionCoordinator.Snapshot value) {
                            snapshot = value;
                        }
                    }, () -> now);
        }

        CarrierRecognitionCoordinator.Outcome recognize() throws Exception {
            return coordinator.recognize(WAYBILL, null);
        }

        void recognizeExpectingFailure(String name) {
            try {
                recognize();
                fail(name + ": a counted failure");
            } catch (Exception expected) {
                // Recorded and rethrown.
            }
        }

        /** free_failure, free_success:CODE, paid_failure, paid_success:CODE, paid_no_match, paid_pending:MS */
        void stage(String event) throws Exception {
            freeThrows = false;
            free = new HttpClient.Response(200, bytes(UNRECOGNIZED));
            paid = null;
            String[] parts = event.split(":", 2);
            switch (parts[0]) {
                case "free_failure":
                    freeThrows = true;
                    break;
                case "free_success":
                    free = new HttpClient.Response(200, bytes(new JSONObject().put("auto",
                            new JSONArray().put(new JSONObject().put("comCode",
                                    CarrierRegistry.resolve(parts[1]).kuaidi100Code))).toString()));
                    break;
                case "paid_failure":
                    paid = new HttpClient.Response(500, bytes(""));
                    break;
                case "paid_success":
                    paid = new HttpClient.Response(200, bytes(new JSONObject().put("auto",
                            new JSONArray().put(new JSONObject().put("comCode", parts[1])))
                            .toString()));
                    break;
                case "paid_no_match":
                    paid = new HttpClient.Response(200, bytes(UNRECOGNIZED));
                    break;
                case "paid_pending":
                    paid = new HttpClient.Response(502, bytes(new JSONObject()
                            .put("error", "recognition_pending")
                            .put("retryAt", now + Long.parseLong(parts[1])).toString()));
                    break;
                default:
                    fail("unknown event " + event);
            }
        }
    }

    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }
}
