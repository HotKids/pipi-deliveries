package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;

import me.pipi.deliveries.background.AccountCarrierRecognition;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;

/** Display-only hiding preserves rows and their existing projection work. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class JingDongCompletedOrderPlaceholderTest {
    private static final String PHONE = "13800004422";
    private static final String GIFT = "350000004421";
    private static final String COMPLETED_AT = at("2026-09-20 10:00:00");
    private static final String GIFT_REVIEW = "您的订单" + GIFT
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";

    private Context context;
    private ExpressRepository repository;
    private ExpressOrderProjectionRetryStore retries;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("express_jd_h5_cooldown", 0).edit().clear().commit();
        context.getSharedPreferences("express_jd_h5_empty_page", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        retries = new ExpressOrderProjectionRetryStore(context);
    }

    @After public void tearDown() throws Exception {
        database().close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void completedShortOrderHidesWithoutAnEmptyPageAndKeepsProcessing() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        assertFalse(listed(row));
        assertTrue(repository.listVisibleForHome("interface5").isEmpty());
        assertEquals(row.rowId, repository.homeRows("interface5").processing.get(0).rowId);
        assertNull(repository.findVisibleByWaybill(GIFT, "interface5"));
        assertNotNull(repository.find(row.rowId));
        assertEquals(row.rowId, repository.listVisibleAsStored("interface5").get(0).rowId);
        assertFalse(retries.pageConfirmedEmpty(repository.find(row.rowId)));
    }

    @Test public void otherPrefixesAndLengthsStayVisible() throws Exception {
        for (String number : new String[]{"450000004421", "3500000000044421", "35000000442"}) {
            ExpressItem row = order(number, new String[][]{{COMPLETED_AT, "订单已完成"}});
            assertTrue(number, listed(row));
        }
    }

    @Test public void pickupTextDoesNotReplaceAnAssociationAndAnotherCarriersWaybillRestoresTheOrder()
            throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW},
                {at("2026-09-19 09:00:00"), "【上海市】圆通速递 已揽收"}});
        assertTrue(row.tracksJson.contains("已揽收"));
        assertFalse(listed(row));
        assertNotNull(repository.find(row.rowId));
        assertEquals(row.rowId, repository.homeRows("interface5").processing.get(0).rowId);
        assertFalse(retries.pageConfirmedEmpty(row));

        assertTrue(repository.saveOrderProjection(row, "interface5", "YT000000044421", "圆通速递"));
        assertTrue(listed(row));
    }

    @Test public void everyThreePrefixWithinTheApprovedLengthIsCovered() throws Exception {
        ExpressItem row = order("310000004421", new String[][]{{COMPLETED_AT, "订单已完成"}});
        assertFalse(listed(row));
    }

    @Test public void unstructuredAndNonCompletedOrdersStayVisible() throws Exception {
        ExpressItem row = unsettledGiftOrder(StatusSemantic.COMPLETED, COMPLETED_AT, GIFT_REVIEW);
        assertTrue(listed(row));
        observe(StatusSemantic.TRANSIT, at("2026-09-21 09:00:00"), "运输途中");
        assertTrue(listed(row));
    }

    @Test public void projectedWaybillsOfEveryCarrierAndFormatRestoreVisibility() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        assertFalse(listed(row));
        for (String number : new String[]{"JD000000044421", "YT000000044421", "351234567890"}) {
            assertTrue(repository.saveOrderProjection(repository.find(row.rowId), "interface5", number, ""));
            assertTrue(number, listed(row));
        }
    }

    @Test public void anUnqualifiedSavedAssociationStillProtectsTheOrder() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        ContentValues history = new ContentValues();
        history.put("normalized_waybill", "351234567890");
        history.put("owner_provider", "interface5");
        history.put("binding_generation", "old-generation");
        history.put("record_key", GIFT);
        history.put("package_owner", "I5-JD");
        history.put("binding_source", "interface5");
        history.put("waybill", GIFT);
        history.put("qualified", 0);
        history.put("observed_at", 1L);
        database().getWritableDatabase().insertOrThrow(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE, null, history);
        assertTrue(listed(row));
    }

    @Test public void historicalOwnerTimelineProtectsAnUnprojectedOrder() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        ContentValues history = new ContentValues();
        history.put("owner_row_id", row.rowId);
        history.put("normalized_waybill", "YT000000044421");
        history.put("binding_source", "interface5");
        history.put("provider", "jd_h5");
        history.put("waybill", "YT000000044421");
        history.put("success_at", 1L);
        database().getWritableDatabase().insertOrThrow(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, history);
        assertTrue(listed(row));
    }

    @Test public void savedFeedTextProtectsARealNumericWaybill() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW},
                {at("2026-09-19 09:00:00"), "已交付承运商，运单号为351234567890"}});
        assertTrue(listed(row));
    }

    @Test public void heldPageWaybillProtectsTheOrderBeforeCarrierRecognition() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        ContentValues held = new ContentValues();
        held.put("owner_row_id", row.rowId);
        held.put("normalized_source_id", GIFT);
        held.put("binding_source", "interface5");
        held.put("normalized_waybill", "YT000000044421");
        held.put("provider", "jd_h5");
        held.put("waybill", "YT000000044421");
        held.put("success_at", 1L);
        database().getWritableDatabase().insertOrThrow(ExpressDatabase.HELD_ORDER_PROJECTION_TABLE, null, held);
        assertTrue(listed(row));
    }

    @Test public void aQueuedNotificationCannotExposeTheHiddenOrder() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        ContentValues pending = new ContentValues();
        pending.put("owner_row_id", row.rowId);
        pending.put("event_token", "queued-before-hide");
        database().getWritableDatabase().insertOrThrow(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, pending);
        repository.replayPendingNotifications();
        assertEquals(0, outbox());
        assertEquals(0, Shadows.shadowOf(context.getSystemService(android.app.NotificationManager.class))
                .getAllNotifications().size());
        assertNotNull(repository.find(row.rowId));
    }

    @Test public void completionDoesNotStageANewHiddenOrderNotification() throws Exception {
        String time = at("2026-09-19 09:00:00");
        long eventAt = ExpressTimeline.parseTime(time);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(GIFT, "JDKD", "京东商品快递",
                StatusSemantic.TRANSIT, eventAt, time, "运输途中", tracks(new String[][]{{time, "运输途中"}}),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(status(StatusSemantic.TRANSIT, eventAt, true)), PHONE);
        assertTrue(listed(repository.findByWaybill(GIFT, "interface5")));
        repository.runInChangeBatch(() -> {
            try {
                ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
                assertFalse(listed(row));
                assertEquals(0, outbox());
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
        });
    }

    @Test public void aSavedAssociationSurvivesProjectionCacheCleanupAndRestart() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        assertTrue(repository.saveOrderProjection(row, "interface5", "351234567890", ""));
        database().getWritableDatabase().delete(ExpressDatabase.ORDER_PROJECTION_TABLE, null, null);
        database().getWritableDatabase().delete(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE, null, null);
        restart();
        assertTrue(repository.find(row.rowId).projectedWaybill.isEmpty());
        assertTrue(listed(row));
    }

    @Test public void aQueryWaybillSurvivesCarrierBudgetExhaustionAndCacheCleanup() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        assertFalse(listed(row));
        ExpressQueryResult query = queryNamingWaybill();
        String carrier = AccountCarrierRecognition.queryTextCarrier(row, query,
                AccountCarrierRecognition.bounded(new AccountCarrierRecognition.Budget(0), waybill -> {
                    fail("an exhausted recognition budget must not start another request");
                    return null;
                }));
        assertNull(carrier);
        assertTrue(repository.saveInterface5Query(query, row,
                repository.bindingGeneration(PHONE, "interface5"), carrier));
        assertTrue(repository.find(row.rowId).projectedWaybill.isEmpty());
        assertNotNull(repository.accountTimeline(GIFT, "interface5"));
        ExpressRepository.PendingProjection pending = repository.pendingProjection(repository.find(row.rowId));
        assertNotNull(pending);
        assertEquals(ExpressRepository.PendingProjectionSource.QUERY_TEXT, pending.source);
        assertEquals("JT4006839564547", pending.waybill);
        assertTrue(listed(row));
        assertEquals("1", rememberedWaybill(row));

        database().getWritableDatabase().delete(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE, null, null);
        restart();
        assertNull(repository.pendingProjection(repository.find(row.rowId)));
        assertTrue(repository.find(row.rowId).projectedWaybill.isEmpty());
        assertTrue(listed(row));
    }

    @Test public void startupBackfillsAnOwnedUnprojectedQueryWaybill() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        assertTrue(repository.saveInterface5Query(queryNamingWaybill(), row,
                repository.bindingGeneration(PHONE, "interface5"), null));
        // Simulate a pre-marker database while retaining the real query write and attribution.
        database().getWritableDatabase().delete(ExpressDatabase.ROW_LEDGER_TABLE,
                "owner_row_id=? AND entry=?", new String[]{Long.toString(row.rowId), "order_had_waybill"});
        restart();
        assertNotNull(repository.find(row.rowId));
        assertEquals("1", rememberedWaybill(row));
        database().getWritableDatabase().delete(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE, null, null);
        restart();
        assertTrue(listed(row));
    }

    @Test public void unattributedQueryHistoryDoesNotInventAnOrderAssociation() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        assertNotNull(repository.saveAccountTimeline(queryNamingWaybill(), "interface5"));
        assertNotNull(repository.accountTimeline(GIFT, "interface5"));
        assertNull(repository.accountTimeline(row, GIFT, "interface5"));
        assertNull(repository.pendingProjection(row));
        assertFalse(listed(row));
        restart();
        assertFalse(listed(row));
        assertEquals("", rememberedWaybill(row));
    }

    @Test public void startupBackfillsOldOwnerEvidenceBeforeItsPacketIsRemoved() throws Exception {
        historicalOwnerTimelineProtectsAnUnprojectedOrder();
        ExpressItem row = repository.findByWaybill(GIFT, "interface5");
        restart();
        assertTrue(listed(row));
        database().getWritableDatabase().delete(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, null, null);
        restart();
        assertTrue(listed(row));
    }

    @Test public void unlabelledNumbersInOrdinaryTextNeverEstablishAWaybill() throws Exception {
        ExpressItem row = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW},
                {at("2026-09-19 09:00:00"), "配送员留言351234567890，请评价本次购物"}});
        assertFalse(listed(row));
    }

    private void restart() {
        database().close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        repository = ExpressRepository.get(context);
    }

    private boolean listed(ExpressItem order) {
        for (ExpressItem item : repository.listVisible("interface5")) {
            if (item.rowId == order.rowId) return true;
        }
        return false;
    }

    /** An unprojected Interface-5 JD order: carrier evidence and a structured completion, like 4421. */
    private ExpressItem order(String orderId, String[][] nodes) throws Exception {
        long eventAt = ExpressTimeline.parseTime(nodes[0][0]);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(orderId, "JDKD", "京东商品快递",
                StatusSemantic.COMPLETED, eventAt, nodes[0][0], nodes[0][1], tracks(nodes),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(status(StatusSemantic.COMPLETED, eventAt, true)), PHONE);
        ExpressItem owner = repository.findByWaybill(orderId, "interface5");
        assertNotNull(owner);
        assertEquals(StatusSemantic.COMPLETED, owner.semantic);
        assertTrue(owner.projectedWaybill.isEmpty());
        return owner;
    }

    /**
     * The same gift order without carrier evidence or a structured completion: each list observation
     * still rewrites the row, so a newer completion text is a notifiable change.
     */
    private ExpressItem unsettledGiftOrder(StatusSemantic semantic, String time, String text)
            throws Exception {
        observe(semantic, time, text);
        ExpressItem owner = repository.findByWaybill(GIFT, "interface5");
        assertNotNull(owner);
        assertEquals(StatusSemantic.COMPLETED, owner.semantic);
        return owner;
    }

    private void observe(StatusSemantic semantic, String time, String text) throws Exception {
        long eventAt = ExpressTimeline.parseTime(time);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(GIFT, "", "",
                semantic, eventAt, time, text, tracks(new String[][]{{time, text}}),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(status(semantic, eventAt, false)), PHONE);
    }

    private int outbox() {
        try (Cursor cursor = database().getReadableDatabase().query(
                ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, null, null, null, null, null)) {
            return cursor.getCount();
        }
    }

    private ExpressQueryResult queryNamingWaybill() throws Exception {
        String time = at("2026-09-19 09:00:00");
        String text = "您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547";
        return new ExpressQueryResult(GIFT, "JD", "京东快递", StatusSemantic.PICKED,
                ExpressTimeline.parseTime(time), time, text, tracks(new String[][]{{time, text}}),
                "", PHONE, "v5_query", "", "", "JingDong");
    }

    private String rememberedWaybill(ExpressItem row) {
        try (Cursor cursor = database().getReadableDatabase().query(ExpressDatabase.ROW_LEDGER_TABLE,
                new String[]{"value"}, "owner_row_id=? AND entry=?",
                new String[]{Long.toString(row.rowId), "order_had_waybill"}, null, null, null)) {
            return cursor.moveToFirst() ? cursor.getString(0) : "";
        }
    }

    private ExpressDatabase database() throws RuntimeException {
        try {
            java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
            helper.setAccessible(true);
            return (ExpressDatabase) helper.get(repository);
        } catch (ReflectiveOperationException failure) {
            throw new IllegalStateException(failure);
        }
    }

    private static WorkerStatusProjection status(StatusSemantic semantic, long eventAt, boolean structured)
            throws Exception {
        return WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "ORDER").put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                        .put("eventAtMs", eventAt).put("structured", structured)));
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        }
        return value.toString();
    }
}
