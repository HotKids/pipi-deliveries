package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Looper;

import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressOrderProjectionIdentity;
import me.pipi.deliveries.data.ExpressRepository;
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
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.RealObject;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;
import org.robolectric.util.ReflectionHelpers.ClassParameter;

/**
 * 用户 2026-09-25 同意（方案 A，三端同一口径，iOS empty-union-page.test.ts）：已完成订单的京粉页一旦确认是空壳，就
 * 记住这一单，不再重试——首页在屏幕上那一轮、后台轮次、进详情取号都不再开（连先发的 v5_query 也不发）。「确认」=
 * 同一单两次空壳、后一次距上一次至少一个京粉页冷却（10 分钟），不到 10 分钟的又一次只挪动那一次；抓到带物流的东西
 * 才清零（接口只回了不带物流的应答照样是空壳，见 JingDongEmptyShellDetectionTest）；风控既不算也不清；非已完成
 * 订单从不记。起因是 Pixel 上没有商品的赠品单 4421：京粉页加载完却什么都没有，首页每 10 分钟重试一次、每次还先查
 * 一遍 v5。可同一轮里 5251 也是空壳，十几分钟后却抓到了，所以一次空壳不算数。走真实的首页抓取与进详情流程，只把
 * 京粉页本身换成给定的结果。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {SyntheticSecretBox.class, JingDongEmptyOrderPageTest.QueryShadow.class,
                JingDongEmptyOrderPageTest.CaptureShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class JingDongEmptyOrderPageTest {
    private static final String PHONE = "13800004421";
    private static final String GIFT = "350000004421";
    private static final String ROUTE = "https://jingfen.jd.com/item?fixture=4421";
    private static final long TEN_MINUTES = 10L * 60L * 1000L;
    private static final String COMPLETED_AT = at("2026-09-20 10:00:00");
    private static final String GIFT_REVIEW = "您的订单" + GIFT
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";

    private Context context;
    private ExpressRepository repository;
    private ExpressDetailActivity detail;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        cooldowns().edit().clear().commit();
        emptyPages().edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        QueryShadow.calls = 0;
        CaptureShadow.pages = 0;
        CaptureShadow.result = null;
    }

    @After public void tearDown() throws Exception {
        if (detail != null) ((ExecutorService) ReflectionHelpers.getField(detail, "worker")).shutdownNow();
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void oneEmptyPageIsStillRetriedAfterTheCooldown() throws Exception {
        ExpressItem gift = giftOrder();
        assertTrue(home(gift, empty()));
        assertEquals(1, CaptureShadow.pages);
        assertFalse("one empty page proves nothing", confirmed(gift));

        expireCooldown();
        assertTrue("Home opens it again", home(gift, empty()));
        assertEquals(2, CaptureShadow.pages);
        assertEquals(2, QueryShadow.calls);
        expireCooldown();
        enterDetail(gift, empty());
        assertEquals("so does the detail entry", 3, CaptureShadow.pages);
        assertFalse("less than ten minutes after the first empty page", confirmed(gift));
    }

    @Test public void twoEmptyPagesTenMinutesApartAreNeverReopened() throws Exception {
        ExpressItem gift = giftOrder();
        assertTrue(home(gift, empty()));
        rewindFirstEmptyPage(gift, TEN_MINUTES);
        expireCooldown();
        assertTrue(home(gift, empty()));
        assertTrue(confirmed(gift));
        assertEquals(2, CaptureShadow.pages);
        assertEquals(2, QueryShadow.calls);

        expireCooldown();
        assertFalse("Home never reopens it", home(gift, empty()));
        assertEquals(2, CaptureShadow.pages);
        assertEquals("nor queries v5 for it first", 2, QueryShadow.calls);
        enterDetail(gift, empty());
        assertEquals("the detail entry does not reopen it", 2, CaptureShadow.pages);
        assertEquals("the detail keeps its own v5 query", 3, QueryShadow.calls);
    }

    @Test public void theDetailEntryCountsItsOwnEmptyPages() throws Exception {
        ExpressItem gift = giftOrder();
        enterDetail(gift, empty());
        rewindFirstEmptyPage(gift, TEN_MINUTES);
        expireCooldown();
        enterDetail(gift, empty());
        assertEquals(2, CaptureShadow.pages);
        assertTrue(confirmed(gift));

        expireCooldown();
        enterDetail(gift, empty());
        assertFalse(home(gift, empty()));
        assertEquals(2, CaptureShadow.pages);
    }

    @Test public void aLogisticsCaptureResetsTheCount() throws Exception {
        ExpressItem gift = giftOrder();
        assertTrue(home(gift, empty()));
        rewindFirstEmptyPage(gift, TEN_MINUTES + 60_000L);
        expireCooldown();
        assertTrue(home(gift, logistics()));
        assertTrue("captured logistics forget the earlier empty page", emptyPages().getAll().isEmpty());

        expireCooldown();
        assertTrue(home(gift, empty()));
        assertFalse("counting starts again after the capture", confirmed(gift));
        expireCooldown();
        assertTrue(home(gift, empty()));
        assertEquals(4, CaptureShadow.pages);

        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(context);
        long now = System.currentTimeMillis();
        retries.recordPage(gift, empty(), now + TEN_MINUTES);
        assertTrue(confirmed(gift));
        retries.recordPage(gift, new ExpressAutomaticTimelineCapture.Result(new ExpressQueryResult(
                "YT0000000004421", "YTO", "圆通速递", StatusSemantic.UNKNOWN, 0L,
                COMPLETED_AT, "您的快件已签收", "[]", "", "", "jd_h5", "", "", "JingDong"),
                false, false), now + 2L * TEN_MINUTES);
        assertFalse("a captured package (a waybill) clears even a confirmed mark", confirmed(gift));

        retries.recordPage(gift, empty(), now + 3L * TEN_MINUTES);
        retries.recordPage(gift, empty(), now + 4L * TEN_MINUTES);
        assertTrue(confirmed(gift));
        retries.recordPage(gift, new ExpressAutomaticTimelineCapture.Result(
                null, false, true, false, false, true), now + 5L * TEN_MINUTES);
        assertFalse("logistics captured on a risk-controlled page still clear the mark", confirmed(gift));
    }

    /** 与 iOS nextEmptyShellStrikes 同口径：后一次空壳离上一次不到 10 分钟，只把这一次挪到新的时间。 */
    @Test public void aSecondEmptyPageInsideTheRestOnlyMovesTheStrike() throws Exception {
        ExpressItem gift = giftOrder();
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(context);
        long first = System.currentTimeMillis();
        retries.recordPage(gift, empty(), first);
        retries.recordPage(gift, empty(), first + 5L * 60_000L);
        retries.recordPage(gift, empty(), first + 12L * 60_000L);
        assertFalse("twelve minutes after the first strike but seven after the latest", confirmed(gift));
        retries.recordPage(gift, empty(), first + 22L * 60_000L);
        assertTrue("ten minutes after the latest strike", confirmed(gift));
    }

    /** 与 iOS 同口径：这一单已不是已完成、没有运单号的订单时，它的任何京粉页结果都清掉之前的空壳次数。 */
    @Test public void aResultForAnOrderNoLongerCompletedClearsItsStrike() throws Exception {
        ExpressItem gift = giftOrder();
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(context);
        long first = System.currentTimeMillis();
        retries.recordPage(gift, empty(), first);
        assertFalse(emptyPages().getAll().isEmpty());
        ExpressItem reopened = new ExpressItem(gift.rowId, PHONE, GIFT, "JDKD", "京东商品快递",
                StatusSemantic.DELIVERY, "派送中", "您的订单正在派送中", COMPLETED_AT, "[]", "", "I5-JD", "",
                gift.statusEventTime, gift.updatedAt, "I5-JD", "", "v5", ROUTE, true, "", "", "[]", "JingDong");
        retries.recordPage(reopened, riskControl(), first + TEN_MINUTES);
        assertTrue(emptyPages().getAll().isEmpty());
        retries.recordPage(gift, empty(), first + 2L * TEN_MINUTES);
        assertFalse("the next empty page is a first strike again", confirmed(gift));
    }

    @Test public void aNonCompletedOrderIsNeverMarked() throws Exception {
        ExpressItem delivering = order("350000005251", StatusSemantic.DELIVERY, new String[][]{
                {at("2026-09-20 08:00:00"), "您的订单正在派送中，请您准备签收"}});
        assertTrue(home(delivering, empty()));
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(context);
        long now = System.currentTimeMillis();
        retries.recordPage(delivering, empty(), now + TEN_MINUTES);
        retries.recordPage(delivering, empty(), now + 3L * TEN_MINUTES);
        assertFalse(confirmed(delivering));
        assertTrue(emptyPages().getAll().isEmpty());

        expireCooldown();
        assertTrue(home(delivering, empty()));
        assertEquals(2, CaptureShadow.pages);
    }

    @Test public void riskControlNeitherCountsNorResets() throws Exception {
        ExpressItem gift = giftOrder();
        assertTrue(home(gift, empty()));
        rewindFirstEmptyPage(gift, TEN_MINUTES);
        String key = ExpressOrderProjectionIdentity.orderHash(GIFT);
        long strike = emptyPages().getLong(key, 0L);
        expireCooldown();
        assertTrue(home(gift, riskControl()));
        assertFalse("risk control confirms nothing", confirmed(gift));
        assertEquals("and does not reset the strike", strike, emptyPages().getLong(key, 0L));
        assertFalse("risk control still rests the order for an hour",
                new ExpressOrderProjectionRetryStore(context).timelineAttemptDue(
                        gift, System.currentTimeMillis() + TEN_MINUTES + 1L));

        expireCooldown();
        assertTrue(home(gift, empty()));
        assertTrue("the strike from before the risk control confirms with the next empty page", confirmed(gift));
    }

    /**
     * 用户 2026-09-25 补充：union 请求出错（非 2xx 或网络失败）与风控一样，既不算空壳也不清零。京东两次故障隔 10 分钟
     * 不能把真订单记成空壳（方案 B 会把它藏起来）。
     */
    @Test public void aUnionErrorNeitherCountsNorResets() throws Exception {
        ExpressItem gift = giftOrder();
        for (int outage = 0; outage < 2; outage++) {
            expireCooldown();
            assertTrue(home(gift, unionError()));
        }
        assertTrue("two outages ten minutes apart mark nothing", emptyPages().getAll().isEmpty());

        expireCooldown();
        assertTrue(home(gift, empty()));
        rewindFirstEmptyPage(gift, TEN_MINUTES);
        String key = ExpressOrderProjectionIdentity.orderHash(GIFT);
        long strike = emptyPages().getLong(key, 0L);
        expireCooldown();
        assertTrue(home(gift, unionError()));
        assertFalse(confirmed(gift));
        assertEquals("an outage keeps the earlier strike", strike, emptyPages().getLong(key, 0L));
        expireCooldown();
        assertTrue(home(gift, empty()));
        assertTrue("the strike from before the outage confirms with the next empty page", confirmed(gift));
    }

    /** 后台轮次只开有揽收的单；已完成的单只要确认空壳也一样跳过。 */
    @Test public void backgroundRoundsSkipAConfirmedEmptyOrder() throws Exception {
        ExpressItem picked = order("350000006100", StatusSemantic.COMPLETED, new String[][]{
                {COMPLETED_AT, "您的订单350000006100已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。"},
                {at("2026-09-19 09:00:00"), "【上海市】圆通速递 已揽收"}});
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(context);
        assertEquals(Arrays.asList(picked), ExpressBackgroundOrderProjection.dueCandidates(
                Arrays.asList(picked), retries, System.currentTimeMillis()));
        long now = System.currentTimeMillis();
        retries.recordPage(picked, empty(), now - 2L * TEN_MINUTES);
        retries.recordPage(picked, empty(), now - TEN_MINUTES);
        assertTrue(confirmed(picked));
        assertTrue(ExpressBackgroundOrderProjection.dueCandidates(
                Arrays.asList(picked), retries, now).isEmpty());
    }

    /** 记号只按订单号哈希存（与京粉页冷却同一个键），不存订单号本身（AGENTS §9）。 */
    @Test public void theMarkIsKeptOnlyUnderTheOrderHash() throws Exception {
        ExpressItem gift = giftOrder();
        assertTrue(home(gift, empty()));
        Map<String, ?> marks = emptyPages().getAll();
        assertEquals(1, marks.size());
        String key = marks.keySet().iterator().next();
        assertTrue(key.matches("[0-9a-f]{64}"));
        assertEquals(ExpressOrderProjectionIdentity.orderHash(GIFT), key);
        assertEquals("the same key as the union page cooldown", cooldowns().getAll().keySet(), marks.keySet());
        assertFalse(String.valueOf(marks.get(key)).contains(GIFT));
    }

    private static ExpressAutomaticTimelineCapture.Result empty() {
        return new ExpressAutomaticTimelineCapture.Result(null, false, false, false, true, false);
    }

    /** A page that captured something logistics-bearing without a usable package (tracks, nodes, a waybill). */
    private static ExpressAutomaticTimelineCapture.Result logistics() {
        return new ExpressAutomaticTimelineCapture.Result(null, false, false, false, false, true);
    }

    /**
     * What the capture delivers when a union request failed (non-2xx or a network failure) and nothing
     * else happened: no result, neither empty nor logistics (see JingDongEmptyShellDetectionTest).
     */
    private static ExpressAutomaticTimelineCapture.Result unionError() {
        return null;
    }

    /** What the capture reports for a risk-control reply: throttled, not empty, no logistics. */
    private static ExpressAutomaticTimelineCapture.Result riskControl() {
        return new ExpressAutomaticTimelineCapture.Result(null, false, true, false, false, false);
    }

    private boolean confirmed(ExpressItem order) {
        return new ExpressOrderProjectionRetryStore(context).pageConfirmedEmpty(repository.find(order.rowId));
    }

    /** Home's own capture with a Home host; returns whether it opened the page. */
    private boolean home(ExpressItem order, ExpressAutomaticTimelineCapture.Result page) throws Exception {
        CaptureShadow.result = page;
        int pagesBefore = CaptureShadow.pages;
        Activity host = Robolectric.buildActivity(Activity.class).setup().get();
        boolean[] finished = {false};
        ExpressHomeOrderProjectionCapture capture = new ExpressHomeOrderProjectionCapture(
                host, repository.find(order.rowId), (ignored, saved) -> finished[0] = true);
        try {
            if (!capture.start()) return false;
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (System.nanoTime() < until && !finished[0]) {
                Thread.sleep(10);
                Shadows.shadowOf(Looper.getMainLooper()).idle();
            }
            assertTrue("the Home capture finishes", finished[0]);
            return CaptureShadow.pages > pagesBefore;
        } finally {
            capture.cancel();
            host.finish();
        }
    }

    /** Opening the detail page (not a pull): its forced v5 query, then the identity capture. */
    private void enterDetail(ExpressItem order, ExpressAutomaticTimelineCapture.Result page) {
        CaptureShadow.result = page;
        if (detail == null) detail = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        ReflectionHelpers.callInstanceMethod(detail, "refreshAutomaticDetail",
                ClassParameter.from(ExpressRepository.class, repository),
                ClassParameter.from(ExpressItem.class, repository.find(order.rowId)),
                ClassParameter.from(ExpressQueryCancellation.class, new ExpressQueryCancellation(5_000L)),
                ClassParameter.from(boolean.class, false),
                ClassParameter.from(boolean.class, false));
    }

    /** The ten-minute union page cooldown is over. */
    private void expireCooldown() {
        cooldowns().edit().clear().commit();
    }

    /** The first empty page was seen {@code ms} earlier than recorded. */
    private void rewindFirstEmptyPage(ExpressItem order, long ms) {
        String key = ExpressOrderProjectionIdentity.orderHash(order.waybill);
        long first = emptyPages().getLong(key, 0L);
        assertTrue("one empty page is on record", first > 0L);
        emptyPages().edit().putLong(key, first - ms).commit();
    }

    private SharedPreferences cooldowns() {
        return context.getSharedPreferences("express_jd_h5_cooldown", 0);
    }

    private SharedPreferences emptyPages() {
        return context.getSharedPreferences("express_jd_h5_empty_page", 0);
    }

    /** A completed no-item gift order whose only node is JD's completion/review text. */
    private ExpressItem giftOrder() throws Exception {
        return order(GIFT, StatusSemantic.COMPLETED, new String[][]{{COMPLETED_AT, GIFT_REVIEW}});
    }

    /** An unprojected Interface-5 JD order with a structured status and its own union page route. */
    private ExpressItem order(String orderId, StatusSemantic semantic, String[][] nodes) throws Exception {
        long eventAt = ExpressTimeline.parseTime(nodes[0][0]);
        ExpressQueryResult feed = new ExpressQueryResult(orderId, "JDKD", "京东商品快递",
                semantic, eventAt, nodes[0][0], nodes[0][1], tracks(nodes), ROUTE,
                PHONE, "interface5", "v5", ROUTE, "JingDong")
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject()
                        .put("normalizedStatus", new JSONObject().put("version", 1)
                                .put("scope", "ORDER").put("semantic", semantic.name())
                                .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                                .put("eventAtMs", eventAt).put("structured", true))));
        repository.saveInterface5OrderSummary(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(orderId, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveRecoveredOwnerRoute(owner, repository.captureManualQueryOwner(owner), feed));
        owner = repository.find(owner.rowId);
        assertEquals(semantic, owner.semantic);
        assertTrue(owner.projectedWaybill.isEmpty());
        assertFalse(ExpressDetailActivity.safeOrderH5Url(owner).isEmpty());
        assertTrue("Home's on-screen gate lets it through",
                ExpressHomeOrderProjectionCapture.needsProjection(owner, true));
        return owner;
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

        @Implementation protected ExpressQueryResult refreshKnown(Context ignored,
                ExpressItem owner, boolean force, ExpressQueryCancellation cancellation) {
            calls++;
            return null;
        }
    }

    /** The union page itself: Home's capture answers at once, the detail's blocking capture returns it. */
    @Implements(value = ExpressAutomaticTimelineCapture.class, isInAndroidSdk = false)
    public static class CaptureShadow {
        static volatile int pages;
        static volatile ExpressAutomaticTimelineCapture.Result result;
        @RealObject private ExpressAutomaticTimelineCapture capture;

        @Implementation protected void start() {
            pages++;
            ExpressAutomaticTimelineCapture.Callback callback = ReflectionHelpers.getField(capture, "callback");
            callback.complete(result);
        }

        @Implementation protected void cancel() {}

        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider,
                ExpressQueryCancellation cancellation) {
            pages++;
            return result;
        }
    }
}
