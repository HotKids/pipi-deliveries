package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;
import android.os.SystemClock;

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

import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.notification.ExpressNotifications;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        instrumentedPackages = {"me.pipi.deliveries.data"})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressPhase4ParityAndSideReadTest {
    private Context context;
    private ExpressRepository repository;
    private ExecutorService executor;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        repository = new ExpressRepository(context);
        executor = Executors.newFixedThreadPool(2);
    }

    @After
    public void tearDown() throws Exception {
        executor.shutdownNow();
        assertTrue(executor.awaitTermination(3L, TimeUnit.SECONDS));
        Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test
    public void b03StructuredCompletionProtectsValidClockAndRepairsFutureClock() {
        long now = ExpressSourcePolicy.parseEventTime("2026-11-15 18:00:00");
        SystemClock.setCurrentTimeMillis(now);
        long validCompleted = now - 3_600_000L;
        long futureCompleted = now + 86_400_000L;

        ExpressQueryResult validPacket = new ExpressQueryResult(
                "ZT100000000001", "ZTO", "中通快递", StatusSemantic.COMPLETED, validCompleted,
                "2026-11-15 17:00:00", "快件已签收",
                "[{\"time\":\"2026-11-15 17:00:00\",\"context\":\"快件已签收\"}]",
                "", "", "v6_query", "", "", "")
                .withManualStatusEvidence("已签收", true);
        ExpressQueryResult futurePacket = new ExpressQueryResult(
                "ZT100000000001", "ZTO", "中通快递", StatusSemantic.COMPLETED, futureCompleted,
                "2026-11-16 18:00:00", "快件已签收",
                "[{\"time\":\"2026-11-15 17:00:00\",\"context\":\"快件已签收\"}]",
                "", "", "v4_query", "", "", "")
                .withManualStatusEvidence("已签收", true);

        ManualTimelineAuthorityPolicy.Candidate validCandidate =
                new ManualTimelineAuthorityPolicy.Candidate("v6_query", validPacket, now, true);
        ManualTimelineAuthorityPolicy.Candidate futureCandidate =
                new ManualTimelineAuthorityPolicy.Candidate("v4_query", futurePacket, now, true);

        ManualTimelineAuthorityPolicy.Candidate selected =
                ManualTimelineAuthorityPolicy.selectStructuredStatus(
                        Arrays.asList(futureCandidate, validCandidate));
        assertNotNull(selected);
        assertEquals(validCompleted, selected.result.statusEventTime);

        ManualTimelineAuthorityPolicy.Candidate terminal =
                ManualTimelineAuthorityPolicy.selectStructuredTerminal(
                        Arrays.asList(futureCandidate, validCandidate));
        assertNotNull(terminal);
        assertEquals(validCompleted, terminal.result.statusEventTime);
    }

    @Test
    public void b04OrderStageHeadlineAndRedundantCompletionFilteringMatchParity() throws Exception {
        long now = ExpressSourcePolicy.parseEventTime("2026-11-15 18:00:00");
        JSONObject orderOnly = new JSONObject()
                .put("time", "2026-11-15 17:30:00")
                .put("context", "您的订单已完成")
                .put("normalizedStatus", new JSONObject()
                        .put("version", 1)
                        .put("scope", "ORDER")
                        .put("semantic", "COMPLETED")
                        .put("code", "ORDER_DONE")
                        .put("text", "已完成")
                        .put("priority", 10)
                        .put("eventAtMs", now - 1_800_000L)
                        .put("structured", true)
                        .put("orderStageOnly", true));
        JSONObject shipmentNode = new JSONObject()
                .put("time", "2026-11-15 15:00:00")
                .put("context", "极兔速递已收取快件")
                .put("normalizedStatus", new JSONObject()
                        .put("version", 1)
                        .put("scope", "SHIPMENT")
                        .put("semantic", "PICKED")
                        .put("code", "PICKED")
                        .put("text", "已揽收")
                        .put("priority", 20)
                        .put("eventAtMs", now - 10_800_000L)
                        .put("structured", true));

        ExpressTimeline.Track headlineWithShipment = ExpressTimeline.latestMeaningful(
                new JSONArray().put(orderOnly).put(shipmentNode).toString(),
                StatusSemantic.PICKED);
        assertNotNull(headlineWithShipment);
        assertEquals("极兔速递已收取快件", headlineWithShipment.detail);

        ExpressTimeline.Track headlineOrderOnly = ExpressTimeline.latestMeaningful(
                new JSONArray().put(orderOnly).toString(),
                StatusSemantic.ORDERED);
        assertNotNull(headlineOrderOnly);
        assertEquals("您的订单已完成", headlineOrderOnly.detail);

        String carrierTracks = new JSONArray().put(shipmentNode).toString();
        String ownerTracks = new JSONArray()
                .put(orderOnly)
                .put(new JSONObject().put("time", "2026-11-15 14:20:00")
                        .put("context", "订单已完成"))
                .put(new JSONObject().put("time", "2026-11-15 14:15:00")
                        .put("context", "感谢您在京东购物")
                        .put("logisticsStatusDesc", "评价赢京豆"))
                .put(new JSONObject().put("time", "2026-11-15 14:10:00")
                        .put("context", "您的订单[极兔测试商品]已完成，10京豆等您拿，完成评价即有机会获得，不要错过呦！"))
                .put(new JSONObject().put("time", "2026-11-15 13:30:00")
                        .put("context", "您的订单已经拣货完成，待出库交付极兔速递"))
                .put(new JSONObject().put("time", "2026-11-15 13:00:00")
                        .put("context", "您提交了订单，请等待系统确认"))
                .toString();

        JSONArray appendedOwner = new JSONArray(
                ExpressTimeline.appendOwnerOrderStage(carrierTracks, ownerTracks));
        assertEquals(3, appendedOwner.length());
        assertEquals("极兔速递已收取快件", appendedOwner.getJSONObject(0).getString("context"));
        assertEquals(
                "您的订单已经拣货完成，待出库交付极兔速递",
                appendedOwner.getJSONObject(1).getString("context"));
        assertEquals("您提交了订单，请等待系统确认", appendedOwner.getJSONObject(2).getString("context"));

        JSONArray appendedAttached = new JSONArray(ExpressTimeline.appendAttachedOrderStage(
                carrierTracks, Collections.singletonList(ownerTracks)));
        assertEquals(3, appendedAttached.length());
    }

    @Test
    public void b06NotificationDedupUsesDisplayedHeadlineInsteadOfRawEvidence() throws Exception {
        long t1 = ExpressSourcePolicy.parseEventTime("2026-11-15 16:00:00");
        long t2 = ExpressSourcePolicy.parseEventTime("2026-11-15 16:05:00");
        String tracks1 = new JSONArray()
                .put(new JSONObject()
                        .put("time", "2026-11-15 16:00:00")
                        .put("context", "【兔喜生活】包裹已到站（原始帧A）")
                        .put("displayContext", "快件已送达兔喜生活驿站")
                        .put("_pipiStatusSource", "jt_h5")
                        .put("jtStatusLabel", "待取件"))
                .toString();
        String tracks2 = new JSONArray()
                .put(new JSONObject()
                        .put("time", "2026-11-15 16:05:00")
                        .put("context", "【兔喜生活】包裹已到站（原始帧B）")
                        .put("displayContext", "快件已送达兔喜生活驿站")
                        .put("_pipiStatusSource", "jt_h5")
                        .put("jtStatusLabel", "待取件"))
                .toString();

        ExpressItem previous = new ExpressItem(
                11L, "13900001234", "JT4006839564547", "JTSD", "极兔速递",
                StatusSemantic.WAITING_PICKUP, "待取件",
                "【兔喜生活】包裹已到站（原始帧A）", "2026-11-15 16:00:00", tracks1,
                "", "MANUAL", "", t1, t1, "MANUAL", "", "", "", false,
                "", "", "", "", true, "jt_h5", t1);
        ExpressItem current = new ExpressItem(
                11L, "13900001234", "JT4006839564547", "JTSD", "极兔速递",
                StatusSemantic.WAITING_PICKUP, "待取件",
                "【兔喜生活】包裹已到站（原始帧B）", "2026-11-15 16:05:00", tracks2,
                "", "MANUAL", "", t2, t2, "MANUAL", "", "", "", false,
                "", "", "", "", true, "jt_h5", t2);

        assertEquals("快件已送达兔喜生活驿站", ExpressTimeline.displayHeadline(previous));
        assertEquals("快件已送达兔喜生活驿站", ExpressTimeline.displayHeadline(current));
        assertFalse(ExpressNotifications.shouldPostUpdate(previous, current));
    }

    @Test
    public void b07ListVisibleReadsViaWalSidePoolWithoutBlockingOnRepositoryMonitor()
            throws Exception {
        long now = ExpressSourcePolicy.parseEventTime("2026-11-15 17:00:00");
        ExpressQueryResult initial = new ExpressQueryResult(
                "SF1500000000001", "SF", "顺丰速运", StatusSemantic.TRANSIT, now - 60_000L,
                "2026-11-15 16:59:00", "快件正在发往深圳集散中心",
                "[{\"time\":\"2026-11-15 16:59:00\",\"context\":\"快件正在发往深圳集散中心\"}]",
                "", "", "v6_query", "", "", "")
                .withManualStatusEvidence("运输中", true);
        repository.saveManualQueryBatch(
                null,
                Collections.singletonList(new ManualQuerySuccess("v6_query", initial, now, true)),
                "", "INTERFACE5");

        List<ExpressItem> primed = repository.listVisible("INTERFACE5");
        assertEquals(1, primed.size());
        assertEquals("快件正在发往深圳集散中心", primed.get(0).latestDetail);

        CountDownLatch monitorHeld = new CountDownLatch(1);
        CountDownLatch releaseMonitor = new CountDownLatch(1);
        Future<?> holder = executor.submit(() -> {
            synchronized (repository) {
                monitorHeld.countDown();
                try {
                    releaseMonitor.await(5L, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        });
        assertTrue(monitorHeld.await(2L, TimeUnit.SECONDS));
        try {
            Future<List<ExpressItem>> concurrentRead = executor.submit(
                    () -> repository.listVisible("INTERFACE5"));
            List<ExpressItem> duringHold = concurrentRead.get(2L, TimeUnit.SECONDS);
            assertEquals(1, duringHold.size());
            assertEquals("SF1500000000001", duringHold.get(0).waybill);
        } finally {
            releaseMonitor.countDown();
            holder.get(2L, TimeUnit.SECONDS);
        }

        ExpressQueryResult updated = new ExpressQueryResult(
                "SF1500000000001", "SF", "顺丰速运", StatusSemantic.DELIVERY, now,
                "2026-11-15 17:00:00", "顺丰速运正在为您派件",
                "[{\"time\":\"2026-11-15 17:00:00\",\"context\":\"顺丰速运正在为您派件\"},"
                        + "{\"time\":\"2026-11-15 16:59:00\",\"context\":\"快件正在发往深圳集散中心\"}]",
                "", "", "v6_query", "", "", "")
                .withManualStatusEvidence("派送中", true);
        ExpressItem existing = primed.get(0);
        repository.saveManualQueryBatch(
                existing,
                Collections.singletonList(new ManualQuerySuccess("v6_query", updated, now + 1_000L, true)),
                "", "INTERFACE5");
        List<ExpressItem> refreshed = repository.listVisible("INTERFACE5");
        assertEquals(1, refreshed.size());
        assertEquals(StatusSemantic.DELIVERY, refreshed.get(0).semantic);
        assertEquals("顺丰速运正在为您派件", refreshed.get(0).latestDetail);
    }
}
