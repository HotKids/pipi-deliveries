package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.data.CarrierAuthorityFixture;
import me.pipi.deliveries.data.CarrierRegistry;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.nio.charset.StandardCharsets;

public final class CarrierAuthorityTest {
    private static final long NOW = CarrierAuthority.REFRESH_INTERVAL_MS * 2L;

    @Before
    public void setUp() throws Exception {
        install(CarrierAuthorityFixture.payload());
    }

    @After
    public void tearDown() throws Exception {
        install(CarrierAuthorityFixture.payload());
    }

    @Test
    public void startupLoadsTheLastGoodSnapshotBeforeAnyRefresh() throws Exception {
        JSONObject payload = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(payload, "YTO").put("displayName", "缓存圆通");
        MemoryStorage storage = new MemoryStorage();
        storage.snapshot = envelope(payload, NOW).toString();

        assertTrue(CarrierAuthority.loadCached(storage));
        assertEquals("缓存圆通", CarrierRegistry.companyName("YTO", ""));
    }

    @Test
    public void successfulRefreshPersistsBeforePublishingAndRunsAtMostDaily() throws Exception {
        JSONObject payload = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(payload, "YTO").put("displayName", "远端圆通");
        MemoryStorage storage = new MemoryStorage();
        FakeGateway gateway = new FakeGateway(response(payload));

        assertTrue(CarrierAuthority.refreshIfDue(storage, gateway, () -> NOW));
        assertEquals(1, gateway.calls);
        assertEquals("/api/express/carriers", gateway.path);
        assertEquals("{}", gateway.request.toString());
        assertTrue(storage.snapshot.contains("远端圆通"));
        assertEquals("远端圆通", CarrierRegistry.companyName("YTO", ""));

        assertFalse(CarrierAuthority.refreshIfDue(
                storage, gateway, () -> NOW + CarrierAuthority.REFRESH_INTERVAL_MS - 1L));
        assertEquals(1, gateway.calls);
        assertTrue(CarrierAuthority.refreshIfDue(
                storage, gateway, () -> NOW + CarrierAuthority.REFRESH_INTERVAL_MS));
        assertEquals(2, gateway.calls);
    }

    @Test
    public void invalidResponseOrPersistenceFailureRetainsCurrentLastGoodTable() throws Exception {
        JSONObject installed = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(installed, "YTO").put("displayName", "当前圆通");
        install(installed);

        JSONObject invalid = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(invalid, "JD").remove("requiresPhoneTail");
        MemoryStorage invalidStorage = new MemoryStorage();
        assertFalse(CarrierAuthority.refreshIfDue(
                invalidStorage, new FakeGateway(response(invalid)), () -> NOW));
        assertEquals("当前圆通", CarrierRegistry.companyName("YTO", ""));

        JSONObject next = CarrierAuthorityFixture.payload();
        CarrierAuthorityFixture.entry(next, "YTO").put("displayName", "不可落盘圆通");
        MemoryStorage failedStorage = new MemoryStorage();
        failedStorage.allowWrite = false;
        assertFalse(CarrierAuthority.refreshIfDue(
                failedStorage, new FakeGateway(response(next)), () -> NOW));
        assertEquals("当前圆通", CarrierRegistry.companyName("YTO", ""));
    }

    @Test
    public void failedAttemptIsAlsoRateLimitedForTwentyFourHours() {
        MemoryStorage storage = new MemoryStorage();
        FakeGateway gateway = new FakeGateway(
                new HttpClient.Response(503, new byte[0]));

        assertFalse(CarrierAuthority.refreshIfDue(storage, gateway, () -> NOW));
        assertEquals(1, gateway.calls);
        assertFalse(CarrierAuthority.refreshIfDue(storage, gateway, () -> NOW + 10_000L));
        assertEquals(1, gateway.calls);
    }

    private static void install(JSONObject payload) {
        CarrierRegistry.installAuthority(CarrierRegistry.prepareAuthority(payload));
    }

    private static HttpClient.Response response(JSONObject payload) {
        return new HttpClient.Response(
                200, payload.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static JSONObject envelope(JSONObject payload, long fetchedAtMs) throws Exception {
        return new JSONObject()
                .put("cacheSchema", 1)
                .put("fetchedAtMs", fetchedAtMs)
                .put("payload", payload);
    }

    private static final class MemoryStorage implements CarrierAuthority.Storage {
        String snapshot;
        long attempt;
        boolean allowWrite = true;

        @Override public String readSnapshot() {
            return snapshot;
        }

        @Override public boolean writeSnapshot(String value) {
            if (!allowWrite) return false;
            snapshot = value;
            return true;
        }

        @Override public long lastAttemptMs() {
            return attempt;
        }

        @Override public boolean recordAttemptMs(long value) {
            attempt = value;
            return true;
        }
    }

    private static final class FakeGateway implements ExpressGatewayTransport {
        final HttpClient.Response response;
        int calls;
        String path;
        JSONObject request;

        FakeGateway(HttpClient.Response value) {
            response = value;
        }

        @Override public boolean configured() {
            return true;
        }

        @Override public HttpClient.Response post(String route, JSONObject payload) {
            calls += 1;
            path = route;
            request = payload;
            return response;
        }
    }
}
