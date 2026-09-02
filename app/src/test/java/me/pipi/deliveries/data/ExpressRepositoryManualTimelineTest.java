package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;
import org.json.JSONArray;

import java.util.Arrays;

public final class ExpressRepositoryManualTimelineTest {
    @Test
    public void projectionChangesTrackingButPreservesAccountIdentityAndRoute() {
        ExpressItem owner = owner(
                41L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.PICKED, false, 987654L);
        ManualTimelineAuthorityPolicy.Candidate authority = candidate(
                "v4", 2_000_000L, StatusSemantic.DELIVERY,
                "2026-08-24 12:30:00", "快件正在派送");

        ExpressItem projected = ExpressRepository.projectManualTimeline(owner, authority);

        assertEquals(owner.rowId, projected.rowId);
        assertEquals(owner.phone, projected.phone);
        assertEquals(owner.waybill, projected.waybill);
        assertEquals(owner.courierCode, projected.courierCode);
        assertEquals(owner.companyName, projected.companyName);
        assertEquals(owner.source, projected.source);
        assertEquals(owner.stateOwner, projected.stateOwner);
        assertEquals(owner.remark, projected.remark);
        assertEquals(owner.updatedAt, projected.updatedAt);
        assertEquals(owner.detailUrl, projected.detailUrl);
        assertEquals(owner.routeOwner, projected.routeOwner);
        assertEquals(owner.routeInterface, projected.routeInterface);
        assertEquals(owner.routeCredential, projected.routeCredential);
        assertEquals(owner.routeCredentialAvailable, projected.routeCredentialAvailable);
        assertEquals(owner.sourceProvider, projected.sourceProvider);
        assertEquals(owner.manuallyAdded, projected.manuallyAdded);
        assertEquals(StatusSemantic.DELIVERY, projected.semantic);
        assertEquals("快件正在派送", projected.latestDetail);
        assertEquals("2026-08-24 12:30:00", projected.latestTime);
        assertEquals(authority.result.tracksJson, projected.tracksJson);
        assertEquals("v4", projected.manualTimelineProvider);
        assertEquals(2_000_000L, projected.manualTimelineSuccessAt);
    }

    @Test
    public void incompleteAutomaticOwnerCanReceiveACompleteManualProjection() {
        ExpressItem owner = owner(
                42L, "13900001234", "INTERFACE6", "ShunFeng",
                StatusSemantic.PICKED, false, 0L);

        ExpressItem projected = ExpressRepository.projectManualTimeline(
                owner, candidate("kuaidi100", 2_000_000L,
                        StatusSemantic.TRANSIT,
                        "2026-08-24 12:30:00", "快件运输中"));
        assertEquals(StatusSemantic.PICKED, projected.semantic);
        assertEquals("快件运输中", projected.latestDetail);
        assertEquals("kuaidi100", projected.manualTimelineProvider);
    }

    @Test
    public void phoneMayChangeButOwnerRowCannot() {
        ExpressItem original = owner(
                43L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.PICKED, false, 0L);
        ExpressItem phoneUpdated = owner(
                43L, "13800005678", "INTERFACE5", "ShunFeng",
                StatusSemantic.TRANSIT, false, 100L);
        ExpressItem differentOwner = owner(
                44L, "13800005678", "INTERFACE5", "ShunFeng",
                StatusSemantic.TRANSIT, false, 100L);

        assertTrue(ExpressRepository.sameOwnerIdentity(phoneUpdated, original));
        assertFalse(ExpressRepository.sameOwnerIdentity(differentOwner, original));
        ExpressItem projected = ExpressRepository.projectManualTimeline(
                phoneUpdated, candidate("interface5", 2_000_000L,
                        StatusSemantic.TRANSIT,
                        "2026-08-24 12:30:00", "快件运输中"));
        assertEquals("13800005678", projected.phone);
    }

