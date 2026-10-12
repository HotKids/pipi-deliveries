package me.pipi.deliveries.model;

import static org.junit.Assert.*;

import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Read-only timeline reuse must preserve provider meaning and mutable packet isolation. */
public final class ExpressTimelineRawReadScopeTest {
    private static final String PACKET = "[{\"time\":\"2026-09-06 12:00:00\","
            + "\"context\":\"运输中\",\"statusCode\":102},{\"time\":\"2026-09-06 09:00:00\","
            + "\"context\":\"已揽收\",\"statusCode\":1}]";

    @Test public void sharedRawNodesStillUseEachCallersProviderAndForeignAnchor() {
        ExpressTimeline.withParsedTracks(() -> {
            assertEquals(List.of(StatusSemantic.SHIPPED),
                    ExpressTimeline.latestTrackStatuses(PACKET, "interface5"));
            assertEquals(List.of(StatusSemantic.ORDERED),
                    ExpressTimeline.latestTrackStatuses(new String(PACKET), "k100_h5"));
            long first = ExpressTimeCodec.parse("2026-09-06 09:00:00");
            assertEquals(first - ExpressTimeline.FOREIGN_PACKAGE_ANCHOR_SLACK_MS,
                    ExpressTimeline.foreignPackageAnchorMillis(PACKET));
            assertEquals(first, ExpressTimeline.accountListOriginAtMillis(PACKET));
            assertTrue(ExpressTimeline.isForeignPackage(first + 1L, PACKET));
            assertFalse(ExpressTimeline.isForeignPackage(first, PACKET));
            return null;
        });
    }

    @Test public void mutableMergeCannotDonateMetadataBackIntoReadOnlyNodes() {
        String plain = "[{\"time\":\"2026-09-06 12:00:00\",\"context\":\"事件\"}]";
        String status = "[{\"time\":\"2026-09-06 12:00:00\",\"context\":\"事件\","
                + "\"statusCode\":3,\"location\":\"synthetic\"}]";
        String expected = ExpressTimeline.mergeJson(status, plain);
        ExpressTimeline.withParsedTracks(() -> {
            assertEquals(List.of(StatusSemantic.UNKNOWN),
                    ExpressTimeline.latestTrackStatuses(plain, "k100_h5"));
            String merged = ExpressTimeline.mergeJson(status, plain);
            assertEquals(expected, merged);
            assertEquals(List.of(StatusSemantic.COMPLETED),
                    ExpressTimeline.latestTrackStatuses(merged, "k100_h5"));
            assertEquals(List.of(StatusSemantic.UNKNOWN),
                    ExpressTimeline.latestTrackStatuses(plain, "k100_h5"));
            assertEquals(expected, ExpressTimeline.mergeJson(status, plain));
            return null;
        });
    }

    @Test public void appendedOwnerRowsKeepOriginalPacketsAndWrapperMetadata() {
        String fallback = "{\"data\":[{\"time\":\"2026-09-06 12:00:00\","
                + "\"context\":\"运输中\",\"statusCode\":0}],\"normalizedStatus\":{\"semantic\":\"TRANSIT\"}}";
        String owner = "[{\"time\":\"2026-09-06 09:00:00\",\"context\":\"已下单\","
                + "\"statusCode\":101,\"_pipiStatusSource\":\"interface5\"}]";
        String expected = ExpressTimeline.appendOwnerOrderStage(fallback, owner);
        ExpressTimeline.withParsedTracks(() -> {
            List<StatusSemantic> before = ExpressTimeline.latestTrackStatuses(owner, "interface5");
            String appended = ExpressTimeline.appendOwnerOrderStage(fallback, owner);
            assertEquals(expected, appended);
            try {
                JSONObject root = new JSONObject(appended);
                assertEquals("TRANSIT", root.getJSONObject("normalizedStatus").getString("semantic"));
                assertEquals(2, root.getJSONArray("data").length());
                assertEquals("2026-09-06 09:00:00", root.getJSONArray("data").getJSONObject(1).getString("time"));
                assertEquals(before, ExpressTimeline.latestTrackStatuses(owner, "interface5"));
                assertEquals(1, new JSONArray(owner).length());
                assertEquals(1, new JSONObject(fallback).getJSONArray("data").length());
            } catch (org.json.JSONException invalid) {
                throw new AssertionError(invalid);
            }
            return null;
        });
    }

    @Test public void providerErrorResultDoesNotComeFromTheFilteredRawTimeline() {
        String error = "[{\"time\":\"2026-09-06 12:00:00\",\"context\":\"验证码错误，请重试\"}]";
        ExpressTimeline.withParsedTracks(() -> {
            assertTrue(ExpressTimeline.latestTrackStatuses(error, "k100_h5").isEmpty());
            assertTrue(ExpressTimeline.containsProviderError(error));
            assertTrue(ExpressTimeline.containsProviderError(new String(error)));
            assertFalse(ExpressTimeline.containsProviderError(PACKET));
            assertFalse(ExpressTimeline.containsProviderError(new String(PACKET)));
            assertTrue(ExpressTimeline.latestTrackStatuses(error, "k100_h5").isEmpty());
            return null;
        });
    }

    @Test public void recoveryAndNestedReadsKeepTheirOriginalOutputs() {
        String recovered = "{\"data\":\"{\",\"traces\":" + PACKET + "}";
        ExpressTimeline.withParsedTracks(() -> {
            List<ExpressTimeline.Track> outer = ExpressTimeline.parse(PACKET, "", "", "interface5");
            ExpressTimeline.withParsedTracks(() -> {
                assertEquals(List.of(StatusSemantic.SHIPPED),
                        ExpressTimeline.latestTrackStatuses(recovered, "interface5"));
                assertFalse(ExpressTimeline.containsProviderError(recovered));
                assertTrue(ExpressTimeline.latestTrackStatuses("{", "interface5").isEmpty());
                return null;
            });
            assertSame(outer, ExpressTimeline.parse(PACKET, "", "", "interface5"));
            assertEquals(List.of(StatusSemantic.SHIPPED),
                    ExpressTimeline.latestTrackStatuses(PACKET, "interface5"));
            assertTrue(ExpressTimeline.latestTrackStatuses(null, "interface5").isEmpty());
            assertFalse(ExpressTimeline.containsProviderError(""));
            return null;
        });
    }
}
