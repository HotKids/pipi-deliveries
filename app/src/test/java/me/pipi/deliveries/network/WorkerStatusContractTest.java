package me.pipi.deliveries.network;

import static org.junit.Assert.*;
import java.util.Arrays;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.model.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class WorkerStatusContractTest {
    private static final long EVENT = 1789290913000L;

    private static JSONObject projection(String semantic, String code, String text, int priority, long time) throws Exception {
        return new JSONObject().put("version", 1).put("scope", "SHIPMENT")
                .put("semantic", semantic).put("code", code).put("text", text)
                .put("priority", priority).put("eventAtMs", time)
                .put("structured", !"UNKNOWN".equals(semantic));
    }

    private static JSONArray tracks() throws Exception {
        return new JSONArray().put(new JSONObject().put("time", "2026-09-13 16:35:13")
                .put("context", "配送更新"))
                .put(new JSONObject().put("time", "2026-09-12 09:00:00").put("context", "已揽收"));
    }

    private static ExpressQueryResult online(JSONObject status, String raw, String description) throws Exception {
        JSONObject body = new JSONObject().put("code", 200).put("normalizedStatus", status)
                .put("value", new JSONObject().put("nu", "EMS8021").put("com", "EMS")
                        .put("status", raw).put("stateName", description).put("data", tracks()));
        return ExpressSubscriptionClient.parseManualResponse(body.toString(), "EMS8021");
    }

    @Test public void workerProjectionOwnsSupportedParsersAndNeverGuessesUnknown() throws Exception {
        JSONObject unknown = projection("UNKNOWN", "", "", 0, 0);
        JSONObject account5 = new JSONObject().put("mailNo", "EMS8021").put("provider", "Cainiao")
                .put("stateNum", 107).put("state", "已签收").put("details", tracks())
                .put("normalizedStatus", unknown);
        ExpressQueryResult v5 = ExpressDiscoveryClient.parseExpress(account5, "", "");
        assertNotNull(v5);
        assertEquals(StatusSemantic.UNKNOWN, v5.semantic);
        assertEquals(0L, v5.statusEventTime);
        assertFalse(v5.structuredStatusEvidence);
        JSONObject account6 = new JSONObject().put("mailNo", "EMS8021").put("logsiticsStatus", "SIGN")
                .put("logisticsStatusDesc", "已签收").put("lastLogisticDetail", "物流更新")
                .put("logisticsGmtModified", "2026-09-13 16:35:13")
                .put("packageDyn", new JSONObject().put("secretKey", "synthetic-never-copy"))
                .put("normalizedStatus", unknown);
        ExpressQueryResult v6 = ExpressSubscriptionClient.parseExpress(account6, "", "");
        assertEquals(StatusSemantic.UNKNOWN, v6.semantic);
        assertFalse(v6.tracksJson.contains("synthetic-never-copy"));
        assertEquals(0, ExpressTimeline.parse(v6.tracksJson, "", "").size());
        assertEquals(StatusSemantic.UNKNOWN, online(unknown, "SIGN", "已签收").semantic);
        ExpressQueryResult k100 = ExpressApi.parse("EMS8021", "ems",
                new JSONObject().put("state", "3").put("data", tracks()).put("normalizedStatus", unknown));
        assertEquals(StatusSemantic.UNKNOWN, k100.semantic);
        assertEquals(0L, k100.statusEventTime);
    }

    @Test public void projectionLabelAndPairedTimeSurviveCacheAndWholeHistorySelection() throws Exception {
        ExpressQueryResult station = online(projection("DELIVERY", "STA_DELIVERING", "驿站派送中", 1, EVENT),
                "TRANSPORT", "运输中");
        assertEquals(StatusSemantic.DELIVERY, station.semantic);
        assertEquals("驿站派送中", station.statusDescription);
        assertEquals(EVENT, station.statusEventTime);
        assertTrue(station.structuredStatusEvidence);
        ExpressQueryResult cached = new ExpressQueryResult(station.waybill, station.courierCode,
                station.companyName, station.semantic, station.statusEventTime,
                station.latestTime, station.latestDetail, station.tracksJson, "", "", "v6_query", "", "", "")
                .withManualStatusEvidence(station.statusDescription, station.structuredStatusEvidence);
        assertEquals(1, cached.workerStatus.priority);
        ExpressQueryResult plain = new ExpressQueryResult("EMS8021", "EMS", "EMS", StatusSemantic.DELIVERY,
                EVENT + 60000, "2026-09-13 16:36:13", "whole H5 history", tracks().toString(),
                "", "", "k100_h5", "", "", "")
                .withManualStatusEvidence("派送中", true);
        ExpressQueryResult chosen = ManualTimelineAuthorityPolicy.presentationResult(plain, Arrays.asList(
                new ManualTimelineAuthorityPolicy.Candidate("k100_h5", plain, 1, true),
                new ManualTimelineAuthorityPolicy.Candidate("v6_query", cached, 1, false)));
        assertEquals("k100_h5", chosen.timelineProvider);
        assertEquals("whole H5 history", chosen.latestDetail);
        assertEquals(EVENT, chosen.statusEventTime);
        ExpressItem item = new ExpressItem(1, "", "EMS8021", "EMS", "EMS", chosen.semantic,
                chosen.statusDescription, chosen.latestDetail, chosen.latestTime, chosen.tracksJson,
                "", "manual", "", chosen.statusEventTime, 1, "manual", "");
        assertEquals("驿站派送中", item.displayStatus());
        ExpressItem changedTime = new ExpressItem(1, "", "EMS8021", "EMS", "EMS", chosen.semantic,
                chosen.statusDescription, chosen.latestDetail, chosen.latestTime, chosen.tracksJson,
                "", "manual", "", chosen.statusEventTime + 1, 1, "manual", "");
        assertEquals("派送中", changedTime.displayStatus());
        ExpressQueryResult arbitraryLabel = online(projection("DELIVERY", "SERVER_SUBTYPE", "Worker delivery label", 3, EVENT), "", "");
        assertEquals("Worker delivery label", arbitraryLabel.statusDescription);
    }

    @Test public void sameSourcePriorityNeverOverridesTerminalOrChangesHistoryCount() throws Exception {
        ExpressQueryResult station = online(projection("DELIVERY", "STA_DELIVERING", "驿站派送中", 1, EVENT), "", "");
        ExpressQueryResult plain = online(projection("DELIVERY", "DELIVERING", "派送中", 0, EVENT + 60000), "", "");
        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(station, plain);
        assertEquals(EVENT, merged.statusEventTime);
        assertEquals(1, merged.workerStatus.priority);
        assertEquals(2, ExpressTimeline.parse(merged.tracksJson, "", "").size());
        ExpressQueryResult signed = online(projection("COMPLETED", "SIGN", "已签收", 0, EVENT + 120000), "", "");
        assertEquals(StatusSemantic.COMPLETED, Kuaidi100TimelinePolicy.merge(station, signed).semantic);
        assertEquals(StatusSemantic.COMPLETED, Kuaidi100TimelinePolicy.merge(signed, station).semantic);
    }

    @Test public void workerMissingOrFutureCompletionTimeCannotFreezeFromSignedProse() throws Exception {
        long now = System.currentTimeMillis();
        for (long time : new long[]{0L, now + 60000L}) {
            ExpressQueryResult signed = online(projection("COMPLETED", "SIGN", "已签收", 0, time), "SIGN", "已签收");
            assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(null, signed, now));
        }
        assertFalse(Kuaidi100TimelinePolicy.shouldRefresh(null,
                online(projection("COMPLETED", "SIGN", "已签收", 0, now - 1), "SIGN", "已签收"), now));
    }

    @Test public void unknownNodeProjectionBlocksLocalRawEnumFallbackAndLegacyStillWorks() throws Exception {
        JSONArray values = new JSONArray().put(new JSONObject().put("time", "2026-09-13 16:35:13")
                .put("context", "物流更新").put("status", "SIGN")
                .put("normalizedStatus", projection("UNKNOWN", "SIGN", "暂无状态", 0, 0)));
        assertEquals(StatusSemantic.UNKNOWN, ExpressTimeline.latestTrackStatuses(values.toString(), "v6_query").get(0));
        assertEquals(StatusSemantic.COMPLETED, online(null, "SIGN", "已签收").semantic);
        JSONObject unsupported = projection("DELIVERY", "STA_DELIVERING", "驿站派送中", 1, EVENT).put("version", 2);
        assertEquals(StatusSemantic.TRANSIT, online(unsupported, "TRANSPORT", "运输中").semantic);
    }

    @Test public void normalizedBusinessErrorRejectsSuccessfulHttpBeforeProviderParsing() throws Exception {
        JSONObject body = new JSONObject().put("code", 200)
                .put("normalizedError", new JSONObject().put("version", 1).put("code", "upstream_business_error"))
                .put("data", new JSONObject().put("nu", "EMS8021").put("data", tracks()));
        assertThrows(IllegalStateException.class,
                () -> ExpressSubscriptionClient.parseManualResponse(body.toString(), "EMS8021"));
    }
}