    @Test
    public void pollClockUsesOnlyLastManualSuccess() {
        long now = 3_000_000L;
        ExpressItem owner = owner(
                45L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.TRANSIT, false, now);
        ManualTimelineAuthorityPolicy.Candidate almostDue = candidate(
                "interface5",
                now - ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS + 1L,
                StatusSemantic.TRANSIT,
                "2026-08-24 12:30:00", "快件运输中");
        ManualTimelineAuthorityPolicy.Candidate due = candidate(
                "interface5",
                now - ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS,
                StatusSemantic.TRANSIT,
                "2026-08-24 12:30:00", "快件运输中");

        assertTrue(ExpressRepository.manualTimelinePollDue(owner, null, now));
        assertFalse(ExpressRepository.manualTimelinePollDue(owner, almostDue, now));
        assertTrue(ExpressRepository.manualTimelinePollDue(owner, due, now));
        assertFalse(ExpressRepository.manualTimelinePollDue(owner, due, due.successAt - 1L));

        ExpressItem cancelledByAccount = owner(
                45L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.CANCELLED, false, now);
        assertFalse(ExpressRepository.manualTimelinePollDue(cancelledByAccount, due, now));
    }

    @Test
    public void failedAutomaticPollCoolsOnlyAttemptsNewerThanTheLastSuccess() {
        long now = 30_000_000L;
        ExpressItem owner = owner(
                51L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.TRANSIT, false, 0L);
        long recentAttempt = now
                - ExpressRepository.MANUAL_TIMELINE_FAILURE_COOLDOWN_MS + 1L;
        long dueAttempt = now - ExpressRepository.MANUAL_TIMELINE_FAILURE_COOLDOWN_MS;

        assertFalse(ExpressRepository.manualTimelinePollDue(
                owner, null, recentAttempt, now));
        assertTrue(ExpressRepository.manualTimelinePollDue(
                owner, null, dueAttempt, now));
        assertTrue(ExpressRepository.manualTimelinePollDue(
                owner, null, now + 1L, now));

        ManualTimelineAuthorityPolicy.Candidate authority = candidate(
                "interface5",
                now - ExpressRepository.MANUAL_TIMELINE_FAILURE_COOLDOWN_MS
                        - ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS,
                StatusSemantic.TRANSIT,
                "2026-08-24 12:30:00", "快件运输中");
        assertTrue(ExpressRepository.manualTimelinePollDue(
                owner, authority, authority.successAt, now));
        assertFalse(ExpressRepository.manualTimelinePollDue(
                owner, authority, recentAttempt, now));
        assertTrue(ExpressRepository.manualTimelinePollDue(
                owner, authority, dueAttempt, now));
    }

    @Test
    public void bothAutomaticAccountInterfacesPersistRawProviderEvidence() {
        assertTrue(ExpressRepository.shouldPersistSourceProvider(
                "INTERFACE5", true, "ShunFeng"));
        assertTrue(ExpressRepository.shouldPersistSourceProvider(
                "I5-JD", true, "JingDong"));
        assertFalse(ExpressRepository.shouldPersistSourceProvider(
                "INTERFACE5", false, "ShunFeng"));
        assertTrue(ExpressRepository.shouldPersistSourceProvider(
                "INTERFACE6", true, "ShunFeng"));
        assertFalse(ExpressRepository.shouldPersistSourceProvider(
                "INTERFACE5", true, ""));
    }

    @Test
    public void sidecarOwnedRowsBypassOwnerStateWrites() {
        ExpressItem exactSource = owner(
                46L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.TRANSIT, false, 0L);
        ExpressItem legacyLocal = owner(
                47L, "", "KD-100", "",
                StatusSemantic.TRANSIT, false, 0L);
        ExpressItem otherAccount = owner(
                48L, "13900001234", "INTERFACE6", "",
                StatusSemantic.TRANSIT, false, 0L);
        ExpressItem manualAccountShape = owner(
                49L, "", "INTERFACE5", "",
                StatusSemantic.TRANSIT, true, 0L);

        assertFalse(ExpressRepository.manualResultWritesOwnerRow(exactSource));
        assertTrue(ExpressRepository.manualResultWritesOwnerRow(legacyLocal));
        assertTrue(ExpressRepository.manualResultMarksOwnerManual(legacyLocal));
        assertFalse(ExpressRepository.manualResultWritesOwnerRow(otherAccount));
        assertFalse(ExpressRepository.manualResultMarksOwnerManual(otherAccount));
        assertFalse(ExpressRepository.manualResultWritesOwnerRow(manualAccountShape));
        assertTrue(ExpressRepository.manualResultMarksOwnerManual(manualAccountShape));
    }

