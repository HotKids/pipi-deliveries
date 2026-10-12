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
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
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
 * 用户 2026-09-27「这个已完成只能当作临时轨迹」：京东评价节点留作第一条签收时，完整、完整缓存、进详情的 v5 查询和签收
 * 缺口都不算它，与之前评价被删时一样。真机的形状（v5_list 结构化签收、没有带时间的节点；v5_query 到 16:16:18 派送中，
 * 另有 17:52:33 的评价）：只有评价过了完成时间，详情判为不完整，下拉放行京粉页；拿掉评价后也到了签收（完成之后抓的
 * 京粉页 17:52:30 已送达）就按完整缓存，不再开。走真实的详情下拉流程，数京粉页的抓取次数。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {SyntheticSecretBox.class, JingDongKeptReviewSignedGapTest.CaptureShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class JingDongKeptReviewSignedGapTest {
    private static final String PHONE = "13800000001";
    private static final String ORDER = "3999999000000001";
    private static final String WAYBILL = "JD9990000000001";
    private static final String ROUTE = "https://jingfen.jd.com/item?fixture=9001";
    private static final String REVIEW = "您的订单" + ORDER
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
    private static final String REVIEW_AT = at("2026-09-23 17:52:33");
    private static final String[][] QUERY_NODES = {
            {REVIEW_AT, REVIEW},
            {at("2026-09-23 16:16:18"), "您的快件正在派送中，请您准备签收"},
            {at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】"},
            {at("2026-09-22 10:10:13"), "您的快件已由京东快递揽收完成"}};

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

    @Test public void onlyTheKeptReviewReachesTheSigningSoAPullOpensTheUnionPage() throws Exception {
        ExpressItem owner = signedOrderWithAKeptReview();
        ExpressQueryResult account = repository.automaticSourceTimeline(owner);
        ManualTimelineAuthorityPolicy.Candidate selected = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(selected);
        assertTrue("the displayed package keeps the review", selected.result.tracksJson.contains("期待您"));
        assertFalse("the kept review does not complete the history",
                ExpressDetailActivity.currentDetailComplete(owner, account, selected));
        assertFalse(ExpressDetailActivity.shouldSkipCompleteCache(owner, false));
        pull(owner);
        assertEquals(1, CaptureShadow.calls);
    }

    @Test public void aSignedHistoryWithoutTheReviewServesTheCompleteCache() throws Exception {
        ExpressItem owner = signedOrderWithAKeptReview();
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L,
                        at("2026-09-23 17:52:30"), "您的订单已送达至【家门口】",
                        tracks(new String[][]{{at("2026-09-23 17:52:30"), "您的订单已送达至【家门口】"},
                                QUERY_NODES[1], QUERY_NODES[2], QUERY_NODES[3]}),
                        "", "", TimelineSlot.JD_H5, "", "", ""), true));
        owner = repository.find(owner.rowId);
        assertTrue(ExpressDetailActivity.currentDetailComplete(owner,
                repository.automaticSourceTimeline(owner), repository.manualDetailTimelineAuthority(owner)));
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

    /** 已签收（结构化，就是评价的时间）、已投影、带可信京粉页路由的订单行；v5_query 里评价留作第一条签收。 */
    private ExpressItem signedOrderWithAKeptReview() throws Exception {
        long completedAt = ExpressTimeline.parseTime(REVIEW_AT);
        ExpressQueryResult feed = new ExpressQueryResult(ORDER, "JD", "京东购物",
                StatusSemantic.COMPLETED, completedAt, REVIEW_AT, REVIEW, "[]", ROUTE,
                PHONE, "interface5", "v5", ROUTE, "JingDong").withWorkerStatus(status(completedAt));
        repository.saveInterface5OrderSummary(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveRecoveredOwnerRoute(owner, repository.captureManualQueryOwner(owner), feed));
        assertTrue(repository.saveOrderProjection(repository.find(owner.rowId), "interface5", WAYBILL, "京东快递"));
        owner = repository.find(owner.rowId);
        assertTrue(repository.saveInterface5Query(new ExpressQueryResult(ORDER, "JD", "京东快递",
                        StatusSemantic.COMPLETED, completedAt, REVIEW_AT, REVIEW, tracks(QUERY_NODES), "",
                        PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong").withWorkerStatus(status(completedAt)),
                owner, repository.bindingGeneration(PHONE, "interface5")));
        owner = repository.find(owner.rowId);
        assertTrue(repository.accountTimeline(WAYBILL, "interface5").tracksJson.contains("期待您"));
        assertFalse(ExpressDetailActivity.safeOrderH5Url(owner).isEmpty());
        return owner;
    }

    private static WorkerStatusProjection status(long completedAt) throws Exception {
        return WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "ORDER").put("semantic", "COMPLETED")
                        .put("code", "SERVER_ENUM").put("text", "已完成").put("priority", 0)
                        .put("eventAtMs", completedAt).put("structured", true)));
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1])
                    .put("_pipiStatusSource", "interface5"));
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
