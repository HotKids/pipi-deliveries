package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import android.content.Context;

import com.google.android.material.progressindicator.LinearProgressIndicator;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
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
import org.robolectric.shadows.ShadowLog;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/**
 * The JD web-detail entry keeps its foreground v5 capability and shares the October 8 alignment
 * budget: unchanged groups retry at the ordinary interval, at most three times. Synthetic parcels
 * exercise the real detail-open path and count v5 requests.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = JingDongListDetailMismatchQueryTest.QueryShadow.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class JingDongListDetailMismatchQueryTest {
    private static final String PHONE = "13800005501";
    private static final String ORDER = "3999999100005501";
    private static final String WAYBILL = "JD9990000005501";
    private static final String PICKUP = "您的快件已由京东快递揽收完成";
    private static final String DELIVERING = "您的订单正在派送中，请您准备签收（快递员：测试员，电话：19900000000）";
    private static final String SIGNED = "您的订单已送达至【家门口有问题，联系快递员。】，快递员：测试员";
    private static final String REVIEW = "您的订单" + ORDER
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";

    private Context context;
    private ExpressRepository repository;
    private ExpressDetailActivity activity;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        QueryShadow.calls = 0;
        QueryShadow.fail = false;
    }

    @After public void tearDown() throws Exception {
        if (activity != null) {
            ((ExecutorService) ReflectionHelpers.getField(activity, "worker")).shutdownNow();
        }
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    /** A lagging union page queries v5 past its complete cache under the shared bounded retry record. */
    @Test public void aLaggingUnionPageRetriesWithoutUpdatesAtMostThreeTimes() throws Exception {
        ExpressItem owner = signedOrderWhoseUnionPageStopsBeforeTheSignature();
        assertTrue(ExpressDetailActivity.shouldSkipCompleteCache(owner,
                ReflectionHelpers.<Boolean>callInstanceMethod(activity(), "currentDetailComplete",
                        ClassParameter.from(ExpressItem.class, owner))));
        ExpressRepository.StatusAlignmentProbe probe = repository.statusAlignmentProbe(owner);
        assertNotNull(probe);
        assertTrue(probe.detailFromWebCapture);
        assertFalse(repository.signedFrozen(owner));

        open(owner);
        assertEquals("the lagging union page queries v5 once", 1, QueryShadow.calls);
        assertTrue(repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_DETAIL_WEB_LAG_QUERY).isEmpty());
        elapseRetryInterval(owner);
        open(repository.find(owner.rowId));
        assertEquals("no update leaves the entry retryable", 2, QueryShadow.calls);
        elapseRetryInterval(owner);
        open(repository.find(owner.rowId));
        assertEquals(3, QueryShadow.calls);
        open(repository.find(owner.rowId));
        assertEquals("at most three attempts for the same times", 3, QueryShadow.calls);

        // A later union page still stops more than five minutes before the signing: a new set of times, one more query.
        captureUnionPage(repository.find(owner.rowId), new String[][]{
                {at("2026-09-23 11:06:00"), "您的快件已签收，签收人：家门口（补录）"},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-23 07:23:00"), "您的订单已到达【测试城东站】"},
                {at("2026-09-22 22:12:48"), "您的订单已离开【测试城北三期接货仓】"},
                {at("2026-09-22 21:48:11"), PICKUP}});
        open(repository.find(owner.rowId));
        assertEquals("the times moved", 4, QueryShadow.calls);
        elapseRetryInterval(owner);
        open(repository.find(owner.rowId));
        assertEquals(5, QueryShadow.calls);
    }

    @Test public void immediateSameGroupReopeningDoesNotConsumeTheSecondOrThirdAttempt() throws Exception {
        ExpressItem owner = signedOrderWhoseUnionPageStopsBeforeTheSignature();
        open(owner);
        open(repository.find(owner.rowId));
        open(repository.find(owner.rowId));
        assertEquals("same-group detail retries use the ordinary interval", 1, QueryShadow.calls);
        assertEquals(1, new JSONObject(repository.ledgerValue(owner.rowId,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT)).getInt("attempts"));
    }

    /** A failed query consumes one attempt and stays retryable after the ordinary interval. */
    @Test public void aFailedQueryIsRetriedAfterTheOrdinaryInterval() throws Exception {
        ExpressItem owner = signedOrderWhoseUnionPageStopsBeforeTheSignature();
        QueryShadow.fail = true;
        open(owner, true);
        assertEquals(1, QueryShadow.calls);
        QueryShadow.fail = false;
        open(repository.find(owner.rowId));
        assertEquals("an immediate retry preserves the budget", 1, QueryShadow.calls);
        elapseRetryInterval(owner);
        open(repository.find(owner.rowId));
        assertEquals(2, QueryShadow.calls);
    }

    private void elapseRetryInterval(ExpressItem owner) throws Exception {
        JSONObject record = new JSONObject(repository.ledgerValue(owner.rowId,
                ExpressRepository.LEDGER_STATUS_ALIGNMENT));
        record.put("lastAt", System.currentTimeMillis() - 15L * 60_000L);
        repository.claimLedger(owner.rowId, ExpressRepository.LEDGER_STATUS_ALIGNMENT, record.toString());
    }

    /** A union page no more than five minutes behind the structured signing is not an entry query. */
    @Test public void aUnionPageWithinFiveMinutesOfTheSigningIsNotQueried() throws Exception {
        ExpressItem owner = signedOrder(new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 11:12:23"), SIGNED},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}});
        captureUnionPage(owner, new String[][]{
                {at("2026-09-23 11:08:00"), "您的快件已签收，签收人：家门口（补录）"},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-23 07:23:00"), "您的订单已到达【测试城东站】"},
                {at("2026-09-22 22:12:48"), "您的订单已离开【测试城北三期接货仓】"},
                {at("2026-09-22 21:48:11"), PICKUP}});
        owner = repository.find(owner.rowId);
        assertFalse(ExpressDetailActivity.claimWebLagEntryQuery(repository, owner));
        assertEquals("", repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_DETAIL_WEB_LAG_QUERY));
    }

    /**
     * 用户 2026-10-02「头条 状态 详情页 都推进到了签收状态…就冻结快递 后续不再进行任何刷新」，弹窗「按时间对齐」：feed
     * 没有评价，列表表头是 feed 的签收（11:12:23），详情排第一的是完成之后抓的京粉页（止于 11:08），两者都不早于完成时间
     * （11:12:27）五分钟以上，这一行冻结；两边仍差四分多钟（对不上），打开详情也不再查 v5，下拉也不开京粉页，只记
     * signed_frozen。
     */
    @Test public void aSignedFrozenRowDoesNotQueryOnAListDetailMismatch() throws Exception {
        ExpressItem owner = signedOrder(new String[][]{
                {at("2026-09-23 11:12:23"), SIGNED},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}});
        captureUnionPage(owner, new String[][]{
                {at("2026-09-23 11:08:00"), "您的快件已签收，签收人：家门口（补录）"},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-23 07:23:00"), "您的订单已到达【测试城东站】"},
                {at("2026-09-22 22:12:48"), "您的订单已离开【测试城北三期接货仓】"},
                {at("2026-09-22 21:48:11"), PICKUP}});
        owner = repository.find(owner.rowId);
        assertEquals(SIGNED, listed(owner).latestDetail);
        assertTrue(repository.signedFrozen(owner));
        ShadowLog.clear();

        open(owner);
        assertEquals("the frozen row asks nothing", 0, QueryShadow.calls);
        String logs = logs();
        assertTrue(logs, logs.contains("trigger=detail_open") && logs.contains("detail.refresh.skipped")
                && logs.contains("skipReason=signed_frozen"));

        // A pull is stopped at the same gate (no union page, no manual chain); the page keeps what is stored.
        ShadowLog.clear();
        ExpressDetailActivity detail = activity();
        ReflectionHelpers.setField(detail, "pullRefreshRequested", true);
        ReflectionHelpers.setField(detail, "localRefreshInFlight", false);
        ReflectionHelpers.setField(detail, "item", repository.find(owner.rowId));
        ReflectionHelpers.callInstanceMethod(detail, "refreshLocalTimelineInBackground",
                ClassParameter.from(boolean.class, false));
        ReflectionHelpers.<Future<?>>getField(detail, "localRefreshTask").get(5, TimeUnit.SECONDS);
        assertEquals(0, QueryShadow.calls);
        logs = logs();
        assertTrue(logs, logs.contains("trigger=detail_pull") && logs.contains("skipReason=signed_frozen"));
        assertFalse("no stage starts (no union page, no Picker)", logs.contains("detail.refresh.stage_started"));
    }

    private static String logs() {
        StringBuilder logs = new StringBuilder();
        for (ShadowLog.LogItem item : ShadowLog.getLogsForTag("PipiExpress")) logs.append(item.msg).append('\n');
        return logs.toString();
    }

    private ExpressItem listed(ExpressItem owner) {
        for (ExpressItem item : repository.listVisibleAsStored("interface5")) {
            if (item.rowId == owner.rowId) return item;
        }
        throw new AssertionError("the row is not listed");
    }

    private void open(ExpressItem owner) throws Exception {
        open(owner, false);
    }

    private void open(ExpressItem owner, boolean queryFails) throws Exception {
        ExpressDetailActivity detail = activity();
        ReflectionHelpers.setField(detail, "item", owner);
        ReflectionHelpers.setField(detail, "detailEntryObserved", false);
        ReflectionHelpers.setField(detail, "pullRefreshRequested", false);
        ReflectionHelpers.setField(detail, "localRefreshInFlight", false);
        ReflectionHelpers.setField(detail, "localRefreshFailed", false);
        ReflectionHelpers.callInstanceMethod(detail, "refreshLocalTimelineInBackground",
                ClassParameter.from(boolean.class, false));
        Future<?> task = ReflectionHelpers.getField(detail, "localRefreshTask");
        assertNotNull(task);
        task.get(5, TimeUnit.SECONDS);
        assertEquals(queryFails, ReflectionHelpers.<Boolean>getField(detail, "localRefreshFailed"));
    }

    private ExpressDetailActivity activity() {
        if (activity == null) {
            activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
            activity.setTheme(R.style.AppTheme);
            ReflectionHelpers.setField(activity, "nativeProgress", new LinearProgressIndicator(activity));
        }
        return activity;
    }

    /**
     * 签收冻结的行：feed 自己带签收（11:12:23）；完整的京粉页包把签收记在几分钟前（11:05）、节点更多，排在详情第一。
     * 列表表头是 feed 的签收，详情最新是 11:05，两边差七分钟。
     */
    private ExpressItem signedOrderWhoseUnionPageStopsBeforeTheSignature() throws Exception {
        long completedAt = ExpressTimeline.parseTime(at("2026-09-23 11:12:27"));
        String[][] feed = {
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 11:12:23"), SIGNED},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}};
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JD", "京东快递",
                StatusSemantic.COMPLETED, completedAt, feed[0][0], feed[0][1], tracks(feed),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, completedAt)), PHONE);
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        owner = repository.find(owner.rowId);
        captureUnionPage(owner, new String[][]{
                {at("2026-09-23 11:05:00"), "您的快件已签收，签收人：家门口"},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-23 07:23:00"), "您的订单已到达【测试城东站】"},
                {at("2026-09-22 22:12:48"), "您的订单已离开【测试城北三期接货仓】"},
                {at("2026-09-22 21:48:11"), PICKUP}});
        return repository.find(owner.rowId);
    }

    /** 同一张订单（结构化签收于 11:12:27、已投影出运单号），feed 就是 {@code feed}，还没有京粉页。 */
    private ExpressItem signedOrder(String[][] feed) throws Exception {
        long completedAt = ExpressTimeline.parseTime(at("2026-09-23 11:12:27"));
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JD", "京东快递",
                StatusSemantic.COMPLETED, completedAt, feed[0][0], feed[0][1], tracks(feed),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, completedAt)), PHONE);
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        return repository.find(owner.rowId);
    }

    private void captureUnionPage(ExpressItem owner, String[][] nodes) throws Exception {
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L,
                        nodes[0][0], nodes[0][1], tracks(nodes), "", "", TimelineSlot.JD_H5, "", "", ""),
                true));
    }

    private static WorkerStatusProjection structured(StatusSemantic semantic, long eventAt) throws Exception {
        return WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "ORDER").put("semantic", semantic.name())
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

    @Implements(value = ExpressDiscoveryClient.class, isInAndroidSdk = false)
    public static class QueryShadow {
        static volatile int calls;
        static volatile boolean fail;

        @Implementation protected ExpressQueryResult refreshKnown(Context ignored,
                ExpressItem owner, boolean force, ExpressQueryCancellation cancellation) throws Exception {
            calls++;
            if (fail) throw new java.io.IOException("offline");
            return null;
        }
    }
}