    @Test
    public void completeK100PackageOwnsPresentationWithoutTakingStructuredState()
            throws Exception {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-24 12:00:00");
        long waitingAt = ExpressSourcePolicy.parseEventTime("2026-08-24 13:00:00");
        ExpressItem owner = owner(
                61L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.WAITING_PICKUP, false, waitingAt, 9_000L);
        ManualTimelineAuthorityPolicy.Candidate previousProvider =
                explicitCandidate("v4", 10_000L, StatusSemantic.WAITING_PICKUP,
                        waitingAt, "2026-08-24 13:00:00", "上一来源待取件", "501", false);
        ManualTimelineAuthorityPolicy.Candidate completedKuaidi100 =
                explicitCandidate("kuaidi100", 20_000L, StatusSemantic.COMPLETED,
                        completedAt, "2026-08-24 12:00:00", "K100 已签收", "501",
                        true, false);

        ManualTimelineAuthorityPolicy.Candidate selected =
                ManualTimelineAuthorityPolicy.select(
                        Arrays.asList(previousProvider, completedKuaidi100));
        ExpressItem projected = ExpressRepository.projectManualTimeline(owner, selected);

        assertEquals("kuaidi100", selected.provider);
        assertEquals(StatusSemantic.WAITING_PICKUP, projected.semantic);
        assertEquals(waitingAt, projected.statusEventTime);
        assertEquals("2026-08-24 12:00:00", projected.latestTime);
        assertEquals("K100 已签收", projected.latestDetail);
        assertEquals("kuaidi100", projected.manualTimelineProvider);
        assertEquals("501", new JSONArray(projected.tracksJson)
                .getJSONObject(0).getString("statusCode"));
        assertEquals(owner.rowId, projected.rowId);
        assertEquals(owner.phone, projected.phone);
        assertEquals(owner.waybill, projected.waybill);
        assertEquals(owner.courierCode, projected.courierCode);
        assertEquals(owner.companyName, projected.companyName);
        assertEquals(owner.source, projected.source);
        assertEquals(owner.sourceProvider, projected.sourceProvider);
    }

    @Test
    public void unstructuredCompletedK100PackageKeepsPolling() {
        long now = 30_000_000L;
        ExpressItem owner = owner(
                62L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.WAITING_PICKUP, false, now, now);
        ManualTimelineAuthorityPolicy.Candidate completed = explicitCandidate(
                "kuaidi100", now - ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS,
                StatusSemantic.COMPLETED, 1_000L,
                "2026-08-24 12:00:00", "K100 已签收", "501", true, false);

        assertTrue(ExpressRepository.manualTimelinePollDue(owner, completed, now));
    }

    @Test
    public void partialTerminalPackageKeepsPollingForACompleteFallback() {
        long now = 30_000_000L;
        ExpressItem owner = owner(
                64L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.WAITING_PICKUP, false, now, now);
        ManualTimelineAuthorityPolicy.Candidate partial = explicitCandidate(
                "v4", now - ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS,
                StatusSemantic.COMPLETED, 1_000L,
                "2026-08-24 12:00:00", "Moto 已签收", "501", false);

        assertTrue(ExpressRepository.manualTimelinePollDue(owner, partial, now));
    }

    @Test
    public void singleNodeStructuredKdniaoTerminalKeepsPollingForFallback() {
        long now = 30_000_000L;
        ExpressItem owner = owner(
                65L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.WAITING_PICKUP, false, now, now);
        ManualTimelineAuthorityPolicy.Candidate completed = explicitCandidate(
                "kdniao", now - ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS,
                StatusSemantic.COMPLETED, 1_000L,
                "2026-08-24 12:00:00", "结构化已签收", "3", true, true);

        assertTrue(ExpressRepository.manualTimelinePollDue(owner, completed, now));
    }

