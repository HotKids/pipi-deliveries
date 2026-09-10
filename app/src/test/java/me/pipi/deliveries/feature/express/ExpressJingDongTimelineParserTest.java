package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public class ExpressJingDongTimelineParserTest {
    private static final String WAYBILL = "JD123456789012";

    private static ExpressItem owner(String projected) {
        return new ExpressItem(1L, "", "ORDER123456", "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单正在配送", "2026-09-08 12:00:00",
                "[]", "", "I5-JD", "", 1L, 2L, "I5-JD", "", "v5", "", true,
                projected, "", "[]", "JingDong");
    }

    private static JSONObject envelope(String waybill, int count, boolean proof, boolean dom)
            throws Exception {
        JSONArray tracks = new JSONArray();
        for (int index = 0; index < count; index++) {
            tracks.put(new JSONObject().put("operateTime", "2026-09-08 10:0" + index + ":00")
                    .put("operateMessage", "运输节点 " + index).put("waybillCode", waybill));
        }
        JSONObject info = new JSONObject().put("waybillCode", waybill)
                .put("companyName", "京东快递").put("traceList", tracks);
        return new JSONObject().put("wholePayload", new JSONObject().put("data",
                        new JSONObject().put("floors", new JSONArray().put(new JSONObject()
                                .put("element", new JSONObject().put("info", info))))).toString())
                .put("source", dom ? "dom" : "network")
                .put("fullProgressRequestedAtStart", proof);
    }

    private static ExpressJingDongTimelineParser.Packet parse(JSONObject... envelopes) throws Exception {
        JSONArray queue = new JSONArray();
        for (JSONObject envelope : envelopes) queue.put(envelope.toString());
        return ExpressJingDongTimelineParser.parse(new JSONObject().put("q", queue).toString(), owner(""));
    }

    @Test public void requestStartProofKeepsDelayedPreClickResponsePartial() throws Exception {
        assertFalse(parse(envelope(WAYBILL, 1, false, false)).complete);
        assertTrue(parse(envelope(WAYBILL, 1, true, false)).complete);
        assertTrue(parse(envelope(WAYBILL, 2, false, false)).complete);
    }

    @Test public void separatePartialResponsesNeverBecomeACombinedTimeline() throws Exception {
        JSONObject first = envelope(WAYBILL, 1, false, false);
        JSONObject second = envelope(WAYBILL, 1, false, false);
        second.put("wholePayload", second.getString("wholePayload")
                .replace("10:00:00", "11:00:00").replace("节点 0", "另一个节点"));
        ExpressJingDongTimelineParser.Packet result = parse(first, second);
        assertFalse(result.complete);
        assertEquals(1, new JSONArray(result.timeline.tracksJson).length());
        assertEquals("2026-09-08 11:00:00", result.timeline.latestTime);
    }

    @Test public void projectionCannotChangeAnAlreadyKnownWaybill() throws Exception {
        String captured = new JSONObject().put("q", new JSONArray()
                .put(envelope(WAYBILL, 2, false, false))).toString();
        assertNotNull(ExpressJingDongTimelineParser.parse(captured, owner(WAYBILL)).timeline);
        assertNull(ExpressJingDongTimelineParser.parse(captured, owner("JD999999999999")).timeline);
    }

    @Test public void conflictingIdentitiesRejectTheWholeResponse() throws Exception {
        JSONObject captured = envelope(WAYBILL, 2, false, false);
        JSONObject body = new JSONObject(captured.getString("wholePayload"));
        body.put("other", new JSONObject().put("waybillCode", "OTHER123456"));
        captured.put("wholePayload", body.toString());
        assertNull(parse(captured).timeline);
    }

    @Test public void identityOnlyDoesNotInventTracksOrACompleteFlag() throws Exception {
        ExpressJingDongTimelineParser.Packet result = parse(envelope(WAYBILL, 0, true, false));
        assertEquals(WAYBILL, result.timeline.waybill);
        assertEquals("[]", result.timeline.tracksJson);
        assertFalse(result.complete);
    }

    @Test public void h5CannotBecomeTheOwnersStructuredStatus() throws Exception {
        JSONObject captured = envelope(WAYBILL, 2, false, false);
        captured.put("wholePayload", captured.getString("wholePayload").replace("运输节点 1", "已签收"));
        ExpressJingDongTimelineParser.Packet result = parse(captured);
        assertEquals(StatusSemantic.UNKNOWN, result.timeline.semantic);
        assertEquals(0L, result.timeline.statusEventTime);
        assertFalse(result.timeline.structuredStatusEvidence);
        assertEquals("已签收", result.timeline.latestDetail);
        assertEquals("jd_h5", result.timeline.timelineProvider);
    }

    @Test public void modalMustMatchNetworkIdentityAndCoverItsTracks() throws Exception {
        ExpressJingDongTimelineParser.Packet shorter = parse(
                envelope(WAYBILL, 3, false, false), envelope(WAYBILL, 1, true, true));
        assertTrue(shorter.complete);
        assertEquals(3, new JSONArray(shorter.timeline.tracksJson).length());
        ExpressJingDongTimelineParser.Packet mismatch = parse(
                envelope(WAYBILL, 1, false, false), envelope("OTHER123456", 2, true, true));
        assertEquals(WAYBILL, mismatch.timeline.waybill);
        assertFalse(mismatch.complete);
        assertTrue(parse(envelope(WAYBILL, 1, false, false),
                envelope(WAYBILL, 1, true, true)).complete);
    }

    @Test public void evictedNetworkPacketsStillConstrainModalCompleteness() throws Exception {
        String captured = new JSONObject().put("n", 4).put("q", new JSONArray()
                .put(envelope(WAYBILL, 2, true, true))).toString();
        assertFalse(ExpressJingDongTimelineParser.parse(captured, owner("")).complete);
    }

    @Test public void riskControlSurvivesAnEmptyOrInvalidQueue() throws Exception {
        ExpressJingDongTimelineParser.Packet result = ExpressJingDongTimelineParser.parse(
                new JSONObject().put("k", true).put("q", new JSONArray()).toString(), owner(""));
        assertTrue(result.throttled);
        assertNull(result.timeline);
        assertNull(ExpressJingDongTimelineParser.parse("broken", owner("")).timeline);
    }

    @Test public void webViewEncodedPayloadAndExactModalSelectorsAreSupported() throws Exception {
        String wire = new JSONObject().put("q", new JSONArray()
                .put(envelope(WAYBILL, 2, false, false))).toString();
        assertTrue(ExpressJingDongTimelineParser.parse(JSONObject.quote(wire), owner("")).complete);
        String script = ExpressJingDongTimelineParser.probeScript();
        assertTrue(script.contains("fullProgressRequestedAtStart"));
        assertTrue(script.contains("==='完整物流进度'"));
        assertTrue(script.contains(".logistics-status-info.child-status"));
        assertFalse(script.contains("querySelectorAll('.logistics-status-info')"));
        assertFalse(script.contains("document.cookie"));
    }
}
