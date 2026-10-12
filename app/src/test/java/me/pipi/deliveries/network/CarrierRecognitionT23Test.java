package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/**
 * 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28、29）的识别一侧：京东平台行（R-20）识别时跳过京东、走下一个候选和
 * 付费级（缺口②：原来把平台行识别出的 JD 当成功缓存，之后每轮被拒，永远进不了付费级也到不了终态）；快递100 认得出、内置表
 * 没有的承运商记下它给的名字，只作显示。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class CarrierRecognitionT23Test {
    @Test public void aPlatformRowSkipsJdForTheNextCandidateAndThePaidLevel() throws Exception {
        CarrierRecognitionCoordinator twoCandidates = coordinator(
                free(candidate("jd", ""), candidate("yuantong", "")), unusedGateway(), new KeyedState());
        assertEquals("YTO", twoCandidates.recognize("YT1234567890", null, true)
                .candidates.get(0).standardCode);

        AtomicInteger paid = new AtomicInteger();
        CarrierRecognitionCoordinator onlyJd = coordinator(free(candidate("jd", "")),
                (path, payload) -> {
                    paid.incrementAndGet();
                    return response(new JSONObject().put("auto", new JSONArray()
                            .put(new JSONObject().put("comCode", "JD"))
                            .put(new JSONObject().put("comCode", "JTSD"))));
                }, new KeyedState());
        CarrierRecognitionCoordinator.Outcome platform = onlyJd.recognize("JT4006839564547", null, true);
        assertEquals("the paid level is reached", 1, paid.get());
        assertEquals("a paid 京东 is refused too", "JTSD", platform.candidates.get(0).standardCode);

        CarrierRecognitionCoordinator jdOnlyEverywhere = coordinator(free(candidate("jd", "")),
                (path, payload) -> response(new JSONObject().put("auto", new JSONArray()
                        .put(new JSONObject().put("comCode", "JD")))), new KeyedState());
        CarrierRecognitionCoordinator.Outcome refused =
                jdOnlyEverywhere.recognize("JT4006839564548", null, true);
        assertTrue(refused.candidates.isEmpty());
        assertTrue("a terminal verdict instead of a JD success rejected every round", refused.terminal);
    }

    @Test public void anOrdinaryRowStillTakesJdAndAPlatformRowDoesNotReuseItsCache() throws Exception {
        KeyedState state = new KeyedState();
        AtomicInteger free = new AtomicInteger();
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            free.incrementAndGet();
            return response(new JSONArray().put(candidate("jd", "")).put(candidate("zhongtong", "")));
        }, unusedGateway(), state);
        assertEquals("JD", coordinator.recognize("JDV000000001", null, false)
                .candidates.get(0).standardCode);
        assertEquals(1, free.get());
        assertEquals("the cached JD is not a platform row's answer", "ZTO",
                coordinator.recognize("JDV000000001", null, true).candidates.get(0).standardCode);
        assertEquals(2, free.get());
    }

    @Test public void anOffTableCarrierKeepsTheNameKuaidi100Gives() throws Exception {
        KeyedState state = new KeyedState();
        AtomicInteger free = new AtomicInteger();
        CarrierRecognitionCoordinator coordinator = coordinator((url, cancellation) -> {
            free.incrementAndGet();
            return response(new JSONObject().put("auto", new JSONArray()
                    .put(candidate("notbuilt", "某某速运"))));
        }, (path, payload) -> response(new JSONObject().put("auto", new JSONArray())), state);
        CarrierRecognitionCoordinator.Outcome first = coordinator.recognize("MM1234567890", null);
        assertTrue(first.candidates.isEmpty());
        assertTrue(first.terminal);
        assertEquals("某某速运", first.offTable.offTableName());
        assertEquals("notbuilt", first.offTable.kuaidi100Code);
        CarrierRecognitionCoordinator.Outcome cached = coordinator.recognize("MM1234567890", null);
        assertEquals("the terminal verdict still binds", 1, free.get());
        assertEquals("某某速运", cached.offTable.offTableName());
    }

    @Test public void theOffTableNameSurvivesTheDurableCache() {
        Context context = RuntimeEnvironment.getApplication();
        SharedPreferences preferences = context.getSharedPreferences("t23_carrier_cache", 0);
        preferences.edit().clear().commit();
        CarrierRecognitionCoordinator.PreferencesState state =
                new CarrierRecognitionCoordinator.PreferencesState(preferences);
        state.save("identity", new CarrierRecognitionCoordinator.Snapshot(
                me.pipi.deliveries.model.CarrierNormalization.NONE, 0, 5_000L, true,
                me.pipi.deliveries.model.CarrierNormalization.offTable("某某速运", "notbuilt")));
        CarrierRecognitionCoordinator.Snapshot loaded = state.load("identity");
        assertTrue(loaded.terminal);
        assertEquals("某某速运", loaded.offTable.offTableName());
        assertEquals("notbuilt", loaded.offTable.kuaidi100Code);
    }

    @Test public void candidatesCarryTheNameKuaidi100Gives() {
        List<Kuaidi100CarrierDetector.Candidate> candidates =
                Kuaidi100CarrierDetector.parseNamedCandidates("{\"auto\":["
                        + "{\"comCode\":\"a1\",\"name\":\"甲速运\"},"
                        + "{\"comCode\":\"b2\",\"comName\":\"乙快递\"},"
                        + "{\"comCode\":\"c3\",\"companyName\":\"丙物流\"},"
                        + "{\"comCode\":\"d4\"}]}");
        assertEquals(4, candidates.size());
        assertEquals("甲速运", candidates.get(0).name);
        assertEquals("乙快递", candidates.get(1).name);
        assertEquals("丙物流", candidates.get(2).name);
        assertEquals("", candidates.get(3).name);
        assertEquals("d4", candidates.get(3).code);
    }

    /**
     * 其余裁决 32：终态（付费级明确认不出，或连续 3 次失败）且快递100 没给名字时，识别给出「终态」结论；还在冷却、之后还会重试的
     * 不算；给了名字的是表外名。
     */
    @Test public void aTerminalVerdictWithoutANameReadsAsExhausted() throws Exception {
        Responder paidNoMatch = (path, payload) -> response(new JSONObject().put("auto", new JSONArray()));
        me.pipi.deliveries.model.CarrierNormalization unnamed = api(
                free(candidate("notbuilt", "")), paidNoMatch).recognizeCarrier("MM1234567891", null);
        assertTrue(unnamed.recognitionExhausted());
        me.pipi.deliveries.model.CarrierNormalization named = api(
                free(candidate("notbuilt", "某某速运")), paidNoMatch).recognizeCarrier("MM1234567892", null);
        assertEquals("某某速运", named.offTableName());
        assertTrue(!named.recognitionExhausted());

        AtomicInteger calls = new AtomicInteger();
        ExpressApi cooling = api((url, cancellation) -> {
            if (calls.incrementAndGet() == 1) throw new java.io.IOException("offline");
            return response(new JSONObject().put("auto", new JSONArray()));
        }, paidNoMatch);
        try {
            cooling.recognizeCarrier("MM1234567893", null);
            org.junit.Assert.fail("the first network failure is thrown");
        } catch (ExpressApi.QueryException expected) {
            // One failure: a retry is due in 15 minutes.
        }
        me.pipi.deliveries.model.CarrierNormalization waiting = cooling.recognizeCarrier("MM1234567893", null);
        assertTrue("a cooling retry is no verdict", !waiting.present());
    }

    @Test public void threeNetworkFailuresReachTheTerminalVerdict() throws Exception {
        java.util.concurrent.atomic.AtomicLong now = new java.util.concurrent.atomic.AtomicLong(1_000L);
        CarrierRecognitionCoordinator coordinator = new CarrierRecognitionCoordinator(
                new Kuaidi100CarrierDetector((url, cancellation) -> {
                    throw new java.io.IOException("offline");
                }), new ExpressGatewayTransport() {
                    @Override public boolean configured() { return true; }

                    @Override public HttpClient.Response post(String path, JSONObject payload) {
                        throw new AssertionError("Gateway must not be called");
                    }
                }, new KeyedState(), now::get);
        for (int attempt = 1; attempt <= 3; attempt++) {
            try {
                coordinator.recognize("MM1234567894", null, false);
                org.junit.Assert.fail("attempt " + attempt + " fails");
            } catch (Exception expected) {
                now.addAndGet(CarrierRecognitionCoordinator.RETRY_DELAY_MS + 1L);
            }
        }
        CarrierRecognitionCoordinator.Outcome verdict = coordinator.recognize("MM1234567894", null, false);
        assertTrue(verdict.terminal);
        assertTrue(verdict.candidates.isEmpty());
        assertTrue(verdict.offTable.offTableName().isEmpty());
    }

    private static ExpressApi api(Kuaidi100CarrierDetector.Transport transport, Responder gateway) {
        return new ExpressApi(new ExpressGatewayTransport() {
            @Override public boolean configured() { return true; }

            @Override public HttpClient.Response post(String path, JSONObject payload) throws Exception {
                return gateway.post(path, payload);
            }
        }, new Kuaidi100CarrierDetector(transport));
    }

    private static CarrierRecognitionCoordinator coordinator(
            Kuaidi100CarrierDetector.Transport transport, Responder gateway,
            CarrierRecognitionCoordinator.State state) {
        return new CarrierRecognitionCoordinator(new Kuaidi100CarrierDetector(transport),
                new ExpressGatewayTransport() {
                    @Override public boolean configured() { return true; }

                    @Override public HttpClient.Response post(String path, JSONObject payload)
                            throws Exception {
                        return gateway.post(path, payload);
                    }
                }, state, () -> 1_000L);
    }

    private static Kuaidi100CarrierDetector.Transport free(JSONObject... candidates) {
        return (url, cancellation) -> {
            JSONArray auto = new JSONArray();
            for (JSONObject candidate : candidates) auto.put(candidate);
            return response(new JSONObject().put("auto", auto));
        };
    }

    private static JSONObject candidate(String code, String name) {
        try {
            JSONObject value = new JSONObject().put("comCode", code);
            return name.isEmpty() ? value : value.put("name", name);
        } catch (Exception impossible) {
            throw new AssertionError(impossible);
        }
    }

    private static Responder unusedGateway() {
        return (path, payload) -> {
            throw new AssertionError("Gateway must not be called");
        };
    }

    private static HttpClient.Response response(Object body) {
        return new HttpClient.Response(200, String.valueOf(body).getBytes(StandardCharsets.UTF_8));
    }

    private static final class KeyedState implements CarrierRecognitionCoordinator.State {
        private final Map<String, CarrierRecognitionCoordinator.Snapshot> values = new HashMap<>();

        @Override public synchronized CarrierRecognitionCoordinator.Snapshot load(String identity) {
            return values.getOrDefault(identity, CarrierRecognitionCoordinator.Snapshot.empty());
        }

        @Override public synchronized void save(
                String identity, CarrierRecognitionCoordinator.Snapshot snapshot) {
            values.put(identity, snapshot);
        }
    }

    @FunctionalInterface
    private interface Responder {
        HttpClient.Response post(String path, JSONObject payload) throws Exception;
    }
}
