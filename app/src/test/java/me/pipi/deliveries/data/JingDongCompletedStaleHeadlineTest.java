package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
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
 * 2026-09-24（问题 3，与 iOS jd-completed-stale-headline.test.ts 同口径）：京东列表的完成事件是评价文案
 * （展示时被拦掉）或不带节点，首页能显示的最新一条停在更早的「派送中」，于是「已签收」配「派送中」；
 * 详情选中的京粉页包里有签收节点。已签收且首页表头落后于完成时间时，表头改取详情排第一的包里最新的节点。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class JingDongCompletedStaleHeadlineTest {
    private static final String PHONE = "13800001906";
    private static final String ORDER = "3999999100001906";
    private static final String WAYBILL = "JD9990000001906";
    private static final String DELIVERING = "您的订单正在派送中，请您准备签收（快递员：测试员，电话：19900000000）";
    private static final String SIGNED = "您的订单已送达至【家门口有问题，联系快递员。】。如有疑问您可以联系配送员"
            + "【测试员，19900000000】确认。感谢您在京东购物，欢迎再次光临。";
    private static final String REVIEW = "您的订单" + ORDER
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
    private static final String LEFT_WAREHOUSE = "您的订单已离开【测试城北三期接货仓】，正在发往下一站"
            + "【测试城西集散分拣中心】的路上";
    private static final String[][] SIGNED_CAPTURE = {
            {at("2026-09-23 11:12:23"), SIGNED},
            {at("2026-09-23 08:02:00"), DELIVERING},
            {at("2026-09-23 07:23:00"), "您的订单已到达【测试城东站】"},
            {at("2026-09-22 22:12:48"), LEFT_WAREHOUSE},
            {at("2026-09-22 21:48:11"), "您的订单已由京东快递揽收"}};

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

    @Test public void aCompletedRowWhoseFeedStopsAtDeliveryShowsTheDetailSignature() throws Exception {
        ExpressItem home = completedRow(new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING}}, SIGNED_CAPTURE);
        assertEquals(StatusSemantic.COMPLETED, home.semantic);
        assertEquals(SIGNED, home.latestDetail);
        assertEquals(at("2026-09-23 11:12:23"), home.latestTime);
    }

    // 2026-09-27 user rule: the kept review headline is overridden only by a post-completion non-account package;
    // 2026-09-28 user decision 「改成严格晚于」: its newest node must be strictly later than the account's. The union
    // page's newest node (11:12:23) is at the feed's own signature time, so the review stays the headline.
    @Test public void aPostCompletionUnionPageAtTheFeedSignatureTimeKeepsTheReview() throws Exception {
        ExpressItem home = completedRow(new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 11:12:23"), SIGNED + "（feed）"},
                {at("2026-09-23 08:02:00"), DELIVERING}}, SIGNED_CAPTURE);
        assertEquals(REVIEW, home.latestDetail);
        assertEquals(at("2026-09-23 11:12:27"), home.latestTime);
    }

    /**
     * Fold7 2026-09-24 实测：京粉页在签收前抓过一次（最新 09-22 22:12:48），详情页下拉重抓后同源增量合并，
     * 轨迹里有了 11:12:23 的签收，包上存的 latestTime/latestDetail 却还停在第一次那条，首页表头倒退到
     * 「09-22 22:12 已离开【测试城北三期接货仓】」。表头只认轨迹里最新的有效节点。
     */
    @Test public void aRecapturedDetailPackageShowsItsNewestNodeNotItsStoredHeadline() throws Exception {
        ExpressItem home = completedRow(new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING}},
                new String[][]{
                        {at("2026-09-22 22:12:48"), LEFT_WAREHOUSE},
                        {at("2026-09-22 21:48:11"), "您的订单已由京东快递揽收"}},
                SIGNED_CAPTURE);
        assertEquals(SIGNED, home.latestDetail);
        assertEquals(at("2026-09-23 11:12:23"), home.latestTime);
    }

    /**
     * 2026-09-24（问题 3 的另一条路）：签收只在按承运商运单号存的 v5_query 里，没有京粉页包，feed 停在「派送中」。
     * 详情按列表上的号（承运商运单号）读 query、显示签收；首页的例外原先按订单号读 query，那一份的运单号是订单号，
     * 在详情选包里被判 waybill_mismatch，首页就还是「派送中」。例外要跟详情读同一个 query。
     */
    // 2026-09-27 user rule: account packages do not override the kept review; with the review counted the feed
    // (11:12:27) outranks the carrier-keyed query (11:12:23), so the review stays the headline.
    @Test public void aSignatureOnlyInTheCarrierKeyedQueryKeepsTheReviewHeadline() throws Exception {
        ExpressItem owner = completedOwner(new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING}});
        saveOwnedCarrierQuery(owner, new ExpressQueryResult(WAYBILL, "JD", "京东快递",
                StatusSemantic.UNKNOWN, 0L, SIGNED_CAPTURE[0][0], SIGNED_CAPTURE[0][1],
                tracks(SIGNED_CAPTURE), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong"));
        assertNull("only the carrier-keyed copy has the signature",
                repository.accountTimeline(ORDER, "interface5"));
        assertTrue("the signed JD row is display-frozen", displayFrozen(owner.rowId));

        ManualTimelineAuthorityPolicy.Candidate detail = repository.manualDetailTimelineAuthority(owner);
        assertNull("the feed with the review is the detail's top package", detail);

        ExpressItem home = listed(owner.rowId);
        assertEquals(StatusSemantic.COMPLETED, home.semantic);
        assertEquals(REVIEW, home.latestDetail);
        assertEquals(at("2026-09-23 11:12:27"), home.latestTime);
    }

    /**
     * 同一条路走没冻结的行（列表和京粉页都没给承运商身份，行没进自动归属，签收也就不冻结）：列表那边走
     * projectTimelineAuthorities 而不是冻结路径，例外同样要按详情的号读 query。
     */
    // 2026-09-27 user rule: account packages do not override the kept review headline (unfrozen path too).
    @Test public void anUnfrozenSignedRowKeepsTheReviewOverTheCarrierKeyedQuery() throws Exception {
        ExpressItem owner = completedOwner(new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING}}, false);
        assertFalse(displayFrozen(owner.rowId));
        saveOwnedCarrierQuery(owner, new ExpressQueryResult(WAYBILL, "JD", "京东快递",
                StatusSemantic.UNKNOWN, 0L, SIGNED_CAPTURE[0][0], SIGNED_CAPTURE[0][1],
                tracks(SIGNED_CAPTURE), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong"));
        ExpressItem home = listed(owner.rowId);
        assertEquals(REVIEW, home.latestDetail);
        assertEquals(at("2026-09-23 11:12:27"), home.latestTime);
    }

    /**
     * 2026-09-27 user rule, removal side of the 09-24 path: the parcel was signed earlier (structured completion
     * 11:12:23), so the later review (11:12:27) is removed as before; the signature is only in the carrier-keyed
     * v5_query, and the ordinary exception still takes the headline from it (frozen row: list and find()).
     */
    @Test public void aReviewAfterAnEarlierSigningLeavesTheCarrierKeyedQueryToTheHeadline() throws Exception {
        ExpressItem owner = completedOwner(new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING}}, true, at("2026-09-23 11:12:23"));
        saveOwnedCarrierQuery(owner, new ExpressQueryResult(WAYBILL, "JD", "京东快递",
                StatusSemantic.UNKNOWN, 0L, SIGNED_CAPTURE[0][0], SIGNED_CAPTURE[0][1],
                tracks(SIGNED_CAPTURE), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong"));
        assertTrue(displayFrozen(owner.rowId));
        assertFalse(repository.find(owner.rowId).tracksJson.contains("期待您"));
        ExpressItem home = listed(owner.rowId);
        assertEquals(SIGNED, home.latestDetail);
        assertEquals(at("2026-09-23 11:12:23"), home.latestTime);
        assertEquals(home.latestDetail, repository.find(owner.rowId).latestDetail);
    }

    /** Same removal-side case on an unfrozen row (projectTimelineAuthorities path). */
    @Test public void anUnfrozenRowSignedBeforeItsReviewAlsoReadsTheCarrierKeyedQuery() throws Exception {
        ExpressItem owner = completedOwner(new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING}}, false, at("2026-09-23 11:12:23"));
        assertFalse(displayFrozen(owner.rowId));
        saveOwnedCarrierQuery(owner, new ExpressQueryResult(WAYBILL, "JD", "京东快递",
                StatusSemantic.UNKNOWN, 0L, SIGNED_CAPTURE[0][0], SIGNED_CAPTURE[0][1],
                tracks(SIGNED_CAPTURE), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong"));
        ExpressItem home = listed(owner.rowId);
        assertEquals(SIGNED, home.latestDetail);
        assertEquals(at("2026-09-23 11:12:23"), home.latestTime);
    }

    /** 用户定 2026-09-24：签收冻结的行 find() 与列表同一个表头（京粉页包里的签收）。 */
    @Test public void findReturnsTheListHeadlineOfAFrozenSignedRow() throws Exception {
        ExpressItem home = completedRow(new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING}}, SIGNED_CAPTURE);
        assertTrue(displayFrozen(home.rowId));
        assertEquals(SIGNED, home.latestDetail);
        ExpressItem found = repository.find(home.rowId);
        assertEquals(home.latestDetail, found.latestDetail);
        assertEquals(home.latestTime, found.latestTime);
    }

    /** 同上，签收只在按承运商运单号存的 v5_query 里：find() 与列表读同一份 query。 */
    // 2026-09-27 user rule: account packages do not override the kept review; find() and the list agree on it.
    @Test public void findMatchesTheListWhenOnlyTheCarrierKeyedQueryHasTheSignature() throws Exception {
        ExpressItem owner = completedOwner(new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING}});
        saveOwnedCarrierQuery(owner, new ExpressQueryResult(WAYBILL, "JD", "京东快递",
                StatusSemantic.UNKNOWN, 0L, SIGNED_CAPTURE[0][0], SIGNED_CAPTURE[0][1],
                tracks(SIGNED_CAPTURE), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong"));
        ExpressItem home = listed(owner.rowId);
        ExpressItem found = repository.find(owner.rowId);
        assertEquals(REVIEW, home.latestDetail);
        assertEquals(home.latestDetail, found.latestDetail);
        assertEquals(home.latestTime, found.latestTime);
    }

    /**
     * 用户定 2026-09-24：「转为已签收」那一条通知的正文跟列表表头一致。通知在提交后按 find() 发出，
     * 转为已签收的同一步里已写了显示冻结，所以冻结路径也要套签收头条的例外。
     */
    @Test public void theSignedTransitionNotificationCarriesTheListHeadline() throws Exception {
        ExpressItem owner = deliveringOrderWithSignedUnionPage();
        int before = postedTexts().size();
        list(StatusSemantic.COMPLETED, at("2026-09-23 11:12:27"), new String[][]{
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), "您的订单已由京东快递揽收"}});
        assertTrue(displayFrozen(owner.rowId));
        java.util.List<String> texts = postedTexts();
        assertEquals(before + 1, texts.size());
        assertEquals(SIGNED, texts.get(texts.size() - 1));
        assertEquals(SIGNED, listed(owner.rowId).latestDetail);
        assertEquals(SIGNED, repository.find(owner.rowId).latestDetail);
    }

    /**
     * 冻结的京东件不再通知：表头换了（这里是再抓一次京粉页、再收一次签收列表、再投影一次），状态和
     * 结构化时间都没变，不是新事件。
     */
    @Test public void aFrozenSignedRowDoesNotNotifyAgainWhenItsHeadlineMoves() throws Exception {
        ExpressItem owner = deliveringOrderWithSignedUnionPage();
        String[][] completed = {
                {at("2026-09-23 11:12:27"), REVIEW},
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), "您的订单已由京东快递揽收"}};
        list(StatusSemantic.COMPLETED, at("2026-09-23 11:12:27"), completed);
        int afterSigned = postedTexts().size();

        String[][] later = new String[SIGNED_CAPTURE.length + 1][];
        later[0] = new String[]{at("2026-09-23 11:20:00"), "您的订单已签收，签收人：本人"};
        System.arraycopy(SIGNED_CAPTURE, 0, later, 1, SIGNED_CAPTURE.length);
        captureUnionPage(repository.find(owner.rowId), later);
        list(StatusSemantic.COMPLETED, at("2026-09-23 11:12:27"), completed);
        assertTrue(repository.saveOrderProjection(
                repository.find(owner.rowId), "interface5", WAYBILL, "京东快递"));

        assertEquals(at("2026-09-23 11:20:00"), listed(owner.rowId).latestTime);
        assertEquals(afterSigned, postedTexts().size());
    }

    private static final String FEED_SIGNED = SIGNED + "（feed）";
    private static final String HANDED_OVER = "您的订单已签收，签收人：本人";
    private static final String[][] FEED_SIGNED_AT_NEWEST = {
            {at("2026-09-23 11:12:23"), FEED_SIGNED},
            {at("2026-09-23 08:02:00"), DELIVERING}};

    /** SIGNED_CAPTURE plus one node strictly later than the feed's newest node. */
    private static String[][] laterCapture() {
        String[][] later = new String[SIGNED_CAPTURE.length + 1][];
        later[0] = new String[]{at("2026-09-23 11:20:00"), HANDED_OVER};
        System.arraycopy(SIGNED_CAPTURE, 0, later, 1, SIGNED_CAPTURE.length);
        return later;
    }

    /**
     * 用户 2026-10-01「改成「不晚于」，三端一起」: the feed's own newest node is the signing, so the
     * structured completion equals it. A complete union page captured after the completion whose
     * newest node is strictly later now leads the list (frozen row: list and find()); status, status
     * time and tracks stay the feed's.
     */
    @Test public void aFeedSigningAtItsNewestNodeHandsTheListToAStrictlyLaterDetailNode() throws Exception {
        ExpressItem owner = completedOwner(FEED_SIGNED_AT_NEWEST, true, at("2026-09-23 11:12:23"));
        assertTrue(displayFrozen(owner.rowId));
        assertEquals(FEED_SIGNED, owner.latestDetail);
        assertEquals(owner.statusEventTime, ExpressSourcePolicy.parseEventTime(owner.latestTime));
        captureUnionPage(owner, laterCapture());
        ExpressItem home = listed(owner.rowId);
        assertEquals(HANDED_OVER, home.latestDetail);
        assertEquals(at("2026-09-23 11:20:00"), home.latestTime);
        assertEquals(StatusSemantic.COMPLETED, home.semantic);
        assertEquals(owner.statusEventTime, home.statusEventTime);
        assertEquals(owner.tracksJson, home.tracksJson);
        ExpressItem found = repository.find(owner.rowId);
        assertEquals(home.latestDetail, found.latestDetail);
        assertEquals(home.latestTime, found.latestTime);
    }

    /**
     * Same on an unfrozen row (projectTimelineAuthorities path), with the later node in the
     * carrier-keyed v5_query the detail reads, as the earlier-feed tests above.
     */
    @Test public void anUnfrozenFeedSigningAtItsNewestNodeAlsoHandsTheListOver() throws Exception {
        ExpressItem owner = completedOwner(FEED_SIGNED_AT_NEWEST, false, at("2026-09-23 11:12:23"));
        assertFalse(displayFrozen(owner.rowId));
        String[][] later = laterCapture();
        saveOwnedCarrierQuery(owner, new ExpressQueryResult(WAYBILL, "JD", "京东快递",
                StatusSemantic.UNKNOWN, 0L, later[0][0], later[0][1],
                tracks(later), "", PHONE, TimelineSlot.V5_QUERY, "", "", "JingDong"));
        ExpressItem home = listed(owner.rowId);
        assertEquals(HANDED_OVER, home.latestDetail);
        assertEquals(at("2026-09-23 11:20:00"), home.latestTime);
        assertEquals(StatusSemantic.COMPLETED, home.semantic);
        assertEquals(owner.statusEventTime, home.statusEventTime);
    }

    /** Same shape; the union page's newest node is the feed's own signing time: unchanged. */
    @Test public void aFeedSigningAtItsNewestNodeKeepsItWithoutAStrictlyLaterDetailNode() throws Exception {
        ExpressItem owner = completedOwner(FEED_SIGNED_AT_NEWEST, true, at("2026-09-23 11:12:23"));
        captureUnionPage(owner, SIGNED_CAPTURE);
        ExpressItem home = listed(owner.rowId);
        assertEquals(FEED_SIGNED, home.latestDetail);
        assertEquals(at("2026-09-23 11:12:23"), home.latestTime);
    }

    /**
     * Same shape; the only union page was captured before the completion, so none of its nodes is
     * later than the feed's: unchanged.
     */
    @Test public void aFeedSigningAtItsNewestNodeIgnoresAPageCapturedBeforeTheCompletion() throws Exception {
        ExpressItem owner = completedOwner(FEED_SIGNED_AT_NEWEST, true, at("2026-09-23 11:12:23"));
        captureUnionPage(owner, new String[][]{
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-23 07:23:00"), "您的订单已到达【测试城东站】"},
                {at("2026-09-22 22:12:48"), LEFT_WAREHOUSE},
                {at("2026-09-22 21:48:11"), "您的订单已由京东快递揽收"}});
        ExpressItem home = listed(owner.rowId);
        assertEquals(FEED_SIGNED, home.latestDetail);
        assertEquals(at("2026-09-23 11:12:23"), home.latestTime);
    }

    /** An unsigned row whose status time is its newest node keeps its feed headline. */
    @Test public void anUnsignedRowAtItsNewestNodeKeepsItsFeedHeadline() throws Exception {
        ExpressItem owner = deliveringOrderWithSignedUnionPage();
        assertEquals(StatusSemantic.DELIVERY, owner.semantic);
        assertEquals(owner.statusEventTime, ExpressSourcePolicy.parseEventTime(owner.latestTime));
        ExpressItem home = listed(owner.rowId);
        assertEquals(DELIVERING, home.latestDetail);
        assertEquals(at("2026-09-23 08:02:00"), home.latestTime);
    }

    /** A non-JD interface 5 row signed at its newest node keeps its feed headline. */
    @Test public void aNonJdRowSignedAtItsNewestNodeKeepsItsFeedHeadline() throws Exception {
        String waybill = "ZT9990000001906";
        long completedAt = ExpressSourcePolicy.parseEventTime(at("2026-09-23 11:12:23"));
        WorkerStatusProjection completed = WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "SHIPMENT").put("semantic", "COMPLETED")
                        .put("code", "SIGN").put("text", "已签收").put("priority", 0)
                        .put("eventAtMs", completedAt).put("structured", true)));
        String[][] feedTracks = {
                {at("2026-09-23 11:12:23"), "您的快件已签收"},
                {at("2026-09-23 08:02:00"), "您的快件正在派送中"},
                {at("2026-09-22 21:48:11"), "您的快件已揽收"}};
        repository.saveInterface5(new ExpressQueryResult(waybill, "ZTO", "中通快递",
                StatusSemantic.COMPLETED, completedAt, feedTracks[0][0], feedTracks[0][1],
                tracks(feedTracks), "", PHONE, "interface5", "", "", "CaiNiao")
                .withWorkerStatus(completed), PHONE);
        ExpressItem owner = repository.findByWaybill(waybill, "interface5");
        assertNotNull(owner);
        assertFalse(owner.isJingDongSource());
        assertEquals(StatusSemantic.COMPLETED, owner.semantic);
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        String[][] page = {
                {at("2026-09-23 11:20:00"), HANDED_OVER},
                {at("2026-09-23 11:12:23"), "您的快件已签收"},
                {at("2026-09-23 08:02:00"), "您的快件正在派送中"},
                {at("2026-09-23 07:23:00"), "您的快件已到达【测试城东站】"},
                {at("2026-09-22 21:48:11"), "您的快件已揽收"}};
        assertTrue(repository.saveAutomaticDetailTimeline(owner, claim, new ExpressQueryResult(
                waybill, "ZTO", "中通快递", StatusSemantic.UNKNOWN, 0L, page[0][0], page[0][1],
                tracks(page), "", "", TimelineSlot.CN_H5, "", "", ""), true));
        ExpressItem home = listed(owner.rowId);
        assertEquals("您的快件已签收", home.latestDetail);
        assertEquals(at("2026-09-23 11:12:23"), home.latestTime);
    }

    private ExpressItem completedRow(String[][] feedTracks, String[][]... detailCaptures)
            throws Exception {
        ExpressItem owner = completedOwner(feedTracks);
        for (String[][] capture : detailCaptures) {
            owner = repository.find(owner.rowId);
            ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
            // 京粉页包不带状态，latestTime/latestDetail 就是这次抓到的最新一条。
            assertTrue(repository.saveAutomaticDetailTimeline(owner, claim, new ExpressQueryResult(
                    WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L,
                    capture[0][0], capture[0][1], tracks(capture),
                    "", "", TimelineSlot.JD_H5, "", "", ""), true));
        }
        return listed(owner.rowId);
    }

    /** 已签收（结构化）、已投影到 WAYBILL 的京东订单行，feed 的节点就是 feedTracks。 */
    private ExpressItem completedOwner(String[][] feedTracks) throws Exception {
        return completedOwner(feedTracks, true);
    }

    /**
     * owned=false：列表不带承运商码、投影不带承运商名，两处都不建自动归属，这一行不会被签收冻结。
     */
    private ExpressItem completedOwner(String[][] feedTracks, boolean owned) throws Exception {
        return completedOwner(feedTracks, owned, at("2026-09-23 11:12:27"));
    }

    /** {@code completedAtText}: the structured completion time the list reports. */
    private ExpressItem completedOwner(String[][] feedTracks, boolean owned, String completedAtText)
            throws Exception {
        long completedAt = ExpressSourcePolicy.parseEventTime(completedAtText);
        WorkerStatusProjection completed = WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "ORDER").put("semantic", "COMPLETED")
                        .put("code", "SERVER_ENUM").put("text", "已完成").put("priority", 0)
                        .put("eventAtMs", completedAt).put("structured", true)));
        ExpressQueryResult feed = new ExpressQueryResult(ORDER, owned ? "JD" : "", "京东快递",
                StatusSemantic.COMPLETED, completedAt, feedTracks[0][0], feedTracks[0][1],
                tracks(feedTracks), "", PHONE, "interface5", "", "", "JingDong")
                .withWorkerStatus(completed);
        repository.saveInterface5OrderSummary(feed, PHONE);
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveOrderProjection(
                owner, "interface5", WAYBILL, owned ? "京东快递" : ""));
        return repository.find(owner.rowId);
    }

    private void saveOwnedCarrierQuery(ExpressItem owner, ExpressQueryResult result) {
        assertTrue(repository.saveInterface5Query(result.withWaybill(owner.waybill), owner,
                repository.bindingGeneration(owner.phone, "interface5")));
        // This fixture isolates the carrier-keyed copy, as a retained older query cache can.
        database.getWritableDatabase().delete(ExpressDatabase.ACCOUNT_V5_TIMELINE_TABLE,
                "normalized_waybill=?", new String[]{ExpressSourcePolicy.normalizeWaybill(owner.waybill)});
    }

    /** 派送中、已投影、京粉页已抓到签收的订单行（还没收到签收的列表）。 */
    private ExpressItem deliveringOrderWithSignedUnionPage() throws Exception {
        list(StatusSemantic.DELIVERY, at("2026-09-23 08:02:00"), new String[][]{
                {at("2026-09-23 08:02:00"), DELIVERING},
                {at("2026-09-22 21:48:11"), "您的订单已由京东快递揽收"}});
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        owner = repository.find(owner.rowId);
        captureUnionPage(owner, SIGNED_CAPTURE);
        assertFalse(displayFrozen(owner.rowId));
        return repository.find(owner.rowId);
    }

    private void captureUnionPage(ExpressItem owner, String[][] capture) throws Exception {
        ExpressRepository.ManualQueryOwnerClaim claim = repository.captureManualQueryOwner(owner);
        assertTrue(repository.saveAutomaticDetailTimeline(owner, claim, new ExpressQueryResult(
                WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L,
                capture[0][0], capture[0][1], tracks(capture),
                "", "", TimelineSlot.JD_H5, "", "", ""), true));
    }

    private void list(StatusSemantic semantic, String eventAt, String[][] nodes) throws Exception {
        long eventAtMs = ExpressSourcePolicy.parseEventTime(eventAt);
        WorkerStatusProjection status = WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "ORDER").put("semantic", semantic.name())
                        .put("code", "SERVER_ENUM").put("text", semantic.label).put("priority", 0)
                        .put("eventAtMs", eventAtMs).put("structured", true)));
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JD", "京东快递",
                semantic, eventAtMs, nodes[0][0], nodes[0][1], tracks(nodes),
                "", PHONE, "interface5", "", "", "JingDong").withWorkerStatus(status), PHONE);
    }

    /** 已发出的通知正文（去掉通知排版插进去的零宽空格）。 */
    private java.util.List<String> postedTexts() {
        java.util.List<String> texts = new java.util.ArrayList<>();
        android.app.NotificationManager manager = (android.app.NotificationManager)
                context.getSystemService(Context.NOTIFICATION_SERVICE);
        for (android.app.Notification notification
                : org.robolectric.Shadows.shadowOf(manager).getAllNotifications()) {
            CharSequence text = notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT);
            texts.add(text == null ? "" : text.toString().replace("\u200B", ""));
        }
        return texts;
    }

    private boolean displayFrozen(long rowId) {
        try (android.database.Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, new String[]{"display_frozen"},
                "owner_row_id=?", new String[]{Long.toString(rowId)}, null, null, null)) {
            return cursor.moveToFirst() && cursor.getInt(0) != 0;
        }
    }

    private ExpressItem listed(long rowId) {
        for (ExpressItem item : repository.listVisible("interface5")) {
            if (item.rowId == rowId) return item;
        }
        throw new AssertionError("the completed order is not visible");
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        }
        return value.toString();
    }
}
