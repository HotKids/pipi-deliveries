package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import android.app.NotificationManager;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

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
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/**
 * 投影订单的归属（用户 2026-09-25 采纳，ownership plan T1–T6，Lite）：一条上游记录只写它自己的行和观测槽；运单号谁先占
 * 归谁；投影只是给订单挂上运单号，号已有归属时订单行保留但隐藏（不进列表、小组件和通知，照常写自己的数据，留存按它自己
 * 的时间）；手动行的字段永不被改写；两张订单共用一个运单号时先占的显示、其余挂靠；不再来回翻。
 *
 * <p>设备形态来自 Pixel（Lite 1.3.7-beta73）：订单 …0579 投影到圆通运单 …7051，同一个包裹早有一行接口 5 菜鸟来源的
 * 圆通运单（09-16 已签收）。单号按原样的尾号造。</p>
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ProjectedOrderOwnershipTest {
    private static final String PHONE = "13800000579";
    private static final String ORDER = "3630448013820579";
    private static final String SECOND_ORDER = "3630448013829999";
    private static final String WAYBILL = "YT1234567897051";
    private static final String PARCEL_PICKUP = "【上海市】圆通速递 已揽收";
    private static final String PARCEL_TRANSIT = "【上海市】快件已发往 上海转运中心";
    private static final String PARCEL_DELIVERY = "【上海市】快件派送中，请保持电话畅通";
    private static final String PARCEL_SIGNED = "您的快件已签收，签收人：家门口。感谢使用圆通速递";
    private static final String ORDER_SUBMITTED = "您提交了订单，请等待系统确认";
    private static final String ORDER_OUTBOUND = "您的订单已出库";
    private static final String ORDER_PICKUP = "您的订单已由圆通速递揽收";
    private static final String REVIEW = "您的订单" + ORDER
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
    private static final String DOORSTEP = "您的包裹已送货上门，放至家门口。如有疑问请联系快递员";

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
        context.getSystemService(NotificationManager.class).cancelAll();
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    private void resetDatabase() {
        tearDown();
        setUp();
    }

    /**
     * 设备形态：菜鸟圆通运单行先占号，订单投影上来后挂靠。两种列表顺序各跑三轮：可见行的号、来源、轨迹始终是运单记录的，
     * 订单行在但隐藏、照常写自己的新节点，订单的新节点不推送。之后运单记录自己的新事件照常通知。
     */
    @Test public void theWaybillRowKeepsItsRecordInBothListOrders() throws Exception {
        for (boolean orderFirst : new boolean[]{false, true}) {
            resetDatabase();
            ExpressItem parcel = parcel(StatusSemantic.TRANSIT, parcelTransit());
            ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(0));
            assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
            int posted = postedCount();

            for (int round = 1; round <= 3; round++) {
                String[][] orderRound = orderNodes(round);
                assertEquals("round " + round + (orderFirst ? " order first" : " waybill first"),
                        0, round(orderFirst,
                                () -> listParcel(StatusSemantic.TRANSIT, parcelTransit()),
                                () -> listOrder(ORDER, StatusSemantic.TRANSIT, orderRound)));
                ExpressItem shown = onlyListedRow();
                assertEquals(parcel.rowId, shown.rowId);
                assertEquals(WAYBILL, shown.waybill);
                assertEquals(WAYBILL, shown.displayWaybill());
                assertEquals("CaiNiao", shown.sourceProvider);
                assertEquals("INTERFACE5", shown.stateOwner);
                assertEquals(PARCEL_TRANSIT, shown.latestDetail);
                assertTrue(shown.tracksJson.contains(PARCEL_PICKUP));
                assertFalse(shown.tracksJson.contains(ORDER_PICKUP));
                ExpressItem attached = repository.find(order.rowId);
                assertNotNull("the order row stays", attached);
                assertEquals(ORDER, attached.waybill);
                assertEquals(WAYBILL, attached.displayWaybill());
                assertEquals("the order row keeps writing its own data",
                        orderRound[0][1], attached.latestDetail);
                assertEquals(parcel.rowId, ownerRowId(WAYBILL));
                assertEquals(WAYBILL, ownerRecordKey(WAYBILL));
            }
            assertEquals("no repeated notification", posted, postedCount());

            assertEquals("the waybill record's own newer event notifies as before", 1,
                    round(orderFirst,
                            () -> listParcel(StatusSemantic.DELIVERY, new String[][]{
                                    {at("2026-09-24 09:00:00"), PARCEL_DELIVERY},
                                    {at("2026-09-23 18:00:00"), PARCEL_TRANSIT},
                                    {at("2026-09-22 18:00:00"), PARCEL_PICKUP}}),
                            () -> listOrder(ORDER, StatusSemantic.TRANSIT, orderNodes(3))));
            assertEquals(posted + 1, postedCount());
            assertEquals(StatusSemantic.DELIVERY, onlyListedRow().semantic);
        }
    }

    /**
     * Pixel 原样：运单行 09-16 签收，订单已完成（09-18 评价节点），首页京粉页把订单投影上来。之后三轮同步：可见行仍是
     * 签收的运单行、头条和时间都是它自己的，没有推送；订单的京东完成不再冻结运单行；订单行照常写自己的数据，按它自己的
     * 完成时间留存。
     */
    @Test public void pixelShapeTheSignedWaybillRowStaysAsItWas() throws Exception {
        String[][] signed = {
                {at("2026-09-16 20:05:18"), PARCEL_SIGNED},
                {at("2026-09-13 18:00:00"), PARCEL_PICKUP}};
        ExpressItem parcel = parcel(StatusSemantic.COMPLETED, signed);
        ExpressItem order = order(ORDER, StatusSemantic.COMPLETED, completedOrderNodes());
        captureUnionPage(order);
        int posted = postedCount();

        boolean orderFirst = false;
        for (int round = 1; round <= 3; round++) {
            assertEquals(0, round(orderFirst,
                    () -> listParcel(StatusSemantic.COMPLETED, signed),
                    () -> listOrder(ORDER, StatusSemantic.COMPLETED, completedOrderNodes())));
            orderFirst = !orderFirst;
            ExpressItem shown = onlyListedRow();
            assertEquals(parcel.rowId, shown.rowId);
            assertEquals(WAYBILL, shown.waybill);
            assertEquals(StatusSemantic.COMPLETED, shown.semantic);
            assertEquals(PARCEL_SIGNED, shown.latestDetail);
            assertEquals(at("2026-09-16 20:05:18"), shown.latestTime);
            assertEquals("CaiNiao", shown.sourceProvider);
        }
        assertEquals(posted, postedCount());
        assertFalse("the order's JD completion no longer freezes the waybill row",
                displayFrozen(parcel.rowId));
        ExpressItem attached = repository.find(order.rowId);
        assertEquals(StatusSemantic.COMPLETED, attached.semantic);
        assertTrue("retention runs on the attached row's own time", attached.signedRetainedAt > 0L);
    }

    /**
     * 归属-1：手动行与投影订单同号，投影时没写出归属（承运商没解析出来），下一条订单包本身合格：按 §5.2 自动来源接管，
     * 归属给订单自己的行，手动行隐藏、一个字段都不改。
     */
    @Test public void aManualRowIsHiddenUnchangedWhenTheProjectedOrderTakesOver() throws Exception {
        ExpressItem manual = manualRow();
        Map<String, String> manualBefore = rawRow(manual.rowId);
        List<String> manualSidecarBefore = rows(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE);
        // The order's first list record carries no raw carrier: a provisional row with no owner.
        repository.saveInterface5OrderSummary(orderPacket(ORDER, "", "", StatusSemantic.TRANSIT,
                orderNodes(0)), PHONE);
        ExpressItem order = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(order);
        assertEquals(0, ownershipCount());
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, ""));
        assertEquals("no carrier, so the projection wrote no owner", 0, ownershipCount());

        listOrder(ORDER, StatusSemantic.TRANSIT, orderNodes(1));

        assertEquals("the manual row's fields are never rewritten", manualBefore, rawRow(manual.rowId));
        assertEquals(manualSidecarBefore, rows(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE));
        assertTrue(repository.find(manual.rowId).manuallyAdded);
        assertEquals(order.rowId, ownerRowId(WAYBILL));
        assertEquals(ORDER, ownerRecordKey(WAYBILL));
        ExpressItem shown = onlyListedRow();
        assertEquals("the order's own row takes over", order.rowId, shown.rowId);
        assertEquals(WAYBILL, shown.displayWaybill());
        assertEquals(orderNodes(1)[0][1], shown.latestDetail);
    }

    /** 两张订单投到同一个运单号：先占的显示，后到的挂靠；两种列表顺序各三轮，不来回翻，后到的新节点不推送。 */
    @Test public void twoOrdersOnOneWaybillShowTheFirstAndAttachTheSecond() throws Exception {
        for (boolean secondFirst : new boolean[]{false, true}) {
            resetDatabase();
            ExpressItem first = order(ORDER, StatusSemantic.TRANSIT, orderNodes(0));
            ExpressItem second = order(SECOND_ORDER, StatusSemantic.TRANSIT, secondNodes(0));
            assertTrue(repository.saveOrderProjection(first, "interface5", WAYBILL, "圆通速递"));
            assertTrue(repository.saveOrderProjection(
                    repository.find(second.rowId), "interface5", WAYBILL, "圆通速递"));
            int posted = postedCount();

            for (int round = 1; round <= 3; round++) {
                String[][] secondRound = secondNodes(round);
                assertEquals(0, round(secondFirst,
                        () -> listOrder(ORDER, StatusSemantic.TRANSIT, orderNodes(0)),
                        () -> listOrder(SECOND_ORDER, StatusSemantic.TRANSIT, secondRound)));
                ExpressItem shown = onlyListedRow();
                assertEquals(first.rowId, shown.rowId);
                assertEquals(ORDER, shown.waybill);
                assertEquals(orderNodes(0)[0][1], shown.latestDetail);
                ExpressItem attached = repository.find(second.rowId);
                assertEquals(SECOND_ORDER, attached.waybill);
                assertEquals(secondRound[0][1], attached.latestDetail);
                assertEquals(first.rowId, ownerRowId(WAYBILL));
                assertEquals(ORDER, ownerRecordKey(WAYBILL));
            }
            assertEquals(posted, postedCount());
            assertEquals("the visible order's sheet may add the attached order's stage", 1,
                    repository.attachedOrderFeeds(repository.find(first.rowId)).size());
            assertTrue("an attached row's sheet adds nothing",
                    repository.attachedOrderFeeds(repository.find(second.rowId)).isEmpty());
        }
    }

    /**
     * 先到先得的另一边：订单先投影、没人占号，订单成为归属方；之后才出现的运单记录挂靠，不写订单的行，只留下自己的观测
     * （§5.1 第 3 条）。两种列表顺序都不翻。决定 A（2026-09-26）：订单行在列表上跟随它更新的结构化状态和头条，第一轮通知
     * 一次，之后不再重复。
     */
    @Test public void aWaybillRecordArrivingAfterTheOrderOwnsTheNumberIsAttached() throws Exception {
        for (boolean orderFirst : new boolean[]{false, true}) {
            resetDatabase();
            ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(0));
            assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
            assertEquals(order.rowId, ownerRowId(WAYBILL));
            int posted = postedCount();

            for (int round = 1; round <= 3; round++) {
                assertEquals("the adopted status notifies in the first round only",
                        round == 1 ? 1 : 0, round(orderFirst,
                        () -> listParcel(StatusSemantic.DELIVERY, new String[][]{
                                {at("2026-09-24 09:00:00"), PARCEL_DELIVERY},
                                {at("2026-09-22 18:00:00"), PARCEL_PICKUP}}),
                        () -> listOrder(ORDER, StatusSemantic.TRANSIT, orderNodes(0))));
                ExpressItem shown = onlyListedRow();
                assertEquals(order.rowId, shown.rowId);
                assertEquals(ORDER, shown.waybill);
                assertEquals(StatusSemantic.DELIVERY, shown.semantic);
                assertEquals(PARCEL_DELIVERY, shown.latestDetail);
                assertEquals(orderNodes(0)[0][1],
                        repository.automaticSourceTimeline(shown).latestDetail);
                assertEquals("the waybill record gets no row", 0,
                        count(ExpressDatabase.EXPRESS_TABLE, "normalizedMailNo=?", WAYBILL));
                assertEquals(1, count(ExpressDatabase.EXPRESS_TABLE, "normalizedMailNo=?", ORDER));
            }
            assertEquals(posted + 1, postedCount());
            assertEquals("the waybill record's observation is retained in its own slot", 1,
                    count(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                            "normalized_waybill=? AND record_key=?", WAYBILL, WAYBILL));
            assertEquals(1, count(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                    "normalized_waybill=? AND record_key=?", WAYBILL, ORDER));
        }
    }

    /**
     * 归属-2：可见运单行的详情页接上挂靠订单早于归属包最早节点的订单阶段节点（沿用 D-8，只在详情页）。更晚的订单节点不接；
     * 列表、行本身和缓存都不变。
     */
    @Test public void theDetailPageAddsOnlyTheAttachedOrdersEarlierOrderStage() throws Exception {
        parcel(StatusSemantic.TRANSIT, new String[][]{
                {at("2026-09-23 18:00:00"), PARCEL_TRANSIT},
                {at("2026-09-22 18:00:00"), PARCEL_PICKUP}});
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, new String[][]{
                {at("2026-09-23 09:00:00"), ORDER_PICKUP},
                {at("2026-09-21 20:00:00"), ORDER_OUTBOUND},
                {at("2026-09-21 10:00:00"), ORDER_SUBMITTED}});
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        ExpressItem shown = onlyListedRow();
        String storedTracks = shown.tracksJson;

        List<String> feeds = repository.attachedOrderFeeds(shown);
        assertEquals(1, feeds.size());
        ExpressQueryResult detail = ManualTimelineAuthorityPolicy.withAttachedOrderStage(
                repository.automaticSourceTimeline(shown), feeds);
        List<String> details = new ArrayList<>();
        for (ExpressTimeline.Track track : ExpressTimeline.parse(detail.tracksJson, "", "")) {
            details.add(track.detail);
        }
        assertEquals(java.util.Arrays.asList(
                PARCEL_TRANSIT, PARCEL_PICKUP, ORDER_OUTBOUND, ORDER_SUBMITTED), details);
        assertTrue("the attached row itself owns nothing", repository.attachedOrderFeeds(
                repository.find(order.rowId)).isEmpty());
        ExpressItem listed = onlyListedRow();
        assertEquals("the list stays the owner's", PARCEL_TRANSIT, listed.latestDetail);
        assertEquals(storedTracks, listed.tracksJson);
        assertFalse(listed.tracksJson.contains(ORDER_SUBMITTED));
    }

    /** §5.4 哑火记账仍按包裹号：列表里只剩挂靠订单时这个号也算看见了；两条都不见才记一次哑火，归属不动。 */
    @Test public void misfireAccountingStaysOnTheParcelNumber() throws Exception {
        ExpressItem parcel = parcel(StatusSemantic.TRANSIT, parcelTransit());
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(0));
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        String generation = repository.bindingGeneration(PHONE, "interface5");

        Map<String, Set<String>> onlyOrder = new HashMap<>();
        onlyOrder.put(generation, new HashSet<>(Collections.singletonList(ORDER)));
        repository.recordAutomaticRefreshExecuted("INTERFACE5", onlyOrder, System.currentTimeMillis());
        assertEquals(0L, ownershipNumber(WAYBILL, "miss_count"));
        assertEquals(parcel.rowId, ownerRowId(WAYBILL));

        Map<String, Set<String>> neither = new HashMap<>();
        neither.put(generation, new HashSet<>());
        repository.recordAutomaticRefreshExecuted("INTERFACE5", neither, System.currentTimeMillis());
        assertEquals(1L, ownershipNumber(WAYBILL, "miss_count"));
        assertEquals(parcel.rowId, ownerRowId(WAYBILL));
        assertEquals(WAYBILL, ownerRecordKey(WAYBILL));
    }

    /** 挂靠行照常按它自己的时间删除：订单签收满 21 天被清理，运单行和运单号的归属、观测都留着，只清掉订单自己的观测槽。 */
    @Test public void theAttachedRowExpiresOnItsOwnTime() throws Exception {
        ExpressItem parcel = parcel(StatusSemantic.TRANSIT, parcelTransit());
        ExpressItem order = order(ORDER, StatusSemantic.COMPLETED, completedOrderNodes());
        captureUnionPage(order);
        listOrder(ORDER, StatusSemantic.COMPLETED, completedOrderNodes());
        long later = System.currentTimeMillis() + 40L * 24L * 60L * 60L * 1000L;

        List<?> expired = ReflectionHelpers.callInstanceMethod(repository, "pruneExpiredShipments",
                ClassParameter.from(long.class, later));
        assertEquals(1, expired.size());
        assertNull(repository.find(order.rowId));
        assertNotNull(repository.find(parcel.rowId));
        assertEquals(parcel.rowId, ownerRowId(WAYBILL));
        assertEquals(1, count(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                "normalized_waybill=? AND record_key=?", WAYBILL, WAYBILL));
        assertEquals("the removed order's own slot goes with it", 0,
                count(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE, "record_key=?", ORDER));
    }

    /**
     * 决定 A（用户 2026-09-26）：订单先占号、运单自己的承运商记录挂靠时，可见的订单行在列表上跟随那条记录更新的结构化
     * 状态（比如签收），带上它的头条和头条时间，按 restoreAccountActivity 跟随更新的同票 v5_query 的办法；轨迹各归各的。
     * 状态变化按既有规则通知一次。
     */
    @Test public void theOrderHoldingTheWaybillListsItsCarrierRecordsNewerStatus() throws Exception {
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(0));
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        assertEquals(order.rowId, ownerRowId(WAYBILL));
        int posted = postedCount();
        String signedAt = at("2026-09-24 10:00:00");

        assertEquals("the adopted status change notifies once", 1, round(false,
                () -> listParcel(StatusSemantic.COMPLETED, parcelSigned(signedAt)),
                () -> listOrder(ORDER, StatusSemantic.TRANSIT, orderNodes(0))));

        ExpressItem shown = onlyListedRow();
        assertEquals(order.rowId, shown.rowId);
        assertEquals("the row keeps its identity", ORDER, shown.waybill);
        assertEquals(WAYBILL, shown.displayWaybill());
        assertEquals(StatusSemantic.COMPLETED, shown.semantic);
        assertEquals(PARCEL_SIGNED, shown.latestDetail);
        assertEquals(signedAt, shown.latestTime);
        assertEquals("the order's own feed is untouched", StatusSemantic.TRANSIT, shown.sourceSemantic);
        assertFalse("timelines stay separate", shown.tracksJson.contains(PARCEL_SIGNED));
        assertFalse(repository.automaticSourceTimeline(shown).tracksJson.contains(PARCEL_SIGNED));
        assertEquals(StatusSemantic.COMPLETED, repository.find(order.rowId).semantic);
        assertEquals(posted + 1, postedCount());
        assertEquals("the carrier record keeps its own slot", 1,
                count(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                        "normalized_waybill=? AND record_key=?", WAYBILL, WAYBILL));
        assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE, "normalizedMailNo=?", WAYBILL));
    }

    /** 挂靠承运商记录的结构化状态比订单行现在的旧：不跟随，不通知。 */
    @Test public void anOlderCarrierStatusIsNotAdopted() throws Exception {
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(1));
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        int posted = postedCount();

        assertEquals(0, round(false,
                () -> listParcel(StatusSemantic.DELIVERY, new String[][]{
                        {at("2026-09-23 09:00:00"), PARCEL_DELIVERY},
                        {at("2026-09-22 18:00:00"), PARCEL_PICKUP}}),
                () -> listOrder(ORDER, StatusSemantic.TRANSIT, orderNodes(1))));

        ExpressItem shown = onlyListedRow();
        assertEquals(order.rowId, shown.rowId);
        assertEquals(StatusSemantic.TRANSIT, shown.semantic);
        assertEquals(orderNodes(1)[0][1], shown.latestDetail);
        assertEquals(posted, postedCount());
    }

    /**
     * 采纳 A 统一（用户 2026-09-26，其余裁决 9；Lite 补这一条）：表头只在不比现有表头旧时才换。挂靠承运商记录的结构化
     * 状态比订单行的新、它自己最新的节点却比订单行现在的表头旧时，状态照换，表头不换（D6：头条是最新的有效节点）。
     */
    @Test public void anAdoptedStatusKeepsTheOrdersNewerHeadline() throws Exception {
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(2));
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        String[][] ownNodes = orderNodes(2);
        long statusAt = ExpressSourcePolicy.parseEventTime(at("2026-09-23 13:00:00"));
        String[][] carrierNodes = {
                {at("2026-09-23 11:00:00"), PARCEL_DELIVERY},
                {at("2026-09-22 18:00:00"), PARCEL_PICKUP}};

        round(false, () -> repository.saveInterface5(new ExpressQueryResult(WAYBILL, "YTO", "圆通速递",
                        StatusSemantic.DELIVERY, statusAt, carrierNodes[0][0], carrierNodes[0][1],
                        tracks(carrierNodes), "", PHONE, TimelineSlot.V5_QUERY, "", "", "CaiNiao")
                        .withWorkerStatus(status("SHIPMENT", StatusSemantic.DELIVERY, statusAt)), PHONE),
                () -> listOrder(ORDER, StatusSemantic.TRANSIT, ownNodes));

        ExpressItem shown = onlyListedRow();
        assertEquals(order.rowId, shown.rowId);
        assertEquals("the newer structured status is adopted", StatusSemantic.DELIVERY, shown.semantic);
        assertEquals(statusAt, shown.statusEventTime);
        assertEquals("an older carrier node does not replace a newer headline",
                ownNodes[0][1], shown.latestDetail);
        assertEquals(ownNodes[0][0], shown.latestTime);
    }

    /** 反方向永不发生：运单行先占号，挂靠订单报了更新的结构化签收，运单行照旧显示它自己的（09-08 规则）。 */
    @Test public void anAttachedOrderNeverLendsItsStatusToTheWaybillRow() throws Exception {
        ExpressItem parcel = parcel(StatusSemantic.TRANSIT, parcelTransit());
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(0));
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        int posted = postedCount();
        String[][] orderSigned = {
                {at("2026-09-24 10:00:00"), "您的订单已签收，感谢您在京东购物"},
                {at("2026-09-22 17:30:00"), ORDER_PICKUP}};

        assertEquals(0, round(false,
                () -> listParcel(StatusSemantic.TRANSIT, parcelTransit()),
                () -> listOrder(ORDER, StatusSemantic.COMPLETED, orderSigned)));

        ExpressItem shown = onlyListedRow();
        assertEquals(parcel.rowId, shown.rowId);
        assertEquals(StatusSemantic.TRANSIT, shown.semantic);
        assertEquals(PARCEL_TRANSIT, shown.latestDetail);
        assertEquals(StatusSemantic.COMPLETED, repository.find(order.rowId).semantic);
        assertEquals(posted, postedCount());
    }

    /**
     * 跟随之后不再重复：之后几轮承运商包、订单自己的包（含订单更新的节点、仍早于签收）都不再通知，列表一直是承运商的签收。
     */
    @Test public void anAdoptedStatusNeverNotifiesAgain() throws Exception {
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(0));
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        String signedAt = at("2026-09-24 10:00:00");
        assertEquals(1, round(true,
                () -> listParcel(StatusSemantic.COMPLETED, parcelSigned(signedAt)),
                () -> listOrder(ORDER, StatusSemantic.TRANSIT, orderNodes(0))));
        int posted = postedCount();

        for (int round = 1; round <= 3; round++) {
            String[][] orderRound = orderNodes(round);
            boolean orderFirst = round % 2 == 0;
            assertEquals("round " + round, 0, round(orderFirst,
                    () -> listParcel(StatusSemantic.COMPLETED, parcelSigned(signedAt)),
                    () -> listOrder(ORDER, StatusSemantic.TRANSIT, orderRound)));
            ExpressItem shown = onlyListedRow();
            assertEquals(StatusSemantic.COMPLETED, shown.semantic);
            assertEquals(PARCEL_SIGNED, shown.latestDetail);
            assertEquals(orderRound[0][1], repository.automaticSourceTimeline(shown).latestDetail);
        }
        assertEquals(posted, postedCount());
    }

    /** 留存照常按显示的时间：跟随来的签收已满 14 天，订单行随之隐藏，也不为它通知。 */
    @Test public void retentionFollowsTheAdoptedDisplayedTime() throws Exception {
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, new String[][]{
                {at("2026-09-04 09:00:00"), ORDER_PICKUP}});
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        assertEquals(order.rowId, onlyListedRow().rowId);
        int posted = postedCount();

        listParcel(StatusSemantic.COMPLETED, new String[][]{
                {at("2026-09-09 10:00:00"), PARCEL_SIGNED},
                {at("2026-09-05 18:00:00"), PARCEL_PICKUP}});

        assertTrue("signed 15 days ago by the displayed time",
                repository.listVisible("interface5").isEmpty());
        assertEquals(StatusSemantic.COMPLETED, repository.find(order.rowId).semantic);
        assertEquals(posted, postedCount());
    }

    /** 同一批里订单先攒了一条通知、随后投影挂靠：批末重放时它已是挂靠行，这条通知丢掉不发。 */
    @Test public void aStagedNotificationIsDroppedOnceItsRowIsAttached() throws Exception {
        parcel(StatusSemantic.TRANSIT, parcelTransit());
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(0));
        int posted = postedCount();
        int[] staged = {0};
        repository.runInChangeBatch(() -> {
            listOrder(ORDER, StatusSemantic.TRANSIT, orderNodes(1));
            staged[0] = count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null);
            assertTrue(repository.saveOrderProjection(
                    repository.find(order.rowId), "interface5", WAYBILL, "圆通速递"));
        });
        assertEquals("the unprojected order's own update was staged", 1, staged[0]);
        assertEquals(posted, postedCount());
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null));
    }

    /** 订单改投到另一个运单号时只搬它自己的观测和它自己的归属；原运单号的归属方和它的观测不动。 */
    @Test public void reprojectionMovesOnlyTheOrdersOwnSlotsAndClaim() throws Exception {
        ExpressItem parcel = parcel(StatusSemantic.TRANSIT, parcelTransit());
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(0));
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        String other = "JT1234567890123";

        assertTrue(repository.saveOrderProjection(
                repository.find(order.rowId), "interface5", other, "极兔速递"));

        assertEquals(parcel.rowId, ownerRowId(WAYBILL));
        assertEquals(WAYBILL, ownerRecordKey(WAYBILL));
        assertEquals(1, count(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                "normalized_waybill=? AND record_key=?", WAYBILL, WAYBILL));
        assertEquals(0, count(ExpressDatabase.AUTOMATIC_OBSERVATION_TABLE,
                "normalized_waybill=? AND record_key=?", WAYBILL, ORDER));
        assertEquals("the unowned new waybill goes to the order", order.rowId, ownerRowId(other));
        assertEquals(ORDER, ownerRecordKey(other));
        assertEquals(2, repository.listVisible("interface5").size());
    }

    /**
     * 归属方的行没了、归属还悬着：谁先带着合格的包来谁接手（ownership plan 风险第五条）——这里先来的是挂靠订单，接手的
     * 是它自己的行；之后回来的运单记录挂靠。
     */
    @Test public void aVacantOwnershipGoesToTheFirstQualifiedRecordsOwnRow() throws Exception {
        ExpressItem parcel = parcel(StatusSemantic.TRANSIT, parcelTransit());
        ExpressItem order = order(ORDER, StatusSemantic.TRANSIT, orderNodes(0));
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        database.getWritableDatabase().delete(ExpressDatabase.EXPRESS_TABLE, "_id=?",
                new String[]{Long.toString(parcel.rowId)});

        listOrder(ORDER, StatusSemantic.TRANSIT, orderNodes(1));

        assertEquals(order.rowId, ownerRowId(WAYBILL));
        assertEquals(ORDER, ownerRecordKey(WAYBILL));
        ExpressItem shown = onlyListedRow();
        assertEquals(order.rowId, shown.rowId);
        assertEquals(WAYBILL, shown.displayWaybill());
        listParcel(StatusSemantic.TRANSIT, parcelTransit());
        assertEquals(order.rowId, ownerRowId(WAYBILL));
        assertEquals(0, count(ExpressDatabase.EXPRESS_TABLE, "normalizedMailNo=?", WAYBILL));
    }

    /** §5.3 换接口：归属方的绑定失效，下一个合格观测是挂靠订单的，归属移到订单自己的行，原运单行一个字段都不改。 */
    @Test public void aBindingHandoffMovesOwnershipToTheOrdersOwnRow() throws Exception {
        String otherPhone = "13900000580";
        repository.bindPhoneLocally(otherPhone, "interface5");
        ExpressItem parcel = parcel(StatusSemantic.TRANSIT, parcelTransit());
        repository.saveInterface5OrderSummary(orderPacket(ORDER, "JDKD", "京东商品快递",
                StatusSemantic.TRANSIT, orderNodes(0), otherPhone), otherPhone);
        ExpressItem order = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(order);
        assertTrue(repository.saveOrderProjection(order, "interface5", WAYBILL, "圆通速递"));
        assertEquals(parcel.rowId, ownerRowId(WAYBILL));
        Map<String, String> parcelBefore = rawRow(parcel.rowId);

        repository.unbindPhone(PHONE, "interface5");

        assertEquals(order.rowId, ownerRowId(WAYBILL));
        assertEquals(ORDER, ownerRecordKey(WAYBILL));
        assertEquals("the previous owner row is not written", parcelBefore, rawRow(parcel.rowId));
    }

    /** 兜底：归属记录与行不一致的异常状态下，记录也不改写别人的行，而是写一行自己的。 */
    @Test public void aRecordNeverRewritesARowCarryingAnotherNumber() throws Exception {
        ExpressItem parcel = parcel(StatusSemantic.TRANSIT, parcelTransit());
        ContentValues foreign = new ContentValues();
        foreign.put("mailNo", ORDER);
        foreign.put("normalizedMailNo", ORDER);
        database.getWritableDatabase().update(ExpressDatabase.EXPRESS_TABLE, foreign, "_id=?",
                new String[]{Long.toString(parcel.rowId)});

        listParcel(StatusSemantic.DELIVERY, new String[][]{
                {at("2026-09-24 09:00:00"), PARCEL_DELIVERY},
                {at("2026-09-22 18:00:00"), PARCEL_PICKUP}});

        assertEquals(ORDER, rawRow(parcel.rowId).get("mailNo"));
        long own = ownerRowId(WAYBILL);
        assertTrue(own != parcel.rowId);
        assertEquals(WAYBILL, rawRow(own).get("mailNo"));
        assertEquals(PARCEL_DELIVERY, repository.find(own).latestDetail);
    }

    private ExpressItem parcel(StatusSemantic semantic, String[][] nodes) throws Exception {
        listParcel(semantic, nodes);
        ExpressItem parcel = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(parcel);
        assertEquals(WAYBILL, parcel.waybill);
        return parcel;
    }

    private ExpressItem order(String order, StatusSemantic semantic, String[][] nodes)
            throws Exception {
        listOrder(order, semantic, nodes);
        ExpressItem row = repository.findByWaybill(order, "interface5");
        assertNotNull(row);
        assertTrue(row.isAccountOrder());
        assertTrue(row.projectedWaybill.isEmpty());
        return row;
    }

    private ExpressItem manualRow() throws Exception {
        String time = at("2026-09-22 18:00:00");
        repository.saveManualQueryResult(new ExpressQueryResult(WAYBILL, "YTO", "圆通速递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(time), time,
                PARCEL_PICKUP, tracks(new String[][]{{time, PARCEL_PICKUP}}),
                "", PHONE, "meizu", "", "", "")
                .withManualStatusEvidence(StatusSemantic.PICKED.label, true), PHONE, "interface5");
        ExpressItem manual = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(manual);
        assertTrue(manual.manuallyAdded);
        return manual;
    }

    /** The parcel's own Interface-5 record, reported by CaiNiao with a structured shipment status. */
    private void listParcel(StatusSemantic semantic, String[][] nodes) {
        long eventAt = ExpressSourcePolicy.parseEventTime(nodes[0][0]);
        repository.saveInterface5(new ExpressQueryResult(WAYBILL, "YTO", "圆通速递",
                semantic, eventAt, nodes[0][0], nodes[0][1], tracks(nodes),
                "", PHONE, TimelineSlot.V5_QUERY, "", "", "CaiNiao")
                .withWorkerStatus(status("SHIPMENT", semantic, eventAt)), PHONE);
    }

    private void listOrder(String order, StatusSemantic semantic, String[][] nodes) {
        repository.saveInterface5OrderSummary(
                orderPacket(order, "JDKD", "京东商品快递", semantic, nodes), PHONE);
    }

    private static ExpressQueryResult orderPacket(String order, String code, String name,
            StatusSemantic semantic, String[][] nodes) {
        return orderPacket(order, code, name, semantic, nodes, PHONE);
    }

    private static ExpressQueryResult orderPacket(String order, String code, String name,
            StatusSemantic semantic, String[][] nodes, String phone) {
        long eventAt = ExpressSourcePolicy.parseEventTime(nodes[0][0]);
        return new ExpressQueryResult(order, code, name, semantic, eventAt, nodes[0][0],
                nodes[0][1], tracks(nodes), "", phone, "interface5", "", "", "JingDong")
                .withWorkerStatus(status("ORDER", semantic, eventAt));
    }

    /** Home's capture save path: a complete union page package naming the parcel's waybill. */
    private void captureUnionPage(ExpressItem order) {
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(order);
        assertTrue(repository.saveAutomaticDetailTimeline(order, claim, new ExpressQueryResult(
                WAYBILL, "YTO", "圆通速递", StatusSemantic.UNKNOWN, 0L,
                at("2026-09-15 20:05:10"), DOORSTEP, tracks(new String[][]{
                        {at("2026-09-15 20:05:10"), DOORSTEP},
                        {at("2026-09-13 18:00:00"), PARCEL_PICKUP}}),
                "", "", TimelineSlot.JD_H5, "", "", ""), true));
        assertEquals(WAYBILL, repository.find(order.rowId).projectedWaybill);
    }

    /** One background sync round with both list records; returns what it staged. */
    private int round(boolean orderFirst, Runnable parcel, Runnable order) {
        int[] staged = {0};
        repository.runInChangeBatch(() -> {
            if (orderFirst) {
                order.run();
                parcel.run();
            } else {
                parcel.run();
                order.run();
            }
            staged[0] = count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE, null);
        });
        return staged[0];
    }

    private static String[][] parcelTransit() {
        return new String[][]{
                {at("2026-09-23 18:00:00"), PARCEL_TRANSIT},
                {at("2026-09-22 18:00:00"), PARCEL_PICKUP}};
    }

    private static String[][] parcelSigned(String signedAt) {
        return new String[][]{
                {signedAt, PARCEL_SIGNED},
                {at("2026-09-22 18:00:00"), PARCEL_PICKUP}};
    }

    /** The order's feed; each later round adds one newer node. */
    private static String[][] orderNodes(int round) {
        ArrayList<String[]> nodes = new ArrayList<>();
        for (int index = round; index >= 1; index--) {
            nodes.add(new String[]{at("2026-09-23 1" + index + ":30:00"),
                    "您的订单已到达【上海转运中心" + index + "】"});
        }
        nodes.add(new String[]{at("2026-09-22 17:30:00"), ORDER_PICKUP});
        return nodes.toArray(new String[0][]);
    }

    private static String[][] secondNodes(int round) {
        ArrayList<String[]> nodes = new ArrayList<>();
        for (int index = round; index >= 1; index--) {
            nodes.add(new String[]{at("2026-09-23 1" + index + ":40:00"),
                    "另一单：您的订单已到达【杭州分拨中心" + index + "】"});
        }
        nodes.add(new String[]{at("2026-09-22 17:40:00"), "另一单：您的订单已出库"});
        return nodes.toArray(new String[0][]);
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
        assertEquals("one parcel, one row", 1, rows.size());
        return rows.get(0);
    }

    private int postedCount() {
        return Shadows.shadowOf(context.getSystemService(NotificationManager.class))
                .getAllNotifications().size();
    }

    private boolean displayFrozen(long rowId) {
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, new String[]{"display_frozen"},
                "owner_row_id=?", new String[]{Long.toString(rowId)}, null, null, null)) {
            return cursor.moveToFirst() && cursor.getInt(0) != 0;
        }
    }

    private long ownerRowId(String waybill) {
        return ownershipNumber(waybill, "owner_row_id");
    }

    private long ownershipNumber(String waybill, String column) {
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, new String[]{column},
                "normalized_waybill=?", new String[]{waybill}, null, null, null)) {
            assertTrue("owner of " + waybill, cursor.moveToFirst());
            return cursor.getLong(0);
        }
    }

    private String ownerRecordKey(String waybill) {
        try (Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, new String[]{"owner_record_key"},
                "normalized_waybill=?", new String[]{waybill}, null, null, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getString(0);
        }
    }

    private int ownershipCount() {
        return count(ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, null);
    }

    private Map<String, String> rawRow(long rowId) {
        TreeMap<String, String> values = new TreeMap<>();
        try (Cursor cursor = database.getReadableDatabase().query(ExpressDatabase.EXPRESS_TABLE,
                null, "_id=?", new String[]{Long.toString(rowId)}, null, null, null)) {
            assertTrue(cursor.moveToFirst());
            for (int index = 0; index < cursor.getColumnCount(); index++) {
                values.put(cursor.getColumnName(index), cursor.getString(index));
            }
        }
        return values;
    }

    private List<String> rows(String table) {
        ArrayList<String> rows = new ArrayList<>();
        try (Cursor cursor = database.getReadableDatabase().query(
                table, null, null, null, null, null, null)) {
            while (cursor.moveToNext()) {
                StringBuilder row = new StringBuilder();
                for (int index = 0; index < cursor.getColumnCount(); index++) {
                    row.append(cursor.getColumnName(index)).append('=')
                            .append(cursor.getString(index)).append(';');
                }
                rows.add(row.toString());
            }
        }
        Collections.sort(rows);
        return rows;
    }

    private int count(String table, String selection, String... args) {
        try (Cursor cursor = database.getReadableDatabase().query(
                table, null, selection, selection == null ? null : args,
                null, null, null)) {
            return cursor.getCount();
        }
    }

    private static WorkerStatusProjection status(String scope, StatusSemantic semantic, long eventAt) {
        try {
            return WorkerStatusProjection.read(new JSONObject()
                    .put("normalizedStatus", new JSONObject().put("version", 1)
                            .put("scope", scope).put("semantic", semantic.name())
                            .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                            .put("eventAtMs", eventAt).put("structured", true)));
        } catch (org.json.JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String tracks(String[][] nodes) {
        try {
            JSONArray value = new JSONArray();
            for (String[] node : nodes) {
                value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
            }
            return value.toString();
        } catch (org.json.JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
