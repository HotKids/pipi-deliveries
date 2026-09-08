package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public final class CarrierRecognitionCoordinatorTest {
    @Test
    public void successfulDirectRecognitionIsPersistedAndReused() throws Exception {
        int[] publicCalls = {0};
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    publicCalls[0]++;
                    return response(new JSONArray().put(
                            new JSONObject().put("comCode", "shunfeng")));
                }, unusedGateway(), state, () -> 1_000L);

        CarrierRecognitionCoordinator.Outcome first = coordinator.recognize(
                "SF1234567890", null);
        CarrierRecognitionCoordinator.Outcome second = coordinator.recognize(
                "SF1234567890", null);

        assertEquals(1, publicCalls[0]);
        assertEquals("SF", first.candidates.get(0).standardCode);
        assertEquals("shunfeng", second.candidates.get(0).kuaidi100Code);
    }

    @Test
    public void unmappedPublicCodeUsesExistingWorkerClassifyAsSecondLevel()
            throws Exception {
        String[] requestedPath = {""};
        JSONObject[] requestedPayload = {null};
        ExpressGatewayTransport gateway = gateway((path, payload) -> {
            requestedPath[0] = path;
            requestedPayload[0] = payload;
            return response(new JSONObject().put("auto", new JSONArray().put(
                    new JSONObject().put("comCode", "KYSY")
                            .put("name", "跨越速运"))));
        });
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> response(new JSONArray().put(
                        new JSONObject().put("comCode", "not-in-local-baseline"))),
                gateway, new MemoryState(), () -> 1_000L);

        CarrierRecognitionCoordinator.Outcome result = coordinator.recognize(
                "TEST123456", null);

        assertEquals("/api/express/classify", requestedPath[0]);
        assertTrue(requestedPayload[0].getBoolean("firstStageCompleted"));
        assertEquals(2, requestedPayload[0].length());
        assertEquals("KYSY", result.candidates.get(0).standardCode);
    }

    @Test
    public void networkFailuresWaitFifteenMinutesAndBecomeTerminalAfterThree()
            throws Exception {
        long[] now = {10_000L};
        int[] calls = {0};
        MemoryState state = new MemoryState();
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    calls[0]++;
                    throw new IOException("synthetic network failure");
                }, unusedGateway(), state, () -> now[0]);

        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                coordinator.recognize("TEST123456", null);
                org.junit.Assert.fail("Expected network failure");
            } catch (Exception expected) {
                // The detector translates transport errors into the gateway's stable
                // network-failure type; retry state must not depend on the wrapper type.
                assertTrue(expected.getMessage() != null);
            }
            CarrierRecognitionCoordinator.Outcome immediate = coordinator.recognize(
                    "TEST123456", null);
            if (attempt < 3) {
                assertTrue(immediate.deferred);
                assertFalse(immediate.terminal);
                now[0] += CarrierRecognitionCoordinator.RETRY_DELAY_MS;
            } else {
                assertTrue(immediate.terminal);
            }
        }
        assertEquals(3, calls[0]);
    }

    @Test
    public void staleResolvedPresentationHealsFromCurrentTableWithoutNetwork() throws Exception {
        int[] calls = {0};
        MemoryState state = new MemoryState();
        state.value = new CarrierRecognitionCoordinator.Snapshot(
                new me.pipi.deliveries.model.CarrierNormalization(
                        "HTKY", "百世快递", "jtexpress", true, "broken"),
                0, 0L, false);
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    calls[0]++;
                    return response(new JSONArray().put(
                            new JSONObject().put("comCode", "huitongkuaidi")));
                }, unusedGateway(), state, () -> 1_000L);

        CarrierRecognitionCoordinator.Outcome result = coordinator.recognize(
                "TEST123456", null);

        assertEquals(0, calls[0]);
        assertEquals("HTKY", result.candidates.get(0).standardCode);
        assertEquals("极兔速递", result.candidates.get(0).displayName);
        assertEquals("huitongkuaidi", result.candidates.get(0).kuaidi100Code);
    }

    @Test
    public void unknownCachedStandardCodeRunsRecognitionAgain() throws Exception {
        int[] calls = {0};
        MemoryState state = new MemoryState();
        state.value = new CarrierRecognitionCoordinator.Snapshot(
                new me.pipi.deliveries.model.CarrierNormalization(
                        "REMOVED", "旧承运商", "removed", true, "old"),
                0, 0L, false);
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    calls[0]++;
                    return response(new JSONArray().put(
                            new JSONObject().put("comCode", "shunfeng")));
                }, unusedGateway(), state, () -> 1_000L);

        CarrierRecognitionCoordinator.Outcome result = coordinator.recognize(
                "TEST123456", null);

        assertEquals(1, calls[0]);
        assertEquals("SF", result.candidates.get(0).standardCode);
    }

    @Test
    public void equivalentWaybillFormattingUsesOneDurableIdentity() throws Exception {
        int[] calls = {0};
        KeyedState state = new KeyedState();
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    calls[0]++;
                    return response(new JSONArray().put(
                            new JSONObject().put("comCode", "shunfeng")));
                }, unusedGateway(), state, () -> 1_000L);

        coordinator.recognize("SF 123-456", null);
        CarrierRecognitionCoordinator.Outcome reused = coordinator.recognize(
                "sf123456", null);

        assertEquals(1, calls[0]);
        assertEquals("SF", reused.candidates.get(0).standardCode);
    }

    @Test
    public void punctuationOnlyWaybillNeverCreatesSharedEmptyIdentity() throws Exception {
        int[] calls = {0};
        CarrierRecognitionCoordinator coordinator = coordinator(
                (url, cancellation) -> {
                    calls[0]++;
                    return response(new JSONArray());
                }, unusedGateway(), new KeyedState(), () -> 1_000L);

        CarrierRecognitionCoordinator.Outcome result = coordinator.recognize(
                "------", null);

        assertTrue(result.terminal);
        assertEquals(0, calls[0]);
    }

    private static CarrierRecognitionCoordinator coordinator(
            Kuaidi100CarrierDetector.Transport transport,
            ExpressGatewayTransport gateway,
            CarrierRecognitionCoordinator.State state,
            CarrierRecognitionCoordinator.Clock clock) {
        return new CarrierRecognitionCoordinator(
                new Kuaidi100CarrierDetector(transport), gateway, state, clock);
    }

    private static ExpressGatewayTransport unusedGateway() {
        return gateway((path, payload) -> {
            throw new AssertionError("Gateway must not be called");
        });
    }

    private static ExpressGatewayTransport gateway(Responder responder) {
        return new ExpressGatewayTransport() {
            @Override public boolean configured() { return true; }

            @Override public HttpClient.Response post(String path, JSONObject payload)
                    throws Exception {
                return responder.post(path, payload);
            }
        };
    }

    private static HttpClient.Response response(Object body) {
        return new HttpClient.Response(200, String.valueOf(body)
                .getBytes(StandardCharsets.UTF_8));
    }

    private static final class MemoryState implements CarrierRecognitionCoordinator.State {
        CarrierRecognitionCoordinator.Snapshot value =
                CarrierRecognitionCoordinator.Snapshot.empty();

        @Override public CarrierRecognitionCoordinator.Snapshot load(String identity) {
            return value;
        }

        @Override public void save(
                String identity, CarrierRecognitionCoordinator.Snapshot snapshot) {
            value = snapshot;
        }
    }

    private static final class KeyedState implements CarrierRecognitionCoordinator.State {
        private final Map<String, CarrierRecognitionCoordinator.Snapshot> values =
                new HashMap<>();

        @Override public CarrierRecognitionCoordinator.Snapshot load(String identity) {
            return values.getOrDefault(
                    identity, CarrierRecognitionCoordinator.Snapshot.empty());
        }

        @Override public void save(
                String identity, CarrierRecognitionCoordinator.Snapshot snapshot) {
            values.put(identity, snapshot);
        }
    }

    @FunctionalInterface
    private interface Responder {
        HttpClient.Response post(String path, JSONObject payload) throws Exception;
    }
}
