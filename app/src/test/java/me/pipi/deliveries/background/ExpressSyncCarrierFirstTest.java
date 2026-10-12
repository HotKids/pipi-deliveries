package me.pipi.deliveries.background;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;

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
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;

/**
 * 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28）入口 B：同步轮读到订单文案给出的运单号，先识别承运商，对上才投影并
 * 推送；这一轮对不上，订单行仍是「京东购物 · 已下单」、不推，下一轮再补识别，识别出来那一轮再推。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class, shadows = {
        ExpressSyncCarrierFirstTest.Discovery.class, ExpressSyncCarrierFirstTest.Api.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressSyncCarrierFirstTest {
    private static final String PHONE = "13900002323";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    private Context context;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String name : new String[]{"deliveries_repository_migrations", "express_account_source",
                "express_network_success"}) {
            context.getSharedPreferences(name, 0).edit().clear().commit();
        }
        context.getSharedPreferences("express_account_source", 0).edit()
                .putString("active_interface", "v5").commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        context.getSystemService(NotificationManager.class).cancelAll();
        Api.calls.set(0);
        Api.answer = CarrierNormalization.NONE;
    }

    @After public void tearDown() {
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aSyncRoundProjectsOrderTextOnlyWithAMatchedCarrier() throws Exception {
        String text = "您的订单由第三方卖家拣货完成，待出库交付申通快递，运单号为770018906334362";
        String time = TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - 90L * 60_000L));
        long eventAt = ExpressTimeline.parseTime(time);
        repository.saveInterface5OrderSummary(new ExpressQueryResult("3630448013822501", "JDKD",
                "京东商品快递", StatusSemantic.PICKED, eventAt, time, text,
                new JSONArray().put(new JSONObject().put("time", time).put("context", text)).toString(),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject().put("normalizedStatus",
                        new JSONObject().put("version", 1).put("scope", "ORDER")
                                .put("semantic", "PICKED").put("code", "SERVER_ENUM")
                                .put("text", "已揽件").put("priority", 0)
                                .put("eventAtMs", eventAt).put("structured", true)))), PHONE);
        ExpressItem order = repository.findByWaybill("3630448013822501", "interface5");
        assertEquals("", order.projectedWaybill);

        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        ExpressItem kept = repository.find(order.rowId);
        assertTrue("the round asked for the carrier", Api.calls.get() > 0);
        assertEquals("unmatched: the order stays as it was", "", kept.projectedWaybill);
        assertEquals("京东购物", kept.displayCompany());
        assertEquals(StatusSemantic.ORDERED, kept.semantic);
        assertTrue(postedTitles().isEmpty());

        Api.answer = new CarrierNormalization("STO", "申通快递", "shentong", true, "t23");
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        ExpressItem projected = repository.find(order.rowId);
        assertEquals("770018906334362", projected.projectedWaybill);
        assertEquals("申通快递", projected.displayCompany());
        assertEquals(List.of("申通快递 4362 · 已揽件"), postedTitles());
    }

    /** 其余裁决 32: at the terminal verdict the round releases the order, shown by its raw code. */
    @Test public void aSyncRoundReleasesAnExhaustedOrderWithItsRawCode() throws Exception {
        String text = "您的订单由第三方卖家拣货完成，待出库交付申通快递，运单号为770018906334372";
        String time = TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - 90L * 60_000L));
        long eventAt = ExpressTimeline.parseTime(time);
        repository.saveInterface5OrderSummary(new ExpressQueryResult("3630448013822502", "JDKD",
                "京东商品快递", StatusSemantic.PICKED, eventAt, time, text,
                new JSONArray().put(new JSONObject().put("time", time).put("context", text)).toString(),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject().put("normalizedStatus",
                        new JSONObject().put("version", 1).put("scope", "ORDER")
                                .put("semantic", "PICKED").put("code", "SERVER_ENUM")
                                .put("text", "已揽件").put("priority", 0)
                                .put("eventAtMs", eventAt).put("structured", true)))), PHONE);
        ExpressItem order = repository.findByWaybill("3630448013822502", "interface5");
        Api.answer = CarrierNormalization.exhausted();
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, false, "background");
        ExpressItem projected = repository.find(order.rowId);
        assertEquals("770018906334372", projected.projectedWaybill);
        assertEquals("JDKD", projected.displayCompany());
        assertEquals(List.of("JDKD 4372 · 已揽件"), postedTitles());
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

    @Implements(value = ExpressDiscoveryClient.class, isInAndroidSdk = false)
    public static class Discovery {
        @Implementation protected int sync(Context ignored, List<String> phones, boolean userPull) {
            return 0;
        }

        @Implementation protected boolean wasSynced(String waybill) {
            return true;
        }

        @Implementation protected Map<String, Set<String>> syncedWaybillsByGeneration() {
            return Collections.emptyMap();
        }
    }

    @Implements(value = ExpressApi.class, isInAndroidSdk = false)
    public static class Api {
        static final AtomicInteger calls = new AtomicInteger();
        static volatile CarrierNormalization answer = CarrierNormalization.NONE;

        @Implementation protected void __constructor__(Context ignored) {}

        @Implementation protected CarrierNormalization recognizeCarrier(
                String waybill, ExpressQueryCancellation cancellation) {
            calls.incrementAndGet();
            return answer;
        }

        @Implementation protected CarrierNormalization recognizeCarrier(
                String waybill, ExpressQueryCancellation cancellation, boolean excludeJd) {
            calls.incrementAndGet();
            return answer;
        }

        /** The sync round's own call (用户 2026-09-27 提交前核对答复四), answered the same way. */
        @Implementation protected CarrierNormalization recognizeCarrierInSyncRound(
                String waybill, boolean excludeJd) {
            calls.incrementAndGet();
            return answer;
        }
    }
}
