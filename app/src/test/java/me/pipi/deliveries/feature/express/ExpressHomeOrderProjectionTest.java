package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.Test;

public final class ExpressHomeOrderProjectionTest {
    private static final String ROUTE_A = "https://order.jd.com/detail?token=a";
    private static final String ROUTE_ROTATED = "https://order.jd.com/detail?token=b";
    private static final String ROUTE_NEW_ENDPOINT = "https://wqs.jd.com/detail?token=c";
    private static final String ROUTE_NEW_PATH = "https://order.jd.com/order/detail?token=c";
    private static final String ROUTE_NEW_PORT = "https://order.jd.com:8443/detail?token=c";

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
        ExpressItem changedPath = order(
                1L, "I5-JD", "", true, ROUTE_NEW_PATH);
        ExpressItem changedPort = order(
                1L, "I5-JD", "", true, ROUTE_NEW_PORT);
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
                ExpressOrderProjectionRetryStore.routeFingerprint(changedPath), now + 1L));
        assertTrue(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, failedRoute,
                ExpressOrderProjectionRetryStore.routeFingerprint(changedPort), now + 1L));
        assertTrue(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, failedRoute,
                ExpressOrderProjectionRetryStore.routeFingerprint(alternateSource), now + 1L));
        assertTrue(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, failedRoute, failedRoute,
                now + ExpressOrderProjectionRetryStore.FAILURE_COOLDOWN_MS));
        assertFalse(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, failedRoute, failedRoute,
                now + ExpressOrderProjectionRetryStore.FAILURE_COOLDOWN_MS - 1L));
        assertEquals(60L * 60L * 1000L,
                ExpressOrderProjectionRetryStore.FAILURE_COOLDOWN_MS);
    }

    @Test
    public void forcedDetailAttemptBypassesCooldownButNotAnActiveAttempt() {
        ExpressItem order = order(1L, "I5-JD", "", true, ROUTE_A);
        long now = 1_000_000L;
        String route = ExpressOrderProjectionRetryStore.routeFingerprint(order);

        assertFalse(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, route, route, now + 1L));
        assertTrue(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, route, route, now + 1L, true));
        ExpressOrderProjectionRetryStore.AttemptToken first =
                ExpressOrderProjectionRetryStore.acquireAttempt(order);
        assertNotNull(first);
        assertNull(ExpressOrderProjectionRetryStore.acquireAttempt(order));
        assertNull(ExpressOrderProjectionRetryStore.acquireAttempt(
                orderWithIdentity(9L, "I5-JD", order.waybill, "", true,
                        ROUTE_NEW_ENDPOINT)));
        ExpressItem otherSource = orderWithIdentity(
                9L, "I6-JD", order.waybill, "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken other =
                ExpressOrderProjectionRetryStore.acquireAttempt(otherSource);
        assertNotNull(other);
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(other));
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(first));
        ExpressOrderProjectionRetryStore.AttemptToken replacement =
                ExpressOrderProjectionRetryStore.acquireAttempt(order);
        assertNotNull(replacement);
        assertFalse(ExpressOrderProjectionRetryStore.releaseAttempt(first));
        assertNull(ExpressOrderProjectionRetryStore.acquireAttempt(order));
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(replacement));
    }

    @Test
    public void detailHandoffRechecksTheCurrentUnresolvedOwner() {
        ExpressItem stale = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressItem refreshedRoute = orderWithIdentity(
                1L, "I5-JD", stale.waybill, "", true, ROUTE_ROTATED);
        ExpressItem resolvedByHome = orderWithIdentity(
                1L, "I5-JD", stale.waybill, "JDWAYBILL123", true, ROUTE_ROTATED);

        assertEquals(refreshedRoute,
                ExpressOrderProjectionRetryStore.currentUnresolvedOwner(
                        stale, refreshedRoute));
        assertNull(ExpressOrderProjectionRetryStore.currentUnresolvedOwner(
                stale, resolvedByHome));
    }

    @Test
    public void failedCooldownPersistenceCannotLeakTheActiveAttempt() {
        ExpressItem order = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken token =
                ExpressOrderProjectionRetryStore.acquireAttempt(order);
        assertNotNull(token);
        AtomicInteger wakeups = new AtomicInteger();
        ExpressOrderProjectionRetryStore.WaitToken waiter =
                ExpressOrderProjectionRetryStore.waitForAttemptRelease(
                        order, wakeups::incrementAndGet);
        assertNotNull(waiter);
        IllegalStateException databaseFailure =
                new IllegalStateException("database unavailable");
        AtomicReference<RuntimeException> reportedFailure = new AtomicReference<>();
        assertFalse(ExpressOrderProjectionRetryStore.completeAttempt(
                token, () -> { throw databaseFailure; }, reportedFailure::set));
        assertEquals(1, wakeups.get());
        assertSame(databaseFailure, reportedFailure.get());
        assertFalse(ExpressOrderProjectionRetryStore.cancelWait(waiter));
        ExpressOrderProjectionRetryStore.AttemptToken retry =
                ExpressOrderProjectionRetryStore.acquireAttempt(order);
        assertNotNull(retry);
        ExpressOrderProjectionRetryStore.releaseAttempt(retry);
    }

    @Test
    public void staleAttemptCannotRunCompletionOrReleaseTheCurrentAttempt() {
        ExpressItem order = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken stale =
                ExpressOrderProjectionRetryStore.acquireAttempt(order);
        assertNotNull(stale);
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(stale));
        ExpressOrderProjectionRetryStore.AttemptToken current =
                ExpressOrderProjectionRetryStore.acquireAttempt(order);
        assertNotNull(current);
        AtomicInteger callbacks = new AtomicInteger();
        AtomicInteger failures = new AtomicInteger();

        assertFalse(ExpressOrderProjectionRetryStore.completeAttempt(
                stale, callbacks::incrementAndGet,
                ignored -> failures.incrementAndGet()));
        assertEquals(0, callbacks.get());
        assertEquals(0, failures.get());
        assertNull(ExpressOrderProjectionRetryStore.acquireAttempt(order));
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(current));
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
    public void bridgeResultCanOnlyApplyToTheSameCurrentUnresolvedOwner() {
        ExpressItem expected = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressItem rotatedRoute = orderWithIdentity(
                1L, "I5-JD", expected.waybill, "", true, ROUTE_ROTATED);
        ExpressItem replacedOrder = orderWithIdentity(
                1L, "I5-JD", "OTHERORDER", "", true, ROUTE_A);
        ExpressItem otherSource = orderWithIdentity(
                1L, "I6-JD", expected.waybill, "", true, ROUTE_A);
        ExpressItem alreadyProjected = orderWithIdentity(
                1L, "I5-JD", expected.waybill, "SF123456789", true, ROUTE_A);

        assertTrue(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, rotatedRoute));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, replacedOrder));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, otherSource));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, alreadyProjected));
    }

    @Test
    public void bridgeResultRejectsEveryCaptureContractChange() {
        ExpressItem expected = order(1L, "I5-JD", "", true, ROUTE_A);

        assertTrue(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, orderWithCaptureIdentity(expected, "JingDong", "JD",
                        "京东购物", "", "v5", ROUTE_ROTATED)));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, orderWithCaptureIdentity(expected, "OtherProvider", "JD",
                        "京东购物", "", "v5", ROUTE_A)));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, orderWithCaptureIdentity(expected, "JingDong", "JDKD",
                        "京东购物", "", "v5", ROUTE_A)));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, orderWithCaptureIdentity(expected, "JingDong", "JD",
                        "京东快递", "", "v5", ROUTE_A)));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, orderWithCaptureIdentity(expected, "JingDong", "JD",
                        "京东购物", "INTERFACE5", "v5", ROUTE_A)));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, orderWithCaptureIdentity(expected, "JingDong", "JD",
                        "京东购物", "", "v6", ROUTE_A)));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, orderWithCaptureIdentity(expected, "JingDong", "JD",
                        "京东购物", "", "v5", ROUTE_NEW_ENDPOINT)));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, orderWithCaptureIdentity(expected, "JingDong", "JD",
                        "京东购物", "", "v5", ROUTE_NEW_PATH)));
        assertFalse(ExpressOrderProjectionBridge.sameUnresolvedOwner(
                expected, orderWithCaptureIdentity(expected, "JingDong", "JD",
                        "京东购物", "", "v5", ROUTE_NEW_PORT)));
    }

    @Test
    public void waitingDetailAttemptResumesExactlyWhenTheActiveCaptureReleases() {
        ExpressItem order = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken active =
                ExpressOrderProjectionRetryStore.acquireAttempt(order);
        assertNotNull(active);
        AtomicReference<ExpressOrderProjectionRetryStore.AttemptToken> resumed =
                new AtomicReference<>();
        AtomicInteger wakeups = new AtomicInteger();

        ExpressOrderProjectionRetryStore.WaitToken wait =
                ExpressOrderProjectionRetryStore.waitForAttemptRelease(order, () -> {
                    wakeups.incrementAndGet();
                    resumed.set(ExpressOrderProjectionRetryStore.acquireAttempt(order));
                });
        assertNotNull(wait);
        assertNull(resumed.get());
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(active));
        assertEquals(1, wakeups.get());
        assertNotNull(resumed.get());
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(resumed.get()));
        assertFalse(ExpressOrderProjectionRetryStore.cancelWait(wait));
        assertTrue(ExpressDetailActivity.ORDER_CAPTURE_WAIT_TIMEOUT_MS
                > ExpressDetailActivity.ORDER_CAPTURE_TIMEOUT_MS);
    }

    @Test
    public void destroyedDetailCanCancelItsAttemptReleaseWakeup() {
        ExpressItem order = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken active =
                ExpressOrderProjectionRetryStore.acquireAttempt(order);
        assertNotNull(active);
        AtomicInteger wakeups = new AtomicInteger();
        ExpressOrderProjectionRetryStore.WaitToken wait =
                ExpressOrderProjectionRetryStore.waitForAttemptRelease(
                        order, wakeups::incrementAndGet);

        assertNotNull(wait);
        assertTrue(ExpressOrderProjectionRetryStore.cancelWait(wait));
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(active));
        assertEquals(0, wakeups.get());
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

    @Test
    public void upgradedCaptureAlgorithmInvalidatesTheOldFailureCooldown() throws Exception {
        long now = 1_000_000L;
        ExpressItem order = order(1L, "I5-JD", "", true, ROUTE_A);
        String oldFingerprint = legacyFingerprint(order);

        assertTrue(ExpressOrderProjectionRetryStore.shouldAttempt(
                now, oldFingerprint,
                ExpressOrderProjectionRetryStore.routeFingerprint(order), now + 1L));
    }

    private static String legacyFingerprint(ExpressItem item) throws Exception {
        String input = ExpressOrderProjectionRetryStore.stableIdentity(item)
                + "\n" + item.routeInterface + ":order.jd.com";
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(
                input.getBytes(StandardCharsets.UTF_8));
        StringBuilder encoded = new StringBuilder(digest.length * 2);
        for (byte value : digest) {
            encoded.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return encoded.toString();
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
                projectedWaybill, "", "[]", "JingDong");
    }

    private static ExpressItem orderWithCaptureIdentity(
            ExpressItem source, String sourceProvider, String courierCode,
            String companyName, String routeOwner, String routeInterface,
            String routeCredential) {
        return new ExpressItem(
                source.rowId, source.phone, source.waybill, courierCode, companyName,
                source.semantic, source.statusDescription, source.latestDetail,
                source.latestTime, source.tracksJson, source.remark, source.source,
                source.detailUrl, source.statusEventTime, source.updatedAt,
                source.stateOwner, routeOwner, routeInterface, routeCredential,
                source.routeCredentialAvailable, source.projectedWaybill,
                source.projectedCompanyName, source.projectedTracksJson, sourceProvider);
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
