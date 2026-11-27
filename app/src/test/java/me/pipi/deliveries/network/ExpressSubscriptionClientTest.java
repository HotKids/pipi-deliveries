package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.SharedExpressFixtures;
import me.pipi.deliveries.data.CarrierAuthorityFixture;
import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.feature.express.ExpressStatusColors;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;

import java.util.Collections;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class ExpressSubscriptionClientTest {
    @Test
    public void normalizedPhoneChallengeSurvivesTheManualQueryRound() throws Exception {
        String body = new JSONObject().put("normalizedError", new JSONObject()
                .put("version", 1).put("code", "phone_verification_required")).toString();
        try {
            ManualQueryCoordinator.queryOnlineFirst(
                    () -> ExpressSubscriptionClient.parseManualResponse(body, "TEST123456"),
                    null, null, false);
            org.junit.Assert.fail("Expected the phone input challenge");
        } catch (Exception failure) {
            assertTrue(failure instanceof ExpressApi.QueryException);
            assertTrue(((ExpressApi.QueryException) failure).needsPhoneTail());
            assertEquals(false, ((ExpressApi.QueryException) failure).phoneTailMismatch());
        }
    }

    @Test
    public void manualResponseDerivesHeadlineFromTimelineArray() throws Exception {
        JSONObject result = new JSONObject()
                .put("nu", "TEST123456")
                .put("com", "ZTO")
                .put("name", "中通快递")
                .put("status", "3")
                .put("detailUrl", "https://m.kuaidi100.com/result.jsp?nu=TEST123456")
                .put("data", new JSONArray()
                        .put(new JSONObject()
                                .put("time", "2026-08-22 09:00:00")
                                .put("context", "快件已揽收"))
                        .put(new JSONObject()
                                .put("time", "2026-08-22 10:00:00")
                                .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "TEST123456");

        assertEquals("2026-08-22 10:00:00", parsed.latestTime);
        assertEquals("快件运输中", parsed.latestDetail);
        assertEquals("v6_query", parsed.timelineProvider);
        assertEquals("https://m.kuaidi100.com/result.jsp?nu=TEST123456",
                parsed.detailUrl);
        assertTrue(Kuaidi100TimelinePolicy.hasRealTracking(parsed));
        assertTrue(Kuaidi100TimelinePolicy.hasTimedTracking(parsed));
    }

    @Test
    public void accountMetadataNeverBecomesALocalTimeline() throws Exception {
        JSONObject account = new JSONObject()
                .put("mailNo", "TEST654321")
                .put("cpCode", "ZTO")
                .put("cpName", "中通快递")
                .put("logsiticsStatus", "TRANSPORT")
                .put("logisticsStatusDesc", "运输中")
                .put("lastLogisticDetail", "快件运输中")
                .put("logisticsGmtModified", "2026-08-24 09:00:00")
                .put("packageDyn", new JSONObject()
                        .put("secretKey", "must-not-be-a-track")
                        .put("estimate", "今天送达"));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseExpress(
                account, "", "");

        assertEquals("[]", parsed.tracksJson);
        assertEquals(false, Kuaidi100TimelinePolicy.hasRealTracking(parsed));
    }

    @Test
    public void jdPrefixNormalizesDisplayWithoutRewritingMeizuCpCode() throws Exception {
        JSONObject result = new JSONObject()
                .put("nu", "JDTEST123456")
                .put("cpCode", "JDVD")
                .put("status", "2")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-01 12:00:00")
                        .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JDTEST123456");

        assertEquals("JDVD", parsed.courierCode);
        assertEquals("京东快递", parsed.companyName);
    }

    @Test(expected = IllegalStateException.class)
    public void meizuProviderErrorCannotBecomeABestEffortPreview() throws Exception {
        JSONObject result = new JSONObject()
                .put("mailNo", "JDTEST654321")
                .put("cpCode", "JD")
                .put("time", "2026-09-02 10:45:00")
                .put("message", "验证码错误，请重试");

        ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JDTEST654321");
    }

    @Test
    public void meizuMixedResponseKeepsRealSiblingAndDropsProviderError() throws Exception {
        JSONObject result = new JSONObject()
                .put("mailNo", "JDTEST777777")
                .put("cpCode", "JD")
                .put("data", new JSONArray()
                        .put(new JSONObject()
                                .put("time", "2026-09-02 10:45:00")
                                .put("message", "验证码错误，请重试"))
                        .put(new JSONObject()
                                .put("time", "2026-09-02 10:46:00")
                                .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JDTEST777777");

        assertEquals(1, new JSONArray(parsed.tracksJson).length());
        assertEquals("快件运输中", parsed.latestDetail);
        assertEquals(false, parsed.tracksJson.contains("验证码错误"));
    }

    @Test
    public void meizuRootErrorStatusCannotOwnARealSibling() throws Exception {
        JSONObject result = new JSONObject()
                .put("mailNo", "JDTEST888888")
                .put("cpCode", "JD")
                .put("time", "2026-09-02 10:45:00")
                .put("message", "验证码错误，请重试")
                .put("status", "SIGN")
                .put("stateName", "已签收")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-02 10:46:00")
                        .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JDTEST888888");

        assertEquals(StatusSemantic.UNKNOWN, parsed.semantic);
        assertEquals(false, parsed.structuredStatusEvidence);
        assertEquals("快件运输中", parsed.latestDetail);
        assertEquals(1, new JSONArray(parsed.tracksJson).length());
    }

    @Test(expected = IllegalStateException.class)
    public void meizuResponseCannotReturnAnotherWaybill() throws Exception {
        JSONObject result = new JSONObject()
                .put("mailNo", "JD-OTHER-654321")
                .put("cpCode", "JD")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-02 11:00:00")
                        .put("context", "快件运输中")));

        ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JD-EXPECTED-123456");
    }

    @Test
    public void meizuResponseAcceptsEquivalentNormalizedWaybill() throws Exception {
        JSONObject result = new JSONObject()
                .put("mailNo", "jd expected-123456")
                .put("cpCode", "JD")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-02 11:00:00")
                        .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JD-EXPECTED-123456");

        assertEquals("jd expected-123456", parsed.waybill);
    }

    @Test
    public void meizuResponseWithoutIdentityUsesRequestedWaybill() throws Exception {
        JSONObject result = new JSONObject()
                .put("cpCode", "JD")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("time", "2026-09-02 11:00:00")
                        .put("context", "快件运输中")));

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JD-EXPECTED-123456");

        assertEquals("JD-EXPECTED-123456", parsed.waybill);
    }

    @Test(expected = IllegalStateException.class)
    public void meizuNestedResponseCannotDeclareAnotherWaybill() throws Exception {
        JSONObject result = new JSONObject()
                .put("cpCode", "JD")
                .put("data", new JSONArray().put(new JSONObject()
                        .put("mailNo", "JD-OTHER-654321")
                        .put("time", "2026-09-02 11:00:00")
                        .put("context", "不应采用的轨迹")));

        ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", result).toString(),
                "JD-EXPECTED-123456");
    }

    /** online refresh（queryByMailNoOnline）回的是列表记录形状，也要解成一条带时间的节点。 */
    @Test
    public void refreshRecordParsesIntoOneTimedOnlineTrack() throws Exception {
        JSONObject record = new JSONObject()
                .put("mailNo", "SF1234567890")
                .put("cpCode", "SF")
                .put("logsiticsStatus", "3")
                .put("lastLogisticDetail", "快件已到达【深圳中转场】")
                .put("logisticsGmtModified", "2026-09-05 18:20:00")
                .put("detailUrl", "https://m.kuaidi100.com/result.jsp?nu=SF1234567890");

        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 200).put("value", record.toString()).toString(),
                "SF1234567890");

        assertEquals("2026-09-05 18:20:00", parsed.latestTime);
        assertEquals("快件已到达【深圳中转场】", parsed.latestDetail);
        assertEquals("v6_query", parsed.timelineProvider);
        assertTrue(Kuaidi100TimelinePolicy.hasTimedTracking(parsed));
    }

    // Owner decision 2026-11-20 (「清关中怎么变成了异常件 应该属于运输中吧 然后如果可以抓到清关中的状态就显示清关中
    // 属于运输中的分支」): Meizu v6 puts Kuaidi100's customs states into its coarse FAILED bucket and keeps the
    // structured state name in logisticsStatusDesc (VPS raw Online answer, waybill replaced).
    private static final String CUSTOMS_WAYBILL = "77100000000001";
    private static final String CUSTOMS_TIME = "2026-11-20 17:28:31";
    private static final long CUSTOMS_AT = 1795166911000L;

    private static JSONObject customsRecord(String description) throws Exception {
        JSONObject record = new JSONObject()
                .put("mailNo", CUSTOMS_WAYBILL)
                .put("cpCode", "zhongtongguoji")
                .put("cpName", "中通国际")
                .put("fromCp", "KD-100")
                .put("logisticsStatus", "FAILED")
                .put("lastLogisticDetail", "[中国]进行处理，快件已开始清关")
                .put("logisticsGmtModified", CUSTOMS_TIME);
        if (description != null) record.put("logisticsStatusDesc", description);
        return record;
    }

    private static ExpressQueryResult customsOnline(String description) throws Exception {
        return ExpressSubscriptionClient.parseManualResponse(new JSONObject().put("code", 200)
                .put("value", customsRecord(description).toString()).toString(), CUSTOMS_WAYBILL);
    }

    /** Both Worker tracks and the formal-generated bundled table carry the subtype; tests pin it here. */
    private static void installCustomsSubtype() throws Exception {
        JSONObject table = SharedExpressFixtures.load("status-labels.v1.json").getJSONObject("table");
        JSONArray subtypes = new JSONArray();
        for (int index = 0; index < table.getJSONArray("subtypes").length(); index++) {
            JSONObject subtype = table.getJSONArray("subtypes").getJSONObject(index);
            if (!"CUSTOMS_CLEARANCE".equals(subtype.optString("code"))) subtypes.put(subtype);
        }
        subtypes.put(new JSONObject().put("semantic", "TRANSIT").put("code", "CUSTOMS_CLEARANCE")
                .put("label", "清关中").put("priority", 1));
        table.put("subtypes", subtypes);
        CarrierRegistry.installAuthority(CarrierRegistry.prepareAuthority(
                CarrierAuthorityFixture.payload().put("statusLabels", table)));
    }

    private static void restoreBundledLabels() throws Exception {
        CarrierRegistry.installAuthority(CarrierRegistry.prepareAuthority(
                CarrierAuthorityFixture.payload()));
    }

    private static ExpressItem item(ExpressQueryResult parsed) {
        return new ExpressItem(1L, "", parsed.waybill, "ZTO", "中通快递", parsed.semantic,
                parsed.statusDescription, parsed.latestDetail, parsed.latestTime, parsed.tracksJson,
                "", "MANUAL", "", parsed.statusEventTime, 0L, "", "");
    }

    @Test
    public void onlineFailedWithCustomsClearanceDescriptionIsTheTransitSubtype() throws Exception {
        installCustomsSubtype();
        try {
            ExpressQueryResult parsed = customsOnline("清关中");
            assertEquals(StatusSemantic.TRANSIT, parsed.semantic);
            assertEquals("CUSTOMS_CLEARANCE", parsed.workerStatus.code);
            assertEquals("清关中", parsed.workerStatus.text);
            assertEquals(1, parsed.workerStatus.priority);
            assertEquals(CUSTOMS_AT, parsed.statusEventTime);
            assertTrue(parsed.structuredStatusEvidence);
            ExpressItem row = item(parsed);
            assertEquals("清关中", row.displayStatus());
            // Sorting, filters and notification groups follow TRANSIT; 清关中 uses its dedicated light text #00796B and shares dark #4DB6AC.
            assertEquals(ExpressStatusColors.accent(StatusSemantic.TRANSIT, "清关中", false),
                    ExpressStatusColors.accent(row.semantic, row.displayStatus(), false));
            assertNotEquals(ExpressStatusColors.accent(StatusSemantic.TRANSIT, "运输中", false),
                    ExpressStatusColors.accent(row.semantic, row.displayStatus(), false));
            assertEquals(ExpressStatusColors.accent(StatusSemantic.TRANSIT, "运输中", true),
                    ExpressStatusColors.accent(row.semantic, row.displayStatus(), true));
            assertNotEquals(ExpressStatusColors.accent(StatusSemantic.DANGER, "异常件", false),
                    ExpressStatusColors.accent(row.semantic, row.displayStatus(), false));

            JSONObject named = customsRecord(null).put("stateName", "清关中");
            assertEquals("CUSTOMS_CLEARANCE", ExpressSubscriptionClient.parseManualResponse(
                    new JSONObject().put("code", 200).put("value", named.toString()).toString(),
                    CUSTOMS_WAYBILL).workerStatus.code);
        } finally {
            restoreBundledLabels();
        }
    }

    @Test
    public void onlineFailedWithPendingOrClearedCustomsIsTransit() throws Exception {
        for (String description : new String[]{"待清关", "已清关"}) {
            ExpressQueryResult parsed = customsOnline(description);
            assertEquals(description, StatusSemantic.TRANSIT, parsed.semantic);
            assertEquals(description, "TRANSIT", parsed.workerStatus.code);
            assertEquals(description, "运输中", item(parsed).displayStatus());
        }
    }

    @Test
    public void onlineFailedWithAnyOtherDescriptionStaysDanger() throws Exception {
        for (String description : new String[]{"清关异常", "问题件", "", null, "清关中了"}) {
            ExpressQueryResult parsed = customsOnline(description);
            assertEquals(String.valueOf(description), StatusSemantic.DANGER, parsed.semantic);
            assertNull(String.valueOf(description), parsed.workerStatus);
        }
        JSONObject prose = customsRecord(null).put("lastLogisticDetail", "清关中");
        assertEquals("track text is never status evidence", StatusSemantic.DANGER,
                ExpressSubscriptionClient.parseManualResponse(new JSONObject().put("code", 200)
                        .put("value", prose.toString()).toString(), CUSTOMS_WAYBILL).semantic);
    }

    @Test
    public void sharedProviderFixtureScalarV6CasesGiveTheWorkerAnswer() throws Exception {
        // The Worker-generated provider-status-parity.v1.json ties this local copy of the
        // FAILED-description policy (StatusSemantic.meizuFailedDescriptionCode) to the Worker. Lite's
        // Online parser reads the scalar record only and no tracks container (existing parser contract),
        // so the fixture's multi-node equal-time case is checked by the Worker, Pipi, iOS and the Bot.
        JSONArray cases = SharedExpressFixtures.load("provider-status-parity.v1.json")
                .getJSONArray("cases");
        int count = 0;
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            if (!"v6".equals(value.getString("provider"))) continue;
            JSONObject input = value.getJSONObject("input");
            JSONObject record = new JSONObject(input.getString("value"));
            if (record.has("tracks")) continue;
            count++;
            String name = value.getString("name");
            JSONObject expected = value.getJSONObject("expected");
            // The Worker reads an account list row (parseExpress) through the same v6 node rule.
            ExpressQueryResult online = ExpressSubscriptionClient.parseManualResponse(
                    input.toString(), record.getString("mailNo"));
            ExpressQueryResult listRow = ExpressSubscriptionClient.parseExpress(record, "", "");
            for (ExpressQueryResult parsed : new ExpressQueryResult[]{online, listRow}) {
                String label = name + (parsed == online ? " (Online)" : " (list row)");
                assertEquals(label, expected.getString("semantic"), parsed.semantic.name());
                assertEquals(label, expected.getString("text"), item(parsed).displayStatus());
                if (StatusSemantic.TRANSIT.name().equals(expected.getString("semantic"))) {
                    assertEquals(label, expected.getString("code"), parsed.workerStatus.code);
                    assertEquals(label, expected.getString("text"), parsed.workerStatus.text);
                    assertEquals(label, expected.getInt("priority"), parsed.workerStatus.priority);
                    assertEquals(label, expected.getLong("eventAtMs"), parsed.statusEventTime);
                } else {
                    // Other statuses keep the existing local parser (no projection of its own).
                    assertNull(label, parsed.workerStatus);
                }
            }
        }
        assertTrue("the shared fixture carries the customs v6 cases", count >= 7);
    }

    @Test
    public void onlineReadsTheCorrectlySpelledLogisticsStatusField() throws Exception {
        JSONObject signed = customsRecord("清关中").put("logisticsStatus", "SIGN");
        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 200).put("value", signed.toString()).toString(),
                CUSTOMS_WAYBILL);
        assertEquals("the description refines only FAILED", StatusSemantic.COMPLETED, parsed.semantic);
        assertTrue(parsed.structuredStatusEvidence);
    }

    @Test
    public void aWorkerProjectionStillDecidesTheOnlineStatus() throws Exception {
        JSONObject projected = customsRecord("清关中").put("normalizedStatus", new JSONObject()
                .put("version", 1).put("scope", "SHIPMENT").put("semantic", "DANGER")
                .put("code", "FAILED").put("text", "异常件").put("priority", 0)
                .put("eventAtMs", CUSTOMS_AT).put("structured", true));
        ExpressQueryResult parsed = ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 200).put("value", projected.toString()).toString(),
                CUSTOMS_WAYBILL);
        assertEquals("an older Worker's projection is not reinterpreted", StatusSemantic.DANGER,
                parsed.semantic);
        assertEquals("FAILED", parsed.workerStatus.code);
    }

    /**
     * Third review M-03 ① (2026-11-23): the Online same-provider merge of a refreshed 17:28:31 node (its own coarse
     * FAILED in Meizu's real {@code logsiticsStatus} spelling with the description 清关中, no projection of its own)
     * with its cached copy that still carries an older Worker's FAILED projection. The refreshed node owns the event
     * and must not take that 异常件 projection as missing metadata, or the node reads DANGER beside the package's
     * TRANSIT (status_mismatch). A genuine 清关异常 refresh still agrees with, and takes, the cached projection.
     */
    @Test
    public void aRefreshedCustomsNodeDoesNotTakeTheCachedFailedProjection() throws Exception {
        installCustomsSubtype();
        try {
            JSONObject failed = new JSONObject().put("version", 1).put("scope", "SHIPMENT").put("semantic", "DANGER")
                    .put("code", "FAILED").put("text", "异常件").put("priority", 0)
                    .put("eventAtMs", CUSTOMS_AT).put("structured", true);
            for (String description : new String[]{"清关中", "待清关", "已清关", "清关异常"}) {
                JSONObject node = new JSONObject().put("time", CUSTOMS_TIME)
                        .put("context", "[中国]进行处理，快件已开始清关").put("logsiticsStatus", "FAILED")
                        .put("logisticsStatusDesc", description);
                ExpressQueryResult cached = onlineNodes(new JSONObject(node.toString()).put("normalizedStatus", failed));
                ExpressQueryResult refreshed = onlineNodes(node);
                assertEquals(Collections.singletonList(StatusSemantic.DANGER),
                        ExpressTimeline.latestTrackStatuses(cached.tracksJson, "v6_query"));
                String merged = ExpressTimeline.mergeJson(cached.tracksJson, refreshed.tracksJson);
                assertEquals(description + ": one 17:28:31 node", 1, new JSONArray(merged).length());
                assertEquals(description, Collections.singletonList("清关异常".equals(description)
                        ? StatusSemantic.DANGER : StatusSemantic.TRANSIT),
                        ExpressTimeline.latestTrackStatuses(merged, "v6_query"));
            }
        } finally {
            restoreBundledLabels();
        }
    }

    private static ExpressQueryResult onlineNodes(JSONObject node) throws Exception {
        JSONObject value = new JSONObject().put("mailNo", CUSTOMS_WAYBILL).put("cpCode", "zhongtongguoji")
                .put("data", new JSONArray().put(node));
        return ExpressSubscriptionClient.parseManualResponse(new JSONObject().put("code", 200)
                .put("value", value.toString()).toString(), CUSTOMS_WAYBILL);
    }

    @Test
    public void meizuListRowsReadTheSameCustomsRefinement() throws Exception {
        installCustomsSubtype();
        try {
            ExpressQueryResult customs = ExpressSubscriptionClient.parseExpress(
                    customsRecord("清关中"), "", "");
            assertEquals(StatusSemantic.TRANSIT, customs.semantic);
            assertEquals("CUSTOMS_CLEARANCE", customs.workerStatus.code);
            assertEquals("CUSTOMS_CLEARANCE", WorkerStatusProjection.cached(customs.tracksJson).code);
            assertEquals("清关中", item(customs).displayStatus());
            ExpressQueryResult cleared = ExpressSubscriptionClient.parseExpress(
                    customsRecord("已清关"), "", "");
            assertEquals(StatusSemantic.TRANSIT, cleared.semantic);
            assertEquals("运输中", item(cleared).displayStatus());
            ExpressQueryResult failed = ExpressSubscriptionClient.parseExpress(
                    customsRecord("清关异常"), "", "");
            assertEquals(StatusSemantic.DANGER, failed.semantic);
            assertNull(failed.workerStatus);
        } finally {
            restoreBundledLabels();
        }
    }

    // Owner 2026-11-21 「Read it for every status」 (docs/EXPRESS_OWNERSHIP_PLAN_FINAL_20260830.md §6.4
    // amendment): Lite reads the Meizu v6 coarse fields logsiticsStatus, logisticsStatus, status and state
    // in the Worker's order. The first recognized value decides, an unrecognized value does not mask a
    // recognized one, and recognized values that disagree give no status. Each expected answer below is
    // the generated Beta Worker's answer for the same record (normalizeExpressTimelineResponse("v6") for
    // the Online answer, parcelStatus("v6") for the list row).

    /** A Meizu v6 record with no coarse status field; {@code fields} adds field/value pairs. */
    private static JSONObject coarseRecord(Object... fields) throws Exception {
        JSONObject record = new JSONObject()
                .put("mailNo", CUSTOMS_WAYBILL)
                .put("cpCode", "zhongtongguoji")
                .put("cpName", "中通国际")
                .put("fromCp", "KD-100")
                .put("lastLogisticDetail", "[中国]进行处理，快件已开始清关")
                .put("logisticsGmtModified", CUSTOMS_TIME);
        for (int index = 0; index + 1 < fields.length; index += 2) {
            record.put((String) fields[index], fields[index + 1]);
        }
        return record;
    }

    private static ExpressQueryResult coarseOnline(JSONObject record) throws Exception {
        return ExpressSubscriptionClient.parseManualResponse(new JSONObject().put("code", 200)
                .put("value", record.toString()).toString(), CUSTOMS_WAYBILL);
    }

    /** The Online answer and the list row both read the record; each must give the Worker's answer. */
    private static void assertWorkerReading(String name, JSONObject record, StatusSemantic semantic,
            String customsCode) throws Exception {
        ExpressQueryResult online = coarseOnline(record);
        ExpressQueryResult listRow = ExpressSubscriptionClient.parseExpress(record, "", "");
        for (ExpressQueryResult parsed : new ExpressQueryResult[]{online, listRow}) {
            String label = name + (parsed == online ? " (Online)" : " (list row)");
            assertEquals(label, semantic, parsed.semantic);
            if (customsCode == null) {
                assertNull(label, parsed.workerStatus);
            } else {
                assertEquals(label, customsCode, parsed.workerStatus.code);
                assertEquals(label, CUSTOMS_AT, parsed.statusEventTime);
            }
        }
        if (semantic != StatusSemantic.UNKNOWN) assertTrue(name, online.structuredStatusEvidence);
    }

    @Test
    public void anUnrecognizedCoarseValueDoesNotMaskALaterRecognizedOne() throws Exception {
        installCustomsSubtype();
        try {
            // Before: the first non-empty value of status, state, logsiticsStatus, logisticsStatus decided.
            assertWorkerReading("unrecognized logsiticsStatus, then logisticsStatus SIGN",
                    coarseRecord("logsiticsStatus", "UNSUPPORTED_ENUM", "logisticsStatus", "SIGN"),
                    StatusSemantic.COMPLETED, null);
            assertWorkerReading("unrecognized status, then logisticsStatus FAILED with 清关中",
                    coarseRecord("status", "UNSUPPORTED_ENUM", "logisticsStatus", "FAILED",
                            "logisticsStatusDesc", "清关中"),
                    StatusSemantic.TRANSIT, "CUSTOMS_CLEARANCE");
            assertWorkerReading("a numeric state is no enum; logisticsStatus TRANSPORT decides",
                    coarseRecord("state", 3, "logisticsStatus", "TRANSPORT"),
                    StatusSemantic.TRANSIT, null);
            assertWorkerReading("status alone",
                    coarseRecord("status", "SIGN"), StatusSemantic.COMPLETED, null);
            // The Worker upper-cases the value before the lookup; Lite's common-vocabulary lookup does too.
            assertWorkerReading("lower-case failed with 清关中",
                    coarseRecord("logisticsStatus", "failed", "logisticsStatusDesc", "清关中"),
                    StatusSemantic.TRANSIT, "CUSTOMS_CLEARANCE");
        } finally {
            restoreBundledLabels();
        }
    }

    @Test
    public void theFirstRecognizedCoarseValueInTheWorkerOrderDecides() throws Exception {
        installCustomsSubtype();
        try {
            // logsiticsStatus comes before status: PROBLEM is the Worker's code, so 清关中 does not
            // refine it (the old order read status FAILED first and refined it).
            assertWorkerReading("logsiticsStatus PROBLEM before status FAILED",
                    coarseRecord("status", "FAILED", "logsiticsStatus", "PROBLEM",
                            "logisticsStatusDesc", "清关中"),
                    StatusSemantic.DANGER, null);
            assertWorkerReading("logsiticsStatus FAILED beside state PROBLEM (both DANGER)",
                    coarseRecord("logsiticsStatus", "FAILED", "state", "PROBLEM",
                            "logisticsStatusDesc", "清关中"),
                    StatusSemantic.TRANSIT, "CUSTOMS_CLEARANCE");
            assertWorkerReading("both FAILED spellings with 清关中",
                    coarseRecord("logsiticsStatus", "FAILED", "logisticsStatus", "FAILED",
                            "logisticsStatusDesc", "清关中"),
                    StatusSemantic.TRANSIT, "CUSTOMS_CLEARANCE");
            // Each adjacent pair of the Worker order, FAILED in the earlier field and PROBLEM (also
            // DANGER) in the later one: the earlier field's FAILED is the code, so 清关中 refines it. Read in
            // the other order PROBLEM would be the code and the row would stay DANGER.
            assertWorkerReading("logsiticsStatus FAILED before logisticsStatus PROBLEM",
                    coarseRecord("logsiticsStatus", "FAILED", "logisticsStatus", "PROBLEM",
                            "logisticsStatusDesc", "清关中"),
                    StatusSemantic.TRANSIT, "CUSTOMS_CLEARANCE");
            assertWorkerReading("logisticsStatus FAILED before status PROBLEM",
                    coarseRecord("logisticsStatus", "FAILED", "status", "PROBLEM",
                            "logisticsStatusDesc", "清关中"),
                    StatusSemantic.TRANSIT, "CUSTOMS_CLEARANCE");
            assertWorkerReading("status FAILED before state PROBLEM",
                    coarseRecord("status", "FAILED", "state", "PROBLEM",
                            "logisticsStatusDesc", "清关中"),
                    StatusSemantic.TRANSIT, "CUSTOMS_CLEARANCE");
        } finally {
            restoreBundledLabels();
        }
    }

    @Test
    public void recognizedCoarseSpellingsThatDisagreeGiveNoStatus() throws Exception {
        installCustomsSubtype();
        try {
            String[] names = {
                    "logsiticsStatus TRANSPORT, logisticsStatus SIGN",
                    "logsiticsStatus FAILED with 清关中, logisticsStatus TRANSPORT",
                    "status SIGN, state FAILED, stateName 已签收",
            };
            JSONObject[] records = {
                    coarseRecord("logsiticsStatus", "TRANSPORT", "logisticsStatus", "SIGN"),
                    // No customs refinement either: the disagreement wins before FAILED is read.
                    coarseRecord("logsiticsStatus", "FAILED", "logisticsStatus", "TRANSPORT",
                            "logisticsStatusDesc", "清关中"),
                    // A description does not decide a row whose recognized values disagree.
                    coarseRecord("status", "SIGN", "state", "FAILED", "stateName", "已签收",
                            "logisticsStatusDesc", "清关中"),
            };
            for (int index = 0; index < records.length; index++) {
                String name = names[index];
                JSONObject record = records[index];
                assertWorkerReading(name, record, StatusSemantic.UNKNOWN, null);
                ExpressQueryResult online = coarseOnline(record);
                assertFalse(name, online.structuredStatusEvidence);
                assertEquals(name, 0L, online.statusEventTime);
                assertEquals(name, "暂无状态", item(online).displayStatus());
            }
        } finally {
            restoreBundledLabels();
        }
    }

    /** A Meizu Online node at 2026-11-20 10:00:00 whose text is no start event; {@code fields} adds pairs. */
    private static JSONObject meizuNode(Object... fields) throws Exception {
        JSONObject node = new JSONObject().put("time", "2026-11-20 10:00:00")
                .put("context", "快件到达转运中心");
        for (int index = 0; index + 1 < fields.length; index += 2) {
            node.put((String) fields[index], fields[index + 1]);
        }
        return node;
    }

    /** The Worker's projection of one node, as the generated Beta Worker attaches it. */
    private static JSONObject nodeProjection(String semantic, String code, String text, int priority)
            throws Exception {
        boolean structured = !"UNKNOWN".equals(semantic);
        return new JSONObject().put("version", 1).put("scope", "SHIPMENT").put("semantic", semantic)
                .put("code", code).put("text", text).put("priority", priority)
                .put("eventAtMs", structured ? 1795140000000L : 0L).put("structured", structured);
    }

    /** The node readers on an Online answer whose data array holds {@code node}. */
    private static void assertNodeReading(String name, JSONObject node, StatusSemantic semantic,
            boolean pickup) throws Exception {
        ExpressQueryResult parsed = coarseOnline(coarseRecord("logisticsStatus", "TRANSPORT")
                .put("data", new JSONArray().put(node)));
        assertEquals(name, Collections.singletonList(semantic),
                ExpressTimeline.latestTrackStatuses(parsed.tracksJson, parsed.timelineProvider));
        assertEquals(name, pickup, Kuaidi100TimelinePolicy.hasPickupEvidence(parsed));
    }

    @Test
    public void meizuOnlineNodesReadTheirCoarseFieldsAsTheWorkerProjectsThem() throws Exception {
        // Owner 2026-11-21 「Read it for every status」: a Meizu Online node's own coarse fields are read in
        // the Worker's order with its disagreement rule and the customs refinement, the reading the
        // Worker attaches to the node (normalizeExpressTimelineResponse("v6"), each projection below).
        // An unprojected node and its Worker-projected copy therefore read the same.
        Object[][] cases = {
                // Before: logsiticsStatus was not read on a node.
                {"logsiticsStatus SIGN", meizuNode("logsiticsStatus", "SIGN"),
                        nodeProjection("COMPLETED", "SIGN", "已签收", 0), StatusSemantic.COMPLETED, false},
                // Before: the unrecognized logisticsStatus came first and masked GOT.
                {"unrecognized logisticsStatus, then status GOT",
                        meizuNode("logisticsStatus", "UNSUPPORTED_ENUM", "status", "GOT"),
                        nodeProjection("PICKED", "GOT", "已揽件", 0), StatusSemantic.PICKED, true},
                // Before: logsiticsStatus was skipped and status GOT counted as a pickup.
                {"logsiticsStatus SIGN disagrees with status GOT",
                        meizuNode("logsiticsStatus", "SIGN", "status", "GOT"),
                        nodeProjection("UNKNOWN", "SIGN", "暂无状态", 0), StatusSemantic.UNKNOWN, false},
                // Before: FAILED read as DANGER.
                {"logisticsStatus FAILED with 清关中",
                        meizuNode("logisticsStatus", "FAILED", "logisticsStatusDesc", "清关中"),
                        nodeProjection("TRANSIT", "CUSTOMS_CLEARANCE", "清关中", 1),
                        StatusSemantic.TRANSIT, false},
                // Unchanged answer: status 在途 is a common-vocabulary value (TRANSIT, owner 2026-11-21 「Lite
                // 用完整状态词表（推荐）」) and agrees with the node's Kuaidi100 statusCode 0.
                {"Kuaidi100-shaped node, status 在途 and statusCode 0",
                        meizuNode("status", "在途", "statusCode", "0"),
                        nodeProjection("TRANSIT", "在途", "运输中", 0), StatusSemantic.TRANSIT, false},
        };
        for (Object[] value : cases) {
            String name = (String) value[0];
            JSONObject node = (JSONObject) value[1];
            StatusSemantic semantic = (StatusSemantic) value[3];
            boolean pickup = (Boolean) value[4];
            assertNodeReading(name, node, semantic, pickup);
            assertNodeReading(name + " (Worker-projected)",
                    new JSONObject(node.toString()).put("normalizedStatus", value[2]), semantic, pickup);
        }
        // With no coarse value the common vocabulary recognizes (揽收 is not one), a node keeps the
        // existing statusCode reading (here a Kuaidi100 pickup code); the generated Worker projects this
        // node UNKNOWN (code 揽收).
        assertNodeReading("Kuaidi100-shaped pickup, status 揽收 and statusCode 1",
                meizuNode("status", "揽收", "statusCode", "1"), StatusSemantic.PICKED, true);
    }

    // Owner 2026-11-21 「Lite 用完整状态词表（推荐）」: Lite recognizes a Meizu v6 coarse value through the
    // Worker's full `common` vocabulary in the bundled or served status label table (the table the Worker
    // and the Bot read), not only `storedCodes`. Each expected answer is the generated formal and Beta
    // Worker's answer for the same record (normalizeExpressTimelineResponse("v6") for the Online answer,
    // parcelStatus("v6") for the list row, both identical on the two tracks).

    @Test
    public void coarseValuesOnlyTheCommonTableKnowsDecideAsTheWorkerReadsThem() throws Exception {
        installCustomsSubtype();
        try {
            // Before: each of these values was unrecognized, so the row had no status.
            assertWorkerReading("logsiticsStatus RETURNED",
                    coarseRecord("logsiticsStatus", "RETURNED"), StatusSemantic.DANGER, null);
            assertWorkerReading("status 签收", coarseRecord("status", "签收"), StatusSemantic.COMPLETED, null);
            assertWorkerReading("logisticsStatus 揽件",
                    coarseRecord("logisticsStatus", "揽件"), StatusSemantic.PICKED, null);
            assertWorkerReading("state CLOSE", coarseRecord("state", "CLOSE"), StatusSemantic.CANCELLED, null);
            assertWorkerReading("lower-case logisticsStatus finished",
                    coarseRecord("logisticsStatus", "finished"), StatusSemantic.COMPLETED, null);
            // Before: RETURNED was skipped, so status FAILED became the code and 清关中 refined it. The
            // Worker's code is RETURNED (DANGER, both agree), which the customs refinement never reads.
            assertWorkerReading("logisticsStatus RETURNED before status FAILED with 清关中",
                    coarseRecord("logisticsStatus", "RETURNED", "status", "FAILED",
                            "logisticsStatusDesc", "清关中"),
                    StatusSemantic.DANGER, null);
            // FAILED in the earlier field stays the code beside an agreeing RETURNED, and 清关中 refines it.
            assertWorkerReading("logisticsStatus FAILED before status RETURNED with 清关中",
                    coarseRecord("logisticsStatus", "FAILED", "status", "RETURNED",
                            "logisticsStatusDesc", "清关中"),
                    StatusSemantic.TRANSIT, "CUSTOMS_CLEARANCE");
        } finally {
            restoreBundledLabels();
        }
    }

    @Test
    public void commonTableValuesThatDisagreeGiveNoStatus() throws Exception {
        installCustomsSubtype();
        try {
            String[] names = {
                    // Before: RETURNED was unrecognized and SIGN decided (COMPLETED).
                    "status RETURNED, state SIGN",
                    // Before: FINISHED was unrecognized and FAILED with 清关中 decided (清关中).
                    "logsiticsStatus FINISHED, logisticsStatus FAILED with 清关中",
            };
            JSONObject[] records = {
                    coarseRecord("status", "RETURNED", "state", "SIGN"),
                    coarseRecord("logsiticsStatus", "FINISHED", "logisticsStatus", "FAILED",
                            "logisticsStatusDesc", "清关中"),
            };
            for (int index = 0; index < records.length; index++) {
                assertWorkerReading(names[index], records[index], StatusSemantic.UNKNOWN, null);
                ExpressQueryResult online = coarseOnline(records[index]);
                assertFalse(names[index], online.structuredStatusEvidence);
                assertEquals(names[index], 0L, online.statusEventTime);
                assertEquals(names[index], "暂无状态", item(online).displayStatus());
            }
        } finally {
            restoreBundledLabels();
        }
    }

    // Owner 2026-11-21 「文案推出的状态不当结构化证据（推荐）」 (AGENTS.md §9 「状态看结构化，不看文案」): when no
    // coarse value is recognized, Lite may still show the status its description field names, but that
    // status is no structured evidence. The Worker gives these records no status at all (UNKNOWN,
    // structured=false), so the evidence flag now agrees with it while the display reading is kept.

    @Test
    public void aStatusReadFromTheDescriptionIsShownButIsNoStructuredEvidence() throws Exception {
        String[] names = {
                // Before: any non-empty coarse value marked the description's status structured.
                "unrecognized numeric logsiticsStatus 2 with 运输中",
                "unrecognized status with stateName 已签收",
                "the string null in state with 运输中",
                // Unchanged: no coarse value at all was already no structured evidence.
                "no coarse value, description 运输中",
        };
        JSONObject[] records = {
                coarseRecord("logsiticsStatus", "2", "logisticsStatusDesc", "运输中"),
                coarseRecord("status", "UNSUPPORTED_ENUM", "stateName", "已签收"),
                coarseRecord("state", "null", "logisticsStatusDesc", "运输中"),
                coarseRecord("logisticsStatusDesc", "运输中"),
        };
        StatusSemantic[] shown = {StatusSemantic.TRANSIT, StatusSemantic.COMPLETED,
                StatusSemantic.TRANSIT, StatusSemantic.TRANSIT};
        // The list row reads logisticsStatusDesc only (existing parser contract), not stateName.
        StatusSemantic[] listShown = {StatusSemantic.TRANSIT, StatusSemantic.UNKNOWN,
                StatusSemantic.TRANSIT, StatusSemantic.TRANSIT};
        for (int index = 0; index < records.length; index++) {
            String name = names[index];
            ExpressQueryResult online = coarseOnline(records[index]);
            assertEquals(name, shown[index], online.semantic);
            assertFalse(name, online.structuredStatusEvidence);
            assertFalse(name, ManualTimelineAuthorityPolicy.hasStructuredStatus(online));
            assertNull(name, online.workerStatus);
            ExpressQueryResult listRow = ExpressSubscriptionClient.parseExpress(records[index], "", "");
            assertEquals(name + " (list row)", listShown[index], listRow.semantic);
            assertFalse(name + " (list row)", listRow.structuredStatusEvidence);
        }
        // A recognized coarse value stays structured evidence beside the same description.
        ExpressQueryResult recognized = coarseOnline(
                coarseRecord("logsiticsStatus", "TRANSPORT", "logisticsStatusDesc", "运输中"));
        assertEquals(StatusSemantic.TRANSIT, recognized.semantic);
        assertTrue(recognized.structuredStatusEvidence);
        assertTrue(ManualTimelineAuthorityPolicy.hasStructuredStatus(recognized));
    }

    @Test
    public void meizuOnlineNodesReadCommonTableValuesAsTheWorkerProjectsThem() throws Exception {
        // Owner 2026-11-21 「Lite 用完整状态词表（推荐）」 on the node readers; each projection is the one the
        // generated formal and Beta Worker attach to the node.
        Object[][] cases = {
                // Before: RETURNED was unrecognized and the node had no status.
                {"status RETURNED", meizuNode("status", "RETURNED"),
                        nodeProjection("DANGER", "RETURNED", "异常件", 0), StatusSemantic.DANGER, false},
                // Before: 揽件 was unrecognized, so the node was no pickup.
                {"logisticsStatus 揽件", meizuNode("logisticsStatus", "揽件"),
                        nodeProjection("PICKED", "揽件", "已揽件", 0), StatusSemantic.PICKED, true},
                // Before: 签收 was unrecognized and GOT counted as a pickup.
                {"status 签收 disagrees with state GOT", meizuNode("status", "签收", "state", "GOT"),
                        nodeProjection("UNKNOWN", "签收", "暂无状态", 0), StatusSemantic.UNKNOWN, false},
                // Before: 派件 was unrecognized and the Kuaidi100 statusCode 501 decided (WAITING_PICKUP).
                {"status 派件 with statusCode 501", meizuNode("status", "派件", "statusCode", "501"),
                        nodeProjection("DELIVERY", "派件", "派送中", 0), StatusSemantic.DELIVERY, false},
        };
        for (Object[] value : cases) {
            String name = (String) value[0];
            JSONObject node = (JSONObject) value[1];
            StatusSemantic semantic = (StatusSemantic) value[3];
            boolean pickup = (Boolean) value[4];
            assertNodeReading(name, node, semantic, pickup);
            assertNodeReading(name + " (Worker-projected)",
                    new JSONObject(node.toString()).put("normalizedStatus", value[2]), semantic, pickup);
        }
    }

    @Test
    public void aMeizuNodeDescriptionIsNoStructuredStartEvidence() throws Exception {
        // Owner 2026-11-21 「文案推出的状态不当结构化证据（推荐）」 on the start gate: a Meizu Online node's
        // description field no longer stands in for a structured node status. Before, both nodes below
        // counted as a pickup from 已揽件; the generated Worker gives each no status (UNKNOWN), and with no
        // structured status the node's own text decides (「三端统一改成结构化优先」, 2026-10-02).
        assertNodeReading("unrecognized logsiticsStatus with description 已揽件",
                meizuNode("logsiticsStatus", "UNSUPPORTED_ENUM", "logisticsStatusDesc", "已揽件"),
                StatusSemantic.UNKNOWN, false);
        assertNodeReading("description 已揽件 alone",
                meizuNode("logisticsStatusDesc", "已揽件"), StatusSemantic.UNKNOWN, false);
        assertNodeReading("description 已揽件 alone (Worker placeholder)",
                meizuNode("logisticsStatusDesc", "已揽件").put("normalizedStatus",
                        nodeProjection("UNKNOWN", "", "暂无状态", 0)), StatusSemantic.UNKNOWN, false);
        // The node's text still decides a node without a structured status.
        assertNodeReading("description 已揽件 on a pickup text",
                meizuNode("logisticsStatusDesc", "已揽件").put("context", "快件已揽收"),
                StatusSemantic.UNKNOWN, true);
        // Other providers keep their description reading.
        org.json.JSONArray k100 = new org.json.JSONArray().put(new JSONObject()
                .put("time", "2026-11-20 10:00:00").put("context", "快件到达转运中心")
                .put("logisticsStatusDesc", "已揽件"));
        assertTrue(Kuaidi100TimelinePolicy.containsTimelineStart(k100, "k100_h5", false));
    }
}
