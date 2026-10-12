package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.os.Looper;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import me.pipi.deliveries.R;
import me.pipi.deliveries.background.ExpressScheduler;
import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.network.ExpressApi;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressLog;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.RealObject;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.shadows.ShadowLog;
import org.robolectric.util.ReflectionHelpers;

/**
 * 用户定 2026-09-24：Lite 后台轮次结束时自己把京东订单投影成真实运单号——只有这一条能在后台开京粉页（离屏），
 * 走首页同一个 capture（同一道门、冷却、租约、强制 v5_query、提交）。其它网页抓取照旧只在前台。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class, shadows = {
        SyntheticSecretBox.class,
        ExpressBackgroundOrderProjectionTest.Query.class,
        ExpressBackgroundOrderProjectionTest.Page.class,
        ExpressBackgroundOrderProjectionTest.Carrier.class,
        ExpressBackgroundOrderProjectionTest.Kuaidi100Page.class,
        ExpressBackgroundOrderProjectionTest.Scheduler.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressBackgroundOrderProjectionTest {
    private static final String PHONE = "13800002468";
    private static final String PICKED =
            "[{\"time\":\"2026-09-24 08:00:00\",\"context\":\"已揽收\"}]";
    private static final long MINUTE = 60_000L;
    private Context context;
    private ExpressRepository repository;
    private ExpressOrderProjectionRetryStore retries;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String prefs : new String[]{"express_jd_h5_cooldown", "express_account_source",
                "deliveries_repository_migrations"}) {
            context.getSharedPreferences(prefs, 0).edit().clear().commit();
        }
        context.getSharedPreferences("express_account_source", 0).edit()
                .putString("active_interface", "v5").commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        retries = new ExpressOrderProjectionRetryStore(context);
        ((Map<?, ?>) ReflectionHelpers.getStaticField(
                ExpressOrderProjectionRetryStore.class, "ACTIVE_ATTEMPTS")).clear();
        ((AtomicInteger) ReflectionHelpers.getStaticField(
                ExpressListActivity.class, "STARTED_HOMES")).set(0);
        ((AtomicBoolean) ReflectionHelpers.getStaticField(
                ExpressBackgroundOrderProjection.class, "ROUND_ACTIVE")).set(false);
        Query.reset();
        Page.reset();
        Carrier.calls.set(0);
        Kuaidi100Page.constructed.set(0);
        ShadowLog.clear();
    }

    @After public void tearDown() {
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aBackgroundRoundProjectsAnEligibleOrderThroughTheOffWindowCapture()
            throws Exception {
        ExpressItem order = order("3630448013820101", PICKED, true);
        assertTrue(ExpressHomeOrderProjectionCapture.needsProjection(order));
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            pump(worker.submit(() -> {
                ExpressBackgroundOrderProjection.afterCommittedRound(
                        context, System.nanoTime(), () -> false);
                return null;
            }));
        } finally { worker.shutdownNow(); }

        assertEquals("Home's forced v5_query recovers the route first", 1, Query.forced.get());
        assertEquals(List.of(TimelineSlot.JD_H5), Page.providers);
        assertEquals("no Activity hosts the page", List.of(false), Page.hosted);
        assertEquals("the page is created from the application context", List.of(true), Page.offWindow);
        ExpressItem projected = repository.find(order.rowId);
        assertEquals(carrierWaybill(order), projected.projectedWaybill);
        assertNotNull("the complete package commits through Home's repository call",
                repository.manualTimelineCandidate(projected, TimelineSlot.JD_H5));
        assertEquals("Home's carrier recognition follows the commit", 1, Carrier.calls.get());
        assertTrue("the commit publishes outward like Home's", Shadows.shadowOf((Application) context)
                .getBroadcastIntents().stream().anyMatch(intent ->
                        ExpressRepository.ACTION_CHANGED.equals(intent.getAction())));
        assertFalse("the page load starts the shared 10-minute cooldown",
                retries.timelineAttemptDue(order, System.currentTimeMillis()));
        ExpressOrderProjectionRetryStore.AttemptToken lease =
                ExpressOrderProjectionRetryStore.acquireAttempt(order);
        assertNotNull("the order lease is released after the capture", lease);
        ExpressOrderProjectionRetryStore.releaseAttempt(lease);
        String tail = ExpressLog.tail(order.waybill);
        List<String> lines = projectionLines();
        assertTrue(lines.toString(), lines.stream().anyMatch(line -> line.endsWith(
                " result=started stage=jd_h5 waybillTail=" + tail + " trigger=background")));
        assertTrue(lines.toString(), lines.stream().anyMatch(line -> line.contains(
                " result=succeeded ") && line.endsWith(" complete=true trigger=background")));
    }

    @Test public void ordersHomeWouldNotOpenStayClosedInTheBackground() throws Exception {
        ExpressItem beforePickup = order("3630448013820201",
                "[{\"time\":\"2026-09-24 08:00:00\",\"context\":\"您提交了订单，请等待系统确认\"}]", true);
        ExpressItem alreadyProjected = order("3630448013820202", PICKED, true);
        assertTrue(repository.saveOrderProjection(
                alreadyProjected, "interface5", "JD00000020202", "京东快递"));
        alreadyProjected = listed(alreadyProjected.rowId);
        ExpressItem noRoute = order("3630448013820203", PICKED, false);
        ExpressItem named = order("3630448013820204", "[{\"time\":\"2026-09-24 08:00:00\","
                + "\"context\":\"待出库交付申通快递，运单号为770018906334362\"}]", true);
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(beforePickup));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(alreadyProjected));
        assertFalse(ExpressHomeOrderProjectionCapture.needsProjection(noRoute));
        assertTrue("the feed text names this order's waybill",
                ExpressHomeOrderProjectionCapture.needsProjection(named)
                        && ExpressOrderTextIdentity.fromTracksJson(named.tracksJson, named.waybill) != null);
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;

        assertEquals(0, round());

        assertEquals("no forced query without a page to open", 0, Query.calls.get());
        assertTrue("no page opens: " + Page.owners, Page.owners.isEmpty());
        assertTrue("no cooldown is spent",
                context.getSharedPreferences("express_jd_h5_cooldown", 0).getAll().isEmpty());
    }

    @Test public void theSharedTenMinuteCooldownKeepsAnOrderClosedUntilItEnds() throws Exception {
        ExpressItem order = order("3630448013820301", PICKED, true);
        long now = System.currentTimeMillis();
        open(order, now - MINUTE);
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;

        assertEquals(0, round());
        assertEquals("a cooling order sends neither the forced query nor the page",
                0, Query.calls.get());
        assertTrue(Page.owners.isEmpty());
        assertTrue("a cooling order is not even handed to the capture each round",
                projectionLines().stream().noneMatch(line -> line.contains("skipReason=cooldown")));

        context.getSharedPreferences("express_jd_h5_cooldown", 0).edit().clear().commit();
        open(order, now - 10L * MINUTE - 1_000L);
        assertEquals(1, round());
        assertEquals(List.of(order.waybill), Page.owners);
    }

    @Test public void aRiskControlRestKeepsTheOrderClosedForTheHour() throws Exception {
        ExpressItem order = order("3630448013820302", PICKED, true);
        retries.recordTimelineRateLimit(order, System.currentTimeMillis() - 59L * MINUTE);
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;

        assertEquals(0, round());

        assertEquals(0, Query.calls.get());
        assertTrue(Page.owners.isEmpty());
    }

    @Test public void aRoundOpensAtMostTwoPagesAndTheRestGoNextRound() throws Exception {
        order("3630448013820401", PICKED, true);
        order("3630448013820402", PICKED, true);
        order("3630448013820403", PICKED, true);
        Page.answer = owner -> null;

        assertEquals(0, round());

        assertEquals(ExpressBackgroundOrderProjection.MAX_CAPTURES_PER_ROUND, Page.owners.size());
        assertEquals(2, Query.forced.get());
        assertTrue(projectionLines().toString(), projectionLines().stream().anyMatch(line ->
                line.endsWith(" skipReason=round_cap trigger=background")));
        List<String> firstRound = new ArrayList<>(Page.owners);
        Page.reset();
        Page.answer = owner -> null;

        assertEquals(0, round());

        // 优化 6（用户 2026-10-03「离屏失败不占冷却（推荐）」）：the two pages brought no package, so they did not take the
        // ten-minute cooldown (it used to keep them closed and leave this round to the third alone). The round is full
        // again, and the order never opened still goes first.
        assertEquals(2, Page.owners.size());
        assertFalse(firstRound.contains(Page.owners.get(0)));
        assertEquals(firstRound.get(0), Page.owners.get(1));
    }

    /**
     * 优化 6（用户 2026-10-03「离屏失败不占冷却（推荐）」）：an off-window page that brings no package (nothing, or a page
     * loaded empty) and is not risk control leaves the order due, so Home's own page can open at once (Pixel
     * 2026-09-24: the off-window page timed out after 20 s with nothing, and Home then waited out the ten minutes).
     * Home's hosted page keeps today's cooldown whatever it brings.
     */
    @Test public void anOffWindowPageWithoutAPackageLeavesTheOrderDueForHome() throws Exception {
        ExpressItem order = order("3630448013820451", PICKED, true);
        ExpressItem shell = order("3630448013820452", PICKED, true);
        Page.answer = owner -> owner.waybill.equals(shell.waybill)
                ? new ExpressAutomaticTimelineCapture.Result(null, false, false, false, true, false) : null;

        assertEquals(0, round());

        assertEquals(2, Page.owners.size());
        long now = System.currentTimeMillis();
        assertTrue("no package: the cooldown is given back", retries.timelineAttemptDue(order, now));
        assertTrue("an empty page is no package either", retries.timelineAttemptDue(shell, now));
        assertTrue("the attempt time stays as the order's place in the background order",
                retries.timelineCooldownUntil(order) > 0L && retries.timelineCooldownUntil(order) <= now);

        Page.reset();
        Page.answer = owner -> null;
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        boolean[] finished = {false};
        ExpressHomeOrderProjectionCapture home = new ExpressHomeOrderProjectionCapture(
                activity, listed(order.rowId), (capture, committed) -> finished[0] = true, "home-projection-6");
        try {
            assertTrue("Home may open the page at once", home.start());
            pumpUntil(() -> finished[0]);
        } finally {
            home.cancel();
            activity.finish();
        }
        assertEquals(List.of(true), Page.hosted);
        assertFalse("Home's own page keeps today's ten minutes",
                retries.timelineAttemptDue(order, System.currentTimeMillis()));
    }

    @Test public void theOrderOpenedLongestAgoGoesFirst() throws Exception {
        order("3630448013820501", PICKED, true);
        order("3630448013820502", PICKED, true);
        order("3630448013820503", PICKED, true);
        List<ExpressItem> listed = repository.listVisible("interface5");
        ExpressItem listedFirst = listed.get(0);
        ExpressItem listedSecond = listed.get(1);
        ExpressItem listedLast = listed.get(2);
        long now = System.currentTimeMillis();
        open(listedFirst, now - 11L * MINUTE);
        open(listedSecond, now - 13L * MINUTE);
        Page.answer = owner -> null;

        round();

        assertEquals("never opened first, then the order whose cooldown ended earliest",
                List.of(listedLast.waybill, listedSecond.waybill), Page.owners);
    }

    @Test public void aRiskControlAnswerEndsTheRound() throws Exception {
        order("3630448013820601", PICKED, true);
        order("3630448013820602", PICKED, true);
        Page.answer = owner -> new ExpressAutomaticTimelineCapture.Result(null, false, true);

        assertEquals(0, round());

        assertEquals(1, Page.owners.size());
        ExpressItem throttled = byWaybill(Page.owners.get(0));
        assertTrue("the existing 60-minute risk-control rest",
                retries.timelineCooldownUntil(throttled)
                        >= System.currentTimeMillis() + 59L * MINUTE);
        for (ExpressItem other : repository.listVisible("interface5")) {
            if (other.rowId != throttled.rowId) assertEquals(0L, retries.timelineCooldownUntil(other));
        }
        assertTrue(projectionLines().toString(), projectionLines().stream().anyMatch(line ->
                line.endsWith(" skipReason=risk_control trigger=background")));
    }

    @Test public void onlyTheJdOrderPageOpensInTheBackground() throws Exception {
        ExpressItem eligible = order("3630448013820701", PICKED, true);
        ExpressItem projected = order("3630448013820702", PICKED, true);
        assertTrue(repository.saveOrderProjection(projected, "interface5", "JD00000020702", "京东快递"));
        String time = "2026-09-24 08:00:00";
        long at = ExpressTimeline.parseTime(time);
        repository.saveInterface5(new ExpressQueryResult("YT7000000000701", "YTO", "圆通速递",
                StatusSemantic.TRANSIT, at, time, "运输中", PICKED, "", PHONE, "interface5",
                "", "", "CaiNiao"), PHONE);
        repository.saveInterface5(new ExpressQueryResult("JDX000000000701", "JD", "京东快递",
                StatusSemantic.TRANSIT, at, time, "运输中", PICKED, "", PHONE, "interface5",
                "", "", "JingDong"), PHONE);
        assertNotNull(repository.saveManualQueryBatch(null, null, List.of(new ManualQuerySuccess(
                TimelineSlot.K100_H5, new ExpressQueryResult("SF1400000000701", "SF", "顺丰速运",
                        StatusSemantic.TRANSIT, at, time, "运输中", PICKED, "", "",
                        TimelineSlot.K100_H5, "", "", ""), System.currentTimeMillis(), false)),
                "", "interface5"));
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;

        assertEquals(1, round());

        assertEquals(List.of(TimelineSlot.JD_H5), Page.providers);
        assertEquals(List.of(eligible.waybill), Page.owners);
        assertEquals("no Kuaidi100 page in the background", 0, Kuaidi100Page.constructed.get());
    }

    @Test public void theBackgroundPackageReachesAPageOnlyThroughTheOrderProjection()
            throws Exception {
        try (Stream<Path> files = Files.list(source("background"))) {
            for (Path file : files.collect(Collectors.toList())) {
                String text = Files.readString(file, StandardCharsets.UTF_8);
                for (String capture : new String[]{"WebView", "ExpressKuaidi100TimelineCapture",
                        "ExpressAutomaticTimelineCapture", "ExpressHomeOrderProjectionCapture",
                        "ExpressDetailActivity"}) {
                    assertFalse(file + " must not reach " + capture, text.contains(capture));
                }
            }
        }
        String worker = Files.readString(source("background/ExpressSyncWorker.java"),
                StandardCharsets.UTF_8);
        assertTrue(worker.contains("ExpressBackgroundOrderProjection.afterCommittedRound("));
        String runner = Files.readString(source(
                "feature/express/ExpressBackgroundOrderProjection.java"), StandardCharsets.UTF_8);
        assertTrue(runner.contains("ExpressHomeOrderProjectionCapture.offWindow("));
        for (String other : new String[]{"new ExpressHomeOrderProjectionCapture(", "WebView",
                "ExpressAutomaticTimelineCapture", "ExpressKuaidi100TimelineCapture"}) {
            assertFalse("the round opens nothing but Home's order capture: " + other,
                    runner.contains(other));
        }
    }

    @Test public void homeCannotOpenTheOrderTheBackgroundIsCapturing() throws Exception {
        ExpressItem order = order("3630448013820801", PICKED, true);
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;
        Query.gate = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        ExpressHomeOrderProjectionCapture home = new ExpressHomeOrderProjectionCapture(
                activity, order, (capture, saved) -> { });
        try {
            Future<Integer> round = worker.submit(() -> ExpressBackgroundOrderProjection.run(context,
                    2, ExpressBackgroundOrderProjection.CAPTURE_WAIT_MS,
                    System.nanoTime() + TimeUnit.MINUTES.toNanos(9), () -> false));
            pumpUntil(() -> Query.calls.get() == 1);
            assertFalse("the background holds the order lease", home.start());
            Query.gate.countDown();
            assertEquals(1, (int) pump(round));
            assertEquals(1, Query.calls.get());
            assertEquals(List.of(false), Page.hosted);
        } finally {
            Query.gate.countDown();
            home.cancel();
            activity.finish();
            worker.shutdownNow();
        }
    }

    @Test public void theBackgroundCannotOpenTheOrderHomeIsCapturing() throws Exception {
        ExpressItem order = order("3630448013820802", PICKED, true);
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;
        Query.gate = new CountDownLatch(1);
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        boolean[] finished = {false};
        ExpressHomeOrderProjectionCapture home = new ExpressHomeOrderProjectionCapture(
                activity, order, (capture, saved) -> finished[0] = true);
        try {
            assertTrue(home.start());
            pumpUntil(() -> Query.calls.get() == 1);

            assertEquals(0, round());

            assertEquals("the background sent no second query", 1, Query.calls.get());
            assertTrue(Page.owners.isEmpty());
            Query.gate.countDown();
            pumpUntil(() -> finished[0]);
            assertEquals("only Home's hosted page opened", List.of(true), Page.hosted);
        } finally {
            Query.gate.countDown();
            home.cancel();
            activity.finish();
        }
    }

    @Test public void aVisibleHomeKeepsOrderProjectionAndTheRoundStops() throws Exception {
        order("3630448013820901", PICKED, true);
        order("3630448013820902", PICKED, true);
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;
        Query.gate = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        ActivityController<ExpressListActivity> home =
                Robolectric.buildActivity(ExpressListActivity.class);
        home.get().setTheme(R.style.AppTheme);
        try {
            Future<Integer> round = worker.submit(() -> ExpressBackgroundOrderProjection.run(context,
                    2, ExpressBackgroundOrderProjection.CAPTURE_WAIT_MS,
                    System.nanoTime() + TimeUnit.MINUTES.toNanos(9), () -> false));
            pumpUntil(() -> Query.calls.get() == 1);
            home.create().start();
            pumpUntil(() -> Query.calls.get() == 2);
            Query.gate.countDown();

            assertEquals(1, (int) pump(round));
            pumpUntil(() -> Page.owners.size() == 2);

            assertEquals("each order opens once", 2, Page.owners.stream().distinct().count());
            assertEquals(1, Page.hosted.stream().filter(hosted -> hosted).count());
            assertEquals(1, Page.hosted.stream().filter(hosted -> !hosted).count());
            assertTrue(projectionLines().toString(), projectionLines().stream().anyMatch(line ->
                    line.endsWith(" skipReason=home_visible trigger=background")));
        } finally {
            Query.gate.countDown();
            home.stop().destroy();
            worker.shutdownNow();
        }
    }

    @Test public void aStartedHomeTakesTheWholeRound() throws Exception {
        order("3630448013820903", PICKED, true);
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;
        AtomicInteger startedHomes = ReflectionHelpers.getStaticField(
                ExpressListActivity.class, "STARTED_HOMES");
        startedHomes.set(1);
        try {
            assertEquals(0, round());
        } finally { startedHomes.set(0); }

        assertEquals(0, Query.calls.get());
        assertTrue(Page.owners.isEmpty());
        assertTrue(projectionLines().toString(), projectionLines().stream().anyMatch(line ->
                line.endsWith(" skipReason=home_visible trigger=background")));
        assertEquals("once Home stops, the next round projects", 1, round());
    }

    @Test public void aStoppedWorkerCancelsTheCaptureAndReleasesTheOrder() throws Exception {
        ExpressItem order = order("3630448013821001", PICKED, true);
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;
        Query.gate = new CountDownLatch(1);
        AtomicBoolean stopped = new AtomicBoolean();
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            Future<Integer> round = worker.submit(() -> ExpressBackgroundOrderProjection.run(context,
                    2, 60_000L, System.nanoTime() + TimeUnit.MINUTES.toNanos(9), stopped::get));
            pumpUntil(() -> Query.calls.get() == 1);
            stopped.set(true);

            assertEquals(0, (int) pump(round));

            assertTrue(Page.owners.isEmpty());
            ExpressOrderProjectionRetryStore.AttemptToken lease =
                    ExpressOrderProjectionRetryStore.acquireAttempt(order);
            assertNotNull("the cancelled capture released its lease", lease);
            ExpressOrderProjectionRetryStore.releaseAttempt(lease);
            assertTrue("no page opened, so no cooldown",
                    retries.timelineAttemptDue(order, System.currentTimeMillis()));
            assertTrue(projectionLines().toString(), projectionLines().stream().anyMatch(line ->
                    line.endsWith(" waybillTail=" + ExpressLog.tail(order.waybill)
                            + " skipReason=deadline_exhausted trigger=background")));
        } finally {
            Query.gate.countDown();
            worker.shutdownNow();
        }
    }

    @Test public void noCaptureStartsWithoutTimeToFinishBeforeTheWorkerLimit() throws Exception {
        order("3630448013821002", PICKED, true);
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;

        assertEquals(0, round(2, System.nanoTime() + TimeUnit.SECONDS.toNanos(5), () -> false));

        assertEquals(0, Query.calls.get());
        assertTrue(Page.owners.isEmpty());
        assertTrue(projectionLines().toString(), projectionLines().stream().anyMatch(line ->
                line.endsWith(" skipReason=deadline_exhausted trigger=background")));
    }

    /**
     * Home still hosts its page. Its lines now also name their flow and trigger (audit R10, user
     * 2026-09-25: 「Lite 首页取号的日志没有 trigger 和 flowId」), as iOS names its Home projection
     * (flow home-projection-…, trigger home_projection); they used to carry neither.
     */
    @Test public void homeStillHostsItsPageAndLogsItsFlowAndTrigger() throws Exception {
        ExpressItem order = order("3630448013821101", PICKED, true);
        Page.answer = ExpressBackgroundOrderProjectionTest::carrierPackage;
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        boolean[] finished = {false};
        boolean[] saved = {false};
        ExpressHomeOrderProjectionCapture home = new ExpressHomeOrderProjectionCapture(
                activity, order, (capture, committed) -> {
                    saved[0] = committed;
                    finished[0] = true;
                }, "home-projection-test");
        try {
            assertTrue(home.start());
            pumpUntil(() -> finished[0]);
            assertTrue(saved[0]);
            assertEquals(List.of(true), Page.hosted);
            assertEquals(List.of(false), Page.offWindow);
            String tail = ExpressLog.tail(order.waybill);
            String flow = " flowId=home-projection-test trigger=home_projection";
            List<String> lines = projectionLines();
            assertTrue(lines.toString(), lines.stream().anyMatch(line -> line.endsWith(
                    " result=started stage=jd_h5 waybillTail=" + tail + flow)));
            assertTrue(lines.toString(), lines.stream().anyMatch(line -> line.endsWith(
                    " result=succeeded stage=jd_h5 waybillTail=" + tail
                            + " saved=true resultPresent=true complete=true" + flow)));
            assertTrue(lines.toString(), lines.stream().allMatch(line -> line.endsWith(flow)));
        } finally {
            home.cancel();
            activity.finish();
        }
    }

    /**
     * 承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28）：京粉页给过运单号、那一轮承运商却没对上而暂存的订单，
     * 不再开页——后台轮次不开，也不替同步补识别；首页只补识别，对上时暂存的页面包按京粉页原路落库。
     */
    @Test public void aHeldPageProjectionNeverReopensThePage() throws Exception {
        ExpressItem order = order("3630448013822401", PICKED, true);
        assertTrue(repository.holdOrderProjection(order, repository.captureManualQueryOwner(order),
                carrierPackage(order).timeline, true));
        assertEquals(0, round());
        assertTrue("no page in the background", Page.providers.isEmpty());
        assertEquals(0, Query.forced.get());
        assertEquals("the sync round recognises it, not the page round", 0, Carrier.calls.get());

        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        boolean[] finished = {false};
        boolean[] saved = {false};
        ExpressHomeOrderProjectionCapture home = new ExpressHomeOrderProjectionCapture(
                activity, listed(order.rowId), (capture, committed) -> {
                    saved[0] = committed;
                    finished[0] = true;
                }, "home-projection-t23");
        try {
            assertTrue(home.start());
            pumpUntil(() -> finished[0]);
        } finally {
            home.cancel();
            activity.finish();
        }
        assertTrue(saved[0]);
        assertTrue("Home opens no page for it either", Page.providers.isEmpty());
        assertEquals("nor forces another v5_query", 0, Query.forced.get());
        assertEquals(1, Carrier.calls.get());
        ExpressItem projected = repository.find(order.rowId);
        assertEquals(carrierWaybill(order), projected.projectedWaybill);
        assertNotNull(repository.manualTimelineCandidate(projected, TimelineSlot.JD_H5));
    }

    private ExpressItem order(String order, String tracks, boolean route) {
        String url = route ? "https://jingfen.jd.com/item?fixture=" + order : "";
        String time = "2026-09-24 08:00:00";
        ExpressQueryResult feed = new ExpressQueryResult(order, "JD", "京东购物",
                StatusSemantic.TRANSIT, ExpressTimeline.parseTime(time), time, "订单运输中",
                tracks, url, PHONE, "interface5", route ? "v5" : "", url, "JingDong");
        repository.saveInterface5OrderSummary(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(order, "interface5");
        assertNotNull(owner);
        if (route) {
            assertTrue(repository.saveRecoveredOwnerRoute(
                    owner, repository.captureManualQueryOwner(owner), feed));
        }
        return listed(owner.rowId);
    }

    private ExpressItem listed(long rowId) {
        for (ExpressItem item : repository.listVisible("interface5")) {
            if (item.rowId == rowId) return item;
        }
        throw new AssertionError("the order is not listed");
    }

    private ExpressItem byWaybill(String waybill) {
        for (ExpressItem item : repository.listVisible("interface5")) {
            if (item.waybill.equals(waybill)) return item;
        }
        throw new AssertionError("the order is not listed");
    }

    /** One earlier union-page load for this order at {@code at} (Home's or Detail's). */
    private void open(ExpressItem order, long at) {
        ExpressOrderProjectionRetryStore.AttemptToken token = retries.beginTimelineAttempt(order, at);
        assertNotNull(token);
        retries.endAttempt(token);
    }

    private static String carrierWaybill(ExpressItem owner) {
        return "JD00000" + owner.waybill.substring(owner.waybill.length() - 6);
    }

    private static ExpressAutomaticTimelineCapture.Result carrierPackage(ExpressItem owner) {
        return new ExpressAutomaticTimelineCapture.Result(new ExpressQueryResult(
                carrierWaybill(owner), "", "", StatusSemantic.UNKNOWN,
                "2026-09-24 10:00:00", "Arrived at station",
                "[{\"time\":\"2026-09-24 10:00:00\",\"context\":\"Arrived at station\"}]",
                "", PHONE, TimelineSlot.JD_H5, "", "", "JingDong"), true, false);
    }

    private int round() throws Exception {
        return round(ExpressBackgroundOrderProjection.MAX_CAPTURES_PER_ROUND,
                System.nanoTime() + TimeUnit.MINUTES.toNanos(9), () -> false);
    }

    private int round(int cap, long deadlineNanos, BooleanSupplier stopped) throws Exception {
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try {
            return pump(worker.submit(() -> ExpressBackgroundOrderProjection.run(context, cap,
                    ExpressBackgroundOrderProjection.CAPTURE_WAIT_MS, deadlineNanos, stopped)));
        } finally { worker.shutdownNow(); }
    }

    /** The worker thread waits on the main looper; the test thread is that looper. */
    private static <T> T pump(Future<T> task) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!task.isDone()) {
            if (System.nanoTime() > until) throw new AssertionError("the round did not finish");
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            Thread.sleep(5);
        }
        Shadows.shadowOf(Looper.getMainLooper()).idle();
        return task.get();
    }

    private static void pumpUntil(BooleanSupplier condition) throws Exception {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > until) throw new AssertionError("the condition was not reached");
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            Thread.sleep(5);
        }
    }

    private static List<String> projectionLines() {
        return ShadowLog.getLogsForTag(ExpressLog.TAG).stream().map(entry -> entry.msg)
                .filter(line -> line.contains(" level=jd_h5 ")).collect(Collectors.toList());
    }

    private static Path source(String relative) {
        Path project = Path.of("app/src/main/java/me/pipi/deliveries", relative);
        return Files.exists(project) ? project : Path.of("src/main/java/me/pipi/deliveries", relative);
    }

    @Implements(value = ExpressDiscoveryClient.class, isInAndroidSdk = false)
    public static class Query {
        static final AtomicInteger calls = new AtomicInteger();
        static final AtomicInteger forced = new AtomicInteger();
        static volatile CountDownLatch gate;

        static void reset() {
            calls.set(0);
            forced.set(0);
            gate = null;
        }

        @Implementation protected ExpressQueryResult refreshKnown(Context ignored, ExpressItem owner,
                boolean force, ExpressQueryCancellation cancellation) throws InterruptedException {
            calls.incrementAndGet();
            if (force) forced.incrementAndGet();
            CountDownLatch held = gate;
            if (held != null) held.await(10, TimeUnit.SECONDS);
            return null;
        }
    }

    @Implements(value = ExpressAutomaticTimelineCapture.class, isInAndroidSdk = false)
    public static class Page {
        static final List<String> providers = new CopyOnWriteArrayList<>();
        static final List<String> owners = new CopyOnWriteArrayList<>();
        static final List<Boolean> hosted = new CopyOnWriteArrayList<>();
        static final List<Boolean> offWindow = new CopyOnWriteArrayList<>();
        static volatile Function<ExpressItem, ExpressAutomaticTimelineCapture.Result> answer;
        @RealObject private ExpressAutomaticTimelineCapture capture;

        static void reset() {
            providers.clear();
            owners.clear();
            hosted.clear();
            offWindow.clear();
            answer = null;
        }

        @Implementation protected void start() {
            ExpressItem owner = ReflectionHelpers.getField(capture, "owner");
            providers.add(ReflectionHelpers.getField(capture, "provider"));
            owners.add(owner.waybill);
            hosted.add(ReflectionHelpers.getField(capture, "host") != null);
            offWindow.add(ReflectionHelpers.getField(capture, "offWindowContext") != null);
            Function<ExpressItem, ExpressAutomaticTimelineCapture.Result> reply = answer;
            ExpressAutomaticTimelineCapture.Callback callback =
                    ReflectionHelpers.getField(capture, "callback");
            callback.complete(reply == null ? null : reply.apply(owner));
        }

        @Implementation protected void cancel() {}
    }

    @Implements(value = ExpressApi.class, isInAndroidSdk = false)
    public static class Carrier {
        static final AtomicInteger calls = new AtomicInteger();

        @Implementation protected void __constructor__(Context ignored) {}

        @Implementation protected CarrierNormalization recognizeCarrier(
                String waybill, ExpressQueryCancellation cancellation) {
            calls.incrementAndGet();
            return new CarrierNormalization("JD", "京东快递", "jd", true, "test");
        }
    }

    @Implements(value = ExpressKuaidi100TimelineCapture.class, isInAndroidSdk = false)
    public static class Kuaidi100Page {
        static final AtomicInteger constructed = new AtomicInteger();

        @Implementation protected void __constructor__(Activity host, String route, String number,
                String savedPhone, ExpressKuaidi100TimelineCapture.Callback callback) {
            constructed.incrementAndGet();
        }

        @Implementation protected boolean start() { return false; }

        @Implementation protected void cancel() {}
    }

    @Implements(value = ExpressScheduler.class, isInAndroidSdk = false)
    public static class Scheduler {
        @Implementation protected static void requestForeground(Context ignored) {}

        @Implementation protected static UUID requestNow(Context ignored) {
            return UUID.randomUUID();
        }
    }
}
