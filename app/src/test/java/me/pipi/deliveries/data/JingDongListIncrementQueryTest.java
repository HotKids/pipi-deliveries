package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

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
import org.robolectric.annotation.Config;
import org.robolectric.annotation.SQLiteMode;

/**
 * 用户定 2026-09-13（iOS mergeAccountShipmentPackage 同口径；Lite 2026-09-24 补齐）：京东列表被接受的更新节点
 * 增量扩展同运单的已有 v5_query。同运单指这一行当前的号：投影后是承运商运单号，投影前按订单号查的旧包不碰；
 * 没有 query 不新建，重复的增量幂等。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class JingDongListIncrementQueryTest {
    private static final String PHONE = "13800009307";
    private static final String ORDER = "3622448007419307";
    private static final String WAYBILL = "JD0261257549307";
    private static final String PICKUP = "您的快件已揽收完成。";
    private static final String LEFT = "您的订单已离开【测试城南接货仓】";
    private static final String DELIVERING = "您的订单正在派送中，请您准备签收（快递员：测试员，电话：19900000000）";
    private static final String SIGNED = "您的快件已送达至【家门口有问题，联系快递员。】，快递员：测试员";

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

    @Test public void aNewerListNodeExtendsTheCarrierKeyedQueryOnce() throws Exception {
        list(StatusSemantic.DELIVERY, "2026-09-23 08:02:00",
                new String[][]{{"2026-09-23 08:02:00", DELIVERING}, {"2026-09-22 22:44:00", PICKUP}});
        project();
        query(new String[][]{{"2026-09-23 08:02:00", DELIVERING}, {"2026-09-22 22:44:26", LEFT},
                {"2026-09-22 22:44:00", PICKUP}});
        String orderKeyedBefore = repository.accountTimeline(ORDER, "interface5").tracksJson;

        String[][] signed = {{"2026-09-23 11:12:26", SIGNED}, {"2026-09-23 08:02:00", DELIVERING},
                {"2026-09-22 22:44:00", PICKUP}};
        list(StatusSemantic.COMPLETED, "2026-09-23 11:12:26", signed);
        ExpressQueryResult carrierKeyed = repository.accountTimeline(WAYBILL, "interface5");
        assertNotNull(carrierKeyed);
        assertEquals(ExpressSourcePolicy.parseEventTime("2026-09-23 11:12:26"),
                Kuaidi100TimelinePolicy.latestTimedEventMillis(carrierKeyed));
        assertEquals(1, occurrences(carrierKeyed.tracksJson, SIGNED));
        assertTrue("query history is kept, not replaced", carrierKeyed.tracksJson.contains(LEFT));
        assertEquals("the order-keyed copy is left alone",
                orderKeyedBefore, repository.accountTimeline(ORDER, "interface5").tracksJson);

        list(StatusSemantic.COMPLETED, "2026-09-23 11:12:26", signed);
        assertEquals("identical increments are idempotent", 1,
                occurrences(repository.accountTimeline(WAYBILL, "interface5").tracksJson, SIGNED));
    }

    @Test public void aQueryTakenBeforeProjectionStaysUnderItsOrderNumber() throws Exception {
        list(StatusSemantic.DELIVERY, "2026-09-22 22:44:26",
                new String[][]{{"2026-09-22 22:44:26", LEFT}, {"2026-09-22 22:44:00", PICKUP}});
        query(new String[][]{{"2026-09-22 22:44:26", LEFT}, {"2026-09-22 22:44:00", PICKUP}});
        String orderKeyedBefore = repository.accountTimeline(ORDER, "interface5").tracksJson;
        project();

        list(StatusSemantic.COMPLETED, "2026-09-23 11:12:26", new String[][]{
                {"2026-09-23 11:12:26", SIGNED}, {"2026-09-22 22:44:26", LEFT},
                {"2026-09-22 22:44:00", PICKUP}});
        ExpressQueryResult carrierKeyed = repository.accountTimeline(WAYBILL, "interface5");
        assertFalse("no query slot is created without a prior query",
                Kuaidi100TimelinePolicy.hasTimedTracking(carrierKeyed));
        assertEquals(orderKeyedBefore, repository.accountTimeline(ORDER, "interface5").tracksJson);
    }

    @Test public void beforeProjectionTheOrderKeyedQueryIsTheSameTicket() throws Exception {
        list(StatusSemantic.TRANSIT, "2026-09-22 22:44:26",
                new String[][]{{"2026-09-22 22:44:26", LEFT}, {"2026-09-22 22:44:00", PICKUP}});
        query(new String[][]{{"2026-09-22 22:44:26", LEFT}, {"2026-09-22 22:44:00", PICKUP}});

        list(StatusSemantic.DELIVERY, "2026-09-23 08:02:00", new String[][]{
                {"2026-09-23 08:02:00", DELIVERING}, {"2026-09-22 22:44:26", LEFT},
                {"2026-09-22 22:44:00", PICKUP}});
        ExpressQueryResult orderKeyed = repository.accountTimeline(ORDER, "interface5");
        assertEquals(ExpressSourcePolicy.parseEventTime("2026-09-23 08:02:00"),
                Kuaidi100TimelinePolicy.latestTimedEventMillis(orderKeyed));
    }

    /**
     * 两个订单投影到同一个承运商运单号：B 的列表更新不能拿去扩展 A 查回来、按承运商运单号存的那份 v5_query。
     * 投影订单的归属（用户 2026-09-25 采纳）之后 B 挂靠、只写它自己的行，不再写进 A 那一行（原先的合并）。
     */
    @Test public void anotherOrdersListUpdateDoesNotExtendThisOrdersQuery() throws Exception {
        String otherOrder = "3622448007419999";
        String otherNode = "另一单：您的订单已到达【测试城中营业部】";
        list(StatusSemantic.DELIVERY, "2026-09-23 08:02:00",
                new String[][]{{"2026-09-23 08:02:00", DELIVERING}, {"2026-09-22 22:44:00", PICKUP}});
        project();
        query(new String[][]{{"2026-09-23 08:02:00", DELIVERING}, {"2026-09-22 22:44:00", PICKUP}});
        String before = repository.accountTimeline(WAYBILL, "interface5").tracksJson;
        long ownerRow = repository.findByWaybill(ORDER, "interface5").rowId;

        listOrder(otherOrder, StatusSemantic.TRANSIT, "2026-09-23 09:00:00",
                new String[][]{{"2026-09-23 09:00:00", "另一单：您的订单已出库"}});
        ExpressItem other = repository.findByWaybill(otherOrder, "interface5");
        assertNotNull(other);
        assertTrue(repository.saveOrderProjection(other, "interface5", WAYBILL, "京东快递"));
        listOrder(otherOrder, StatusSemantic.TRANSIT, "2026-09-23 12:30:00", new String[][]{
                {"2026-09-23 12:30:00", otherNode}, {"2026-09-23 09:00:00", "另一单：您的订单已出库"}});

        assertEquals("the other order writes only its own row", ORDER, repository.find(ownerRow).waybill);
        assertEquals(otherNode, repository.find(other.rowId).latestDetail);
        assertEquals("the other order's nodes stay out of this order's query",
                before, repository.accountTimeline(WAYBILL, "interface5").tracksJson);
    }

    private void listOrder(String order, StatusSemantic semantic, String eventAt, String[][] nodes)
            throws Exception {
        long eventAtMs = ExpressSourcePolicy.parseEventTime(eventAt);
        WorkerStatusProjection status = WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "ORDER").put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.name()).put("priority", 0)
                        .put("eventAtMs", eventAtMs).put("structured", true)));
        repository.saveInterface5OrderSummary(new ExpressQueryResult(order, "JD", "京东快递",
                semantic, eventAtMs, nodes[0][0], nodes[0][1], tracks(nodes),
                "", PHONE, "interface5", "", "", "JingDong").withWorkerStatus(status), PHONE);
    }

    private void list(StatusSemantic semantic, String eventAt, String[][] nodes) throws Exception {
        long eventAtMs = ExpressSourcePolicy.parseEventTime(eventAt);
        WorkerStatusProjection status = WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "ORDER").put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.name()).put("priority", 0)
                        .put("eventAtMs", eventAtMs).put("structured", true)));
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JD", "京东快递",
                semantic, eventAtMs, nodes[0][0], nodes[0][1], tracks(nodes),
                "", PHONE, "interface5", "", "", "JingDong").withWorkerStatus(status), PHONE);
    }

    private void project() {
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
    }

    private void query(String[][] nodes) throws Exception {
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveInterface5Query(new ExpressQueryResult(ORDER, "JD", "京东快递",
                StatusSemantic.TRANSIT, ExpressSourcePolicy.parseEventTime(nodes[0][0]),
                nodes[0][0], nodes[0][1], tracks(nodes), "", PHONE, TimelineSlot.V5_QUERY,
                "", "", "JingDong"), owner, repository.bindingGeneration(PHONE, "interface5")));
    }

    /** 按存储的原样数：状态投影会把轨迹包成 {"data":[…]}，不经去重解析，免得掩盖重复节点。 */
    private static int occurrences(String tracksJson, String detail) throws Exception {
        Object root = new org.json.JSONTokener(tracksJson).nextValue();
        JSONArray rows = root instanceof JSONObject
                ? ((JSONObject) root).getJSONArray("data") : (JSONArray) root;
        int count = 0;
        for (int index = 0; index < rows.length(); index++) {
            if (detail.equals(rows.getJSONObject(index).optString("context"))) count++;
        }
        return count;
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        }
        return value.toString();
    }
}
