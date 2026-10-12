package me.pipi.deliveries.background;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import me.pipi.deliveries.network.ExpressQueryCancellation;
import me.pipi.deliveries.network.ExpressSubscriptionClient;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.annotation.SQLiteMode;
import org.robolectric.shadows.ShadowLog;
import org.robolectric.util.ReflectionHelpers;

/**
 * 用户 2026-10-02「头条 状态 详情页 都推进到了签收状态…就冻结快递 后续不再进行任何刷新」，弹窗「只停本机发起的请求」：
 * the list round still pulls the account list, but a row whose structured signing, headline and detail reached
 * the signing makes no per-parcel request in it. The round reads the rows as stored, never the list's display-only
 * headline alignment. Synthetic parcels; the account list, the Picker and the per-parcel query are fakes.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class,
        shadows = {ExpressSyncSignedFreezeTest.Subscription.class, ExpressSyncSignedFreezeTest.Discovery.class})
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class ExpressSyncSignedFreezeTest {
    private static final String PHONE = "13900000055";
    private static final String SF = "SF1000000000055";
    private static final String SF_SIGNED = "SF1000000000056";
    private static final String ZTO = "ZT1000000000055";
    private static final long MINUTE = 60_000L;

    private Context context;
    private ExpressRepository repository;
    private long base;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
        for (String name : new String[]{"deliveries_repository_migrations", "express_account_source",
                "express_network_success"}) {
            context.getSharedPreferences(name, 0).edit().clear().commit();
        }
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface6");
        repository.bindPhoneLocally(PHONE, "interface5");
        base = (System.currentTimeMillis() - 180L * MINUTE) / 1000L * 1000L;
        Subscription.lists.set(0);
        Subscription.pickers.set(0);
        Discovery.lists.set(0);
        Discovery.refreshed.clear();
        ShadowLog.clear();
    }

    @After public void tearDown() {
        ((ExpressDatabase) ReflectionHelpers.getField(repository, "helper")).close();
        ReflectionHelpers.setStaticField(ExpressRepository.class, "instance", null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    /**
     * A structured SF signing at +110 min with its headline there too: frozen, no Picker, while the list is still
     * pulled. The signed freeze of 2026-09-04 holds this row as well, so no skip line is added for it.
     */
    @Test public void aStructuredSigningMakesNoPickerRequestWhileTheListIsStillPulled() throws Exception {
        ExpressItem owner = shunFeng(true, new String[][]{{at(110), "快件已签收"}, {at(0), "顺丰速运 已收取快件"}});
        ExpressQueryResult detailed = new ExpressQueryResult(SF, "SF", "顺丰速运", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(110), "快件已签收", tracks(new String[][]{
                        {at(110), "快件已签收"}, {at(0), "顺丰速运 已收取快件"}}),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", "")
                .withManualStatusEvidence("已签收", true);
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, detailed, System.currentTimeMillis(), false)),
                PHONE, "interface6");
        owner = repository.find(owner.rowId);
        assertTrue(repository.signedFrozenRows("interface6").contains(owner.rowId));
        assertFalse(ExpressRepository.backgroundTimelineRefreshAllowed(owner,
                repository.manualTimelineAuthority(owner), System.currentTimeMillis()));

        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, true, "list_pull");
        assertEquals("the account list is still pulled", 1, Subscription.lists.get());
        assertEquals("no Picker for the frozen row", 0, Subscription.pickers.get());
        assertFalse(logs().contains("skipReason=signed_frozen"));
    }

    @Test public void aSignedCoarseShunFengFeedKeepsItsOrdinaryPickerRefresh() throws Exception {
        ExpressItem owner = shunFeng(true, new String[][]{{at(110), "快件已签收"}, {at(0), "顺丰速运 已收取快件"}});
        assertFalse(repository.signedFrozen(owner));
        assertTrue(ExpressRepository.backgroundTimelineRefreshAllowed(owner,
                repository.manualTimelineAuthority(owner), System.currentTimeMillis()));
        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, true, "list_pull");
        assertEquals(1, Subscription.pickers.get());
    }

    @Test public void aStructuredNonShunFengSigningStillStopsTheOrdinaryPoll() throws Exception {
        selectInterface5();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(110), "快件已签收",
                tracks(new String[][]{{at(110), "快件已签收"}}), "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertFalse(ExpressRepository.backgroundTimelineRefreshAllowed(owner,
                repository.manualTimelineAuthority(owner), System.currentTimeMillis()));
    }

    /** 「结构化状态是已签收」: the same signing without structured evidence is neither frozen nor aligned. */
    @Test public void aSigningWithoutStructuredEvidenceIsNotFrozen() throws Exception {
        ExpressItem owner = shunFeng(false, new String[][]{{at(110), "快件已签收"}, {at(0), "顺丰速运 已收取快件"}});
        assertEquals(StatusSemantic.COMPLETED, owner.semantic);
        assertFalse(repository.signedFrozenRows("interface6").contains(owner.rowId));
        for (ExpressRepository.StatusAlignmentProbe probe : repository.statusAlignmentProbes("interface6")) {
            assertFalse("not aligned either", probe.row.rowId == owner.rowId);
        }

        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, true, "list_pull");
        assertEquals(1, Subscription.pickers.get());
        assertFalse(logs().contains("skipReason=signed_frozen"));
    }

    /**
     * The round's Picker gate on its own: a frozen row is never claimed; its skip is logged only where the signed
     * freeze of 2026-09-04 would have let the poll through (here the row without structured evidence), so a row
     * that freeze already holds stays quiet.
     */
    @Test public void thePickerGateSkipsAFrozenRowAndLogsOnlyWhereTheOldFreezeWouldNot() throws Exception {
        ExpressItem open = shunFeng(false, new String[][]{{at(110), "快件已签收"}, {at(0), "顺丰速运 已收取快件"}});
        assertFalse(ExpressSyncEngine.pickerSignedFrozen(repository, Set.of(), open));
        assertTrue(ExpressSyncEngine.pickerSignedFrozen(repository, Set.of(open.rowId), open));
        String logs = logs();
        assertTrue(logs, logs.contains("manual.source.skipped") && logs.contains("skipReason=signed_frozen"));

        ShadowLog.clear();
        ExpressItem held = shunFeng(SF_SIGNED, true,
                new String[][]{{at(110), "快件已签收"}, {at(0), "顺丰速运 已收取快件"}});
        assertTrue(ExpressSyncEngine.pickerSignedFrozen(repository, Set.of(held.rowId), held));
        assertTrue("a coarse signed feed would otherwise still be queried", logs().contains("signed_frozen"));
    }

    /**
     * The list shows the status package's newer node (+60 min) over the stored headline (+20 min); the round's
     * per-parcel query still sends the stored row, so the summary going upstream keeps the stored time.
     */
    @Test public void theUpstreamSummaryKeepsTheStoredHeadlineTime() throws Exception {
        selectInterface5();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 60L * MINUTE, at(20), "快件到达营业点",
                tracks(new String[][]{{at(60), "快件派送中"}, {at(20), "快件到达营业点"}, {at(0), "快件已揽收"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 60L * MINUTE)), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        assertEquals("the list shows the aligned headline", at(60),
                listed(repository.listVisible("interface5"), owner.rowId).latestTime);
        assertEquals(at(20), listed(repository.listVisibleAsStored("interface5"), owner.rowId).latestTime);

        ExpressSyncEngine.syncAll(context, new int[]{0, 0, 0}, true, "list_pull");
        assertEquals(1, Discovery.refreshed.size());
        ExpressItem sent = Discovery.refreshed.get(0);
        assertEquals(at(20), sent.latestTime);
        JSONObject summary = ReflectionHelpers.callStaticMethod(ExpressDiscoveryClient.class, "itemSummary",
                ReflectionHelpers.ClassParameter.from(ExpressItem.class, sent));
        assertEquals(at(20), summary.getString("logisticsUpdateTime"));
    }

    @Test public void theSkipNamesOnlyAFrozenRow() throws Exception {
        ExpressItem owner = shunFeng(true, new String[][]{{at(110), "快件已签收"}, {at(0), "顺丰速运 已收取快件"}});
        assertFalse(ExpressSyncEngine.skippedSignedFrozen(Set.of(), owner, "v5", TimelineSlot.V5_QUERY));
        assertFalse(logs().contains("signed_frozen"));
        assertTrue(ExpressSyncEngine.skippedSignedFrozen(Set.of(owner.rowId), owner, "v5", TimelineSlot.V5_QUERY));
        String logs = logs();
        assertTrue(logs, logs.contains("refresh.stage.skipped") && logs.contains("skipReason=signed_frozen"));
    }

    private void selectInterface5() {
        context.getSharedPreferences("express_account_source", 0).edit()
                .putString("active_interface", "v5").commit();
    }

    /** Interface 6 SF signed at +110 min, with or without a structured Worker status; the newest node first. */
    private ExpressItem shunFeng(boolean structured, String[][] nodes) throws Exception {
        return shunFeng(SF, structured, nodes);
    }

    private ExpressItem shunFeng(String waybill, boolean structured, String[][] nodes) throws Exception {
        ExpressQueryResult feed = new ExpressQueryResult(waybill, "SF", "顺丰速运", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, nodes[0][0], nodes[0][1], tracks(nodes), "", PHONE, TimelineSlot.V6_LIST,
                "", "", "ShunFeng");
        if (structured) feed = feed.withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE));
        repository.saveInterface6(feed, PHONE, repository.bindingGeneration(PHONE, "interface6"));
        ExpressItem owner = repository.findByWaybill(waybill, "interface6");
        assertNotNull(owner);
        assertEquals(StatusSemantic.COMPLETED, owner.semantic);
        return owner;
    }

    private static ExpressItem listed(List<ExpressItem> rows, long rowId) {
        for (ExpressItem row : rows) if (row.rowId == rowId) return row;
        throw new AssertionError("row not listed");
    }

    private String at(long minutes) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new Date(base + minutes * MINUTE));
    }

    private static WorkerStatusProjection structured(StatusSemantic semantic, long eventAtMs) throws Exception {
        return WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "SHIPMENT").put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                        .put("eventAtMs", eventAtMs).put("structured", true)));
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        return value.toString();
    }

    private static String logs() {
        List<String> lines = new ArrayList<>();
        for (ShadowLog.LogItem item : ShadowLog.getLogsForTag("PipiExpress")) lines.add(item.msg);
        return String.join("\n", lines);
    }

    @Implements(value = ExpressSubscriptionClient.class, isInAndroidSdk = false, callThroughByDefault = true)
    public static class Subscription {
        static final AtomicInteger lists = new AtomicInteger();
        static final AtomicInteger pickers = new AtomicInteger();

        @Implementation protected List<ExpressQueryResult> query(Context context) {
            lists.incrementAndGet();
            return List.of();
        }

        @Implementation protected ExpressQueryResult queryManual(Context context, String waybill,
                ExpressQueryCancellation cancellation) {
            pickers.incrementAndGet();
            return null;
        }
    }

    /** The interface 5 list lands nothing new; the per-parcel query records the row it was given. */
    @Implements(value = ExpressDiscoveryClient.class, isInAndroidSdk = false)
    public static class Discovery {
        static final AtomicInteger lists = new AtomicInteger();
        static final List<ExpressItem> refreshed = new CopyOnWriteArrayList<>();

        @Implementation protected int sync(Context ignored, List<String> phones, boolean userPull) {
            lists.incrementAndGet();
            return 0;
        }

        @Implementation protected boolean wasSynced(String waybill) {
            return false;
        }

        @Implementation protected java.util.Map<String, Set<String>> syncedWaybillsByGeneration() {
            return Collections.emptyMap();
        }

        @Implementation protected ExpressQueryResult refreshKnown(Context ignored, ExpressItem item) {
            refreshed.add(item);
            return null;
        }
    }
}