    @Test
    public void twoNodeStructuredKdniaoTerminalStopsPolling() {
        long now = 30_000_000L;
        ExpressItem owner = owner(
                65L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.WAITING_PICKUP, false, now, now);
        ExpressQueryResult result = new ExpressQueryResult(
                "CONFLICTING-WAYBILL", "ZTO", "中通快递", StatusSemantic.COMPLETED,
                1_000L, "2026-08-24 12:00:00", "结构化已签收",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"结构化已签收\",\"statusCode\":\"3\"},"
                        + "{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"快件已揽收\",\"statusCode\":\"1\"}]",
                "", "13700009999", "kdniao", "", "", "")
                .withManualStatusEvidence("已签收", true);
        ManualTimelineAuthorityPolicy.Candidate completed =
                new ManualTimelineAuthorityPolicy.Candidate(
                        "kdniao", result,
                        now - ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS,
                        true);

        assertFalse(ExpressRepository.manualTimelinePollDue(owner, completed, now));
    }

    @Test
    public void timedStateLabelIsAValidCompletedProjection() {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-24 12:00:00");
        ExpressItem owner = owner(
                63L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.WAITING_PICKUP, false, completedAt + 1_000L, 9_000L);
        ManualTimelineAuthorityPolicy.Candidate completed = explicitCandidate(
                "v4", 20_000L, StatusSemantic.COMPLETED,
                completedAt, "2026-08-24 12:00:00", "已签收", "501");

        ExpressItem projected = ExpressRepository.projectManualTimeline(owner, completed);

        assertEquals(StatusSemantic.COMPLETED, projected.semantic);
        assertEquals("已签收", projected.latestDetail);
        assertEquals(completedAt, projected.statusEventTime);
    }

    @Test
    public void unstructuredManualPackageOwnsTextAndTracksButNotSemanticOrStateTime() {
        long ownerStateTime = ExpressSourcePolicy.parseEventTime("2026-08-24 09:00:00");
        ExpressItem owner = owner(
                65L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.WAITING_PICKUP, false, ownerStateTime, 9_000L);
        ExpressQueryResult manual = new ExpressQueryResult(
                "CONFLICTING-WAYBILL", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                ExpressSourcePolicy.parseEventTime("2026-08-24 13:00:00"),
                "2026-08-24 13:00:00", "手动源最新头条",
                "[{\"time\":\"2026-08-24 13:00:00\","
                        + "\"context\":\"手动源最新头条\"}]",
                "", "", "v4", "", "", "")
                .withManualStatusEvidence("手动源粗状态", false);

        ExpressItem projected = ExpressRepository.projectManualTimeline(
                owner, new ManualTimelineAuthorityPolicy.Candidate(
                        "v4", manual, 20_000L, false));

        assertEquals(StatusSemantic.WAITING_PICKUP, projected.semantic);
        assertEquals(ownerStateTime, projected.statusEventTime);
        assertEquals("手动源粗状态", projected.statusDescription);
        assertEquals("手动源最新头条", projected.latestDetail);
        assertEquals(manual.tracksJson, projected.tracksJson);
    }

    @Test
    public void pureManualOwnerStillTakesUnstructuredPackageStateAndTime() {
        long manualStateTime = ExpressSourcePolicy.parseEventTime("2026-08-24 15:00:00");
        ExpressItem owner = owner(
                67L, "", "KD-100", "",
                StatusSemantic.UNKNOWN, true, 0L, 9_000L);
        ExpressQueryResult manual = new ExpressQueryResult(
                owner.waybill, "SF", "顺丰速运", StatusSemantic.COMPLETED,
                manualStateTime, "2026-08-24 15:00:00", "K100 已签收",
                "[{\"time\":\"2026-08-24 15:00:00\","
                        + "\"context\":\"K100 已签收\",\"statusCode\":\"3\"}]",
                "", "", "kuaidi100", "", "", "")
                .withManualStatusEvidence("已签收", false);

        ExpressItem projected = ExpressRepository.projectManualTimeline(
                owner, new ManualTimelineAuthorityPolicy.Candidate(
                        "kuaidi100", manual, 20_000L, true));

        assertEquals(StatusSemantic.COMPLETED, projected.semantic);
        assertEquals(manualStateTime, projected.statusEventTime);
        assertEquals("已签收", projected.statusDescription);
        assertEquals(manual.tracksJson, projected.tracksJson);
    }

