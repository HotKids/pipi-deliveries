package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.database.Cursor;

import java.util.ArrayList;
import java.util.List;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
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

/**
 * 用户定 2026-09-25（方案 B）：订单投影后并进已有运单行的那一轮，只有展示状态变了才通知。同日晚用户采纳投影订单的
 * 归属方案（ownership plan T1–T7）：订单只写它自己的行，号已有归属时挂靠、隐藏、不通知，所以不再有「并进来的那一轮」；
 * 合并轮的判断留在代码里作兜底（归属-3），正常流程不再触发。这里的设备形态改为验证采纳后的行为：运单行始终是运单
 * 记录自己的，挂靠订单的每一轮都不推送，运单行自己的轮次照旧。
 *
 * <p>Pixel（Lite 1.3.7-beta73）实测：首页 16:16:23 把已完成的订单 …0579 投影成真实运单号，同一个包裹早有一行
 * 接口 5 菜鸟来源的圆通运单（09-16 已签收）。旧版本下一轮后台同步里这个订单的列表观测按投影后的运单号落在那一行上，
 * 把订单的数据写了进去：上一版是运单行（已签收 09-16 20:05:18），这一版是订单（已签收，完成时间 09-19 20:05:22，
 * 文案换成订单 feed 里的「您的包裹已送货上门…」），状态没变，却因为事件更新、文案变了而推了一条
 * 「圆通速递 7051 · 已签收」。</p>
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ProjectedOrderMergeNotificationTest {
    private static final String PHONE = "13800000579";
    private static final String ORDER = "3630448013820579";
    private static final String WAYBILL = "YT1234567897051";
    private static final String REVIEW = "您的订单" + ORDER
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
    private static final String DOORSTEP = "您的包裹已送货上门，放至家门口。如有疑问请联系快递员";
    private static final String ORDER_PICKUP = "您的订单已由圆通速递揽收";
    private static final String PARCEL_SIGNED = "您的快件已签收，签收人：家门口。感谢使用圆通速递";
    private static final String PARCEL_PICKUP = "【上海市】圆通速递 已揽收";

    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(PHONE, "interface5");
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    /** (a) 设备复现：菜鸟来源、已签收的圆通运单行；订单经京粉页投影后挂靠，两边都已签收。 */
    @Test public void theDeviceMergeDoesNotRenotifyTheSignedParcel() throws Exception {
        ExpressItem parcel = parcel(StatusSemantic.COMPLETED, at("2026-09-15 20:05:18"), PARCEL_SIGNED);
        ExpressItem order = order(StatusSemantic.COMPLETED, completedOrderNodes());
        captureUnionPage(order);
        int posted = postedTitles().size();

        assertEquals("the merge round stages nothing", 0,
                syncOrder(StatusSemantic.COMPLETED, completedOrderNodes()));
        assertEquals("nothing is posted", posted, postedTitles().size());
        ExpressItem shown = onlyListedRow();
        assertEquals("the parcel's row is the one listed", parcel.rowId, shown.rowId);
        assertEquals(WAYBILL, shown.displayWaybill());
        assertEquals(StatusSemantic.COMPLETED, shown.semantic);
    }

    /**
     * (b) 运单行在派送中、挂靠的订单已签收：订单的签收不写运单行、不推送，运单行仍显示它自己的派送中；等运单记录自己
     * 报签收，展示状态真的变了，照常通知。（旧期望：订单并进来那一轮就把运单行改成已签收并通知一次。）
     */
    @Test public void anAttachedOrdersCompletionWaitsForTheWaybillRecord() throws Exception {
        parcel(StatusSemantic.DELIVERY, at("2026-09-15 18:00:00"), "【上海市】快递员正在派送，请保持电话畅通");
        ExpressItem order = order(StatusSemantic.COMPLETED, completedOrderNodes());
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        int posted = postedTitles().size();

        assertEquals(0, syncOrder(StatusSemantic.COMPLETED, completedOrderNodes()));
        assertEquals(posted, postedTitles().size());
        assertEquals(StatusSemantic.DELIVERY, onlyListedRow().semantic);

        int[] staged = {0};
        repository.runInChangeBatch(() -> {
            try {
                parcel(StatusSemantic.COMPLETED, at("2026-09-15 20:05:18"), PARCEL_SIGNED);
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
            staged[0] = count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE);
        });
        assertEquals(1, staged[0]);
        List<String> titles = postedTitles();
        assertEquals(posted + 1, titles.size());
        String title = titles.get(titles.size() - 1);
        assertTrue(title, title.contains("7051"));
        assertEquals(StatusSemantic.COMPLETED, onlyListedRow().semantic);
    }

    /**
     * 「展示状态」是可见行在列表和通知里显示的状态。运单行本来就是已揽件，挂靠的订单也是已揽件，订单更新的事件和换了
     * 的文案都不通知。（订单挂靠时投影那一步也不再通知：挂靠行不进通知。）
     */
    @Test public void aMergeWhoseShownStatusStaysDoesNotNotify() throws Exception {
        parcel(StatusSemantic.PICKED, at("2026-09-20 09:00:00"), PARCEL_PICKUP);
        ExpressItem order = order(StatusSemantic.PICKED, new String[][]{
                {at("2026-09-20 08:30:00"), ORDER_PICKUP}});
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        int posted = postedTitles().size();

        assertEquals(0, syncOrder(StatusSemantic.PICKED, new String[][]{
                {at("2026-09-20 10:00:00"), "您的订单已离开【上海分拨中心】"},
                {at("2026-09-20 08:30:00"), ORDER_PICKUP}}));
        assertEquals(posted, postedTitles().size());
        assertEquals(StatusSemantic.PICKED, onlyListedRow().semantic);
    }

    /**
     * (c) 挂靠之后的轮次：挂靠订单每一轮更新的事件和换了的文案都不通知（旧期望：合并之后下一轮照原规则通知一次）；
     * 运单行自己的轮次照原规则，更新的事件配上换了的文案通知。已签收的运单行不会因为订单的京东完成被冻结（旧期望：
     * 合并后显示冻结），之后订单再有更新的事件和文案也不通知。
     */
    @Test public void laterRoundsOfTheAttachedOrderStayQuietAndTheWaybillRowKeepsItsRules()
            throws Exception {
        ExpressItem parcel = parcel(StatusSemantic.TRANSIT, at("2026-09-20 09:00:00"),
                "【上海市】快件已发往 上海转运中心");
        ExpressItem order = order(StatusSemantic.TRANSIT, new String[][]{
                {at("2026-09-20 08:30:00"), ORDER_PICKUP}});
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        int posted = postedTitles().size();

        assertEquals("an attached round: a newer event with changed text alone", 0,
                syncOrder(StatusSemantic.TRANSIT, new String[][]{
                        {at("2026-09-20 10:00:00"), "您的订单已到达【上海转运中心】"},
                        {at("2026-09-20 08:30:00"), ORDER_PICKUP}}));
        assertFalse("the waybill row is not display-frozen", displayFrozen(parcel.rowId));
        assertEquals("the next attached round stays quiet too", 0,
                syncOrder(StatusSemantic.TRANSIT, new String[][]{
                        {at("2026-09-20 12:00:00"), "您的订单已离开【上海转运中心】，正在发往【杭州分拨中心】"},
                        {at("2026-09-20 10:00:00"), "您的订单已到达【上海转运中心】"},
                        {at("2026-09-20 08:30:00"), ORDER_PICKUP}}));
        assertEquals(posted, postedTitles().size());
        int[] staged = {0};
        repository.runInChangeBatch(() -> {
            try {
                parcel(StatusSemantic.TRANSIT, at("2026-09-20 13:00:00"),
                        "【杭州市】快件已到达 杭州转运中心");
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
            staged[0] = count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE);
        });
        assertEquals("the waybill row's own newer event with changed text notifies as before",
                1, staged[0]);
        assertEquals(posted + 1, postedTitles().size());

        tearDown();
        setUp();
        // Row ids start over with the new database; clear the posted notifications with them.
        context.getSystemService(NotificationManager.class).cancelAll();
        ExpressItem signed = parcel(StatusSemantic.COMPLETED, at("2026-09-15 20:05:18"), PARCEL_SIGNED);
        ExpressItem completed = order(StatusSemantic.COMPLETED, completedOrderNodes());
        captureUnionPage(completed);
        posted = postedTitles().size();
        assertEquals(0, syncOrder(StatusSemantic.COMPLETED, completedOrderNodes()));
        assertFalse("the order's JD completion does not freeze the waybill row",
                displayFrozen(signed.rowId));
        String[][] later = new String[completedOrderNodes().length + 1][];
        later[0] = new String[]{at("2026-09-19 09:00:00"),
                "您的订单[赠品]已完成，20京豆等您拿，完成评价即有机会获得，不要错过呦！"};
        System.arraycopy(completedOrderNodes(), 0, later, 1, completedOrderNodes().length);
        assertEquals("the attached order never notifies", 0,
                syncOrder(StatusSemantic.COMPLETED, at("2026-09-19 09:00:00"), later));
        assertEquals(posted, postedTitles().size());
        assertEquals(PARCEL_SIGNED, onlyListedRow().latestDetail);
    }

    /** (d) 没有已有运单行时投影，之后这一行自己的轮次与原来一样：更新的事件配上换了的文案照常通知。 */
    @Test public void anOrderProjectedWithoutAWaybillRowKeepsTheExistingRules() throws Exception {
        ExpressItem order = order(StatusSemantic.TRANSIT, new String[][]{
                {at("2026-09-20 08:30:00"), ORDER_PICKUP}});
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        int posted = postedTitles().size();
        assertEquals("a same-status observation without a newer event stays quiet", 0,
                syncOrder(StatusSemantic.TRANSIT, new String[][]{
                        {at("2026-09-20 08:30:00"), ORDER_PICKUP}}));
        assertEquals(1, syncOrder(StatusSemantic.TRANSIT, new String[][]{
                {at("2026-09-20 10:00:00"), "您的订单已到达【上海转运中心】"},
                {at("2026-09-20 08:30:00"), ORDER_PICKUP}}));
        ExpressItem shown = onlyListedRow();
        assertEquals(order.rowId, shown.rowId);
        assertEquals(WAYBILL, shown.displayWaybill());
        assertEquals(posted + 1, postedTitles().size());
    }

    /** The parcel's own Interface-5 row, reported by CaiNiao with a structured shipment status. */
    private ExpressItem parcel(StatusSemantic semantic, String time, String detail) throws Exception {
        long eventAt = ExpressSourcePolicy.parseEventTime(time);
        repository.saveInterface5(new ExpressQueryResult(WAYBILL, "YTO", "圆通速递",
                semantic, eventAt, time, detail, tracks(new String[][]{
                        {time, detail},
                        {at("2026-09-13 18:00:00"), PARCEL_PICKUP}}),
                "", PHONE, TimelineSlot.V5_QUERY, "", "", "CaiNiao")
                .withWorkerStatus(status("SHIPMENT", semantic, eventAt)), PHONE);
        ExpressItem parcel = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(parcel);
        assertEquals(semantic, parcel.semantic);
        return parcel;
    }

    /** The unprojected JD account order for the same parcel. */
    private ExpressItem order(StatusSemantic semantic, String[][] nodes) throws Exception {
        listOrder(semantic, nodes[0][0], nodes);
        ExpressItem order = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(order);
        assertTrue(order.isAccountOrder());
        assertTrue(order.projectedWaybill.isEmpty());
        return order;
    }

    /** Home's capture save path: a complete union page package naming the parcel's waybill. */
    private void captureUnionPage(ExpressItem order) throws Exception {
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(order);
        assertTrue(repository.saveAutomaticDetailTimeline(order, claim, new ExpressQueryResult(
                WAYBILL, "YTO", "圆通速递", StatusSemantic.UNKNOWN, 0L,
                at("2026-09-15 20:05:10"), DOORSTEP, tracks(new String[][]{
                        {at("2026-09-15 20:05:10"), DOORSTEP},
                        {at("2026-09-13 18:00:00"), PARCEL_PICKUP}}),
                "", "", TimelineSlot.JD_H5, "", "", ""), true));
        assertEquals(WAYBILL, repository.find(order.rowId).projectedWaybill);
    }

    /** One background sync round observing the order's list record; returns what it staged. */
    private int syncOrder(StatusSemantic semantic, String[][] nodes) throws Exception {
        return syncOrder(semantic, nodes[0][0], nodes);
    }

    private int syncOrder(StatusSemantic semantic, String statusAt, String[][] nodes) throws Exception {
        int[] staged = {0};
        repository.runInChangeBatch(() -> {
            try {
                listOrder(semantic, statusAt, nodes);
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
            staged[0] = count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE);
        });
        return staged[0];
    }

    private void listOrder(StatusSemantic semantic, String statusAt, String[][] nodes) throws Exception {
        long eventAt = ExpressSourcePolicy.parseEventTime(statusAt);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JDKD", "京东商品快递",
                semantic, eventAt, nodes[0][0], nodes[0][1], tracks(nodes),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(status("ORDER", semantic, eventAt)), PHONE);
    }

    /** The completed order's feed: the review node, the doorstep delivery, the pickup. */
    private static String[][] completedOrderNodes() {
        return new String[][]{
                {at("2026-09-18 20:05:22"), REVIEW},
                {at("2026-09-15 20:05:10"), DOORSTEP},
                {at("2026-09-13 18:00:00"), ORDER_PICKUP}};
    }

    private ExpressItem onlyListedRow() {
        List<ExpressItem> rows = repository.listVisible("interface5");
        assertEquals("the order and the parcel are one row", 1, rows.size());
        return rows.get(0);
    }

    private List<String> postedTitles() {
        List<String> titles = new ArrayList<>();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        for (Notification notification : Shadows.shadowOf(manager).getAllNotifications()) {
            CharSequence title = notification.extras.getCharSequence(Notification.EXTRA_TITLE);
            titles.add(title == null ? "" : title.toString());
        }
        return titles;
    }

    private boolean displayFrozen(long rowId) {
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, new String[]{"display_frozen"},
                "owner_row_id=?", new String[]{Long.toString(rowId)}, null, null, null)) {
            return cursor.moveToFirst() && cursor.getInt(0) != 0;
        }
    }

    private int count(String table) {
        try (Cursor cursor = database.getReadableDatabase().query(
                table, null, null, null, null, null, null)) {
            return cursor.getCount();
        }
    }

    private static WorkerStatusProjection status(String scope, StatusSemantic semantic, long eventAt)
            throws Exception {
        return WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", scope).put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                        .put("eventAtMs", eventAt).put("structured", true)));
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        }
        return value.toString();
    }
}
