package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

import java.util.List;

public final class Kuaidi100TimelinePolicyTest {
    private static final long NOW = 1_800_000_000_000L;

    @Test
    public void activeShipmentRefreshesOnEveryOpen() {
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.TRANSIT, NOW - 7L * 24L * 60L * 60L * 1000L),
                null, NOW));
    }

    @Test
    public void signedShipmentFreezesImmediatelyWithKnownTime() {
        ExpressQueryResult signedHistory = result(StatusSemantic.COMPLETED,
                "2026-01-01 00:00:00", "已签收",
                "[{\"time\":\"2026-01-01 00:00:00\",\"context\":\"快件已签收\"}]");
        assertFalse(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED, NOW), signedHistory, NOW));
    }

    @Test
    public void signedShipmentWithoutTracksStillFreezesWithKnownTime() {
        assertFalse(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED, NOW - 1L), null, NOW));
    }

    @Test
    public void signedShipmentWithoutReliableTimeStillRefreshes() {
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED, 0L), null, NOW));
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED, NOW + 5L * 60L * 1000L + 1L), null, NOW));
        assertFalse(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED, NOW + 1L), null, NOW));
    }

    @Test
    public void storageWriteTimeIsNotSignatureEvidenceForRefresh() {
        ExpressItem value = new ExpressItem(1L, "", "TEST-UNKNOWN-TIME", "ZTO", "Test",
                StatusSemantic.COMPLETED, "已签收", "", "", "[]", "", "INTERFACE5", "",
                0L, NOW, "INTERFACE5", "");
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(value, null, NOW));
    }

    @Test
    public void signedKuaidi100CacheControlsLocalDetailLifetime() {
        // The cache proves its signature by its own status time (audit D10, user 2026-09-25): a
        // 签收 headline or node alone is no signed evidence, so that form refreshes now.
        long signedAt = ExpressSourcePolicy.parseEventTime("2026-01-01 00:00:00");
        ExpressQueryResult cached = result(StatusSemantic.COMPLETED, signedAt,
                "2026-01-01 00:00:00", "已签收", "[]");
        long afterWindow = signedAt + 1L;
        ExpressItem transit = item(StatusSemantic.TRANSIT,
                "[{\"time\":\"2026-01-01 00:00:00\",\"context\":\"快件已签收\"}]");
        assertFalse(Kuaidi100TimelinePolicy.shouldRefresh(transit, cached, afterWindow));
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(transit, result(StatusSemantic.COMPLETED,
                "2026-01-01 00:00:00", "已签收", "[]"), afterWindow));
    }

    /**
     * 审计 D10（用户 2026-09-25 采纳，与 iOS、Pipi 同）：揽收与起点只看节点证据。包自己（或选包时借来的）状态是
     * PICKED / ORDERED、却没有对应节点时，不算有揽收、不算到了起点；有揽收节点或下单节点才算。
     */
    @Test
    public void onlyANodeProvesPickupOrTheStart() {
        String transitOnly = "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"快件到达转运中心\"}]";
        assertFalse(Kuaidi100TimelinePolicy.hasPickupEvidence(result(StatusSemantic.PICKED,
                "2026-08-15 10:00:00", "快件到达转运中心", transitOnly)));
        assertFalse(Kuaidi100TimelinePolicy.hasTimelineStart(result(StatusSemantic.ORDERED,
                "2026-08-15 10:00:00", "快件到达转运中心", transitOnly)));
        String withPickup = "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"快件到达转运中心\"},"
                + "{\"time\":\"2026-08-15 08:00:00\",\"context\":\"【上海】已揽收\"}]";
        assertTrue(Kuaidi100TimelinePolicy.hasPickupEvidence(result(StatusSemantic.TRANSIT,
                "2026-08-15 10:00:00", "快件到达转运中心", withPickup)));
        String withOrder = "[{\"time\":\"2026-08-15 08:00:00\",\"context\":\"您的订单已提交\"}]";
        assertTrue(Kuaidi100TimelinePolicy.hasTimelineStart(result(StatusSemantic.UNKNOWN,
                "2026-08-15 08:00:00", "您的订单已提交", withOrder)));
    }

    /**
     * 审计 D10（用户 2026-09-25 采纳）：没有结构化状态时间时，不再从「签收」文案的节点推出签收时间——冻结要有依据，
     * 不靠猜（AGENTS §9 签收冻结，与 iOS、Pipi 同）。此前这里断言文案节点能补上缺失的签收时间、停止刷新。
     */
    @Test
    public void aSignedTextNodeIsNoSignedTimeWithoutAStructuredOne() {
        String signedTime = "2026-01-01 00:00:00";
        ExpressQueryResult cached = result(StatusSemantic.COMPLETED,
                "", "已签收", "[{\"time\":\"" + signedTime
                        + "\",\"context\":\"快件已签收\"}]");
        long afterWindow = ExpressSourcePolicy.parseEventTime(signedTime)
                + 1L;
        assertTrue(Kuaidi100TimelinePolicy.shouldRefresh(
                item(StatusSemantic.COMPLETED, 0L), cached, afterWindow));
        assertEquals(0L, ExpressLifecycleTimes.signedEvidenceAt(
                item(StatusSemantic.COMPLETED, 0L), cached, afterWindow));
    }

    @Test
    public void refreshIsMergedIncrementallyAndRevisesSameTimestamp() {
        ExpressQueryResult cached = result(StatusSemantic.TRANSIT,
                "2026-08-15 10:00:00", "运输中",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-08-15 09:00:00\",\"context\":\"已揽收\"}]");
        ExpressQueryResult refreshed = result(StatusSemantic.DELIVERY,
                "2026-08-15 11:00:00", "派送中",
                "[{\"time\":\"2026-08-15 11:00:00\",\"context\":\"派送中\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\",\"context\":\"到达转运中心\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.tracksJson, merged.latestTime, merged.latestDetail);

        assertEquals(StatusSemantic.DELIVERY, merged.semantic);
        assertEquals(4, tracks.size());
        assertEquals("派送中", tracks.get(0).detail);
        assertEquals("到达转运中心", tracks.get(1).detail);
        assertEquals("运输中", tracks.get(2).detail);
        assertEquals("已揽收", tracks.get(3).detail);
    }

    @Test
    public void refreshKeepsAllProviderScansFromTheSameSecond() {
        ExpressQueryResult cached = result(StatusSemantic.TRANSIT,
                "2026-08-15 10:00:00", "旧节点",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"旧节点\"},"
                        + "{\"time\":\"2026-08-15 09:00:00\",\"context\":\"已揽收\"}]");
        ExpressQueryResult refreshed = result(StatusSemantic.TRANSIT,
                "2026-08-15 10:00:00", "离开网点",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"到达网点\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\","
                        + "\"context\":\"离开网点\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.tracksJson, merged.latestTime, merged.latestDetail);

        assertEquals(4, tracks.size());
        assertEquals("到达网点", tracks.get(0).detail);
        assertEquals("离开网点", tracks.get(1).detail);
        assertEquals("旧节点", tracks.get(2).detail);
        assertEquals("已揽收", tracks.get(3).detail);
    }

    // 用户 2026-09-25 定（审计 D6「换成最新」）：已签收的包状态照旧冻结，签收之后又来的节点照样当表头。
    @Test
    public void completedTimedPackageFreezesStatusButItsHeadlineFollowsLaterHistory() {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-15 12:00:00");
        long transitAt = ExpressSourcePolicy.parseEventTime("2026-08-15 13:00:00");
        ExpressQueryResult cached = result(
                StatusSemantic.COMPLETED, completedAt,
                "2026-08-15 12:00:00", "已签收",
                "[{\"time\":\"2026-08-15 12:00:00\","
                        + "\"context\":\"快件已签收\",\"statusCode\":\"3\"}]");
        ExpressQueryResult refreshed = result(
                StatusSemantic.TRANSIT, transitAt,
                "2026-08-15 13:00:00", "运输中",
                "[{\"time\":\"2026-08-15 13:00:00\","
                        + "\"context\":\"快件到达转运中心\",\"statusCode\":\"0\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.tracksJson, merged.latestTime, merged.latestDetail);

        assertEquals(StatusSemantic.COMPLETED, merged.semantic);
        assertEquals(completedAt, merged.statusEventTime);
        assertEquals("2026-08-15 13:00:00", merged.latestTime);
        assertEquals("快件到达转运中心", merged.latestDetail);
        assertEquals(2, tracks.size());
        assertEquals("快件到达转运中心", tracks.get(0).detail);
        assertEquals("快件已签收", tracks.get(1).detail);
    }

    // 用户 2026-09-24 采纳：同源合并的表头对齐 iOS withMergedHeadline（头条 = 最新的有效时间节点）。

    @Test
    public void aStatuslessRefreshMovesTheHeadlineToTheNewestMergedNode() {
        ExpressQueryResult cached = result(StatusSemantic.UNKNOWN,
                "2026-08-15 10:00:00", "到达网点",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"到达网点\"},"
                        + "{\"time\":\"2026-08-15 09:00:00\",\"context\":\"已揽收\"}]");
        ExpressQueryResult refreshed = result(StatusSemantic.UNKNOWN,
                "2026-08-15 11:00:00", "离开网点",
                "[{\"time\":\"2026-08-15 11:00:00\",\"context\":\"离开网点\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\",\"context\":\"到达网点\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);

        assertEquals("2026-08-15 11:00:00", merged.latestTime);
        assertEquals("离开网点", merged.latestDetail);
        assertEquals(StatusSemantic.UNKNOWN, merged.semantic);
        assertEquals(3, ExpressTimeline.parse(merged.tracksJson, "", "").size());
    }

    @Test
    public void anEqualTimeNodeDoesNotTakeTheHeadline() {
        ExpressQueryResult cached = result(StatusSemantic.UNKNOWN,
                "2026-08-15 10:00:00", "到达网点",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"到达网点\"}]");
        ExpressQueryResult refreshed = result(StatusSemantic.UNKNOWN,
                "2026-08-15 10:00:00", "离开网点",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"离开网点\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);

        assertEquals("2026-08-15 10:00:00", merged.latestTime);
        assertEquals("到达网点", merged.latestDetail);
    }

    @Test
    public void aStoredHeadlineWithoutAReadableTimeIsLeftAlone() {
        ExpressQueryResult cached = result(StatusSemantic.UNKNOWN, "", "到达网点",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"到达网点\"}]");
        ExpressQueryResult refreshed = result(StatusSemantic.UNKNOWN,
                "2026-08-15 11:00:00", "离开网点",
                "[{\"time\":\"2026-08-15 11:00:00\",\"context\":\"离开网点\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);

        assertEquals("", merged.latestTime);
        assertEquals("到达网点", merged.latestDetail);
    }

    @Test
    public void movingTheHeadlineLeavesStatusAndEvidenceAlone() {
        long transitAt = ExpressSourcePolicy.parseEventTime("2026-08-15 10:00:00");
        ExpressQueryResult cached = result(StatusSemantic.TRANSIT, transitAt,
                "2026-08-15 10:00:00", "运输中",
                "[{\"time\":\"2026-08-15 10:00:00\",\"context\":\"运输中\"}]")
                .withManualStatusEvidence("运输中", true);
        ExpressQueryResult refreshed = result(StatusSemantic.UNKNOWN, 0L,
                "2026-08-15 11:00:00", "到达网点",
                "[{\"time\":\"2026-08-15 11:00:00\",\"context\":\"到达网点\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);

        assertEquals("2026-08-15 11:00:00", merged.latestTime);
        assertEquals("到达网点", merged.latestDetail);
        assertEquals(StatusSemantic.TRANSIT, merged.semantic);
        assertEquals(transitAt, merged.statusEventTime);
        assertEquals("运输中", merged.statusDescription);
        assertTrue(merged.structuredStatusEvidence);
        assertEquals(2, ExpressTimeline.parse(merged.tracksJson, "", "").size());
    }

    // 用户 2026-09-25 定（D6）：读时也一样，有没有结构化证据的已签收包都取签收之后的最新节点，状态不动。
    @Test
    public void aStoredSignedManualPackageTakesItsNewestHeadlineOnRead() {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-15 12:00:00");
        String tracks = "[{\"time\":\"2026-08-15 13:00:00\",\"context\":\"签收后补的一条\"},"
                + "{\"time\":\"2026-08-15 12:00:00\",\"context\":\"已签收\"}]";
        ExpressQueryResult structured = result(StatusSemantic.COMPLETED, completedAt,
                "2026-08-15 12:00:00", "已签收", tracks).withManualStatusEvidence("已签收", true);
        ExpressQueryResult unstructured = result(StatusSemantic.COMPLETED, completedAt,
                "2026-08-15 12:00:00", "已签收", tracks).withManualStatusEvidence("已签收", false);

        for (ExpressQueryResult stored : new ExpressQueryResult[]{structured, unstructured}) {
            ExpressQueryResult read = Kuaidi100TimelinePolicy.storedManualHeadline(stored);
            assertEquals("2026-08-15 13:00:00", read.latestTime);
            assertEquals("签收后补的一条", read.latestDetail);
            assertEquals(StatusSemantic.COMPLETED, read.semantic);
            assertEquals(completedAt, read.statusEventTime);
            assertEquals(stored.structuredStatusEvidence, read.structuredStatusEvidence);
        }
    }

    @Test
    public void completedTimedPackageRejectsEmptyCompletedRefresh() {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-15 12:00:00");
        ExpressQueryResult cached = result(
                StatusSemantic.COMPLETED, completedAt,
                "2026-08-15 12:00:00", "由本人签收",
                "[{\"time\":\"2026-08-15 12:00:00\","
                        + "\"context\":\"由本人签收\",\"statusCode\":\"3\"}]");
        ExpressQueryResult refreshed = result(
                StatusSemantic.COMPLETED, completedAt + 60_000L,
                "2026-08-15 12:01:00", "已签收", "[]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);

        assertEquals(completedAt, merged.statusEventTime);
        assertEquals("2026-08-15 12:00:00", merged.latestTime);
        assertEquals("由本人签收", merged.latestDetail);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.tracksJson, merged.latestTime, merged.latestDetail);
        assertEquals(1, tracks.size());
        assertEquals("由本人签收", tracks.get(0).detail);
    }

    @Test
    public void completedTimedPackageMergesOnlyValidCompletedHistory() {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-15 12:00:00");
        ExpressQueryResult cached = result(
                StatusSemantic.COMPLETED, completedAt,
                "2026-08-15 12:00:00", "由本人签收",
                "[{\"time\":\"2026-08-15 12:00:00\","
                        + "\"context\":\"由本人签收\",\"statusCode\":\"3\"},"
                        + "{\"time\":\"2026-08-15 10:00:00\","
                        + "\"context\":\"派送中\",\"statusCode\":\"5\"}]");
        ExpressQueryResult refreshed = result(
                StatusSemantic.COMPLETED, completedAt + 60_000L,
                "2026-08-15 11:00:00", "已签收",
                "[{\"time\":\"2026-08-15 11:00:00\","
                        + "\"context\":\"放入丰巢柜\",\"statusCode\":\"501\"}]");

        ExpressQueryResult merged = Kuaidi100TimelinePolicy.merge(cached, refreshed);
        List<ExpressTimeline.Track> tracks = ExpressTimeline.parse(
                merged.tracksJson, merged.latestTime, merged.latestDetail);

        assertEquals(StatusSemantic.COMPLETED, merged.semantic);
        assertEquals(completedAt, merged.statusEventTime);
        assertEquals("2026-08-15 12:00:00", merged.latestTime);
        assertEquals("由本人签收", merged.latestDetail);
        assertEquals(3, tracks.size());
        assertEquals("由本人签收", tracks.get(0).detail);
        assertEquals("放入丰巢柜", tracks.get(1).detail);
        assertEquals("派送中", tracks.get(2).detail);
    }

    @Test
    public void orderCompletionTextDoesNotCreateALogisticsCompletionPackage() {
        ExpressQueryResult order = result(
                StatusSemantic.ORDERED,
                ExpressSourcePolicy.parseEventTime("2026-08-15 12:00:00"),
                "2026-08-15 12:00:00", "订单已完成",
                "[{\"time\":\"2026-08-15 12:00:00\","
                        + "\"context\":\"订单已完成\"}]");

        assertFalse(Kuaidi100TimelinePolicy.isCompletedTimedPackage(order));
    }

    @Test
    public void pendingManualItemNeedsARealTrackingNode() {
        assertFalse(Kuaidi100TimelinePolicy.hasRealTracking(result(
                StatusSemantic.UNKNOWN, "", "", "[]")));
        assertFalse(Kuaidi100TimelinePolicy.hasRealTracking(result(
                StatusSemantic.UNKNOWN, "", "暂无物流信息",
                "[{\"time\":\"\",\"context\":\"暂无物流信息\"}]")));
        assertTrue(Kuaidi100TimelinePolicy.hasRealTracking(result(
                StatusSemantic.PICKED, "2026-08-16 12:00:00", "快件已揽收",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"快件已揽收\"}]")));
    }

    @Test
    public void startGateUsesProviderSpecificCodesAndChineseBoundaryEvents() {
        ExpressQueryResult accountShipped = new ExpressQueryResult(
                "TEST123", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-08-16 12:00:00", "已发货",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"已发货\","
                        + "\"statusCode\":\"102\",\"_pipiStatusSource\":\"interface6\"}]",
                "", "", "interface6");
        ExpressQueryResult onlineOrdered = new ExpressQueryResult(
                "TEST123", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-08-16 12:00:00", "已发货",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"已发货\","
                        + "\"statusCode\":\"102\",\"_pipiStatusSource\":\"meizu\"}]",
                "", "", "meizu");
        ExpressQueryResult pickedByText = new ExpressQueryResult(
                "TEST123", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-08-16 12:00:00", "运输中",
                "[{\"time\":\"2026-08-16 11:00:00\",\"context\":\"快件已揽收\"},"
                        + "{\"time\":\"2026-08-16 12:00:00\",\"context\":\"运输中\"}]",
                "", "", "meizu");
        // 顺丰的揽收节点写「顺丰速运 已收取快件」，2026-09-05 三端同补，否则永远判不完整。
        ExpressQueryResult shunFengPickedByText = new ExpressQueryResult(
                "TEST123", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-09-05 12:00:00", "运输中",
                "[{\"time\":\"2026-09-05 10:00:00\",\"context\":\"顺丰速运 已收取快件\"},"
                        + "{\"time\":\"2026-09-05 12:00:00\",\"context\":\"运输中\"}]",
                "", "", "meizu");

        assertFalse(Kuaidi100TimelinePolicy.hasTimelineStart(accountShipped));
        assertTrue(Kuaidi100TimelinePolicy.hasTimelineStart(onlineOrdered));
        assertTrue(Kuaidi100TimelinePolicy.hasTimelineStart(pickedByText));
        assertTrue(Kuaidi100TimelinePolicy.hasTimelineStart(shunFengPickedByText));
    }

    @Test
    public void legacyProviderErrorCodeCannotCloseTheStartGate() {
        ExpressQueryResult legacyMixedMeizu = new ExpressQueryResult(
                "TEST123", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-09-02 10:46:00", "快件运输中",
                "[{\"time\":\"2026-09-02 10:45:00\","
                        + "\"context\":\"验证码错误，请重试\","
                        + "\"statusCode\":\"102\",\"_pipiStatusSource\":\"meizu\"},"
                        + "{\"time\":\"2026-09-02 10:46:00\","
                        + "\"context\":\"快件运输中\","
                        + "\"statusCode\":\"0\",\"_pipiStatusSource\":\"meizu\"}]",
                "", "", "meizu");

        assertTrue(Kuaidi100TimelinePolicy.hasTimedTracking(legacyMixedMeizu));
        assertFalse(Kuaidi100TimelinePolicy.hasTimelineStart(legacyMixedMeizu));
    }

    @Test
    public void persistedManualAuthorityNeedsAParseableTimedNode() {
        assertFalse(Kuaidi100TimelinePolicy.hasTimedTracking(result(
                StatusSemantic.PICKED, "", "快件已揽收",
                "[{\"context\":\"快件已揽收\"}]")));
        assertFalse(Kuaidi100TimelinePolicy.hasTimedTracking(result(
                StatusSemantic.PICKED, "not-a-time", "快件已揽收",
                "[{\"time\":\"not-a-time\",\"context\":\"快件已揽收\"}]")));
        assertTrue(Kuaidi100TimelinePolicy.hasTimedTracking(result(
                StatusSemantic.TRANSIT, "2026-08-16 12:00:00", "运输中",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"运输中\"}]")));
        assertTrue(Kuaidi100TimelinePolicy.hasTimedTracking(result(
                StatusSemantic.PICKED, "2026-08-16 12:00:00", "快件已揽收",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"快件已揽收\"}]")));
    }

    @Test
    public void completenessUsesProviderContractWithKdniaoTerminalGuard() {
        assertTrue(Kuaidi100TimelinePolicy.isTimelineIncomplete(result(
                StatusSemantic.TRANSIT, "", "", "[]")));
        ExpressQueryResult oneK100Node = new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", StatusSemantic.COMPLETED,
                "2026-08-16 12:00:00", "已签收",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"已签收\"}]",
                "", "", "kuaidi100");
        ExpressQueryResult oneKdniaoTerminalNode = new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", StatusSemantic.COMPLETED,
                "2026-08-16 12:00:00", "已签收",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"已签收\"}]",
                "", "", "kdniao");
        ExpressQueryResult twoKdniaoTerminalNodes = new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", StatusSemantic.COMPLETED,
                "2026-08-16 12:00:00", "已签收",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"已签收\"},"
                        + "{\"time\":\"2026-08-16 10:00:00\","
                        + "\"context\":\"已揽收\"}]",
                "", "", "kdniao");
        ExpressQueryResult manyAccountNodes = new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "2026-08-16 12:00:00", "运输中",
                "[{\"time\":\"2026-08-16 12:00:00\",\"context\":\"运输中\"},"
                        + "{\"time\":\"2026-08-16 11:00:00\",\"context\":\"已揽收\"},"
                        + "{\"time\":\"2026-08-16 10:00:00\",\"context\":\"已发出\"}]",
                "", "", "interface5");
        ExpressQueryResult completedMoto = new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", StatusSemantic.COMPLETED,
                "2026-08-16 13:00:00", "已签收",
                "[{\"time\":\"2026-08-16 13:00:00\",\"context\":\"已签收\"}]",
                "", "", "v4");

        assertFalse(Kuaidi100TimelinePolicy.isTimelineIncomplete(oneK100Node));
        assertTrue(Kuaidi100TimelinePolicy.isTimelineIncomplete(oneKdniaoTerminalNode));
        assertFalse(Kuaidi100TimelinePolicy.isTimelineIncomplete(twoKdniaoTerminalNodes));
        assertTrue(Kuaidi100TimelinePolicy.isTimelineIncomplete(manyAccountNodes));
        assertTrue(Kuaidi100TimelinePolicy.isTimelineIncomplete(completedMoto));
    }

    private static ExpressItem item(StatusSemantic semantic, String tracksJson) {
        return new ExpressItem(1L, "", "TEST123", "ZTO", "中通快递",
                semantic, semantic.label, "", "", tracksJson, "", "INTERFACE5", "",
                0L, 0L, "INTERFACE5", "");
    }

    private static ExpressItem item(StatusSemantic semantic, long eventTime) {
        return new ExpressItem(1L, "", "TEST123", "ZTO", "中通快递",
                semantic, semantic.label, "", "", "[]", "", "INTERFACE5", "",
                eventTime, eventTime, "INTERFACE5", "");
    }

    private static ExpressQueryResult result(
            StatusSemantic semantic, String time, String detail, String tracks) {
        return new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", semantic, time, detail, tracks);
    }

    private static ExpressQueryResult result(
            StatusSemantic semantic, long statusEventTime,
            String time, String detail, String tracks) {
        return new ExpressQueryResult(
                "TEST123", "ZTO", "中通快递", semantic, statusEventTime,
                time, detail, tracks, "", "", "kuaidi100", "", "", "");
    }
}
