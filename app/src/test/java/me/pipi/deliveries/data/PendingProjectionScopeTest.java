package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.concurrent.atomic.AtomicInteger;

import me.pipi.deliveries.background.AccountCarrierRecognition;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

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
 * Who takes a waybill itself (AGENTS §9「谁需要自己取运单号」, user 2026-09-26): only Xiaomi (interface 5) JD
 * orders — a third-party seller order from its track text, a JD-operated one from the union page. Every other
 * source is left alone.
 *
 * <p>The first three tests are migrated from {@code ExpressSyncEngineTest}'s tests of
 * {@code ExpressSyncEngine.textProjectionIdentity}, which the assistant deleted as a cleanup once T23 left it
 * without a production caller (not a user decision); the same cases now run on
 * {@link ExpressRepository#pendingProjection}, the path the sync round, Home and detail use. Their expectations
 * are unchanged.</p>
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class PendingProjectionScopeTest {
    private static final String PHONE = "13800004545";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private static final String NAMED = "[{\"time\":\"2026-09-06 11:24:29\",\"context\":"
            + "\"待出库交付申通快递，运单号为770018906334362\"}]";

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

    /** Migrated: backgroundSyncReadsTheWaybillNamedByOrderTrackText. */
    @Test public void theWaybillNamedByOrderTrackTextIsRead() {
        String tracks = "[{\"time\":\"2026-09-06 11:24:29\",\"context\":"
                + "\"您的订单由第三方卖家拣货完成，待出库交付申通快递，运单号为770018906334362\"},"
                + "{\"time\":\"2026-09-06 00:19:43\",\"context\":\"预计9月6日发货\"}]";
        ExpressRepository.PendingProjection pending = repository.pendingProjection(
                order("I5-JD", "JingDong", "", StatusSemantic.PICKED, tracks));
        // 只取运单号（用户 2026-09-26，其余裁决 7）；「交付申通快递」不再当承运商。
        assertEquals("770018906334362", pending.waybill);
        assertEquals("", pending.offeredName);
        assertEquals(ExpressRepository.PendingProjectionSource.FEED_TEXT, pending.source);
    }

    /** Migrated: textProjectionIgnoresStatusAndNeverRepeatsOrLeavesAccountOrders. */
    @Test public void textIdentityIgnoresStatusAndNeverRepeatsOrLeavesAccountOrders() {
        // A returned waybill is identity evidence even before pickup.
        assertEquals("770018906334362", repository.pendingProjection(
                order("I5-JD", "JingDong", "", StatusSemantic.ORDERED, NAMED)).waybill);
        assertEquals("770018906334362", repository.pendingProjection(
                order("I5-JD", "JingDong", "", StatusSemantic.SHIPPED, NAMED)).waybill);
        // An already projected order keeps its projection.
        assertNull(repository.pendingProjection(
                order("I5-JD", "JingDong", "770018906334362", StatusSemantic.PICKED, NAMED)));
        // Text that names no waybill projects nothing.
        assertNull(repository.pendingProjection(order("I5-JD", "JingDong", "", StatusSemantic.PICKED,
                "[{\"context\":\"已揽收\"}]")));
        // A plain carrier waybill row is not an account order.
        assertNull(repository.pendingProjection(new ExpressItem(
                1L, "", "TEST123456", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "运输中", "快件运输中",
                "2026-08-24 10:00:00", NAMED, "", "INTERFACE5", "",
                1L, 2L, "INTERFACE5", "", "", "", true,
                "", "", "", "")));
        assertNull(repository.pendingProjection(null));
    }

    /** Migrated: orderTextProjectionIsExclusiveToInterface5. */
    @Test public void orderTextIdentityIsExclusiveToInterface5() {
        assertNull(repository.pendingProjection(order("I6-JD", "JingDong", "", StatusSemantic.PICKED, NAMED)));
        assertEquals("770018906334362", repository.pendingProjection(
                order("I5-JD", "JingDong", "", StatusSemantic.PICKED, NAMED)).waybill);
    }

    /** New (AGENTS §9): an interface-5 order row whose source is not JD takes no waybill from its text. */
    @Test public void aNonJdOrderRowTakesNoWaybillFromItsText() throws Exception {
        assertNull(repository.pendingProjection(order("I5-JD", "CaiNiao", "", StatusSemantic.PICKED, NAMED)));
        ExpressItem stored = listOrder("3630448013824501", "CaiNiao", "您的订单已出库");
        AtomicInteger asked = new AtomicInteger();
        assertNull(AccountCarrierRecognition.queryTextCarrier(stored, query(stored, NAMED), waybill -> {
            asked.incrementAndGet();
            return new CarrierNormalization("STO", "申通快递", "shentong", true, "t23d");
        }));
        assertEquals(0, asked.get());
        assertTrue(repository.saveInterface5Query(query(stored, NAMED), stored,
                repository.bindingGeneration(PHONE, "interface5"), "STO"));
        assertEquals("the reply is saved but projects nothing", "",
                repository.find(stored.rowId).projectedWaybill);
        assertNotNull(repository.accountTimeline(stored.waybill, "interface5"));
        assertNull(repository.pendingProjection(repository.find(stored.rowId)));

        ExpressItem jd = listOrder("3630448013824502", "JingDong", "您的订单已出库");
        assertTrue(repository.saveInterface5Query(query(jd, NAMED), jd,
                repository.bindingGeneration(PHONE, "interface5"), "STO"));
        assertEquals("770018906334362", repository.find(jd.rowId).projectedWaybill);
    }

    /** New (AGENTS §9): a Cainiao page never projects a waybill onto an interface-5 order row. */
    @Test public void aCainiaoPageNeverProjectsAnOrderRow() throws Exception {
        ExpressItem order = listOrder("3630448013824503", "CaiNiao", "您的订单已出库");
        assertTrue(order.isCainiaoSource());
        AtomicInteger asked = new AtomicInteger();
        assertFalse(AccountCarrierRecognition.savePageCapture(repository, order,
                repository.captureManualQueryOwner(order), page("YT1234567894503", TimelineSlot.CN_H5), true,
                waybill -> {
                    asked.incrementAndGet();
                    return new CarrierNormalization("YTO", "圆通速递", "yuantong", true, "t23d");
                }, null));
        assertEquals("no recognition is spent on it", 0, asked.get());
        assertFalse(repository.saveAutomaticDetailTimeline(order,
                repository.captureManualQueryOwner(order), page("YT1234567894503", TimelineSlot.CN_H5), true));
        assertEquals("", repository.find(order.rowId).projectedWaybill);
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE));
    }

    /**
     * User 2026-09-27, list item X1:「菜鸟不是会直接返回运单号吗 当然要补轨迹啊」. The Cainiao page of an unprojected
     * interface-5 Cainiao-source order row supplements its timeline: the package is kept in the row's own cn_h5
     * slot. It still projects no waybill (AGENTS §9, user 2026-09-26). The page is built the way
     * {@code ExpressCainiaoTimelineParser} builds it, under the row's own displayed identity.
     */
    @Test public void aCainiaoPageKeepsItsTimelineOnAnUnprojectedOrderRowWithoutProjecting() throws Exception {
        ExpressItem order = listOrder("3630448013824504", "CaiNiao", "您的订单已出库");
        ExpressQueryResult feed = repository.automaticSourceTimeline(order);
        AtomicInteger asked = new AtomicInteger();
        assertTrue(AccountCarrierRecognition.savePageCapture(repository, order,
                repository.captureManualQueryOwner(order), page(order.displayWaybill(), TimelineSlot.CN_H5), true,
                waybill -> {
                    asked.incrementAndGet();
                    return new CarrierNormalization("YTO", "圆通速递", "yuantong", true, "x1");
                }, null));
        assertEquals("no recognition is spent on it", 0, asked.get());
        ManualTimelineAuthorityPolicy.Candidate kept =
                repository.manualTimelineCandidate(order, TimelineSlot.CN_H5);
        assertNotNull("the page timeline is kept", kept);
        assertTrue(kept.result.tracksJson.contains("快件已到达 上海转运中心"));
        ExpressItem after = repository.find(order.rowId);
        assertEquals("the page projects nothing", "", after.projectedWaybill);
        assertEquals(order.waybill, after.displayWaybill());
        assertEquals(feed.tracksJson, repository.automaticSourceTimeline(after).tracksJson);
        assertEquals(0, count(ExpressDatabase.ORDER_PROJECTION_TABLE));
        assertEquals(0, count(ExpressDatabase.HELD_ORDER_PROJECTION_TABLE));
        assertEquals(0, count(ExpressDatabase.NOTIFICATION_OUTBOX_TABLE));
    }

    private ExpressItem listOrder(String orderId, String provider, String detail) throws Exception {
        String time = TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - 100L * 60_000L));
        repository.saveInterface5OrderSummary(new ExpressQueryResult(orderId, "JDKD", "京东商品快递",
                StatusSemantic.PICKED, ExpressSourcePolicy.parseEventTime(time), time, detail,
                new JSONArray().put(new JSONObject().put("time", time).put("context", detail)).toString(),
                "", PHONE, "interface5", "", "", provider), PHONE);
        ExpressItem order = repository.findByWaybill(orderId, "interface5");
        assertNotNull(order);
        assertTrue(order.isAccountOrder());
        assertEquals(provider, order.sourceProvider);
        return order;
    }

    private static ExpressQueryResult query(ExpressItem owner, String tracks) {
        String time = TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - 90L * 60_000L));
        return new ExpressQueryResult(owner.waybill, "JD", "京东快递", StatusSemantic.PICKED,
                ExpressSourcePolicy.parseEventTime(time), time, "运单号为770018906334362", tracks, "",
                PHONE, TimelineSlot.V5_QUERY, "", "", owner.sourceProvider);
    }

    private static ExpressQueryResult page(String waybill, String provider) {
        String time = TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - 50L * 60_000L));
        return new ExpressQueryResult(waybill, "", "", StatusSemantic.UNKNOWN, 0L, time,
                "【上海市】快件已到达 上海转运中心",
                "[{\"time\":\"" + time + "\",\"context\":\"【上海市】快件已到达 上海转运中心\"}]",
                "", "", provider, "", "", "");
    }

    private static ExpressItem order(String owner, String provider, String projectedWaybill,
            StatusSemantic semantic, String tracksJson) {
        return new ExpressItem(
                4L, "", "3613448003874424", "JD", "京东购物",
                semantic, semantic.label, "订单进行中",
                "2026-09-06 11:24:29", tracksJson, "", owner, "",
                1L, 2L, owner, owner, "I6-JD".equals(owner) ? "v6" : "v5",
                "https://example.jd.com/detail", true,
                projectedWaybill, "", "[]", provider);
    }

    private int count(String table) {
        try (android.database.Cursor cursor = database.getReadableDatabase().query(
                table, null, null, null, null, null, null)) {
            return cursor.getCount();
        }
    }
}
