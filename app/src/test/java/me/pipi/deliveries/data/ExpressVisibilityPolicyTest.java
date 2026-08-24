package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressVisibilityPolicyTest {
    private static final long NOW = 1_800_000_000_000L;

    @Test
    public void signedShipmentExpiresAtSevenDayBoundary() {
        assertFalse(ExpressVisibilityPolicy.isExpired(
                item(StatusSemantic.COMPLETED,
                        NOW - ExpressVisibilityPolicy.SIGNED_VISIBLE_MS + 1L), NOW));
        assertTrue(ExpressVisibilityPolicy.isExpired(
                item(StatusSemantic.COMPLETED,
                        NOW - ExpressVisibilityPolicy.SIGNED_VISIBLE_MS), NOW));
    }

    @Test
    public void activeOrUncertainShipmentIsNeverExpired() {
        assertFalse(ExpressVisibilityPolicy.isExpired(
                item(StatusSemantic.TRANSIT,
                        NOW - ExpressVisibilityPolicy.SIGNED_VISIBLE_MS), NOW));
        assertFalse(ExpressVisibilityPolicy.isExpired(
                item(StatusSemantic.COMPLETED, 0L), NOW));
        assertFalse(ExpressVisibilityPolicy.isExpired(
                item(StatusSemantic.COMPLETED, NOW + 1L), NOW));
    }

    @Test
    public void newerSignedTrackKeepsACompletedShipmentVisible() {
        long oldStatusTime = NOW - ExpressVisibilityPolicy.SIGNED_VISIBLE_MS;
        String tracks = "[{\"time\":\"2027-01-14 00:00:00\","
                + "\"context\":\"包裹已签收\"}]";
        ExpressItem item = new ExpressItem(1L, "", "TEST123", "ZTO", "中通快递",
                StatusSemantic.COMPLETED, "已签收", "", "", tracks, "", "INTERFACE5", "",
                oldStatusTime, oldStatusTime, "INTERFACE5", "");

        assertFalse(ExpressVisibilityPolicy.isExpired(item, NOW));
    }

    @Test
    public void missingProviderTimeFallsBackToWhenSignedStateWasStored() {
        long storedAt = NOW - ExpressVisibilityPolicy.SIGNED_VISIBLE_MS;
        ExpressItem item = new ExpressItem(1L, "", "TEST123", "ZTO", "中通快递",
                StatusSemantic.COMPLETED, "已签收", "", "", "[]", "", "INTERFACE5", "",
                0L, storedAt, "INTERFACE5", "");
        assertTrue(ExpressVisibilityPolicy.isExpired(item, NOW));
    }

    @Test
    public void cancelledShipmentExpiresAtFourHourBoundary() {
        assertFalse(ExpressVisibilityPolicy.isExpired(
                item(StatusSemantic.CANCELLED,
                        NOW - ExpressVisibilityPolicy.CANCELLED_VISIBLE_MS + 1L), NOW));
        assertTrue(ExpressVisibilityPolicy.isExpired(
                item(StatusSemantic.CANCELLED,
                        NOW - ExpressVisibilityPolicy.CANCELLED_VISIBLE_MS), NOW));
    }

    @Test
    public void accountOrderDoesNotStartCarrierRetentionFromItsOrderState() {
        assertFalse(ExpressVisibilityPolicy.isExpired(
                accountOrder(StatusSemantic.COMPLETED,
                        NOW - ExpressVisibilityPolicy.SIGNED_VISIBLE_MS), NOW));
        assertFalse(ExpressVisibilityPolicy.isExpired(
                accountOrder(StatusSemantic.CANCELLED,
                        NOW - ExpressVisibilityPolicy.CANCELLED_VISIBLE_MS), NOW));
    }

    @Test
    public void deletionTombstoneUsesSha256AndNormalizesCase() {
        String lowerCase = ExpressRepository.waybillHash("abc");
        String upperCase = ExpressRepository.waybillHash("ABC");
        String differentWaybill = ExpressRepository.waybillHash("ABD");

        assertEquals(
                "b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78",
                lowerCase);
        assertEquals(lowerCase, upperCase);
        assertEquals(lowerCase, ExpressRepository.waybillHash(" abc "));
        assertNotEquals(lowerCase, differentWaybill);
        assertTrue(lowerCase.matches("[0-9a-f]{64}"));
    }

    @Test
    public void retentionPruneRunsHourlyAndRetriesAfterClockRollback() {
        long interval = ExpressRepository.RETENTION_PRUNE_INTERVAL_MS;
        assertTrue(ExpressRepository.isRetentionPruneDue(0L, NOW));
        assertFalse(ExpressRepository.isRetentionPruneDue(NOW - interval + 1L, NOW));
        assertTrue(ExpressRepository.isRetentionPruneDue(NOW - interval, NOW));
        assertTrue(ExpressRepository.isRetentionPruneDue(NOW + 1L, NOW));
    }

    @Test
    public void pendingQueriesRetryEveryThirtyMinutesAndHandleClockRollback() {
        long interval = ExpressRepository.PENDING_QUERY_RETRY_INTERVAL_MS;
        assertTrue(ExpressRepository.isPendingQueryDue(0L, NOW));
        assertFalse(ExpressRepository.isPendingQueryDue(NOW - interval + 1L, NOW));
        assertTrue(ExpressRepository.isPendingQueryDue(NOW - interval, NOW));
        assertTrue(ExpressRepository.isPendingQueryDue(NOW + 1L, NOW));
    }

    @Test
    public void pendingQueriesExpireAtSevenDayBoundary() {
        long ttl = ExpressRepository.PENDING_QUERY_TTL_MS;
        assertFalse(ExpressRepository.isPendingQueryExpired(NOW - ttl + 1L, NOW));
        assertTrue(ExpressRepository.isPendingQueryExpired(NOW - ttl, NOW));
        assertTrue(ExpressRepository.isPendingQueryExpired(0L, NOW));
    }

    @Test
    public void pendingQueryClockRollbackRestartsTtlAndRetryClock() {
        assertFalse(ExpressRepository.isPendingQueryExpired(NOW + 1L, NOW));
        assertEquals(NOW,
                ExpressRepository.pendingCreatedAtAfterClockRollback(NOW + 1L, NOW));
        assertFalse(ExpressRepository.isPendingQueryExpired(NOW, NOW));
        assertTrue(ExpressRepository.isPendingQueryDue(0L, NOW));
    }

    private static ExpressItem item(StatusSemantic semantic, long eventTime) {
        return item(semantic, eventTime, "INTERFACE5");
    }

    private static ExpressItem item(
            StatusSemantic semantic, long eventTime, String source) {
        return new ExpressItem(1L, "", "TEST123", "ZTO", "中通快递",
                semantic, semantic.label, "", "", "[]", "", source, "",
                eventTime, eventTime, source, "");
    }

    private static ExpressItem accountOrder(
            StatusSemantic sourceSemantic, long eventTime) {
        return new ExpressItem(
                1L, "", "JDORDER000001", "JD", "京东购物",
                StatusSemantic.ORDERED, StatusSemantic.ORDERED.label, "订单已创建", "",
                "[]", "", "I5-JD", "", eventTime, eventTime, "I5-JD", "", "", "",
                true, "", "", "", "JingDong", false, "", 0L, sourceSemantic);
    }
}
