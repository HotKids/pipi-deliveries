package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import me.pipi.deliveries.R;
import me.pipi.deliveries.data.ExpressAutomaticDetailPersistenceTest.SyntheticSecretBox;
import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.Kuaidi100TimelinePolicy;
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
 * 用户采纳 2026-09-24：缓存的自动 H5 包（jd_h5 / cn_h5）只有在详情选包自己也判它完整时才挡手动链，光有揽收节点
 * 不够。Pixel 上 Pipi 实测（三端同逻辑）：顺丰承运的京东单，jd_h5 六个节点含「顺丰速运 已收取快件」，最新一条
 * 16:16，列表最新 17:21；选包不显示它（newer_account_history），显示的历史没有揽收，K100 却因为「H5 有揽收」从不跑。
 * feed 自己有揽收照旧挡。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35, manifest = Config.NONE, application = Application.class,
        shadows = {SyntheticSecretBox.class, AutomaticH5OriginGateTest.Pages.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class AutomaticH5OriginGateTest {
    private static final String PHONE = "13800009001";
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")
            .withZone(ZoneId.of("Asia/Shanghai"));
    /** The account list's newest node is ten minutes old (the Pixel row: 17:21). */
    private static final long LIST_NEWEST_MINUTES_AGO = 10L;
    private Context context;
    private ExpressRepository repository;
    private ExpressDetailActivity activity;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String prefs : new String[]{"express_jd_h5_cooldown", "express_k100_capture_cooldown",
                "deliveries_repository_migrations"}) {
            context.getSharedPreferences(prefs, 0).edit().clear().commit();
        }
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
        activity = Robolectric.buildActivity(ExpressDetailActivity.class).get();
        Pages.providers.clear();
    }

    @After public void tearDown() {
        ((ExecutorService) ReflectionHelpers.getField(activity, "worker")).shutdownNow();
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aStaleUnionPageWithPickupNoLongerStopsTheManualChain() throws Exception {
        ExpressItem owner = sfCarriedOrder("3630448013829001", "SF1400000009001", false);
        // Newest union-page node 75 minutes old: 65 minutes behind the list (16:16 against 17:21).
        unionPage(owner, 75L);
        assertTrue("the package itself has the SF pickup node", Kuaidi100TimelinePolicy.hasPickupEvidence(
                repository.manualTimelineCandidate(owner, TimelineSlot.JD_H5).result));
        assertNull("the detail selection shows the newer account history, not this package",
                repository.manualDetailTimelineAuthority(owner));
        assertFalse(repository.detailRanksPackageComplete(owner, TimelineSlot.JD_H5));

        assertFalse(ExpressDetailActivity.automaticSourcesHaveOrigin(repository, owner));

        pull(owner);
        assertEquals("the pull reopened the union page, then the manual chain ran its primary K100 page",
                List.of(TimelineSlot.JD_H5, TimelineSlot.K100_H5), Pages.providers);
    }

    @Test public void aCompleteUnionPageStillStopsTheManualChain() throws Exception {
        ExpressItem owner = sfCarriedOrder("3630448013829002", "SF1400000009002", false);
        // Newest union-page node five minutes behind the list: within the 30-minute lag rule.
        unionPage(owner, 15L);
        ManualTimelineAuthorityPolicy.Candidate displayed = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(displayed);
        assertEquals(TimelineSlot.JD_H5, displayed.provider);
        assertTrue(repository.detailRanksPackageComplete(owner, TimelineSlot.JD_H5));

        assertTrue(ExpressDetailActivity.automaticSourcesHaveOrigin(repository, owner));

        pull(owner);
        assertTrue("no page opens: " + Pages.providers, Pages.providers.isEmpty());
    }

    @Test public void aFeedPickupStillStopsTheManualChain() throws Exception {
        ExpressItem owner = sfCarriedOrder("3630448013829003", "SF1400000009003", true);
        // Even beside a stale union page, the feed's own pickup is the origin.
        unionPage(owner, 75L);
        assertFalse(repository.detailRanksPackageComplete(owner, TimelineSlot.JD_H5));

        assertTrue(ExpressDetailActivity.automaticSourcesHaveOrigin(repository, owner));

        pull(owner);
        assertFalse("the feed pickup keeps the manual chain closed",
                Pages.providers.contains(TimelineSlot.K100_H5));
    }

    @Test public void aCainiaoPagePackageFollowsTheSameRule() throws Exception {
        ExpressItem stale = cainiaoRow("YT7000000009004");
        cainiaoPage(stale, 75L);
        assertFalse(ExpressDetailActivity.automaticSourcesHaveOrigin(repository, stale));

        ExpressItem fresh = cainiaoRow("YT7000000009005");
        cainiaoPage(fresh, 15L);
        assertTrue(repository.detailRanksPackageComplete(fresh, TimelineSlot.CN_H5));
        assertTrue(ExpressDetailActivity.automaticSourcesHaveOrigin(repository, fresh));
    }

    /** SF-carried JD order: projected to its SF waybill, structured TRANSIT, trusted union-page route. */
    private ExpressItem sfCarriedOrder(String order, String carrierWaybill, boolean feedPickup)
            throws Exception {
        String route = "https://jingfen.jd.com/item?fixture=" + order;
        String newest = minutesAgo(LIST_NEWEST_MINUTES_AGO);
        String[][] nodes = {
                {newest, "您的订单正在运输途中"},
                {minutesAgo(200L), feedPickup ? "您的快件已由顺丰速运揽收完成" : "您的订单已出库"}};
        long newestAt = ExpressTimeline.parseTime(newest);
        ExpressQueryResult feed = new ExpressQueryResult(order, "JD", "京东购物",
                StatusSemantic.TRANSIT, newestAt, newest, nodes[0][1], tracks(nodes), route,
                PHONE, "interface5", "v5", route, "JingDong")
                .withWorkerStatus(structured(StatusSemantic.TRANSIT, newestAt));
        repository.saveInterface5OrderSummary(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(order, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveRecoveredOwnerRoute(owner, repository.captureManualQueryOwner(owner), feed));
        assertTrue(repository.saveOrderProjection(repository.find(owner.rowId), "interface5",
                carrierWaybill, "顺丰速运"));
        owner = repository.find(owner.rowId);
        assertEquals(carrierWaybill, owner.displayWaybill());
        assertEquals(StatusSemantic.TRANSIT, owner.semantic);
        assertEquals(feedPickup, Kuaidi100TimelinePolicy.hasPickupEvidence(
                repository.automaticSourceTimeline(owner)));
        return owner;
    }

    /** A complete six-node union-page package whose oldest node is the SF pickup. */
    private void unionPage(ExpressItem owner, long newestMinutesAgo) throws Exception {
        String[][] nodes = {
                {minutesAgo(newestMinutesAgo), "快件到达【测试甲区集散中心】"},
                {minutesAgo(newestMinutesAgo + 20L), "快件已发车"},
                {minutesAgo(newestMinutesAgo + 40L), "快件在【测试乙区转运中心】完成分拣，准备发往下一站"},
                {minutesAgo(newestMinutesAgo + 60L), "快件到达【测试乙区转运中心】"},
                {minutesAgo(newestMinutesAgo + 80L), "快件已从【测试乙区营业点】发出"},
                {minutesAgo(newestMinutesAgo + 100L), "顺丰速运 已收取快件"}};
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(owner.displayWaybill(), "SF", "顺丰速运", StatusSemantic.UNKNOWN, 0L,
                        nodes[0][0], nodes[0][1], tracks(nodes), "", "", TimelineSlot.JD_H5, "", "", ""),
                true));
    }

    /** An interface 5 Cainiao row whose own feed has no pickup yet (structured TRANSIT). */
    private ExpressItem cainiaoRow(String waybill) throws Exception {
        String newest = minutesAgo(LIST_NEWEST_MINUTES_AGO);
        long newestAt = ExpressTimeline.parseTime(newest);
        repository.saveInterface5(new ExpressQueryResult(waybill, "YTO", "圆通速递",
                StatusSemantic.TRANSIT, newestAt, newest, "快件已到达【杭州转运中心】",
                tracks(new String[][]{{newest, "快件已到达【杭州转运中心】"}}), "", PHONE,
                "interface5", "", "", "CaiNiao")
                .withWorkerStatus(structured(StatusSemantic.TRANSIT, newestAt)), PHONE);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(owner);
        assertTrue(owner.isCainiaoSource());
        return owner;
    }

    private void cainiaoPage(ExpressItem owner, long newestMinutesAgo) throws Exception {
        String[][] nodes = {
                {minutesAgo(newestMinutesAgo), "快件已发往【杭州转运中心】"},
                {minutesAgo(newestMinutesAgo + 60L), "【宁波市】圆通速递 已揽收"}};
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(owner.displayWaybill(), "YTO", "圆通速递", StatusSemantic.UNKNOWN, 0L,
                        nodes[0][0], nodes[0][1], tracks(nodes), "", "", TimelineSlot.CN_H5, "", "", ""),
                false));
    }

    /** The real detail pull: the automatic stage, then the manual chain unless the gate stops it. */
    private void pull(ExpressItem owner) throws Exception {
        activity.setTheme(R.style.AppTheme);
        ReflectionHelpers.setField(activity, "nativeProgress", new LinearProgressIndicator(activity));
        ReflectionHelpers.setField(activity, "item", owner);
        ReflectionHelpers.setField(activity, "localRefreshInFlight", false);
        ReflectionHelpers.setField(activity, "pullRefreshRequested", true);
        ReflectionHelpers.callInstanceMethod(activity, "refreshLocalTimelineInBackground",
                ClassParameter.from(boolean.class, false));
        Future<?> task = ReflectionHelpers.getField(activity, "localRefreshTask");
        task.get(10, TimeUnit.SECONDS);
        assertFalse(ReflectionHelpers.getField(activity, "localRefreshFailed"));
    }

    private static String minutesAgo(long minutes) {
        return TIME.format(Instant.ofEpochMilli(System.currentTimeMillis() - minutes * 60_000L));
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        return value.toString();
    }

    private static WorkerStatusProjection structured(StatusSemantic semantic, long eventAt)
            throws Exception {
        return WorkerStatusProjection.read(new JSONObject().put("normalizedStatus", new JSONObject()
                .put("version", 1).put("scope", "SHIPMENT").put("semantic", semantic.name())
                .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                .put("eventAtMs", eventAt).put("structured", true)));
    }

    @Implements(value = ExpressAutomaticTimelineCapture.class, isInAndroidSdk = false)
    public static class Pages {
        static final List<String> providers = new CopyOnWriteArrayList<>();

        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider,
                ExpressQueryCancellation cancellation) {
            providers.add(provider);
            return null;
        }

        @Implementation protected static ExpressAutomaticTimelineCapture.Result capture(
                Activity host, ExpressItem owner, String route, String provider, List<String> phones,
                ExpressQueryCancellation cancellation) {
            providers.add(provider);
            return null;
        }
    }
}
