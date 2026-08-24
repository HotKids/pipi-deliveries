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
                "kuaidi100", 2_000_000L, StatusSemantic.DELIVERY,
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
        assertEquals("kuaidi100", projected.manualTimelineProvider);
        assertEquals(2_000_000L, projected.manualTimelineSuccessAt);
    }

    @Test
    public void unrelatedAccountOwnerCannotReceiveTheProjection() {
        ExpressItem owner = owner(
                42L, "13900001234", "INTERFACE6", "ShunFeng",
                StatusSemantic.PICKED, false, 0L);

        assertSame(owner, ExpressRepository.projectManualTimeline(
                owner, candidate("kuaidi100", 2_000_000L,
                        StatusSemantic.TRANSIT,
                        "2026-08-24 12:30:00", "快件运输中")));
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
        assertTrue(ExpressRepository.manualTimelinePollDue(cancelledByAccount, due, now));
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
    public void onlyAutomaticInterface5RowsPersistRawProviderEvidence() {
        assertTrue(ExpressRepository.shouldPersistSourceProvider(
                "INTERFACE5", true, "ShunFeng"));
        assertTrue(ExpressRepository.shouldPersistSourceProvider(
                "I5-JD", true, "JingDong"));
        assertFalse(ExpressRepository.shouldPersistSourceProvider(
                "INTERFACE5", false, "ShunFeng"));
        assertFalse(ExpressRepository.shouldPersistSourceProvider(
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
        assertTrue(ExpressRepository.manualResultWritesOwnerRow(otherAccount));
        assertFalse(ExpressRepository.manualResultMarksOwnerManual(otherAccount));
        assertFalse(ExpressRepository.manualResultWritesOwnerRow(manualAccountShape));
        assertTrue(ExpressRepository.manualResultMarksOwnerManual(manualAccountShape));
    }

    @Test
    public void newestProviderPackageWinsDespiteLaterOwnerAndPreviousProviderEvents()
            throws Exception {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-24 12:00:00");
        long waitingAt = ExpressSourcePolicy.parseEventTime("2026-08-24 13:00:00");
        ExpressItem owner = owner(
                61L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.WAITING_PICKUP, false, waitingAt, 9_000L);
        ManualTimelineAuthorityPolicy.Candidate previousProvider =
                explicitCandidate("interface5", 10_000L, StatusSemantic.WAITING_PICKUP,
                        waitingAt, "2026-08-24 13:00:00", "上一来源待取件", "501");
        ManualTimelineAuthorityPolicy.Candidate completedKuaidi100 =
                explicitCandidate("kuaidi100", 20_000L, StatusSemantic.COMPLETED,
                        completedAt, "2026-08-24 12:00:00", "K100 已签收", "501");

        ManualTimelineAuthorityPolicy.Candidate selected =
                ManualTimelineAuthorityPolicy.select(
                        Arrays.asList(previousProvider, completedKuaidi100));
        ExpressItem projected = ExpressRepository.projectManualTimeline(owner, selected);

        assertEquals("kuaidi100", selected.provider);
        assertEquals(StatusSemantic.COMPLETED, projected.semantic);
        assertEquals(completedAt, projected.statusEventTime);
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
    public void completedManualPackageStopsPollingImmediately() {
        long now = 30_000_000L;
        ExpressItem owner = owner(
                62L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.WAITING_PICKUP, false, now, now);
        ManualTimelineAuthorityPolicy.Candidate completed = explicitCandidate(
                "kuaidi100", now - ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS,
                StatusSemantic.COMPLETED, 1_000L,
                "2026-08-24 12:00:00", "K100 已签收", "501");

        assertFalse(ExpressRepository.manualTimelinePollDue(owner, completed, now));
    }

    @Test
    public void timedStateLabelIsAValidCompletedProjection() {
        long completedAt = ExpressSourcePolicy.parseEventTime("2026-08-24 12:00:00");
        ExpressItem owner = owner(
                63L, "13900001234", "INTERFACE5", "ShunFeng",
                StatusSemantic.WAITING_PICKUP, false, completedAt + 1_000L, 9_000L);
        ManualTimelineAuthorityPolicy.Candidate completed = explicitCandidate(
                "kuaidi100", 20_000L, StatusSemantic.COMPLETED,
                completedAt, "2026-08-24 12:00:00", "已签收", "501");

        ExpressItem projected = ExpressRepository.projectManualTimeline(owner, completed);

        assertEquals(StatusSemantic.COMPLETED, projected.semantic);
        assertEquals("已签收", projected.latestDetail);
        assertEquals(completedAt, projected.statusEventTime);
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
        return new ManualTimelineAuthorityPolicy.Candidate(
                provider, result, successAt, true);
    }

    private static ManualTimelineAuthorityPolicy.Candidate explicitCandidate(
            String provider, long successAt, StatusSemantic semantic,
            long statusEventTime, String time, String detail, String statusCode) {
        ExpressQueryResult result = new ExpressQueryResult(
                "CONFLICTING-WAYBILL", "ZTO", "中通快递", semantic,
                statusEventTime, time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail
                        + "\",\"statusCode\":\"" + statusCode
                        + "\",\"_pipiStatusSource\":\"" + provider + "\"}]",
                "", "13700009999", provider, "", "", "");
        return new ManualTimelineAuthorityPolicy.Candidate(
                provider, result, successAt, true);
    }
}
