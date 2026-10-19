package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;

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

/**
 * 用户 2026-09-25 同意（方案 B，Lite 与 iOS；Pipi、kdbot 不做）：确认没有商品的京东订单行像留存到期的行一样隐藏。
 * 三条同时成立才算：已完成、从没有过真实运单号的接口 5 京东订单；它自己的 feed 历史只有订单级的完成 / 评价节点；
 * 方案 A 已确认它的京粉页是空壳。隐藏的行不进列表、小组件和同步的逐行刷新，也不通知；行和缓存都还在，任一条不再
 * 成立就自动回来。起因是 Pixel 上的赠品单 4421：只有一条「您的订单…已完成…期待您对本次购物进行评价」，永远没有运单号。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class JingDongNoItemOrderVisibilityTest {
    private static final String PHONE = "13800004422";
    // Synthetic 16-digit identity isolates the existing empty-page rule.
    private static final String GIFT = "3500000000044421";
    private static final long TEN_MINUTES = 10L * 60L * 1000L;
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

    @Test public void aConfirmedEmptyGiftOrderIsHiddenLikeARetentionHiddenRow() throws Exception {
        ExpressItem gift = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        confirmEmpty(gift);
        assertFalse("not in the list, the widgets or the per-row sync", listed(gift));
        assertNull("not reported as already listed either",
                repository.findVisibleByWaybill(GIFT, "interface5"));
        assertNotNull("the row itself is kept", repository.find(gift.rowId));
    }

    @Test public void aHiddenGiftOrderIsNeverNotified() throws Exception {
        ExpressItem gift = unsettledGiftOrder(StatusSemantic.COMPLETED, COMPLETED_AT, GIFT_REVIEW);
        confirmEmpty(gift);
        assertFalse(listed(gift));
        assertEquals("a newer completion text would otherwise notify", 0,
                observeInBatch(StatusSemantic.COMPLETED, at("2026-09-21 09:00:00"),
                        "您的订单[赠品]已完成，20京豆等您拿，完成评价即有机会获得，不要错过呦！"));

        ContentValues pending = new ContentValues();
        pending.put("owner_row_id", gift.rowId);
        pending.put("event_token", "staged-before-it-was-hidden");
        database().getWritableDatabase().insertOrThrow(
                ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, pending);
        repository.replayPendingNotifications();
        assertEquals("a notification staged earlier is dropped, not posted", 0, outbox());
        assertEquals(0, Shadows.shadowOf(context.getSystemService(android.app.NotificationManager.class))
                .getAllNotifications().size());
    }

    @Test public void theSameShapeWithoutTheMarkIsShownAndNotified() throws Exception {
        ExpressItem gift = unsettledGiftOrder(StatusSemantic.COMPLETED, COMPLETED_AT, GIFT_REVIEW);
        retries.recordPage(gift, empty(), System.currentTimeMillis());
        assertTrue("one empty page is not a confirmation", listed(gift));
        assertNotNull(repository.findVisibleByWaybill(GIFT, "interface5"));
        assertEquals(1, observeInBatch(StatusSemantic.COMPLETED, at("2026-09-21 09:00:00"),
                "您的订单[赠品]已完成，20京豆等您拿，完成评价即有机会获得，不要错过呦！"));
    }

    @Test public void aRealOrderWithALogisticsNodeIsNeverHidden() throws Exception {
        ExpressItem real = order("3500000000066101", new String[][]{
                {COMPLETED_AT, "您的订单3500000000066101已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。"},
                {at("2026-09-19 09:00:00"), "【上海市】圆通速递 已揽收"}});
        confirmEmpty(real);
        assertTrue(listed(real));
    }

    @Test public void aProjectedOrderIsNeverHidden() throws Exception {
        ExpressItem gift = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        confirmEmpty(gift);
        assertFalse(listed(gift));
        assertTrue(repository.saveOrderProjection(repository.find(gift.rowId), "interface5",
                "YT0000000004421", "圆通速递"));
        assertTrue("a real waybill brings it back", listed(gift));
    }

    @Test public void aLaterCaptureThatClearsTheMarkBringsTheRowBack() throws Exception {
        ExpressItem gift = order(GIFT, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
        confirmEmpty(gift);
        assertFalse(listed(gift));
        retries.recordPage(repository.find(gift.rowId), new ExpressAutomaticTimelineCapture.Result(
                null, false, false, false, false, true), System.currentTimeMillis());
        assertTrue(listed(gift));
        assertNotNull(repository.findVisibleByWaybill(GIFT, "interface5"));
    }

    private static ExpressAutomaticTimelineCapture.Result empty() {
        return new ExpressAutomaticTimelineCapture.Result(null, false, false, false, true, false);
    }

    /** Two empty-shell pages at least ten minutes apart, recorded the way both capture paths record them. */
    private void confirmEmpty(ExpressItem order) {
        ExpressItem current = repository.find(order.rowId);
        long now = System.currentTimeMillis();
        retries.recordPage(current, empty(), now - TEN_MINUTES);
        retries.recordPage(current, empty(), now);
        assertTrue(retries.pageConfirmedEmpty(current));
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

    /** One background-sync style observation; returns the notification obligations it staged. */
    private int observeInBatch(StatusSemantic semantic, String time, String text) {
        int[] staged = {0};
        repository.runInChangeBatch(() -> {
            try {
                observe(semantic, time, text);
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
            staged[0] = outbox();
        });
        return staged[0];
    }

    private int outbox() {
        try (Cursor cursor = database().getReadableDatabase().query(
                ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null, null, null, null, null, null)) {
            return cursor.getCount();
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