    @Test
    public void crossProviderTerminalGuardOnlyProtectsSemanticAndStateTime() {
        long ownerTime = ExpressSourcePolicy.parseEventTime("2026-08-24 09:00:00");
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-24 12:00:00");
        ExpressItem owner = owner(
                68L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.TRANSIT, false, ownerTime, 9_000L);
        ManualTimelineAuthorityPolicy.Candidate presentation = explicitCandidate(
                "kuaidi100", 20_000L, StatusSemantic.TRANSIT,
                ExpressSourcePolicy.parseEventTime("2026-08-24 13:00:00"),
                "2026-08-24 13:00:00", "K100 完整包头条", "1001", true, false);
        ManualTimelineAuthorityPolicy.Candidate terminalGuard = explicitCandidate(
                "v4", 10_000L, StatusSemantic.COMPLETED,
                completedAt, "2026-08-24 12:00:00", "Moto 已签收", "", false, true);

        ExpressItem projected = ExpressRepository.projectManualTimeline(
                owner, presentation, terminalGuard);

        assertEquals(StatusSemantic.COMPLETED, projected.semantic);
        assertEquals(completedAt, projected.statusEventTime);
        assertEquals("K100 完整包头条", projected.latestDetail);
        assertEquals(presentation.result.tracksJson, projected.tracksJson);
        assertEquals("kuaidi100", projected.manualTimelineProvider);
    }

    @Test
    public void terminalOwnerKeepsSemanticWhileManualPresentationStillRefreshes() {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-24 09:00:00");
        ExpressItem owner = owner(
                66L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.COMPLETED, false, completedAt, 9_000L);
        ExpressQueryResult manual = new ExpressQueryResult(
                "CONFLICTING-WAYBILL", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                ExpressSourcePolicy.parseEventTime("2026-08-24 14:00:00"),
                "2026-08-24 14:00:00", "手动源后续在途头条",
                "[{\"time\":\"2026-08-24 14:00:00\","
                        + "\"context\":\"手动源后续在途头条\"}]",
                "", "", "v4", "", "", "")
                .withManualStatusEvidence("运输中", true);

        ExpressItem projected = ExpressRepository.projectManualTimeline(
                owner, new ManualTimelineAuthorityPolicy.Candidate(
                        "v4", manual, 20_000L, false));

        assertEquals(StatusSemantic.COMPLETED, projected.semantic);
        assertEquals(completedAt, projected.statusEventTime);
        assertEquals("运输中", projected.statusDescription);
        assertEquals("手动源后续在途头条", projected.latestDetail);
        assertEquals(manual.tracksJson, projected.tracksJson);
    }

    @Test
    public void legacyMixedProviderErrorCannotOwnHeadlineStatusOrCompleteness() {
        ExpressItem owner = owner(
                69L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.TRANSIT, false, 123L, 9_000L);
        ExpressQueryResult legacy = new ExpressQueryResult(
                "CONFLICTING-WAYBILL", "SF", "顺丰速运", StatusSemantic.COMPLETED,
                ExpressSourcePolicy.parseEventTime("2026-09-02 10:45:00"),
                "2026-09-02 10:45:00", "验证码错误，请重试",
                "[{\"time\":\"2026-09-02 10:45:00\","
                        + "\"context\":\"验证码错误，请重试\",\"status\":\"SIGN\"},"
                        + "{\"time\":\"2026-09-02 10:44:00\","
                        + "\"context\":\"快件运输中\",\"status\":\"TRANSIT\"}]",
                "", "", "meizu", "", "", "")
                .withManualStatusEvidence("已签收", true);
        ManualTimelineAuthorityPolicy.Candidate sanitized =
                ExpressRepository.sanitizeManualTimelineCandidate(
                        new ManualTimelineAuthorityPolicy.Candidate(
                                "meizu", legacy, 10_000L, true));

        assertEquals(StatusSemantic.UNKNOWN, sanitized.result.semantic);
        assertEquals(0L, sanitized.result.statusEventTime);
        assertFalse(sanitized.result.structuredStatusEvidence);
        assertFalse(sanitized.complete);
        assertFalse(sanitized.result.tracksJson.contains("验证码错误"));
        assertEquals("快件运输中", sanitized.result.latestDetail);

        ExpressItem projected = ExpressRepository.projectManualTimeline(owner, sanitized);
        assertEquals(StatusSemantic.TRANSIT, projected.semantic);
        assertEquals(owner.statusDescription, projected.statusDescription);
        assertEquals("快件运输中", projected.latestDetail);
        assertFalse(projected.tracksJson.contains("验证码错误"));
    }

