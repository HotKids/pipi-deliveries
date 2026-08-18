package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressHomeOrderProjectionTest {
    private static final String ROUTE_A = "https://order.jd.com/detail?token=a";
    private static final String ROUTE_ROTATED = "https://order.jd.com/detail?token=b";
    private static final String ROUTE_NEW_ENDPOINT = "https://wqs.jd.com/detail?token=c";

    @Test
    public void onlyUnresolvedOrdersWithAnAvailableRouteAreEligible() {
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(
                order(1L, "I5-JD", "", true, ROUTE_A)));
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(
                order(2L, "I6-JD", "", true, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(3L, "I5-JD", "JDWAYBILL123", true, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(4L, "I5-JD", "", false, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(5L, "I5-JD", "", true, "")));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(normalShipment()));
    }

    @Test
    public void homeQueueIsFifoAndAttemptsEachRowOncePerBatch() {
        ExpressItem first = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressItem second = order(2L, "I5-JD", "", true, ROUTE_A);
        Set<String> attempted = new HashSet<>();

        assertEquals(first, ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(first, first, second), attempted));
        assertEquals(second, ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(first, first, second), attempted));
        assertNull(ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(first, first, second), attempted));
    }

    @Test
    public void failedProjectionCoolsOnlyTheSameStableIdentityAndRoute() {
        long now = 1_000_000L;
        ExpressItem first = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressItem sameIdentity = orderWithIdentity(
                9L, "I5-JD", "JDORDER1", "", true, ROUTE_A);
        ExpressItem rotatedCredential = order(
                1L, "I5-JD", "", true, ROUTE_ROTATED);
        ExpressItem changedEndpoint = order(
                1L, "I5-JD", "", true, ROUTE_NEW_ENDPOINT);
        ExpressItem alternateSource = order(1L, "I6-JD", "", true, ROUTE_A);

        String failedRoute = ExpressOrderProjectionRetryStore.routeFingerprint(first);
        assertFalse(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, failedRoute,
                ExpressOrderProjectionRetryStore.routeFingerprint(sameIdentity), now + 1L));
        assertFalse(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, failedRoute,
                ExpressOrderProjectionRetryStore.routeFingerprint(rotatedCredential), now + 1L));
        assertTrue(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, failedRoute,
                ExpressOrderProjectionRetryStore.routeFingerprint(changedEndpoint), now + 1L));
        assertTrue(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, failedRoute,
                ExpressOrderProjectionRetryStore.routeFingerprint(alternateSource), now + 1L));
        assertTrue(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, failedRoute, failedRoute,
                now + ExpressOrderProjectionRetryStore.FAILURE_COOLDOWN_MS));
    }

    @Test
    public void cooldownIdentityIsScopedToSourceAndOrderNotRowId() {
        ExpressItem first = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressItem sameOrderDifferentRow = orderWithIdentity(
                9L, "I5-JD", "JDORDER1", "", true, ROUTE_A);
        ExpressItem otherSource = order(1L, "I6-JD", "", true, ROUTE_A);

        assertEquals(ExpressOrderProjectionRetryStore.stableIdentity(first),
                ExpressOrderProjectionRetryStore.stableIdentity(sameOrderDifferentRow));
        assertFalse(ExpressOrderProjectionRetryStore.stableIdentity(first).equals(
                ExpressOrderProjectionRetryStore.stableIdentity(otherSource)));
    }

    @Test
    public void routeChangeCanRetryWithoutWaitingForTheInMemoryBatchToReset() {
        ExpressItem first = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressItem changedRoute = order(
                1L, "I5-JD", "", true, ROUTE_NEW_ENDPOINT);
        Set<String> attempted = new HashSet<>();

        assertEquals(first, ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(first), attempted));
        assertEquals(changedRoute, ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(changedRoute), attempted));
    }

    private static ExpressItem order(
            long rowId, String owner, String projectedWaybill,
            boolean credentialAvailable, String credential) {
        return orderWithIdentity(rowId, owner, "JDORDER" + rowId, projectedWaybill,
                credentialAvailable, credential);
    }

    private static ExpressItem orderWithIdentity(
            long rowId, String owner, String orderId, String projectedWaybill,
            boolean credentialAvailable, String credential) {
        return new ExpressItem(
                rowId, "", orderId, "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单正在配送",
                "2026-08-22 10:00:00", "[]", "", owner, "",
                1L, 2L, owner, "", "v5", credential, credentialAvailable,
                projectedWaybill, "", "[]");
    }

    private static ExpressItem normalShipment() {
        return new ExpressItem(
                6L, "", "ZTO123456789", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "运输中", "已到达转运中心",
                "2026-08-22 10:00:00", "[]", "", "INTERFACE5", "",
                1L, 2L, "INTERFACE5", "", "v5", "route", true,
                "", "", "[]");
    }
}
