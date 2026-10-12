package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ManualQuerySuccess;
import me.pipi.deliveries.model.StatusSemantic;

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
 * 网页包（k100_h5、jd_h5、cn_h5、jt_h5）自己不带状态（UNKNOWN）。同一来源第二次抓取带回更新的节点时，轨迹并进去了，
 * 但 Kuaidi100TimelinePolicy.merge 挑表头时两边都是 UNKNOWN 就留旧包，存下的 latestTime / latestDetail 停在
 * 第一次抓取（Fold7 2026-09-24，1906 的京粉页包：轨迹最新 09-23 11:12:23，存的表头还是 09-22 22:12:48）。
 * 首页表头（find / listVisible）对顺丰件和手动件先读包上存的这两个字段，于是跟着停住。iOS mergeTimelinePackage
 * 每个出口都经 withMergedHeadline 从合并后的轨迹重读表头。
 *
 * <p>2026-09-24 先加了这几条复现（当时失败），用户同日采纳后 Kuaidi100TimelinePolicy.withMergedHeadline 在合并时
 * 修正表头，它们转绿。时间都按当前时间往前推，不会因为夹具日期过期而失败。</p>
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class SameProviderIncrementalHeadlineTest {
    private static final long HOUR = 3_600_000L;
    private static final String PHONE = "13800000001";
    private static final String FIRST_LATEST = "第一次抓到的最新一条";
    private static final String NEWER = "第二次抓到的新节点";

    private Context context;
    private ExpressDatabase database;
    private ExpressRepository repository;
    private long now;

    @Before public void setUp() {
        context = RuntimeEnvironment.getApplication();
        context.deleteDatabase(ExpressDatabase.DATABASE);
        context.getSharedPreferences("deliveries_repository_migrations", 0).edit().clear().commit();
        database = new ExpressDatabase(context);
        repository = new ExpressRepository(context, database);
        repository.bindPhoneLocally(PHONE, "interface5");
        now = System.currentTimeMillis() / 1000L * 1000L;
    }

    @After public void tearDown() {
        database.close();
        context.deleteDatabase(ExpressDatabase.DATABASE);
    }

    /** 顺丰自动件：列表表头取详情排第一的手动包（这里是 K100 页），K100 增量抓取后应跟到新节点。 */
    @Test public void aShunFengHomeHeadlineFollowsTheNewestNodeOfAnIncrementalK100Capture() throws Exception {
        long feedAt = now - 20 * HOUR;
        repository.saveInterface5(new ExpressQueryResult("SFSTALE000001", "SF", "顺丰速运",
                StatusSemantic.TRANSIT, feedAt, time(feedAt), "feed运输中",
                tracks(new long[]{feedAt}, new String[]{"feed运输中"}),
                "", PHONE, "interface5", "", "", "ShunFeng"), PHONE);
        ExpressItem owner = repository.findByWaybill("SFSTALE000001", "interface5");
        assertNotNull(owner);
        assertTrue(owner.isShunFengSource());

        long firstLatest = now - 6 * HOUR;
        long newer = now - 2 * HOUR;
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.K100_H5,
                        page(owner.waybill, "SF", "顺丰速运", TimelineSlot.K100_H5,
                                new long[]{firstLatest, feedAt, feedAt - 2 * HOUR},
                                new String[]{FIRST_LATEST, "K100 运输中", "已揽收"}),
                        now - 5 * HOUR, true)),
                PHONE, "interface5");
        assertHomeHeadline(owner.rowId, firstLatest, FIRST_LATEST);

        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.K100_H5,
                        page(owner.waybill, "SF", "顺丰速运", TimelineSlot.K100_H5,
                                new long[]{newer, firstLatest, feedAt, feedAt - 2 * HOUR},
                                new String[]{NEWER, FIRST_LATEST, "K100 运输中", "已揽收"}),
                        now - HOUR, true)),
                PHONE, "interface5");

        ManualTimelineAuthorityPolicy.Candidate detail = repository.manualDetailTimelineAuthority(owner);
        assertNotNull(detail);
        assertEquals(TimelineSlot.K100_H5, detail.provider);
        assertEquals("the merged tracks already reach the new node",
                newer, Kuaidi100TimelinePolicy.latestTimedEventMillis(detail.result));
        assertHomeHeadline(owner.rowId, newer, NEWER);
    }

    /** 手动添加的件：首页跟详情同一套选包（2026-09-05 方案 A），表头取选中的 K100 包。 */
    @Test public void aManualHomeHeadlineFollowsTheNewestNodeOfAnIncrementalK100Capture() throws Exception {
        String waybill = "ZTSTALE000001";
        long pickedAt = now - 30 * HOUR;
        long firstLatest = now - 6 * HOUR;
        long newer = now - 2 * HOUR;
        ExpressItem owner = repository.saveManualQueryBatch(null,
                List.of(new ManualQuerySuccess(TimelineSlot.K100_H5,
                        page(waybill, "ZTO", "中通快递", TimelineSlot.K100_H5,
                                new long[]{firstLatest, pickedAt + HOUR, pickedAt},
                                new String[]{FIRST_LATEST, "K100 运输中", "已揽收"}),
                        now - 5 * HOUR, true)),
                PHONE, "interface5");
        assertNotNull(owner);
        assertTrue(owner.manuallyAdded);
        assertHomeHeadline(owner.rowId, firstLatest, FIRST_LATEST);

        repository.saveManualQueryBatch(owner,
                List.of(new ManualQuerySuccess(TimelineSlot.K100_H5,
                        page(waybill, "ZTO", "中通快递", TimelineSlot.K100_H5,
                                new long[]{newer, firstLatest, pickedAt + HOUR, pickedAt},
                                new String[]{NEWER, FIRST_LATEST, "K100 运输中", "已揽收"}),
                        now - HOUR, true)),
                PHONE, "interface5");

        assertEquals("the merged tracks already reach the new node", newer,
                Kuaidi100TimelinePolicy.latestTimedEventMillis(
                        repository.manualDetailTimelineAuthority(repository.find(owner.rowId)).result));
        assertHomeHeadline(owner.rowId, newer, NEWER);
    }

    /**
     * 1906 的形状：京东投影件的京粉页包重抓一次，带回签收节点。存下的包表头应当是合并后最新的有效节点。
     * （京东自动件的首页表头归 feed；签收头条的例外已改成读轨迹，这条只钉存储这一层。）
     */
    @Test public void aJdUnionPageRecaptureStoresItsNewestNodeAsTheHeadline() throws Exception {
        String order = "3999999000001906";
        String real = "JD9990000001906";
        long feedAt = now - 20 * HOUR;
        repository.saveInterface5OrderSummary(new ExpressQueryResult(order, "JD", "京东快递",
                StatusSemantic.TRANSIT, feedAt, time(feedAt), "您的快件已揽收完成",
                tracks(new long[]{feedAt}, new String[]{"您的快件已揽收完成"}),
                "", PHONE, "interface5", "", "", "JingDong"), PHONE);
        ExpressItem owner = repository.findByWaybill(order, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveOrderProjection(owner, "interface5", real, "京东快递"));
        owner = repository.find(owner.rowId);

        long firstLatest = now - 6 * HOUR;
        long signedAt = now - 2 * HOUR;
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                page(real, "JD", "京东快递", TimelineSlot.JD_H5,
                        new long[]{firstLatest, feedAt},
                        new String[]{"您的订单已离开【测试城北三期接货仓】", "您的快件已揽收完成"}), true));
        assertTrue(repository.saveAutomaticDetailTimeline(owner, repository.captureManualQueryOwner(owner),
                page(real, "JD", "京东快递", TimelineSlot.JD_H5,
                        new long[]{signedAt, firstLatest, feedAt},
                        new String[]{"您的快件已签收，感谢您使用京东物流", "您的订单已离开【测试城北三期接货仓】",
                                "您的快件已揽收完成"}), true));

        ManualTimelineAuthorityPolicy.Candidate stored = repository.manualTimelineCandidate(
                repository.find(owner.rowId), TimelineSlot.JD_H5);
        assertNotNull(stored);
        assertEquals("the merged tracks already reach the signature",
                signedAt, Kuaidi100TimelinePolicy.latestTimedEventMillis(stored.result));
        assertEquals(time(signedAt), stored.result.latestTime);
        assertEquals("您的快件已签收，感谢您使用京东物流", stored.result.latestDetail);
    }

    /**
     * 第 2 条 2a（用户 2026-09-24 采纳）：改之前存下的旧表头，读时就跟到最新节点。首次写入不经合并、原样落盘，
     * 用它造一份表头比自己最新节点旧的包，等同于改之前那样存下来的。
     */
    @Test public void aStaleStoredShunFengHeadlineIsReadAtTheNewestNode() throws Exception {
        long feedAt = now - 20 * HOUR;
        repository.saveInterface5(new ExpressQueryResult("SFSTALE000002", "SF", "顺丰速运",
                StatusSemantic.TRANSIT, feedAt, time(feedAt), "feed运输中",
                tracks(new long[]{feedAt}, new String[]{"feed运输中"}),
                "", PHONE, "interface5", "", "", "ShunFeng"), PHONE);
        ExpressItem owner = repository.findByWaybill("SFSTALE000002", "interface5");
        assertNotNull(owner);
        long stale = now - 6 * HOUR;
        long newest = now - 2 * HOUR;
        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.K100_H5,
                        page(owner.waybill, "SF", "顺丰速运", TimelineSlot.K100_H5,
                                new long[]{newest, stale, feedAt, feedAt - 2 * HOUR},
                                new String[]{NEWER, FIRST_LATEST, "K100 运输中", "已揽收"})
                                .withHeadline(time(stale), FIRST_LATEST),
                        now - HOUR, true)),
                PHONE, "interface5");

        assertEquals("the stored package still carries the old headline", time(stale),
                repository.manualTimelineCandidate(repository.find(owner.rowId), TimelineSlot.K100_H5)
                        .result.latestTime);
        assertHomeHeadline(owner.rowId, newest, NEWER);
    }

    @Test public void aStaleStoredManualHeadlineIsReadAtTheNewestNode() throws Exception {
        String waybill = "ZTSTALE000002";
        long pickedAt = now - 30 * HOUR;
        long stale = now - 6 * HOUR;
        long newest = now - 2 * HOUR;
        ExpressItem owner = repository.saveManualQueryBatch(null,
                List.of(new ManualQuerySuccess(TimelineSlot.K100_H5,
                        page(waybill, "ZTO", "中通快递", TimelineSlot.K100_H5,
                                new long[]{newest, stale, pickedAt + HOUR, pickedAt},
                                new String[]{NEWER, FIRST_LATEST, "K100 运输中", "已揽收"})
                                .withHeadline(time(stale), FIRST_LATEST),
                        now - HOUR, true)),
                PHONE, "interface5");
        assertNotNull(owner);

        assertEquals("the stored package still carries the old headline", time(stale),
                repository.manualTimelineCandidate(repository.find(owner.rowId), TimelineSlot.K100_H5)
                        .result.latestTime);
        assertHomeHeadline(owner.rowId, newest, NEWER);
    }

    /** 用户 2026-09-25 定（D6「换成最新」）：带结构化证据的已签收包，签收之后并进来的节点照样当首页头条。 */
    @Test public void aSignedStoredPackageTakesItsNewestHeadlineOnRead() throws Exception {
        String waybill = "ZTSIGNED00001";
        long pickedAt = now - 30 * HOUR;
        long signedAt = now - 6 * HOUR;
        long later = now - 2 * HOUR;
        JSONArray nodes = new JSONArray(tracks(new long[]{later, signedAt, pickedAt},
                new String[]{"签收后补的一条", "已签收", "已揽收"}));
        nodes.getJSONObject(0).put("statusCode", "3");
        ExpressQueryResult signed = new ExpressQueryResult(waybill, "ZTO", "中通快递",
                StatusSemantic.COMPLETED, signedAt, time(signedAt), "已签收",
                nodes.toString(),
                "", PHONE, TimelineSlot.KDNIAO, "", "", "").withManualStatusEvidence("已签收", true);
        ExpressItem owner = repository.saveManualQueryBatch(null,
                List.of(new ManualQuerySuccess(TimelineSlot.KDNIAO, signed, now - HOUR, true)),
                PHONE, "interface5");
        assertNotNull(owner);

        assertHomeHeadline(owner.rowId, later, "签收后补的一条");
        assertEquals(StatusSemantic.COMPLETED, repository.find(owner.rowId).semantic);
    }

    @Test public void anUnknownLaterNodeAlignsToTheSignedDonorWithoutLosingTheStoredNode() throws Exception {
        String waybill = "ZTUNKNOWNSIGNED01";
        long pickedAt = now - 30 * HOUR;
        long signedAt = now - 6 * HOUR;
        long later = now - 2 * HOUR;
        String original = tracks(new long[]{later, signedAt, pickedAt},
                new String[]{"签收后补的一条", "已签收", "已揽收"});
        ExpressQueryResult signed = new ExpressQueryResult(waybill, "ZTO", "中通快递",
                StatusSemantic.COMPLETED, signedAt, time(signedAt), "已签收", original,
                "", PHONE, TimelineSlot.KDNIAO, "", "", "").withManualStatusEvidence("已签收", true);
        ExpressItem owner = repository.saveManualQueryBatch(null,
                List.of(new ManualQuerySuccess(TimelineSlot.KDNIAO, signed, now - HOUR, true)),
                PHONE, "interface5");
        assertNotNull(owner);
        assertEquals(time(later), repository.find(owner.rowId).latestTime);
        assertEquals("签收后补的一条", repository.find(owner.rowId).latestDetail);
        ExpressItem displayed = repository.listVisible("interface5").stream()
                .filter(row -> row.rowId == owner.rowId).findFirst().orElseThrow();
        assertEquals(time(signedAt), displayed.latestTime);
        assertEquals("已签收", displayed.latestDetail);
        ExpressQueryResult stored = repository.manualTimelineCandidate(owner, TimelineSlot.KDNIAO).result;
        assertEquals(original, stored.tracksJson);
        assertEquals(later, Kuaidi100TimelinePolicy.latestTimedEventMillis(stored));
        assertEquals(StatusSemantic.COMPLETED, repository.find(owner.rowId).semantic);
        assertEquals(signedAt, repository.find(owner.rowId).statusEventTime);
    }

    private void assertHomeHeadline(long rowId, long at, String detail) {
        ExpressItem found = repository.find(rowId);
        ExpressItem listed = repository.listVisible("interface5").stream()
                .filter(row -> row.rowId == rowId).findFirst().orElse(null);
        assertNotNull("find() returns the row", found);
        assertNotNull("the row is listed", listed);
        for (ExpressItem home : new ExpressItem[]{found, listed}) {
            assertEquals(time(at), home.latestTime);
            assertEquals(detail, home.latestDetail);
        }
    }

    /** 网页包的形状：自己不带状态，表头是这次抓到的最新一条（与 kuaidi100CapturedResult、京粉页解析一致）。 */
    private static ExpressQueryResult page(String waybill, String courier, String company,
            String provider, long[] at, String[] detail) throws Exception {
        return new ExpressQueryResult(waybill, courier, company, StatusSemantic.UNKNOWN, 0L,
                time(at[0]), detail[0], tracks(at, detail), "", PHONE, provider, "", "", "");
    }

    private static String tracks(long[] at, String[] detail) throws Exception {
        JSONArray value = new JSONArray();
        for (int index = 0; index < at.length; index++) {
            value.put(new JSONObject().put("time", time(at[index])).put("context", detail[index]));
        }
        return value.toString();
    }

    private static String time(long at) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT);
        format.setTimeZone(java.util.TimeZone.getTimeZone("Asia/Shanghai"));
        return format.format(new Date(at));
    }
}