    private static ExpressItem owner(
            long rowId, String phone, String owner, String provider,
            StatusSemantic semantic, boolean manuallyAdded, long updatedAt) {
        return owner(rowId, phone, owner, provider, semantic, manuallyAdded, 123L, updatedAt);
    }

    private static ExpressItem owner(
            long rowId, String phone, String owner, String provider,
            StatusSemantic semantic, boolean manuallyAdded,
            long statusEventTime, long updatedAt) {
        return new ExpressItem(
                rowId, phone, "SFOWNER000001", "SF", "顺丰速运",
                semantic, semantic.label, "账号来源摘要", "2026-08-24 10:00:00",
                "[{\"time\":\"2026-08-24 10:00:00\",\"context\":\"账号来源摘要\"}]",
                "原备注", owner, "pipi-route:v5", statusEventTime, updatedAt,
                owner, owner, "v5", "https://example.invalid/private-route", true,
                "", "", "", provider, manuallyAdded, "", 0L);
    }

    private static ManualTimelineAuthorityPolicy.Candidate candidate(
            String provider, long successAt, StatusSemantic semantic,
            String time, String detail) {
        ExpressQueryResult result = new ExpressQueryResult(
                "CONFLICTING-WAYBILL", "ZTO", "中通快递", semantic,
                time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail + "\"}]",
                "https://example.invalid/conflicting-route", "13700009999", provider);
        result = result.withManualStatusEvidence(
                semantic.label, "v4".equals(provider));
        return new ManualTimelineAuthorityPolicy.Candidate(
                provider, result, successAt,
                ManualTimelineAuthorityPolicy.completeByContract(provider));
    }

    private static ManualTimelineAuthorityPolicy.Candidate explicitCandidate(
            String provider, long successAt, StatusSemantic semantic,
            long statusEventTime, String time, String detail, String statusCode) {
        return explicitCandidate(
                provider, successAt, semantic, statusEventTime, time, detail, statusCode,
                true, "v4".equals(provider));
    }

    private static ManualTimelineAuthorityPolicy.Candidate explicitCandidate(
            String provider, long successAt, StatusSemantic semantic,
            long statusEventTime, String time, String detail, String statusCode,
            boolean complete) {
        return explicitCandidate(
                provider, successAt, semantic, statusEventTime, time, detail, statusCode,
                complete, "v4".equals(provider));
    }

    private static ManualTimelineAuthorityPolicy.Candidate explicitCandidate(
            String provider, long successAt, StatusSemantic semantic,
            long statusEventTime, String time, String detail, String statusCode,
            boolean complete, boolean structured) {
        ExpressQueryResult result = new ExpressQueryResult(
                "CONFLICTING-WAYBILL", "ZTO", "中通快递", semantic,
                statusEventTime, time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail
                        + "\",\"statusCode\":\"" + statusCode
                        + "\",\"_pipiStatusSource\":\"" + provider + "\"}]",
                "", "13700009999", provider, "", "", "")
                .withManualStatusEvidence(semantic.label, structured);
        return new ManualTimelineAuthorityPolicy.Candidate(
                provider, result, successAt, complete);
    }
}
