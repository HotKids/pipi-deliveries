package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

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
 * 用户 2026-10-02「头条 状态 详情页 都推进到了签收状态（之前京东定的那种临时签收例外）就冻结快递 后续不再进行任何刷新」，
 * 弹窗「按时间对齐」「先用掉再冻结」「只停本机发起的请求」「四端都做」。Synthetic parcels only: a row is frozen when its
 * structured signing has a valid time and its list headline and native detail are not more than five minutes
 * before it — the status alignment's own three times — except an order still without its waybill, a JD review
 * kept as the first signing, and a JD row whose one union page after signing is still due.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class SignedTripleFreezeTest {
    private static final String PHONE = "13800000066";
    private static final String ZTO = "ZT1000000000066";
    private static final String ORDER = "3999999100000066";
    private static final String JD = "JD9990000000066";
    private static final String REVIEW = "您的订单" + ORDER
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
    private static final String JD_SIGNED = "您的订单已送达至【家门口】，感谢您在京东购物，欢迎再次光临。";
    private static final String JD_DELIVERING = "您的订单正在派送中，请您准备签收";
    private static final String JD_PICKUP = "您的快件已由京东快递揽收完成";
    private static final long MINUTE = 60_000L;
    private static final long FIVE = ExpressRepository.STATUS_ALIGNMENT_MILLIS;

    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    /** A whole second three hours ago: the parcels stay well inside the 14-day list window. */
    private long base;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(PHONE, "interface5");
        base = (System.currentTimeMillis() - 180L * MINUTE) / 1000L * 1000L;
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    @Test public void theTripleIsReachedOnlyAtAValidSigningWithinFiveMinutes() {
        long now = base + 200L * MINUTE;
        long t = base + 110L * MINUTE;
        assertTrue(ExpressRepository.signedTripleReached(StatusSemantic.COMPLETED, t, t, t, now));
        // H and D: at most five minutes before the completion, any time after it.
        assertTrue(ExpressRepository.signedTripleReached(StatusSemantic.COMPLETED, t, t - FIVE, t - FIVE, now));
        assertFalse(ExpressRepository.signedTripleReached(StatusSemantic.COMPLETED, t, t - FIVE - 1L, t, now));
        assertFalse(ExpressRepository.signedTripleReached(StatusSemantic.COMPLETED, t, t, t - FIVE - 1L, now));
        assertTrue(ExpressRepository.signedTripleReached(StatusSemantic.COMPLETED, t, t + 60L * MINUTE,
                t + 30L * MINUTE, now));
        // A row without D (no timed detail node) is read on S and H only; H is required.
        assertTrue(ExpressRepository.signedTripleReached(StatusSemantic.COMPLETED, t, t, 0L, now));
        assertFalse(ExpressRepository.signedTripleReached(StatusSemantic.COMPLETED, t, 0L, t, now));
        // S: signed, with a positive completion time that is not in the future.
        assertFalse(ExpressRepository.signedTripleReached(StatusSemantic.DELIVERY, t, t, t, now));
        assertFalse(ExpressRepository.signedTripleReached(StatusSemantic.WAITING_PICKUP, t, t, t, now));
        assertFalse(ExpressRepository.signedTripleReached(StatusSemantic.CANCELLED, t, t, t, now));
        assertFalse(ExpressRepository.signedTripleReached(StatusSemantic.COMPLETED, 0L, t, t, now));
        assertFalse(ExpressRepository.signedTripleReached(StatusSemantic.COMPLETED, now + 1L, now + 1L,
                now + 1L, now));
    }

    @Test public void aSignedRowWhoseHeadlineAndDetailReachedTheSigningIsFrozen() throws Exception {
        ExpressItem owner = zto(110L, new String[][]{
                {at(110), "快件已签收"}, {at(20), "快件到达营业点"}, {at(0), "快件已揽收"}});
        ExpressRepository.StatusAlignmentProbe probe = probe(owner);
        assertEquals(base + 110L * MINUTE, probe.statusAt);
        assertEquals(base + 110L * MINUTE, probe.headlineAt);
        assertEquals(base + 110L * MINUTE, probe.detailAt);
        assertTrue(repository.signedFrozen(probe));
        assertTrue(repository.signedFrozen(owner));
        assertTrue(repository.signedFrozenRows("interface5").contains(owner.rowId));
    }

    /** A node after the signing (a later headline and detail) keeps the row frozen: ≥, not equal. */
    @Test public void aKnownNonSignedDetailNodeCannotFreezeWithinTheSignedTimeWindow() throws Exception {
        String json = new JSONArray()
                .put(new JSONObject().put("time", at(115)).put("context", "配送节点").put("statusCode", "105"))
                .put(new JSONObject().put("time", at(110)).put("context", "签收节点").put("statusCode", "107"))
                .toString();
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(110), "签收节点", json, "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE, "SHIPMENT")), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        ExpressRepository.StatusAlignmentProbe probe = probe(owner);
        assertEquals(StatusSemantic.COMPLETED, probe.headlineSemantic);
        assertEquals(StatusSemantic.DELIVERY, probe.detailSemantic);
        assertTrue(ExpressRepository.signedTripleReached(probe.row.semantic, probe.statusAt,
                probe.headlineAt, probe.detailAt, System.currentTimeMillis()));
        assertFalse(repository.signedFrozen(owner));
    }

    @Test public void aLaterNodeAfterTheSigningStillCounts() throws Exception {
        ExpressItem owner = zto(110L, new String[][]{
                {at(150), "快件已由驿站代收"}, {at(110), "快件已签收"}, {at(0), "快件已揽收"}});
        ExpressRepository.StatusAlignmentProbe probe = probe(owner);
        assertEquals(base + 150L * MINUTE, probe.headlineAt);
        assertTrue(repository.signedFrozen(owner));
    }

    @Test public void aHeadlineBehindTheSigningIsNotFrozen() throws Exception {
        ExpressItem lagging = zto(110L, new String[][]{
                {at(104), "快件派送中"}, {at(20), "快件到达营业点"}, {at(0), "快件已揽收"}});
        assertEquals(base + 104L * MINUTE, probe(lagging).headlineAt);
        assertFalse("six minutes before the signing", repository.signedFrozen(lagging));
        assertFalse(repository.signedFrozenRows("interface5").contains(lagging.rowId));
    }

    @Test public void aHeadlineFiveMinutesBeforeTheSigningIsFrozen() throws Exception {
        ExpressItem owner = zto(110L, new String[][]{
                {at(105), "快件派送中"}, {at(20), "快件到达营业点"}, {at(0), "快件已揽收"}});
        assertTrue(repository.signedFrozen(owner));
    }

    @Test public void aRowStillOnTheWayIsNotFrozen() throws Exception {
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.DELIVERY,
                base + 110L * MINUTE, at(110), "快件派送中",
                tracks(new String[][]{{at(110), "快件派送中"}, {at(0), "快件已揽收"}}),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.DELIVERY, base + 110L * MINUTE, "SHIPMENT")), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        assertFalse(repository.signedFrozen(owner));
    }

    /**
     * 「结构化状态是已签收」「列表展示的结构化状态时间」: a signing without structured evidence takes no part. The list keeps
     * its headline (no alignment swap), the row is not probed and not frozen; a structured twin is swapped.
     */
    @Test public void aSigningWithoutStructuredEvidenceIsNeitherAlignedNorFrozen() throws Exception {
        String[][] nodes = {{at(110), "快件已签收"}, {at(20), "快件到达营业点"}, {at(0), "快件已揽收"}};
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(20), "快件到达营业点", tracks(nodes),
                "", PHONE, "interface5", "", "", "ZhongTong"), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        assertEquals(StatusSemantic.COMPLETED, owner.semantic);
        assertEquals(at(20), listed(owner.rowId).latestTime);
        for (ExpressRepository.StatusAlignmentProbe probe : repository.statusAlignmentProbes("interface5")) {
            assertFalse(probe.row.rowId == owner.rowId);
        }
        assertFalse(repository.signedFrozen(owner));

        String twin = "ZT1000000000067";
        repository.saveInterface5(new ExpressQueryResult(twin, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(20), "快件到达营业点", tracks(nodes),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE, "SHIPMENT")), PHONE);
        assertEquals(at(110), listed(repository.findByWaybill(twin, "interface5").rowId).latestTime);
    }

    /** A signing reached by all three times, without structured evidence, is not frozen. */
    @Test public void anAlignedSigningWithoutStructuredEvidenceIsNotFrozen() throws Exception {
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + 110L * MINUTE, at(110), "快件已签收",
                tracks(new String[][]{{at(110), "快件已签收"}, {at(0), "快件已揽收"}}),
                "", PHONE, "interface5", "", "", "ZhongTong"), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        assertFalse(repository.signedFrozen(owner));
        assertFalse(repository.signedFrozenRows("interface5").contains(owner.rowId));
    }

    /** 「只停本机发起的请求」but identity stays: an order without its carrier waybill keeps its requests. */
    @Test public void anOrderWithoutItsWaybillIsNotFrozen() throws Exception {
        ExpressItem order = jdOrder(110L, new String[][]{
                {at(110), JD_SIGNED}, {at(60), JD_DELIVERING}, {at(0), JD_PICKUP}});
        ExpressRepository.StatusAlignmentProbe probe = probe(order);
        assertEquals(StatusSemantic.COMPLETED, probe.row.semantic);
        assertTrue(ExpressRepository.signedTripleReached(probe.row.semantic, probe.statusAt, probe.headlineAt,
                probe.detailAt, System.currentTimeMillis()));
        assertFalse(repository.signedFrozen(order));

        ExpressItem projected = project(order);
        assertTrue("with its waybill the same times freeze it", repository.signedFrozen(projected));
    }

    /**
     * AGENTS §9「临时头条」: a JD review kept as the first signing is a temporary headline. Its times reach the
     * signing (a real signed node three minutes earlier keeps D there), yet the row is not frozen.
     */
    @Test public void aReviewKeptAsTheFirstSigningIsNotTheSigning() throws Exception {
        ExpressItem owner = project(jdOrder(110L, new String[][]{
                {at(110), REVIEW}, {at(107), JD_SIGNED}, {at(60), JD_DELIVERING}, {at(0), JD_PICKUP}}));
        assertEquals(REVIEW, listed(owner.rowId).latestDetail);
        ExpressRepository.StatusAlignmentProbe probe = probe(owner);
        assertTrue(ExpressRepository.signedTripleReached(probe.row.semantic, probe.statusAt, probe.headlineAt,
                probe.detailAt, System.currentTimeMillis()));
        assertFalse(repository.signedFrozen(owner));

        // A union page captured after the completion now leads the detail, ending at the real signed node; the list
        // headline is still the review (that page has nothing newer than the account's own node), so still open.
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(JD, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L, at(107), JD_SIGNED,
                        tracks(new String[][]{{at(107), JD_SIGNED}, {at(60), JD_DELIVERING},
                                {at(30), "您的订单已到达【测试站】"}, {at(0), JD_PICKUP}}),
                        "", "", TimelineSlot.JD_H5, "", "", ""), true));
        owner = repository.find(owner.rowId);
        assertEquals(REVIEW, listed(owner.rowId).latestDetail);
        assertEquals(TimelineSlot.JD_H5, repository.manualDetailTimelineAuthority(owner).provider);
        assertFalse(repository.signedFrozen(owner));
    }

    /**
     * The same rule on the detail side: the list headline is a real signed node, but the package the detail page
     * shows (the per-parcel query) ends with the review kept as the first signing, so the row is not frozen.
     */
    @Test public void aDetailEndingWithAKeptReviewIsNotTheSigning() throws Exception {
        ExpressItem owner = project(jdOrder(110L, new String[][]{
                {at(108), JD_SIGNED}, {at(60), JD_DELIVERING}, {at(0), JD_PICKUP}}));
        assertTrue(repository.saveInterface5Query(new ExpressQueryResult(ORDER, "JD", "京东快递",
                StatusSemantic.COMPLETED, base + 110L * MINUTE, at(110), REVIEW, tracks(new String[][]{
                        {at(110), REVIEW}, {at(108), JD_SIGNED}, {at(60), JD_DELIVERING},
                        {at(30), "您的订单已到达【测试站】"}, {at(0), JD_PICKUP}}),
                "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + 110L * MINUTE, "ORDER")),
                owner, repository.bindingGeneration(PHONE, "interface5")));
        owner = repository.find(owner.rowId);
        ExpressRepository.StatusAlignmentProbe probe = probe(owner);
        assertEquals(JD_SIGNED, probe.row.latestDetail);
        assertTrue(ExpressRepository.signedTripleReached(probe.row.semantic, probe.statusAt, probe.headlineAt,
                probe.detailAt, System.currentTimeMillis()));
        assertFalse(repository.signedFrozen(owner));
    }

    /**
     * 弹窗「先用掉再冻结」: the list headline (+150, a node after the signing) is more than half an hour past what the
     * detail shows (+110), so the detail is incomplete and the JD signed-history gap still owes its one union page;
     * the row is not frozen until that page, captured after the completion, is stored.
     */
    @Test public void aSignedHistoryGapStillDueKeepsTheRowOpenUntilItsUnionPage() throws Exception {
        ExpressItem owner = project(jdOrder(110L, at(150), "您的快件已放至代收点", new String[][]{
                {at(110), JD_SIGNED}, {at(60), JD_DELIVERING}, {at(0), JD_PICKUP}}));
        ExpressRepository.StatusAlignmentProbe probe = probe(owner);
        assertEquals(base + 150L * MINUTE, probe.headlineAt);
        assertEquals(base + 110L * MINUTE, probe.detailAt);
        assertTrue(ExpressRepository.signedTripleReached(probe.row.semantic, probe.statusAt, probe.headlineAt,
                probe.detailAt, System.currentTimeMillis()));
        assertTrue(me.pipi.deliveries.feature.express.ExpressDetailActivity.signedJingDongHistoryGap(probe.row,
                repository.automaticSourceTimeline(owner), null, false));
        assertFalse(repository.signedFrozen(owner));

        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(JD, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L, at(150), "您的快件已放至代收点",
                        tracks(new String[][]{{at(150), "您的快件已放至代收点"}, {at(110), JD_SIGNED},
                                {at(60), JD_DELIVERING}, {at(0), JD_PICKUP}}),
                        "", "", TimelineSlot.JD_H5, "", "", ""), true));
        owner = repository.find(owner.rowId);
        assertTrue("the union page after the completion spent the gap", repository.signedFrozen(owner));
    }

    private ExpressItem zto(long signedAtMinutes, String[][] nodes) throws Exception {
        repository.saveInterface5(new ExpressQueryResult(ZTO, "ZTO", "中通快递", StatusSemantic.COMPLETED,
                base + signedAtMinutes * MINUTE, nodes[0][0], nodes[0][1], tracks(nodes),
                "", PHONE, "interface5", "", "", "ZhongTong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, base + signedAtMinutes * MINUTE,
                        "SHIPMENT")), PHONE);
        ExpressItem owner = repository.findByWaybill(ZTO, "interface5");
        assertNotNull(owner);
        return owner;
    }

    private ExpressItem jdOrder(long completedAtMinutes, String[][] nodes) throws Exception {
        return jdOrder(completedAtMinutes, nodes[0][0], nodes[0][1], nodes);
    }

    private ExpressItem jdOrder(long completedAtMinutes, String headlineAt, String headline, String[][] nodes)
            throws Exception {
        long completedAt = base + completedAtMinutes * MINUTE;
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JD", "京东快递",
                StatusSemantic.COMPLETED, completedAt, headlineAt, headline, tracks(nodes),
                "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(structured(StatusSemantic.COMPLETED, completedAt, "ORDER")), PHONE);
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        return owner;
    }

    private ExpressItem project(ExpressItem order) {
        assertTrue(repository.saveOrderProjection(order, "interface5", JD, "京东快递"));
        return repository.find(order.rowId);
    }

    private ExpressRepository.StatusAlignmentProbe probe(ExpressItem owner) {
        for (ExpressRepository.StatusAlignmentProbe probe : repository.statusAlignmentProbes("interface5")) {
            if (probe.row.rowId == owner.rowId) return probe;
        }
        throw new AssertionError("no probe for the row");
    }

    private ExpressItem listed(long rowId) {
        for (ExpressItem item : repository.listVisible("interface5")) {
            if (item.rowId == rowId) return item;
        }
        throw new AssertionError("row not listed");
    }

    private String at(long minutes) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new Date(base + minutes * MINUTE));
    }

    private static WorkerStatusProjection structured(StatusSemantic semantic, long eventAtMs, String scope)
            throws Exception {
        return WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", scope).put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                        .put("eventAtMs", eventAtMs).put("structured", true)));
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        return value.toString();
    }
}
