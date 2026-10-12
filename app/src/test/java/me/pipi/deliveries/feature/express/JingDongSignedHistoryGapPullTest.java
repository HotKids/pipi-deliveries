package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Activity;
import android.app.Application;
import android.content.Context;

import java.util.concurrent.ExecutorService;

import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.network.ExpressQueryCancellation;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/**
 * 2026-09-24：已签收缺口一次完成只放行一次。完成包在真正签收几个小时（自动确认收货可能是几天）之后才到，
 * 京粉页里最新的签收节点离完成时间超过半小时，详情一直判不完整；已经有一个在完成之后抓的京粉页包时，
 * 详情下拉不再开京粉页。走真实的详情下拉流程，数京粉页的抓取次数。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {SyntheticSecretBox.class, JingDongSignedHistoryGapPullTest.CaptureShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class JingDongSignedHistoryGapPullTest {
    private static final String PHONE = "13800005502";
    private static final String ORDER = "3999999100005502";
    private static final String WAYBILL = "JD9990000005502";
    private static final String ROUTE = "https://jingfen.jd.com/item?fixture=1907";
    private static final String COMPLETED_AT = at("2026-09-23 20:00:00");
    private static final String REVIEW = "您的订单" + ORDER
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
    private static final String SIGNED = "您的订单已送达至【家门口】，感谢您在京东购物，欢迎再次光临。";
    private static final String DELIVERING = "您的订单正在派送中，请您准备签收";
    private static final String PICKUP = "您的快件已由京东快递揽收完成";

    private Context context;
    private ExpressRepository repository;
    private ExpressDetailActivity activity;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("express_jd_h5_cooldown", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        CaptureShadow.calls = 0;
    }

    @After public void tearDown() throws Exception {
        ((ExecutorService) ReflectionHelpers.getField(activity, "worker")).shutdownNow();
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aPullWithoutAUnionPageStillOpensItOnce() throws Exception {
        ExpressItem owner = signedOrderCompletedHoursAfterTheSignature();
        pull(owner);
        assertEquals(1, CaptureShadow.calls);
    }

    @Test public void aUnionPageCapturedAfterTheCompletionIsNotReopenedByAPull() throws Exception {
        ExpressItem owner = signedOrderCompletedHoursAfterTheSignature();
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L,
                        at("2026-09-23 11:12:23"), SIGNED, tracks(new String[][]{
                                {at("2026-09-23 11:12:23"), SIGNED},
                                {at("2026-09-23 08:02:00"), DELIVERING},
                                {at("2026-09-22 21:48:11"), PICKUP}}),
                        "", "", TimelineSlot.JD_H5, "", "", ""), true));
        owner = repository.find(owner.rowId);
        assertTrue(repository.manualTimelineCandidate(owner, TimelineSlot.JD_H5).successAt
                >= owner.statusEventTime);
        assertFalse("the signature is hours before the completion, so the detail stays incomplete",
                ReflectionHelpers.<Boolean>callInstanceMethod(activity, "currentDetailComplete",
                        ClassParameter.from(ExpressItem.class, owner)));

        pull(owner);
        assertEquals(0, CaptureShadow.calls);
    }

    private void pull(ExpressItem owner) {
        ReflectionHelpers.callInstanceMethod(activity, "refreshAutomaticDetail",
                ClassParameter.from(ExpressRepository.class, repository),
                ClassParameter.from(ExpressItem.class, owner),
                ClassParameter.from(ExpressQueryCancellation.class, new ExpressQueryCancellation(1000L)),
                ClassParameter.from(boolean.class, true));
    }

    /** 已签收（结构化，完成时间比签收晚八个多小时）、已投影、feed 有揽收、带可信京粉页路由的订单行。 */
    private ExpressItem signedOrderCompletedHoursAfterTheSignature() throws Exception {
        long completedAt = ExpressTimeline.parseTime(COMPLETED_AT);
        String[][] nodes = {
                {COMPLETED_AT, REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}};
        ExpressQueryResult feed = new ExpressQueryResult(ORDER, "JD", "京东购物",
                StatusSemantic.COMPLETED, completedAt, COMPLETED_AT, REVIEW, tracks(nodes), ROUTE,
                PHONE, "interface5", "v5", ROUTE, "JingDong")
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject()
                        .put("normalizedStatus", new JSONObject().put("version", 1)
                                .put("scope", "ORDER").put("semantic", "COMPLETED")
                                .put("code", "SERVER_ENUM").put("text", "已完成").put("priority", 0)
                                .put("eventAtMs", completedAt).put("structured", true))));
        repository.saveInterface5OrderSummary(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveRecoveredOwnerRoute(owner, repository.captureManualQueryOwner(owner), feed));
        assertTrue(repository.saveOrderProjection(repository.find(owner.rowId), "interface5", WAYBILL, "京东快递"));
        owner = repository.find(owner.rowId);
        assertFalse(ExpressDetailActivity.safeOrderH5Url(owner).isEmpty());
        return owner;
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        }
        return value.toString();
    }

    @Implements(ExpressAutomaticTimelineCapture.class)
    public static class CaptureShadow {
        static int calls;

        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider,
                ExpressQueryCancellation cancellation) {
            calls++;
            return null;
        }
    }
}
