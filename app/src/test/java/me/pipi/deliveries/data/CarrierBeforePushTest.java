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
import java.util.concurrent.atomic.AtomicInteger;

import me.pipi.deliveries.R;
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
 * 承运商先对上再推送（T23，用户 2026-09-26，对齐文档「其余裁决」28、29；AGENTS §9 同日新条）。用户原话：「出现运单号之后需要
 * 匹配上承运商才推送 而不是推空白承运商的通知或状态」。
 *
 * <p>28：一票件一有运单号，同一轮先把承运商识别跑完（内置表 → 快递100 免费 → 付费快递鸟）再落库、上列表、推送；这一轮识别
 * 不出来，这一票保持原样（订单行仍是「京东购物」），不推承运商空白的状态或通知，识别出来那一轮再推。29：快递100 认得出、
 * 内置表没有的承运商显示快递100 给的名字，只作显示。</p>
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class CarrierBeforePushTest {
    private static final String PHONE = "13800002323";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private static final CarrierNormalization YTO =
            new CarrierNormalization("YTO", "圆通速递", "yuantong", true, "t23");

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

    /** Entry A: a waybill row whose raw carrier the table cannot name keeps its notification until it is matched. */
    @Test public void aStatusChangeWithAnUnmatchedCarrierWaitsForTheRoundThatMatchesIt() throws Exception {
        ExpressItem row = parcel("YT7700189063", StatusSemantic.TRANSIT, minutesAgo(120), "快件运输中");
        assertTrue("the raw code is shown, not a carrier", row.carrierPending());
        int posted = postedTitles().size();

        parcel("YT7700189063", StatusSemantic.DELIVERY, minutesAgo(60), "快递员正在派送");
        assertEquals("no notification with a blank or raw carrier", posted, postedTitles().size());
        assertEquals("the obligation is kept", 1, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        repository.replayPendingNotifications();
        assertEquals(posted, postedTitles().size());
        assertEquals(1, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));

        assertTrue(repository.saveRecognizedCarrier(repository.find(row.rowId), YTO));
        List<String> titles = postedTitles();
        assertEquals("the round that matches the carrier pushes the change", posted + 1, titles.size());
        assertDeliveryLive("圆通速递", "YT7700189063");
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
    }

    /**
     * Gap ①: the batch depth is per thread, so another thread's replay used to push what the sync thread had
     * committed before that round recognised the carrier.
     */
    @Test public void anotherThreadCannotPushARoundsNotificationBeforeItsCarrier() throws Exception {
        ExpressItem row = parcel("YT7700189064", StatusSemantic.TRANSIT, minutesAgo(120), "快件运输中");
        int posted = postedTitles().size();
        List<String> seenDuringRound = new ArrayList<>();
        repository.runInChangeBatch(() -> {
            try {
                parcel("YT7700189064", StatusSemantic.DELIVERY, minutesAgo(60), "快递员正在派送");
                Thread other = new Thread(repository::replayPendingNotifications);
                other.start();
                other.join();
                seenDuringRound.addAll(postedTitles());
                assertTrue(repository.saveRecognizedCarrier(repository.find(row.rowId), YTO));
            } catch (Exception failure) {
                throw new IllegalStateException(failure);
            }
        });
        assertEquals("nothing leaves before the carrier is matched", posted, seenDuringRound.size());
        List<String> titles = postedTitles();
        assertEquals(posted + 1, titles.size());
        assertDeliveryLive("圆通速递", "YT7700189064");
    }

    @Test public void carrierPendingFollowsWhatTheRowShows() {
        assertFalse("an unprojected order shows 京东购物", order("", "").carrierPending());
        assertTrue("a projected waybill without a carrier", order("YT1234567890123", "").carrierPending());
        assertTrue("the generic 快递", order("YT1234567890123", "快递").carrierPending());
        assertFalse(order("YT1234567890123", "YTO").carrierPending());
        assertFalse("a real name the page gave", order("YT1234567890123", "丰网速运").carrierPending());
        assertTrue("京东 is no carrier on a non-JD waybill (R-20)",
                order("YT1234567890123", "京东快递").carrierPending());
        assertTrue("a raw code the table cannot name", waybillRow("UNKNOWNCODE", "",
                CarrierNormalization.NONE).carrierPending());
        assertFalse("an upstream real name", waybillRow("", "某某物流",
                CarrierNormalization.NONE).carrierPending());
        assertFalse(waybillRow("YTO", "圆通速递", CarrierNormalization.NONE).carrierPending());
        assertFalse("Kuaidi100's off-table name (其余裁决 29)", waybillRow("UNKNOWNCODE", "",
                CarrierNormalization.offTable("某某速运", "moumou")).carrierPending());
    }

    /** 其余裁决 29: shown by the name Kuaidi100 gives, display only — raw tuple, icon and table untouched. */
    @Test public void anOffTableCarrierIsShownByTheNameKuaidi100Gives() throws Exception {
        ExpressItem row = parcel("MM7700189065", StatusSemantic.TRANSIT, minutesAgo(120), "快件运输中");
        parcel("MM7700189065", StatusSemantic.DELIVERY, minutesAgo(60), "快递员正在派送");
        int posted = postedTitles().size();
        assertTrue(repository.saveRecognizedCarrier(repository.find(row.rowId),
                CarrierNormalization.offTable("某某速运", "moumou")));
        ExpressItem shown = repository.find(row.rowId);
        assertEquals("某某速运", shown.displayCompany());
        assertEquals("UNKNOWNCODE", shown.courierCode);
        assertNull(shown.resolvedCarrier());
        assertEquals(R.drawable.ic_card_express_cp_default, shown.displayIconResource());
        assertNull("never added to the table", CarrierRegistry.resolveName("某某速运"));
        assertFalse(shown.carrierPending());
        List<String> titles = postedTitles();
        assertEquals(posted + 1, titles.size());
        assertDeliveryLive("某某速运", "MM7700189065");

        // A later list write whose Worker sidecar has no built-in answer keeps the name; a built-in answer
        // replaces it.
        parcel("MM7700189065", StatusSemantic.DELIVERY, minutesAgo(30), "快递员正在派送，请保持电话畅通",
                new CarrierNormalization("", "", "", false, "worker"));
        assertEquals("某某速运", repository.find(row.rowId).displayCompany());
        assertTrue(repository.saveRecognizedCarrier(repository.find(row.rowId), YTO));
        assertEquals("圆通速递", repository.find(row.rowId).displayCompany());
        assertFalse("an off-table name never replaces a built-in one", repository.saveRecognizedCarrier(
                repository.find(row.rowId), CarrierNormalization.offTable("某某速运", "moumou")));
    }

    /** Entries B/C/D: the waybill the order text names projects only once its carrier matched. */
    @Test public void orderTextProjectsOnlyWithAMatchedCarrier() throws Exception {
        // A picked order without its waybill reads 已下单; the projection turns it into 已揽件.
        ExpressItem order = listOrder("3630448013822301", StatusSemantic.PICKED,
                "您的订单由第三方卖家拣货完成，待出库交付申通快递，运单号为770018906334362");
        assertEquals(StatusSemantic.ORDERED, order.semantic);
        ExpressRepository.PendingProjection pending = repository.pendingProjection(order);
        assertNotNull(pending);
        assertEquals(ExpressRepository.PendingProjectionSource.FEED_TEXT, pending.source);
        assertEquals("770018906334362", pending.waybill);
        int posted = postedTitles().size();

        assertFalse(AccountCarrierRecognition.projectPending(repository, order, pending,
                waybill -> CarrierNormalization.NONE, null));
        ExpressItem kept = repository.find(order.rowId);
        assertEquals("the order stays as it was", "", kept.projectedWaybill);
        assertEquals("京东购物", kept.displayCompany());
        assertEquals(posted, postedTitles().size());
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
        assertNotNull("the waybill is still known for the next round", repository.pendingProjection(kept));

        assertTrue(AccountCarrierRecognition.projectPending(repository, kept,
                repository.pendingProjection(kept),
                waybill -> new CarrierNormalization("STO", "申通快递", "shentong", true, "t23"), null));
        ExpressItem projected = repository.find(order.rowId);
        assertEquals("770018906334362", projected.projectedWaybill);
        assertEquals("stored by its standard code (audit C6)", "STO", projected.projectedCompanyName);
        assertEquals("申通快递", projected.displayCompany());
        List<String> titles = postedTitles();
        assertEquals("the projection's status change is pushed with its carrier", posted + 1, titles.size());
        assertEquals("申通快递 4362 · 已揽件", titles.get(titles.size() - 1));
        assertNull(repository.pendingProjection(projected));
    }

    @Test public void projectionCarrierFollowsTheRecognitionChain() throws Exception {
        ExpressItem order = order("", "");
        AtomicInteger calls = new AtomicInteger();
        AccountCarrierRecognition.Recognizer counting = waybill -> {
            calls.incrementAndGet();
            return CarrierNormalization.NONE;
        };
        assertEquals("a table name the page gave", "中通快递", AccountCarrierRecognition.projectionCarrier(
                order, "75600000001844", "中通快递", counting));
        assertEquals(0, calls.get());
        assertEquals("ZTO", AccountCarrierRecognition.projectionCarrier(order, "75600000001844", "",
                waybill -> new CarrierNormalization("ZTO", "中通快递", "zhongtong", true, "t23")));
        assertNull("京东 on a non-JD waybill is no carrier", AccountCarrierRecognition.projectionCarrier(
                order, "75600000001844", "京东快递",
                waybill -> new CarrierNormalization("JD", "京东快递", "jd", true, "t23")));
        assertEquals("JD", AccountCarrierRecognition.projectionCarrier(order, "JDV000000001844", "",
                waybill -> new CarrierNormalization("JD", "京东快递", "jd", true, "t23")));
        assertEquals("a real name the page gave", "丰网速运", AccountCarrierRecognition.projectionCarrier(
                order, "75600000001844", "丰网速运", counting));
        assertEquals("Kuaidi100's off-table name", "某某速运", AccountCarrierRecognition.projectionCarrier(
                order, "75600000001844", "",
                waybill -> CarrierNormalization.offTable("某某速运", "moumou")));
        assertNull("a failed recognition keeps the order as it was", AccountCarrierRecognition
                .projectionCarrier(order, "75600000001844", "", waybill -> {
                    throw new IllegalStateException("unavailable");
                }));
        assertTrue(AccountCarrierRecognition.excludesJd(order, "75600000001844"));
        assertFalse(AccountCarrierRecognition.excludesJd(order, "JDV000000001844"));
    }

    /** Entry E: a v5_query reply whose text names the waybill saves unprojected until its carrier matches. */
    @Test public void aQueryReplyNamingTheWaybillWaitsForItsCarrier() throws Exception {
        ExpressItem order = listOrder("3630448013822302", StatusSemantic.TRANSIT, "您的订单已出库");
        String text = "您的订单由第三方卖家拣货完成，待出库交付极兔速递，运单号为JT4006839564547";
        String time = minutesAgo(90);
        ExpressQueryResult query = new ExpressQueryResult(order.waybill, "JD", "京东快递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(time), time,
                text, tracks(new String[][]{{time, text}}), "", PHONE,
                TimelineSlot.V5_QUERY, "", "", "JingDong");
        assertTrue(repository.saveInterface5Query(query, order,
                repository.bindingGeneration(PHONE, "interface5"), null));
        ExpressItem kept = repository.find(order.rowId);
        assertEquals("", kept.projectedWaybill);
        assertNotNull("the reply itself is saved", repository.accountTimeline(order.waybill, "interface5"));
        ExpressRepository.PendingProjection pending = repository.pendingProjection(kept);
        assertNotNull(pending);
        assertEquals(ExpressRepository.PendingProjectionSource.QUERY_TEXT, pending.source);
        assertEquals("JT4006839564547", pending.waybill);

        assertTrue(AccountCarrierRecognition.projectPending(repository, kept, pending,
                waybill -> new CarrierNormalization("JTSD", "极兔速递", "jtexpress", true, "t23"), null));
        ExpressItem projected = repository.find(order.rowId);
        assertEquals("JT4006839564547", projected.displayWaybill());
        assertEquals("极兔速递", projected.displayCompany());
        assertNotNull("both query keys, as the reply's own save", repository.accountTimeline(
                "JT4006839564547", "interface5"));
        assertEquals("quiet, as the query save was", 0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
    }

    /** Entry F: a union page whose carrier did not match is held, never lost and never shown. */
    @Test public void anUnmatchedUnionPageIsHeldAndLandsOnceItsCarrierMatches() throws Exception {
        ExpressItem order = listOrder("3630448013822303", StatusSemantic.TRANSIT, "您的订单已由快递揽收");
        String time = minutesAgo(50);
        ExpressQueryResult page = new ExpressQueryResult("YT1234567897051", "", "",
                StatusSemantic.UNKNOWN, 0L, time, "【上海市】快件已到达 上海转运中心",
                tracks(new String[][]{{time, "【上海市】快件已到达 上海转运中心"},
                        {minutesAgo(300), "【上海市】圆通速递 已揽收"}}),
                "", "", TimelineSlot.JD_H5, "", "", "");
        assertTrue(AccountCarrierRecognition.savePageCapture(repository, order,
                repository.captureManualQueryOwner(order), page, true,
                waybill -> CarrierNormalization.NONE, null));
        ExpressItem kept = repository.find(order.rowId);
        assertEquals("", kept.projectedWaybill);
        assertEquals("京东购物", kept.displayCompany());
        assertNull("the held package is not mixed into a slot",
                repository.manualTimelineCandidate(kept, TimelineSlot.JD_H5));
        assertEquals(1, count(ExpressDatabase.HELD_ORDER_PROJECTION_TABLE));
        ExpressRepository.PendingProjection pending = repository.pendingProjection(kept);
        assertNotNull(pending);
        assertEquals(ExpressRepository.PendingProjectionSource.HELD_PAGE, pending.source);
        assertEquals("YT1234567897051", pending.waybill);

        assertTrue(AccountCarrierRecognition.projectPending(repository, kept, pending,
                waybill -> YTO, null));
        ExpressItem projected = repository.find(order.rowId);
        assertEquals("YT1234567897051", projected.projectedWaybill);
        assertEquals("YTO", projected.projectedCompanyName);
        assertEquals("圆通速递", projected.displayCompany());
        assertNotNull("the held complete package lands through the page save",
                repository.manualTimelineCandidate(projected, TimelineSlot.JD_H5));
        assertEquals(0, count(ExpressDatabase.HELD_ORDER_PROJECTION_TABLE));
    }

    /** A projection that already shows no carrier (projected before T23) takes Kuaidi100's off-table name. */
    @Test public void aBlankProjectionTakesTheOffTableName() throws Exception {
        ExpressItem order = listOrder("3630448013822304", StatusSemantic.TRANSIT, "您的订单已出库");
        assertTrue(repository.saveOrderProjection(order, "interface5", "MM1234567897052", ""));
        ExpressItem blank = repository.find(order.rowId);
        assertTrue(blank.carrierPending());
        assertTrue(AccountCarrierRecognition.recognize(repository, blank,
                waybill -> CarrierNormalization.offTable("某某速运", "moumou")));
        ExpressItem named = repository.find(order.rowId);
        assertEquals("某某速运", named.displayCompany());
        assertFalse(named.carrierPending());
        assertTrue("a built-in answer still replaces it", AccountCarrierRecognition.recognize(
                repository, named, waybill -> YTO));
        assertEquals("圆通速递", repository.find(order.rowId).displayCompany());

        ExpressItem paged = listOrder("3630448013822306", StatusSemantic.TRANSIT, "您的订单已出库");
        assertTrue(repository.saveOrderProjection(paged, "interface5", "FW1234567897053", "丰网速运"));
        assertFalse("a name the page gave stays", AccountCarrierRecognition.recognize(repository,
                repository.find(paged.rowId), waybill -> CarrierNormalization.offTable("某某速运", "moumou")));
        assertEquals("丰网速运", repository.find(paged.rowId).displayCompany());
    }

    /** Audit C6 kept for T23's own projections: a recognized standard code is stored as that code. */
    @Test public void aRecognizedStandardCodeStaysACodeInTheProjection() throws Exception {
        ExpressItem order = listOrder("3630448013822305", StatusSemantic.TRANSIT, "您的订单已出库");
        assertTrue(repository.saveOrderProjection(order, "interface5", "BEST00000005482", "HTKY"));
        ExpressItem projected = repository.find(order.rowId);
        assertEquals("HTKY", projected.projectedCompanyName);
        assertEquals("HTKY", projected.resolvedCarrier().standardCode);
        assertEquals("huitongkuaidi", projected.displayCourierCode());
    }

    /** Entry G: a manual row recognises its carrier, and a later refresh without a built-in answer keeps it. */
    @Test public void aManualRowRecognisesItsCarrierAndKeepsIt() throws Exception {
        String waybill = "YT7700189066";
        ExpressItem manual = repository.saveManualQueryBatch(null, Collections.singletonList(
                new ManualQuerySuccess(TimelineSlot.V6_QUERY, manualResult(waybill,
                        StatusSemantic.TRANSIT, minutesAgo(120), "快件运输中"), 1_000L, false)),
                "", "interface5");
        assertNotNull(manual);
        assertTrue(manual.manuallyAdded);
        assertTrue(manual.carrierPending());
        assertTrue(AccountCarrierRecognition.needsRecognition(manual));
        assertTrue(AccountCarrierRecognition.recognize(repository, manual, number -> YTO));
        assertEquals("圆通速递", repository.find(manual.rowId).displayCompany());
        assertFalse(AccountCarrierRecognition.needsRecognition(repository.find(manual.rowId)));

        repository.saveManualQueryBatch(repository.find(manual.rowId),
                repository.captureManualQueryOwner(repository.find(manual.rowId)),
                Collections.singletonList(new ManualQuerySuccess(TimelineSlot.V6_QUERY,
                        manualResult(waybill, StatusSemantic.DELIVERY, minutesAgo(60), "快递员正在派送"),
                        2_000L, false)), "", "interface5");
        assertEquals("a Meizu round without a built-in answer keeps the recognised carrier",
                "圆通速递", repository.find(manual.rowId).displayCompany());
        repository.saveManualQueryResult(manualResult(waybill, StatusSemantic.DELIVERY,
                minutesAgo(30), "快递员正在派送，请保持电话畅通"), "", "interface5");
        assertEquals("圆通速递", repository.find(manual.rowId).displayCompany());
    }

    private ExpressItem parcel(String waybill, StatusSemantic semantic, String time, String detail)
            throws Exception {
        return parcel(waybill, semantic, time, detail, CarrierNormalization.NONE);
    }

    private ExpressItem parcel(String waybill, StatusSemantic semantic, String time, String detail,
            CarrierNormalization worker) throws Exception {
        repository.saveInterface5(new ExpressQueryResult(waybill, "UNKNOWNCODE", "",
                semantic, ExpressSourcePolicy.parseEventTime(time), time, detail,
                tracks(new String[][]{{time, detail}}), "", PHONE, "interface5", "", "", "")
                .withCarrierNormalization(worker), PHONE);
        ExpressItem row = repository.findByWaybill(waybill, "interface5");
        assertNotNull(row);
        return row;
    }

    private ExpressItem listOrder(String orderId, StatusSemantic semantic, String detail)
            throws Exception {
        String time = minutesAgo(100);
        long eventAt = ExpressSourcePolicy.parseEventTime(time);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(orderId, "JDKD", "京东商品快递",
                semantic, eventAt, time, detail, tracks(new String[][]{{time, detail}}),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(status("ORDER", semantic, eventAt)), PHONE);
        ExpressItem order = repository.findByWaybill(orderId, "interface5");
        assertNotNull(order);
        assertTrue(order.isAccountOrder());
        assertEquals("", order.projectedWaybill);
        return order;
    }

    private static ExpressQueryResult manualResult(
            String waybill, StatusSemantic semantic, String time, String detail) throws Exception {
        return new ExpressQueryResult(waybill, "", "", semantic, 0L, time, detail,
                tracks(new String[][]{{time, detail}}), "", "", TimelineSlot.V6_QUERY, "", "", "")
                .withManualStatusEvidence(semantic.label, true)
                .withCarrierNormalization(new CarrierNormalization("", "", "", false, "worker"));
    }

    private static ExpressItem order(String projectedWaybill, String projectedCompany) {
        return new ExpressItem(
                2L, "", "3630448013829999", "JDKD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单运输中",
                "2026-09-26 10:00:00", "[]", "", "I5-JD", "",
                1L, 2L, "I5-JD", "I5-JD", "v5",
                "https://example.jd.com/detail", true,
                projectedWaybill, projectedCompany, "[]", "JingDong");
    }

    private static ExpressItem waybillRow(String courierCode, String companyName,
            CarrierNormalization normalization) {
        return new ExpressItem(
                3L, "", "YT7700189099", courierCode, companyName,
                StatusSemantic.TRANSIT, "运输中", "快件运输中",
                "2026-09-26 10:00:00", "[]", "", "INTERFACE5", "",
                1L, 2L, "INTERFACE5", "", "", "", true,
                "", "", "[]", "", false, "", 0L, StatusSemantic.TRANSIT, normalization);
    }

    private void assertDeliveryLive(String company, String waybill) {
        List<Notification> posted = Shadows.shadowOf(context.getSystemService(NotificationManager.class)).getAllNotifications();
        Notification live = posted.stream().filter(n -> "express_live".equals(n.getChannelId())).findFirst().orElseThrow();
        assertEquals("派送中 1 件", live.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
        String body = live.extras.getCharSequence(Notification.EXTRA_BIG_TEXT).toString().replace("\u200B", "");
        assertTrue(body, body.startsWith(company + " · " + waybill));
        assertTrue(posted.stream().noneMatch(n -> "express_delivery".equals(n.getChannelId())));
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
