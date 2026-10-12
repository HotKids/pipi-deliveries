package me.pipi.deliveries.feature.express;

import static me.pipi.deliveries.FixtureDay.at;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Activity;
import android.app.Application;
import android.content.Context;

import com.google.android.material.progressindicator.LinearProgressIndicator;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.network.ExpressLog;
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
 * 用户 2026-09-28（Pixel 11 Pro，Lite 1.4.0-beta2）：屏幕熄灭打断了详情下拉里的京粉页抓取，这一阶段和整次刷新
 * 都没有结束日志；恢复前台后自动重跑的那次被记成 detail_pull；冷却挡住的京粉页没有一行说明。这里走真实的
 * 详情刷新流程（京粉页抓取换成可控的桩），看日志：阶段有结束，冷却有 skipped，整次刷新以 iOS / Pipi 的
 * detail.refresh.committed / skipped / failed 收尾，自动重跑记 foreground。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {SyntheticSecretBox.class, DetailRefreshDiagnosticsTest.CaptureShadow.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class DetailRefreshDiagnosticsTest {
    private static final String PHONE = "13800009999";
    private static final String ORDER = "3999999000000001";
    private static final String WAYBILL = "JD9990000000001";
    private static final String ROUTE = "https://jingfen.jd.com/item?fixture=9999";
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
        context.getSharedPreferences("express_k100_capture_cooldown", 0).edit().clear().commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        activity.setTheme(R.style.AppTheme);
        CaptureShadow.calls = 0;
        CaptureShadow.pageCalls = 0;
        CaptureShadow.mode = Mode.EMPTY;
        CaptureShadow.pageMode = Mode.EMPTY;
        ShadowLog.clear();
    }

    @After public void tearDown() throws Exception {
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    /** ③ A union-page capture cut off by the page stopping ends its stage, and its cooldown stays spent. */
    @Test public void aCancelledUnionPageCaptureEndsItsStage() throws Exception {
        ExpressItem owner = signedProjectedOrder();
        CaptureShadow.mode = Mode.INTERRUPT;
        try (ExpressLog.Scope ignored = ExpressLog.scope("detail-test", "detail_pull", "v5")) {
            try {
                pullAutomaticDetail(owner);
                org.junit.Assert.fail("the cancellation reaches the refresh");
            } catch (RuntimeException expected) {
                assertTrue(String.valueOf(expected.getCause()),
                        expected.getCause() instanceof InterruptedException);
            }
        }
        assertEquals(1, CaptureShadow.calls);
        String line = only(lines(), " detail.refresh.stage_failed ");
        assertTrue(line, line.contains(" WARNING detail.refresh.stage_failed "));
        assertTrue(line, line.contains(" level=jd_h5 ") && line.contains(" waybillTail=0001 "));
        assertTrue(line, line.endsWith(" errorCategory=cancelled"));
        assertTrue("the interrupted attempt keeps the order's cooldown",
                new ExpressOrderProjectionRetryStore(context).timelineCooldownUntil(owner)
                        > System.currentTimeMillis());
    }

    /** ③ A union page still cooling down is a logged skip; the page is not opened. */
    @Test public void aCoolingUnionPageIsALoggedSkip() throws Exception {
        ExpressItem owner = signedProjectedOrder();
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(context);
        retries.endAttempt(retries.beginTimelineAttempt(owner, System.currentTimeMillis()));
        try (ExpressLog.Scope ignored = ExpressLog.scope("detail-test", "detail_pull", "v5")) {
            pullAutomaticDetail(owner);
        }
        assertEquals(0, CaptureShadow.calls);
        String line = only(lines(), " detail.refresh.stage_skipped ");
        assertTrue(line, line.contains(" INFO detail.refresh.stage_skipped ")
                && line.contains(" level=jd_h5 ") && line.contains(" result=skipped "));
        assertTrue(line, line.endsWith(" gateReason=cooldown"));
    }

    /** ③ A refresh that changed what the page shows ends committed. */
    @Test public void aRefreshThatChangesTheDetailEndsCommitted() throws Exception {
        ExpressItem owner = signedProjectedOrder();
        CaptureShadow.mode = Mode.SIGNED_PAGE;
        runPull(owner, false);
        assertEquals(1, CaptureShadow.calls);
        List<String> lines = lines();
        String end = only(lines, " detail.refresh.committed ");
        assertTrue(end, end.contains(" INFO detail.refresh.committed ") && end.contains(" trigger=detail_pull ")
                && end.contains(" waybillTail=0001 ") && end.contains(" result=committed ")
                && end.contains(" persisted=true ") && end.contains(" detailTimelineProvider=jd_h5 "));
        assertEquals(sameFlow(lines, "detail.refresh.started"), sameFlow(lines, "detail.refresh.committed"));
        assertNoOtherEnd(lines, "committed");
    }

    /** ③ A refresh whose page answered nothing ends skipped as iOS's empty_response. */
    @Test public void aRefreshThatChangesNothingEndsSkipped() throws Exception {
        ExpressItem owner = signedProjectedOrder();
        runPull(owner, false);
        String end = only(lines(), " detail.refresh.skipped ");
        assertTrue(end, end.contains(" result=empty_response ") && end.contains(" skipReason=empty_response ")
                && end.contains(" persisted=false "));
        assertNoOtherEnd(lines(), "skipped");
    }

    /** ③ A refresh that threw ends failed, with the failure's category and not its class name. */
    @Test public void aRefreshThatThrowsEndsFailed() throws Exception {
        ExpressItem owner = signedProjectedOrder();
        CaptureShadow.mode = Mode.THROW;
        runPull(owner, false);
        String end = only(lines(), " detail.refresh.failed ");
        assertTrue(end, end.contains(" WARNING detail.refresh.failed ") && end.contains(" result=failed ")
                && end.contains(" persisted=false ") && end.contains(" errorCategory=unknown"));
        assertFalse(end, end.contains("IllegalStateException"));
        assertNoOtherEnd(lines(), "failed");
    }

    /** ③ A refresh the page stopped ends skipped as interrupted (Pipi's INTERRUPTED). */
    @Test public void aStoppedRefreshEndsInterrupted() throws Exception {
        ExpressItem owner = signedProjectedOrder();
        CaptureShadow.mode = Mode.INTERRUPT;
        runPull(owner, false);
        List<String> lines = lines();
        assertTrue(only(lines, " detail.refresh.stage_failed ").endsWith(" errorCategory=cancelled"));
        String end = only(lines, " detail.refresh.skipped ");
        assertTrue(end, end.contains(" skipReason=interrupted ") && end.contains(" persisted=false "));
        assertNoOtherEnd(lines, "skipped");
    }

    /** ③ A row gone before the refresh ran ends skipped as removed. */
    @Test public void aRefreshOfARemovedRowEndsSkipped() throws Exception {
        ExpressItem owner = signedProjectedOrder();
        repository.delete(owner.rowId);
        runPull(owner, false);
        String end = only(lines(), " detail.refresh.skipped ");
        assertTrue(end, end.contains(" skipReason=removed "));
    }

    /**
     * ③ The refresh restarted when the page comes back to the foreground is not the user's pull: it is
     * logged with the foreground trigger, and its stages are still detail refresh stages.
     */
    @Test public void aRestartedRefreshIsNotLoggedAsAPull() throws Exception {
        ExpressItem owner = signedProjectedOrder();
        runPull(owner, true);
        List<String> lines = lines();
        String started = only(lines, " detail.refresh.started ");
        assertTrue(started, started.contains(" trigger=foreground "));
        String stage = only(lines, " detail.refresh.stage_started ");
        assertTrue(stage, stage.contains(" trigger=foreground ") && stage.contains(" level=jd_h5 "));
        assertFalse(lines.toString(), lines.toString().contains("trigger=detail_pull"));
        assertFalse(ReflectionHelpers.<Boolean>getField(activity, "localRefreshRestart"));
    }

    /** Left for later ①: a Cainiao page cut off by the page stopping ends its stage too. */
    @Test public void aCancelledCainiaoPageCaptureEndsItsStage() throws Exception {
        ExpressItem parcel = cainiaoParcel();
        CaptureShadow.mode = Mode.INTERRUPT;
        try (ExpressLog.Scope ignored = ExpressLog.scope("detail-test", "detail_pull", "v5")) {
            try {
                pullAutomaticDetail(parcel);
                org.junit.Assert.fail("the cancellation reaches the refresh");
            } catch (RuntimeException expected) {
                assertTrue(String.valueOf(expected.getCause()),
                        expected.getCause() instanceof InterruptedException);
            }
        }
        assertEquals(1, CaptureShadow.calls);
        String line = only(lines(), " detail.refresh.stage_failed ");
        assertTrue(line, line.contains(" WARNING detail.refresh.stage_failed ") && line.contains(" level=cn_h5 "));
        assertTrue(line, line.endsWith(" errorCategory=cancelled"));
    }

    /** Left for later ③: an order whose page another capture holds is iOS's active_attempt skip. */
    @Test public void anOrderWhosePageIsAlreadyOpenIsAnActiveAttemptSkip() throws Exception {
        ExpressItem owner = signedProjectedOrder();
        ExpressOrderProjectionRetryStore.AttemptToken held = ExpressOrderProjectionRetryStore.acquireAttempt(owner);
        assertNotNull(held);
        try (ExpressLog.Scope ignored = ExpressLog.scope("detail-test", "detail_pull", "v5")) {
            pullAutomaticDetail(owner);
        } finally {
            ExpressOrderProjectionRetryStore.releaseAttempt(held);
        }
        assertEquals(0, CaptureShadow.calls);
        assertTrue(only(lines(), " detail.refresh.stage_skipped ").endsWith(" gateReason=active_attempt"));
    }

    /** Left for later ③: the hour after JD risk control is iOS's risk_control_cooldown, not the ten minutes. */
    @Test public void aRiskControlledOrderIsARiskControlSkip() throws Exception {
        ExpressItem owner = signedProjectedOrder();
        new ExpressOrderProjectionRetryStore(context).recordTimelineRateLimit(owner, System.currentTimeMillis());
        try (ExpressLog.Scope ignored = ExpressLog.scope("detail-test", "detail_pull", "v5")) {
            pullAutomaticDetail(owner);
        }
        assertEquals(0, CaptureShadow.calls);
        assertTrue(only(lines(), " detail.refresh.stage_skipped ").endsWith(" gateReason=risk_control_cooldown"));
    }

    /**
     * Left for later ④: the K100 page asked for a JD row names that row as iOS does — its own source and
     * waybill tail, with k100_h5 as the request provider — instead of the generic "manual".
     */
    @Test public void theK100StageNamesItsRow() throws Exception {
        ExpressItem owner = signedProjectedOrder(false);
        runPull(owner, false);
        assertEquals(1, CaptureShadow.pageCalls);
        List<String> lines = lines();
        String started = lines.stream().filter(line -> line.contains(" detail.refresh.stage_started ")
                && line.contains(" level=k100_h5 ")).findFirst().orElseThrow(() -> new AssertionError(lines));
        assertTrue(started, started.contains(" sourceProvider=jingdong ") && started.contains(" waybillTail=0001 ")
                && started.contains(" requestProvider=k100_h5") && started.contains(" timelineProvider=k100_h5 "));
        String ended = lines.stream().filter(line -> line.contains(" detail.refresh.stage_failed ")
                && line.contains(" level=k100_h5 ")).findFirst().orElseThrow(() -> new AssertionError(lines));
        assertTrue(ended, ended.contains(" sourceProvider=jingdong ") && ended.contains(" waybillTail=0001 ")
                && ended.contains(" requestProvider=k100_h5 "));
        assertFalse(lines.toString(), lines.stream().anyMatch(line -> line.contains(" level=k100_h5 ")
                && line.contains(" sourceProvider=manual ")));
    }

    /** Round 3 ②: a K100 page cut off mid-query ends its stage as cancelled; the flow still ends interrupted. */
    @Test public void aCancelledK100PageEndsItsStage() throws Exception {
        ExpressItem owner = signedProjectedOrder(false);
        CaptureShadow.pageMode = Mode.INTERRUPT;
        runPull(owner, false);
        assertEquals(1, CaptureShadow.pageCalls);
        List<String> lines = lines();
        String ended = lines.stream().filter(line -> line.contains(" detail.refresh.stage_failed ")
                && line.contains(" level=k100_h5 ")).findFirst().orElseThrow(() -> new AssertionError(lines));
        assertTrue(ended, ended.contains(" WARNING detail.refresh.stage_failed ")
                && ended.contains(" waybillTail=0001 ") && ended.endsWith(" errorCategory=cancelled"));
        String end = only(lines, " detail.refresh.skipped ");
        assertTrue(end, end.contains(" skipReason=interrupted "));
    }

    /**
     * Round 3 ③: the K100 stage lines carry iOS shipmentDiagnosticDetails for the row — identity, route kind,
     * how the detail is shown (display scope) — and the answer's own fields once there is one.
     */
    @Test public void theK100StageCarriesTheIosRowFields() throws Exception {
        ExpressItem owner = signedProjectedOrder(false);
        runPull(owner, false);
        List<String> lines = lines();
        String started = lines.stream().filter(line -> line.contains(" detail.refresh.stage_started ")
                && line.contains(" level=k100_h5 ")).findFirst().orElseThrow(() -> new AssertionError(lines));
        for (String field : new String[]{" automatic=true ", " carrierCode=JD ", " routeKind=none ",
                " routePointerPresent=false ", " requestProvider=k100_h5 ", " displayTimelineProvider=v5_list ",
                " effectiveTrackCount=", " selectionScope=display ", " displayedTrackCount=", " latestEventAtMs=",
                " latestTrackAtMs=", " feedEventAtMs=", " statusEventAtMs=", " statusSemantic=COMPLETED ",
                " structuredStatus=true"}) {
            assertTrue(field + " in " + started, started.contains(field));
        }
        String ended = lines.stream().filter(line -> line.contains(" detail.refresh.stage_failed ")
                && line.contains(" level=k100_h5 ")).findFirst().orElseThrow(() -> new AssertionError(lines));
        assertTrue(ended, ended.contains(" selectionScope=display ") && ended.contains(" result=failed ")
                && ended.contains(" exitReason=no_timed_tracks") && !ended.contains(" result=no_timed_tracks")
                && ended.contains(" carrierCode=JD ") && ended.contains(" durationMs="));
    }

    @Test public void aK100PageAnswerCarriesTheResponseFields() throws Exception {
        ExpressItem owner = signedProjectedOrder(false);
        CaptureShadow.pageMode = Mode.SIGNED_PAGE;
        runPull(owner, false);
        List<String> lines = lines();
        String answered = lines.stream().filter(line -> line.contains(" detail.refresh.stage_succeeded ")
                && line.contains(" level=k100_h5 ")).findFirst().orElseThrow(() -> new AssertionError(lines));
        assertTrue(answered, answered.contains(" selectionScope=query_response ")
                && answered.contains(" effectiveTrackCount=3 ") && answered.contains(" result=succeeded ")
                && answered.contains(" exitReason=timed_tracks") && !answered.contains(" result=timed_tracks")
                && answered.contains(" displayedTrackCount=") && answered.contains(" automatic=true ")
                && answered.contains(" requestProvider=k100_h5 ") && !answered.contains(" feedEventAtMs="));
    }

    /**
     * A K100 page still cooling down is skipped before its stage starts, as iOS logs a stage it does not
     * attempt; a refresh that ran nothing else ends skipped as not_attempted, not empty_response.
     */
    @Test public void aCoolingK100PageEndsTheRefreshNotAttempted() throws Exception {
        ExpressItem owner = signedProjectedOrder(false);
        long now = System.currentTimeMillis();
        ExpressOrderProjectionRetryStore retries = new ExpressOrderProjectionRetryStore(context);
        retries.endAttempt(retries.beginTimelineAttempt(owner, now));
        ExpressKuaidi100CaptureCooldown.record(context, owner.displayWaybill(), now);
        runPull(owner, false);
        assertEquals(0, CaptureShadow.calls);
        assertEquals(0, CaptureShadow.pageCalls);
        List<String> lines = lines();
        String skipped = lines.stream().filter(line -> line.contains(" detail.refresh.stage_skipped ")
                && line.contains(" level=k100_h5 ")).findFirst().orElseThrow(() -> new AssertionError(lines));
        assertTrue(skipped, skipped.contains(" INFO detail.refresh.stage_skipped ")
                && skipped.contains(" result=skipped ") && skipped.contains(" waybillTail=0001 ")
                && skipped.endsWith(" gateReason=cooldown"));
        assertFalse(lines.toString(), lines.stream().anyMatch(line -> line.contains(" level=k100_h5 ")
                && (line.contains(" detail.refresh.stage_started ") || line.contains(" detail.refresh.stage_failed "))));
        String end = only(lines, " detail.refresh.skipped ");
        assertTrue(end, end.contains(" skipReason=not_attempted "));
        assertNoOtherEnd(lines, "skipped");
    }

    private void pullAutomaticDetail(ExpressItem owner) {
        ReflectionHelpers.callInstanceMethod(activity, "refreshAutomaticDetail",
                ClassParameter.from(ExpressRepository.class, repository),
                ClassParameter.from(ExpressItem.class, owner),
                ClassParameter.from(ExpressQueryCancellation.class, new ExpressQueryCancellation(5_000L)),
                ClassParameter.from(boolean.class, true));
    }

    /** One pull through the page's own background refresh, run on this thread. */
    private void runPull(ExpressItem owner, boolean restartedOnStart) {
        QueuedExecutor worker = new QueuedExecutor();
        ReflectionHelpers.setField(activity, "worker", worker);
        ReflectionHelpers.setField(activity, "item", owner);
        ReflectionHelpers.setField(activity, "nativeProgress", new LinearProgressIndicator(activity));
        ReflectionHelpers.setField(activity, "detailEntryObserved", true);
        ReflectionHelpers.setField(activity, "pullRefreshRequested", true);
        if (restartedOnStart) ReflectionHelpers.setField(activity, "localRefreshRestart", true);
        ReflectionHelpers.callInstanceMethod(activity, "refreshLocalTimelineInBackground",
                ClassParameter.from(boolean.class, false));
        if (restartedOnStart) ReflectionHelpers.setField(activity, "localRefreshRestart", false);
        assertEquals(1, worker.tasks.size());
        // The page itself is not laid out here: move its generation on so the task's UI callbacks
        // see a superseded refresh and leave the (absent) views alone.
        int generation = ReflectionHelpers.getField(activity, "localRefreshGeneration");
        ReflectionHelpers.setField(activity, "localRefreshGeneration", generation + 1);
        worker.tasks.get(0).run();
    }

    /** 已签收（结构化，完成时间比签收晚八个多小时）、已投影、feed 有揽收、带可信京粉页路由的订单行。 */
    private ExpressItem signedProjectedOrder() throws Exception {
        return signedProjectedOrder(true);
    }

    /** {@code withPickup} false: the feed stops at delivery, so a pull goes on to the K100 page. */
    private ExpressItem signedProjectedOrder(boolean withPickup) throws Exception {
        long completedAt = ExpressTimeline.parseTime(COMPLETED_AT);
        String[][] nodes = withPickup ? new String[][]{
                {COMPLETED_AT, REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}} : new String[][]{
                {COMPLETED_AT, REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING}};
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

    /** An interface-5 Cainiao-source waybill row in transit, with its own trusted route. */
    private ExpressItem cainiaoParcel() throws Exception {
        String id = "YT9990000000001";
        String time = at("2026-09-24 08:00:00");
        String node = "【上海市】快件已到达 上海转运中心";
        ExpressQueryResult feed = new ExpressQueryResult(id, "YTO", "圆通速递", StatusSemantic.TRANSIT,
                ExpressTimeline.parseTime(time), time, node, tracks(new String[][]{{time, node}}),
                me.pipi.deliveries.model.CainiaoRoute.token("v5"), PHONE, TimelineSlot.V5_QUERY, "v5",
                "https://page.cainiao.com/detail?secretkey=synthetic9999", "CaiNiao");
        repository.saveInterface5(feed, PHONE);
        ExpressItem row = repository.findByWaybill(id, "interface5");
        assertNotNull(row);
        assertTrue(repository.saveRecoveredOwnerRoute(row, repository.captureManualQueryOwner(row), feed));
        row = repository.find(row.rowId);
        assertFalse(ExpressDetailActivity.safeCainiaoUrl(row).isEmpty());
        return row;
    }

    private static ExpressQueryResult signedPage() throws Exception {
        return new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L,
                COMPLETED_AT, SIGNED, tracks(new String[][]{
                        {COMPLETED_AT, SIGNED},
                        {at("2026-09-23 08:02:00"), DELIVERING},
                        {at("2026-09-22 21:48:11"), PICKUP}}),
                "", "", TimelineSlot.JD_H5, "", "", "");
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        }
        return value.toString();
    }

    private static List<String> lines() {
        return ShadowLog.getLogsForTag(ExpressLog.TAG).stream().map(row -> row.msg)
                .collect(Collectors.toList());
    }

    private static String only(List<String> lines, String marker) {
        List<String> found = lines.stream().filter(line -> line.contains(marker)).collect(Collectors.toList());
        assertEquals(lines.toString(), 1, found.size());
        return found.get(0);
    }

    private static String sameFlow(List<String> lines, String event) {
        String line = lines.stream().filter(value -> value.contains(" " + event + " ")).findFirst().orElse("");
        int start = line.indexOf(" flowId=");
        return start < 0 ? "" : line.substring(start, line.indexOf(' ', start + 1));
    }

    private static void assertNoOtherEnd(List<String> lines, String expected) {
        for (String end : new String[]{"committed", "skipped", "failed"}) {
            if (end.equals(expected)) continue;
            assertFalse(lines.toString(), lines.stream().anyMatch(line -> line.contains(" detail.refresh." + end + " ")));
        }
    }

    enum Mode { EMPTY, SIGNED_PAGE, THROW, INTERRUPT }

    @Implements(ExpressAutomaticTimelineCapture.class)
    public static class CaptureShadow {
        static int calls;
        static int pageCalls;
        static Mode mode;

        static Mode pageMode;

        /** The primary H5 page (K100 / J&T) a pull opens: nothing, a cut-off capture, or a three-node page. */
        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider, List<String> phones,
                ExpressQueryCancellation cancellation) throws InterruptedException {
            pageCalls++;
            switch (pageMode) {
                case INTERRUPT: throw new InterruptedException("Express query cancelled");
                case SIGNED_PAGE:
                    try {
                        ExpressQueryResult page = signedPage();
                        return new ExpressAutomaticTimelineCapture.Result(new ExpressQueryResult(
                                page.waybill, page.courierCode, page.companyName, page.semantic,
                                page.statusEventTime, page.latestTime, page.latestDetail, page.tracksJson,
                                "", "", TimelineSlot.K100_H5, "", "", ""), true, false);
                    } catch (Exception failure) {
                        throw new AssertionError(failure);
                    }
                default: return null;
            }
        }

        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider,
                ExpressQueryCancellation cancellation) throws InterruptedException {
            calls++;
            switch (mode) {
                case INTERRUPT: throw new InterruptedException("Express query cancelled");
                case THROW: throw new IllegalStateException("Synthetic private page failure");
                case SIGNED_PAGE:
                    try {
                        return new ExpressAutomaticTimelineCapture.Result(signedPage(), true, false);
                    } catch (Exception failure) {
                        throw new AssertionError(failure);
                    }
                default: return null;
            }
        }
    }

    private static final class QueuedExecutor extends AbstractExecutorService {
        final List<Runnable> tasks = new ArrayList<>();
        private boolean stopped;
        @Override public void execute(Runnable task) { tasks.add(task); }
        @Override public void shutdown() { stopped = true; }
        @Override public List<Runnable> shutdownNow() { stopped = true; return tasks; }
        @Override public boolean isShutdown() { return stopped; }
        @Override public boolean isTerminated() { return stopped; }
        @Override public boolean awaitTermination(long timeout, TimeUnit unit) { return stopped; }
    }
}
