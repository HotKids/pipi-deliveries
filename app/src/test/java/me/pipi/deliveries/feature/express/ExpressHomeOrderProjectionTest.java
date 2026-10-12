package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;
import android.app.Activity;
import android.content.Context;
import android.os.Looper;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Robolectric;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.RealObject;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {ExpressHomeOrderProjectionTest.QueryShadow.class,
                ExpressHomeOrderProjectionTest.CaptureShadow.class,
                ExpressHomeOrderProjectionTest.CarrierShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressHomeOrderProjectionTest {
    private static final String ROUTE_A = "https://order.jd.com/detail?token=a";
    private static final String ROUTE_ROTATED = "https://order.jd.com/detail?token=b";
    private static final long NOW = 1_000_000L;
    private static final long TEN_MINUTES = 10L * 60L * 1000L;
    private ExpressOrderProjectionRetryStore retries;
    private Context context;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("express_jd_h5_cooldown", 0).edit().clear().commit();
        retries = new ExpressOrderProjectionRetryStore(context);
        CaptureShadow.result = null;
        CarrierShadow.calls = 0;
        CarrierShadow.waybill = null;
    }

    @Test public void onlyUnresolvedInterface5OrdersWithAnAvailableRouteAreEligible() {
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(
                order(1L, "I5-JD", "", true, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(2L, "I6-JD", "", true, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(3L, "I5-JD", "JDWAYBILL123", true, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(4L, "I5-JD", "", false, ROUTE_A)));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                order(5L, "I5-JD", "", true, "")));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(normalShipment()));
    }

    /**
     * 2026-09-24：京东列表只给最新一条「派送中」、没有揽收字样时，首页从来投影不出运单号，只能靠
     * 详情页下拉。结构化状态已经过了揽收就该放行；已下单、已发货不算揽收，已签收的老单照旧只认文字。
     */
    @Test public void aStructuredPostPickupOrderIsEligibleWithoutPickupText() throws Exception {
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(
                structuredOrder(StatusSemantic.DELIVERY, "您的订单正在派送中，请您准备签收")));
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(
                structuredOrder(StatusSemantic.TRANSIT, "您的订单已到达【测试城东站】")));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                structuredOrder(StatusSemantic.ORDERED, "您提交了订单，请等待系统确认")));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                structuredOrder(StatusSemantic.SHIPPED, "您的订单已出库")));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(
                structuredOrder(StatusSemantic.COMPLETED, "您的订单已完成")));
    }

    /**
     * 用户 2026-09-25 同意：首页在屏幕上时，已完成、还没运单号的订单也取一次号（真实运单号出来了就不该再停在
     * 「京东购物 + 订单号」）；后台轮次与离屏抓取照旧只认揽收。
     */
    @Test public void aCompletedOrderIsProjectedOnlyFromTheHomeScreen() throws Exception {
        ExpressItem completed = structuredOrder(StatusSemantic.COMPLETED,
                "您的订单已完成，感谢您对京东的支持，欢迎再次光临");
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(completed, true));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(completed, false));
        assertSame("the Home queue offers it", completed,
                ExpressListActivity.nextOrderProjectionCandidate(Arrays.asList(completed), new HashSet<>()));
        assertTrue("the background round does not",
                ExpressBackgroundOrderProjection.dueCandidates(Arrays.asList(completed), retries, NOW).isEmpty());
        assertFalse("an off-window capture refuses it", ExpressHomeOrderProjectionCapture.offWindow(
                context, completed, (ignored, saved) -> { }).start());
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        ExpressHomeOrderProjectionCapture onScreen = new ExpressHomeOrderProjectionCapture(
                activity, completed, (ignored, saved) -> { });
        try {
            assertTrue("the Home capture starts it", onScreen.start());
        } finally {
            onScreen.cancel();
        }
    }

    /** 2026-09-24：未投影订单的列表行把结构化「已揽收」压成了「已下单」，门看的是 feed 自己的 sourceSemantic。 */
    @Test public void aStructuredPickupCountsThoughTheListShowsItAsOrdered() throws Exception {
        withRepository("13800000924", repository -> {
            ExpressItem picked = listedOrder(repository, "13800000924", "3630448013820001",
                    StatusSemantic.PICKED, "2026-09-24 07:58:14", "您的订单已出库");
            assertEquals("the list shows an unprojected pickup as ordered",
                    StatusSemantic.ORDERED, picked.semantic);
            assertTrue(ExpressHomeOrderProjectionCapture.structurallyPastPickup(picked));
        });
    }

    /**
     * 审计 L8（用户 2026-09-25 采纳）：门读的是存盘那一行降级前的 Worker 状态。feed 自己给了结构化「已揽收」，之后更新的
     * v5_query 把列表状态接管成「运输中」，门照样认 feed 的揽收（原来接管后挂的状态与 sourceSemantic 对不上就不认，
     * 平行文档 2026-09-24 记为已知差异）。
     */
    @Test public void aFeedPickupStillOpensTheHomeGateAfterAQueryTakesOverTheList() throws Exception {
        String phone = "13800000926";
        withRepository(phone, repository -> {
            String order = "3630448013820003";
            ExpressItem picked = listedOrder(repository, phone, order,
                    StatusSemantic.PICKED, "2026-09-24 07:58:14", "您的订单已出库");
            assertTrue(ExpressHomeOrderProjectionCapture.structurallyPastPickup(picked));
            long queriedAt = me.pipi.deliveries.model.ExpressTimeline.parseTime("2026-09-24 09:10:00");
            assertTrue(repository.saveInterface5Query(new ExpressQueryResult(order, "JD", "京东快递",
                    StatusSemantic.TRANSIT, queriedAt, "2026-09-24 09:10:00", "您的订单已到达【测试城东站】",
                    new org.json.JSONArray().put(new org.json.JSONObject()
                            .put("time", "2026-09-24 09:10:00").put("context", "您的订单已到达【测试城东站】"))
                            .toString(), "", phone, "v5_query", "", "", "JingDong")
                    .withWorkerStatus(structuredStatus(StatusSemantic.TRANSIT, queriedAt)),
                    picked, repository.bindingGeneration(phone, "interface5")));
            ExpressItem takenOver = listed(repository, picked.rowId);
            assertEquals("the list takes the newer query status", StatusSemantic.TRANSIT, takenOver.semantic);
            assertTrue("the feed's own structured pickup still counts",
                    ExpressHomeOrderProjectionCapture.structurallyPastPickup(takenOver));
        });
    }

    /** v5_query 经 restoreAccountActivity 接管来的「运输中」不算（与 iOS jingDongOrderPastPickup 同口径）。 */
    @Test public void aQueryStatusTakenOverByTheListDoesNotOpenTheHomeGate() throws Exception {
        String phone = "13800000925";
        withRepository(phone, repository -> {
            String order = "3630448013820002";
            ExpressItem ordered = listedOrder(repository, phone, order,
                    StatusSemantic.ORDERED, "2026-09-24 07:58:14", "您提交了订单，请等待系统确认");
            assertFalse(ExpressHomeOrderProjectionCapture.structurallyPastPickup(ordered));
            long queriedAt = me.pipi.deliveries.model.ExpressTimeline.parseTime("2026-09-24 09:10:00");
            assertTrue(repository.saveInterface5Query(new ExpressQueryResult(order, "JD", "京东快递",
                    StatusSemantic.TRANSIT, queriedAt, "2026-09-24 09:10:00", "您的订单已到达【测试城东站】",
                    new org.json.JSONArray().put(new org.json.JSONObject()
                            .put("time", "2026-09-24 09:10:00").put("context", "您的订单已到达【测试城东站】"))
                            .toString(), "", phone, "v5_query", "", "", "JingDong")
                    .withWorkerStatus(structuredStatus(StatusSemantic.TRANSIT, queriedAt)),
                    ordered, repository.bindingGeneration(phone, "interface5")));
            ExpressItem takenOver = listed(repository, ordered.rowId);
            assertEquals("the list takes the newer query status", StatusSemantic.TRANSIT, takenOver.semantic);
            assertFalse(ExpressHomeOrderProjectionCapture.structurallyPastPickup(takenOver));
        });
    }

    /**
     * 首页每次 onStart、同步结束都清空「已试过」；冷却（与详情共用的京粉页冷却）没到的单，强制 v5_query 和
     * 京粉页都不能发。
     */
    @Test public void aCoolingOrderIssuesNeitherTheForcedQueryNorTheUnionPage() throws Exception {
        context.deleteDatabase(ExpressDatabase.DATABASE);
        java.lang.reflect.Field singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, null);
        ExpressRepository repository = ExpressRepository.get(context);
        String phone = "13800000001";
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5OrderSummary(new ExpressQueryResult("JDORDERHOME002", "JD", "京东购物",
                StatusSemantic.TRANSIT, 0L, "2026-09-09 09:00:00", "已揽收",
                "[{\"time\":\"2026-09-09 09:00:00\",\"context\":\"已揽收\"}]", "", phone,
                "v5_query", "", "", "JingDong"), phone);
        ExpressItem stored = repository.findByWaybill("JDORDERHOME002", "interface5");
        assertNotNull(stored);
        ExpressItem source = new ExpressItem(stored.rowId, phone, stored.waybill,
                stored.courierCode, stored.companyName, stored.semantic, stored.statusDescription,
                stored.latestDetail, stored.latestTime, stored.tracksJson, "", stored.source,
                "", 0L, stored.updatedAt, stored.stateOwner, "", "v5", ROUTE_A, true,
                "", "", "[]", "JingDong");
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(source));
        ExpressOrderProjectionRetryStore.AttemptToken earlier =
                retries.beginAttempt(source, System.currentTimeMillis());
        assertNotNull(earlier);
        retries.endAttempt(earlier);
        QueryShadow.result = null;
        QueryShadow.calls = 0;
        QueryShadow.waiting = null;
        CaptureShadow.starts = 0;
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        ExpressHomeOrderProjectionCapture capture = new ExpressHomeOrderProjectionCapture(
                activity, source, (ignored, saved) -> { });
        try {
            assertFalse(capture.start());
            Thread.sleep(50);
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals(0, QueryShadow.calls);
            assertEquals(0, CaptureShadow.starts);
            ExpressOrderProjectionRetryStore.AttemptToken lease =
                    ExpressOrderProjectionRetryStore.acquireAttempt(source);
            assertNotNull("a skipped start holds no lease", lease);
            retries.endAttempt(lease);
        } finally {
            capture.cancel();
            activity.finish();
            singleton.set(null, null);
            java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
            helper.setAccessible(true);
            ((ExpressDatabase) helper.get(repository)).close();
        }
    }

    @Test public void unpickedHomeOrdersWaitWhileDetailStillAllowsIdentityCapture() {
        for (String detail : new String[]{"已下单", "正在打包", "等待揽收", "预计明天送达"}) {
            ExpressItem item = orderWithIdentity(1L, "I5-JD", "JDORDER1", "", true,
                    ROUTE_A, "[{\"time\":\"2026-08-22 10:00:00\",\"context\":\"" + detail + "\"}]");
            assertFalse(detail, ExpressHomeOrderProjectionCapture.needsProjection(item));
            assertTrue(detail, ExpressDetailActivity.allowsJingDongCapture(item));
            assertNull(retries.beginAttempt(item, NOW));
        }
    }

    @Test public void textIdentityDoesNotRequirePickupOrAReadyH5Route() {
        ExpressItem item = orderWithIdentity(1L, "I5-JD", "JDORDER1", "", false, "",
                "[{\"time\":\"2026-08-22 10:00:00\",\"context\":\"待出库交付中通快递，运单号为 75600000001844\"}]");
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(item));
        assertEquals(item, ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(item), new HashSet<>()));
        assertTrue(context.getSharedPreferences("express_jd_h5_cooldown", 0).getAll().isEmpty());
    }

    @Test public void homeQueueIsFifoAndAttemptsEachRowOncePerBatch() {
        ExpressItem first = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressItem second = order(2L, "I5-JD", "", true, ROUTE_A);
        Set<String> attempted = new HashSet<>();
        assertEquals(first, ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(first, first, second), attempted));
        assertEquals(second, ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(first, first, second), attempted));
        assertNull(ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(first, first, second), attempted));
    }

    /**
     * Audit R10 (user 2026-09-25): 「Lite 首页取号的日志没有 trigger 和 flowId」. A Home pass logs its
     * flow and trigger, as iOS logs its Home projection (flow home-projection-…, trigger home_projection).
     */
    @Test public void theHomePassNamesItsFlowAndTrigger() {
        org.robolectric.shadows.ShadowLog.clear();
        ExpressItem waiting = order(1L, "I5-JD", "", false, "");
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(waiting, true));
        assertNull(ExpressListActivity.nextOrderProjectionCandidate(
                Arrays.asList(waiting), new HashSet<>(), "home-projection-test"));
        java.util.List<String> lines = org.robolectric.shadows.ShadowLog.getLogsForTag(
                me.pipi.deliveries.network.ExpressLog.TAG).stream().map(row -> row.msg)
                .filter(line -> line.contains(" skipReason=projection_prerequisite "))
                .collect(java.util.stream.Collectors.toList());
        assertEquals(lines.toString(), 1, lines.size());
        assertTrue(lines.get(0), lines.get(0).endsWith(
                " flowId=home-projection-test trigger=home_projection"));
    }

    /** One Home pass is one flow: the pass hands its flow to the capture it starts. */
    @Test public void theHomePassHandsItsFlowToItsCapture() throws Exception {
        java.nio.file.Path path = java.nio.file.Path.of(
                "app/src/main/java/me/pipi/deliveries/feature/express/ExpressListActivity.java");
        if (!java.nio.file.Files.isRegularFile(path)) path = java.nio.file.Path.of(
                "src/main/java/me/pipi/deliveries/feature/express/ExpressListActivity.java");
        String source = java.nio.file.Files.readString(path, java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(source.contains("String flowId = ExpressHomeOrderProjectionCapture.homeFlowId();"));
        assertTrue(source.contains("items, attemptedOrderProjections, flowId)) != null) {"));
        assertTrue(source.contains("this, candidate, this::onOrderProjectionCaptureFinished, flowId);"));
    }

    @Test public void releasingOrCancellingAnAttemptKeepsItsTenMinuteCooldown() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken first = retries.beginAttempt(item, NOW);
        assertNotNull(first);
        retries.endAttempt(first);
        assertNull(retries.beginAttempt(item, NOW + TEN_MINUTES - 1L));
        ExpressOrderProjectionRetryStore.AttemptToken next = retries.beginAttempt(item, NOW + TEN_MINUTES);
        assertNotNull(next);
        retries.endAttempt(next);
    }

    @Test public void detailAndHomeShareCooldownAndRouteChangesDoNotBypassIt() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken home = retries.beginAttempt(item, NOW);
        assertNotNull(home);
        retries.endAttempt(home);
        ExpressItem projected = order(1L, "I5-JD", "JDREAL123456", true, ROUTE_ROTATED);
        assertNull(retries.beginTimelineAttempt(projected, NOW + 1L));
        assertNull(retries.beginTimelineAttempt(
                order(1L, "I5-JD", "", true, "https://wqs.jd.com/other"), NOW + 1L));
        ExpressOrderProjectionRetryStore.AttemptToken detail =
                retries.beginTimelineAttempt(projected, NOW + TEN_MINUTES);
        assertNotNull(detail);
        retries.endAttempt(detail);
        assertNull(retries.beginAttempt(item, NOW + TEN_MINUTES + 1L));
    }

    @Test public void rateControlExtendsTheSameOrderToSixtyMinutes() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken token = retries.beginAttempt(item, NOW);
        assertNotNull(token);
        retries.recordTimelineRateLimit(item, NOW + 1_000L);
        retries.endAttempt(token);
        assertNull(retries.beginTimelineAttempt(item, NOW + TEN_MINUTES));
        long until = NOW + 1_000L + 60L * 60L * 1000L;
        assertNull(retries.beginTimelineAttempt(item, until - 1L));
        ExpressOrderProjectionRetryStore.AttemptToken next = retries.beginTimelineAttempt(item, until);
        assertNotNull(next);
        retries.endAttempt(next);
    }

    @Test public void anActiveAttemptAndAStaleReleaseCannotAllowASecondCapture() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken first = retries.beginAttempt(item, NOW);
        assertNotNull(first);
        assertNull(retries.beginTimelineAttempt(item, NOW + TEN_MINUTES));
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(first));
        ExpressOrderProjectionRetryStore.AttemptToken current =
                retries.beginTimelineAttempt(item, NOW + TEN_MINUTES);
        assertNotNull(current);
        assertFalse(ExpressOrderProjectionRetryStore.releaseAttempt(first));
        assertNull(ExpressOrderProjectionRetryStore.acquireAttempt(item));
        assertTrue(ExpressOrderProjectionRetryStore.releaseAttempt(current));
    }

    @Test public void feedTextProjectionCanAcquireTheLeaseWithoutOpeningH5() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken h5 = retries.beginAttempt(item, NOW);
        assertNotNull(h5);
        retries.endAttempt(h5);
        assertNull(retries.beginAttempt(item, NOW + 1L));
        ExpressOrderProjectionRetryStore.AttemptToken text =
                ExpressOrderProjectionRetryStore.acquireAttempt(item);
        assertNotNull(text);
        retries.endAttempt(text);
        assertNull(retries.beginAttempt(item, NOW + 2L));
    }

    @Test public void cooldownKeysContainOnlyTheOrderHash() {
        ExpressItem item = order(1L, "I5-JD", "", true, ROUTE_A);
        ExpressOrderProjectionRetryStore.AttemptToken token = retries.beginAttempt(item, NOW);
        assertNotNull(token);
        retries.endAttempt(token);
        Set<String> keys = context.getSharedPreferences("express_jd_h5_cooldown", 0).getAll().keySet();
        assertEquals(1, keys.size());
        assertTrue(keys.iterator().next().matches("[0-9a-f]{64}"));
    }

    @Test public void interface6CannotOpenTheAutomaticTimelineCapture() {
        ExpressItem unsupported = order(1L, "I6-JD", "", true, ROUTE_A);
        assertNull(retries.beginAttempt(unsupported, NOW));
        assertNull(retries.beginTimelineAttempt(unsupported, NOW));
    }

    @Test public void timedAccountQueryDoesNotBlockMissingIdentityH5() throws Exception {
        verifyHomeQuery(true, false);
    }

    @Test public void emptyAccountQueryStillAllowsH5AndOnlyThenStartsCooldown() throws Exception {
        verifyHomeQuery(false, false);
    }

    @Test public void closingHomeDuringAccountQueryDoesNotOpenH5OrConsumeCooldown() throws Exception {
        verifyHomeQuery(false, true);
    }

    @Test public void homeH5RecognizesAnUnnamedProjectedCarrierBeforeCompleting() throws Exception {
        context.deleteDatabase(ExpressDatabase.DATABASE);
        java.lang.reflect.Field singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, null);
        ExpressRepository repository = ExpressRepository.get(context);
        String phone = "13800000001";
        repository.bindPhoneLocally(phone, "interface5");
        repository.saveInterface5OrderSummary(new ExpressQueryResult(
                "1234500006403", "JDKD", "京东购物", StatusSemantic.TRANSIT, 0L,
                "2026-09-09 09:00:00", "已揽收",
                "[{\"time\":\"2026-09-09 09:00:00\",\"context\":\"已揽收\"}]",
                "", phone, "v5_query", "", "", "JingDong"), phone);
        ExpressItem stored = repository.findByWaybill("1234500006403", "interface5");
        assertNotNull(stored);
        ExpressItem source = new ExpressItem(stored.rowId, phone, stored.waybill,
                stored.courierCode, stored.companyName, stored.semantic, stored.statusDescription,
                stored.latestDetail, stored.latestTime, stored.tracksJson, "", stored.source,
                "", 0L, stored.updatedAt, stored.stateOwner, "", "v5", ROUTE_A, true,
                "", "", "[]", "JingDong");
        QueryShadow.result = null;
        QueryShadow.calls = 0;
        QueryShadow.waiting = null;
        CaptureShadow.starts = 0;
        CaptureShadow.result = new ExpressAutomaticTimelineCapture.Result(new ExpressQueryResult(
                "JD00000005481", "", "", StatusSemantic.UNKNOWN,
                "2026-09-09 10:00:00", "Arrived at station",
                "[{\"time\":\"2026-09-09 10:00:00\",\"context\":\"Arrived at station\"}]",
                "", phone, "jd_h5", "", "", "JingDong"), true, false);
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        boolean[] finished = {false};
        boolean[] saved = {false};
        ExpressItem[] completed = {null};
        ExpressHomeOrderProjectionCapture capture = new ExpressHomeOrderProjectionCapture(
                activity, source, (ignored, committed) -> {
                    saved[0] = committed;
                    completed[0] = repository.find(source.rowId);
                    finished[0] = true;
                });
        try {
            assertTrue(capture.start());
            long until = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(3);
            while (System.nanoTime() < until && !finished[0]) {
                Thread.sleep(10);
                Shadows.shadowOf(Looper.getMainLooper()).idle();
            }
            assertTrue("The Home capture must finish", finished[0]);
            assertTrue(saved[0]);
            assertEquals(1, QueryShadow.calls);
            assertEquals(1, CaptureShadow.starts);
            assertEquals(1, CarrierShadow.calls);
            assertEquals("JD00000005481", CarrierShadow.waybill);
            ExpressItem recognized = completed[0];
            assertNotNull(recognized);
            assertEquals("JD00000005481", recognized.projectedWaybill);
            // Stored by its standard code since audit C6 (user 2026-09-25); shown by the table name.
            assertEquals("JD", recognized.projectedCompanyName);
            assertEquals("京东快递", recognized.displayCompany());
            assertEquals("jd", recognized.displayCourierCode());
            assertEquals(stored.rowId, recognized.rowId);
            assertEquals(stored.waybill, recognized.waybill);
            assertEquals(stored.courierCode, recognized.courierCode);
            assertEquals(stored.companyName, recognized.companyName);
            assertEquals(stored.phone, recognized.phone);
            assertEquals(stored.stateOwner, recognized.stateOwner);
            assertEquals(stored.sourceProvider, recognized.sourceProvider);
        } finally {
            capture.cancel();
            activity.finish();
            singleton.set(null, null);
            java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
            helper.setAccessible(true);
            ((ExpressDatabase) helper.get(repository)).close();
        }
    }

    private void verifyHomeQuery(boolean timed, boolean cancelDuringQuery) throws Exception {
        context.deleteDatabase(ExpressDatabase.DATABASE);
        java.lang.reflect.Field singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, null);
        ExpressRepository repository = ExpressRepository.get(context);
        String phone = "13800000001";
        repository.bindPhoneLocally(phone, "interface5");
        ExpressQueryResult feed = new ExpressQueryResult("JDORDERHOME001", "JD", "京东购物",
                StatusSemantic.TRANSIT, 0L, "2026-09-09 09:00:00", "已揽收",
                "[{\"time\":\"2026-09-09 09:00:00\",\"context\":\"已揽收\"}]", "", phone,
                "v5_query", "", "", "JingDong");
        repository.saveInterface5OrderSummary(feed, phone);
        ExpressItem stored = repository.findByWaybill(feed.waybill, "interface5");
        assertNotNull(stored);
        ExpressItem source = new ExpressItem(stored.rowId, phone, stored.waybill,
                stored.courierCode, stored.companyName, stored.semantic, stored.statusDescription,
                stored.latestDetail, stored.latestTime, stored.tracksJson, "", stored.source,
                "", 0L, stored.updatedAt, stored.stateOwner, "", "v5", ROUTE_A, true,
                "", "", "[]", "JingDong");
        QueryShadow.result = timed ? new ExpressQueryResult(source.waybill, "JD", "京东购物",
                StatusSemantic.TRANSIT, "2026-09-09 10:00:00", "Query event",
                "[{\"time\":\"2026-09-09 10:00:00\",\"context\":\"Query event\"}]",
                "", phone, "v5_query", "", "", "JingDong") : null;
        QueryShadow.calls = 0;
        QueryShadow.waiting = cancelDuringQuery ? new java.util.concurrent.CountDownLatch(1) : null;
        CaptureShadow.starts = 0;
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        boolean[] finished = {false};
        ExpressHomeOrderProjectionCapture capture = new ExpressHomeOrderProjectionCapture(
                activity, source, (ignored, saved) -> finished[0] = true);
        try {
            assertTrue(capture.start());
            long until = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(3);
            while (System.nanoTime() < until && !finished[0] && CaptureShadow.starts == 0) {
                Thread.sleep(10);
                Shadows.shadowOf(Looper.getMainLooper()).idle();
                if (cancelDuringQuery && QueryShadow.calls > 0) {
                    capture.cancel();
                    QueryShadow.waiting.countDown();
                    break;
                }
            }
            assertEquals("Home must query its account before opening H5", 1, QueryShadow.calls);
            assertEquals("An active unresolved identity permits H5 even with timed history",
                    cancelDuringQuery ? 0 : 1, CaptureShadow.starts);
            assertEquals(cancelDuringQuery,
                    context.getSharedPreferences("express_jd_h5_cooldown", 0).getAll().isEmpty());
            if (cancelDuringQuery) {
                ExpressOrderProjectionRetryStore.AttemptToken reopened =
                        ExpressOrderProjectionRetryStore.acquireAttempt(source);
                assertNotNull(reopened);
                retries.endAttempt(reopened);
            }
        } finally {
            capture.cancel();
            activity.finish();
            singleton.set(null, null);
            java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
            helper.setAccessible(true);
            ((ExpressDatabase) helper.get(repository)).close();
        }
    }

    @Implements(value = ExpressDiscoveryClient.class, isInAndroidSdk = false)
    public static class QueryShadow {
        static volatile int calls;
        static ExpressQueryResult result;
        static java.util.concurrent.CountDownLatch waiting;
        @Implementation protected ExpressQueryResult refreshKnown(Context ignored,
                ExpressItem owner, boolean force, ExpressQueryCancellation cancellation) throws InterruptedException {
            calls++;
            if (waiting != null) waiting.await(3, java.util.concurrent.TimeUnit.SECONDS);
            return result;
        }
    }

    @Implements(value = ExpressAutomaticTimelineCapture.class, isInAndroidSdk = false)
    public static class CaptureShadow {
        static volatile int starts;
        static ExpressAutomaticTimelineCapture.Result result;
        @RealObject private ExpressAutomaticTimelineCapture capture;
        @Implementation protected void start() {
            starts++;
            if (result != null) {
                ExpressAutomaticTimelineCapture.Callback callback =
                        ReflectionHelpers.getField(capture, "callback");
                callback.complete(result);
            }
        }
        @Implementation protected void cancel() {}
    }

    @Implements(value = ExpressApi.class, isInAndroidSdk = false)
    public static class CarrierShadow {
        static volatile int calls;
        static String waybill;
        @Implementation protected void __constructor__(Context ignored) {}
        @Implementation protected CarrierNormalization recognizeCarrier(
                String requestedWaybill, ExpressQueryCancellation cancellation) {
            calls++;
            waybill = requestedWaybill;
            return new CarrierNormalization("JD", "京东快递", "jd", true, "test");
        }
    }

    private static ExpressItem order(
            long rowId, String owner, String projectedWaybill,
            boolean credentialAvailable, String credential) {
        return orderWithIdentity(rowId, owner, "JDORDER" + rowId, projectedWaybill,
                credentialAvailable, credential);
    }

    private static ExpressItem orderWithIdentity(
            long rowId, String owner, String orderId, String projectedWaybill,
            boolean credentialAvailable, String credential) {
        return orderWithIdentity(rowId, owner, orderId, projectedWaybill, credentialAvailable,
                credential, "[{\"time\":\"2026-08-22 10:00:00\",\"context\":\"已揽收\"}]");
    }

    private static ExpressItem orderWithIdentity(
            long rowId, String owner, String orderId, String projectedWaybill,
            boolean credentialAvailable, String credential, String tracks) {
        return new ExpressItem(
                rowId, "", orderId, "JD", "京东购物",
                StatusSemantic.TRANSIT, "运输中", "订单正在配送",
                "2026-08-22 10:00:00", tracks, "", owner, "",
                1L, 2L, owner, "", "v5", credential, credentialAvailable,
                projectedWaybill, "", "[]", "JingDong");
    }

    private static ExpressItem structuredOrder(StatusSemantic semantic, String detail)
            throws Exception {
        long eventAt = 1_790_207_894_000L;
        String tracks = me.pipi.deliveries.model.WorkerStatusProjection.attach(
                new org.json.JSONArray().put(new org.json.JSONObject()
                        .put("time", "2026-09-24 07:58:14").put("context", detail)).toString(),
                me.pipi.deliveries.model.WorkerStatusProjection.read(new org.json.JSONObject()
                        .put("normalizedStatus", new org.json.JSONObject().put("version", 1)
                                .put("scope", "ORDER").put("semantic", semantic.name())
                                .put("code", "SERVER_ENUM").put("text", semantic.label)
                                .put("priority", 0).put("eventAtMs", eventAt)
                                .put("structured", true))));
        // As read from the stored row: the feed's own structured Worker status (audit L8 carries
        // it on the row as sourceStatusStructured; the gate no longer reads the attached packet).
        return new ExpressItem(
                9L, "", "3630448013820516", "JDKD", "京东购物",
                semantic, semantic.label, detail,
                "2026-09-24 07:58:14", tracks, "", "I5-JD", "",
                eventAt, eventAt, "I5-JD", "", "v5", ROUTE_A, true,
                "", "", "[]", "JingDong").withSourceStatusStructured(true);
    }

    private interface RepositoryBody {
        void run(ExpressRepository repository) throws Exception;
    }

    private void withRepository(String phone, RepositoryBody body) throws Exception {
        context.deleteDatabase(ExpressDatabase.DATABASE);
        java.lang.reflect.Field singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, null);
        ExpressRepository repository = ExpressRepository.get(context);
        try {
            repository.bindPhoneLocally(phone, "interface5");
            body.run(repository);
        } finally {
            singleton.set(null, null);
            java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
            helper.setAccessible(true);
            ((ExpressDatabase) helper.get(repository)).close();
        }
    }

    private static me.pipi.deliveries.model.WorkerStatusProjection structuredStatus(
            StatusSemantic semantic, long eventAt) throws Exception {
        return me.pipi.deliveries.model.WorkerStatusProjection.read(new org.json.JSONObject()
                .put("normalizedStatus", new org.json.JSONObject().put("version", 1)
                        .put("scope", "ORDER").put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.label)
                        .put("priority", 0).put("eventAtMs", eventAt)
                        .put("structured", true)));
    }

    /** 列表页上的这一行（listVisible 同一套投影），feed 带结构化状态、没有揽收字样。 */
    private static ExpressItem listedOrder(ExpressRepository repository, String phone,
            String order, StatusSemantic semantic, String time, String detail) throws Exception {
        long eventAt = me.pipi.deliveries.model.ExpressTimeline.parseTime(time);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(order, "JD", "京东购物",
                semantic, eventAt, time, detail, new org.json.JSONArray().put(new org.json.JSONObject()
                        .put("time", time).put("context", detail)).toString(),
                "", phone, "interface5", "", "", "JingDong")
                .withWorkerStatus(structuredStatus(semantic, eventAt)), phone);
        ExpressItem owner = repository.findByWaybill(order, "interface5");
        assertNotNull(owner);
        return listed(repository, owner.rowId);
    }

    private static ExpressItem listed(ExpressRepository repository, long rowId) {
        for (ExpressItem item : repository.listVisible("interface5")) {
            if (item.rowId == rowId) return item;
        }
        throw new AssertionError("the order is not listed");
    }

    private static ExpressItem normalShipment() {
        return new ExpressItem(
                6L, "", "ZTO123456789", "ZTO", "中通快递",
                StatusSemantic.TRANSIT, "运输中", "已到达转运中心",
                "2026-08-22 10:00:00", "[]", "", "INTERFACE5", "",
                1L, 2L, "INTERFACE5", "", "v5", "route", true,
                "", "", "[]");
    }
}
