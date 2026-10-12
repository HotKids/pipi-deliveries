package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static me.pipi.deliveries.FixtureDay.at;

import android.app.Application;
import android.content.Context;

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
 * 用户定 2026-09-27（四端同口径）：京东「订单已完成 / 期待您评价」节点只有在这一票更早就已结构化签收时才删；
 * 否则它就是第一条签收证据，照普通节点留着（能当列表头条、保留自己的时间）。更早的签收只认两样：这一行或同一个
 * 槽在这个包之前存下的结构化签收时间，和同一个包里自己带签收状态的节点（结构化的 Worker 投影，否则节点自己的
 * 原始状态码，从不看文案）。进来的包自己的包级状态时间不算：接口 5 的包级时钟就是最新一条、也就是评价自己。
 *
 * <p>同日用户又定「这个已完成只能当作临时轨迹，打开详情页时签收轨迹可以覆盖列表页头条轨迹」（详情页排第一的包）：
 * 列表表头是留下的评价时，签收头条例外的基准改为 feed 里最新的非评价节点。</p>
 *
 * <p>真机实测的形状（2026-09-27，Lite beta，接口 5 京东件；运单号、订单号在夹具里换成合成值）：v5_list 结构化
 * 已签收 17:52:33、没有带时间的节点；v5_query 到 16:16:18 派送中，另有 17:52:33 的评价节点。评价被删、列表头条停在
 * 16:16。这一行此前从未签收，评价就是第一条签收证据。夹具时间按 {@link me.pipi.deliveries.FixtureDay} 平移，间隔
 * 不变。</p>
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class JingDongReviewAfterSigningTest {
    private static final String PHONE = "13800000001";
    private static final String ORDER = "3999999000000001";
    private static final String WAYBILL = "JD9990000000001";
    private static final String REVIEW = "您的订单" + ORDER
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
    private static final String DELIVERING = "您的快件正在派送中，请您准备签收（快递员：测试，电话：00000000000）";
    private static final String DELIVERED = "您的订单已送达至【家门口】，感谢您在京东购物，欢迎再次光临。";
    private static final String SIGNED = "您的订单已签收。签收人：本人。感谢您在京东购物，欢迎再次光临。";
    private static final String REVIEW_AT = at("2026-09-23 17:52:33");
    private static final String DELIVERED_AT = at("2026-09-23 17:52:30");
    private static final String DELIVERING_AT = at("2026-09-23 16:16:18");
    private static final String[][] QUERY_NODES = {
            {REVIEW_AT, REVIEW},
            {DELIVERING_AT, DELIVERING},
            {at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】"},
            {at("2026-09-22 10:10:13"), "您的快件已由京东快递揽收完成"}};
    private static final String[][] UNION_PAGE = {
            {DELIVERED_AT, DELIVERED},
            {DELIVERING_AT, DELIVERING},
            {at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】"},
            {at("2026-09-22 23:05:41"), "您的快件已离开【测试分拣中心】"},
            {at("2026-09-22 10:10:13"), "您的快件已由京东快递揽收完成"}};

    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(PHONE, "interface5");
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    /** 真机形状的接口 5 v5_query：节点不带状态（投影恒为 UNKNOWN / structured:false），包的状态钟就是评价自己的时间。 */
    @Test public void theInterface5QueryKeepsAReviewThatIsTheFirstSigning() throws Exception {
        ExpressQueryResult query = parsedInterface5Query();
        assertEquals(StatusSemantic.COMPLETED, query.semantic);
        assertEquals(millis(REVIEW_AT), query.statusEventTime);
        assertEquals(REVIEW, query.latestDetail);
        for (long prior : new long[]{0L, millis(REVIEW_AT)}) {
            ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(query, ORDER, prior);
            assertSame("prior " + prior, query, clean);
            assertEquals(REVIEW, clean.latestDetail);
            assertEquals(REVIEW_AT, clean.latestTime);
            assertFalse(JingDongOrderCompletionPolicy.removesAt(query, ORDER, prior, millis(REVIEW_AT)));
        }
    }

    /**
     * 用户 2026-09-27「要求」：评价只有在它自己的包报了结构化签收（包的结构化 COMPLETED、带结构化签收投影的节点或原始
     * 签收状态码）时才可能是第一条签收；包里没有结构化签收时照旧删。
     */
    @Test public void aPacketWithoutStructuredSigningDropsItsReviews() throws Exception {
        JSONArray tracks = new JSONArray().put(node(REVIEW_AT, REVIEW)).put(node(DELIVERING_AT, DELIVERING));
        for (ExpressQueryResult packet : new ExpressQueryResult[]{
                new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.COMPLETED, millis(REVIEW_AT),
                        REVIEW_AT, REVIEW, tracks.toString(), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong"),
                new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L,
                        REVIEW_AT, REVIEW, tracks.toString(), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong")}) {
            assertFalse(packet.structuredStatusEvidence);
            ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(packet, ORDER, 0L);
            assertFalse(clean.tracksJson.contains("期待您"));
            assertEquals(DELIVERING, clean.latestDetail);
        }
        ExpressQueryResult rawSigned = new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.COMPLETED,
                millis(REVIEW_AT), REVIEW_AT, REVIEW, new JSONArray()
                .put(node(REVIEW_AT, REVIEW).put("statusCode", "107"))
                .put(node(DELIVERING_AT, DELIVERING)).toString(), "", PHONE, TimelineSlot.V5_QUERY, "", "",
                "JingDong");
        assertSame(rawSigned, JingDongOrderCompletionPolicy.clean(rawSigned, ORDER, 0L));
    }

    /**
     * 同一条评价 5 分钟内推了两次：时间线合并后只显示较新的一条，四端都按合并后的时间线判。更早存下的签收就在第一条的
     * 时间（上一轮它就是第一条签收、存下了这个时间）：那个签收就是这条评价自己的一份，不算更早的签收（用户 2026-09-28
     * 「修，按规则保留」，原先两条一起删）；更早的签收就在较新那条的时间或没有更早的签收：两条都留，时间线显示一条、时间
     * 是较新的。
     */
    @Test public void twinReviewsAreJudgedOnTheCollapsedTimeline() throws Exception {
        String twinAt = at("2026-09-23 17:54:33");
        ExpressQueryResult packet = packet(twinAt, new JSONArray()
                .put(node(twinAt, REVIEW)).put(node(REVIEW_AT, REVIEW))
                .put(node(DELIVERING_AT, DELIVERING)));

        assertSame(packet, JingDongOrderCompletionPolicy.clean(packet, ORDER, millis(REVIEW_AT)));
        assertFalse(JingDongOrderCompletionPolicy.removesAt(packet, ORDER, millis(REVIEW_AT), millis(REVIEW_AT)));

        for (long prior : new long[]{millis(twinAt), 0L}) {
            assertSame("prior " + prior, packet, JingDongOrderCompletionPolicy.clean(packet, ORDER, prior));
        }
        java.util.List<me.pipi.deliveries.model.ExpressTimeline.Track> shown =
                me.pipi.deliveries.model.ExpressTimeline.parse(packet.tracksJson, "", "");
        assertEquals(2, shown.size());
        assertEquals(REVIEW, shown.get(0).detail);
        assertEquals(twinAt, shown.get(0).time);
    }

    /**
     * 用户 2026-09-28「修，按规则保留」：上一轮第一条签收的评价存下了完成时间（17:52:33），这一轮同一条评价又推了一份
     * （17:54:33，5 分钟内）。存下的时间就是这条评价自己的一份，不算更早的签收：两份都在这一轮的包里，或者这一轮只有
     * 较新的一份、上一轮存下的包（表头是 17:52:33 的评价）说明了那个时间是它，评价都留着、仍是表头。
     */
    @Test public void aCrossRoundTwinOfTheFirstSigningIsKept() throws Exception {
        String twinAt = at("2026-09-23 17:54:33");
        long anchor = millis(REVIEW_AT);
        ExpressQueryResult both = packet(twinAt, new JSONArray().put(node(twinAt, REVIEW))
                .put(node(REVIEW_AT, REVIEW)).put(node(DELIVERING_AT, DELIVERING)));
        ExpressQueryResult roundOne = packet(REVIEW_AT, new JSONArray());
        ExpressQueryResult newerOnly = packet(twinAt, new JSONArray().put(node(twinAt, REVIEW))
                .put(node(DELIVERING_AT, DELIVERING)));
        for (ExpressQueryResult packet : new ExpressQueryResult[]{both, newerOnly}) {
            ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(packet, ORDER, anchor, roundOne);
            assertSame(packet.tracksJson, packet, clean);
            assertEquals(REVIEW, clean.latestDetail);
            assertEquals(twinAt, clean.latestTime);
            assertFalse(JingDongOrderCompletionPolicy.removesAt(packet, ORDER, anchor, millis(twinAt), roundOne));
        }
        assertSame(both, JingDongOrderCompletionPolicy.clean(both, ORDER, anchor));
    }

    /** 同上，但这一轮的那份比存下的完成时间晚 5 分钟以上：是另一条事件，照删；存下时间上的那一份留着。 */
    @Test public void aCrossRoundCopyMoreThanFiveMinutesLaterIsStillRemoved() throws Exception {
        String laterAt = at("2026-09-23 17:58:34");
        long anchor = millis(REVIEW_AT);
        ExpressQueryResult both = packet(laterAt, new JSONArray().put(node(laterAt, REVIEW))
                .put(node(REVIEW_AT, REVIEW)).put(node(DELIVERING_AT, DELIVERING)));
        ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(both, ORDER, anchor);
        assertEquals(REVIEW, clean.latestDetail);
        assertEquals(REVIEW_AT, clean.latestTime);
        assertEquals(2, me.pipi.deliveries.model.ExpressTimeline.parse(clean.tracksJson, "", "").size());
        assertTrue(JingDongOrderCompletionPolicy.removesAt(both, ORDER, anchor, millis(laterAt)));

        ExpressQueryResult laterOnly = packet(laterAt, new JSONArray().put(node(laterAt, REVIEW))
                .put(node(DELIVERING_AT, DELIVERING)));
        ExpressQueryResult cleaned = JingDongOrderCompletionPolicy.clean(laterOnly, ORDER, anchor,
                packet(REVIEW_AT, new JSONArray()));
        assertFalse(cleaned.tracksJson.contains("期待您"));
        assertEquals(DELIVERING, cleaned.latestDetail);
    }

    /**
     * 存下的完成时间是另一个节点的（17:52:30 已送达，不带状态），评价 3 秒之后：真正更早的签收，照删；那个节点只在上一轮
     * 存下的包里也一样。存下的完成时间那一刻没有任何节点（17:52:00，评价 17:52:33）：说明不了它是这条评价，照删。
     */
    @Test public void aDifferentEarlierSigningStillRemovesTheReview() throws Exception {
        ExpressQueryResult delivered = packet(REVIEW_AT, new JSONArray().put(node(REVIEW_AT, REVIEW))
                .put(node(DELIVERED_AT, DELIVERED)).put(node(DELIVERING_AT, DELIVERING)));
        ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(delivered, ORDER, millis(DELIVERED_AT));
        assertFalse(clean.tracksJson.contains("期待您"));
        assertEquals(DELIVERED, clean.latestDetail);
        assertTrue(JingDongOrderCompletionPolicy.removesAt(delivered, ORDER, millis(DELIVERED_AT), millis(REVIEW_AT)));
        ExpressQueryResult reviewOnly = packet(REVIEW_AT, new JSONArray().put(node(REVIEW_AT, REVIEW))
                .put(node(DELIVERING_AT, DELIVERING)));
        ExpressQueryResult storedDelivery = new ExpressQueryResult(WAYBILL, "JD", "京东快递",
                StatusSemantic.COMPLETED, millis(DELIVERED_AT), DELIVERED_AT, DELIVERED, "[]", "", PHONE,
                "interface5", "", "", "JingDong").withManualStatusEvidence("已签收", true);
        assertFalse(JingDongOrderCompletionPolicy.clean(reviewOnly, ORDER, millis(DELIVERED_AT), storedDelivery)
                .tracksJson.contains("期待您"));

        String clockAt = at("2026-09-23 17:52:00");
        ExpressQueryResult nodeless = new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.COMPLETED,
                millis(clockAt), REVIEW_AT, REVIEW, new JSONArray().put(node(REVIEW_AT, REVIEW))
                .put(node(DELIVERING_AT, DELIVERING)).toString(), "", PHONE, TimelineSlot.V5_QUERY, "", "",
                "JingDong").withManualStatusEvidence("已签收", true);
        ExpressQueryResult cleaned = JingDongOrderCompletionPolicy.clean(nodeless, ORDER, millis(clockAt));
        assertFalse(cleaned.tracksJson.contains("期待您"));
        assertEquals(DELIVERING, cleaned.latestDetail);
    }

    /**
     * 同一条评价 5 分钟内推了两次、两份都自己带签收（结构化投影或原始 107），此前没有签收：签收证据也按合并后的时间线
     * 量（较新那份的时间），较早那份不能当「更早的签收」把自己删掉——两份都留，它就是第一条签收。
     */
    @Test public void twinSigningReviewsWithoutAnEarlierSigningAreKept() throws Exception {
        String twinAt = at("2026-09-23 17:54:33");
        for (boolean structured : new boolean[]{true, false}) {
            ExpressQueryResult packet = packet(twinAt, new JSONArray()
                    .put(signedReview(twinAt, structured)).put(signedReview(REVIEW_AT, structured))
                    .put(node(DELIVERING_AT, DELIVERING)));
            String form = structured ? "structured" : "raw";
            assertSame(form, packet, JingDongOrderCompletionPolicy.clean(packet, ORDER, 0L));
            assertFalse(form, JingDongOrderCompletionPolicy.removesAt(packet, ORDER, 0L, millis(REVIEW_AT)));
            assertFalse(form, JingDongOrderCompletionPolicy.removesAt(packet, ORDER, 0L, millis(twinAt)));
        }
    }

    /** 两份相隔超过 5 分钟就是两个节点：较早那份是第一条签收、留着，之后那份照删（结构化与原始两种形式）。 */
    @Test public void aSigningReviewMoreThanFiveMinutesLaterIsStillRemoved() throws Exception {
        String laterAt = at("2026-09-23 17:58:34");
        for (boolean structured : new boolean[]{true, false}) {
            ExpressQueryResult packet = packet(laterAt, new JSONArray()
                    .put(signedReview(laterAt, structured)).put(signedReview(REVIEW_AT, structured))
                    .put(node(DELIVERING_AT, DELIVERING)));
            String form = structured ? "structured" : "raw";
            ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(packet, ORDER, 0L);
            assertNotSame(form, packet, clean);
            assertEquals(form, REVIEW, clean.latestDetail);
            assertEquals(form, REVIEW_AT, clean.latestTime);
            assertEquals(form, 2, me.pipi.deliveries.model.ExpressTimeline.parse(clean.tracksJson, "", "").size());
            assertFalse(form, JingDongOrderCompletionPolicy.removesAt(packet, ORDER, 0L, millis(REVIEW_AT)));
            assertTrue(form, JingDongOrderCompletionPolicy.removesAt(packet, ORDER, 0L, millis(laterAt)));
        }
    }

    private static JSONObject signedReview(String time, boolean structured) throws Exception {
        return structured
                ? node(time, REVIEW).put("normalizedStatus", projection("COMPLETED", millis(time), true))
                : node(time, REVIEW).put("statusCode", "107");
    }

    /** 更早存下的结构化签收：之后才来的评价照删，头条回到签收节点；不带时间的评价只要签收过就删。 */
    @Test public void anEarlierStoredSigningDropsTheLaterReview() throws Exception {
        String signedAt = at("2026-09-20 12:00:00");
        ExpressQueryResult packet = packet(REVIEW_AT, new JSONArray()
                .put(node(REVIEW_AT, REVIEW)).put(node(signedAt, SIGNED))
                .put(node(at("2026-09-20 09:00:00"), DELIVERING)));
        ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(packet, ORDER, millis(signedAt));
        assertEquals(SIGNED, clean.latestDetail);
        assertEquals(signedAt, clean.latestTime);
        assertFalse(clean.tracksJson.contains("期待您"));
        assertEquals(StatusSemantic.COMPLETED, clean.semantic);
        assertTrue(JingDongOrderCompletionPolicy.removesAt(packet, ORDER, millis(signedAt), millis(REVIEW_AT)));

        ExpressQueryResult untimed = packet("", new JSONArray()
                .put(node("", REVIEW)).put(node(signedAt, SIGNED)));
        assertFalse(JingDongOrderCompletionPolicy.clean(untimed, ORDER, millis(signedAt))
                .tracksJson.contains("期待您"));
        assertSame(untimed, JingDongOrderCompletionPolicy.clean(untimed, ORDER, 0L));
    }

    /** 更早的签收时间就是评价自己的时间：评价是第一条签收，不删。 */
    @Test public void aPriorSigningAtTheReviewItselfKeepsIt() throws Exception {
        ExpressQueryResult packet = packet(REVIEW_AT, new JSONArray()
                .put(node(REVIEW_AT, REVIEW)).put(node(DELIVERING_AT, DELIVERING)));
        assertSame(packet, JingDongOrderCompletionPolicy.clean(packet, ORDER, millis(REVIEW_AT)));
        assertFalse(JingDongOrderCompletionPolicy.removesAt(packet, ORDER, millis(REVIEW_AT), millis(REVIEW_AT)));
        ExpressQueryResult later = JingDongOrderCompletionPolicy.clean(packet, ORDER, millis(REVIEW_AT) - 1_000L);
        assertEquals(DELIVERING, later.latestDetail);
    }

    /**
     * 同一个包里更早的节点自己带签收状态：评价删掉。结构化投影（没有 eventAtMs 时用节点自己的时间），或者
     * 没有结构化投影时节点自己的原始状态码 107；105、文案形式的状态、不结构化的投影和包级状态时间都不算；
     * 评价节点自己带的签收不早于它自己。
     */
    @Test public void anEarlierSignedNodeInThePacketDropsTheReview() throws Exception {
        String signedAt = at("2026-09-23 12:00:00");
        JSONObject[] signedNodes = {
                node(signedAt, SIGNED).put("normalizedStatus", projection("COMPLETED", millis(signedAt), true)),
                node(signedAt, SIGNED).put("normalizedStatus", projection("COMPLETED", 0L, true)),
                node(signedAt, SIGNED).put("statusCode", "107"),
                node(signedAt, SIGNED).put("statusCode", "107")
                        .put("normalizedStatus", projection("UNKNOWN", 0L, false))};
        for (JSONObject signed : signedNodes) {
            ExpressQueryResult packet = packet(REVIEW_AT, new JSONArray()
                    .put(node(REVIEW_AT, REVIEW)).put(signed).put(node(DELIVERING_AT, DELIVERING)));
            ExpressQueryResult clean = JingDongOrderCompletionPolicy.clean(packet, ORDER, 0L);
            assertNotSame(signed.toString(), packet, clean);
            assertFalse(clean.tracksJson.contains("期待您"));
            assertEquals(DELIVERING, clean.latestDetail);
        }

        JSONObject[] notSigned = {
                node(signedAt, SIGNED).put("statusCode", "105"),
                node(signedAt, SIGNED).put("state", "已签收").put("stateText", "已签收"),
                node(signedAt, SIGNED).put("normalizedStatus", projection("COMPLETED", millis(signedAt), false)),
                node(signedAt, SIGNED).put("statusCode", "107")
                        .put("normalizedStatus", projection("DELIVERY", millis(signedAt), true))};
        for (JSONObject other : notSigned) {
            ExpressQueryResult packet = packet(REVIEW_AT, new JSONArray()
                    .put(node(REVIEW_AT, REVIEW)).put(other).put(node(DELIVERING_AT, DELIVERING)));
            assertSame(other.toString(), packet, JingDongOrderCompletionPolicy.clean(packet, ORDER, 0L));
        }

        ExpressQueryResult reviewCarriesCompletion = packet(REVIEW_AT, new JSONArray()
                .put(node(REVIEW_AT, REVIEW).put("statusCode", "107"))
                .put(node(DELIVERING_AT, DELIVERING)));
        assertSame(reviewCarriesCompletion,
                JingDongOrderCompletionPolicy.clean(reviewCarriesCompletion, ORDER, 0L));

        ExpressQueryResult packageClock = new ExpressQueryResult(WAYBILL, "JD", "京东快递",
                StatusSemantic.COMPLETED, millis(signedAt), REVIEW_AT, REVIEW, new JSONArray()
                .put(node(REVIEW_AT, REVIEW)).put(node(DELIVERING_AT, DELIVERING)).toString(),
                "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong")
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject().put("normalizedStatus",
                        projection("COMPLETED", millis(signedAt), true))));
        assertSame(packageClock, JingDongOrderCompletionPolicy.clean(packageClock, ORDER, 0L));
    }

    /**
     * 真机的顺序落到仓库里——订单派送中、投影到京东运单、v5_query 到 16:16 派送中，然后列表结构化签收（列表头条就是
     * 评价、没有带时间的节点），再查 v5_query 带回评价。评价留在 query 里，列表头条先是 17:52:33 的评价（临时轨迹）。
     * 重复同步、重读、重开数据库都不翻、留存锚点不动。京粉页抓到 17:52:30 已送达、成为详情排第一的包之后，列表头条
     * 换成它。
     */
    @Test public void theDeviceSequenceKeepsTheReviewUntilTheDetailSignatureArrives() throws Exception {
        long reviewMs = millis(REVIEW_AT);
        list(StatusSemantic.DELIVERY, at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】");
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        String[][] beforeSigning = {QUERY_NODES[1], QUERY_NODES[2], QUERY_NODES[3]};
        assertTrue(repository.saveInterface5Query(query(beforeSigning, StatusSemantic.DELIVERY),
                repository.find(owner.rowId), repository.bindingGeneration(PHONE, "interface5")));

        list(StatusSemantic.COMPLETED, REVIEW_AT, REVIEW);
        assertTrue(repository.saveInterface5Query(query(QUERY_NODES, StatusSemantic.COMPLETED),
                repository.find(owner.rowId), repository.bindingGeneration(PHONE, "interface5")));
        long anchor = storedAnchor(owner.rowId);

        for (int round = 0; round < 3; round++) {
            ExpressItem listed = listed(owner.rowId);
            assertEquals("round " + round, StatusSemantic.COMPLETED, listed.semantic);
            assertEquals("round " + round, REVIEW, listed.latestDetail);
            assertEquals("round " + round, REVIEW_AT, listed.latestTime);
            assertEquals(REVIEW, repository.find(owner.rowId).latestDetail);
            ExpressQueryResult stored = repository.accountTimeline(WAYBILL, "interface5");
            assertNotNull(stored);
            assertTrue(stored.tracksJson.contains("期待您"));
            assertEquals(REVIEW, stored.latestDetail);
            assertEquals(anchor, storedAnchor(owner.rowId));

            list(StatusSemantic.COMPLETED, REVIEW_AT, REVIEW);
            assertTrue(repository.saveInterface5Query(query(QUERY_NODES, StatusSemantic.COMPLETED),
                    repository.find(owner.rowId), repository.bindingGeneration(PHONE, "interface5")));
            database.close();
            database = new ExpressDatabase(context);
            repository = new ExpressRepository(context, database);
        }
        assertEquals(reviewMs, anchor);

        owner = repository.find(owner.rowId);
        ManualTimelineAuthorityPolicy.Candidate before = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(before);
        assertEquals("the query with the kept review is the top package", TimelineSlot.V5_QUERY, before.provider);
        assertEquals(REVIEW, before.result.latestDetail);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        assertTrue(repository.saveAutomaticDetailTimeline(owner, claim, new ExpressQueryResult(
                WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L, DELIVERED_AT, DELIVERED,
                tracks(UNION_PAGE), "", "", TimelineSlot.JD_H5, "", "", ""), true));
        owner = repository.find(owner.rowId);
        ManualTimelineAuthorityPolicy.Candidate top = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(top);
        assertEquals("the union page is the detail's top package", TimelineSlot.JD_H5, top.provider);
        ExpressItem listed = listed(owner.rowId);
        assertEquals(StatusSemantic.COMPLETED, listed.semantic);
        assertEquals(DELIVERED, listed.latestDetail);
        assertEquals(DELIVERED_AT, listed.latestTime);
        assertEquals(DELIVERED, repository.find(owner.rowId).latestDetail);
        assertTrue("the query keeps its own review", repository.accountTimeline(WAYBILL, "interface5")
                .tracksJson.contains("期待您"));
        assertEquals(anchor, storedAnchor(owner.rowId));
    }

    /**
     * 用户 2026-09-28「修，按规则保留」，仓库里走一遍：第一轮评价是第一条签收（列表与 query 都到 17:52:33，这一行存下
     * 17:52:33 的完成时间），第二轮 query 里同一条评价 2 分钟后又推了一份（两份都在）。评价留在 query 里（合并成
     * 17:54:33 的一条），列表表头仍是评价、不回到 16:16 的派送中；重读照旧。
     */
    @Test public void aCrossRoundTwinStaysInTheQueryAndOnTheList() throws Exception {
        String twinAt = at("2026-09-23 17:54:33");
        list(StatusSemantic.DELIVERY, at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】");
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        list(StatusSemantic.COMPLETED, REVIEW_AT, REVIEW);
        assertTrue(repository.saveInterface5Query(query(QUERY_NODES, StatusSemantic.COMPLETED),
                repository.find(owner.rowId), repository.bindingGeneration(PHONE, "interface5")));
        assertEquals(REVIEW, listed(owner.rowId).latestDetail);
        assertEquals(millis(REVIEW_AT), storedAnchor(owner.rowId));

        String[][] twice = {{twinAt, REVIEW}, QUERY_NODES[0], QUERY_NODES[1], QUERY_NODES[2], QUERY_NODES[3]};
        list(StatusSemantic.COMPLETED, twinAt, REVIEW);
        assertTrue(repository.saveInterface5Query(query(twice, StatusSemantic.COMPLETED),
                repository.find(owner.rowId), repository.bindingGeneration(PHONE, "interface5")));
        for (int read = 0; read < 2; read++) {
            ExpressQueryResult stored = repository.accountTimeline(WAYBILL, "interface5");
            assertTrue("read " + read, stored.tracksJson.contains("期待您"));
            assertEquals("read " + read, twinAt, queryHeadlineTime(stored));
            ExpressItem listed = listed(owner.rowId);
            assertEquals("read " + read, REVIEW, listed.latestDetail);
            assertEquals("read " + read, StatusSemantic.COMPLETED, listed.semantic);
            database.close();
            database = new ExpressDatabase(context);
            repository = new ExpressRepository(context, database);
        }
    }

    private static String queryHeadlineTime(ExpressQueryResult packet) {
        java.util.List<me.pipi.deliveries.model.ExpressTimeline.Track> shown =
                me.pipi.deliveries.model.ExpressTimeline.parse(packet.tracksJson, "", "");
        return shown.isEmpty() ? "" : shown.get(0).time;
    }

    /**
     * 用户 2026-09-27「收窄」：评价只在账号的包和非账号的包比时不算。评价只在 v5_query 里、feed 的节点到 16:16 而且
     * 条数更多时，账号自己的包之间照旧连评价一起排：v5_query 仍是详情排第一的包，最新一条是评价，列表的临时表头也是它。
     */
    @Test public void aReviewOnlyInTheQueryStillWinsAmongTheAccountPackages() throws Exception {
        list(StatusSemantic.DELIVERY, at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】");
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        listWithNodes(StatusSemantic.COMPLETED, REVIEW_AT, new String[][]{
                {DELIVERING_AT, DELIVERING},
                {at("2026-09-23 12:00:00"), "您的快件已到达【测试站点】"},
                {at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】"},
                {at("2026-09-22 23:05:41"), "您的快件已离开【测试分拣中心】"},
                {at("2026-09-22 10:10:13"), "您的快件已由京东快递揽收完成"}});
        assertTrue(repository.saveInterface5Query(query(QUERY_NODES, StatusSemantic.COMPLETED),
                repository.find(owner.rowId), repository.bindingGeneration(PHONE, "interface5")));

        owner = repository.find(owner.rowId);
        ManualTimelineAuthorityPolicy.Candidate top = repository.manualDetailTimelineAuthority(owner);
        assertNotNull("the query outranks the feed", top);
        assertEquals(TimelineSlot.V5_QUERY, top.provider);
        assertEquals(REVIEW, top.result.latestDetail);
        ExpressItem listed = listed(owner.rowId);
        assertEquals(REVIEW, listed.latestDetail);
        assertEquals(REVIEW_AT, listed.latestTime);
    }

    /**
     * 用户 2026-09-27「要求」：京粉页要在结构化完成时间当时或之后抓到才能和拿掉评价的账号包比、才能换表头。同一个止于
     * 16:17 派送中（严格晚于账号最后一条 16:16，用户 2026-09-28「改成严格晚于」）、条数更多的京粉页：算作完成之后抓的，
     * 它排第一，换成派送中；算作完成之前抓的，它和带着评价的 v5_query 比、排不到第一，列表不被拉回派送中。
     */
    @Test public void aUnionPageCapturedBeforeTheCompletionNeverOverrides() throws Exception {
        ExpressItem owner = signedWithQueryReview();
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        String pageAt = at("2026-09-23 16:17:18");
        assertTrue(repository.saveAutomaticDetailTimeline(owner, claim, new ExpressQueryResult(
                WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L, pageAt, DELIVERING,
                tracks(new String[][]{
                        {pageAt, DELIVERING},
                        {at("2026-09-23 12:00:00"), "您的快件已到达【测试站点】"},
                        {at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】"},
                        {at("2026-09-22 23:05:41"), "您的快件已离开【测试分拣中心】"},
                        {at("2026-09-22 10:10:13"), "您的快件已由京东快递揽收完成"}}),
                "", "", TimelineSlot.JD_H5, "", "", ""), true));
        owner = repository.find(owner.rowId);
        ManualTimelineAuthorityPolicy.Candidate top = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(top);
        assertEquals("the old union page ranks first", TimelineSlot.JD_H5, top.provider);
        assertTrue(top.successAt >= owner.statusEventTime);
        assertEquals("captured after the completion, it overrides", DELIVERING, listed(owner.rowId).latestDetail);

        android.content.ContentValues before = new android.content.ContentValues();
        before.put("success_at", millis(REVIEW_AT) - 60L * 60L * 1000L);
        assertEquals(1, database.getWritableDatabase().update(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, before,
                "owner_row_id=? AND provider=?", new String[]{Long.toString(owner.rowId), TimelineSlot.JD_H5}));
        owner = repository.find(owner.rowId);
        ManualTimelineAuthorityPolicy.Candidate afterBackdating = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(afterBackdating);
        assertEquals(TimelineSlot.V5_QUERY, afterBackdating.provider);
        assertEquals(REVIEW, afterBackdating.result.latestDetail);
        ExpressItem listed = listed(owner.rowId);
        assertEquals(REVIEW, listed.latestDetail);
        assertEquals(REVIEW_AT, listed.latestTime);
        assertEquals(REVIEW, repository.find(owner.rowId).latestDetail);
    }

    /**
     * 同上「要求」：评价只在 v5_query、feed 到 16:16，另有一个完成之前抓的旧京粉页（真实节点更多）。旧京粉页和带着评价
     * 的 v5_query 比，详情排第一的仍是 v5_query、最新一条是评价，列表临时表头是 17:52:33 的评价；之后抓到完成之后的
     * 京粉页（17:52:30 已送达），它排第一，列表换成已送达。
     */
    @Test public void aPreCompletionUnionPageCannotWinOnlyBecauseTheReviewIsStripped() throws Exception {
        list(StatusSemantic.DELIVERY, at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】");
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        listWithNodes(StatusSemantic.COMPLETED, REVIEW_AT, new String[][]{QUERY_NODES[1], QUERY_NODES[2], QUERY_NODES[3]});
        assertTrue(repository.saveInterface5Query(query(QUERY_NODES, StatusSemantic.COMPLETED),
                repository.find(owner.rowId), repository.bindingGeneration(PHONE, "interface5")));
        owner = repository.find(owner.rowId);
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L, DELIVERING_AT,
                        DELIVERING, tracks(new String[][]{
                                {DELIVERING_AT, DELIVERING},
                                {at("2026-09-23 12:00:00"), "您的快件已到达【测试站点】"},
                                {at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】"},
                                {at("2026-09-22 23:05:41"), "您的快件已离开【测试分拣中心】"},
                                {at("2026-09-22 10:10:13"), "您的快件已由京东快递揽收完成"}}),
                        "", "", TimelineSlot.JD_H5, "", "", ""), true));
        android.content.ContentValues before = new android.content.ContentValues();
        before.put("success_at", millis(REVIEW_AT) - 60L * 60L * 1000L);
        assertEquals(1, database.getWritableDatabase().update(ExpressDatabase.OWNER_MANUAL_TIMELINE_TABLE, before,
                "owner_row_id=? AND provider=?", new String[]{Long.toString(owner.rowId), TimelineSlot.JD_H5}));

        owner = repository.find(owner.rowId);
        ManualTimelineAuthorityPolicy.Candidate top = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(top);
        assertEquals(TimelineSlot.V5_QUERY, top.provider);
        assertEquals(REVIEW, top.result.latestDetail);
        ExpressItem listed = listed(owner.rowId);
        assertEquals(REVIEW, listed.latestDetail);
        assertEquals(REVIEW_AT, listed.latestTime);

        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L, DELIVERED_AT,
                        DELIVERED, tracks(UNION_PAGE), "", "", TimelineSlot.JD_H5, "", "", ""), true));
        owner = repository.find(owner.rowId);
        top = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(top);
        assertEquals(TimelineSlot.JD_H5, top.provider);
        assertTrue(top.successAt >= owner.statusEventTime);
        listed = listed(owner.rowId);
        assertEquals(DELIVERED, listed.latestDetail);
        assertEquals(DELIVERED_AT, listed.latestTime);
    }

    /** 真机的形状：订单派送中、投影、列表结构化签收（表头就是评价、没有节点），v5_query 带回评价。 */
    /**
     * 用户 2026-09-28「改成严格晚于」：完成之后抓到、详情排第一的京粉页，最新一条只是账号自己最后那条（同一时间的
     * 16:16:18 派送中）时，列表仍显示这条临时评价；严格晚于账号最后一条的节点才换上去。
     */
    @Test public void aPostCompletionUnionPageNeedsANodeStrictlyLaterThanTheAccount() throws Exception {
        String[][] history = {
                {at("2026-09-23 12:00:00"), "您的快件已到达【测试站点】"},
                {at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】"},
                {at("2026-09-22 23:05:41"), "您的快件已离开【测试分拣中心】"},
                {at("2026-09-22 10:10:13"), "您的快件已由京东快递揽收完成"}};
        ExpressItem owner = signedWithQueryReview();
        saveUnionPage(owner, DELIVERING_AT, history);
        owner = repository.find(owner.rowId);
        ManualTimelineAuthorityPolicy.Candidate top = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(top);
        assertEquals("the post-completion union page ranks first", TimelineSlot.JD_H5, top.provider);
        ExpressItem listed = listed(owner.rowId);
        assertEquals("the same 派送中 at the same time is no newer", REVIEW, listed.latestDetail);
        assertEquals(REVIEW_AT, listed.latestTime);

        String laterAt = at("2026-09-23 16:17:18");
        saveUnionPage(repository.find(owner.rowId), laterAt, history);
        listed = listed(owner.rowId);
        assertEquals(DELIVERING, listed.latestDetail);
        assertEquals(laterAt, listed.latestTime);
    }

    /**
     * 用户 2026-10-01「除了 13 14 16 17 其他都做」（含「评价节点当临时头条那一支要不要也改成「不晚于」」）：账号自己最新的非评价节点 B（v5_query 里
     * 17:52:33 的到站）与结构化完成时间同一秒。B 不晚于完成时间，完成之后抓到、详情排第一的京粉页里严格晚于 B 的节点
     * 照样换掉临时评价；状态和状态时间仍是 feed 的，v5_query 里的评价留着。
     */
    @Test public void aTemporaryReviewAtTheSameSecondAsTheAccountsLastNodeHandsTheListOver() throws Exception {
        String sameSecond = "您的快件已到达【测试驿站】";
        list(StatusSemantic.DELIVERY, at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】");
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        list(StatusSemantic.COMPLETED, REVIEW_AT, REVIEW);
        String[][] queryNodes = {QUERY_NODES[0], {REVIEW_AT, sameSecond},
                QUERY_NODES[1], QUERY_NODES[2], QUERY_NODES[3]};
        assertTrue(repository.saveInterface5Query(query(queryNodes, StatusSemantic.COMPLETED),
                repository.find(owner.rowId), repository.bindingGeneration(PHONE, "interface5")));
        owner = repository.find(owner.rowId);
        assertTrue(repository.accountTimeline(WAYBILL, "interface5").tracksJson.contains(sameSecond));
        assertEquals(REVIEW, listed(owner.rowId).latestDetail);

        String laterAt = at("2026-09-23 17:53:33");
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L, laterAt,
                        DELIVERED, tracks(new String[][]{
                                {laterAt, DELIVERED},
                                {REVIEW_AT, sameSecond},
                                {DELIVERING_AT, DELIVERING},
                                {at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】"},
                                {at("2026-09-22 23:05:41"), "您的快件已离开【测试分拣中心】"},
                                {at("2026-09-22 10:10:13"), "您的快件已由京东快递揽收完成"}}),
                        "", "", TimelineSlot.JD_H5, "", "", ""), true));
        owner = repository.find(owner.rowId);
        ManualTimelineAuthorityPolicy.Candidate top = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(top);
        assertEquals("the post-completion union page ranks first", TimelineSlot.JD_H5, top.provider);
        ExpressItem listed = listed(owner.rowId);
        assertEquals(StatusSemantic.COMPLETED, listed.semantic);
        assertEquals(DELIVERED, listed.latestDetail);
        assertEquals(laterAt, listed.latestTime);
        assertEquals(millis(REVIEW_AT), listed.statusEventTime);
        assertEquals("find() reads the list headline of a frozen signed row", DELIVERED,
                repository.find(owner.rowId).latestDetail);
        assertTrue("the query keeps its own review", repository.accountTimeline(WAYBILL, "interface5")
                .tracksJson.contains("期待您"));
    }

    private void saveUnionPage(ExpressItem owner, String deliveringAt, String[][] history) throws Exception {
        String[][] nodes = new String[history.length + 1][];
        nodes[0] = new String[]{deliveringAt, DELIVERING};
        System.arraycopy(history, 0, nodes, 1, history.length);
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L, deliveringAt,
                        DELIVERING, tracks(nodes), "", "", TimelineSlot.JD_H5, "", "", ""), true));
    }

    private ExpressItem signedWithQueryReview() throws Exception {
        list(StatusSemantic.DELIVERY, at("2026-09-23 07:40:02"), "您的快件已到达【测试营业部】");
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        list(StatusSemantic.COMPLETED, REVIEW_AT, REVIEW);
        assertTrue(repository.saveInterface5Query(query(QUERY_NODES, StatusSemantic.COMPLETED),
                repository.find(owner.rowId), repository.bindingGeneration(PHONE, "interface5")));
        owner = repository.find(owner.rowId);
        assertEquals(REVIEW, listed(owner.rowId).latestDetail);
        return owner;
    }

    /** 仓库里：几天前 feed 就结构化签收的行（这一行存下的签收），之后 v5_query 带来的评价照删，列表头条仍是签收。 */
    @Test public void aRowSignedDaysEarlierDropsALaterQueryReview() throws Exception {
        String signedAt = at("2026-09-20 12:00:00");
        list(StatusSemantic.DELIVERY, at("2026-09-20 09:00:00"), DELIVERING);
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        list(StatusSemantic.COMPLETED, signedAt, SIGNED);

        assertTrue(repository.saveInterface5Query(query(new String[][]{
                        {REVIEW_AT, REVIEW}, {signedAt, SIGNED}, {at("2026-09-20 09:00:00"), DELIVERING},
                        {at("2026-09-19 10:10:13"), "您的快件已由京东快递揽收完成"}}, StatusSemantic.COMPLETED),
                repository.find(owner.rowId), repository.bindingGeneration(PHONE, "interface5")));
        ExpressQueryResult stored = repository.accountTimeline(WAYBILL, "interface5");
        assertFalse(stored.tracksJson.contains("期待您"));
        ExpressItem listed = listed(owner.rowId);
        assertEquals(SIGNED, listed.latestDetail);
        assertEquals(signedAt, listed.latestTime);
    }

    private ExpressQueryResult parsedInterface5Query() throws Exception {
        JSONArray details = new JSONArray();
        for (String[] node : QUERY_NODES) {
            details.put(new JSONObject().put("time", node[0]).put("desc", node[1])
                    .put("normalizedStatus", projection("UNKNOWN", 0L, false)));
        }
        JSONObject item = new JSONObject().put("mailNo", ORDER).put("cpCode", "JDKD")
                .put("name", "京东商品快递").put("provider", "JingDong").put("stateNum", "107")
                .put("normalizedStatus", projection("COMPLETED", millis(REVIEW_AT), true).put("scope", "ORDER"))
                .put("details", details);
        java.lang.reflect.Method parse = Class.forName(
                "me.pipi.deliveries.network.ExpressDiscoveryClient").getDeclaredMethod(
                "parseAccountOrder", JSONObject.class, boolean.class);
        parse.setAccessible(true);
        ExpressQueryResult parsed = (ExpressQueryResult) parse.invoke(null, item, true);
        assertNotNull(parsed);
        return parsed;
    }

    private void list(StatusSemantic semantic, String time, String headline) throws Exception {
        long eventAt = millis(time);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JD", "京东快递",
                semantic, eventAt, time, headline, "[]", "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject().put("normalizedStatus",
                        projection(semantic.name(), eventAt, true).put("scope", "ORDER")))), PHONE);
    }

    private void listWithNodes(StatusSemantic semantic, String eventAt, String[][] nodes) throws Exception {
        long eventAtMs = millis(eventAt);
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JD", "京东快递",
                semantic, eventAtMs, nodes[0][0], nodes[0][1], tracks(nodes), "", PHONE, "interface5", "", "",
                "JingDong").withWorkerStatus(WorkerStatusProjection.read(new JSONObject().put("normalizedStatus",
                        projection(semantic.name(), eventAtMs, true).put("scope", "ORDER")))), PHONE);
    }

    private static ExpressQueryResult query(String[][] nodes, StatusSemantic semantic) throws Exception {
        JSONArray tracks = new JSONArray();
        for (String[] node : nodes) {
            tracks.put(node(node[0], node[1]).put("normalizedStatus", projection("UNKNOWN", 0L, false)));
        }
        long clock = millis(nodes[0][0]);
        return new ExpressQueryResult(ORDER, "JD", "京东快递", semantic, clock, nodes[0][0], nodes[0][1],
                tracks.toString(), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong")
                .withWorkerStatus(WorkerStatusProjection.read(new JSONObject().put("normalizedStatus",
                        projection(semantic.name(), clock, true).put("scope", "ORDER"))));
    }

    private static ExpressQueryResult packet(String latestTime, JSONArray tracks) {
        return new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.COMPLETED,
                millis(latestTime), latestTime, REVIEW, tracks.toString(), "", PHONE,
                TimelineSlot.V5_QUERY, "", "", "JingDong").withManualStatusEvidence("已签收", true);
    }

    private static JSONObject node(String time, String detail) throws Exception {
        return new JSONObject().put("time", time).put("context", detail)
                .put("_pipiStatusSource", "interface5");
    }

    private static JSONObject projection(String semantic, long eventAt, boolean structured) throws Exception {
        return new JSONObject().put("version", 1).put("scope", "SHIPMENT").put("semantic", semantic)
                .put("code", "SERVER_ENUM").put("text", "").put("priority", 0)
                .put("eventAtMs", eventAt).put("structured", structured);
    }

    private long storedAnchor(long rowId) {
        try (android.database.Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, new String[]{"signedRetainedAt"}, "_id=?",
                new String[]{Long.toString(rowId)}, null, null, null)) {
            assertTrue(cursor.moveToFirst());
            return cursor.getLong(0);
        }
    }

    private ExpressItem listed(long rowId) {
        for (ExpressItem item : repository.listVisible("interface5")) {
            if (item.rowId == rowId) return item;
        }
        throw new AssertionError("the signed order is not visible");
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) value.put(node(node[0], node[1]));
        return value.toString();
    }

    private static long millis(String time) {
        return ExpressSourcePolicy.parseEventTime(time);
    }
}
