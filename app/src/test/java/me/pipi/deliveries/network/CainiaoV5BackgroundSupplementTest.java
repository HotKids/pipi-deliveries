package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.app.NotificationManager;
import android.content.Context;

import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

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
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.util.ReflectionHelpers;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class CainiaoV5BackgroundSupplementTest {
    private static final String PHONE = "13900001888";
    private static final String WAYBILL = "YT2611160000188";
    private static final String GENERIC = "快递状态已更新，点击查看>>";
    private static final long MINUTE = 60_000L;
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));

    private Context context;
    private ExpressRepository repository;
    private final AtomicLong nowMs = new AtomicLong();
    private FakeGateway gateway;
    private ExpressDiscoveryClient client;
    private long dayBaseMs;

    @Before
    public void setUp() throws Exception {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String prefs : new String[]{
                "deliveries_repository_migrations",
                "express_interface5_sync_v2",
                "express_account_source",
                "express_network_success",
                "express_notifications"
        }) {
            context.getSharedPreferences(prefs, 0).edit().clear().commit();
        }
        context.getSharedPreferences("express_account_source", 0)
                .edit().putString("active_interface", "v5").commit();
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        dayBaseMs = (System.currentTimeMillis() - 6L * 60L * MINUTE) / 1000L * 1000L;
        nowMs.set(dayBaseMs);
        gateway = new FakeGateway();
        JSONObject identity = new JSONObject().put("synthetic", true);
        client = new ExpressDiscoveryClient(gateway, identity);
        client.setClockForTest(nowMs::get);
        Supplier<ExpressDiscoveryClient> factory = () -> {
            ExpressDiscoveryClient instance = new ExpressDiscoveryClient(gateway, identity);
            instance.setClockForTest(nowMs::get);
            return instance;
        };
        ReflectionHelpers.setStaticField(
                Class.forName("me.pipi.deliveries.background.ExpressSyncEngine"),
                "discoveryFactory", factory);
        Shadows.shadowOf((Application) context)
                .grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS);
        context.getSystemService(NotificationManager.class).cancelAll();
    }

    @After
    public void tearDown() throws Exception {
        Supplier<ExpressDiscoveryClient> defaultFactory = ExpressDiscoveryClient::new;
        ReflectionHelpers.setStaticField(
                Class.forName("me.pipi.deliveries.background.ExpressSyncEngine"),
                "discoveryFactory", defaultFactory);
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test
    public void accountPhasePublishesBeforeCainiaoDetailSupplementRuns() throws Exception {
        String pickedTime = formatOffset(0);
        gateway.list = new JSONArray().put(listItem(WAYBILL, 103, pickedTime, GENERIC));
        gateway.detailHandler = waybill -> detailResponse(waybill, 103,
                new String[][]{{pickedTime, "广东东莞公司 已揽收"}});
        AtomicBoolean accountPhaseSawPublishedListBeforeQuery = new AtomicBoolean();
        AtomicBoolean detailQueryRanAfterAccountPhase = new AtomicBoolean();
        AtomicBoolean accountPhaseCallbackFired = new AtomicBoolean();

        gateway.onDetailRequest = () -> {
            List<ExpressItem> visibleDuringQuery = repository.listVisible("interface5");
            if (visibleDuringQuery.size() == 1 && accountPhaseCallbackFired.get()) {
                detailQueryRanAfterAccountPhase.set(true);
            }
        };

        int[] network = new int[]{0, 0, 0};
        runSyncEngine(network, true, "list_pull", () -> {
            accountPhaseCallbackFired.set(true);
            if (gateway.detailRequests.isEmpty()
                    && repository.listVisible("interface5").size() == 1
                    && repository.accountTimeline(WAYBILL, "interface5") == null) {
                accountPhaseSawPublishedListBeforeQuery.set(true);
            }
        });

        assertTrue("E1 account phase must publish before v5_query starts",
                accountPhaseSawPublishedListBeforeQuery.get());
        assertTrue("v5_query must run in the post-account supplement phase",
                detailQueryRanAfterAccountPhase.get());
        assertEquals(Collections.singletonList(WAYBILL), gateway.detailRequests);
        ExpressItem after = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(after);
        assertEquals(StatusSemantic.PICKED, after.semantic);
        assertEquals("广东东莞公司 已揽收", after.latestDetail);
    }

    @Test
    public void interruptedFirstRoundHoldsAlignedBaselineAndSecondRoundCompletesWithoutListChange()
            throws Exception {
        String pickedTime = formatOffset(0);       // e.g. 14:46
        String transitTime = formatOffset(261);    // e.g. 19:07 (+4h21m)

        // Round 0: initial aligned PICKED baseline at 14:46.
        nowMs.set(dayBaseMs + 2L * MINUTE);
        gateway.list = new JSONArray().put(listItem(WAYBILL, 103, pickedTime, GENERIC));
        gateway.detailHandler = waybill -> detailResponse(waybill, 103,
                new String[][]{{pickedTime, "广东东莞公司 已揽收"}});
        runSyncEngine(new int[]{0, 0, 0}, false, "background", null);
        repository.replayPendingNotifications();

        ExpressItem baseline = repository.findByWaybill(WAYBILL, "interface5");
        assertNotNull(baseline);
        assertEquals(StatusSemantic.PICKED, baseline.semantic);
        assertEquals("广东东莞公司 已揽收", baseline.latestDetail);
        assertFalse(repository.cainiaoHasTrajectoryGap(baseline));
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        nm.cancelAll();

        // Round 1 (19:07): v5_list advances to TRANSIT, but v5_query times out.
        gateway.detailRequests.clear();
        nowMs.set(dayBaseMs + 261L * MINUTE);
        gateway.list = new JSONArray().put(listItem(WAYBILL, 104, transitTime, GENERIC));
        gateway.detailHandler = waybill -> {
            throw new SocketTimeoutException("Read timed out");
        };
        runSyncEngine(new int[]{0, 0, 0}, false, "background", null);
        repository.replayPendingNotifications();

        assertEquals(Collections.singletonList(WAYBILL), gateway.detailRequests);
        ExpressItem afterFailedRound1 = repository.listVisible("interface5").get(0);
        ExpressQueryResult rawSource = repository.automaticSourceTimeline(afterFailedRound1);
        assertEquals(StatusSemantic.TRANSIT, rawSource.semantic);
        assertEquals(ExpressTimeline.parseTime(transitTime), rawSource.statusEventTime);
        assertTrue(repository.cainiaoHasTrajectoryGap(afterFailedRound1));
        assertEquals(StatusSemantic.PICKED, afterFailedRound1.semantic);
        assertEquals("广东东莞公司 已揽收", afterFailedRound1.latestDetail);
        assertEquals(pickedTime, afterFailedRound1.latestTime);
        assertEquals("No torn notification while headline is still at 14:46 PICKED",
                0, Shadows.shadowOf(nm).size());

        // Inside 1-minute initial timeout backoff (+30s): unchanged list does not hammer upstream.
        gateway.detailRequests.clear();
        nowMs.set(dayBaseMs + 261L * MINUTE + 30_000L);
        runSyncEngine(new int[]{0, 0, 0}, false, "background", null);
        assertTrue(gateway.detailRequests.isEmpty());

        // Round 2 (19:20, +13m): v5_list is UNCHANGED, persistent gap check triggers v5_query and succeeds!
        gateway.detailRequests.clear();
        nowMs.set(dayBaseMs + 274L * MINUTE);
        gateway.detailHandler = waybill -> detailResponse(waybill, 104, new String[][]{
                {transitTime, "快件离开东莞中心，正发往深圳"},
                {pickedTime, "广东东莞公司 已揽收"}
        });
        runSyncEngine(new int[]{0, 0, 0}, false, "background", null);
        repository.replayPendingNotifications();

        assertEquals(Collections.singletonList(WAYBILL), gateway.detailRequests);
        ExpressItem afterRound2 = repository.listVisible("interface5").get(0);
        assertFalse(repository.cainiaoHasTrajectoryGap(afterRound2));
        assertEquals(StatusSemantic.TRANSIT, afterRound2.semantic);
        assertEquals("快件离开东莞中心，正发往深圳", afterRound2.latestDetail);
        assertEquals(transitTime, afterRound2.latestTime);
        assertTrue("Aligned v5_query advancing displayed status must emit status notification",
                Shadows.shadowOf(nm).size() >= 1);
    }

    @Test
    public void staleQueryHoldsBaselineAndEnforcesNoResultTimeoutAndRiskControlCooldowns() throws Exception {
        String pickedTime = formatOffset(0);
        String transitTime = formatOffset(60);
        String transit2Time = formatOffset(70);
        String deliveryTime = formatOffset(95);

        // Initial aligned PICKED baseline.
        nowMs.set(dayBaseMs + MINUTE);
        gateway.list = new JSONArray().put(listItem(WAYBILL, 103, pickedTime, GENERIC));
        gateway.detailHandler = waybill -> detailResponse(waybill, 103,
                new String[][]{{pickedTime, "广东东莞公司 已揽收"}});
        client.sync(context, Collections.singletonList(PHONE), false);

        // List advances to TRANSIT (+60m), but v5_query returns stale PICKED tracks from +0m (> 5m older).
        gateway.detailRequests.clear();
        nowMs.set(dayBaseMs + 60L * MINUTE);
        gateway.list = new JSONArray().put(listItem(WAYBILL, 104, transitTime, GENERIC));
        gateway.detailHandler = waybill -> detailResponse(waybill, 103,
                new String[][]{{pickedTime, "广东东莞公司 已揽收"}});
        client.sync(context, Collections.singletonList(PHONE), false);

        assertEquals(Collections.singletonList(WAYBILL), gateway.detailRequests);
        ExpressItem held = repository.listVisible("interface5").get(0);
        assertEquals(StatusSemantic.PICKED, held.semantic);
        assertEquals("广东东莞公司 已揽收", held.latestDetail);
        assertTrue(repository.cainiaoHasTrajectoryGap(held));

        // 5m no_result cooldown: blocked at +2m, allowed at +5m (+65m).
        gateway.detailRequests.clear();
        nowMs.set(dayBaseMs + 62L * MINUTE);
        client.sync(context, Collections.singletonList(PHONE), false);
        assertTrue("5m no_result cooldown must hold at +2m", gateway.detailRequests.isEmpty());

        nowMs.set(dayBaseMs + 65L * MINUTE);
        gateway.detailHandler = waybill -> detailResponse(waybill, 104, new String[][]{
                {transitTime, "快件离开东莞中心"},
                {pickedTime, "广东东莞公司 已揽收"}
        });
        client.sync(context, Collections.singletonList(PHONE), false);
        assertEquals("5m no_result cooldown expires at +5m", 1, gateway.detailRequests.size());
        assertEquals(StatusSemantic.TRANSIT, repository.listVisible("interface5").get(0).semantic);

        // New list clock (+70m): timeout #1 -> 1m initial backoff, timeout #2 at +71m -> 2m backoff.
        gateway.detailRequests.clear();
        nowMs.set(dayBaseMs + 70L * MINUTE);
        gateway.list = new JSONArray().put(listItem(WAYBILL, 104, transit2Time, GENERIC));
        gateway.detailHandler = waybill -> {
            throw new SocketTimeoutException("timeout #1");
        };
        client.sync(context, Collections.singletonList(PHONE), false);
        assertEquals(1, gateway.detailRequests.size());

        gateway.detailRequests.clear();
        nowMs.set(dayBaseMs + 70L * MINUTE + 30_000L);
        client.sync(context, Collections.singletonList(PHONE), false);
        assertTrue("1m initial timeout backoff blocks at +30s", gateway.detailRequests.isEmpty());

        gateway.detailRequests.clear();
        nowMs.set(dayBaseMs + 71L * MINUTE);
        client.sync(context, Collections.singletonList(PHONE), false);
        assertEquals("2nd consecutive failure starts after 1m initial timeout backoff",
                1, gateway.detailRequests.size());

        gateway.detailRequests.clear();
        nowMs.set(dayBaseMs + 72L * MINUTE);
        client.sync(context, Collections.singletonList(PHONE), false);
        assertTrue("Exponential 2m backoff after 2nd timeout blocks at +1m",
                gateway.detailRequests.isEmpty());

        // At +73m (2m elapsed), upstream returns HTTP 429 risk-control -> 60m backoff blocking even new tuple!
        nowMs.set(dayBaseMs + 73L * MINUTE);
        gateway.detailHandler = waybill -> new HttpClient.Response(
                429, "{\"code\":429,\"error\":\"rate_limited\",\"message\":\"操作过于频繁\"}"
                        .getBytes(StandardCharsets.UTF_8));
        client.sync(context, Collections.singletonList(PHONE), false);
        assertEquals(1, gateway.detailRequests.size());

        gateway.detailRequests.clear();
        nowMs.set(dayBaseMs + 95L * MINUTE); // +22m (< 60m), even with a brand new DELIVERY list update!
        gateway.list = new JSONArray().put(listItem(WAYBILL, 105, deliveryTime, GENERIC));
        client.sync(context, Collections.singletonList(PHONE), false);
        assertTrue("60m risk-control backoff must block even a new list tuple",
                gateway.detailRequests.isEmpty());

        // At +134m (> 60m after +73m), risk-control backoff expires and query succeeds.
        nowMs.set(dayBaseMs + 134L * MINUTE);
        gateway.detailHandler = waybill -> detailResponse(waybill, 105, new String[][]{
                {deliveryTime, "深圳南山营业部 派件员正在为您派件"},
                {transit2Time, "快件到达深圳转运中心"},
                {transitTime, "快件离开东莞中心"},
                {pickedTime, "广东东莞公司 已揽收"}
        });
        client.sync(context, Collections.singletonList(PHONE), false);
        assertEquals(1, gateway.detailRequests.size());
        ExpressItem aligned = repository.listVisible("interface5").get(0);
        assertEquals(StatusSemantic.DELIVERY, aligned.semantic);
        assertEquals("深圳南山营业部 派件员正在为您派件", aligned.latestDetail);
    }

    @Test
    public void lateQueryDoesNotRegressCnH5AlignedStateAndCnH5WithinFiveMinutesSatisfiesGap()
            throws Exception {
        String pickedTime = formatOffset(0);
        String transitTime = formatOffset(60);
        String cnH5Time = formatOffset(66);      // 19:13 (within 5m of 19:14!)
        String deliveryTime = formatOffset(67);  // 19:14

        nowMs.set(dayBaseMs + MINUTE);
        gateway.list = new JSONArray().put(listItem(WAYBILL, 103, pickedTime, GENERIC));
        gateway.detailHandler = waybill -> detailResponse(waybill, 103,
                new String[][]{{pickedTime, "广东东莞公司 已揽收"}});
        client.sync(context, Collections.singletonList(PHONE), false);

        // List updates to 19:14 DELIVERY while cn_h5 already captured 19:13 DELIVERY track (within 5m).
        ExpressItem owner = repository.findByWaybill(WAYBILL, "interface5");
        String cnH5Tracks = new JSONArray()
                .put(new JSONObject().put("time", cnH5Time).put("context", "派送中，快递员张三正在派件"))
                .put(new JSONObject().put("time", pickedTime).put("context", "广东东莞公司 已揽收"))
                .toString();
        ExpressQueryResult cnH5 = new ExpressQueryResult(WAYBILL, "YTO", "圆通速递",
                StatusSemantic.DELIVERY, ExpressTimeline.parseTime(cnH5Time),
                cnH5Time, "派送中，快递员张三正在派件", cnH5Tracks, "", PHONE,
                TimelineSlot.CN_H5, "", "", "CaiNiao");
        assertTrue(repository.saveAutomaticDetailTimeline(
                owner, repository.captureManualQueryOwner(owner), cnH5, true));

        ExpressQueryResult deliveryFeed = ExpressDiscoveryClient.parseExpress(
                listItem(WAYBILL, 105, deliveryTime, GENERIC), "", PHONE);
        repository.saveInterface5(deliveryFeed, PHONE);

        ExpressItem alignedViaCnH5 = repository.findByWaybill(WAYBILL, "interface5");
        assertFalse("Same-ownership cn_h5 track within 5m satisfies gap",
                repository.cainiaoHasTrajectoryGap(alignedViaCnH5));
        assertEquals(StatusSemantic.DELIVERY, alignedViaCnH5.semantic);
        assertEquals("派送中，快递员张三正在派件", alignedViaCnH5.latestDetail);

        // Unchanged subsequent sync does not need v5_query because cn_h5 already satisfied the gap.
        gateway.detailRequests.clear();
        gateway.list = new JSONArray().put(listItem(WAYBILL, 105, deliveryTime, GENERIC));
        nowMs.set(dayBaseMs + 80L * MINUTE);
        client.sync(context, Collections.singletonList(PHONE), false);
        assertTrue("No v5_query needed when cn_h5 already aligned within 5m",
                gateway.detailRequests.isEmpty());

        // Late 19:07 TRANSIT v5_query arriving out-of-order is rejected at write time without regression!
        String lateTracks = new JSONArray()
                .put(new JSONObject().put("time", transitTime).put("context", "快件到达深圳转运中心"))
                .toString();
        ExpressQueryResult lateQuery = new ExpressQueryResult(WAYBILL, "YTO", "圆通速递",
                StatusSemantic.TRANSIT, ExpressTimeline.parseTime(transitTime),
                transitTime, "快件到达深圳转运中心", lateTracks, "", PHONE,
                TimelineSlot.V5_QUERY, "", "", "CaiNiao")
                .withManualStatusEvidence("运输中", true);
        assertFalse("Late stale v5_query must not overwrite aligned newer state",
                repository.saveInterface5Query(lateQuery, alignedViaCnH5,
                        repository.bindingGeneration(PHONE, "interface5")));

        ExpressItem afterLate = repository.findByWaybill(WAYBILL, "interface5");
        assertEquals(StatusSemantic.DELIVERY, afterLate.semantic);
        assertEquals("派送中，快递员张三正在派件", afterLate.latestDetail);
    }

    private void runSyncEngine(int[] network, boolean userPull, String trigger, Runnable onAccountPhase)
            throws Exception {
        ReflectionHelpers.callStaticMethod(
                Class.forName("me.pipi.deliveries.background.ExpressSyncEngine"),
                "syncAll",
                ReflectionHelpers.ClassParameter.from(Context.class, context),
                ReflectionHelpers.ClassParameter.from(int[].class, network),
                ReflectionHelpers.ClassParameter.from(boolean.class, userPull),
                ReflectionHelpers.ClassParameter.from(String.class, trigger),
                ReflectionHelpers.ClassParameter.from(Runnable.class, onAccountPhase));
    }

    private String formatOffset(long minutes) {
        return TIME.format(Instant.ofEpochMilli(dayBaseMs + minutes * MINUTE));
    }

    private static JSONObject listItem(String waybill, int stateNum, String time, String desc) {
        try {
            return new JSONObject()
                    .put("mailNo", waybill)
                    .put("cpCode", "YTO")
                    .put("name", "圆通速递")
                    .put("provider", "CaiNiao")
                    .put("phone", PHONE)
                    .put("stateNum", stateNum)
                    .put("details", new JSONArray().put(
                            new JSONObject().put("time", time).put("desc", desc)));
        } catch (Exception impossible) {
            throw new AssertionError(impossible);
        }
    }

    private static HttpClient.Response detailResponse(String waybill, int stateNum, String[][] nodes)
            throws Exception {
        JSONArray details = new JSONArray();
        for (String[] node : nodes) {
            details.put(new JSONObject().put("time", node[0]).put("desc", node[1]));
        }
        JSONObject data = new JSONObject()
                .put("mailNo", waybill)
                .put("cpCode", "YTO")
                .put("name", "圆通速递")
                .put("provider", "CaiNiao")
                .put("phone", PHONE)
                .put("stateNum", stateNum)
                .put("details", details);
        return new HttpClient.Response(200,
                new JSONObject().put("code", 0).put("data", data).toString()
                        .getBytes(StandardCharsets.UTF_8));
    }

    interface DetailHandler {
        HttpClient.Response handle(String waybill) throws Exception;
    }

    private static final class FakeGateway implements ExpressGatewayTransport {
        JSONArray list = new JSONArray();
        final List<String> detailRequests = new ArrayList<>();
        DetailHandler detailHandler;
        Runnable onDetailRequest;

        @Override
        public boolean configured() {
            return true;
        }

        @Override
        public HttpClient.Response post(String path, JSONObject payload) throws Exception {
            return post(path, payload, null);
        }

        @Override
        public HttpClient.Response post(String path, JSONObject payload,
                ExpressQueryCancellation cancellation) throws Exception {
            if ("/api/express/accounts/sync".equals(path)) {
                JSONObject data = new JSONObject().put("expressList", list);
                return new HttpClient.Response(200,
                        new JSONObject().put("code", 0).put("data", data).toString()
                                .getBytes(StandardCharsets.UTF_8));
            }
            if ("/api/express/timeline/source".equals(path)) {
                String waybill = payload.getJSONObject("record").getString("waybill");
                detailRequests.add(waybill);
                if (onDetailRequest != null) onDetailRequest.run();
                if (detailHandler != null) return detailHandler.handle(waybill);
                return new HttpClient.Response(200,
                        new JSONObject().put("code", 0).toString().getBytes(StandardCharsets.UTF_8));
            }
            return new HttpClient.Response(200,
                    new JSONObject().put("code", 0).toString().getBytes(StandardCharsets.UTF_8));
        }
    }
}
