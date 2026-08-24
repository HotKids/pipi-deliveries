package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.annotation.SuppressLint;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.database.SQLException;
import android.database.sqlite.SQLiteDatabase;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

import java.text.SimpleDateFormat;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressRepositoryDatabaseTest {
    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0)
                .edit().clear().commit();
        database = new ExpressDatabase(context);
        database.getWritableDatabase();
        repository = new ExpressRepository(context, database);
    }

    @After
    public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test
    public void manualPollClaimIsOwnerScopedAndSuccessClearsIt() {
        ExpressItem first = insertOwner("SFTEST000001", "13900000001", StatusSemantic.TRANSIT);
        ExpressItem second = insertOwner("SFTEST000002", "13900000002", StatusSemantic.TRANSIT);
        long now = 2_000_000L;

        ExpressRepository.ManualTimelinePollClaim firstClaim =
                repository.claimManualTimelinePoll(first, now);
        assertNotNull(firstClaim);
        assertNull(repository.claimManualTimelinePoll(first, now + 1L));
        ExpressRepository.ManualTimelinePollClaim secondClaim =
                repository.claimManualTimelinePoll(second, now);
        assertNotNull(secondClaim);
        assertEquals(2, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE, null, null));

        ExpressItem saved = repository.saveOwnerManualTimeline(
                first, timedResult(first.waybill, "2026-08-24 09:00:00", "快件已揽收"),
                first.phone, "interface5");
        assertNotNull(saved);
        ManualTimelineAuthorityPolicy.Candidate authority =
                repository.manualTimelineAuthority(first);
        assertNotNull(authority);
        assertTrue(authority.result.tracksJson.contains("快件已揽收"));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(first.rowId)}));

        repository.saveOwnerManualTimeline(
                first, timedResult(first.waybill,
                        "2026-08-24 10:00:00", "快件运输中"),
                first.phone, "interface5");
        ManualTimelineAuthorityPolicy.Candidate merged =
                repository.manualTimelineAuthority(first);
        assertNotNull(merged);
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(first.rowId)}));
        assertTrue(merged.result.tracksJson.contains("快件已揽收"));
        assertTrue(merged.result.tracksJson.contains("快件运输中"));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(second.rowId)}));
    }

    @Test
    public void foregroundManualPollSeparatesForceCooldownFromActiveLease() {
        ExpressItem owner = insertOwner(
                "SFTEST000003", "13900000003", StatusSemantic.TRANSIT);
        long now = 3_000_000L;

        ExpressRepository.ManualTimelinePollClaim first =
                repository.claimForegroundManualTimelinePoll(owner, now, false);
        assertNotNull(first);
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 1L, true));

        repository.releaseManualTimelinePoll(first);
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 1L, false));
        ExpressRepository.ManualTimelinePollClaim forced =
                repository.claimForegroundManualTimelinePoll(owner, now + 1L, true);
        assertNotNull(forced);

        repository.releaseManualTimelinePoll(first);
        assertNull(repository.claimForegroundManualTimelinePoll(owner, now + 2L, true));
        repository.releaseManualTimelinePoll(forced);

        ExpressRepository.ManualTimelinePollClaim afterInterval =
                repository.claimForegroundManualTimelinePoll(
                        owner, now + 1L
                                + ExpressRepository.MANUAL_TIMELINE_FOREGROUND_INTERVAL_MS,
                        false);
        assertNotNull(afterInterval);
        repository.releaseManualTimelinePoll(afterInterval);
    }

    @Test
    public void foregroundManualPollUsesShortCadenceAfterARecentSuccessfulTimeline() {
        ExpressItem owner = insertOwner(
                "SFTEST000005", "13900000005", StatusSemantic.TRANSIT);
        repository.saveOwnerManualTimeline(
                owner, timedResult(owner.waybill,
                        "2026-08-24 09:00:00", "快件运输中"),
                owner.phone, "interface5");
        long now = ExpressSourcePolicy.parseEventTime("2026-08-24 09:01:00");

        ExpressRepository.ManualTimelinePollClaim first =
                repository.claimForegroundManualTimelinePoll(owner, now, false);
        assertNotNull(first);
        repository.releaseManualTimelinePoll(first);
        assertNull(repository.claimForegroundManualTimelinePoll(
                owner, now + ExpressRepository.MANUAL_TIMELINE_FOREGROUND_INTERVAL_MS - 1L,
                false));
        ExpressRepository.ManualTimelinePollClaim automatic =
                repository.claimForegroundManualTimelinePoll(
                        owner, now + ExpressRepository.MANUAL_TIMELINE_FOREGROUND_INTERVAL_MS,
                        false);
        assertNotNull(automatic);
        repository.releaseManualTimelinePoll(automatic);

        ExpressRepository.ManualTimelinePollClaim forced =
                repository.claimForegroundManualTimelinePoll(
                        owner, now + ExpressRepository.MANUAL_TIMELINE_FOREGROUND_INTERVAL_MS + 1L,
                        true);
        assertNotNull(forced);
        repository.releaseManualTimelinePoll(forced);
    }

    @Test
    public void expiredManualLeaseCanRecoverButCompletedPackageCannotBeClaimed() {
        ExpressItem owner = insertOwner(
                "SFTEST000004", "13900000004", StatusSemantic.TRANSIT);
        long now = 4_000_000L;
        assertNotNull(repository.claimForegroundManualTimelinePoll(owner, now, true));

        ExpressRepository.ManualTimelinePollClaim recovered =
                repository.claimForegroundManualTimelinePoll(
                        owner, now + ExpressRepository.MANUAL_TIMELINE_ACTIVE_LEASE_MS, true);
        assertNotNull(recovered);
        repository.releaseManualTimelinePoll(recovered);

        ExpressQueryResult completed = timedResult(
                owner.waybill, "2026-08-24 12:00:00", "快件已签收");
        assertNotNull(repository.saveOwnerManualTimeline(
                owner, completed, owner.phone, "interface5"));
        ExpressItem current = repository.find(owner.rowId);
        assertNotNull(current);
        assertEquals(StatusSemantic.COMPLETED, current.semantic);
        assertNull(repository.claimForegroundManualTimelinePoll(
                current, now + ExpressRepository.MANUAL_TIMELINE_ACTIVE_LEASE_MS + 1L, true));
    }

    @Test
    public void rawCompletedOwnerCanStillAcquireItsFirstManualTimeline() {
        ExpressItem owner = insertOwner(
                "SFTEST000006", "13900000006", StatusSemantic.COMPLETED);

        ExpressRepository.ManualTimelinePollClaim claim =
                repository.claimForegroundManualTimelinePoll(owner, 5_000_000L, true);

        assertNotNull(claim);
        repository.releaseManualTimelinePoll(claim);
    }

    @Test
    public void rawCompletedOwnerKeepsRefreshingANonterminalManualTimeline() {
        ExpressItem owner = insertOwner(
                "SFTEST000007", "13900000007", StatusSemantic.COMPLETED);
        assertNotNull(repository.saveOwnerManualTimeline(
                owner, timedResult(owner.waybill,
                        "2026-08-24 09:00:00", "快件运输中"),
                owner.phone, "interface5"));
        ExpressItem projected = repository.find(owner.rowId);
        assertNotNull(projected);
        assertEquals(StatusSemantic.TRANSIT, projected.semantic);

        ExpressRepository.ManualTimelinePollClaim claim =
                repository.claimForegroundManualTimelinePoll(projected, 5_100_000L, true);

        assertNotNull(claim);
        repository.releaseManualTimelinePoll(claim);
    }

    @Test
    public void manualLeaseCanRecoverAfterWallClockRollback() {
        ExpressRepository.ManualTimelineRetryState retry =
                new ExpressRepository.ManualTimelineRetryState(
                        10_000L, "active", 20_000L);

        assertTrue(ExpressRepository.manualTimelineActiveLeaseAvailable(retry, 9_999L));
        assertFalse(ExpressRepository.manualTimelineActiveLeaseAvailable(retry, 10_001L));
        assertTrue(ExpressRepository.manualTimelineActiveLeaseAvailable(retry, 20_000L));
    }

    @Test
    public void manualDeleteAndUnbindRemoveOnlyTheirOwnerSidecars() {
        ExpressItem deleted = insertOwner(
                "SFTEST000011", "13900000011", StatusSemantic.TRANSIT);
        ExpressItem retained = insertOwner(
                "SFTEST000012", "13900000012", StatusSemantic.TRANSIT);
        saveAndClaimAgain(deleted);
        saveAndClaimAgain(retained);

        repository.delete(deleted.rowId);

        assertNull(repository.find(deleted.rowId));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(deleted.rowId)}));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(deleted.rowId)}));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(retained.rowId)}));
        assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(retained.rowId)}));

        repository.bindPhoneLocally(retained.phone, "interface5");
        repository.unbindPhone(retained.phone, "interface5");
        assertNull(repository.find(retained.rowId));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(retained.rowId)}));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(retained.rowId)}));
    }

    @Test
    public void retentionRemovesManualTimelineAndRetryTogether() {
        ExpressItem expired = insertOwner(
                "SFTEST000021", "13900000021", StatusSemantic.COMPLETED);
        repository.saveOwnerManualTimeline(
                expired, timedResult(expired.waybill,
                        "2020-01-01 09:00:00", "快件已签收"),
                expired.phone, "interface5");
        insertRetry(expired, 1_000L);

        repository.pruneExpiredShipmentsIfDue();

        assertNull(repository.find(expired.rowId));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                "owner_row_id=?", new String[]{Long.toString(expired.rowId)}));
        assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_RETRY_TABLE,
                "owner_row_id=?", new String[]{Long.toString(expired.rowId)}));
    }

    @Test
    public void projectionSuccessAndOwnerDeletionCannotLeaveRetryState() {
        ExpressItem order = insertOrder("JDORDER000001", "13900000031");
        repository.recordOrderProjectionFailure(order, 1_000L, "route-a");
        ExpressRepository.OrderProjectionRetryState failed =
                repository.orderProjectionRetryState(order);
        assertEquals(1_000L, failed.failedAt);
        assertEquals("route-a", failed.routeFingerprint);

        assertTrue(repository.saveOrderProjection(
                order, "interface5", "SFPROJECT00001", "顺丰速运"));
        ExpressRepository.OrderProjectionRetryState cleared =
                repository.orderProjectionRetryState(order);
        assertEquals(0L, cleared.failedAt);
        assertEquals("", cleared.routeFingerprint);

        repository.recordOrderProjectionFailure(order, 2_000L, "route-a");
        repository.delete(order.rowId);
        ExpressRepository.OrderProjectionRetryState deleted =
                repository.orderProjectionRetryState(order);
        assertEquals(0L, deleted.failedAt);
        assertEquals("", deleted.routeFingerprint);
    }

    @Test
    public void projectionCommitIsScopedToStableOwnerAndBinding() {
        ExpressItem primary = insertOrder("JDORDER000101", "13900000101");
        ExpressItem secondary = insertOrder(
                "JDORDER0001019", "13900000102", "I6-JD", "v6");
        repository.recordOrderProjectionFailure(primary, 1_001L, "route-primary");
        repository.recordOrderProjectionFailure(secondary, 1_002L, "route-secondary");

        assertFalse(repository.saveOrderProjection(
                primary, "interface6", "JD0256719000101", "京东快递"));
        assertEquals(1_001L, rawRetryAt(primary.rowId));
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE, null, null));

        assertTrue(repository.saveOrderProjection(
                primary, "interface5", "JD0256719000101", "京东快递"));
        assertEquals(0L, rawRetryAt(primary.rowId));
        assertEquals(1_002L, rawRetryAt(secondary.rowId));
        assertEquals("JD0256719000101", repository.find(primary.rowId).displayWaybill());
        assertEquals(secondary.waybill, repository.find(secondary.rowId).displayWaybill());
        assertEquals(1, count(ExpressDatabase.ORDER_PROJECTION_TABLE,
                "normalized_source_id=? AND binding_source=?",
                new String[]{ExpressSourcePolicy.normalizeWaybill(primary.waybill),
                        "interface5"}));
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE,
                "normalized_source_id=? AND binding_source=?",
                new String[]{ExpressSourcePolicy.normalizeWaybill(secondary.waybill),
                        "interface6"}));

        ContentValues replacement = new ContentValues();
        replacement.put("mailNo", "JDORDERREPLACED");
        replacement.put("normalizedMailNo",
                ExpressSourcePolicy.normalizeWaybill("JDORDERREPLACED"));
        assertEquals(1, database.getWritableDatabase().update(
                ExpressDatabase.EXPRESS_TABLE, replacement, "_id=?",
                new String[]{Long.toString(secondary.rowId)}));

        assertFalse(repository.saveOrderProjection(
                secondary, "interface6", "JD0256719000102", "京东快递"));
        assertEquals(1_002L, rawRetryAt(secondary.rowId));
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE,
                "binding_source=?", new String[]{"interface6"}));
    }

    @Test
    public void staleCaptureCannotCommitOrCoolAChangedOwnerContract() {
        ExpressItem captured = insertOrder("JDORDER000103", "13900000103");
        String attemptedRoute = ExpressOrderProjectionIdentity.routeFingerprint(captured);
        repository.recordOrderProjectionFailure(captured, 1_003L, attemptedRoute);
        assertEquals(1_003L, rawRetryAt(captured.rowId));
        assertEquals(attemptedRoute, rawRetryRoute(captured.rowId));

        ContentValues changedContract = new ContentValues();
        // Change only the route contract. Provider/courier changes were already guarded by the
        // legacy identity check and would not prove that a stale capture cannot cross routes.
        changedContract.put("routeInterface", "v6");
        assertEquals(1, database.getWritableDatabase().update(
                ExpressDatabase.EXPRESS_TABLE, changedContract, "_id=?",
                new String[]{Long.toString(captured.rowId)}));
        ExpressItem current = repository.find(captured.rowId);
        assertNotNull(current);
        String currentRoute = ExpressOrderProjectionIdentity.routeFingerprint(current);
        assertFalse(attemptedRoute.equals(currentRoute));

        ContentValues currentCooldown = new ContentValues();
        currentCooldown.put("projectionRetryAt", 2_003L);
        currentCooldown.put("projectionRetryRoute", currentRoute);
        assertEquals(1, database.getWritableDatabase().update(
                ExpressDatabase.EXPRESS_TABLE, currentCooldown, "_id=?",
                new String[]{Long.toString(captured.rowId)}));

        assertFalse(repository.saveOrderProjection(
                captured, "interface5", "JD0256719000103", "京东快递"));
        repository.recordOrderProjectionFailure(captured, 3_003L, attemptedRoute);
        assertEquals(2_003L, rawRetryAt(captured.rowId));
        assertEquals(currentRoute, rawRetryRoute(captured.rowId));
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE, null, null));
    }

    @Test
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    public void projectedTimelinePublishesBeforeCanonicalOwnerBackfill() {
        ExpressItem order = insertOrder("JDORDER000102", "13900000102");
        String displayWaybill = "JD0256719000102";
        assertTrue(repository.saveOrderProjection(
                order, "interface5", displayWaybill, "京东快递"));
        ContentValues legacyCanonicalState = new ContentValues();
        legacyCanonicalState.put("normalizedMailNo", "");
        assertEquals(1, database.getWritableDatabase().update(
                ExpressDatabase.EXPRESS_TABLE, legacyCanonicalState, "_id=?",
                new String[]{Long.toString(order.rowId)}));

        AtomicInteger broadcasts = new AtomicInteger();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                if (ExpressRepository.ACTION_CHANGED.equals(intent.getAction())) {
                    broadcasts.incrementAndGet();
                }
            }
        };
        context.registerReceiver(receiver, new IntentFilter(ExpressRepository.ACTION_CHANGED));
        try {
            repository.saveKuaidi100Timeline(timedResult(
                    displayWaybill, "2026-08-24 15:00:00", "快件运输中"));

            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(1, broadcasts.get());
            ExpressItem projected = repository.find(order.rowId);
            assertNotNull(projected);
            assertEquals(displayWaybill, projected.displayWaybill());
            assertTrue(projected.tracksJson.contains("快件运输中"));
        } finally {
            context.unregisterReceiver(receiver);
        }
    }

    @Test
    public void projectedOrderPresentsItsLatestCarrierStateAcrossRepositoryReads() {
        String orderId = "JDORDER000104";
        String phone = "13900000104";
        ContentValues values = shipmentValues(
                orderId, phone, "JD", "京东购物", "I5-JD", "JingDong",
                StatusSemantic.TRANSIT);
        values.put("lastLogisticDetail", "圆通快件正在转运中心运输");
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);

        ExpressItem unprojected = repository.find(rowId);
        assertNotNull(unprojected);
        assertEquals(StatusSemantic.ORDERED, unprojected.semantic);
        assertEquals("已下单", unprojected.displayStatus());

        assertTrue(repository.saveOrderProjection(
                unprojected, "interface5", "YT0256719000104", "圆通速递"));

        ExpressItem projected = repository.find(rowId);
        assertNotNull(projected);
        assertEquals(StatusSemantic.TRANSIT, projected.sourceSemantic);
        assertEquals(StatusSemantic.TRANSIT, projected.semantic);
        assertEquals("运输中", projected.displayStatus());
        assertEquals("圆通快件正在转运中心运输", projected.latestDetail);
        assertEquals("YT0256719000104", projected.displayWaybill());

        ExpressItem byOrder = repository.findByWaybill(orderId, "interface5");
        assertNotNull(byOrder);
        assertEquals(StatusSemantic.TRANSIT, byOrder.semantic);
        List<ExpressItem> visible = repository.listVisible("interface5");
        assertEquals(1, visible.size());
        assertEquals(StatusSemantic.TRANSIT, visible.get(0).semantic);
        assertEquals(0, repository.listVisible("interface6").size());
    }

    @Test
    public void projectedOrderSelectsItsCarrierPackageAcrossRepositoryReads() {
        String orderId = "JDORDER000032";
        String phone = "13900000032";
        ContentValues values = shipmentValues(
                orderId, phone, "JD", "京东购物", "I5-JD", "JingDong",
                StatusSemantic.COMPLETED);
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);

        ExpressItem unprojected = repository.find(rowId);
        assertNotNull(unprojected);
        assertEquals(StatusSemantic.ORDERED, unprojected.semantic);
        assertEquals(StatusSemantic.COMPLETED, unprojected.sourceSemantic);

        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                orderId, "JD", "京东购物", StatusSemantic.TRANSIT,
                "2026-08-24 12:00:00", "订单运输中", "[]",
                "", phone, "interface5", "", "", "JingDong"), phone);
        ExpressItem refreshed = repository.find(rowId);
        assertNotNull(refreshed);
        assertEquals(StatusSemantic.ORDERED, refreshed.semantic);
        assertEquals(StatusSemantic.COMPLETED, refreshed.sourceSemantic);
        assertEquals("快件已签收", refreshed.latestDetail);

        android.app.NotificationManager notifications =
                context.getSystemService(android.app.NotificationManager.class);
        assertNotNull(notifications);
        assertEquals(0, notifications.getActiveNotifications().length);

        assertTrue(repository.saveOrderProjection(
                repository.find(rowId), "interface5", "JD0256719746857", "京东快递"));
        ExpressItem projected = repository.find(rowId);
        assertNotNull(projected);
        assertEquals(StatusSemantic.COMPLETED, projected.semantic);
        assertEquals(StatusSemantic.COMPLETED, projected.sourceSemantic);
        assertEquals("JD0256719746857", projected.displayWaybill());
        notifications.cancelAll();

        String signedAt = "2026-08-24 13:00:00";
        ExpressQueryResult carrierSigned = new ExpressQueryResult(
                "JD0256719746857", "JD", "京东快递", StatusSemantic.COMPLETED,
                ExpressSourcePolicy.parseEventTime(signedAt), signedAt, "快件已签收",
                "[{\"time\":\"" + signedAt + "\",\"context\":\"快件已签收\"}]",
                "", phone, "kuaidi100", "", "", "");
        repository.saveKuaidi100Timeline(carrierSigned);

        ExpressItem found = repository.find(rowId);
        ExpressItem byOrder = repository.findByWaybill(orderId, "interface5");
        List<ExpressItem> visible = repository.listVisible("interface5");
        assertCarrierProjection(found, carrierSigned);
        assertCarrierProjection(byOrder, carrierSigned);
        assertEquals(1, visible.size());
        assertCarrierProjection(visible.get(0), carrierSigned);
        assertEquals(0, notifications.getActiveNotifications().length);

        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                orderId, "JD", "京东购物", StatusSemantic.COMPLETED,
                "2026-08-24 14:00:00", "订单已完成", "[]",
                "", phone, "interface5", "", "", "JingDong"), phone);
        assertCarrierProjection(repository.find(rowId), carrierSigned);
    }

    @Test
    public void projectedCarrierTimelineCannotRegressTimedCompletedSource() {
        String orderId = "JDORDER000105";
        String phone = "13900000105";
        String signedAt = "2026-08-24 12:00:00";
        ContentValues values = shipmentValues(
                orderId, phone, "JD", "京东购物", "I5-JD", "JingDong",
                StatusSemantic.COMPLETED);
        values.put("statusEventTime", ExpressSourcePolicy.parseEventTime(signedAt));
        values.put("logisticsGmtModified", signedAt);
        values.put("lastLogisticDetail", "顺丰快件已签收");
        values.put("packageDyn", "[{\"time\":\"" + signedAt
                + "\",\"context\":\"顺丰快件已签收\"}]");
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);
        ExpressItem order = repository.find(rowId);
        assertNotNull(order);
        assertTrue(repository.saveOrderProjection(
                order, "interface5", "SF0256719000105", "顺丰速运"));

        repository.saveKuaidi100Timeline(timedResult(
                "SF0256719000105", "2026-08-24 13:00:00", "快件运输中"));

        ExpressItem presented = repository.find(rowId);
        assertNotNull(presented);
        assertEquals(StatusSemantic.COMPLETED, presented.semantic);
        assertEquals("已签收", presented.displayStatus());
        assertEquals(signedAt, presented.latestTime);
        assertEquals("顺丰快件已签收", presented.latestDetail);
        assertTrue(presented.tracksJson.contains("顺丰快件已签收"));
        assertFalse(presented.tracksJson.contains("快件运输中"));
    }

    @Test
    public void projectedOrderKeepsTheNewerNonterminalCarrierPackage() {
        String orderId = "JDORDER000106";
        String phone = "13900000106";
        String dispatchAt = "2026-08-24 13:00:00";
        ContentValues values = shipmentValues(
                orderId, phone, "JD", "京东购物", "I5-JD", "JingDong",
                StatusSemantic.DELIVERY);
        values.put("statusEventTime", ExpressSourcePolicy.parseEventTime(dispatchAt));
        values.put("logisticsGmtModified", dispatchAt);
        values.put("lastLogisticDetail", "圆通快件正在派送");
        values.put("packageDyn", "[{\"time\":\"" + dispatchAt
                + "\",\"context\":\"圆通快件正在派送\"}]");
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);
        ExpressItem order = repository.find(rowId);
        assertNotNull(order);
        assertTrue(repository.saveOrderProjection(
                order, "interface5", "YT0256719000106", "圆通速递"));

        repository.saveKuaidi100Timeline(timedResult(
                "YT0256719000106", "2026-08-24 12:00:00", "快件运输中"));

        ExpressItem presented = repository.find(rowId);
        assertNotNull(presented);
        assertEquals(StatusSemantic.DELIVERY, presented.semantic);
        assertEquals("派送中", presented.displayStatus());
        assertEquals(dispatchAt, presented.latestTime);
        assertEquals("圆通快件正在派送", presented.latestDetail);
        assertTrue(presented.tracksJson.contains("圆通快件正在派送"));
        assertFalse(presented.tracksJson.contains("快件运输中"));
    }

    @Test
    public void completedAccountPackagesRejectLaterWeakSummaries() {
        assertCompletedPackageSurvivesWeakSummary(
                "ZTTEST000034", "13900000034", "INTERFACE5");
        assertCompletedPackageSurvivesWeakSummary(
                "YTTEST000035", "13900000035", "INTERFACE6");
    }

    @Test
    public void completedManualPackageSurvivesAccountOwnershipPromotion() {
        assertCompletedManualPackageSurvivesAccountOwnershipPromotion(
                "SFTEST000036", "13900000036", "interface5");
        assertCompletedManualPackageSurvivesAccountOwnershipPromotion(
                "SFTEST000037", "13900000037", "interface6");
    }

    @Test
    public void newerStateCorrectionReplacesCancelledStatusAndHeadlineTogether() {
        String waybill = "ZTTEST000033";
        String phone = "13900000033";
        ContentValues values = shipmentValues(
                waybill, phone, "ZTO", "中通快递", "INTERFACE5", "CaiNiao",
                StatusSemantic.CANCELLED);
        values.put("lastLogisticDetail", "订单已取消");
        values.put("logisticsGmtModified", "2026-08-24 09:00:00");
        values.put("statusEventTime",
                ExpressSourcePolicy.parseEventTime("2026-08-24 09:00:00"));
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);

        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(new ExpressQueryResult(
                waybill, "ZTO", "中通快递", StatusSemantic.TRANSIT,
                "2026-08-24 12:00:00", "快件正在运输", "[]",
                "", phone, "interface5", "", "", "CaiNiao"), phone);

        ExpressItem corrected = repository.find(rowId);
        assertNotNull(corrected);
        assertEquals(StatusSemantic.TRANSIT, corrected.sourceSemantic);
        assertEquals(StatusSemantic.TRANSIT, corrected.semantic);
        assertEquals("快件正在运输", corrected.latestDetail);
    }

    @Test
    public void routeLessInterface5SummaryDoesNotCreateAnUnreadAccountTimeline() {
        String waybill = "ZTTEST000041";
        String time = "2026-08-24 09:00:00";
        ExpressQueryResult summary = new ExpressQueryResult(
                waybill, "ZTO", "中通快递", StatusSemantic.TRANSIT,
                time, "快件运输中",
                "[{\"time\":\"" + time + "\",\"context\":\"快件运输中\"}]",
                "", "13900000041", "", "", "", "CaiNiao");

        repository.saveInterface5(summary, summary.phone);

        ExpressItem persisted = repository.findByWaybill(waybill, "interface5");
        assertNotNull(persisted);
        assertTrue(persisted.tracksJson.contains("快件运输中"));
        assertFalse(persisted.usesInterface5AccountTimeline());
        assertNull(repository.accountTimeline(waybill, "interface5"));
    }

    @Test
    public void routeLessInterface5CompletionKeepsSameProviderHistoryInOwnerRow() {
        String waybill = "ZTTEST000042";
        String phone = "13900000042";
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "快件到达转运中心",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"快件到达转运中心\"},"
                        + "{\"time\":\"2026-08-24 09:00:00\","
                        + "\"context\":\"快件已揽收\"}]",
                "", "CaiNiao"), phone);

        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "快件已签收",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"快件已签收\"}]",
                "", "cainiao"), phone);

        ExpressItem completed = repository.findByWaybill(waybill, "interface5");
        assertNotNull(completed);
        assertEquals(StatusSemantic.COMPLETED, completed.semantic);
        assertEquals("快件已签收", completed.latestDetail);
        assertTrue(completed.tracksJson.contains("快件已签收"));
        assertTrue(completed.tracksJson.contains("快件到达转运中心"));
        assertTrue(completed.tracksJson.contains("快件已揽收"));
        assertNull(repository.accountTimeline(waybill, "interface5"));
    }

    @Test
    public void routedInterface5CompletionContinuesMergingOnlyInAccountSidecar() {
        String waybill = "ZTTEST000043";
        String phone = "13900000043";
        String route = me.pipi.deliveries.model.CainiaoRoute.token("v5");
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "快件到达转运中心",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"快件到达转运中心\"},"
                        + "{\"time\":\"2026-08-24 09:00:00\","
                        + "\"context\":\"快件已揽收\"}]",
                route, "CaiNiao"), phone);

        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "快件已签收",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"快件已签收\"}]",
                route, "CaiNiao"), phone);

        ExpressItem ownerRow = repository.findByWaybill(waybill, "interface5");
        ExpressQueryResult sidecar = repository.accountTimeline(waybill, "interface5");
        assertNotNull(ownerRow);
        assertNotNull(sidecar);
        assertEquals(StatusSemantic.COMPLETED, sidecar.semantic);
        assertTrue(sidecar.tracksJson.contains("快件已签收"));
        assertTrue(sidecar.tracksJson.contains("快件到达转运中心"));
        assertTrue(sidecar.tracksJson.contains("快件已揽收"));
        assertFalse(ownerRow.tracksJson.contains("快件到达转运中心"));
        assertEquals(1, count(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{
                        ExpressSourcePolicy.normalizeWaybill(waybill)}));
    }

    @Test
    public void routeLessHistoryDoesNotCrossProviderOrAccountSource() {
        String providerWaybill = "ZTTEST000044";
        String interface5Phone = "13900000044";
        repository.bindPhoneLocally(interface5Phone, "interface5");
        repository.saveInterface5(accountResult(
                providerWaybill, interface5Phone, StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "旧来源运输节点",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"旧来源运输节点\"}]",
                "", "CaiNiao"), interface5Phone);
        repository.saveInterface5(accountResult(
                providerWaybill, interface5Phone, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "新来源签收节点",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"新来源签收节点\"}]",
                "", "JingDong"), interface5Phone);

        ExpressItem providerChanged = repository.findByWaybill(
                providerWaybill, "interface5");
        assertNotNull(providerChanged);
        assertTrue(providerChanged.tracksJson.contains("新来源签收节点"));
        assertFalse(providerChanged.tracksJson.contains("旧来源运输节点"));

        String sourceWaybill = "ZTTEST000045";
        String interface6Phone = "13900000045";
        repository.bindPhoneLocally(interface6Phone, "interface6");
        repository.bindPhoneLocally(interface6Phone, "interface5");
        repository.saveInterface6(accountResult(
                sourceWaybill, interface6Phone, StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "接口六运输节点",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"接口六运输节点\"}]",
                "", "CaiNiao"), interface6Phone);
        repository.saveInterface5(accountResult(
                sourceWaybill, interface6Phone, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "接口五签收节点",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"接口五签收节点\"}]",
                "", "CaiNiao"), interface6Phone);

        ExpressItem interface5 = repository.findByWaybill(sourceWaybill, "interface5");
        ExpressItem interface6 = repository.findByWaybill(sourceWaybill, "interface6");
        assertNotNull(interface5);
        assertNotNull(interface6);
        assertTrue(interface5.tracksJson.contains("接口五签收节点"));
        assertFalse(interface5.tracksJson.contains("接口六运输节点"));
        assertTrue(interface6.tracksJson.contains("接口六运输节点"));
        assertFalse(interface6.tracksJson.contains("接口五签收节点"));
    }

    @Test
    public void completedRouteLessHistoryDoesNotCrossProvider() {
        String waybill = "ZTTEST000046";
        String phone = "13900000046";
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.COMPLETED,
                "2026-08-24 10:00:00", "旧来源签收节点",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"旧来源签收节点\"}]",
                "", "CaiNiao"), phone);

        repository.saveInterface5(accountResult(
                waybill, phone, StatusSemantic.COMPLETED,
                "2026-08-24 12:00:00", "新来源签收节点",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"新来源签收节点\"}]",
                "", "JingDong"), phone);

        ExpressItem refreshed = repository.findByWaybill(waybill, "interface5");
        assertNotNull(refreshed);
        assertEquals(StatusSemantic.COMPLETED, refreshed.semantic);
        assertTrue(refreshed.tracksJson.contains("新来源签收节点"));
        assertFalse(refreshed.tracksJson.contains("旧来源签收节点"));
    }

    @Test
    public void completedRouteLessHistoryRequiresKnownProviderOnBothResponses() {
        for (int index = 0; index < 2; index += 1) {
            String waybill = "ZTTEST000047" + index;
            String phone = "1390000004" + (7 + index);
            String cachedProvider = index == 0 ? "" : "CaiNiao";
            String refreshedProvider = index == 0 ? "CaiNiao" : "";
            repository.bindPhoneLocally(phone, "interface5");
            repository.saveInterface5(accountResult(
                    waybill, phone, StatusSemantic.COMPLETED,
                    "2026-08-24 10:00:00", "旧记录" + index,
                    "[{\"time\":\"2026-08-24 10:00:00\","
                            + "\"context\":\"旧记录" + index + "\"}]",
                    "", cachedProvider), phone);
            repository.saveInterface5(accountResult(
                    waybill, phone, StatusSemantic.COMPLETED,
                    "2026-08-24 12:00:00", "新记录" + index,
                    "[{\"time\":\"2026-08-24 12:00:00\","
                            + "\"context\":\"新记录" + index + "\"}]",
                    "", refreshedProvider), phone);

            ExpressItem refreshed = repository.findByWaybill(waybill, "interface5");
            assertNotNull(refreshed);
            assertTrue(refreshed.tracksJson.contains("新记录" + index));
            assertFalse(refreshed.tracksJson.contains("旧记录" + index));
        }
    }

    @Test
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    public void failedSidecarWriteDoesNotPublishAndCommittedPackageFeedsEveryRead()
            throws Exception {
        ExpressItem owner = insertOwner(
                "SFTEST000051", "13900000051", StatusSemantic.WAITING_PICKUP);
        long eventTime = System.currentTimeMillis();
        ExpressQueryResult completed = completed501Result(owner.waybill, eventTime);
        AtomicInteger broadcasts = new AtomicInteger();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                if (ExpressRepository.ACTION_CHANGED.equals(intent.getAction())) {
                    broadcasts.incrementAndGet();
                }
            }
        };
        context.registerReceiver(receiver, new IntentFilter(ExpressRepository.ACTION_CHANGED));
        try {
            database.getWritableDatabase().execSQL(
                    "CREATE TRIGGER reject_manual_sidecar BEFORE INSERT ON "
                            + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE
                            + " BEGIN SELECT RAISE(ABORT,'forced test failure'); END");
            try {
                repository.saveOwnerManualTimeline(
                        owner, completed, owner.phone, "interface5");
                org.junit.Assert.fail("Expected sidecar write failure");
            } catch (SQLException expected) {
                // The transaction must roll back before any projected state is published.
            }

            assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE,
                    "owner_row_id=?", new String[]{Long.toString(owner.rowId)}));
            assertEquals(StatusSemantic.WAITING_PICKUP,
                    repository.find(owner.rowId).semantic);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(0, broadcasts.get());

            database.getWritableDatabase().execSQL("DROP TRIGGER reject_manual_sidecar");
            ExpressItem saved = repository.saveOwnerManualTimeline(
                    owner, completed, owner.phone, "interface5");
            ExpressItem found = repository.find(owner.rowId);
            ExpressItem byWaybill = repository.findByWaybill(
                    owner.waybill, "interface5");
            List<ExpressItem> visible = repository.listVisible("interface5");

            assertProjectedPackage(saved, completed);
            assertProjectedPackage(found, completed);
            assertProjectedPackage(byWaybill, completed);
            assertEquals(1, visible.size());
            assertProjectedPackage(visible.get(0), completed);
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(1, broadcasts.get());
        } finally {
            context.unregisterReceiver(receiver);
        }
    }

    @Test
    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    public void newManualOwnerAndSidecarCommitOrRollbackTogether() throws Exception {
        String waybill = "SFTEST000061";
        ExpressQueryResult completed = completed501Result(
                waybill, System.currentTimeMillis());
        AtomicInteger broadcasts = new AtomicInteger();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context ignored, Intent intent) {
                if (ExpressRepository.ACTION_CHANGED.equals(intent.getAction())) {
                    broadcasts.incrementAndGet();
                }
            }
        };
        context.registerReceiver(receiver, new IntentFilter(ExpressRepository.ACTION_CHANGED));
        try {
            database.getWritableDatabase().execSQL(
                    "CREATE TRIGGER reject_new_manual_sidecar BEFORE INSERT ON "
                            + ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE
                            + " BEGIN SELECT RAISE(ABORT,'forced test failure'); END");
            try {
                repository.saveManualQueryResult(completed, "1515", "interface6");
                org.junit.Assert.fail("Expected sidecar write failure");
            } catch (SQLException expected) {
                // Owner identity and its first visible provider package share one transaction.
            }

            assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE, null, null));
            assertEquals(0, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, null));
            assertNull(repository.findByWaybill(waybill, "interface6"));
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(0, broadcasts.get());

            database.getWritableDatabase().execSQL("DROP TRIGGER reject_new_manual_sidecar");
            repository.saveManualQueryResult(completed, "1515", "interface6");

            ExpressItem saved = repository.findByWaybill(waybill, "interface6");
            assertProjectedPackage(saved, completed);
            assertTrue(saved.manuallyAdded);
            assertEquals("1515", saved.phone);
            assertEquals(1, count(ExpressDatabase.EXPRESS_TABLE, null, null));
            assertEquals(1, count(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, null));
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
            assertEquals(1, broadcasts.get());
        } finally {
            context.unregisterReceiver(receiver);
        }
    }

    private void saveAndClaimAgain(ExpressItem owner) {
        repository.saveOwnerManualTimeline(
                owner, timedResult(owner.waybill,
                        "2026-08-24 09:00:00", "快件运输中"),
                owner.phone, "interface5");
        ManualTimelineAuthorityPolicy.Candidate authority =
                repository.manualTimelineAuthority(owner);
        assertNotNull(authority);
        assertNotNull(repository.claimManualTimelinePoll(
                owner, authority.successAt + ExpressRepository.MANUAL_TIMELINE_POLL_INTERVAL_MS));
    }

    private ExpressItem insertOwner(
            String waybill, String phone, StatusSemantic semantic) {
        ContentValues values = shipmentValues(
                waybill, phone, "SF", "顺丰速运", "INTERFACE5", "ShunFeng", semantic);
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);
        ExpressItem item = repository.find(rowId);
        assertNotNull(item);
        return item;
    }

    private ExpressItem insertOrder(String orderId, String phone) {
        return insertOrder(orderId, phone, "I5-JD", "v5");
    }

    private ExpressItem insertOrder(
            String orderId, String phone, String owner, String routeInterface) {
        ContentValues values = shipmentValues(
                orderId, phone, "JD", "京东购物", owner, "JingDong",
                StatusSemantic.TRANSIT);
        values.put("moreInfoUrl", "pipi-route:" + routeInterface);
        values.put("routeInterface", routeInterface);
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);
        ExpressItem item = repository.find(rowId);
        assertNotNull(item);
        assertTrue(item.isAccountOrder());
        return item;
    }

    private long rawRetryAt(long rowId) {
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, new String[]{"projectionRetryAt"},
                "_id=?", new String[]{Long.toString(rowId)}, null, null, null, "1")) {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        }
    }

    private String rawRetryRoute(long rowId) {
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, new String[]{"projectionRetryRoute"},
                "_id=?", new String[]{Long.toString(rowId)}, null, null, null, "1")) {
            assertTrue(cursor.moveToFirst());
            return cursor.getString(0);
        }
    }

    private static ContentValues shipmentValues(
            String waybill, String phone, String courierCode, String company,
            String owner, String sourceProvider, StatusSemantic semantic) {
        String eventTime = semantic == StatusSemantic.COMPLETED
                ? "2020-01-01 09:00:00" : "2026-08-24 09:00:00";
        String detail = semantic == StatusSemantic.COMPLETED
                ? "快件已签收" : "快件运输中";
        ContentValues values = new ContentValues();
        values.put("subPhone", phone);
        values.put("mailNo", waybill);
        values.put("normalizedMailNo", ExpressSourcePolicy.normalizeWaybill(waybill));
        values.put("cpCode", courierCode);
        values.put("cpName", company);
        values.put("logsiticsStatus", semantic.storageCode);
        values.put("logisticsStatusDesc", semantic.label);
        values.put("lastLogisticDetail", detail);
        values.put("logisticsGmtModified", eventTime);
        values.put("packageDyn", "[{\"time\":\"" + eventTime
                + "\",\"context\":\"" + detail + "\"}]");
        values.put("canShow", 1);
        values.put("isDeleted", 0);
        values.put("fromCp", owner);
        values.put("stateOwner", owner);
        values.put("data1", sourceProvider);
        values.put("updatedAt", 1L);
        return values;
    }

    private static ExpressQueryResult timedResult(
            String waybill, String time, String detail) {
        StatusSemantic semantic = detail.contains("签收")
                ? StatusSemantic.COMPLETED : StatusSemantic.TRANSIT;
        return new ExpressQueryResult(
                waybill, "SF", "顺丰速运", semantic,
                time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\""
                        + detail + "\"}]",
                "", "", "kuaidi100");
    }

    private static ExpressQueryResult accountResult(
            String waybill, String phone, StatusSemantic semantic,
            String time, String detail, String tracks,
            String detailUrl, String sourceProvider) {
        return new ExpressQueryResult(
                waybill, "ZTO", "中通快递", semantic,
                ExpressSourcePolicy.parseEventTime(time), time, detail, tracks,
                detailUrl, phone, "",
                detailUrl.isEmpty() ? "" : "v5", "", sourceProvider);
    }

    private static ExpressQueryResult completed501Result(String waybill, long eventTime) {
        String time = new SimpleDateFormat(
                "yyyy-MM-dd HH:mm:ss", Locale.CHINA).format(eventTime);
        String detail = "K100 已签收";
        return new ExpressQueryResult(
                waybill, "SF", "顺丰速运", StatusSemantic.COMPLETED,
                eventTime, time, detail,
                "[{\"time\":\"" + time + "\",\"context\":\"" + detail
                        + "\",\"statusCode\":\"501\","
                        + "\"_pipiStatusSource\":\"kuaidi100\"}]",
                "", "", "kuaidi100", "", "", "");
    }

    private static void assertProjectedPackage(
            ExpressItem item, ExpressQueryResult expected) throws Exception {
        assertNotNull(item);
        assertEquals(StatusSemantic.COMPLETED, item.semantic);
        assertEquals(expected.statusEventTime, item.statusEventTime);
        assertEquals(expected.latestTime, item.latestTime);
        assertEquals(expected.latestDetail, item.latestDetail);
        assertEquals(expected.tracksJson, item.tracksJson);
        assertEquals("kuaidi100", item.manualTimelineProvider);
        assertEquals("501", new org.json.JSONArray(item.tracksJson)
                .getJSONObject(0).getString("statusCode"));
    }

    private static void assertCarrierProjection(
            ExpressItem item, ExpressQueryResult expected) {
        assertNotNull(item);
        assertEquals(expected.waybill, item.displayWaybill());
        assertEquals(StatusSemantic.COMPLETED, item.semantic);
        assertEquals(expected.statusEventTime, item.statusEventTime);
        assertEquals(expected.latestTime, item.latestTime);
        assertEquals(expected.latestDetail, item.latestDetail);
        assertEquals(expected.tracksJson, item.tracksJson);
    }

    private void assertCompletedPackageSurvivesWeakSummary(
            String waybill, String phone, String owner) {
        String signedAt = "2026-08-24 09:00:00";
        String expectedCourier = owner.startsWith("INTERFACE5") ? "ZTO" : "YTO";
        String expectedCompany = owner.startsWith("INTERFACE5") ? "中通快递" : "圆通速递";
        ContentValues values = shipmentValues(
                waybill, phone, expectedCourier, expectedCompany, owner,
                "CaiNiao", StatusSemantic.COMPLETED);
        values.put("lastLogisticDetail", "快件已签收");
        values.put("logisticsGmtModified", signedAt);
        values.put("statusEventTime", ExpressSourcePolicy.parseEventTime(signedAt));
        values.put("packageDyn", "[{\"time\":\"" + signedAt
                + "\",\"context\":\"快件已签收\"}]");
        long rowId = database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.EXPRESS_TABLE, null, values);
        String bindingSource = owner.endsWith("5") ? "interface5" : "interface6";
        repository.bindPhoneLocally(phone, bindingSource);
        ExpressQueryResult weak = new ExpressQueryResult(
                waybill, "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-08-24 12:00:00", "快件到达转运中心",
                "[{\"time\":\"2026-08-24 12:00:00\","
                        + "\"context\":\"快件到达转运中心\"}]",
                "", phone, bindingSource, "", "", "CaiNiao");
        if ("interface5".equals(bindingSource)) repository.saveInterface5(weak, phone);
        else repository.saveInterface6(weak, phone);

        ExpressItem retained = repository.find(rowId);
        assertNotNull(retained);
        assertEquals(StatusSemantic.COMPLETED, retained.semantic);
        assertEquals(expectedCourier, retained.courierCode);
        assertEquals(expectedCompany, retained.companyName);
        assertEquals(ExpressSourcePolicy.parseEventTime(signedAt), retained.statusEventTime);
        assertEquals("快件已签收", retained.latestDetail);
        assertTrue(retained.tracksJson.contains("快件已签收"));
        assertTrue(retained.tracksJson.contains("快件到达转运中心"));
    }

    private void assertCompletedManualPackageSurvivesAccountOwnershipPromotion(
            String waybill, String phone, String bindingSource) {
        repository.bindPhoneLocally(phone, bindingSource);
        String signedAt = "2026-08-25 09:00:00";
        ExpressQueryResult signed = new ExpressQueryResult(
                waybill, "SF", "顺丰速运", StatusSemantic.COMPLETED,
                ExpressSourcePolicy.parseEventTime(signedAt), signedAt, "快件已签收",
                "[{\"time\":\"" + signedAt
                        + "\",\"context\":\"快件已签收\",\"statusCode\":\"3\"}]",
                "", phone, "kuaidi100", "", "", "");
        repository.saveManualQueryResult(signed, phone, bindingSource);
        ExpressItem manual = repository.findByWaybill(waybill, bindingSource);
        assertNotNull(manual);
        assertTrue(manual.manuallyAdded);
        assertEquals(StatusSemantic.COMPLETED, manual.semantic);
        android.app.NotificationManager notifications =
                context.getSystemService(android.app.NotificationManager.class);
        assertNotNull(notifications);
        notifications.cancelAll();

        String transitAt = "2026-08-25 12:00:00";
        ExpressQueryResult discovered = new ExpressQueryResult(
                waybill, "SF", "顺丰速运", StatusSemantic.TRANSIT,
                ExpressSourcePolicy.parseEventTime(transitAt), transitAt,
                "快件到达转运中心",
                "[{\"time\":\"" + transitAt
                        + "\",\"context\":\"快件到达转运中心\"}]",
                "", phone, bindingSource, "", "", "CaiNiao");
        if ("interface5".equals(bindingSource)) {
            repository.saveInterface5(discovered, phone);
        } else {
            repository.saveInterface6(discovered, phone);
        }

        ExpressItem retained = repository.findByWaybill(waybill, bindingSource);
        assertNotNull(retained);
        assertFalse(retained.manuallyAdded);
        assertEquals("interface5".equals(bindingSource)
                ? "INTERFACE5" : "INTERFACE6", retained.stateOwner);
        assertEquals(StatusSemantic.TRANSIT, retained.sourceSemantic);
        assertEquals(StatusSemantic.COMPLETED, retained.semantic);
        assertEquals("kuaidi100", retained.manualTimelineProvider);
        assertEquals(signedAt, retained.latestTime);
        assertEquals("快件已签收", retained.latestDetail);
        assertTrue(retained.tracksJson.contains("快件已签收"));
        assertFalse(retained.tracksJson.contains("快件到达转运中心"));
        assertEquals(0, notifications.getActiveNotifications().length);
    }

    private void insertRetry(ExpressItem owner, long attemptAt) {
        ContentValues values = new ContentValues();
        values.put("owner_row_id", owner.rowId);
        values.put("normalized_waybill", ExpressSourcePolicy.normalizeWaybill(owner.waybill));
        values.put("binding_source", "interface5");
        values.put("owner_fingerprint", "retention-test");
        values.put("last_attempt_at", attemptAt);
        database.getWritableDatabase().insertOrThrow(
                ExpressDatabase.OWNER_MANUAL_RETRY_TABLE, null, values);
    }

    private int count(String table, String selection, String[] args) {
        try (Cursor cursor = database.getReadableDatabase().query(
                table, new String[]{"COUNT(*)"}, selection, args,
                null, null, null)) {
            cursor.moveToFirst();
            return cursor.getInt(0);
        }
    }
}
