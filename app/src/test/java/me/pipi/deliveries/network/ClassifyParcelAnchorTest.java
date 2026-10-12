package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.app.Application;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import me.pipi.deliveries.data.WaybillReusePolicy;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * 优化 5（用户 2026-10-03「答案按新件分开、总额仍按运单」；接口约定协调方定）：the paid classify request carries the asking
 * parcel's reuse anchor as {@code parcelAnchorAtMs} — its earliest timed node, else its status time, else its latest time,
 * only when positive and not in the future — and nothing otherwise. A Worker that ignores the field answers as before.
 * Synthetic waybills only.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public final class ClassifyParcelAnchorTest {
    private static final long HOUR = 60L * 60L * 1000L;

    @Test public void aValidAnchorIsSentWithThePaidRequest() throws Exception {
        List<JSONObject> sent = new ArrayList<>();
        long anchor = System.currentTimeMillis() - 30L * HOUR;
        CarrierNormalization carrier = api(sent).forParcel(anchor).recognizeCarrier("MM5000000001", null);
        assertEquals("the Worker's answer is read as before", "JTSD", carrier.standardCode);
        assertEquals(1, sent.size());
        assertEquals(anchor, sent.get(0).getLong("parcelAnchorAtMs"));
        assertEquals("MM5000000001", sent.get(0).getString("waybill"));
        assertTrue(sent.get(0).getBoolean("firstStageCompleted"));
    }

    @Test public void anInvalidOrMissingAnchorIsNotSent() throws Exception {
        List<JSONObject> sent = new ArrayList<>();
        api(sent).recognizeCarrier("MM5000000002", null);
        api(sent).forParcel(0L).recognizeCarrier("MM5000000003", null);
        api(sent).forParcel(-5L).recognizeCarrier("MM5000000004", null);
        api(sent).forParcel(System.currentTimeMillis() + 24L * HOUR).recognizeCarrier("MM5000000005", null);
        assertEquals(4, sent.size());
        for (JSONObject payload : sent) assertFalse(payload.toString(), payload.has("parcelAnchorAtMs"));
    }

    @Test public void theAnchorIsTheParcelsEarliestTimedNodeThenItsStatusThenItsLatestTime() throws Exception {
        long now = System.currentTimeMillis();
        String earliest = time(now - 50L * HOUR);
        String later = time(now - 2L * HOUR);
        ExpressQueryResult nodes = result(new JSONArray()
                .put(new JSONObject().put("time", later).put("context", "派送中"))
                .put(new JSONObject().put("time", earliest).put("context", "已揽收")).toString(),
                now - HOUR, later);
        assertEquals(me.pipi.deliveries.model.ExpressTimeline.parseTime(earliest),
                WaybillReusePolicy.parcelAnchorAt(nodes, now));
        assertEquals("no node: the status time", now - HOUR,
                WaybillReusePolicy.parcelAnchorAt(result("[]", now - HOUR, later), now));
        assertEquals("no node, no status time: the latest time",
                me.pipi.deliveries.model.ExpressTimeline.parseTime(later),
                WaybillReusePolicy.parcelAnchorAt(result("[]", 0L, later), now));
        assertEquals("only future times: none", 0L,
                WaybillReusePolicy.parcelAnchorAt(result("[]", now + HOUR, time(now + 2L * HOUR)), now));
    }

    private static ExpressQueryResult result(String tracks, long statusAt, String latestTime) {
        return new ExpressQueryResult("MM5000000006", "", "", StatusSemantic.TRANSIT, statusAt, latestTime,
                "派送中", tracks, "", "", "v6_list", "", "", "");
    }

    private static String time(long at) {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss",
                java.util.Locale.ROOT);
        format.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new java.util.Date(at / 1000L * 1000L));
    }

    /** The free level knows no built-in carrier, so every recognition reaches the paid level. */
    private static ExpressApi api(List<JSONObject> sent) {
        return new ExpressApi(new ExpressGatewayTransport() {
            @Override public boolean configured() { return true; }

            @Override public HttpClient.Response post(String path, JSONObject payload) throws Exception {
                assertEquals("/api/express/classify", path);
                sent.add(new JSONObject(payload.toString()));
                return new HttpClient.Response(200, new JSONObject().put("auto", new JSONArray()
                        .put(new JSONObject().put("comCode", "JTSD"))).toString()
                        .getBytes(StandardCharsets.UTF_8));
            }
        }, new Kuaidi100CarrierDetector((url, cancellation) -> new HttpClient.Response(200,
                new JSONObject().put("auto", new JSONArray()).toString().getBytes(StandardCharsets.UTF_8))));
    }
}
