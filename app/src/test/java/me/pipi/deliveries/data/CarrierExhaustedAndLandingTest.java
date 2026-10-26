package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.database.Cursor;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import me.pipi.deliveries.background.AccountCarrierRecognition;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ManualQuerySuccess;
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
 * T23 细则（用户 2026-09-26，对齐文档「其余裁决」32）：
 * <ul>
 * <li>承运商始终认不出（识别终态：连续 3 次失败，或付费级明确认不出，且快递100 没给名字）：不再无限期挂着，挂起的通知与停在订单
 * 阶段的投影照常放行，承运商位置显示原始承运商码（原样的码，不是平台名「京东快递」）。</li>
 * <li>其余裁决 33（同日，用户：「传回啥 cpcode 就填啥」）：连原始码都没有的件（手动件、订单 cpCode 为空等）也照常放行，承运商
 * 位置填来源传回的 cpCode 原样，没传回就空着，不造占位文案。</li>
 * <li>其余裁决 35（2026-09-27，用户：「算了统一前面加 快递 两个字吧」）：承运商位置为空时，通知标题、列表、小组件、详情页
 * 统一写「快递」，例如「快递 4547 · 已揽收」；承运商名本身（{@code displayCompany}）仍为空。</li>
 * <li>Lite 的 v5 查询文案取号与京粉页投影，投影落地（已下单 → 已揽收等）那一轮也推送，与 iOS、Pipi 一致；推送仍过承运商门，
 * 挂靠到已有运单行的订单照 09-25 / 归属方案不推。</li>
 * </ul>
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class CarrierExhaustedAndLandingTest {
    private static final String PHONE = "13800003232";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private static final CarrierNormalization YTO =
            new CarrierNormalization("YTO", "圆通速递", "yuantong", true, "t23");
    private static final AccountCarrierRecognition.Recognizer EXHAUSTED =
            waybill -> CarrierNormalization.exhausted();

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

    /** A waybill row whose raw code the table cannot name: released at the terminal verdict, shown by that code. */
    @Test public void anExhaustedRowReleasesItsHeldNotificationWithTheRawCode() throws Exception {
        ExpressItem row = parcel("MM7700189071", "MMKD", "", "", StatusSemantic.TRANSIT, 120, "快件运输中");
        parcel("MM7700189071", "MMKD", "", "", StatusSemantic.DELIVERY, 60, "快递员正在派送");
        assertTrue(repository.find(row.rowId).carrierPending());
        assertTrue(postedTitles().isEmpty());

        assertFalse("a retry still due changes nothing", AccountCarrierRecognition.recognize(
                repository, repository.find(row.rowId), waybill -> CarrierNormalization.NONE));
        assertTrue(postedTitles().isEmpty());

        assertTrue(AccountCarrierRecognition.recognize(repository, repository.find(row.rowId), EXHAUSTED));
        ExpressItem released = repository.find(row.rowId);
        assertFalse(released.carrierPending());
        assertEquals("MMKD", released.displayCompany());
        assertDeliveryLive("MMKD", "MM7700189071");
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));

        // A later list write without a built-in answer keeps the verdict; a built-in answer replaces it.
        parcel("MM7700189071", "MMKD", "", "", StatusSemantic.DELIVERY, 30, "快递员正在派送，请保持电话畅通",
                new CarrierNormalization("", "", "", false, "worker"));
        assertEquals("MMKD", repository.find(row.rowId).displayCompany());
        assertFalse("still released", repository.find(row.rowId).carrierPending());
        assertTrue("a verdict keeps retrying", AccountCarrierRecognition.needsRecognition(
                repository.find(row.rowId)));
        assertTrue(AccountCarrierRecognition.recognize(repository, repository.find(row.rowId), waybill -> YTO));
        assertEquals("圆通速递", repository.find(row.rowId).displayCompany());
        assertFalse("never replaces a built-in carrier", AccountCarrierRecognition.recognize(
                repository, repository.find(row.rowId), EXHAUSTED));
    }

    /** Kuaidi100's off-table name is a carrier; a later terminal verdict never replaces it. */
    @Test public void aTerminalVerdictNeverReplacesAnOffTableName() throws Exception {
        ExpressItem row = parcel("MM7700189074", "MMKD", "", "", StatusSemantic.TRANSIT, 120, "快件运输中");
        assertTrue(AccountCarrierRecognition.recognize(repository, row,
                waybill -> CarrierNormalization.offTable("某某速运", "moumou")));
        assertFalse(repository.saveRecognizedCarrier(repository.find(row.rowId), CarrierNormalization.exhausted()));
        assertEquals("某某速运", repository.find(row.rowId).displayCompany());
    }

    /** A JD-platform row shows its raw code as it is, never the platform name 京东快递. */
    @Test public void aJdPlatformRowShowsItsRawCodeNotThePlatformName() throws Exception {
        ExpressItem row = parcel("JT4006839564572", "JDKD", "京东快递", "JingDong",
                StatusSemantic.TRANSIT, 120, "快件运输中");
        parcel("JT4006839564572", "JDKD", "京东快递", "JingDong", StatusSemantic.DELIVERY, 60, "快递员正在派送");
        assertEquals("", repository.find(row.rowId).displayCompany());
        assertTrue(postedTitles().isEmpty());
        assertTrue(AccountCarrierRecognition.recognize(repository, repository.find(row.rowId), EXHAUSTED));
        assertEquals("JDKD", repository.find(row.rowId).displayCompany());
        assertDeliveryLive("JDKD", "JT4006839564572");
    }

    /**
     * 其余裁决 33: without any returned cpCode the row is released all the same and its carrier position stays
     * empty — no placeholder is made up. (Expectation migrated from 32's interim "stays held", which was the
     * point left to the user; 33 decides it. An account list row always carries raw carrier evidence — Lite
     * does not import one without it — so the row here is a manual one, whose Meizu answer and add-box hint
     * may both be empty.)
     */
    @Test public void withoutARawCodeTheRowIsReleasedWithAnEmptyCarrier() throws Exception {
        String waybill = "MM7700189073";
        ExpressItem row = repository.saveManualQueryBatch(null, Collections.singletonList(
                new ManualQuerySuccess(TimelineSlot.V6_QUERY, manualResult(waybill, "",
                        StatusSemantic.TRANSIT, 120, "快件运输中"), 1_000L, false)), "", "interface5");
        assertNotNull(row);
        repository.saveManualQueryBatch(repository.find(row.rowId),
                repository.captureManualQueryOwner(repository.find(row.rowId)),
                Collections.singletonList(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                        manualResult(waybill, "", StatusSemantic.DELIVERY, 60, "快递员正在派送"),
                        2_000L, false)), "", "interface5");
        assertEquals("the delivery round is held", 1, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        assertTrue(AccountCarrierRecognition.recognize(repository, repository.find(row.rowId), EXHAUSTED));
        ExpressItem released = repository.find(row.rowId);
        assertEquals("", released.displayCompany());
        assertFalse(released.carrierPending());
        // 其余裁决 35 (migrated from 33's bare "9073 · 派送中"): an empty carrier position reads 快递.
        assertEquals("快递", released.displayCarrierLabel());
        assertDeliveryLive("快递", waybill);
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
    }

    /** An order held at the order stage projects at the terminal verdict, shown by the order's raw code. */
    @Test public void aHeldOrderTextProjectionIsReleasedWithTheRawCode() throws Exception {
        ExpressItem order = listOrder("3630448013823201", "JDKD", StatusSemantic.PICKED,
                "您的订单由第三方卖家拣货完成，待出库交付申通快递，运单号为770018906334362");
        ExpressRepository.PendingProjection pending = repository.pendingProjection(order);
        assertNotNull(pending);
        assertTrue(AccountCarrierRecognition.projectPending(repository, order, pending, EXHAUSTED, null));
        ExpressItem projected = repository.find(order.rowId);
        assertEquals("770018906334362", projected.projectedWaybill);
        assertEquals("JDKD", projected.displayCompany());
        assertFalse(projected.carrierPending());
        assertEquals(List.of("JDKD 4362 · 已揽件"), postedTitles());

        // A later built-in recognition still names the carrier.
        assertTrue(AccountCarrierRecognition.recognize(repository, projected,
                waybill -> new CarrierNormalization("STO", "申通快递", "shentong", true, "t23")));
        assertEquals("申通快递", repository.find(order.rowId).displayCompany());
    }

    /** 其余裁决 33 (migrated from 32's interim "stays at the order stage"): an order without a cpCode lands too. */
    @Test public void anOrderWithoutARawCodeIsReleasedWithAnEmptyCarrier() throws Exception {
        ExpressItem order = listOrder("3630448013823202", "", StatusSemantic.PICKED,
                "您的订单由第三方卖家拣货完成，待出库交付申通快递，运单号为770018906334363");
        assertEquals(CarrierNormalization.PROJECTION_EXHAUSTED,
                AccountCarrierRecognition.projectionCarrier(order, "770018906334363", "", EXHAUSTED));
        assertTrue(AccountCarrierRecognition.projectPending(repository, order,
                repository.pendingProjection(order), EXHAUSTED, null));
        ExpressItem released = repository.find(order.rowId);
        assertEquals("770018906334363", released.projectedWaybill);
        assertEquals("", released.displayCompany());
        assertFalse(released.carrierPending());
        assertNull(repository.pendingProjection(released));
        // 其余裁决 35 (migrated from 33's bare "4363 · 已揽件"): an empty carrier position reads 快递.
        assertEquals("快递", released.displayCarrierLabel());
        assertEquals(List.of("快递 4363 · 已揽件"), postedTitles());
    }

    /** A held union page is released at the terminal verdict and its landing round notifies. */
    @Test public void aHeldUnionPageIsReleasedWithTheRawCodeAndNotifies() throws Exception {
        ExpressItem order = listOrder("3630448013823203", "JDKD", StatusSemantic.PICKED, "您的订单已由快递揽收");
        assertTrue(AccountCarrierRecognition.savePageCapture(repository, order,
                repository.captureManualQueryOwner(order), page("YT1234567893203"), true,
                waybill -> CarrierNormalization.NONE, null));
        assertEquals("", repository.find(order.rowId).projectedWaybill);
        assertTrue(AccountCarrierRecognition.projectPending(repository, repository.find(order.rowId),
                repository.pendingProjection(repository.find(order.rowId)), EXHAUSTED, null));
        ExpressItem projected = repository.find(order.rowId);
        assertEquals("YT1234567893203", projected.projectedWaybill);
        assertEquals("JDKD", projected.displayCompany());
        assertNotNull(repository.manualTimelineCandidate(projected, TimelineSlot.JD_H5));
        assertEquals(List.of("JDKD 3203 · 已揽件"), postedTitles());
        assertEquals(0, count(ExpressDatabase.HELD_ORDER_PROJECTION_TABLE));
    }

    /** A projection that showed no carrier before T23 is released at the terminal verdict too. */
    @Test public void aBlankProjectionIsReleasedAtTheTerminalVerdict() throws Exception {
        ExpressItem order = listOrder("3630448013823204", "JDKD", StatusSemantic.PICKED, "您的订单已出库");
        assertTrue(repository.saveOrderProjection(order, "interface5", "MM1234567893204", ""));
        assertTrue(repository.find(order.rowId).carrierPending());
        assertTrue("its projection round is held", postedTitles().isEmpty());
        assertTrue(AccountCarrierRecognition.recognize(repository, repository.find(order.rowId), EXHAUSTED));
        ExpressItem released = repository.find(order.rowId);
        assertEquals("JDKD", released.displayCompany());
        assertEquals(List.of("JDKD 3204 · 已揽件"), postedTitles());
        assertTrue("Kuaidi100's name still replaces the verdict", AccountCarrierRecognition.recognize(
                repository, released, waybill -> CarrierNormalization.offTable("某某速运", "moumou")));
        assertEquals("某某速运", repository.find(order.rowId).displayCompany());
    }

    /** Entry E: the landing round of a v5_query text projection notifies (已下单 → 已揽件). */
    @Test public void aQueryTextProjectionNotifiesItsLandingRound() throws Exception {
        ExpressItem order = listOrder("3630448013823205", "JDKD", StatusSemantic.PICKED, "您的订单已出库");
        assertEquals(StatusSemantic.ORDERED, order.semantic);
        String text = "您的订单由第三方卖家拣货完成，待出库交付申通快递，运单号为770018906334365";
        String time = minutesAgo(90);
        assertTrue(repository.saveInterface5Query(new ExpressQueryResult(order.waybill, "JD", "京东快递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(time), time, text,
                tracks(new String[][]{{time, text}}), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong"),
                order, repository.bindingGeneration(PHONE, "interface5"), "STO"));
        assertEquals("770018906334365", repository.find(order.rowId).projectedWaybill);
        assertEquals(List.of("申通快递 4365 · 已揽件"), postedTitles());
    }

    /** Entry E, released later from the stored reply: its landing round notifies too. */
    @Test public void aStoredQueryTextProjectionNotifiesWhenItLands() throws Exception {
        ExpressItem order = listOrder("3630448013823206", "JDKD", StatusSemantic.PICKED, "您的订单已出库");
        String text = "您的订单由第三方卖家拣货完成，待出库交付申通快递，运单号为770018906334366";
        String time = minutesAgo(90);
        assertTrue(repository.saveInterface5Query(new ExpressQueryResult(order.waybill, "JD", "京东快递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(time), time, text,
                tracks(new String[][]{{time, text}}), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong"),
                order, repository.bindingGeneration(PHONE, "interface5"), null));
        assertTrue(postedTitles().isEmpty());
        ExpressItem kept = repository.find(order.rowId);
        assertTrue(AccountCarrierRecognition.projectPending(repository, kept,
                repository.pendingProjection(kept),
                waybill -> new CarrierNormalization("STO", "申通快递", "shentong", true, "t23"), null));
        assertEquals(List.of("申通快递 4366 · 已揽件"), postedTitles());
    }

    /** Entry F: the landing round of a union page projection notifies (已下单 → 已揽件). */
    @Test public void aUnionPageProjectionNotifiesItsLandingRound() throws Exception {
        ExpressItem order = listOrder("3630448013823207", "JDKD", StatusSemantic.PICKED, "您的订单已由快递揽收");
        assertTrue(AccountCarrierRecognition.savePageCapture(repository, order,
                repository.captureManualQueryOwner(order), page("YT1234567893207"), true,
                waybill -> YTO, null));
        assertEquals("YT1234567893207", repository.find(order.rowId).projectedWaybill);
        assertEquals(List.of("圆通速递 3207 · 已揽件"), postedTitles());
    }

    /**
     * 09-25 / ownership plan T3: an order whose page names a waybill another row already owns is attached
     * and hidden; its landing round notifies nothing.
     */
    @Test public void aUnionPageLandingOnAnOwnedWaybillRowStaysQuiet() throws Exception {
        String waybill = "YT1234567893208";
        String time = minutesAgo(200);
        repository.saveInterface5(new ExpressQueryResult(waybill, "YTO", "圆通速递",
                StatusSemantic.TRANSIT, ExpressSourcePolicy.parseEventTime(time), time, "快件运输中",
                tracks(new String[][]{{time, "快件运输中"}}), "", PHONE, TimelineSlot.V5_QUERY, "", "",
                "CaiNiao").withWorkerStatus(status("SHIPMENT", StatusSemantic.TRANSIT,
                ExpressSourcePolicy.parseEventTime(time))), PHONE);
        ExpressItem order = listOrder("3630448013823208", "JDKD", StatusSemantic.PICKED, "您的订单已由快递揽收");
        int before = count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE);
        int posted = postedTitles().size();
        assertTrue(AccountCarrierRecognition.savePageCapture(repository, order,
                repository.captureManualQueryOwner(order), page(waybill), true, number -> YTO, null));
        assertEquals(waybill, repository.find(order.rowId).projectedWaybill);
        assertEquals(before, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        assertEquals(posted, postedTitles().size());
    }

    /** A manual row with a raw code is released at the terminal verdict, and keeps retrying later. */
    @Test public void anExhaustedManualRowIsReleasedAndStillRetries() throws Exception {
        String waybill = "MM7700189079";
        ExpressItem manual = repository.saveManualQueryBatch(null, Collections.singletonList(
                new ManualQuerySuccess(TimelineSlot.V6_QUERY, manualResult(waybill, "MMKD",
                        StatusSemantic.TRANSIT, 120, "快件运输中"), 1_000L, false)), "", "interface5");
        assertNotNull(manual);
        assertTrue(manual.carrierPending());
        assertTrue(AccountCarrierRecognition.recognize(repository, manual, EXHAUSTED));
        ExpressItem released = repository.find(manual.rowId);
        assertEquals("MMKD", released.displayCompany());
        assertFalse(released.carrierPending());
        assertTrue(AccountCarrierRecognition.needsRecognition(released));
    }

    private ExpressItem parcel(String waybill, String code, String name, String provider,
            StatusSemantic semantic, long minutesAgo, String detail) throws Exception {
        return parcel(waybill, code, name, provider, semantic, minutesAgo, detail, CarrierNormalization.NONE);
    }

    private ExpressItem parcel(String waybill, String code, String name, String provider,
            StatusSemantic semantic, long minutesAgo, String detail, CarrierNormalization worker)
            throws Exception {
        String time = minutesAgo(minutesAgo);
        repository.saveInterface5(new ExpressQueryResult(waybill, code, name,
                semantic, ExpressSourcePolicy.parseEventTime(time), time, detail,
                tracks(new String[][]{{time, detail}}), "", PHONE, "interface5", "", "", provider)
                .withCarrierNormalization(worker), PHONE);
        ExpressItem row = repository.findByWaybill(waybill, "interface5");
        assertNotNull(row);
        return row;
    }

    private ExpressItem listOrder(String orderId, String rawCode, StatusSemantic semantic, String detail)
            throws Exception {
        String time = minutesAgo(100);
        long eventAt = ExpressSourcePolicy.parseEventTime(time);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(orderId, rawCode, "京东商品快递",
                semantic, eventAt, time, detail, tracks(new String[][]{{time, detail}}),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(status("ORDER", semantic, eventAt)), PHONE);
        ExpressItem order = repository.findByWaybill(orderId, "interface5");
        assertNotNull(order);
        assertTrue(order.isAccountOrder());
        assertEquals("", order.projectedWaybill);
        assertEquals(rawCode, order.courierCode);
        return order;
    }

    private static ExpressQueryResult page(String waybill) throws Exception {
        String time = minutesAgo(50);
        return new ExpressQueryResult(waybill, "", "", StatusSemantic.UNKNOWN, 0L, time,
                "【上海市】快件已到达 上海转运中心",
                tracks(new String[][]{{time, "【上海市】快件已到达 上海转运中心"},
                        {minutesAgo(300), "【上海市】圆通速递 已揽收"}}),
                "", "", TimelineSlot.JD_H5, "", "", "");
    }

    private static ExpressQueryResult manualResult(String waybill, String code,
            StatusSemantic semantic, long minutesAgo, String detail) throws Exception {
        String time = minutesAgo(minutesAgo);
        return new ExpressQueryResult(waybill, code, "", semantic, 0L, time, detail,
                tracks(new String[][]{{time, detail}}), "", "", TimelineSlot.V6_QUERY, "", "", "")
                .withManualStatusEvidence(semantic.label, true)
                .withCarrierNormalization(new CarrierNormalization("", "", "", false, "worker"));
    }

    private void assertDeliveryLive(String company, String waybill) {
        List<Notification> posted = Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getAllNotifications();
        assertEquals(1, posted.size());
        Notification live = posted.get(0);
        assertEquals("express_live", live.getChannelId());
        assertEquals("派送中 1 件", live.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        String body = live.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString().replace("\u200B", "");
        assertTrue(body, body.startsWith(company + " · " + waybill));
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

    private int count(String table) {
        try (Cursor cursor = database.getReadableDatabase().query(
                table, null, null, null, null, null, null)) {
            return cursor.getCount();
        }
    }

    private static String minutesAgo(long minutes) {
        return TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - minutes * 60_000L));
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
