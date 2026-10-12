package me.pipi.deliveries.feature.express;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import android.content.Context;

import me.pipi.deliveries.data.ExpressDatabase;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;
import me.pipi.deliveries.model.WorkerStatusProjection;

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

/**
 * 2026-09-24（Pipi 用户定，三端同口径）：京东件签收那一条常是被拦掉的评价，feed 早有揽收，显示的历史却停在
 * 「派送中」。已签收（结构化）、已投影出运单号、详情不完整时，详情下拉放行一次京粉页；其它情况照旧由揽收挡住。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class JingDongSignedHistoryGapTest {
    private static final String PHONE = "13800001906";
    private static final String ORDER = "3999999100001906";
    private static final String WAYBILL = "JD9990000001906";
    private static final String REVIEW = "您的订单" + ORDER
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
    private static final String DELIVERING = "您的订单正在派送中，请您准备签收（快递员：测试员，电话：19900000000）";
    private static final String PICKUP = "您的快件已由京东快递揽收完成";

    private Context context;
    private ExpressRepository repository;
    private java.lang.reflect.Field singleton;

    @Before public void setUp() throws Exception {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        singleton = ExpressRepository.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        singleton.set(null, null);
        repository = ExpressRepository.get(context);
        repository.bindPhoneLocally(PHONE, "interface5");
    }

    @After public void tearDown() throws Exception {
        java.lang.reflect.Field helper = ExpressRepository.class.getDeclaredField("helper");
        helper.setAccessible(true);
        ((ExpressDatabase) helper.get(repository)).close();
        singleton.set(null, null);
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void aSignedRowWhoseFeedStopsBeforeTheSignatureOpensTheUnionPage() throws Exception {
        ExpressItem owner = order(StatusSemantic.COMPLETED, at("2026-09-23 11:12:27"), true, new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}});
        ExpressQueryResult feed = repository.automaticSourceTimeline(owner);
        assertTrue(ExpressDetailActivity.signedJingDongHistoryGap(owner, feed, null, false));
        assertFalse("complete detail", ExpressDetailActivity.signedJingDongHistoryGap(owner, feed, null, true));
    }

    @Test public void aRowStillInTransitKeepsTheFeedPickupGate() throws Exception {
        ExpressItem owner = order(StatusSemantic.DELIVERY, at("2026-09-23 08:02:00"), true, new String[][]{
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}});
        assertFalse(ExpressDetailActivity.signedJingDongHistoryGap(
                owner, repository.automaticSourceTimeline(owner), null, false));
    }

    @Test public void aSignedFeedWithoutPickupIsLeftToTheExistingGate() throws Exception {
        ExpressItem owner = order(StatusSemantic.COMPLETED, at("2026-09-23 11:12:27"), true, new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING}});
        assertFalse(ExpressDetailActivity.signedJingDongHistoryGap(
                owner, repository.automaticSourceTimeline(owner), null, false));
    }

    @Test public void anUnprojectedOrderIsNotASignedGap() throws Exception {
        ExpressItem owner = order(StatusSemantic.COMPLETED, at("2026-09-23 11:12:27"), false, new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}});
        assertFalse(ExpressDetailActivity.signedJingDongHistoryGap(
                owner, repository.automaticSourceTimeline(owner), null, false));
    }

    /**
     * 一次完成只放行一次（2026-09-24）：完成包可能在真正签收几天后才到（自动确认收货），京粉页里的签收离完成时间
     * 太远、详情一直不完整；已经有一个在完成时间当时或之后抓的京粉页包，就不再放行。
     */
    @Test public void aUnionPageCapturedAtOrAfterTheCompletionClosesTheGap() throws Exception {
        ExpressItem owner = order(StatusSemantic.COMPLETED, at("2026-09-23 11:12:27"), true, new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}});
        ExpressQueryResult feed = repository.automaticSourceTimeline(owner);
        assertTrue(ExpressDetailActivity.signedJingDongHistoryGap(
                owner, feed, unionPageCapturedAt(owner.statusEventTime - 1L), false));
        assertFalse(ExpressDetailActivity.signedJingDongHistoryGap(
                owner, feed, unionPageCapturedAt(owner.statusEventTime), false));

        saveUnionPage(owner, new String[][]{
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}});
        me.pipi.deliveries.data.ManualTimelineAuthorityPolicy.Candidate stored =
                repository.manualTimelineCandidate(owner, me.pipi.deliveries.data.TimelineSlot.JD_H5);
        assertNotNull(stored);
        assertFalse("captured now, after the completion",
                ExpressDetailActivity.signedJingDongHistoryGap(owner, feed, stored, false));
    }

    private static me.pipi.deliveries.data.ManualTimelineAuthorityPolicy.Candidate unionPageCapturedAt(
            long successAt) throws Exception {
        return new me.pipi.deliveries.data.ManualTimelineAuthorityPolicy.Candidate(
                me.pipi.deliveries.data.TimelineSlot.JD_H5, new ExpressQueryResult(WAYBILL, "JD", "京东快递",
                        StatusSemantic.UNKNOWN, 0L, at("2026-09-23 08:02:00"), DELIVERING,
                        tracks(new String[][]{{at("2026-09-23 08:02:00"), DELIVERING},
                                {at("2026-09-22 21:48:11"), PICKUP}}),
                        "", "", me.pipi.deliveries.data.TimelineSlot.JD_H5, "", "", ""),
                successAt, true);
    }

    /**
     * 用户定 2026-09-24（Fold7 9307）：列表最新一条是 11:12 的签收，详情只剩投影前抓的京粉页旧包（止于前一晚 22:44）。这一例
     * 原先由详情页的 1 分钟对不上查一次 v5；优化 2（用户 2026-10-03「v5 对不上并进对齐」）把那条路并进了头条与状态对齐，
     * 优化 7（「这类行不算详情落后」）又规定详情时间来自 Lite 强刷刷不到的网页包（这里是京粉页）时对齐只比状态与头条：这一行的
     * 详情时间不参与对齐，而签收三态冻结照旧读它（详情还停在签收前一晚，没到签收，不冻结）。
     */
    @Test public void aDetailFromTheUnionPageIsNotComparedByTheStatusAlignment() throws Exception {
        String signature = "您的快件已送达至【家门口有问题，联系快递员。】，快递员：测试员";
        ExpressItem owner = order(StatusSemantic.COMPLETED, at("2026-09-23 11:12:26"), true,
                new String[][]{{at("2026-09-23 11:12:26"), signature}});
        saveUnionPage(owner, new String[][]{
                {at("2026-09-22 22:44:26"), "您的订单已离开【测试城南接货仓】"},
                {at("2026-09-22 22:44:00"), "您的快件已揽收完成。"}});
        owner = repository.find(owner.rowId);
        ExpressRepository.StatusAlignmentProbe probe = probe(owner);
        assertTrue(probe.detailFromWebCapture);
        assertTrue(probe.detailAt > 0L);
        assertTrue("the union page's newest node is not compared", probe.comparedDetailAt() == 0L);
        assertFalse("the triple freeze still needs the detail to reach the signing",
                ExpressRepository.signedTripleReached(probe.row.semantic, probe.statusAt, probe.headlineAt,
                        probe.detailAt, System.currentTimeMillis()));
        assertFalse(repository.signedFrozen(owner));
    }

    /**
     * 优化 1（用户 2026-10-03「这轮就统一」）：签收后的那一次京粉页记在这一行持久化的签收后台账里，按完成时间 T 分代。用掉了就不再
     * 放行；T 变了（重新签收）是新的一代，又可以放行一次；这一行真的删掉时台账一起删。
     */
    @Test public void theSignedLedgerSpendsTheUnionPageOncePerCompletionTime() throws Exception {
        ExpressItem owner = order(StatusSemantic.COMPLETED, at("2026-09-23 11:12:27"), true, new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), PICKUP}});
        ExpressQueryResult feed = repository.automaticSourceTimeline(owner);
        assertFalse(repository.signedUnionPageUsed(owner));
        assertTrue(ExpressDetailActivity.signedJingDongHistoryGap(owner, feed, null, false,
                repository.signedUnionPageUsed(owner)));

        repository.recordSignedUnionPage(owner);
        assertTrue(repository.signedUnionPageUsed(owner));
        assertEquals(Long.toString(owner.statusEventTime),
                repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_SIGNED_UNION_PAGE));
        assertFalse("spent for this completion time", ExpressDetailActivity.signedJingDongHistoryGap(
                owner, feed, null, false, repository.signedUnionPageUsed(owner)));

        ExpressItem resigned = new ExpressItem(owner.rowId, owner.phone, owner.waybill, owner.courierCode,
                owner.companyName, owner.semantic, owner.statusDescription, owner.latestDetail, owner.latestTime,
                owner.tracksJson, owner.remark, owner.source, owner.detailUrl,
                owner.statusEventTime + 60L * 60_000L, owner.updatedAt, owner.stateOwner, owner.routeOwner,
                owner.routeInterface, owner.routeCredential, owner.routeCredentialAvailable,
                owner.projectedWaybill, owner.projectedCompanyName, owner.projectedTracksJson,
                owner.sourceProvider);
        assertFalse("a new completion time is a new generation", repository.signedUnionPageUsed(resigned));
        repository.recordSignedUnionPage(resigned);
        assertTrue(repository.signedUnionPageUsed(resigned));
        assertFalse("one generation at a time", repository.signedUnionPageUsed(owner));

        repository.delete(owner.rowId);
        assertEquals("", repository.ledgerValue(owner.rowId, ExpressRepository.LEDGER_SIGNED_UNION_PAGE));
    }

    /** 优化 1：哪些京粉页结果算「有了回答」——网络 / 加载失败、风控不算；带节点的包（含部分包）、空壳、见到物流都算。 */
    @Test public void onlyAnAnsweredUnionPageSpendsTheSignedLedger() throws Exception {
        ExpressQueryResult partial = new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L,
                at("2026-09-23 08:02:00"), DELIVERING,
                tracks(new String[][]{{at("2026-09-23 08:02:00"), DELIVERING}}), "", "", TimelineSlot.JD_H5,
                "", "", "");
        assertFalse(ExpressDetailActivity.unionPageAnswered(null));
        assertFalse("a failed load", ExpressDetailActivity.unionPageAnswered(
                new ExpressAutomaticTimelineCapture.Result(null, false, false)));
        assertFalse("risk control", ExpressDetailActivity.unionPageAnswered(
                new ExpressAutomaticTimelineCapture.Result(null, false, true)));
        assertFalse("risk control with a package", ExpressDetailActivity.unionPageAnswered(
                new ExpressAutomaticTimelineCapture.Result(partial, false, true)));
        assertTrue("a partial package", ExpressDetailActivity.unionPageAnswered(
                new ExpressAutomaticTimelineCapture.Result(partial, false, false)));
        assertTrue("an empty shell", ExpressDetailActivity.unionPageAnswered(
                new ExpressAutomaticTimelineCapture.Result(null, false, false, false, true, false)));
        assertTrue("logistics seen without a package", ExpressDetailActivity.unionPageAnswered(
                new ExpressAutomaticTimelineCapture.Result(null, false, false, false, false, true)));
    }

    private ExpressRepository.StatusAlignmentProbe probe(ExpressItem owner) {
        for (ExpressRepository.StatusAlignmentProbe probe : repository.statusAlignmentProbes("interface5")) {
            if (probe.row.rowId == owner.rowId) return probe;
        }
        throw new AssertionError("no probe for the row");
    }

    private void saveUnionPage(ExpressItem owner, String[][] nodes) throws Exception {
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        assertTrue(repository.saveAutomaticDetailTimeline(owner, claim, new ExpressQueryResult(
                WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L, nodes[0][0], nodes[0][1],
                tracks(nodes), "", "", me.pipi.deliveries.data.TimelineSlot.JD_H5, "", "", ""), true));
    }

    private ExpressItem order(StatusSemantic semantic, String eventAt, boolean projected,
            String[][] feedTracks) throws Exception {
        long eventAtMs = me.pipi.deliveries.model.ExpressTimeline.parseTime(eventAt);
        WorkerStatusProjection status = WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "ORDER").put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.name()).put("priority", 0)
                        .put("eventAtMs", eventAtMs).put("structured", true)));
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JD", "京东快递",
                semantic, eventAtMs, feedTracks[0][0], feedTracks[0][1], tracks(feedTracks),
                "", PHONE, "interface5", "", "", "JingDong").withWorkerStatus(status), PHONE);
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        if (projected) {
            assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        }
        return repository.find(owner.rowId);
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        }
        return value.toString();
    }
}
