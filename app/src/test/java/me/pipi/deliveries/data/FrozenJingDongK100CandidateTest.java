package me.pipi.deliveries.data;

import static me.pipi.deliveries.FixtureDay.at;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Application;
import android.content.Context;

import java.util.List;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ManualQuerySuccess;
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
 * 用户 2026-09-28（方案 A「存成候选」，Pixel 11 Pro 尾号 7407 的同一类件）：已签收、签收冻结的京东件在详情下拉里
 * 抓到的 K100 页包原先整包丢掉（display_frozen 跳过所有手动槽写入），K100 页白开、也用掉每日配额。现在它进这一行
 * 自己的 K100 槽，成为详情候选，与 iOS 对冻结京东件照样保留手动包一致；这一行的状态、头条与其它槽照旧冻结。
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public final class FrozenJingDongK100CandidateTest {
    private static final String PHONE = "13800009998";
    private static final String ORDER = "3999999000000001";
    private static final String WAYBILL = "JD9990000000001";
    private static final String REVIEW = "您的订单" + ORDER
            + "已完成，感谢您对京东的支持，欢迎再次光临。期待您对本次购物进行评价。";
    private static final String DELIVERING = "您的订单正在派送中，请您准备签收";
    private static final String COMPLETED_AT = at("2026-09-23 11:12:27");

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

    @Test public void aFrozenJingDongRowKeepsItsK100PageAsADetailCandidate() throws Exception {
        ExpressItem owner = signedFrozenOrder();
        ExpressItem before = repository.find(owner.rowId);
        java.util.Map<String, String> storedBefore = storedRow(owner.rowId);

        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.K100_H5, k100Page(), System.currentTimeMillis(), true)),
                PHONE, "interface5");

        ManualTimelineAuthorityPolicy.Candidate k100 =
                repository.manualTimelineCandidate(repository.find(owner.rowId), TimelineSlot.K100_H5);
        assertNotNull("the K100 page lands in the row's own K100 slot", k100);
        assertEquals(3, Kuaidi100TimelinePolicy.timedTrackCount(k100.result));
        assertNull("it is a detail candidate like any other stored package",
                ExpressRepository.manualCandidateRejectionReason(repository.find(owner.rowId), k100, false));

        assertTrue("the row stays frozen", displayFrozen(owner.rowId));
        assertEquals("only the K100 slot is written; the stored row is untouched",
                storedBefore, storedRow(owner.rowId));
        ExpressItem after = repository.find(owner.rowId);
        assertEquals(before.semantic, after.semantic);
        assertEquals(before.statusEventTime, after.statusEventTime);
        // The 2026-09-24 signed-headline exception (its 2026-09-27 kept-review reading) now finds a
        // post-completion non-account package at the top of the detail: the presented headline takes
        // its newest node. The user accepted this consequence with option A (2026-09-28).
        assertEquals(at("2026-09-23 11:12:23"), after.latestTime);
    }

    /** Left for later ②: a J&T / HTKY carrier's page (jt_h5, the same primary H5 stage) is kept the same way. */
    @Test public void aFrozenJingDongRowKeepsItsJtPageAsADetailCandidate() throws Exception {
        ExpressItem owner = signedFrozenOrder();
        java.util.Map<String, String> storedBefore = storedRow(owner.rowId);
        ExpressQueryResult page = k100Page();
        ExpressQueryResult jtPage = new ExpressQueryResult(page.waybill, page.courierCode, page.companyName,
                page.semantic, page.statusEventTime, page.latestTime, page.latestDetail, page.tracksJson,
                "", PHONE, TimelineSlot.JT_H5, "", "", "");

        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.JT_H5, jtPage, System.currentTimeMillis(), true)),
                PHONE, "interface5");

        ManualTimelineAuthorityPolicy.Candidate jt =
                repository.manualTimelineCandidate(repository.find(owner.rowId), TimelineSlot.JT_H5);
        assertNotNull("the J&T page lands in the row's own jt_h5 slot", jt);
        assertNull(ExpressRepository.manualCandidateRejectionReason(repository.find(owner.rowId), jt, false));
        assertTrue(displayFrozen(owner.rowId));
        assertEquals(storedBefore, storedRow(owner.rowId));
    }

    @Test public void aFrozenJingDongRowStillDropsEveryOtherManualSlot() throws Exception {
        ExpressItem owner = signedFrozenOrder();
        ExpressQueryResult online = new ExpressQueryResult(WAYBILL, "JD", "京东快递",
                StatusSemantic.TRANSIT, 0L, at("2026-09-23 08:02:00"), DELIVERING,
                tracks(new String[][]{{at("2026-09-23 08:02:00"), DELIVERING}}),
                "", PHONE, TimelineSlot.V6_QUERY, "", "", "");

        repository.saveOwnerManualQueryBatch(owner, repository.captureManualQueryOwner(owner),
                List.of(new ManualQuerySuccess(TimelineSlot.V6_QUERY, online, System.currentTimeMillis(), false)),
                PHONE, "interface5");

        assertNull(repository.manualTimelineCandidate(repository.find(owner.rowId), TimelineSlot.V6_QUERY));
    }

    /** 已签收（结构化）、已投影、签收冻结的京东订单行。 */
    private ExpressItem signedFrozenOrder() throws Exception {
        long completedAt = ExpressSourcePolicy.parseEventTime(COMPLETED_AT);
        WorkerStatusProjection completed = WorkerStatusProjection.read(new JSONObject()
                .put("normalizedStatus", new JSONObject().put("version", 1)
                        .put("scope", "ORDER").put("semantic", "COMPLETED")
                        .put("code", "SERVER_ENUM").put("text", "已完成").put("priority", 0)
                        .put("eventAtMs", completedAt).put("structured", true)));
        String[][] feed = {{COMPLETED_AT, REVIEW}, {at("2026-09-23 08:02:00"), DELIVERING}};
        repository.saveInterface5OrderSummary(new ExpressQueryResult(ORDER, "JD", "京东快递",
                StatusSemantic.COMPLETED, completedAt, feed[0][0], feed[0][1], tracks(feed),
                "", PHONE, "interface5", "", "", "JingDong").withWorkerStatus(completed), PHONE);
        ExpressItem owner = repository.findByWaybill(ORDER, "interface5");
        assertNotNull(owner);
        assertTrue(repository.saveOrderProjection(owner, "interface5", WAYBILL, "京东快递"));
        owner = repository.find(owner.rowId);
        assertTrue("the signed JD row is display-frozen", displayFrozen(owner.rowId));
        return owner;
    }

    private static ExpressQueryResult k100Page() throws Exception {
        String[][] nodes = {
                {at("2026-09-23 11:12:23"), "【深圳市】您的快件已签收，签收人：本人"},
                {at("2026-09-23 08:02:00"), "【深圳市】您的快件正在派送中"},
                {at("2026-09-22 21:48:11"), "【佛山市】京东快递 已揽收"}};
        return new ExpressQueryResult(WAYBILL, "JD", "京东快递", StatusSemantic.UNKNOWN, 0L,
                nodes[0][0], nodes[0][1], tracks(nodes), "", PHONE, TimelineSlot.K100_H5, "", "", "");
    }

    /** Every stored column of the row, as text. */
    private java.util.Map<String, String> storedRow(long rowId) {
        java.util.Map<String, String> row = new java.util.TreeMap<>();
        try (android.database.Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.EXPRESS_TABLE, null, "_id=?", new String[]{Long.toString(rowId)},
                null, null, null)) {
            assertTrue(cursor.moveToFirst());
            for (int index = 0; index < cursor.getColumnCount(); index++) {
                row.put(cursor.getColumnName(index), cursor.isNull(index) ? null : cursor.getString(index));
            }
        }
        return row;
    }

    private boolean displayFrozen(long rowId) {
        try (android.database.Cursor cursor = database.getReadableDatabase().query(
                ExpressDatabase.AUTOMATIC_OWNERSHIP_TABLE, new String[]{"display_frozen"},
                "owner_row_id=?", new String[]{Long.toString(rowId)}, null, null, null)) {
            return cursor.moveToFirst() && cursor.getInt(0) != 0;
        }
    }

    private static String tracks(String[][] nodes) throws Exception {
        JSONArray value = new JSONArray();
        for (String[] node : nodes) {
            value.put(new JSONObject().put("time", node[0]).put("context", node[1]));
        }
        return value.toString();
    }
}
